// scripts/exam-conductor.ts — 試験の統括（試験の依頼を1つの順番待ちにし、安い時間・本数・本番の調子・空きメモリを見て順に流す）
//
// 2026-11-03 竹内さん「試験のブレインのところにも統括がいるのか」（KB P1「試験にも統括を置く」・P0 4c91ffd9）・作業員1:
//   今は作業員どうしが SendMessage で枠を譲り合い、安い時間や本番の時間切れを手で見ていた → この道具1つに寄せる。
//   ・順番待ち: <倉庫の根>/.claude/exam-cache/exam-queue/*.json（1つの依頼＝1ファイル・--add で足す・流した物は done/ へ）
//   ・関所（全部満たした時だけ1本始める）:
//       DeepSeek の安い時間（平日 JST 13〜15・19〜翌10・土日）／本数の上限（JST 9〜22 は PC 全体で1本・それ以外は2本）／
//       本番の調子（直近10分の llm_usage_logs の失敗・cron の失敗が多くない）／空きメモリ（既定 1000MB 以上）／tsc の鍵が無い
//   ・止める: 流している間も2分ごとに本番の調子を見て、悪ければ止めて片付け、依頼を順番待ちに戻す
//   ・結果: 試験の出力の最後（合格 前→今・悪くなった・良くなった・費用）を読み、results/ に JSON と1行を残す
// 2026-11-03 指揮役の順で足した4つ:
//   ① 早めの打ち切り: 30秒ごとに結果の行を前（main）と比べ、前に合格していた問題が残りの回でも合格に届かない（悪化の確定）か、
//      全部の問題の合否が決まったら止める → 片付け → --report で集計し直す（EXAM_STOP_EARLY=off で止める）
//   ② 入れる順番の表への書き戻し: --release-order=<md>（一度渡せば exam-queue/config.json に覚える）のスイッチの行の「状態」を結果に置き換える
//   ③ 問題ごとの揺れ: 揺れの記録（exam-flake）で答えが割れた問題は 4回（EXAM_FLAKY_REPS・3〜6）・それ以外は repeat（既定2）→ --reps-file で渡す
//   ④ 問題の選び: --pick=types:型@N ／ gold（正解の組）／ map（exam-queue/scene-map.json の場面の地図）／ rag（brain-exam --select=rag）
//   ＋ 終わったら依頼した人に知らせる: --notify=<エージェントの id>（無ければ exam-queue/config.json の notify[owner]）→ results/notify.jsonl と conductor.log の「📣 知らせる」の行。--run を見張る作業員がその行を SendMessage で届ける
//   ＋ tsc の依頼: --runner=tsc --cwd=<作業ツリー>（試験と同時に流さない・1本ずつ・空きメモリ 1500MB 以上・%TEMP%/tsc.lock を取る・heap は EXAM_TSC_HEAP_MB 既定 4096）→ 0 か落ちた理由を知らせる
//   ＋ brain-exam 以外の試験の口: --runner=cmd --cmd="scripts/x.ts --a=1" [--cmd=...]（順に流す・関所と本番の見張りは同じ・採点は依頼者）
// 実行:
//   足す:  npx tsx --env-file=.env.local scripts/exam-conductor.ts --add --label=ms-on1 --owner=作業員1 --switch=BRAIN_MATERIAL_SELF_REPORT --cwd=<作業ツリー> --only=q015,q042 --stage=brain [--repeat=2] [--env=K=V,K=V] [--flaky=q091] [--pick=...]
//          （brain-exam 以外）--add --label=sbp --owner=作業員6 --switch=AIX_SECOND_BLUEPRINT --cwd=<作業ツリー> --runner=cmd --cmd="scripts/exam-aix-text.ts --label=sbp-off --qfile=second-appeal.json --kinds=second" --cmd="..."
//   流す:  npx tsx --env-file=.env.local scripts/exam-conductor.ts --run [--once] [--release-order=<md>]
//   見る:  npx tsx --env-file=.env.local scripts/exam-conductor.ts --list
import { spawn, execFileSync } from "node:child_process";
import { rmdirSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { examCacheRoot } from "./lib/llm-cassette";
import { readObs } from "./lib/exam-flake";
import { cheapNow, maxExamsNow, earlyVerdict, repsPlan, pickProblems, updateReleaseOrder, type RowLite, type SceneMap } from "./lib/exam-conductor-core";
export { cheapNow, maxExamsNow } from "./lib/exam-conductor-core";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const argsOf = (k: string) => args.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3));
const flag = (k: string) => args.includes(`--${k}`);
const ROOT = join(examCacheRoot(), "exam-queue");
const DONE = join(ROOT, "done"), RES = join(ROOT, "results");
const CONFIG = join(ROOT, "config.json"), SCENE_MAP = join(ROOT, "scene-map.json");
const LOG = join(ROOT, "conductor.log");
const ensureDirs = () => { for (const d of [ROOT, DONE, RES]) mkdirSync(d, { recursive: true }); };
const log = (s: string) => { ensureDirs(); const line = `${new Date().toISOString()} ${s}`; console.log(line); appendFileSync(LOG, line + "\n"); };
let _sb: ReturnType<typeof createClient> | null = null;
const db = () => (_sb ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""));
const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };

export type ExamJob = {
  id: string; label: string; owner: string; switch: string; cwd: string; only: string; stage: string; repeat: number; env: Record<string, string>; createdAt: string; tries: number;
  /** 依頼で名指しした揺れる問題（③） */ flaky?: string[];
  /** --pick=rag の時 brain-exam --select=rag に任せる（④） */ selectRag?: boolean;
  /** brain-exam 以外の試験（"cmd"）。cmds はそれぞれ npx tsx --env-file=.env.local の後ろに付ける */ runner?: "brain-exam" | "cmd" | "tsc"; cmds?: string[];
  /** 終わったら知らせる相手（エージェントの id・--notify=）。無ければ exam-queue/config.json の notify[owner] */ notify?: string;
};

// ─── 関所 ───────────────────────────────────────────────────────────────
function pcState(): { free: number; exams: number; tsc: boolean } {
  try {
    const ps = `$os=Get-CimInstance Win32_OperatingSystem; $n=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'tsx.dist.cli\\.mjs' -and $_.CommandLine -match '(brain-exam|exam-aix-text)\\.ts' }).Count; $t=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'tsc' }).Count; Write-Output ("" + [int]($os.FreePhysicalMemory/1024) + " " + $n + " " + $t)`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 60_000 }).trim().split(/\s+/);
    return { free: Number(out[0]), exams: Number(out[1]), tsc: Number(out[2]) > 0 || existsSync(join(process.env.TEMP ?? "", "tsc.lock")) };
  } catch { return { free: 0, exams: 99, tsc: true }; }
}
/** 本番の調子: 直近10分の LLM の失敗（テストの行は除く）と cron の失敗。数えるだけ（行は読まない） */
async function prodHealthy(): Promise<{ ok: boolean; why: string }> {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  try {
    const [llm, cron] = await Promise.all([
      db().from("llm_usage_logs").select("id", { count: "exact", head: true }).gte("created_at", since).not("env", "like", "%test%").not("route", "like", "script:%").or("status.gte.500,status.eq.0"),
      db().from("cron_run_logs").select("id", { count: "exact", head: true }).gte("started_at", since).eq("ok", false),
    ]);
    const nl = llm.count ?? 0, nc = cron.error ? 0 : cron.count ?? 0;
    const max = Number(process.env.EXAM_PROD_FAIL_MAX ?? "5");
    return nl + nc > max ? { ok: false, why: `本番の失敗 直近10分 LLM ${nl}・cron ${nc}（上限 ${max}）` } : { ok: true, why: `本番の失敗 LLM ${nl}・cron ${nc}` };
  } catch (e) { return { ok: false, why: `本番の調子を読めない: ${String(e).slice(0, 80)}` }; }
}
/** tsc の依頼の関所: 試験と同時に流さない・tsc は1本ずつ・空きメモリが十分（既定 1500MB・EXAM_TSC_MIN_FREE_MB）。安い時間・本番の調子は見ない（LLM を呼ばない） */
function gateTsc(): { ok: boolean; why: string } {
  const pc = pcState();
  if (pc.tsc) return { ok: false, why: "tsc が動いている（1本ずつ）" };
  if (pc.exams > 0) return { ok: false, why: `試験が ${pc.exams}本動いている（tsc と同時に流さない）` };
  const minFree = Number(process.env.EXAM_TSC_MIN_FREE_MB ?? "1500");
  if (pc.free < minFree) return { ok: false, why: `空きメモリ ${pc.free}MB（tsc は ${minFree} 以上）` };
  return { ok: true, why: `空き ${pc.free}MB` };
}
async function gate(j?: ExamJob): Promise<{ ok: boolean; why: string }> {
  if (j?.runner === "tsc") return gateTsc();
  if (!cheapNow()) return { ok: false, why: "DeepSeek の混雑の時間（平日 10〜13・15〜19）" };
  const pc = pcState();
  if (pc.tsc) return { ok: false, why: "tsc が動いている" };
  if (pc.exams >= maxExamsNow()) return { ok: false, why: `試験が ${pc.exams}本（上限 ${maxExamsNow()}）` };
  const minFree = Number(process.env.EXAM_MIN_FREE_MB ?? "1000");
  if (pc.free < minFree) return { ok: false, why: `空きメモリ ${pc.free}MB（${minFree} 未満）` };
  const h = await prodHealthy();
  return h.ok ? { ok: true, why: `${h.why}・空き ${pc.free}MB` } : h;
}

// ─── 順番待ち ───────────────────────────────────────────────────────────
function readJobs(): Array<ExamJob & { file: string }> {
  ensureDirs();
  return readdirSync(ROOT).filter((f) => f.endsWith(".json") && f !== "config.json" && f !== "scene-map.json").map((f) => ({ ...(JSON.parse(readFileSync(join(ROOT, f), "utf8")) as ExamJob), file: join(ROOT, f) }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function addJob(): void {
  ensureDirs();
  const env = Object.fromEntries(arg("env").split(",").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const cwd = arg("cwd", process.cwd());
  const label = arg("label") || `job-${Date.now()}`;
  const base = { owner: arg("owner", "?"), switch: arg("switch", ""), cwd, stage: arg("stage", "brain"), env, createdAt: new Date().toISOString(), tries: 0, ...(arg("notify") ? { notify: arg("notify") } : {}) };
  let job: ExamJob;
  if (arg("runner") === "tsc") {
    job = { ...base, id: `${Date.now()}`, label, only: "", repeat: 1, runner: "tsc" };
  } else if (arg("runner") === "cmd") {
    const cmds = argsOf("cmd").filter(Boolean);
    if (!cmds.length) throw new Error("--runner=cmd は --cmd=\"scripts/x.ts --a=1\" が要る（何度でも・順に流す）");
    if (cmds.some((c) => !/^scripts\/[\w./-]+\.ts(\s|$)/.test(c))) throw new Error("--cmd は scripts/ の .ts から始める（npx tsx --env-file=.env.local の後ろに付ける）");
    job = { ...base, id: `${Date.now()}`, label, only: "", repeat: 1, runner: "cmd", cmds };
  } else {
    const spec = readJson<Array<{ id: string; type: string }>>(join(cwd, "scripts/brain-exam/spec.json"), []);
    const golds = readJson<{ golds?: Array<{ id: string }> }>(join(cwd, "scripts/parts-eval/gold-20.json"), {}).golds?.map((g) => g.id) ?? [];
    const p = pickProblems(arg("pick"), spec, { golds, map: readJson<SceneMap>(SCENE_MAP, {}), switchName: base.switch, only: arg("only").split(",").filter(Boolean) });
    const flaky = arg("flaky").split(",").filter(Boolean);
    const ids = [...new Set([...p.ids, ...flaky])];
    if (!ids.length && !p.selectRag) throw new Error("問題が無い（--only か --pick を付ける）");
    job = { ...base, id: `${Date.now()}`, label, only: ids.join(","), repeat: Number(arg("repeat", String(p.repeat ?? 2))), flaky, selectRag: p.selectRag, runner: "brain-exam" };
    if (arg("pick")) log(`  選び: ${p.why} → ${ids.length}問`);
  }
  const f = join(ROOT, `${job.createdAt.replace(/[:.]/g, "-")}-${job.label}.json`);
  writeFileSync(f, JSON.stringify(job, null, 1));
  log(`足した: ${job.label}（${job.owner}・${job.switch}・${job.runner === "cmd" ? `${job.cmds!.length}本の試験` : `${job.only || "rag"}・${job.repeat}回${job.flaky?.length ? `・揺れる ${job.flaky.join(",")}` : ""}`}）`);
}

// ─── 流す・結果を読む ─────────────────────────────────────────────────────
function summarize(out: string): { worse: number | null; better: number | null; pass: string | null; usd: string | null } {
  const last = (re: RegExp) => { const ms = [...out.matchAll(re)]; return ms.length ? ms[ms.length - 1] : null; };
  const w = last(/悪くなった (\d+)/g), b = last(/良くなった (\d+)/g), p = last(/合格 前 (\d+) → 今 (\d+)/g);
  const usd = [...out.matchAll(/DeepSeek・Jev 等 \d+回 \$([0-9.]+)/g)].map((m) => Number(m[1])).reduce((a, x) => a + x, 0);
  return { worse: w ? Number(w[1]) : null, better: b ? Number(b[1]) : null, pass: p ? `${p[1]}→${p[2]}` : null, usd: usd ? `$${usd.toFixed(3)}` : null };
}
const resultsDirOf = (cwd: string) => join(cwd, "scripts", "brain-exam", "results");
function readRows(f: string): RowLite[] {
  if (!existsSync(f)) return [];
  const out: RowLite[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) { if (!l.trim()) continue; try { out.push(JSON.parse(l) as RowLite); } catch { /* 書きかけ */ } }
  return out;
}
/** 止めた試験の書きかけの最後の行を落とす（--report が読めるように） */
function dropPartialLines(f: string): void {
  if (!existsSync(f)) return;
  const ok = readFileSync(f, "utf8").split("\n").filter((l) => { if (!l.trim()) return false; try { JSON.parse(l); return true; } catch { return false; } });
  writeFileSync(f, ok.join("\n") + (ok.length ? "\n" : ""));
}
const baseLabelOf = (cwd: string, label: string): string | null => {
  const j = readJson<{ commit?: string; cfg?: string } | null>(join(resultsDirOf(cwd), `${label}.baseline.json`), null);
  return j?.commit && j.cfg ? `main-${j.commit.slice(0, 7)}-${j.cfg}` : null;
};
function killTree(pid?: number): void { try { if (pid) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 終わった */ } }
/** npx tsx を子で動かす（出力は outFile に足す）。終わりを待つ */
function runTsx(cwd: string, argv: string[], env: Record<string, string>, outFile: string): { child: ReturnType<typeof spawn>; done: Promise<number | null> } {
  return runNpx(cwd, ["tsx", "--env-file=.env.local", ...argv], { ...env, LLM_TEST_MODE: "deepseek-all", EXAM_DAILY_CAP_USD: process.env.EXAM_DAILY_CAP_USD ?? "30" }, outFile);
}
function runNpx(cwd: string, argv: string[], env: Record<string, string>, outFile: string): { child: ReturnType<typeof spawn>; done: Promise<number | null> } {
  const fd = openSync(outFile, "a");
  // Windows は shell 経由で動かす＝空白・日本語のあるパス（C:\Users\竹内 悠馬\…）は引用符で包む
  const q = (a: string) => (process.platform === "win32" && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", argv.map(q), { cwd, shell: process.platform === "win32", env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
  const done = new Promise<number | null>((res) => child.on("close", (c) => { try { closeSync(fd); } catch { /* */ } res(c); }));
  return { child, done };
}
/** 止めた試験の片付け（テストの会話の行を id で消す・exam-brain.ts --cleanup の手順） */
async function cleanupRun(cwd: string, label: string, outFile: string): Promise<void> {
  const out = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
  const conv = [...out.matchAll(/テストの会話: (YUMA\d*)（/g)].pop()?.[1];
  if (!conv || conv === "YUMA") { log(`  片付け: テストの会話が読めない（${conv ?? "-"}）→ 手で exam-brain.ts --cleanup --conv=YUMA2〜5 --label=${label} --from=${cwd} --apply`); return; }
  const r = runTsx(cwd, ["scripts/exam-brain.ts", "--cleanup", `--conv=${conv}`, `--label=${label}`, `--from=${cwd}`, "--apply"], {}, outFile);
  const c = await r.done;
  log(`  片付け: ${conv}・label ${label} → ${c === 0 ? "済み" : `失敗（終わりの番号 ${c}）→ 手で同じ片付けを`}`);
}
function cfg(): { releaseOrder?: string; notify?: Record<string, string> } { const c = readJson<{ releaseOrder?: string; notify?: Record<string, string> }>(CONFIG, {}); const a = arg("release-order"); if (a && a !== c.releaseOrder) { c.releaseOrder = a; writeFileSync(CONFIG, JSON.stringify(c, null, 1)); } return c; }
function writeBack(j: ExamJob, status: string): void {
  const f = cfg().releaseOrder;
  if (!f || !j.switch) return;
  try {
    const r = updateReleaseOrder(readFileSync(f, "utf8"), j.switch, status);
    if (r.changed) { writeFileSync(f, r.md); log(`  入れる順番の表に書いた: ${j.switch} → ${status}`); } else log(`  入れる順番の表にスイッチ ${j.switch} の行が無い（書かない）`);
  } catch (e) { log(`  入れる順番の表に書けない: ${String(e).slice(0, 120)}`); }
}
function finish(j: ExamJob & { file: string }, result: Record<string, unknown>, line: string, status: string): void {
  writeFileSync(join(RES, `${j.label}.json`), JSON.stringify(result, null, 1));
  appendFileSync(join(RES, "results.md"), line + "\n");
  renameSync(j.file, join(DONE, j.file.split(/[\\/]/).pop()!));
  writeBack(j, status);
  // 終わったら依頼した人に知らせる: 統括（--run）は SendMessage を持たない → 知らせの行を notify.jsonl と conductor.log に出し、--run を見張る作業員が SendMessage で届ける
  const to = j.notify ?? cfg().notify?.[j.owner] ?? "";
  const msg = `${j.label} 終わり・${status}・結果は exam-queue/results/${j.label}.out.log（${j.label}.json）`;
  appendFileSync(join(RES, "notify.jsonl"), JSON.stringify({ at: new Date().toISOString(), to, owner: j.owner, label: j.label, msg }) + "\n");
  log(`  📣 知らせる: to=${to || `(相手なし・owner ${j.owner})`} ${msg}`);
}

/** tsc の依頼: %TEMP%/tsc.lock を取り（手で回す tsc と同じ鍵）、npx tsc --noEmit を1本流す。結果（0 か落ちた理由）を知らせる */
async function runTscJob(j: ExamJob & { file: string }): Promise<void> {
  const outFile = join(RES, `${j.label}.out.log`);
  const at = () => new Date().toISOString();
  const lock = join(process.env.TEMP ?? process.env.TMP ?? ".", "tsc.lock");
  try { mkdirSync(lock); } catch { log(`  tsc の鍵が取れない（${lock} がある）→ 待つ`); return; }
  const heap = process.env.EXAM_TSC_HEAP_MB ?? "4096";
  log(`流す: ${j.label}（${j.owner}・tsc・heap ${heap}MB・${j.cwd}）`);
  writeFileSync(outFile, `=== ${at()} npx tsc --noEmit（${j.cwd}）===\n`);
  let code: number | null = null;
  try { code = await runNpx(j.cwd, ["tsc", "--noEmit"], { NODE_OPTIONS: `--max-old-space-size=${heap}` }, outFile).done; }
  finally { try { rmdirSync(lock); } catch { /* */ } }
  const out = readFileSync(outFile, "utf8");
  const errs = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
  const verdict = code === 0 ? "tsc 0" : code === 134 || /heap out of memory|JavaScript heap/i.test(out) ? `tsc 落ちた（${code}・メモリ不足）` : errs.length ? `tsc 型エラー ${errs.length}件: ${errs.slice(0, 3).map((l) => l.trim().slice(0, 140)).join(" ／ ")}` : `tsc 落ちた（終わりの番号 ${code}）`;
  finish(j, { label: j.label, owner: j.owner, runner: "tsc", cwd: j.cwd, code, errors: errs.length, verdict, at: at() },
    `| ${at().slice(0, 16)} | tsc | ${j.owner} | ${j.label} | ${verdict.slice(0, 80)} | - | - | $0 |`, verdict);
  log(`  済み: ${j.label} → ${verdict}`);
}

async function runJob(j: ExamJob & { file: string }): Promise<void> {
  if (j.runner === "tsc") return runTscJob(j);
  const outFile = join(RES, `${j.label}.out.log`);
  const at = () => new Date().toISOString();
  // 本番の見張り（2分ごと）: 悪ければ止めて片付け・順番待ちに戻す
  let stopped: string | null = null;
  let cur: ReturnType<typeof spawn> | null = null;
  const watch = setInterval(async () => { const h = await prodHealthy(); if (!h.ok && !stopped) { stopped = h.why; log(`  ⏹ 本番の調子が悪い → 止める（${h.why}）`); killTree(cur?.pid); } }, 120_000);
  try {
    if (j.runner === "cmd") {
      log(`流す: ${j.label}（${j.owner}・${j.switch}・${j.cmds!.length}本・${j.cwd}）`);
      const codes: Array<number | null> = [];
      for (const c of j.cmds!) {
        if (stopped) break;
        appendFileSync(outFile, `\n=== ${at()} npx tsx --env-file=.env.local ${c} ===\n`);
        const r = runTsx(j.cwd, c.match(/"[^"]*"|\S+/g)!.map((x) => x.replace(/^"|"$/g, "")), j.env, outFile); cur = r.child;
        codes.push(await r.done);
      }
      if (stopped) { writeFileSync(j.file, JSON.stringify({ ...j, tries: j.tries + 1, file: undefined }, null, 1)); log(`  順番待ちに戻した（${j.label}・片付けは依頼者の手順で）`); return; }
      const s = summarize(readFileSync(outFile, "utf8"));
      const verdict = codes.every((c) => c === 0) ? "流し終えた（採点は依頼者）" : `失敗あり（終わりの番号 ${codes.join(",")}）`;
      finish(j, { label: j.label, owner: j.owner, switch: j.switch, runner: "cmd", cmds: j.cmds, codes, usd: s.usd, verdict, at: at() },
        `| ${at().slice(0, 16)} | ${j.switch} | ${j.owner} | ${j.label} | ${verdict} | - | - | ${s.usd ?? "?"} |`, `試験 ${j.label}: ${verdict}（${at().slice(5, 16).replace("T", " ")}Z）`);
      log(`  済み: ${j.label} → ${verdict}`);
      return;
    }
    // brain-exam: ③ 問題ごとの回数（揺れる問題は増やす）
    const ids = j.only.split(",").filter(Boolean);
    const rp = repsPlan(ids, (id) => readObs(id), { normal: j.repeat, flakyReps: Number(process.env.EXAM_FLAKY_REPS ?? "4"), forced: j.flaky, model: "deepseek" });
    const maxRep = Math.max(j.repeat, ...Object.values(rp.reps));
    const repsFile = join(RES, `${j.label}.reps.json`);
    writeFileSync(repsFile, JSON.stringify(rp.reps, null, 1));
    log(`流す: ${j.label}（${j.owner}・${j.switch}・${ids.length ? ids.length + "問" : "rag"}・${j.repeat}回${rp.flaky.length ? `・揺れる ${rp.flaky.map((x) => `${x.id}×${rp.reps[x.id]}`).join(",")}` : ""}・${j.cwd}）`);
    for (const f of rp.flaky) log(`  揺れる ${f.id}: ${f.why}`);
    const argv = ["scripts/brain-exam.ts", `--label=${j.label}`, "--conv=auto", "--baseline=main", `--repeat=${maxRep}`, `--stage=${j.stage}`];
    if (ids.length) argv.push(`--only=${j.only}`, `--reps-file=${repsFile}`);
    if (j.selectRag) argv.push("--select=rag");
    const r = runTsx(j.cwd, argv, j.env, outFile); cur = r.child;
    // ① 早めの打ち切り（30秒ごと）
    let early: { stop: string; why: string; base: string } | null = null;
    const rowsFile = join(resultsDirOf(j.cwd), `${j.label}.jsonl`);
    const earlyOn = process.env.EXAM_STOP_EARLY !== "off" && ids.length > 0;
    const ew = earlyOn ? setInterval(() => {
      if (early || stopped) return;
      const bl = baseLabelOf(j.cwd, j.label); if (!bl) return;
      const v = earlyVerdict(readRows(rowsFile), readRows(join(resultsDirOf(j.cwd), `${bl}.jsonl`)), rp.reps);
      if (v.stop) { early = { stop: v.stop, why: v.why, base: bl }; log(`  ⏩ 早めの打ち切り: ${v.why}`); killTree(cur?.pid); }
    }, 30_000) : null;
    const code = await r.done;
    if (ew) clearInterval(ew);
    if (stopped) { await cleanupRun(j.cwd, j.label, outFile); writeFileSync(j.file, JSON.stringify({ ...j, tries: j.tries + 1, file: undefined }, null, 1)); log(`  順番待ちに戻した（${j.label}）`); return; }
    if (early) {
      const e = early as { stop: string; why: string; base: string };
      await cleanupRun(j.cwd, j.label, outFile);
      dropPartialLines(rowsFile);
      appendFileSync(outFile, `\n=== ${at()} 早めの打ち切り（${e.why}）→ 集計し直す ===\n`);
      await runTsx(j.cwd, ["scripts/brain-exam.ts", `--report=${j.label}`, `--baseline=${e.base}`], {}, outFile).done;
    }
    const s = summarize(existsSync(outFile) ? readFileSync(outFile, "utf8") : "");
    const tag = early ? "（早めの打ち切り）" : "";
    const verdict = (s.worse === 0 ? "悪化0" : s.worse == null ? "結果を読めない" : `悪化 ${s.worse}`) + tag;
    finish(j, { label: j.label, owner: j.owner, switch: j.switch, only: j.only, repeat: j.repeat, reps: rp.reps, code, early, ...s, verdict, at: at() },
      `| ${at().slice(0, 16)} | ${j.switch} | ${j.owner} | ${j.label} | ${verdict} | 合格 ${s.pass ?? "?"} | 良くなった ${s.better ?? "?"} | ${s.usd ?? "?"} |`,
      `試験 ${j.label}: ${verdict}・合格 ${s.pass ?? "?"}・良くなった ${s.better ?? "?"}・${s.usd ?? "?"}（${at().slice(5, 16).replace("T", " ")}Z）`);
    log(`  済み: ${j.label} → ${verdict}・合格 ${s.pass ?? "?"}・良くなった ${s.better ?? "?"}・費用 ${s.usd ?? "?"}`);
  } finally { clearInterval(watch); }
}

// 直に流された時だけ動く（テストが関所の関数だけ読む時は動かない）
if (/exam-conductor.ts$/.test(process.argv[1] ?? "")) (async () => {
  if (flag("add")) { addJob(); return; }
  if (flag("list")) { for (const j of readJobs()) console.log(`- ${j.createdAt.slice(0, 16)} ${j.label}（${j.owner}・${j.switch}・${j.runner === "tsc" ? "tsc" : j.runner === "cmd" ? `${j.cmds?.length}本` : `${j.only || "rag"}・${j.repeat}回`}・試み ${j.tries}）`); return; }
  if (flag("run")) {
    cfg();
    for (;;) {
      const jobs = readJobs();
      if (!jobs.length) { log("順番待ちは空"); return; }
      // 先頭から順に関所を見て、通った最初の依頼を流す（試験が安い時間を待つ間も tsc は先に流せる）
      let picked: (typeof jobs)[number] | null = null; const whys: string[] = [];
      let examBlocked = false;
      for (const j of jobs) { if (j.runner !== "tsc" && examBlocked) continue; const g = await gate(j); if (g.ok) { picked = j; break; } whys.push(`${j.label}: ${g.why}`); if (j.runner !== "tsc") examBlocked = true; }
      if (!picked) { log(`待つ: ${whys.slice(0, 3).join("／")}（${jobs.length}本待ち）`); if (flag("once")) return; await new Promise((r) => setTimeout(r, (jobs.some((x) => x.runner === "tsc") ? 1 : 5) * 60_000)); continue; }
      await runJob(picked);
      if (flag("once")) return;
    }
  }
  console.log("使い方: --add ... ／ --run [--once] [--release-order=<md>] ／ --list");
})();
