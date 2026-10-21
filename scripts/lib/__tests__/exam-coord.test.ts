// 試験の担当どうしの連携（scripts/lib/exam-coord.ts・2026-10-21）
// 実行: npx tsx scripts/lib/__tests__/exam-coord.test.ts（自己完結・LLM も DB も使わない。全 PASS で exit 0）
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  tryClaim, releaseClaims, claimFileOf, claimStale, coordStep, baselineWaitMs, pickPrevMainRows, carriedAnsweredAt, answeredAtOf,
  runFingerprint, labelIdentity, readRunsToday, appendRun, findDuplicateRun, runCapUsd, runCapDecision, routeBelongs,
  classifyRoute, mainVersionOfRoute, summarizeSpend, jstDate, readCoordEvents, appendCoordEvent, type Claim,
} from "../exam-coord";
import { planBaseline, childArgs, type BaselineFile } from "../brain-exam-baseline";
import { makeCassetteFetch, setCassetteTag, flushCassette, setCassettePins, cassetteCallsOf, inputDiffOf, pinsFromRows, hasPinsFor, type CassetteStats, type CassetteMode, type CallRef } from "../llm-cassette";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }
const tmp = mkdtempSync(join(tmpdir(), "exam-coord-"));

(async () => {
  // ─── ① 問題ごとの印 ───
  const bdir = join(tmp, "v-abc-cfg");
  const alive = (pid: number) => pid === 1001 || pid === 1002;
  const a = tryClaim(bdir, "q001", "worker-a", { pid: 1001, alive });
  const b = tryClaim(bdir, "q001", "worker-b", { pid: 1002, alive });
  ok("印: 1人目は取れる", a.ok);
  ok("印: 同じ版・同じ問題の2人目は取れない（持ち主が分かる）", !b.ok && (b as { holder: Claim }).holder.label === "worker-a");
  ok("印: 自分の印はもう一度取れる", tryClaim(bdir, "q001", "worker-a", { pid: 1001, alive }).ok);
  ok("印: 別の問題は2人目も取れる", tryClaim(bdir, "q002", "worker-b", { pid: 1002, alive }).ok);
  releaseClaims(bdir, ["q001"], 1002);
  ok("印: 他人の印は外さない", existsSync(claimFileOf(bdir, "q001")));
  releaseClaims(bdir, ["q001"], 1001);
  ok("印: 自分の印は外す", !existsSync(claimFileOf(bdir, "q001")));
  // 止まった持ち主の印は取り直す
  tryClaim(bdir, "q003", "dead", { pid: 999, alive: () => true });
  ok("印: 持ち主が止まった印は古いとみて取り直す", tryClaim(bdir, "q003", "worker-b", { pid: 1002, alive }).ok);
  ok("印: 時間切れは古い", claimStale({ pid: 1, host: "other", label: "x", at: new Date(Date.now() - 7 * 3600_000).toISOString() }, { ttlMs: 6 * 3600_000 }));
  ok("印: 他の機械の新しい印は古くない", !claimStale({ pid: 1, host: "other-host", label: "x", at: new Date().toISOString() }, {}));
  ok("印: force は持ち主がいても上書き", tryClaim(bdir, "q002", "worker-a", { pid: 1001, alive, force: true }).ok);
  { writeFileSync(claimFileOf(bdir, "q004"), ""); const r = tryClaim(bdir, "q004", "worker-b", { pid: 1002, alive }); ok("印: 書きかけ（読めない・30秒以内）の印は外さない＝2人で作らない", !r.ok); ok("印: 書きかけの印も古くなれば取り直す", tryClaim(bdir, "q004", "worker-b", { pid: 1002, alive, now: Date.now() + 60_000 }).ok); }
  ok("待つ上限: 既定 90分・0 で待たない", baselineWaitMs({}) === 90 * 60_000 && baselineWaitMs({ EXAM_BASELINE_WAIT_MIN: "0" }) === 0);

  // 本当に2つの process で同時に取る → 1人だけ（ファイルの wx 作成）
  const race = join(tmp, "race");
  const script = `const {openSync,mkdirSync,writeSync,closeSync}=require("fs");mkdirSync(process.argv[1],{recursive:true});try{const fd=openSync(process.argv[1]+"/q9.claim","wx");writeSync(fd,String(process.pid));closeSync(fd);process.stdout.write("won")}catch(e){process.stdout.write(e.code)}`;
  const run1 = () => new Promise<string>((res) => { const p = spawn(process.execPath, ["-e", script, race]); let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("close", () => res(o)); });
  const outs = await Promise.all([run1(), run1(), run1(), run1()]);
  ok("印: 4つの process が同時に取っても1人だけ", outs.filter((x) => x === "won").length === 1 && outs.filter((x) => x === "EEXIST").length === 3, outs.join(","));

  // 次の手（純関数）
  const st = coordStep(["q1", "q2", "q3"], { done: (id) => id === "q1", claim: (id) => id === "q2", waitedMs: 0, maxWaitMs: 1000 });
  ok("次の手: 出来た＝使う・取れた＝作る・他の担当＝待つ", st.reuse.join() === "q1" && st.mine.join() === "q2" && st.wait.join() === "q3" && !st.steal.length);
  const st2 = coordStep(["q3"], { done: () => false, claim: () => false, waitedMs: 2000, maxWaitMs: 1000 });
  ok("次の手: 待ちすぎたら自分で作る", st2.steal.join() === "q3");

  // ─── ② 前の main の答え ───
  type R = { id: string; rep: number; error?: string; llmCalls?: CallRef[]; inputSame?: boolean };
  const call = (src: CallRef["src"]): CallRef => ({ pk: "pk1", key: "k1", sha: "s1", action: "brain_full", src });
  const now = Date.parse("2026-10-21T10:00:00Z");
  const f = (o: Partial<BaselineFile<R>> & { dir?: string }): BaselineFile<R> & { dir?: string } => ({ id: "q1", problemHash: "h1", commit: "c", config: { args: {}, env: {} }, savedAt: "2026-10-21T08:00:00Z", fromLabel: "x", rows: [{ id: "q1", rep: 1, llmCalls: [call("record")] }], envFp: "", ...o });
  const cands = [f({ dir: "old", savedAt: "2026-10-20T08:00:00Z" }), f({ dir: "new" }), f({ dir: "err", savedAt: "2026-10-21T09:00:00Z", rows: [{ id: "q1", rep: 1, error: "x" }] }), f({ dir: "sw", savedAt: "2026-10-21T09:30:00Z", envFp: "abc" }), f({ dir: "nocalls", savedAt: "2026-10-21T09:40:00Z", rows: [{ id: "q1", rep: 1 }] })];
  ok("前の main: 同じ問題・既定のスイッチ・失敗なし・控えありの一番新しい物", pickPrevMainRows(cands, { hash: "h1" }, { now })?.dir === "new");
  ok("前の main: 問題が直った物は使わない", pickPrevMainRows(cands, { hash: "h2" }, { now }) === null);
  ok("前の main: 古い答え（answeredAt）は期限で外す", pickPrevMainRows([f({ dir: "a", answeredAt: "2026-10-01T00:00:00Z" })], { hash: "h1" }, { now, maxAgeMs: 7 * 86_400_000 }) === null);
  ok("答えた時刻: 全部の回が前と同じなら前の答えた時刻を持ち越す", carriedAnsweredAt([{ id: "q1", rep: 1, inputSame: true }], { savedAt: "S", answeredAt: "A" }, "NOW") === "A");
  ok("答えた時刻: 1回でも違えば今", carriedAnsweredAt([{ id: "q1", rep: 1, inputSame: true }, { id: "q1", rep: 2, inputSame: false }], { savedAt: "S" }, "NOW") === "NOW" && answeredAtOf({ savedAt: "S" }) === "S");
  ok("答えた時刻: 一部の段だけ前の答え（pin）を使った回も前の答えた時刻（期限が延びない）", carriedAnsweredAt([{ id: "q1", rep: 1, inputSame: false, llmCalls: [call("pin"), call("record")] }], { savedAt: "S", answeredAt: "A" }, "NOW") === "A");
  // planBaseline の期限は answeredAt で見る（持ち越しで期限が延び続けない）
  const cached = new Map([["q1", f({ savedAt: new Date(now).toISOString(), answeredAt: "2026-10-01T00:00:00Z", rows: [{ id: "q1", rep: 1 }] })]]);
  ok("期限: 持ち越した答えは元の答えた時刻で期限を見る", planBaseline([{ id: "q1", hash: "h1" }], cached as never, 1, { maxAgeMs: 7 * 86_400_000, now, envFp: "" }).expired.join() === "q1");
  ok("子の引数: --input-diff は main の子に渡さない（下見の子が main を作らずに終わっていた）", childArgs(["--input-diff=plan", "--conv=YUMA4", "--stage=brain"]).join(" ") === "--conv=YUMA4 --stage=brain");

  // 前の main → 次の main → その次の main と、控えが鎖で効く（src=pin の控えも次に使える）
  {
    const cdir = join(tmp, "cassette");
    const stats = (mode: CassetteMode): CassetteStats => ({ mode, dir: cdir, total: { real: 0, realUsd: 0, replayed: 0, replayUsd: 0, missed: 0, unrecordable: 0 }, byAction: new Map(), byTag: new Map(), misses: [] });
    let calls = 0;
    const llm = async (_i: RequestInfo | URL, init?: RequestInit) => { calls++; const b = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> }; return new Response(JSON.stringify({ model: "deepseek-v4-pro", content: [{ type: "text", text: `答え${calls}:${b.messages[0].content}` }], usage: { input_tokens: 100, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } }); };
    const req = (c: string, action: string) => ({ method: "POST", headers: { "content-type": "application/json", "x-sumora-llm-action": action }, body: JSON.stringify({ messages: [{ role: "user", content: c }] }) });
    const solve = async (q: string, brainText: string, mode: CassetteMode, envFp: string) => {
      const fx = makeCassetteFetch(llm as never, { mode, dir: cdir, stats: stats(mode), env: {}, log: () => {}, envFp });
      setCassetteTag({ problem: q, rep: "1" });
      const a = await (await fx("https://api.anthropic.com/v1/messages", req(brainText, "brain_full"))).text();
      await (await fx("https://api.anthropic.com/v1/messages", req(`下書き ${a}`, "draft"))).text();
      await flushCassette();
      return { id: q, rep: 1, llmCalls: cassetteCallsOf(q, 1) };
    };
    setCassettePins(null);
    const m1 = [await solve("qa", "変わらない問題", "record", "m1"), await solve("qb", "変わる問題 v1", "record", "m1")];
    const after1 = calls;
    ok("main 1: 2問×2段を解いた", after1 === 4, String(after1));
    // main 2（別の版＝録音の鍵は違う）: 前の main の控えを入れる
    setCassettePins(pinsFromRows(m1));
    const m2a = await solve("qa", "変わらない問題", "record", "m2");
    const m2b = await solve("qb", "変わる問題 v2", "record", "m2");
    const da = inputDiffOf(m2a.llmCalls, hasPinsFor("qa", 1)), db = inputDiffOf(m2b.llmCalls, hasPinsFor("qb", 1));
    ok("main 2: 要求が同じ問題は前の main の答え（呼ばない）", da.same && da.pinned === 2, JSON.stringify(da));
    ok("main 2: 要求が変わった問題だけ解く", !db.same && calls === after1 + 2, `${calls} ${JSON.stringify(db)}`);
    // main 3: main 2 の行（qa は src=pin）から控え → まだ同じなら呼ばない
    setCassettePins(pinsFromRows([m2a, m2b]));
    const before3 = calls;
    const m3a = await solve("qa", "変わらない問題", "record", "m3");
    ok("main 3: 持ち越した控え（src=pin）も次の版で効く＝鎖", inputDiffOf(m3a.llmCalls, true).same && calls === before3);
    setCassettePins(null);
  }

  // ─── ③ 1回ごとの見張り ───
  const items = [{ id: "q2", reps: 1, model: "pro", draft: false }, { id: "q1", reps: 2, model: "pro", draft: true }];
  const fp1 = runFingerprint({ codeKey: "k", envFp: "", mainKey: "v1", items });
  ok("比べの指紋: 問題の並びに依らない", fp1 === runFingerprint({ codeKey: "k", envFp: "", mainKey: "v1", items: [...items].reverse() }));
  ok("比べの指紋: コード・スイッチ・main の版・回数で変わる", new Set([fp1, runFingerprint({ codeKey: "k2", envFp: "", mainKey: "v1", items }), runFingerprint({ codeKey: "k", envFp: "e", mainKey: "v1", items }), runFingerprint({ codeKey: "k", envFp: "", mainKey: "v2", items }), runFingerprint({ codeKey: "k", envFp: "", mainKey: "v1", items: [{ ...items[0], reps: 3 }, items[1]] })]).size === 5);
  const rdir = join(tmp, "runs"), day = new Date("2026-10-21T03:00:00Z");
  appendRun({ fp: fp1, label: "fix1", ident: "fix1", at: day.toISOString(), cwd: "/w", estUsd: 0.1, ids: ["q1"] }, day, rdir);
  ok("同じ比べ: 今日の帳簿から見つける", findDuplicateRun(readRunsToday(day, rdir), fp1)?.label === "fix1" && !findDuplicateRun(readRunsToday(day, rdir), "zzz"));
  ok("同じ比べ: 翌日（JST）は別の帳簿", readRunsToday(new Date("2026-10-21T16:00:00Z"), rdir).length === 0 && jstDate(new Date("2026-10-21T16:00:00Z")) === "2026-10-22");
  ok("担当の名前: 後ろの -n・-fl・-d を外す", labelIdentity("fix1-n-fl-d", "/x") === "fix1" && labelIdentity("fix1-fl", "/x") === "fix1" && labelIdentity("fix1", "/x") === "fix1");
  ok("担当の名前: 自動の label は作業ツリー", labelIdentity("eb-1021-ab12", "C:/w/.claude/worktrees/exam-brain3") === "wt:exam-brain3" && labelIdentity("eb-1021-ab12-fl", "/a/b/") === "wt:b");
  ok("担当の route: label で始まる route は担当の物・main の作り直しは数えない", routeBelongs("script:brain-exam-fix1-fl-d", "fix1", []) && !routeBelongs("script:brain-exam-main-4f2cd4d-abc123-r1", "fix1", []) && !routeBelongs("script:brain-exam-fix10", "fix1", []));
  ok("担当の route: 作業ツリーの担当は帳簿の label で数える", routeBelongs("script:brain-exam-eb-1021-ab12-fl", "wt:x", ["eb-1021-ab12"]) && !routeBelongs("script:brain-exam-eb-1021-zz99", "wt:x", ["eb-1021-ab12"]));
  ok("担当の上限: 既定 $5・off で無し", runCapUsd({}) === 5 && runCapUsd({ EXAM_RUN_CAP_USD: "off" }) === null && runCapUsd({ EXAM_RUN_CAP_USD: "2.5" }) === 2.5);
  ok("担当の上限: 超えたら夜中", !runCapDecision({ spentUsd: 0.8, estUsd: 0.3, cap: 1 }).ok && runCapDecision({ spentUsd: 0.5, estUsd: 0.3, cap: 1 }).ok);
  ok("担当の上限: --force／夜中の予約は今", runCapDecision({ spentUsd: 5, estUsd: 1, cap: 1, force: true }).ok && runCapDecision({ spentUsd: 5, estUsd: 1, cap: 1, fromQueue: true }).ok);

  // ─── ④ 今日の費用の帳簿（今日の 4f2cd4d の4重の作り直しの形） ───
  ok("route の種類", classifyRoute("script:brain-exam-main-4f2cd4d-a1b2c3d4e5-rmvhcokim", "2026-10-21T05:00:00Z") === "main" && classifyRoute("script:brain-exam-fix1", "2026-10-21T05:00:00Z") === "worker" && classifyRoute("script:brain-exam-fix1", "2026-10-20T17:00:00Z") === "night" && classifyRoute("script:brain-exam-warm-auto-x", "2026-10-21T05:00:00Z") === "night");
  ok("main の版: route から", mainVersionOfRoute("script:brain-exam-main-4f2cd4d-a1b2c3d4e5-rmvhcokim") === "main-4f2cd4d-a1b2c3d4e5");
  const t = "2026-10-21T05:00:00Z";
  const rows = [
    ...["rmvhcokim", "rmvhcjpkc", "rmvhdnhst", "rmvhe2gkc"].map((r, i) => ({ route: `script:brain-exam-main-4f2cd4d-a1b2c3d4e5-${r}`, created_at: t, usd: 0.4 + i * 0.1 })),
    { route: "script:brain-exam-main-1111111-a1b2c3d4e5-rx", created_at: t, usd: 0.3 },
    { route: "script:brain-exam-fix1", created_at: t, usd: 0.5 }, { route: "script:brain-exam-fix1", created_at: t, usd: 0.25 },
  ];
  const s = summarizeSpend(rows);
  ok("費用: 種類ごとの合計", Math.abs(s.byKind.main.usd - 2.5) < 1e-9 && Math.abs(s.byKind.worker.usd - 0.75) < 1e-9 && s.byKind.main.routes === 5, JSON.stringify(s.byKind));
  ok("費用: 同じ版の4本は重なり（一番高い1本以外が無駄）", s.mainDup.length === 1 && s.mainDup[0].routes === 4 && Math.abs(s.dupExtraUsd - (2.2 - 0.7)) < 1e-9, JSON.stringify(s.mainDup));
  const evf = join(tmp, "ev.jsonl");
  appendCoordEvent({ at: "2026-10-21T01:00:00Z", kind: "wait-reuse", label: "a", ids: ["q1"], usd: 0.03 }, evf);
  appendCoordEvent({ at: "2026-10-19T01:00:00Z", kind: "pin", label: "a", ids: ["q2"], usd: 0.05 }, evf);
  writeFileSync(evf, "壊れた行\n", { flag: "a" });
  ok("帳簿: 今日の出来事だけ・壊れた行は飛ばす", readCoordEvents(new Date("2026-10-20T15:00:00Z"), evf).map((e) => e.kind).join() === "wait-reuse");

  rmSync(tmp, { recursive: true, force: true });
  console.log(`exam-coord: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
