// 試験の節約の4つ（2026-10-15）: ①段の自動選び（exam-scope）②main の版の鍵（exam-scope）③問題の共有（exam-problems-store・exam-shared-file）④揺れる問題だけ繰り返す（exam-flake）
// 実行: npx tsx scripts/lib/__tests__/exam-saver.test.ts（自己完結・LLM も DB も使わない。全 PASS で exit 0）
//   同時書き込みの確かめは node の型の取り除き（Node 22.18+／23.6+）で .ts を直に読む子 process を4本走らせる
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { importSpecs, resolveSpec, examGraph, classifyFile, combineClasses, stageOfClass, examVersionKeyOf, decideStageFromDiff, type FileMap } from "../exam-scope";
import { atomicWriteJson, updateJsonFile, withFileLock } from "../exam-shared-file";
import { specHashOf, publishProblems, fillProblemsFromShared, readSharedProblem, sharedFileOf } from "../exam-problems-store";
import { flakeVerdict, shouldRunRep, sigOfRow, recordObs, readObs, importLegacyRows, type FlakeObs } from "../exam-flake";
import { problemHash, legacyProblemHash, planBaseline, childArgs, mergeBaselines, type BaselineFile } from "../brain-exam-baseline";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }
const tmp = mkdtempSync(join(tmpdir(), "exam-saver-test-"));

(async () => {
  // ─── ① import の線と段の分け方 ───────────────────────────────────────────
  ok("import の書き方を全部拾う", importSpecs(`import a from "./a";\nimport type { T } from "@/app/lib/t";\nexport { x } from '../x';\nconst m = await import("./dyn");\nrequire("./req");\nimport "./side";`).sort().join() === ["../x", "./a", "./dyn", "./req", "./side", "@/app/lib/t"].sort().join());
  const files: FileMap = new Map([
    ["app/lib/brain-core.ts", `import { s } from "./shared"; import { b } from "@/app/lib/brain-only"; import x from "./brain-layers";`],
    ["app/lib/brain-layers.ts", ``], ["app/lib/deepseek-scope.ts", ``], ["app/lib/reply-context.ts", `import "./shared.js"; import "./ctx-deep";`], ["app/lib/ctx-deep.ts", ``],
    ["app/lib/shared.ts", `export const s = 1;`],
    ["app/lib/brain-only.ts", `import "./brain-deep";`], ["app/lib/brain-deep.ts", ``],
    ["app/api/generate-reply/route.ts", `import { s } from "@/app/lib/shared"; import "@/app/lib/draft-only"; import { analyzeConversation } from "@/app/lib/brain-core"; import { x } from "@/app/lib/reply-context";`],
    ["app/lib/draft-only.ts", ``], ["app/lib/reply-hint-auto.ts", ``],
    ["app/lib/unused.ts", ``], ["app/components/Page.tsx", `import "@/app/lib/shared";`],
    ["scripts/brain-exam.ts", `import "./lib/score"; import "../app/lib/brain-core";`], ["scripts/brain-exam-add.ts", ``], ["scripts/lib/score.ts", ``],
  ]);
  ok("@/ と ./ と .js→.ts を解く", resolveSpec("app/lib/reply-context.ts", "./shared.js", (p) => files.has(p)) === "app/lib/shared.ts" && resolveSpec("x/y.ts", "@/app/lib/shared", (p) => files.has(p)) === "app/lib/shared.ts" && resolveSpec("x.ts", "react", () => true) === null);
  const g = examGraph(files);
  const cls = (f: string, exists = true) => classifyFile(f, g, exists).cls;
  ok("ブレインだけが読む → brain（下書きの線はブレインの入口の先へ辿らない）", cls("app/lib/brain-only.ts") === "brain" && cls("app/lib/brain-deep.ts") === "brain", JSON.stringify([...g.draft]));
  ok("brain-core 自身は下書きも読む（定数）→ both・下書きが直に使う reply-context とその先 → both（止めない）", cls("app/lib/brain-core.ts") === "both" && cls("app/lib/reply-context.ts") === "both" && cls("app/lib/ctx-deep.ts") === "both", JSON.stringify([...g.draft]));
  ok("下書きだけが読む → draft", cls("app/lib/draft-only.ts") === "draft" && cls("app/api/generate-reply/route.ts") === "draft");
  ok("両方が読む → both", cls("app/lib/shared.ts") === "both");
  ok("試験の道具・問題・設定 → both", cls("scripts/lib/score.ts") === "both" && cls("scripts/brain-exam/spec.json") === "both" && cls("package.json") === "both" && cls("tsconfig.json") === "both");
  ok("読まれないコード・画面・文書・単体テスト → none", cls("app/lib/unused.ts") === "none" && cls("app/components/Page.tsx") === "none" && cls("memory/x.md") === "none" && cls("app/lib/__tests__/a.test.ts") === "none");
  ok("消した app のコード → 安全側 both", cls("app/lib/gone.ts", false) === "both");
  const v = (fs: string[]) => combineClasses(fs.map((f) => classifyFile(f, g)));
  ok("まとめ: brain だけ → brain・draft だけ → draft・brain と draft → both・none だけ → none・無し → none",
    v(["app/lib/brain-only.ts", "README.md"]) === "brain" && v(["app/lib/draft-only.ts"]) === "draft" && v(["app/lib/brain-only.ts", "app/lib/draft-only.ts"]) === "both" && v(["README.md"]) === "none" && v([]) === "none");
  ok("段: brain/none → brain・draft/both → draft（安全側＝両方）", stageOfClass("brain") === "brain" && stageOfClass("none") === "brain" && stageOfClass("draft") === "draft" && stageOfClass("both") === "draft");

  // ① 本物の git で（分かれ目から変わったファイル・作業中の変更・新しいファイル）
  {
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString();
    git("init", "-q", "-b", "main");
    for (const [p, c] of files) { mkdirSync(join(repo, p, ".."), { recursive: true }); writeFileSync(join(repo, p), c); }
    git("add", "."); git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "work");
    ok("git: main から変わらない → none（brain の最小）", decideStageFromDiff(repo).cls === "none" && decideStageFromDiff(repo).stage === "brain");
    writeFileSync(join(repo, "app/lib/brain-only.ts"), `import "./brain-deep"; // 直した`);
    const d1 = decideStageFromDiff(repo);
    ok("git: 作業中にブレインだけのファイルを直した → brain", d1.cls === "brain" && d1.stage === "brain", JSON.stringify(d1));
    git("commit", "-q", "-am", "brain");
    writeFileSync(join(repo, "app/lib/draft-only.ts"), `// 新しい指示`);
    const d2 = decideStageFromDiff(repo);
    ok("git: 入れた commit（brain）＋作業中（draft）→ both → draft", d2.cls === "both" && d2.stage === "draft", JSON.stringify(d2.files));
    git("checkout", "-q", "--", "app/lib/draft-only.ts");
    writeFileSync(join(repo, "app/lib/new-draft.ts"), `x`);
    writeFileSync(join(repo, "app/api/generate-reply/route.ts"), `import "@/app/lib/new-draft"; import "@/app/lib/shared";`);
    git("commit", "-q", "-am", "draft");
    git("reset", "-q", "--soft", "HEAD~2");
    // 新しいファイル（まだ入れていない）も拾う
    const d3 = decideStageFromDiff(repo);
    ok("git: まだ入れていない新しいファイルも拾う", d3.files.some((f) => f.file === "app/lib/new-draft.ts" && f.cls === "draft"), JSON.stringify(d3.files));
    ok("git: main が無い作業ツリー → 安全側（両方）", decideStageFromDiff(tmp).stage === "draft");
  }

  // ─── ② main の版の鍵 ───────────────────────────────────────────────────
  const blobs = (over: Record<string, string> = {}) => new Map([...files.keys(), "package.json", "README.md", "app/lib/unused.ts"].map((p) => [p, over[p] ?? `h-${p}`]));
  const k0 = examVersionKeyOf(files, blobs());
  ok("版の鍵: 試験に効かないファイル（README・読まれないコード）が変わっても同じ", k0 === examVersionKeyOf(files, blobs({ "README.md": "x", "app/lib/unused.ts": "y", "app/components/Page.tsx": "z" })));
  ok("版の鍵: ブレイン・下書き・設定が変われば違う", k0 !== examVersionKeyOf(files, blobs({ "app/lib/brain-deep.ts": "x" })) && k0 !== examVersionKeyOf(files, blobs({ "app/lib/draft-only.ts": "x" })) && k0 !== examVersionKeyOf(files, blobs({ "package.json": "x" })));

  // ─── ③ 共有の置き場（原子的な書き込み・鍵・問題） ────────────────────────────
  {
    const f = join(tmp, "shared", "counter.json");
    const mod = pathToFileURL(resolve("scripts/lib/exam-shared-file.ts")).href;
    const worker = join(tmp, "worker.mts");
    writeFileSync(worker, `import { updateJsonFile } from ${JSON.stringify(mod)};\nfor (let i = 0; i < 25; i++) updateJsonFile(${JSON.stringify(f)}, () => ({ n: 0, by: [] as number[] }), (c: { n: number; by: number[] }) => ({ n: c.n + 1, by: [...c.by, process.pid] }));\n`);
    const run = () => new Promise<number>((res) => { const c = spawn(process.execPath, [worker], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, NODE_NO_WARNINGS: "1" } }); c.on("exit", (code) => res(code ?? 1)); });
    const codes = await Promise.all([run(), run(), run(), run()]);
    const got = JSON.parse(readFileSync(f, "utf8")) as { n: number; by: number[] };
    ok("鍵＋原子的な書き込み: 4本の process が同時に 25回ずつ足しても 100（抜け・壊れ無し）", codes.every((c) => c === 0) && got.n === 100 && got.by.length === 100, `codes=${codes} n=${got.n}`);
    ok("一時ファイル・鍵が残らない", readdirSync(join(tmp, "shared")).join() === "counter.json", readdirSync(join(tmp, "shared")).join());
    // 落ちた担当の古い鍵は外す
    mkdirSync(`${f}.lock`);
    const old = new Date(Date.now() - 10 * 60_000); (await import("node:fs")).utimesSync(`${f}.lock`, old, old);
    ok("古い鍵（落ちた担当）は外して進む", updateJsonFile<{ n: number }>(f, () => ({ n: 0 }), (c) => ({ ...c, n: c.n + 1 })).n === 101);
    mkdirSync(`${f}.lock`);
    let threw = false; try { withFileLock(f, () => 1, { waitMs: 150 }); } catch { threw = true; }
    ok("新しい鍵は待って、待ちきれなければ投げる（書き込みを壊さない）", threw);
    rmSync(`${f}.lock`, { recursive: true, force: true });
    atomicWriteJson(join(tmp, "shared", "a.json"), { a: 1 });
    ok("原子的な書き込み", JSON.parse(readFileSync(join(tmp, "shared", "a.json"), "utf8")).a === 1);
  }
  {
    const dir = join(tmp, "problems");
    const spec1 = { id: "q001", type: "出し切り", conv: "c1", at: "2026-10-01T00:00:00Z", accept: ["返信"], why: "w" };
    const prob1 = { ...spec1, sub: "s", context: [{ s: "customer", t: "こんにちは", aix: false, ago: 0 }], pc: null, builtAt: "2026-10-15T00:00:00Z" };
    ok("正解の hash は spec と、それから作った問題で同じ", specHashOf(spec1) === specHashOf(prob1));
    ok("正解を直すと別の hash", specHashOf(spec1) !== specHashOf({ ...spec1, accept: ["2段:check"] }));
    ok("置く: 1問1ファイル・2回目は置かない", publishProblems([prob1], dir) === 1 && publishProblems([prob1], dir) === 0 && existsSync(sharedFileOf("q001", specHashOf(spec1), dir)));
    ok("読む: 同じ正解の物だけ", readSharedProblem(spec1, dir)?.builtAt === prob1.builtAt && readSharedProblem({ ...spec1, accept: ["なし"] }, dir) === null);
    ok("会話の無い物（作れなかった問題）は置かない・置き場の名前にできない id は投げる", publishProblems([{ id: "q009" }], dir) === 0 && (() => { try { sharedFileOf("../x", "h", dir); return false; } catch { return true; } })());
    const spec2 = { ...spec1, id: "q002" }, prob2 = { ...prob1, id: "q002" };
    publishProblems([prob2], dir);
    // 手元が無い → spec の全部を共有から
    const r0 = fillProblemsFromShared<typeof prob1>([spec1, spec2], [], { dir });
    ok("手元の problems.json が無い → 共有から全部", r0.problems.map((p) => p.id).join() === "q001,q002" && r0.changed);
    // 手元が古い正解 → 共有の今の正解の物に替える・手元に無い問題は名指しした時だけ足す
    const stale = { ...prob1, accept: ["古い"], builtAt: "old" };
    const extra = { ...prob1, id: "q900" };
    const r1 = fillProblemsFromShared([spec1, spec2], [stale, extra], { dir });
    ok("手元の古い正解 → 共有の物に替える／手元に無い問題は足さない（今まで通り）／spec に無い手元の問題は残す", r1.fromShared.join() === "q001" && r1.problems.map((p) => p.id).join() === "q001,q900" && r1.problems[0].builtAt === prob1.builtAt, JSON.stringify(r1.problems.map((p) => p.id)));
    const r2 = fillProblemsFromShared([spec1, spec2], [stale], { dir, addMissing: (id) => id === "q002" });
    ok("--only で名指しした問題は共有から足す", r2.problems.map((p) => p.id).join() === "q001,q002");
    const r3 = fillProblemsFromShared([{ ...spec1, accept: ["新しい正解"] }], [stale], { dir });
    ok("共有にも無い新しい正解 → 手元の古い物を残して知らせる", r3.staleKept.join() === "q001" && !r3.changed);
  }

  // ─── ② 前の取り置き（問題の hash・揃った印・旧の置き場）────────────────────
  {
    const p = { id: "q1", accept: ["返信"], builtAt: "2026-10-01" };
    ok("問題の hash は作った時刻（builtAt）に依らない", problemHash(p) === problemHash({ ...p, builtAt: "2026-10-15" }) && problemHash(p) !== problemHash({ ...p, accept: ["なし"] }));
    ok("旧の hash（builtAt 込み）も読める", legacyProblemHash(p) !== problemHash(p));
    type R = { rep: number; error?: string };
    const bf = (o: Partial<BaselineFile<R>>): BaselineFile<R> => ({ id: "q1", problemHash: problemHash(p), commit: "c", config: { args: {}, env: {} }, savedAt: "", fromLabel: "", rows: [{ rep: 1 }], ...o });
    const want = [{ id: "q1", hash: problemHash(p), alt: [legacyProblemHash(p)] }];
    ok("旧の hash で取り置いた物も使い回す", planBaseline(want, new Map([["q1", bf({ problemHash: legacyProblemHash(p) })]]), 1).reuse.join() === "q1");
    ok("--repeat=3: 揃った印（揺れる問題だけ繰り返した）は1回でも使い回す・印が無ければ回す",
      planBaseline(want, new Map([["q1", bf({ complete: true })]]), 3, { acceptComplete: true }).reuse.join() === "q1"
      && planBaseline(want, new Map([["q1", bf({ complete: true })]]), 3).run.join() === "q1"
      && planBaseline(want, new Map([["q1", bf({})]]), 3, { acceptComplete: true }).run.join() === "q1");
    ok("失敗の回がある取り置きは揃った印があっても回す", planBaseline(want, new Map([["q1", bf({ complete: true, rows: [{ rep: 1 }, { rep: 2, error: "x" }] })]]), 3, { acceptComplete: true }).run.join() === "q1");
    const m = mergeBaselines(new Map([["q1", bf({ fromLabel: "new" })]]), new Map([["q1", bf({ fromLabel: "old" })], ["q2", bf({ id: "q2", fromLabel: "old" })]]));
    ok("版の置き場を先に・無い問題だけ旧の置き場から", m.get("q1")!.fromLabel === "new" && m.get("q2")!.fromLabel === "old");
    ok("子に渡す: --stage=diff は親で決めた段に置き換える・--baseline-key は渡さない",
      childArgs(["--stage=diff", "--baseline=main", "--baseline-key=commit", "--repeat-flaky", "--replay"], { resolvedStage: "brain" }).join(" ") === "--stage=brain --repeat-flaky --replay"
      && childArgs(["--stage=brain"]).join(" ") === "--stage=brain");
  }

  // ─── ④ 揺れ ─────────────────────────────────────────────────────────────
  {
    const dir = join(tmp, "flake");
    const ob = (o: Partial<FlakeObs>): FlakeObs => ({ id: "q1", problemHash: "h", model: "deepseek-all", codeKey: "k1", label: "L", rep: 1, at: new Date().toISOString(), sig: "返信|○", pathSig: "返信", independent: true, ...o });
    const want = { problemHash: "h", model: "deepseek-all" };
    ok("記録なし → 分からない", flakeVerdict([], want).verdict === "unknown");
    ok("同じコードで答えが割れた → 揺れる", flakeVerdict([ob({}), ob({ rep: 2, sig: "2段:check|✕" })], want).verdict === "flaky");
    ok("独立に3回同じ → 安定（いつもの答えを持つ）", (() => { const v = flakeVerdict([ob({ codeKey: "a" }), ob({ codeKey: "b" }), ob({ codeKey: "c" })], want); return v.verdict === "stable" && v.modal === "返信|○"; })());
    ok("録音の再生だけの回は安定の証拠に数えない", flakeVerdict([ob({ codeKey: "a" }), ob({ codeKey: "b", independent: false }), ob({ codeKey: "c", independent: false })], want).verdict === "unknown");
    ok("コードの違う回で答えが違う → 分からない（直した効果かもしれない＝揺れと言わない）", flakeVerdict([ob({ codeKey: "a" }), ob({ codeKey: "b" }), ob({ codeKey: "c", sig: "なし|✕" })], want).verdict === "unknown");
    ok("違う問題 hash・違うモデルの記録は見ない", flakeVerdict([ob({ problemHash: "old" }), ob({ problemHash: "old", rep: 2, sig: "x" }), ob({ model: "claude", rep: 3, sig: "y" })], want).verdict === "unknown");
    ok("旧の結果（legacy）は同じ実行の中で道が割れたら揺れる・道が同じなら証拠にしない",
      flakeVerdict([ob({ legacy: true, problemHash: "*", codeKey: "label:x", pathSig: "返信" }), ob({ legacy: true, problemHash: "*", codeKey: "label:x", rep: 2, pathSig: "AIX:物件" })], want).verdict === "flaky"
      && flakeVerdict([ob({ legacy: true, problemHash: "*", codeKey: "label:x" }), ob({ legacy: true, problemHash: "*", codeKey: "label:y" }), ob({ legacy: true, problemHash: "*", codeKey: "label:z" })], want).verdict === "unknown");
    const lg = (k: string, path: string, ind = true) => ob({ legacy: true, problemHash: "*", codeKey: `label:${k}`, pathSig: path, sig: `${path}|✕`, independent: ind });
    const lv = flakeVerdict([lg("a", "返信"), lg("a", "返信"), lg("b", "返信"), lg("c", "返信"), lg("d", "返信")], want);
    ok("旧の結果: 録音でない別々の実行3つ以上・5回同じ道 → 道だけで安定", lv.verdict === "stable" && lv.pathOnly === true && lv.modal === "返信", JSON.stringify(lv));
    ok("旧の結果: 録音の再生の回・実行が2つだけ → 安定にしない",
      flakeVerdict([lg("a", "返信", false), lg("a", "返信", false), lg("b", "返信", false), lg("c", "返信", false), lg("d", "返信", false)], want).verdict === "unknown"
      && flakeVerdict([lg("a", "返信"), lg("a", "返信"), lg("a", "返信"), lg("b", "返信"), lg("b", "返信")], want).verdict === "unknown");
    ok("旧の結果で安定でも、今の記録の道が違えば安定にしない", flakeVerdict([lg("a", "返信"), lg("a", "返信"), lg("b", "返信"), lg("c", "返信"), lg("d", "返信"), ob({ pathSig: "なし", sig: "なし|✕" })], want).verdict === "unknown");
    ok("道だけの安定: 1回目の道が同じなら合格の違いは見ない・道が違えば3回", (() => { const done = ["返信|○"]; return !shouldRunRep(2, lv, done, 3) && shouldRunRep(2, lv, ["なし|○"], 3); })());
    const S = { verdict: "stable" as const, modal: "A", why: "", n: 3 }, F = { verdict: "flaky" as const, modal: null, why: "", n: 2 }, U = { verdict: "unknown" as const, modal: null, why: "", n: 0 };
    const plan = (v: typeof S | typeof F | typeof U, sigs: string[]) => { const done: string[] = []; for (let rep = 1; rep <= 3; rep++) if (shouldRunRep(rep, v, done, 3)) done.push(sigs[done.length]); return done.length; };
    ok("安定: 1回・1回目がいつもと違えば3回", plan(S, ["A", "A", "A"]) === 1 && plan(S, ["B", "A", "B"]) === 3);
    ok("揺れる: 3回", plan(F, ["A", "A", "A"]) === 3);
    ok("分からない: 2回・割れたら3回", plan(U, ["A", "A", "A"]) === 2 && plan(U, ["A", "B", "A"]) === 3);
    ok("--repeat=1 なら1回だけ", !shouldRunRep(2, F, ["A"], 1));
    ok("答えの印: 道・合格・下書き", sigOfRow({ path: { code: "返信" }, score: { pass: true }, draft: { code: "返信", pass: false } }) === "返信|○|下書き=返信✕");
    recordObs(ob({}), dir); recordObs(ob({ rep: 2 }), dir);
    ok("記録を書いて読む（実行ごとのファイル）", readObs("q1", dir).length === 2);
    ok("30日より前の記録は読まない", (() => { recordObs(ob({ at: new Date(Date.now() - 40 * 86_400_000).toISOString() }), dir); return readObs("q1", dir).length === 2; })());
    const legacyRows = [{ id: "q7", rep: 1, path: { code: "返信" }, score: { pass: true } }, { id: "q7", rep: 2, path: { code: "なし" }, score: { pass: false } }, { id: "q7", rep: 3, error: "x" }];
    ok("旧の結果を取り込む（失敗の回は入れない）・何度取り込んでも増えない", importLegacyRows(legacyRows, "lab", dir) === 2 && importLegacyRows(legacyRows, "lab", dir) === 2 && readObs("q7", dir).length === 2);
    ok("取り込んだ旧の結果で揺れると分かる", flakeVerdict(readObs("q7", dir), { problemHash: "now", model: "" }).verdict === "flaky");
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(`exam-saver: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
})();
