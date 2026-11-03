// scripts/exam-conductor.ts — 試験の統括（試験の依頼を1つの順番待ちにし、安い時間・本数・本番の調子・空きメモリを見て順に流す）
//
// 2026-11-03 竹内さん「試験のブレインのところにも統括がいるのか」（KB P1「試験にも統括を置く」・P0 4c91ffd9）・作業員1:
//   今は作業員どうしが SendMessage で枠を譲り合い、安い時間や本番の時間切れを手で見ていた → この道具1つに寄せる。
//   ・順番待ち: <倉庫の根>/.claude/exam-cache/exam-queue/*.json（1つの依頼＝1ファイル・--add で足す・流した物は done/ へ）
//   ・関所（全部満たした時だけ1本始める）:
//       DeepSeek の安い時間（平日 JST 13〜15・19〜翌10・土日）／本数の上限（JST 9〜22 は PC 全体で1本・それ以外は2本）／
//       本番の調子（直近10分の llm_usage_logs の失敗・cron の失敗が多くない）／空きメモリ（既定 1000MB 以上）／tsc の鍵が無い
//   ・回数: 依頼の repeat（既定2）。揺れる問題（依頼の flaky）は3回にする（brain-exam の --repeat は全部の問題に効くので、揺れる問題だけの依頼に分けて足す）
//   ・止める: 流している間も2分ごとに本番の調子を見て、悪ければ止めて依頼を順番待ちに戻す（片付けは exam-brain.ts --cleanup の手順）
//   ・結果: 試験の出力の最後（合格 前→今・悪くなった・良くなった・費用）を読み、results/ に JSON と1行を残す＝指揮役が入れる順番の表に写す
// 実行:
//   足す:  npx tsx --env-file=.env.local scripts/exam-conductor.ts --add --label=ms-on1 --owner=作業員1 --switch=BRAIN_MATERIAL_SELF_REPORT --cwd=<作業ツリー> --only=q015,q042 --stage=brain [--repeat=2] [--env=K=V,K=V] [--flaky=q091]
//   流す:  npx tsx --env-file=.env.local scripts/exam-conductor.ts --run [--once]   （--once は1本だけ・無ければ順番待ちが空になるまで）
//   見る:  npx tsx --env-file=.env.local scripts/exam-conductor.ts --list
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { examCacheRoot } from "./lib/llm-cassette";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => args.includes(`--${k}`);
const ROOT = join(examCacheRoot(), "exam-queue");
const DONE = join(ROOT, "done"), RES = join(ROOT, "results");
for (const d of [ROOT, DONE, RES]) mkdirSync(d, { recursive: true });
const LOG = join(ROOT, "conductor.log");
const log = (s: string) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); appendFileSync(LOG, line + "\n"); };
let _sb: ReturnType<typeof createClient> | null = null;
const db = () => (_sb ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""));

export type ExamJob = { id: string; label: string; owner: string; switch: string; cwd: string; only: string; stage: string; repeat: number; env: Record<string, string>; createdAt: string; tries: number };

// ─── 関所 ───────────────────────────────────────────────────────────────
const jstHM = (d: Date) => { const j = new Date(d.getTime() + 9 * 3600_000); return { h: j.getUTCHours(), dow: j.getUTCDay() }; };
/** DeepSeek の安い時間（平日 JST 10〜13・15〜19 は2倍＝流さない） */
export function cheapNow(d = new Date()): boolean { const { h, dow } = jstHM(d); if (dow === 0 || dow === 6) return true; return !((h >= 10 && h < 13) || (h >= 15 && h < 19)); }
/** 本数の上限（JST 9〜22 は1本・それ以外は2本） */
export function maxExamsNow(d = new Date()): number { const { h } = jstHM(d); return h >= 9 && h < 22 ? 1 : 2; }
function pcState(): { free: number; exams: number; tsc: boolean } {
  try {
    const ps = `$os=Get-CimInstance Win32_OperatingSystem; $n=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'tsx.dist.cli\\.mjs' -and $_.CommandLine -match 'brain-exam\\.ts' }).Count; $t=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'tsc' }).Count; Write-Output ("" + [int]($os.FreePhysicalMemory/1024) + " " + $n + " " + $t)`;
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
async function gate(): Promise<{ ok: boolean; why: string }> {
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
  return readdirSync(ROOT).filter((f) => f.endsWith(".json")).map((f) => ({ ...(JSON.parse(readFileSync(join(ROOT, f), "utf8")) as ExamJob), file: join(ROOT, f) }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function addJob(): void {
  const env = Object.fromEntries(arg("env").split(",").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const base = { owner: arg("owner", "?"), switch: arg("switch", ""), cwd: arg("cwd", process.cwd()), stage: arg("stage", "brain"), env, createdAt: new Date().toISOString(), tries: 0 };
  const label = arg("label") || `job-${Date.now()}`;
  const flaky = arg("flaky").split(",").filter(Boolean);
  const only = arg("only").split(",").filter(Boolean);
  const normal = only.filter((q) => !flaky.includes(q));
  const jobs: ExamJob[] = [];
  if (normal.length) jobs.push({ ...base, id: `${Date.now()}-a`, label, only: normal.join(","), repeat: Number(arg("repeat", "2")) });
  if (flaky.length) jobs.push({ ...base, id: `${Date.now()}-b`, label: `${label}-flaky`, only: flaky.join(","), repeat: Math.max(3, Number(arg("flaky-repeat", "3"))) });
  for (const j of jobs) { const f = join(ROOT, `${j.createdAt.replace(/[:.]/g, "-")}-${j.label}.json`); writeFileSync(f, JSON.stringify(j, null, 1)); log(`足した: ${j.label}（${j.owner}・${j.switch}・${j.only}・${j.repeat}回）`); }
}

// ─── 流す・結果を読む ─────────────────────────────────────────────────────
function summarize(out: string): { worse: number | null; better: number | null; pass: string | null; usd: string | null } {
  const w = /悪くなった (\d+)/.exec(out), b = /良くなった (\d+)/.exec(out), p = /合格 前 (\d+) → 今 (\d+)/.exec(out);
  const usd = [...out.matchAll(/DeepSeek・Jev 等 \d+回 \$([0-9.]+)/g)].map((m) => Number(m[1])).reduce((a, x) => a + x, 0);
  return { worse: w ? Number(w[1]) : null, better: b ? Number(b[1]) : null, pass: p ? `${p[1]}→${p[2]}` : null, usd: usd ? `$${usd.toFixed(3)}` : null };
}
async function runJob(j: ExamJob & { file: string }): Promise<void> {
  const outFile = join(RES, `${j.label}.out.log`);
  log(`流す: ${j.label}（${j.owner}・${j.switch}・${j.only}・${j.repeat}回・${j.cwd}）`);
  const argv = ["tsx", "--env-file=.env.local", "scripts/brain-exam.ts", `--label=${j.label}`, "--conv=auto", "--baseline=main", `--only=${j.only}`, `--repeat=${j.repeat}`, `--stage=${j.stage}`];
  const fd = (await import("node:fs")).openSync(outFile, "a");
  const ch = spawn(process.platform === "win32" ? "npx.cmd" : "npx", argv, { cwd: j.cwd, shell: process.platform === "win32", env: { ...process.env, ...j.env, LLM_TEST_MODE: "deepseek-all", EXAM_DAILY_CAP_USD: process.env.EXAM_DAILY_CAP_USD ?? "30" }, stdio: ["ignore", fd, fd] });
  let stopped: string | null = null;
  const watch = setInterval(async () => { const h = await prodHealthy(); if (!h.ok && !stopped) { stopped = h.why; log(`  ⏹ 本番の調子が悪い → 止める（${h.why}）`); try { if (ch.pid) execFileSync("taskkill", ["/PID", String(ch.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* 終わった */ } } }, 120_000);
  const code: number | null = await new Promise((res) => ch.on("close", (c) => res(c)));
  clearInterval(watch);
  if (stopped) { writeFileSync(j.file, JSON.stringify({ ...j, tries: j.tries + 1, file: undefined }, null, 1)); log(`  順番待ちに戻した（${j.label}・片付け: exam-brain.ts --cleanup --conv=YUMA2〜5 --label=${j.label} --from=${j.cwd}）`); return; }
  const s = summarize(existsSync(outFile) ? readFileSync(outFile, "utf8") : "");
  const result = { label: j.label, owner: j.owner, switch: j.switch, only: j.only, repeat: j.repeat, code, ...s, verdict: s.worse === 0 ? "悪化0" : s.worse == null ? "結果を読めない" : `悪化 ${s.worse}`, at: new Date().toISOString() };
  writeFileSync(join(RES, `${j.label}.json`), JSON.stringify(result, null, 1));
  appendFileSync(join(RES, "results.md"), `| ${result.at.slice(0, 16)} | ${j.switch} | ${j.owner} | ${j.label} | ${result.verdict} | 合格 ${s.pass ?? "?"} | 良くなった ${s.better ?? "?"} | ${s.usd ?? "?"} |\n`);
  renameSync(j.file, join(DONE, j.file.split(/[\\/]/).pop()!));
  log(`  済み: ${j.label} → ${result.verdict}・合格 ${s.pass ?? "?"}・良くなった ${s.better ?? "?"}・費用 ${s.usd ?? "?"}`);
}

// 直に流された時だけ動く（テストが関所の関数だけ読む時は動かない）
if (/exam-conductor.ts$/.test(process.argv[1] ?? "")) (async () => {
  if (flag("add")) { addJob(); return; }
  if (flag("list")) { for (const j of readJobs()) console.log(`- ${j.createdAt.slice(0, 16)} ${j.label}（${j.owner}・${j.switch}・${j.only}・${j.repeat}回・試み ${j.tries}）`); return; }
  if (flag("run")) {
    for (;;) {
      const jobs = readJobs();
      if (!jobs.length) { log("順番待ちは空"); return; }
      const g = await gate();
      if (!g.ok) { log(`待つ: ${g.why}（${jobs.length}本待ち）`); if (flag("once")) return; await new Promise((r) => setTimeout(r, 5 * 60_000)); continue; }
      await runJob(jobs[0]);
      if (flag("once")) return;
    }
  }
  console.log("使い方: --add ... ／ --run [--once] ／ --list");
})();
