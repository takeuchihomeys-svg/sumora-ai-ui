// scripts/exam-brain.ts — 試験のブレイン（どの問題・何回・どこまで・いつ・途中で止めるか・前の結果を使うかを1か所で決めて、計画を先に出してから流す）
//
// 2026-10-17 竹内さん 10/16「判断する所はブレインにまとめて、質を高く節約する」（設計知見 4c91ffd9・P0）。
//   今の試験の費用は1日 $16〜21（10/13〜16 の llm_usage_logs の試験 env・DeepSeek のブレイン brain_fresh/brain_full が 75%）。目標は多い日でも1日 $2〜4。
//   決め方は scripts/lib/exam-brain.ts（純関数・単体テスト）、読み書きは scripts/lib/exam-brain-io.ts。試験そのものは今まで通り scripts/brain-exam.ts を子で回す
//   （今の引数は壊さない）。手順書 scripts/brain-exam/README.md「試験のブレイン」。
//
// 使い方（--conv は試験の会話 YUMA2〜YUMA5。付けなければ YUMA）:
//   計画だけ:   npx tsx --env-file=.env.local scripts/exam-brain.ts --plan [--conv=YUMA4]
//   直した後:   npx tsx --env-file=.env.local scripts/exam-brain.ts --conv=YUMA4 [--label=fix1] [--select-q="言葉 q112"] [--name=q112,q153]
//   最後の関所: npx tsx --env-file=.env.local scripts/exam-brain.ts --gate --conv=YUMA5 [--types=出し切り] [--when=night --wait]
//   取り置き:   npx tsx --env-file=.env.local scripts/exam-brain.ts --warm-main --conv=YUMA5 [--when=night]（本番に入れた版の答えを夜中に取り置く）
//   取り置きの見込み: npx tsx --env-file=.env.local scripts/exam-brain.ts --warm-main --warm-plan --conv=YUMA4（10/22・AI を呼ばない下見だけ: 入力が前の main と同じ問題は0円で取り置き、違う問題の数と見込みの $ を出す）
//   10/22 差分だけの取り置き・1本ずつ: scripts/lib/exam-night.ts（予約は比べが先・取り置きは最後に1本・予算 EXAM_WARM_BUDGET_MIN で切って続きを予約・古い控えは脇へ）
//   予約を流す: npx tsx --env-file=.env.local scripts/exam-brain.ts --run-queue（安い時間に。タスクスケジューラ等から）
//   台帳:       npx tsx scripts/exam-brain.ts --ledger [--id=q153] [--days=14]
//   モデル比べ: npx tsx --env-file=.env.local scripts/exam-brain.ts --model-check --conv=YUMA4 [--types=待って・閉じる] [--n=8]
//   片付け:     npx tsx --env-file=.env.local scripts/exam-brain.ts --cleanup --conv=YUMA2 --label=dg1016-a [--from=<作業ツリー>] [--apply]
//   今日の費用: npx tsx --env-file=.env.local scripts/exam-brain.ts --spend-today（main の作り直し／担当の確かめ／夜・同じ版の作り直しの重なり・連携で避けた分）
// 10/21 連携（scripts/lib/exam-coord.ts）: 同じ比べ（コード・スイッチ・main の版・問題と回数）を今日もう流していれば止める（--force で流す）。
//   担当ごとの1日の上限 EXAM_RUN_CAP_USD（既定 $5・off で無し）を超える回は夜中に予約（--over-cap／--force で今）。
//   main の答えは版ごとに1人だけが作る（他の担当は待って使う・EXAM_BASELINE_WAIT_MIN）・前の main と要求が同じ段は前の答え（EXAM_BASELINE_PIN=off で止める）
// 決める事の引数（既定は試験のブレインが決める）:
//   --when=auto|now|night（auto: 最後の関所・見込み $1 以上は安い時間 JST 1:30〜9:30 に予約）・--wait（予約の代わりにその時間まで待って流す）
//   --max-reps=3・--no-early-stop・--stop-worse=3・--no-reuse・--judge=lazy|full（既定 lazy）・--judge-prefix=as-is|rubric（既定 as-is）
//   --model=pro|flash|auto（10/20 から既定 auto＝model-check で道が同じだった型・問題だけ flash・直しの的と関所は pro）・--replay=strict・--select-n=12・--only=（範囲を絞る）
//   10/20 LINE のブレインの組み方: --reps=old（旧の回数・既定は自信で1回ずつ足す）・--main-missing=night（前の答えが無い問題を夜に）・--no-reasons（外れの理由の読み手を止める）
//   正解の食い違い: scripts/exam-gold-check.ts／本番の外れから問題の候補: scripts/exam-question-candidates.ts（手順書 README「LINE のブレインの組み方に寄せた8つ」）
//   -- の後ろは brain-exam.ts にそのまま渡す
// 10/17 竹内さん「1 2 3 順に改善」「1日に上限は10ドル」:
//   --phase=auto|small|final|off（既定 auto・EXAM_PHASE）: 直しの途中は小さな確かめ（5〜8問・繰り返し2回まで）→ 同じ版で通ったら仕上げ（選んだ問題全部）。off＝旧
//   EXAM_DAILY_CAP_USD=10（off で無し）: 今日（JST）の試験 env の費用＋見込みが超えたら守る線を今・残りを夜中（--over-cap で全部今）
//   2倍の時間（平日 JST 10〜13・15〜19）は警告・仕上げは夜中に。EXAM_REUSE_CONV=off＝会話を見ずに使い回す（旧）
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import {
  mergePicks, confirmTargets, draftTargets, compareProblem, brainChangedOf, stopDecision, decideWhen, isCheapWindow, CHEAP_WINDOW_JST, reuseKey, kbKeyOf, canReuse, dbKeyOf,
  modelOf, estimateUsd, DEFAULT_STOP, draftEligible, type PlanProblem, type Pick, type Cmp, type RowLite, type PlanItem, type When, type ChangeClass, type FlakeKind, type DbPart,
  decidePhase, pickSmall, smallRank, SMALL_MAX_REPS, convKeyOf, dailyCapUsd, capSplit, nextNightRun, peakAdvice, UNIT_USD, type Phase,
  warmDecision, warmLimit, flashSpotCheck, flashProof, FLASH_TYPE_MIN_N, isFixTarget, pickModelCheckIds, modelCheckedCounts, modelPairCountable, peakWaitMinOf, peakWaitMs, type ModelCheckStat, repsModeOf, firstRepsOf, warmRepsOf, confidenceRound2, confidenceRound3, jstDayStart,
} from "./lib/exam-brain";
import {
  loadExamProblems, workingScopeKeys, readReuse, writeReuse, appendLedger, readLedger, readRows, readCost, weakSpotProblems, enqueue, readQueue, dequeue, cwdLooksStripped,
  planCleanup, runCleanup, readDbFingerprintFor, dbPartsOf, EXAM_BRAIN_DIR, MODEL_CHECK_FILE, RESULTS_DIR, type AnyProblem, type LedgerLine,
  readPhaseLog, appendPhaseLog, readDailySpend, readConvContexts, readWarmLog, writeWarmLog,
} from "./lib/exam-brain-io";
import { decideStageFromDiff, examVersionKey } from "./lib/exam-scope";
import { BASELINE_DIR } from "./lib/brain-exam-baseline";
import { examEnvFingerprint, formatEnvFp } from "./lib/exam-env-fp";
import * as C from "./lib/exam-coord";
import { budgetMsOf, orderQueue, sweepStaleBackups, itemHardMs, queueTotalMs } from "./lib/exam-night";
// 2026-10-21 スイッチの指紋（既定＝.env.local と違うスイッチ・exam-env-fp.ts）。使い回しの鍵に入れる・見出しと台帳に残す
// 2026-10-21 査読: 予約（--run-queue）は env を運べず、夜の回が既定のスイッチ（DAY_SUBJECT_READER 無し＝off）で流れて on/off の比べが無効になっていた
//   → 予約の argv に --switch=NAME=値（指紋の組・(unset) は消す）を入れ、子の最初にここで env に戻す（指紋より前）
for (const a of process.argv.slice(2)) { if (a === "--") break; const m = /^--switch=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a); if (!m) continue; if (m[2] === "(unset)") delete process.env[m[1]]; else process.env[m[1]] = m[2]; }
// 2026-10-23 節約の台帳（scripts/lib/exam-savings-io.ts）: 前の回で off だった質を変えないスイッチを、次の回から自動で戻す（--switch= と引数で人が決めた物は触らない・止める EXAM_SAVINGS_AUTO=off）
for (const n of applySavingsAutoAtStart(process.env, new Set([...process.argv.slice(2).flatMap((a) => /^--switch=([A-Za-z_][A-Za-z0-9_]*)=/.exec(a)?.[1] ?? []), ...(process.argv.some((a) => a.startsWith("--input-diff=")) ? ["EXAM_INPUT_DIFF"] : []), ...(process.argv.some((a) => a.startsWith("--reps=")) ? ["EXAM_REPS"] : [])]))) console.log(`節約の自動: ${n}`);
const ENV_FP = examEnvFingerprint(process.env);
/** 予約に入れるスイッチ（指紋の組＝既定と違う物だけ・既定なら空） */
const SWITCH_ARGS = ENV_FP.pairs.map(([k, v]) => `--switch=${k}=${v}`);
import { dbFpMode, problemReadsRent, type DbFpMode } from "./lib/exam-db-fp";
import { problemHash, examConfig, configHash } from "./lib/brain-exam-baseline";
import { flakeVerdict, readObs, FLAKE_DIR } from "./lib/exam-flake";
import { isDeepseekPeakAt } from "../app/lib/llm-price";
import {
  buildMissMap, compareMissMaps, nextFocus, buildCoverage, linksOf, mapStageOf, watchNeighbors, normalizePlan, fallbackRaw, looseJson, buildConductorUser, parseDiffReading, parseTriage, freshProblemIds,
  CONDUCTOR_SYSTEM, DIFF_READER_SYSTEM, TRIAGE_SYSTEM, LINKS, LINK_IDS, MAP_STAGES, MAP_STAGE_JA, MAP_STAGE_SHORT,
  type MissMap, type ProblemLike, type RowLike, type GoldLite, type Candidate, type ConductorInput, type DiffReading, type TriageItem,
} from "./lib/exam-conductor";
import { recordExamWeaknesses } from "../app/lib/brain-weaknesses-server";
import { applySavingsAutoAtStart, detectAndRecord, topOpenSavingsText } from "./lib/exam-savings-io";
import { weaknessHitsFromExamReasons } from "../app/lib/brain-weaknesses";
import { READER_SYSTEM, REASON_KINDS, buildReaderUser, parseReason, machineReason, aggregateReasons, failedOf, type Reason, type ReaderProblem, type ReaderRow } from "./lib/exam-failure-reader";
import { conflictPeers, type GoldConflict } from "./lib/exam-gold-check";
import { diffMaterial, verifyRange, mainAnsweredIds, callConductorLlm, newTally, setLocalSpendRecording, savePlan, loadPlan, saveResult, loadLatestResult, mainRowsOf, latestRowsOf, refreshPath, saveMissMap, safeLines, CONDUCTOR_DIR, PRO_MODEL as C_PRO, FLASH_MODEL as C_FLASH, type SavedPlan } from "./lib/exam-conductor-io";

const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
const args = dd >= 0 ? argv.slice(0, dd) : argv;
const PASS = dd >= 0 ? argv.slice(dd + 1) : [];
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => args.includes(`--${k}`);
const list = (k: string) => arg(k).split(",").map((s) => s.trim()).filter(Boolean);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ?? "");
const CONV = arg("conv");
const MAX_REPS = Math.max(1, Number(arg("max-reps", "3")) || 3);
const GATE = flag("gate");
// 10/17 ① 小さな確かめ／仕上げ（auto＝試験のブレインが決める・off＝旧＝毎回選んだ問題全部）。既定は EXAM_PHASE で変えられる
let PHASE_ARG = arg("phase") || process.env.EXAM_PHASE || "auto";
// 10/20 司令塔（--conduct／--run-plan）: 計画どおり流す時の上書き（問題ごとの回数・モデル・段・判定の段）と、読み手が作った探す言葉
let CONDUCTED: SavedPlan | null = null;
let EXTRA_Q = "";
// 10/20 RAG の選びが見る範囲（--range か、--conduct が main の作業ツリーで自動で決めた起点..HEAD）。空＝作業ツリーの差
let RANGE = arg("range");
const JUDGE = arg("judge", "lazy") === "full" ? "full" : "lazy";
// 2026-10-17 確かめ: rubric の並べ替えは判定の答えを変える（q113 の下書き 2/3→0/3）＝既定は旧の並び（as-is）。rubric は別に比べてから
const JUDGE_PREFIX: "as-is" | "rubric" | "stable" = (() => { const v = arg("judge-prefix", "as-is"); return v === "rubric" || v === "stable" ? v : "as-is"; })();
const REPLAY = arg("replay") === "strict" ? "--replay=strict" : "--replay";
// 2026-10-21 竹内さん「試験の次の節約（質は落とさない）」①入力の差の下見: 子を流す前に、AI を呼ばずに今の版の要求を作って main の要求と比べ、
//   同じ問題×回は main の答えで答案を作る（呼ばない）。違う問題だけ本当に呼ぶ。止める: --input-diff=off（または EXAM_INPUT_DIFF=off）
const INPUT_DIFF_PRE = (arg("input-diff") || process.env.EXAM_INPUT_DIFF || "on").trim().toLowerCase() !== "off";
// ②揺れる問題で入力が同じ物は、揺れを測る時（夜の安い時間）だけ回を足す。止める: EXAM_FLAKY_NIGHT=off
const FLAKY_NIGHT = (process.env.EXAM_FLAKY_NIGHT ?? "").trim().toLowerCase() !== "off";
// 10/20 COST② 回数の決め方（confidence＝既定・自信が低い問題だけ1回ずつ足す／old＝旧）
const REPS_MODE = repsModeOf(arg("reps"), process.env);
// 10/20 COST①: 前（main）の答えが無い問題を今 main で解くか（now・既定）／今は解かず夜中の取り置きに回すか（night＝答えの無い問題は前との比べに入らない）。最後の関所は常に now
const MAIN_MISSING = (arg("main-missing") || process.env.EXAM_MAIN_MISSING || "now").trim().toLowerCase() === "night" ? "night" : "now";
const PRO_MODEL = "deepseek-v4-pro", FLASH_MODEL = "deepseek-flash";
const STAGE_BY_TYPE: Record<string, string> = (() => { try { return JSON.parse(readFileSync("scripts/brain-exam/stage-by-type.json", "utf8")) as Record<string, string>; } catch { return {}; } })();
const stageOfAuto = (p: AnyProblem): "brain" | "draft" => { const s = p.stage ?? STAGE_BY_TYPE[p.type] ?? (p.tags ?? []).map((t) => STAGE_BY_TYPE[t]).find(Boolean) ?? STAGE_BY_TYPE["*"]; return s === "draft" ? "draft" : "brain"; };
// 出し切りの決まり（brain-exam.ts の EXHAUSTED_RULE と同じ）: 揺れの記録の問題の hash を brain-exam と合わせる
const EXHAUSTED_RULE = (() => { try { return readFileSync("app/lib/brain-core.ts", "utf8").includes('from "@/app/lib/search-exhausted"') && process.env.SEARCH_EXHAUSTED_ZENRYOKU !== "off"; } catch { return false; } })();
function effective(p: AnyProblem): AnyProblem {
  const aw = p.acceptWhen as { searchExhausted?: string[]; searchExhaustedAsks?: unknown[] } | undefined;
  return EXHAUSTED_RULE && aw?.searchExhausted?.length && aw.searchExhaustedAsks?.length ? { ...p, asks: aw.searchExhaustedAsks } : p;
}
const log = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jst = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 16);

// ─── 10/20 COST① main の答えは版ごとに1回（merge の後の安い時間に自動で取り置く） ─────────────────────
/** 今の main（origin/main を取り直す・失敗しても手元で続ける）と試験に効く所の版の鍵 */
let mainHeadMemo: { commit: string; vk: string } | null | undefined;
function mainHead(): { commit: string; vk: string } | null {
  if (mainHeadMemo === undefined) mainHeadMemo = mainHead0();
  return mainHeadMemo;
}
function mainHead0(): { commit: string; vk: string } | null {
  try { execFileSync("git", ["fetch", "-q", "origin", "main"], { stdio: "ignore", timeout: 20_000 }); } catch { /* 手元で続ける */ }
  let commit = "";
  try { commit = execFileSync("git", ["rev-parse", "--verify", "origin/main^{commit}"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; }
  try { return { commit, vk: examVersionKey(commit, join(BASELINE_DIR, "version-keys.json")) }; } catch { return null; }
}
/**
 * 今の main の版の答えが取り置かれていなければ、安い時間（夜中の --run-queue・JST 1:40）に --warm-main を予約する（同じ版は1回だけ）。
 *   既定は入れる（竹内さん 10/21 OK・1日の上限の内）: 止める EXAM_AUTO_WARM=off。会話は EXAM_WARM_CONV（無ければ今の --conv が YUMA2〜5 ならそれ・それ以外は YUMA5）
 *   cont＝人が流した --warm-main の続き（上限で途中まで）＝旧の「次の夜中に回す」と同じ扱い（EXAM_AUTO_WARM=off の時だけ止める）
 */
function ensureMainWarm(o: { force?: boolean; runNow?: boolean; quiet?: boolean; cont?: boolean } = {}): void {
  const aw = (process.env.EXAM_AUTO_WARM ?? "").trim().toLowerCase();
  if (aw === "off") { if (!o.quiet) log("main の取り置きの自動予約: 止めている（EXAM_AUTO_WARM=off）"); return; }
  const h = mainHead();
  const d = warmDecision({ vk: h?.vk ?? null, log: readWarmLog(), queued: readQueue().map((x) => x.label), force: o.force });
  if (!d.enqueue || !h) { if (!o.quiet) log(`main の取り置き: ${d.why}`); return; }
  const now = new Date(), at = o.runNow ? now : nextNightRun(now);
  const conv = (process.env.EXAM_WARM_CONV || (/^YUMA[2-5]$/i.test(CONV) ? CONV : "YUMA5")).toUpperCase();
  const f = enqueue({ label: d.label, argv: ["--warm-main", "--when=now", `--conv=${conv}`, `--warm-vk=${h.vk}`], cwd: process.cwd(), at: at.toISOString(), createdAt: now.toISOString(), estUsd: 0 });
  log(`main の取り置き: ${d.why} → ${o.runNow ? "今" : `${jst(at)} JST の --run-queue`}で（${f}）`);
}
/** brain-exam が書いた「前（main）」の数（使い回し・持ち越し・解いた・回さなかった） */
//   2026-10-22 差分だけの取り置き: 下見で入力が同じだった問題（planSame・呼んでいない）は使い回しに数える。deferWhy＝残りが出た訳（budget・main-moved・limit）
function readBaselineSummary(label: string): { reused: number; carried: string[]; run: string[]; deferred: string[]; planSame: string[]; planChanged: string[]; planUsd: number; deferWhy: string | null } | null {
  try {
    const j = JSON.parse(readFileSync(join(RESULTS_DIR, `${label}.baseline.json`), "utf8")) as { reused?: number; carried?: string[]; run?: string[]; deferred?: string[]; planSame?: string[]; planChanged?: string[]; planUsd?: number; deferWhy?: string | null };
    return { reused: (j.reused ?? 0) + (j.planSame?.length ?? 0), carried: j.carried ?? [], run: j.run ?? [], deferred: j.deferred ?? [], planSame: j.planSame ?? [], planChanged: j.planChanged ?? [], planUsd: j.planUsd ?? 0, deferWhy: j.deferWhy ?? null };
  } catch { return null; }
}

// ─── 子（brain-exam.ts）を回す ───────────────────────────────────────────────
type ChildOut = { code: number; baseLabels: string[]; mainLabels: string[]; stopped: boolean };
const q = (s: string) => /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
function runBrainExam(a: string[], env: Record<string, string>, watch?: (out: ChildOut) => Promise<void> | void): Promise<ChildOut> {
  return new Promise((res) => {
    const cmd = ["tsx", "--env-file=.env.local", "scripts/brain-exam.ts", ...a];
    log(`\n▶ npx ${cmd.join(" ")}${Object.keys(env).length ? `（${Object.entries(env).filter(([k]) => !/KEY|SECRET|TOKEN/.test(k)).map(([k, v]) => `${k}=${v}`).join(" ")}）` : ""}`);
    const out: ChildOut = { code: 0, baseLabels: [], mainLabels: [], stopped: false };
    // 試験は既定で DeepSeek（最後の Claude は LLM_TEST_FINAL_CLAUDE=1 を自分で付ける）
    const base = process.env.LLM_TEST_MODE || process.env.LLM_TEST_FINAL_CLAUDE ? {} : { LLM_TEST_MODE: "deepseek-all" };
    const ch = spawn(process.platform === "win32" ? "npx.cmd" : "npx", cmd.map(q), { env: { ...process.env, ...base, ...env }, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    // 2026-10-21 確かめる人: Windows は親（この実行）を止めても npx の下の node が残り、試験が LLM を呼び続け・会話に書き続けた
    //   → 親が止まる時（Ctrl+C・kill・終わり）は子の木ごと止める（taskkill /T）
    const killTree = () => { if (ch.exitCode !== null || !ch.pid) return; try { if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(ch.pid), "/T", "/F"], { stdio: "ignore" }); else ch.kill("SIGTERM"); } catch { /* 既に止まっている */ } };
    const onSig = (sig: NodeJS.Signals) => { killTree(); process.exit(sig === "SIGINT" ? 130 : 143); };
    process.on("exit", killTree); process.once("SIGINT", onSig); process.once("SIGTERM", onSig); process.once("SIGHUP", onSig);
    ch.on("close", () => { process.off("exit", killTree); process.off("SIGINT", onSig); process.off("SIGTERM", onSig); process.off("SIGHUP", onSig); });
    let buf = "";
    const onData = (d: Buffer, err: boolean) => {
      const t = d.toString(); (err ? process.stderr : process.stdout).write(t);
      buf += t; const ls = buf.split("\n"); buf = ls.pop() ?? "";
      for (const l of ls) {
        const m = l.match(/前の結果: (main-[\w-]+)/); if (m && !out.baseLabels.includes(m[1])) out.baseLabels.push(m[1]);
        const r = l.match(/--label=(main-[\w-]+)/); if (r && !out.mainLabels.includes(r[1])) out.mainLabels.push(r[1]);
        if (/⏹ 止める印/.test(l)) out.stopped = true;
      }
    };
    ch.stdout.on("data", (d) => onData(d, false)); ch.stderr.on("data", (d) => onData(d, true));
    let done = false;
    const tick = async () => { while (!done) { try { await watch?.(out); } catch (e) { log(`（見張りの失敗: ${String(e).slice(0, 120)}）`); } await sleep(8000); } };
    void tick();
    ch.on("close", (c) => { done = true; out.code = c ?? 1; res(out); });
  });
}

// ─── 前（main）との比べ ──────────────────────────────────────────────────────
function compareAll(ids: string[], label: string, baseLabels: string[], baseRows?: RowLite[]): Array<{ id: string; cmp: Cmp; why: string }> {
  const cur = readRows(label), base = baseRows ?? baseLabels.flatMap((b) => readRows(b));
  return ids.map((id) => ({ id, ...compareProblem(cur.filter((r) => r.id === id), base.filter((r) => r.id === id)) }));
}

// ─── 計画 ─────────────────────────────────────────────────────────────
type Plan = {
  label: string; cls: ChangeClass; clsNote: string; picks: Pick[]; items: Map<string, PlanItem & { stage1: "brain"; draftWhy: string; flake: FlakeKind; flakeWhy: string; key: string; draftKey: string; hash: string }>;
  probs: Map<string, AnyProblem>; draftPlan: { ids: string[]; why: string; mode: "all" | "if-changed" | "none" };
  keys: { brain: string; draft: string; tool: string }; cfgHash: string; ragNote: string;
  /** DB の表の指紋（段ごと）。null＝読めない表がある＝その段は使い回さない・使い回しの置き場にも書かない */
  db: { parts: DbPart[] | null; mode: DbFpMode; brain: string | null; draft: string | null };
  /** 10/17 ① 小さな確かめ／仕上げ／旧。allPicks＝仕上げで流す問題（今の選び全部）・versionKey＝同じ版か（効くファイル・道具・構成・DB の鍵） */
  phase: Phase; phaseWhy: string; allPicks: Pick[]; repsCap: number; versionKey: string;
  /** 10/17 ③ 会話の鍵（"-"＝会話の違いは答えに効かない・null＝読めない＝使い回さない） */
  conv: { key: string | null; why: string };
  /** 2026-10-21 スイッチの指紋（"" ＝既定） */
  envFp: string;
};
async function makePlan(label: string): Promise<Plan> {
  const { spec, full } = loadExamProblems();
  const only = list("only"), types = list("types");
  let scope = spec.filter((p) => (!only.length || only.includes(p.id)) && (!types.length || types.includes(p.type) || (p.tags ?? []).some((t) => types.includes(t))));
  if (!scope.length) throw new Error("問題が無い（--only・--types を確かめる）");
  const probs = new Map(scope.map((p) => [p.id, effective((full.get(p.id) ?? p) as AnyProblem)]));
  scope = scope.map((p) => probs.get(p.id)!);
  // 1. どの問題（RAG＋必ず流す物）
  let rag: { mode: "all" | "rag"; picked: Array<{ id: string; why: string[]; must: boolean }> } | null = null;
  let cls: ChangeClass = "both", clsNote = "", ragNote = "";
  if (GATE || only.length || arg("select") === "all") {
    const d = decideStageFromDiff(".");
    cls = d.cls; clsNote = d.note;
    rag = { mode: "all", picked: scope.map((p) => ({ id: p.id, why: [GATE ? "最後の関所（全部）" : only.length ? "--only の範囲（全部）" : "--select=all"], must: true })) };
  } else {
    try {
      const { ragSelect } = await import("./lib/exam-rag-run");
      const r = await ragSelect(sb, scope as never, { stageOf: stageOfAuto as never, topN: Math.max(1, Number(arg("select-n", "12")) || 12), extraQuery: [arg("select-q"), EXTRA_Q].filter(Boolean).join(String.fromCharCode(10)) || undefined, range: RANGE || undefined });
      rag = r; cls = r.decision.cls; clsNote = r.decision.note; ragNote = `${r.mode === "all" ? "全部" : `RAG ${r.picked.length}/${scope.length}問`}${r.note ? `・${r.note}` : ""}・変わったファイル ${r.decision.files.length}・知見の変化 ${r.kbChanged}`;
    } catch (e) { ragNote = `RAG の選びが失敗 → 安全側で全部（${String(e instanceof Error ? e.message : e).slice(0, 120)}）`; rag = null; const d = decideStageFromDiff("."); cls = d.cls; clsNote = d.note; }
  }
  let links: Record<string, Array<{ kbId: string; kind: string; score: number }>> = {};
  let kbNow: Record<string, string> | null = null;
  try { const st = await import("./lib/exam-rag-store"); links = await st.loadLinks(sb) as never; const { kbHashMap } = await import("./lib/exam-rag-run"); kbNow = kbHashMap(await st.loadKbRows(sb)); } catch (e) { log(`（知見の紐付けが読めない: ${String(e).slice(0, 100)}）`); }
  const weak = GATE ? {} : weakSpotProblems(links);
  // 2026-10-23 弱い所の台帳（読むだけ）: 開いている弱い所の証拠の問題を、選んだ問題の中で先に回す（小さな確かめの順・司令塔の候補）。問題は足さない
  const wq = GATE ? { map: {}, note: "" } : await openWeaknessQids();
  if (wq.note) ragNote = `${ragNote}${ragNote ? "・" : ""}弱い所の台帳: ${wq.note}`;
  const allPicks = mergePicks(scope as PlanProblem[], rag, { gate: GATE, named: list("name"), weakSpotProblems: weak, weaknessQids: wq.map });
  // 2. 何回・6. 使い回し・8. モデル
  const keys = workingScopeKeys(".");
  // 6. 使い回しの鍵に DB の中身（穴③）: ブレインと下書きが読む表の指紋を1回だけ読む（読むだけ）。--no-reuse の時は読まない
  // 2026-10-18: 既定は中身の指紋（試験が読む行の中身だけ・時刻を入れない＝本番の書き込みで数分ごとに変わらない）。EXAM_DB_FP=fine＝旧（件数・最後の時刻）
  const fpMode = dbFpMode();
  const dbParts = flag("no-reuse") ? null : await readDbFingerprintFor(sb, fpMode).catch((e) => { log(`（DB の指紋が読めない → 使い回さない: ${String(e).slice(0, 100)}）`); return null; });
  const db = { parts: dbParts, mode: fpMode, brain: dbKeyOf(dbParts, dbPartsOf("brain", fpMode)), draft: dbKeyOf(dbParts, dbPartsOf("draft", fpMode)) };
  const cfgHash = configHash(examConfig({ ...process.env, ...(CONDUCTED?.plan.judge === "tier" && !process.env.EXAM_JUDGE_TIER ? { EXAM_JUDGE_TIER: "on" } : {}) }, { judge: JUDGE, judgePrefix: JUDGE_PREFIX, layer: "prod", ledger: true, repeat: MAX_REPS, exhaustedRule: EXHAUSTED_RULE }));
  // 10/17 ① 小さな確かめか仕上げか（同じ版＝効くファイル・道具・構成・DB の鍵が同じ）
  // 2026-10-17 確かめる人: DB の指紋は本番の書き込み（ai_reply_knowledge・ai_reply_examples・trigger_action_rules・phrase_dictionary 等＝1日 数百行）で数分ごとに変わる＝
  //   版に入れると次の実行は必ず「この版の小さな確かめがまだ無い」になり、仕上げに進まず小さな確かめだけが続く。版＝作る人が直す物（ファイル・道具・構成）だけ
  //   （DB の違いは使い回しの鍵が見る＝仕上げは今の DB で回る）
  const versionKey = [keys.brain, keys.draft, keys.tool, cfgHash].join("/");
  const ph = decidePhase({ explicit: PHASE_ARG, gate: GATE, pickCount: allPicks.length, keys: versionKey, history: readPhaseLog() });
  const picks = ph.phase === "small" ? pickSmall(allPicks) : allPicks;
  const repsCap = ph.phase === "small" && !arg("max-reps") ? Math.min(MAX_REPS, SMALL_MAX_REPS) : MAX_REPS;
  // 10/17 ③ 会話の違いが答えに効くか（効かない＝別の会話・別の作業ツリーの結果も使う・効く＝会話も鍵に）。EXAM_REUSE_CONV=off＝旧（会話を見ない）
  let conv: Plan["conv"] = { key: "-", why: "会話を見ない（EXAM_REUSE_CONV=off＝旧）" };
  if (process.env.EXAM_REUSE_CONV !== "off" && !flag("no-reuse")) {
    try {
      const c = await readConvContexts(sb, CONV);
      conv = convKeyOf(c.cur, c.all);
      // --conv=auto はどの会話になるか分からない＝全部が同じ時だけ使い回す
      if (CONV.toLowerCase() === "auto" && conv.key !== "-") conv = { key: null, why: `--conv=auto で試験の会話の効く所が揃っていない → 使い回さない（${conv.why}）` };
    }
    catch (e) { conv = { key: null, why: `会話の効く所が読めない → 使い回さない（${String(e).slice(0, 100)}）` }; }
  }
  const mc = readModelCheck();
  // 10/20 COST③: 既定は auto（model-check で flash の道が pro と同じだった型・問題だけ flash・直しの的は pro）。旧は --model=pro
  const modelMode = (arg("model", "auto") as "pro" | "flash" | "auto");
  const items: Plan["items"] = new Map();
  for (const pk of picks) {
    const p = probs.get(pk.id)!;
    const fo = CONDUCTED?.plan.focus.find((f) => f.id === p.id);
    // 見直し: 司令塔が flash を選んでも、比べで道が違った問題・直しの的（fix）は pro に戻す
    const model = fo ? (fo.model === "flash" && (mc.badIds.has(p.id) || fo.role === "fix") ? "pro" : fo.model) : modelOf(p as PlanProblem, { mode: modelMode, flashOkTypes: mc.okTypes, flashOkIds: mc.okIds, flashBadIds: mc.badIds, gate: GATE, protect: isFixTarget(pk.why) });
    const modelLabel = model === "flash" ? `deepseek-all:${FLASH_MODEL}` : "deepseek-all";
    const fv = flakeVerdict(readObs(p.id), { problemHash: problemHash(p), model: modelLabel });
    const reps = fo ? fo.reps : firstRepsOf(REPS_MODE, fv.verdict, repsCap, { gate: GATE });
    const hash = problemHash(p);
    const kbKey = kbKeyOf(links[p.id], kbNow);
    const convKey = conv.key ?? "-";
    // 2026-10-18: 相場の材料（rent_observations）は相場を聞く番の問題だけ鍵に入れる（中身の形だけ・旧は全部同じ）。読めない表がある時は db.brain/draft が null＝使い回さない（下の判定）
    const rent = problemReadsRent(p as never);
    const dbB = db.brain && dbKeyOf(dbParts, dbPartsOf("brain", fpMode, { rent })), dbD = db.draft && dbKeyOf(dbParts, dbPartsOf("draft", fpMode, { rent }));
    const key = reuseKey({ problemHash: hash, stage: "brain", scopeKey: keys.brain, toolKey: keys.tool, cfgHash, model: modelLabel, kbKey, dbKey: dbB ?? "-", convKey, envFp: ENV_FP.hash });
    const draftKey = reuseKey({ problemHash: hash, stage: "draft", scopeKey: keys.draft, toolKey: keys.tool, cfgHash, model: modelLabel, kbKey, dbKey: dbD ?? "-", convKey, envFp: ENV_FP.hash });
    const reuse = !flag("no-reuse") && !!db.brain && conv.key !== null && canReuse(readReuse(p.id, key), key, reps);
    items.set(p.id, { id: p.id, reps, draft: false, reuse, model, why: pk.why, stage1: "brain", draftWhy: "", flake: fv.verdict, flakeWhy: fv.why, key, draftKey, hash });
  }
  // 3. どこまで（下書きの見込み）
  const pl = scope.filter((p) => items.has(p.id)) as PlanProblem[];
  const dAll = draftTargets(cls, pl, new Set(pl.map((p) => p.id)), { gate: GATE });
  const draftMode: "all" | "if-changed" | "none" = GATE || cls === "draft" || cls === "both" ? "all" : dAll.ids.length ? "if-changed" : "none";
  const draftPlan = { ids: draftMode === "all" ? dAll.ids : [], why: draftMode === "all" ? dAll.why : "ブレインの判断が前（main）と変わった問題だけ（1段目の後に決める）", mode: draftMode };
  if (CONDUCTED) { const ds = CONDUCTED.plan.focus.filter((f) => f.stage === "draft" && items.has(f.id) && draftEligible(probs.get(f.id) as PlanProblem)).map((f) => f.id); draftPlan.ids = ds; draftPlan.mode = ds.length ? "all" : "if-changed"; draftPlan.why = ds.length ? "司令塔が下書きまでと決めた問題" : "司令塔は下書きを選ばなかった（判断が前と変わった問題だけ）"; }
  for (const id of draftPlan.ids) { const it = items.get(id); if (it) { it.draft = true; it.draftWhy = draftPlan.why; } }
  return { label, cls, clsNote, picks, items, probs, draftPlan, keys, cfgHash, ragNote, db, phase: ph.phase, phaseWhy: ph.why, allPicks, repsCap, versionKey, conv, envFp: ENV_FP.hash };
}
/** 見込みの値段: 旧は「安い時間（JST 1:30〜9:30）の外は混雑の値段」で数えていた。小さな確かめ・仕上げは本当の値段（2倍の時間だけ高い・llm-price の isDeepseekPeakAt） */
const pricePeak = (pl: Plan, d: Date) => pl.phase === "off" ? !isCheapWindow(d) : isDeepseekPeakAt(d);
/** この実行の見込み（今の側＋判断が変わった問題の下書き 最大）。ids を渡すとその問題だけ */
function planEst(pl: Plan, peak: boolean, ids?: string[]): number {
  const its = [...pl.items.values()].filter((x) => !ids || ids.includes(x.id));
  const ifChanged = pl.draftPlan.mode === "if-changed" ? its.filter((x) => !x.draft && !x.reuse && draftEligibleOf(pl, x.id)).length : 0;
  return estimateUsd(its, { peak }).now + ifChanged * UNIT_USD.draftExtra * (peak ? UNIT_USD.peakRatio : 1);
}
type Budget = { used: { usd: number; rows: number } | null; usedErr?: string; cap: number | null; split: ReturnType<typeof capSplit> | null };
async function budgetOf(pl: Plan, peak: boolean, now: Date): Promise<Budget> {
  const cap = dailyCapUsd(process.env);
  if (cap === null) return { used: null, cap, split: capSplit({ ids: [...pl.items.keys()], whyOf: () => [], estOf: (ids) => planEst(pl, peak, ids), usedUsd: 0, cap: null }) };
  const used = await readDailySpend(sb, now).catch((e) => { return { err: String(e instanceof Error ? e.message : e).slice(0, 120) }; });
  // 読めない時は安全側＝上限ちょうどまで使った物として数える（守る線だけ今・残りは夜中）
  const usedUsd = "err" in used ? cap : used.usd;
  const split = capSplit({ ids: [...pl.items.keys()], whyOf: (id) => pl.items.get(id)?.why ?? [], estOf: (ids) => planEst(pl, peak, ids), usedUsd, cap, force: flag("over-cap"), fill: process.env.EXAM_FROM_QUEUE === "1" });
  return "err" in used ? { used: null, usedErr: used.err, cap, split } : { used, cap, split };
}
function printPlan(pl: Plan, now: Date, x: { budget?: Budget; peakWarn?: string | null; when?: string } = {}) {
  const its = [...pl.items.values()];
  const peak = pricePeak(pl, now);
  const est = estimateUsd(its, { peak });
  const ifChangedMax = pl.draftPlan.mode === "if-changed" ? its.filter((x) => !x.draft && draftEligibleOf(pl, x.id)).length : 0;
  log(`\n=== 試験のブレインの計画（${pl.label}・${jst(now)} JST）===`);
  if (x.peakWarn) log(x.peakWarn);
  log(`形: ${pl.phase === "small" ? `小さな確かめ（${pl.picks.length}/${pl.allPicks.length}問・繰り返し ${pl.repsCap}回まで）` : pl.phase === "final" ? `仕上げ（選んだ問題全部 ${pl.allPicks.length}問）` : `旧（選んだ問題全部 ${pl.allPicks.length}問）`} — ${pl.phaseWhy}${pl.phase === "small" ? `／仕上げの時に足す ${pl.allPicks.length - pl.picks.length}問` : ""}`);
  log(`使い回し（作る人と確かめる人で分け合う・置き場 ${EXAM_BRAIN_DIR}）: ${pl.conv.why}`);
  log(`スイッチの指紋（使い回し・録音の鍵に入る・前＝main は既定のスイッチで回す）: ${formatEnvFp(ENV_FP)}`);
  if (x.budget) {
    const b = x.budget, s = b.split;
    log(`1日の上限: ${b.cap === null ? "なし（EXAM_DAILY_CAP_USD=off）" : `今日の使用額 ${b.used ? `$${b.used.usd.toFixed(2)}（JST ${jst(now).slice(5, 10)}・試験 env の DeepSeek＋Claude ${b.used.rows}行）` : `読めない（${b.usedErr ?? ""}）＝上限まで使った物として数える`}・上限 $${b.cap}・この実行の見込み $${((s?.estNow ?? 0) + (s?.estLater ?? 0)).toFixed(2)}`}${s ? ` → ${s.why}` : ""}`);
    if (s && s.later.length) log(`  夜中に回す ${s.later.length}問（JST ${jst(nextNightRun(now)).slice(5)} の --run-queue）: ${s.later.join(",")}`);
  }
  if (x.when) log(`いつ: ${x.when}`);
  log(`変わった所: ${pl.cls === "both" ? "ブレインと下書きの両方" : pl.cls === "brain" ? "ブレインだけ" : pl.cls === "draft" ? "下書きだけ" : "試験に効く変更なし"}${pl.clsNote ? `（${pl.clsNote}）` : ""}${pl.ragNote ? `・選び: ${pl.ragNote}` : ""}`);
  log(`効く所の鍵: ブレイン ${pl.keys.brain}・下書き ${pl.keys.draft}・試験の道具 ${pl.keys.tool}・構成 ${pl.cfgHash}・判定 ${JUDGE}/${JUDGE_PREFIX}`);
  const bad = (pl.db.parts ?? []).filter((x) => !x.ok);
  log(`DB の指紋（使い回しの鍵・${pl.db.mode === "fine" ? "旧＝件数・最後の時刻（EXAM_DB_FP=fine）" : "中身＝試験が読む行だけ"}）: ${pl.db.parts ? `${pl.db.parts.length}部分・ブレイン ${pl.db.brain ?? "読めない表あり"}・下書き ${pl.db.draft ?? "読めない表あり"}${bad.length ? `（読めない: ${bad.map((x) => `${x.table}＝${x.why ?? ""}`).join("／")} → その段は使い回さない）` : ""}` : "読まない（--no-reuse か読めない）＝使い回さない"}`);
  log(`問題 ${its.length}問（使い回し ${its.filter((x) => x.reuse).length}・揺れる ${its.filter((x) => x.flake === "flaky").length}・flash ${its.filter((x) => x.model === "flash").length}）`);
  for (const it of its) log(`  ${it.reuse ? "♻" : "▶"} ${it.id} [${pl.probs.get(it.id)?.type}] 回 ${it.reps}${it.flake === "flaky" ? "（揺れる）" : ""}・段 ブレイン${it.draft ? "→下書き" : pl.draftPlan.mode === "if-changed" && draftEligibleOf(pl, it.id) ? "（判断が変われば下書き）" : ""}${it.model === "flash" ? "・flash" : ""}${it.reuse ? "・前の結果を使う（使う物が同じ）" : ""} ← ${it.why.slice(0, 3).join("／")}`);
  log(`段: 1段目＝全部をブレインの判断まで（stage=brain）／2段目＝${pl.draftPlan.mode === "all" ? `下書きまで ${pl.draftPlan.ids.length}問（${pl.draftPlan.why}）` : pl.draftPlan.mode === "if-changed" ? `判断が前と変わった問題だけ下書きまで（最大 ${ifChangedMax}問）` : "下書きなし"}`);
  log(`途中で止める: ${flag("no-early-stop") ? "しない" : `最初の ${DEFAULT_STOP.minSeen}問以上で前より悪い問題が ${Number(arg("stop-worse", String(DEFAULT_STOP.worseN)))}問（揺れる問題は数えない）`}・${REPS_MODE === "old" ? `前と違った問題は確かめに ${pl.repsCap}回まで足す（旧・--reps=old）` : `回数は自信で（2回目は前と違った・外れた・揺れる問題だけ・3回目は割れた問題だけ・最大 ${pl.repsCap}回）`}`);
  log(`見込みの費用（今の側・${peak ? "混雑時の値段込み" : "通常の値段"}）: 約 $${est.now.toFixed(2)}＋判断が変わった問題の下書き 最大 $${(ifChangedMax * 0.015 * (peak ? 1.6 : 1)).toFixed(2)}／前（main）の取り置きが無い問題は main でも回す（1問 約 $0.03・夜中の --warm-main で作っておけば0）`);
}
function draftEligibleOf(pl: Plan, id: string): boolean { const p = pl.probs.get(id); return !!p && [...(p.accept ?? []), ...(((p.acceptWhen as { searchExhausted?: string[] } | undefined)?.searchExhausted) ?? [])].some((a) => !a.startsWith("AIX")); }
function readModelCheck(): { okTypes: Set<string>; okIds: Set<string>; badIds: Set<string>; byType: Record<string, ModelCheckStat> } {
  try { const j = JSON.parse(readFileSync(MODEL_CHECK_FILE, "utf8")) as { byType: Record<string, ModelCheckStat>; byId?: Record<string, ModelCheckStat> }; return { byType: j.byType, ...flashProof(j) }; }
  catch { return { okTypes: new Set(), okIds: new Set(), badIds: new Set(), byType: {} }; }
}

// ─── 1つの段を流す（使い回し → 子 → 途中で止める → 確かめの回） ─────────────────────────
type PhaseResult = { label: string; ids: string[]; cmps: Array<{ id: string; cmp: Cmp; why: string }>; baseLabels: string[]; mainLabels: string[]; stopped: boolean; stopWhy: string; confirm: string[];
  /** 2026-10-21 ①入力が main と同じだった問題（全部の回が main の答え・呼んでいない） */
  inputSame: string[];
  /** 10/20 COST① 前（main）の答え: 使い回した・前の main から持ち越した・今 main で解いた・今は解かなかった（夜中に回す） */
  base: { reused: number; carried: number; ran: number; deferred: string[] } };
// 確かめの回（confirm）は同じ問題をもう一度「前」に照らす＝使い回し・持ち越しは数えない（二重に数えない）・新しく解いた分だけ足す
const addBase = (res: PhaseResult, s: ReturnType<typeof readBaselineSummary>, o: { confirm?: boolean } = {}) => { if (!s) return; if (!o.confirm) { res.base.reused += s.reused; res.base.carried += s.carried.length; } res.base.ran += s.run.length; res.base.deferred = [...new Set([...res.base.deferred, ...s.deferred])]; };
async function runPhase(pl: Plan, stage: "brain" | "draft", ids: string[], label: string, model: "pro" | "flash"): Promise<PhaseResult> {
  const res: PhaseResult = { label, ids, cmps: [], baseLabels: [], mainLabels: [], stopped: false, stopWhy: "", confirm: [], inputSame: [], base: { reused: 0, carried: 0, ran: 0, deferred: [] } };
  if (!ids.length) return res;
  mkdirSync(join(EXAM_BRAIN_DIR, "run"), { recursive: true });
  // 6. 使い回し: 前の結果を結果のファイルに先に書く（brain-exam は済んだ問題×回を回さない）
  const have = new Set(readRows(label).filter((r) => !r.error).map((r) => `${r.id}#${r.rep}`));
  const reusedIds: string[] = [];
  for (const id of ids) {
    const it = pl.items.get(id)!;
    const key = stage === "brain" ? it.key : it.draftKey;
    const e = flag("no-reuse") || pl.conv.key === null || !(stage === "brain" ? pl.db.brain : pl.db.draft) ? null : readReuse(id, key);
    if (!canReuse(e, key, it.reps)) continue;
    const rows = e!.rows.filter((r) => !have.has(`${r.id}#${r.rep}`)).map((r) => ({ ...r, label, reusedFrom: e!.label }));
    if (rows.length) { mkdirSync(RESULTS_DIR, { recursive: true }); appendFileSync(join(RESULTS_DIR, `${label}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); }
    reusedIds.push(id);
  }
  if (reusedIds.length) log(`♻ ${stage === "brain" ? "1段目" : "2段目"}: 前の結果を使う ${reusedIds.length}問（${reusedIds.join(",")}）＝使う物（効くファイル・道具・構成・知見・問題）が同じ`);
  const repsFile = resolve(join(EXAM_BRAIN_DIR, "run", `${label}.reps.json`));
  const stopFile = resolve(join(EXAM_BRAIN_DIR, "run", `${label}.stop`));
  try { if (existsSync(stopFile)) writeFileSync(stopFile + ".old", readFileSync(stopFile)); } catch { /* */ }
  try { (await import("node:fs")).rmSync(stopFile, { force: true }); } catch { /* */ }
  const writeReps = (m: Record<string, number>) => writeFileSync(repsFile, JSON.stringify(m));
  writeReps(Object.fromEntries(ids.map((id) => [id, pl.items.get(id)!.reps])));
  const flaky = new Set(ids.filter((id) => pl.items.get(id)!.flake === "flaky"));
  const baseArgs = (only: string[]) => [
    `--label=${label}`, `--only=${only.join(",")}`, `--stage=${stage}`, "--baseline=main", REPLAY, `--repeat=${MAX_REPS}`, `--reps-file=${repsFile}`,
    ...(JUDGE === "lazy" ? ["--judge=lazy"] : []), ...(JUDGE_PREFIX !== "as-is" ? [`--judge-prefix=${JUDGE_PREFIX}`] : []), ...(CONV ? [`--conv=${CONV}`] : []),
    ...(MAIN_MISSING === "night" && !GATE ? ["--baseline-defer"] : []), ...PASS,
  ];
  const env: Record<string, string> = { EXAM_STOP_FILE: stopFile, ...(model === "flash" ? { DEEPSEEK_MODEL: FLASH_MODEL, EXAM_JUDGE_MODEL: PRO_MODEL } : {}), ...(CONDUCTED?.plan.judge === "tier" && !process.env.EXAM_JUDGE_TIER ? { EXAM_JUDGE_TIER: "on" } : {}) };
  if (!CONV && !process.env.REPLAY_FLOOR_FILE) env.REPLAY_FLOOR_FILE = `scripts/.replay-out/brain-exam-floor-${label}.json`;
  // 5. 途中で止める（1段目の最初の数問）
  const stopWorse = Number(arg("stop-worse", String(DEFAULT_STOP.worseN)));
  const watch = async (o: ChildOut) => {
    if (flag("no-early-stop") || res.stopped || !o.baseLabels.length) return;
    const cmps = compareAll(ids, label, o.baseLabels).filter((c) => c.cmp !== "nocur");
    // ⑥ 入力が同じ問題（main の答えそのもの）は数えない・最初の数問（既定 8）ではっきり悪化なら止める
    const d = stopDecision(cmps, flaky, { ...DEFAULT_STOP, worseN: stopWorse, window: STOP_WINDOW }, new Set(res.inputSame));
    if (d.action === "stop") { writeFileSync(stopFile, JSON.stringify({ at: new Date().toISOString(), why: d.why, worse: d.worse })); res.stopped = true; res.stopWhy = d.why; log(`\n⏹ 試験のブレイン: ${d.why} → 止める（悪化: ${d.worse.join(",")}）`); }
  };
  // ①入力の差の下見（呼ばない）: 同じ問題×回は答案ができる → 本番の子はそれを済んだ回として飛ばす
  const pre = INPUT_DIFF_PRE ? await inputDiffPrepass(pl, ids, label, baseArgs, env) : { same: [] as string[], partial: [] as string[] };
  res.inputSame = pre.same;
  if (pre.same.length) {
    // ② 入力が同じ問題は main の回数のまま（増やさない）。揺れる問題は夜の安い時間だけ1回足して揺れを測る
    const night = FLAKY_NIGHT && isCheapWindow(new Date(), CHEAP_WINDOW_JST);
    for (const id of pre.same) {
      const have = readRows(label).filter((r) => r.id === id && !r.error).length;
      const it = pl.items.get(id)!;
      it.reps = night && it.flake === "flaky" ? Math.min(pl.repsCap, have + 1) : have;
    }
    writeReps(Object.fromEntries(ids.map((id) => [id, pl.items.get(id)!.reps])));
  }
  const o1 = await runBrainExam(baseArgs(ids), env, watch);
  res.baseLabels = o1.baseLabels; res.mainLabels = o1.mainLabels;
  addBase(res, readBaselineSummary(label));
  // 2026-10-17 確かめる人: brain-exam は「前」の結果ファイル（<baseLabel>.jsonl）を --only の問題だけで毎回書き直す＝確かめの回（--only=前と違った問題）の後に
  //   読み直すと他の問題が全部「前が無い（nobase）」になり、2段目の下書きが全部の候補になっていた。1回目の「前」を控え、確かめの回の分だけ差し替える
  let baseRows: RowLite[] = res.baseLabels.flatMap((b) => readRows(b));
  res.cmps = compareAll(ids, label, res.baseLabels, baseRows);
  if (o1.code !== 0) log(`⚠ brain-exam が ${o1.code} で終わった（取れた問題だけ比べる）`);
  if (res.stopped) return res;
  // 2. 確かめの回: 1回目が前と違った問題（揺れか本当の変化か）を max 回まで。はっきり良い時は良くなった・悪くなった問題だけ
  const d = stopDecision(res.cmps, flaky);
  // 確かめの回を流す（回数を書いて子を回し、前の結果を差し替えて比べ直す）
  const confirmRun = async (conf: string[], reps: number) => {
    for (const id of conf) pl.items.get(id)!.reps = Math.max(pl.items.get(id)!.reps, reps);
    writeReps(Object.fromEntries(ids.map((id) => [id, pl.items.get(id)!.reps])));
    const o2 = await runBrainExam(baseArgs(conf), env);
    addBase(res, readBaselineSummary(label), { confirm: true });
    res.baseLabels = [...new Set([...res.baseLabels, ...o2.baseLabels])]; res.mainLabels = [...new Set([...res.mainLabels, ...o2.mainLabels])];
    const b2 = o2.baseLabels.flatMap((b) => readRows(b)).filter((r) => conf.includes(r.id));
    const got = new Set(b2.map((r) => r.id));
    baseRows = [...baseRows.filter((r) => !got.has(r.id)), ...b2];
    res.cmps = compareAll(ids, label, res.baseLabels, baseRows);
    res.confirm = [...new Set([...res.confirm, ...conf])];
  };
  if (REPS_MODE === "old") {
    const conf = pl.repsCap <= 1 ? [] : confirmTargets(res.cmps, new Set(ids.filter((id) => pl.items.get(id)!.reps >= pl.repsCap || res.inputSame.includes(id))), { clearlyGood: d.action === "fewer" });
    if (conf.length) {
      log(`\n🔁 確かめの回（前と違った ${conf.length}問 を ${pl.repsCap}回まで${pl.phase === "small" ? "・小さな確かめ＝繰り返し最小" : ""}${d.action === "fewer" ? "・はっきり良いので判断だけ変わった問題は省く" : ""}）: ${conf.join(",")}`);
      await confirmRun(conf, pl.repsCap);
    }
    return res;
  }
  // 10/20 COST② 自信の気づき: 2回目は前と違った・外れた・揺れる問題だけ → 3回目は1回目と2回目が割れた問題だけ（揃えば止める）
  const rowsOf = (id: string) => readRows(label).filter((r) => r.id === id);
  const failedOf = (id: string) => { const rs = rowsOf(id).filter((r) => !r.error); return rs.length > 0 && !(rs.filter((r) => !!r.path?.ok && !!r.score?.pass).length * 2 > rs.length); };
  // ② 入力が同じ問題は2回目を回さない（main の答えそのもの＝回しても同じ要求の別の答えを足すだけ）
  const sameSet = new Set(res.inputSame);
  const r2 = confidenceRound2(ids.filter((id) => !sameSet.has(id)).map((id) => ({ id, cmp: res.cmps.find((c) => c.id === id)?.cmp ?? "nocur", failed: failedOf(id), flake: pl.items.get(id)!.flake, have: rowsOf(id).filter((r) => !r.error).length })), { clearlyGood: d.action === "fewer", cap: pl.repsCap, wide: REPS_MODE === "wide" });
  if (r2.length) {
    log(`\n🔁 2回目（自信が低い ${r2.length}問だけ・${d.action === "fewer" ? "はっきり良いので判断だけ変わった問題は省く・" : ""}揃えばここで止める）: ${r2.map((x) => `${x.id}（${x.why}）`).join(",")}`);
    await confirmRun(r2.map((x) => x.id), 2);
    const r3 = confidenceRound3(rowsOf, r2.map((x) => x.id), pl.repsCap);
    const same = r2.length - r3.length;
    log(`  1回目と2回目: 揃った ${same}問（止める）・割れた ${r3.length}問${r3.length ? `（${r3.join(",")}）→ 3回目` : ""}`);
    if (r3.length) await confirmRun(r3, 3);
  } else log(`\n🔁 2回目なし（前と同じ・外れていない・揺れない＝自信が高い）`);
  return res;
}

// ─── 2026-10-21 ①入力の差の下見 ─────────────────────────────────────────────
const STOP_WINDOW = Math.max(0, Number(arg("stop-window", process.env.EXAM_STOP_WINDOW ?? "8")) || 0);
/**
 * 子を --input-diff=plan で流す（LLM は呼ばない: main と同じ要求は main の答え・違う要求はそこで止める）。
 *   同じ問題×回の答案は結果に書かれる（本番の子は済んだ回として飛ばす）。問題の全部の回が同じなら「入力が同じ」。
 */
async function inputDiffPrepass(pl: Plan, ids: string[], label: string, baseArgs: (only: string[]) => string[], env: Record<string, string>): Promise<{ same: string[]; partial: string[] }> {
  const before = new Set(readRows(label).filter((r) => !r.error).map((r) => `${r.id}#${r.rep}`));
  const todo = ids.filter((id) => !readRows(label).some((r) => r.id === id && !r.error));
  if (!todo.length) return { same: [], partial: [] };
  log(`\n🔍 入力の差の下見（AI を呼ばない）: ${todo.length}問 — main と同じ要求の問題は main の答えで答案を作り、違う問題だけ本当に呼ぶ`);
  await runBrainExam([...baseArgs(todo), "--input-diff=plan"], env);
  let items: Record<string, { same: boolean; firstChanged: string | null; pinned: number }> = {};
  try { items = (JSON.parse(readFileSync(join(RESULTS_DIR, `${label}.inputdiff.json`), "utf8")) as { items?: typeof items }).items ?? {}; } catch { /* 下見できなかった＝全部本番で */ }
  const rows = readRows(label).filter((r) => !r.error);
  const same: string[] = [], partial: string[] = [];
  for (const id of todo) {
    const mine = Object.entries(items).filter(([k]) => k.startsWith(`${id}#`));
    const wrote = rows.filter((r) => r.id === id && !before.has(`${r.id}#${r.rep}`));
    if (mine.length && mine.every(([, v]) => v.same) && wrote.length) same.push(id);
    else if (mine.some(([, v]) => v.pinned > 0)) partial.push(id);
  }
  const stageOf = (id: string) => [...new Set(Object.entries(items).filter(([k, v]) => k.startsWith(`${id}#`) && !v.same).map(([, v]) => v.firstChanged ?? "控えなし"))].join("・");
  log(`🔍 下見の結果: 入力が同じ ${same.length}問（main の答え・呼ばない）${same.length ? `: ${same.join(",")}` : ""}／違う ${todo.length - same.length}問${todo.length - same.length ? `: ${todo.filter((id) => !same.includes(id)).map((id) => `${id}（${stageOf(id) || "控えなし"}）`).join(",")}` : ""}`);
  void pl;
  return { same, partial };
}

// ─── 台帳・使い回しの保存・報告 ───────────────────────────────────────────────
function verdictOf(id: string, cmp: Cmp, rows: RowLite[], flaky: boolean): LedgerLine["verdict"] {
  if (cmp !== "worse" && cmp !== "better" && cmp !== "changed") return null;
  // 2026-10-17 確かめる人: 揺れる問題を回を見ずに「揺れ」にすると、3回とも前より悪い（本当の悪化）も「入れてよい」に数えていた＝揺れる問題も回で決める
  void flaky;
  const ok = rows.filter((r) => !r.error);
  if (ok.length < 2) return "unconfirmed";
  return new Set(ok.map((r) => `${!!r.path?.ok}|${!!r.score?.pass}`)).size === 1 ? "real" : "flake";
}
function finishPhase(pl: Plan, ph: PhaseResult, stage: "brain" | "draft", model: "pro" | "flash", head: string): LedgerLine[] {
  const rows = readRows(ph.label);
  const out: LedgerLine[] = [];
  for (const id of ph.ids) {
    const it = pl.items.get(id)!;
    const rs = rows.filter((r) => r.id === id);
    const c = ph.cmps.find((x) => x.id === id) ?? { cmp: "nocur" as Cmp, why: "" };
    const ok = rs.filter((r) => !r.error);
    const reused = rs.some((r) => (r as Record<string, unknown>).reusedFrom);
    if (ok.length && ok.length === rs.length && !reused && !ph.stopped && pl.conv.key !== null && (stage === "brain" ? pl.db.brain : pl.db.draft)) writeReuse({ id, key: stage === "brain" ? it.key : it.draftKey, savedAt: new Date().toISOString(), label: ph.label, stage, model, rows: ok });
    if (!ok.length) continue;
    const maj = (f: (r: RowLite) => boolean) => ok.filter(f).length * 2 > ok.length;
    out.push({ at: new Date().toISOString(), label: ph.label, id, type: String(pl.probs.get(id)?.type ?? ""), stage, model: model === "flash" ? FLASH_MODEL : PRO_MODEL, head, scopeKey: stage === "brain" ? pl.keys.brain : pl.keys.draft, base: ph.baseLabels.join(",") || null,
      reps: ok.length, codes: [...new Set(ok.map((r) => String(r.path?.code ?? "")))], pathOk: maj((r) => !!r.path?.ok), pass: maj((r) => !!r.score?.pass), cmp: c.cmp, cmpWhy: c.why, flake: it.flake, reused, verdict: verdictOf(id, c.cmp, ok, it.flake === "flaky"), ...(ENV_FP.hash ? { envFp: ENV_FP.text } : {}) });
  }
  return out;
}
async function spendOf(labels: string[], since: string): Promise<{ n: number; usd: number }> {
  const { altUsageUsd, claudeUsageUsd } = await import("../app/lib/llm-price");
  let n = 0, usd = 0;
  for (const l of labels) {
    const { data } = await sb.from("llm_usage_logs").select("model,input_uncached,cache_read,cache_write,cache_write_5m,cache_write_1h,output_tokens,created_at").gte("created_at", since).like("route", `script:brain-exam-${l}%`).limit(10000);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) { n++; usd += /claude/.test(String(r.model ?? "")) ? claudeUsageUsd(r as never) : altUsageUsd(r as never); }
  }
  return { n, usd };
}

// ─── 本体（流す） ─────────────────────────────────────────────────────────
// ─── 10/21 連携③④（scripts/lib/exam-coord.ts） ─────────────────────────────────
function runFpOf(pl: Plan): string {
  return C.runFingerprint({ codeKey: pl.versionKey, envFp: ENV_FP.hash, mainKey: mainHead()?.vk ?? null, items: [...pl.items.values()].map((x) => ({ id: x.id, reps: x.reps, model: x.model, draft: x.draft })), extra: [GATE ? "gate" : "", `judge=${JUDGE}`, REPLAY, `prefix=${JUDGE_PREFIX}`, ...PASS].filter(Boolean) });
}
/**
 * 1回ごとの見張り: ①同じ比べ（コード・スイッチの指紋・比べる main の版・問題と回数・モデル・段）を今日もう流した → 止める（--force）。
 *   ②担当（--label の元・自動の label は作業ツリー）の今日の費用＋見込みが EXAM_RUN_CAP_USD（既定 $5）を超える → 夜中に予約（--over-cap／--force で今）
 */
async function runGuard(pl: Plan, label: string, estNow: number, now: Date): Promise<{ go: boolean; record?: () => void }> {
  const fp = runFpOf(pl);
  const today = C.readRunsToday(now);
  const dup = C.findDuplicateRun(today, fp);
  if (dup && !flag("force")) {
    log(`\n⛔ 同じ比べ（コード・スイッチ・main の版・問題と回数が同じ）を今日もう流した: ${dup.label}（${jst(new Date(dup.at))} JST・${dup.cwd}）→ 流さない（見込み $${estNow.toFixed(2)} を使わない）。`);
    log(`  結果: scripts/.replay-out/brain-exam の ${dup.label}（--report=${dup.label}）。揺れを測り直す等で本当に流すなら --force`);
    C.appendCoordEvent({ at: new Date().toISOString(), kind: "dup-refused", label, ids: [...pl.items.keys()], usd: estNow, note: dup.label });
    return { go: false };
  }
  if (dup) log(`同じ比べを今日もう流した（${dup.label}）が --force で流す`);
  const ident = C.labelIdentity(label, process.cwd());
  const cap = C.runCapUsd(process.env);
  const fromQueue = process.env.EXAM_FROM_QUEUE === "1";
  let spent = 0;
  if (cap !== null && !fromQueue) {
    try {
      const rows = await C.readExamSpendRows(sb, jstDayStart(now));
      const labels = [...new Set(today.filter((r) => r.ident === ident).map((r) => r.label))];
      spent = rows.filter((r) => C.routeBelongs(r.route, ident, labels)).reduce((s, r) => s + r.usd, 0);
    } catch (e) { log(`⚠ 担当の今日の費用が読めない（0 とみて続ける・1日の全体の上限は別に守る）: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`); }
  }
  const d = C.runCapDecision({ spentUsd: spent, estUsd: estNow, cap, force: flag("force") || flag("over-cap"), fromQueue });
  log(`担当の上限（${ident}）: ${d.why}`);
  if (!d.ok) {
    const at = nextNightRun(now);
    const f = enqueue({ label, argv: [...args.filter((a) => !/^--(when|phase|switch)=/.test(a)), "--when=now", ...(pl.phase !== "off" ? [`--phase=${pl.phase}`] : []), ...SWITCH_ARGS, ...(PASS.length ? ["--", ...PASS] : [])], cwd: process.cwd(), at: at.toISOString(), createdAt: now.toISOString(), estUsd: estNow });
    log(`夜中に予約した（${jst(at)} JST の --run-queue）: ${f}`);
    C.appendCoordEvent({ at: new Date().toISOString(), kind: "cap-deferred", label, ids: [...pl.items.keys()], usd: estNow, note: ident });
    return { go: false };
  }
  return { go: true, record: () => { try { C.appendRun({ fp: runFpOf(pl), label, ident, at: new Date().toISOString(), cwd: process.cwd(), estUsd: estNow, ids: [...pl.items.keys()] }); } catch { /* 帳簿が書けなくても流す */ } } };
}
/**
 * 2026-10-23 弱い所の台帳 brain_weaknesses（読むだけ・書かない）: 開いている・作業中の弱い所の証拠の問題（evidence.exam_qids）→ {問題: [鍵]}。
 *   サービスの鍵が無い（RLS でポリシーなしの表＝anon では読めない）・読めない時は空＝選びは今まで通り。止める EXAM_WEAKNESS_PICK=off
 */
async function openWeaknessQids(): Promise<{ map: Record<string, string[]>; note: string }> {
  if ((process.env.EXAM_WEAKNESS_PICK ?? "").trim().toLowerCase() === "off") return { map: {}, note: "使わない（EXAM_WEAKNESS_PICK=off）" };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { map: {}, note: "サービスの鍵が無い＝使わない" };
  try {
    const { data, error } = await sb.from("brain_weaknesses").select("key, status, evidence").in("status", ["open", "in_progress"]).limit(500);
    if (error) return { map: {}, note: `読めない（${error.message.slice(0, 80)}）＝使わない` };
    const map: Record<string, string[]> = {};
    for (const r of (data ?? []) as Array<{ key: string; evidence: { exam_qids?: string[] } | null }>) for (const q of r.evidence?.exam_qids ?? []) (map[q] ??= []).includes(r.key) || map[q].push(r.key);
    return { map, note: `開いている弱い所の証拠 ${Object.keys(map).length}問（選んだ問題の中で先に回す）` };
  } catch (e) { return { map: {}, note: `読めない（${String(e).slice(0, 80)}）＝使わない` }; }
}
/** --spend-today: 今日（JST）の試験の費用を種類で分け、同じ版の main の作り直しの重なりと、連携で避けた分を出す */
async function spendToday() {
  const now = new Date(), since = jstDayStart(now);
  const rows = await C.readExamSpendRows(sb, since);
  const s = C.summarizeSpend(rows, CHEAP_WINDOW_JST);
  const ev = C.readCoordEvents(since);
  const pct = (x: number) => (s.total ? Math.round((x / s.total) * 100) : 0);
  log(`=== 今日の試験の費用（${jst(since)}〜 JST・route script:brain-exam-*）: $${s.total.toFixed(2)}（${s.byRoute.length} 本）===`);
  log(`  main の作り直し: $${s.byKind.main.usd.toFixed(2)}（${pct(s.byKind.main.usd)}%・${s.byKind.main.routes} 本）`);
  log(`  担当の確かめ:   $${s.byKind.worker.usd.toFixed(2)}（${pct(s.byKind.worker.usd)}%・${s.byKind.worker.routes} 本）`);
  log(`  夜（安い時間・warm）: $${s.byKind.night.usd.toFixed(2)}（${pct(s.byKind.night.usd)}%・${s.byKind.night.routes} 本）`);
  if (s.mainDup.length) {
    // 10/23 費用の調べ: route ごとの数え＝問題が違う本も「重なり」に入る上限の目安（10/22 夜〜10/23: 28版 818行で同じ版の同じ問題×回の作り直しは1行だけ＝実際の無駄はほぼ0）
    log(`同じ版の main を2本以上で作った: ${s.mainDup.length} 版・重なりの上限の目安 $${s.dupExtraUsd.toFixed(2)}（route ごとの数え＝問題が違えば無駄でない・同じ問題の作り直しは claim で止めている）`);
    for (const d of s.mainDup.slice(0, 8)) log(`  ${d.version}: ${d.routes} 本 $${d.usd.toFixed(3)}（重なり $${d.extraUsd.toFixed(3)}）`);
  } else log("同じ版の main の作り直しの重なり: なし");
  const by = (k: string) => ev.filter((e) => e.kind === k);
  const sum = (k: string) => by(k).reduce((a, e) => a + e.usd, 0);
  log(`連携で避けた分（帳簿 ${C.COORD_LOG}）:`);
  log(`  他の担当の同じ版の答えを待って使った: ${by("wait-reuse").reduce((a, e) => a + e.ids.length, 0)}問・約 $${sum("wait-reuse").toFixed(2)}`);
  log(`  前の main と入力が同じで呼ばずに済んだ（main の作り直し）: ${by("pin").reduce((a, e) => a + e.ids.length, 0)}問・約 $${sum("pin").toFixed(2)}`);
  log(`  同じ比べを止めた: ${by("dup-refused").length}回・見込み $${sum("dup-refused").toFixed(2)}／担当の上限で夜に回した: ${by("cap-deferred").length}回・見込み $${sum("cap-deferred").toFixed(2)}`);
  if (flag("routes")) for (const r of s.byRoute.slice(0, 30)) log(`  ${r.kind.padEnd(6)} ${r.usd.toFixed(3)} ${r.route}`);
  // 10/23 節約の台帳: 今日の全部で数え直して今日の分を上書き（--dry で書かない）→ 開いている上位
  try { log((await detectAndRecord(sb, { since, write: !flag("dry") && !!process.env.SUPABASE_SERVICE_ROLE_KEY, mode: "set" })).text); } catch (e) { log(`（節約の台帳: ${String(e instanceof Error ? e.message : e).slice(0, 160)}）`); }
  log(await topOpenSavingsText(sb));
}

async function runMain() {
  const now = new Date();
  const label = arg("label") || `eb-${jst(now).slice(5, 10).replace("-", "")}-${Math.random().toString(36).slice(2, 6)}`;
  if (!/^[\w.-]+$/.test(label)) throw new Error(`--label は英数字・-・_ だけ: ${label}`);
  const pl = await makePlan(label);
  // 4. いつ（10/17: 2倍の時間は警告・急がない仕上げは夜中に）・② 1日の上限
  const est = estimateUsd([...pl.items.values()], { peak: pricePeak(pl, now) });
  const whenArg = (arg("when", "auto") as When);
  const pa = peakAdvice({ now, phase: pl.phase, gate: GATE, when: whenArg });
  let w = decideWhen({ when: whenArg, estUsd: est.now, gate: GATE, now });
  // 小さな確かめ・仕上げ（旧でない・関所でない）: DeepSeek は2倍の時間だけ高い＝2倍の時間の外なら今（13:00〜15:00 も可）・2倍の時間の仕上げは夜中
  if (pl.phase !== "off" && !GATE && whenArg === "auto") w = pa.defer ? { runNow: false, at: nextNightRun(now), why: "仕上げ＋2倍の時間＝夜中に予約" } : { runNow: true, at: now, why: pa.peak ? "小さな確かめ＝急ぐので今（2倍の時間）" : "2倍の時間の外＝今" };
  const budget = w.runNow ? await budgetOf(pl, pricePeak(pl, now), now) : undefined;
  printPlan(pl, now, { budget, peakWarn: pa.warn, when: `${w.why}${w.runNow ? "" : `（${jst(w.at)} JST から）`}` });
  if (!budget) log("1日の上限: 予約した時（実行する日の JST）に数える");
  if (flag("plan")) { log("\n（--plan: 流さない）"); return; }
  // 10/21 連携③: 同じ比べを今日もう流した・担当の1日の上限を超える → 流さない／夜中に
  const guard = await runGuard(pl, label, est.now, now);
  if (!guard.go) return;
  ensureMainWarm();
  // 10/23 2倍の時間の少し待ち: 今流すと決まった回でも、安い時間が EXAM_PEAK_WAIT_MIN 分（既定30）以内に始まるならそこまで待つ（--when=now・関所は対象外）
  if (w.runNow && whenArg === "auto" && !GATE) {
    const waitMs = peakWaitMs({ now: new Date(), waitMin: peakWaitMinOf(process.env) });
    if (waitMs > 0) { log(`2倍の時間の終わりまで ${Math.ceil(waitMs / 60_000)}分 → 待ってから流す（半額・止める: EXAM_PEAK_WAIT_MIN=off か --when=now）`); await sleep(waitMs + 5_000); }
  }
  if (!w.runNow) {
    if (flag("wait")) { log(`安い時間まで待つ（--wait）…`); while (Date.now() < w.at.getTime()) await sleep(Math.min(10 * 60_000, w.at.getTime() - Date.now() + 1000)); }
    else {
      const f = enqueue({ label, argv: [...args.filter((a) => !/^--(when|phase|switch)=/.test(a)), "--when=now", ...(pl.phase !== "off" ? [`--phase=${pl.phase}`] : []), ...SWITCH_ARGS, ...(PASS.length ? ["--", ...PASS] : [])], cwd: process.cwd(), at: w.at.toISOString(), createdAt: now.toISOString(), estUsd: est.now });
      log(`予約した: ${f}\n  安い時間に流す: npx tsx --env-file=.env.local scripts/exam-brain.ts --run-queue（タスクスケジューラ SumoraExamNight が JST 1:40 に。今すぐなら --when=now）`);
      return;
    }
  }
  // ② 上限を超える分は夜中の予約に回す（止めて終わりにしない）。--wait で待った時はここで数える
  const split = (budget ?? await budgetOf(pl, pricePeak(pl, new Date()), new Date())).split;
  if (!budget && split) log(`1日の上限: ${split.why}`);
  if (split && split.later.length) {
    const keep = (a: string) => !/^--(when|only|name|select-q|select-n|select|types|phase|label|plan|switch)(=|$)/.test(a);
    const f = enqueue({ label: `${label}-n`, argv: [...args.filter(keep), `--only=${split.later.join(",")}`, "--phase=final", "--when=now", `--label=${label}-n`, ...SWITCH_ARGS, ...(PASS.length ? ["--", ...PASS] : [])], cwd: process.cwd(), at: nextNightRun(now).toISOString(), createdAt: now.toISOString(), estUsd: split.estLater });
    log(`上限: 夜中に回した ${split.later.length}問（${jst(nextNightRun(now))} JST・見込み $${split.estLater.toFixed(2)}・翌日の分として数える）: ${f}`);
    for (const id of split.later) pl.items.delete(id);
    pl.picks = pl.picks.filter((p) => pl.items.has(p.id));
    pl.draftPlan.ids = pl.draftPlan.ids.filter((id) => pl.items.has(id));
    if (!pl.items.size) { log("今流す問題は無い（全部夜中）"); return; }
  }
  guard.record?.();
  let head = ""; try { head = execSync("git rev-parse --short HEAD").toString().trim(); } catch { /* */ }
  const startedAt = new Date().toISOString();
  const groups: Array<{ model: "pro" | "flash"; ids: string[] }> = (["pro", "flash"] as const).map((m) => ({ model: m, ids: [...pl.items.values()].filter((x) => x.model === m).map((x) => x.id) })).filter((g) => g.ids.length);
  const ledger: LedgerLine[] = [];
  const phases: PhaseResult[] = [];
  for (const g of groups) {
    const lb = g.model === "flash" ? `${label}-fl` : label;
    // 1段目: 全部をブレインの判断まで
    const a = await runPhase(pl, "brain", g.ids, lb, g.model);
    phases.push(a); ledger.push(...finishPhase(pl, a, "brain", g.model, head));
    if (a.stopped) { log(`\n⏹ 1段目で止めた（${a.stopWhy}）→ 下書きは流さない`); break; }
    // 2段目: 下書きに効くファイルを直した問題・判断が前と変わった問題だけ
    const changed = brainChangedOf(a.cmps);
    const dt0 = draftTargets(pl.cls, g.ids.map((id) => pl.probs.get(id)!) as PlanProblem[], changed, { gate: GATE });
    // 司令塔の計画: 司令塔が下書きまでと決めた問題＋判断が前と変わった問題（下書き可の物だけ）
    const dt = CONDUCTED ? (() => { const want = new Set(pl.draftPlan.ids); const ids = g.ids.filter((id) => draftEligibleOf(pl, id) && (want.has(id) || changed.has(id))); return { ids, why: "司令塔が下書きまでと決めた問題＋判断が前と変わった問題" }; })() : dt0;
    log(`\n2段目（下書きまで）: ${dt.ids.length}問 — ${dt.why}${dt.ids.length ? `（${dt.ids.join(",")}）` : ""}`);
    const b = await runPhase(pl, "draft", dt.ids, `${lb}-d`, g.model);
    phases.push(b); ledger.push(...finishPhase(pl, b, "draft", g.model, head));
  }
  appendLedger(ledger);
  // 10/20 COST③ の見張り: flash で流した問題を、同じ main の版の pro の答え（取り置き済みの物だけ）と照らして model-check に足す（0円・道が違えば次から pro）
  if (groups.some((g) => g.model === "flash") && groups.some((g) => g.model === "pro")) {
    try {
      const proBase = JSON.parse(readFileSync(join(RESULTS_DIR, `${label}.baseline.json`), "utf8")) as { versionKey?: string; cfg?: string };
      const fl = phases.find((p) => p.label === `${label}-fl`);
      if (proBase.versionKey && proBase.cfg && fl) {
        const dir = join(BASELINE_DIR, `v-${proBase.versionKey}-${proBase.cfg}`);
        const flRows = readRows(fl.label);
        const pairs = fl.ids.map((id) => { let pro: RowLite[] = []; try { pro = (JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as { rows: RowLite[] }).rows; } catch { /* pro の答えが無い */ } return { id, flash: flRows.filter((r) => r.id === id), pro }; });
        const sc = flashSpotCheck(pairs);
        if (sc.length) {
          const prev = existsSync(MODEL_CHECK_FILE) ? JSON.parse(readFileSync(MODEL_CHECK_FILE, "utf8")) as { byType: Record<string, ModelCheckStat>; byId?: Record<string, ModelCheckStat>; spot?: unknown[] } : { byType: {}, byId: {} };
          for (const s of sc) { const e = (prev.byId ??= {})[s.id] ?? { n: 0, samePath: 0, proOk: 0, flashOk: 0 }; e.n++; if (s.samePath) e.samePath++; if (s.proOk) e.proOk++; if (s.flashOk) e.flashOk++; prev.byId[s.id] = e;
            // 見直し: 道が違った時は型にも「違った1回」を足す（型の 9割を下げる向きだけ・同じだった時は型に足さない＝同じ問題の見張りで型の回数を水増ししない）
            const t = String(pl.probs.get(s.id)?.type ?? ""); if (!s.samePath && t) { const et = (prev.byType ??= {})[t] ?? { n: 0, samePath: 0, proOk: 0, flashOk: 0 }; et.n++; if (s.proOk) et.proOk++; if (s.flashOk) et.flashOk++; prev.byType[t] = et; } }
          (prev.spot ??= []).push({ at: new Date().toISOString(), label, items: sc });
          writeFileSync(MODEL_CHECK_FILE, JSON.stringify(prev, null, 1));
          log(`flash の見張り（pro の main の答えと照らす・0円）: ${sc.map((s) => `${s.samePath ? "＝" : "≠"}${s.id} pro=${s.proCode}${s.proOk ? "○" : "✕"} flash=${s.flashCode}${s.flashOk ? "○" : "✕"}`).join("・")}${sc.some((s) => !s.samePath) ? " → 道が違った問題は次から pro" : ""}`);
        }
      }
    } catch { /* pro の取り置きが読めない時は照らさない */ }
  }
  // 報告
  const by = (c: Cmp) => ledger.filter((l) => l.cmp === c);
  log(`\n=== 試験のブレインの結果（${label}）===`);
  for (const ph of phases) {
    const st = ledger.filter((l) => l.label === ph.label);
    log(`${ph.label}: ${st.length}問・道 ${st.filter((l) => l.pathOk).length}・合格 ${st.filter((l) => l.pass).length}・前より悪い ${st.filter((l) => l.cmp === "worse").length}・良い ${st.filter((l) => l.cmp === "better").length}・判断だけ変わった ${st.filter((l) => l.cmp === "changed").length}・turn_contract の形だけ変わった ${st.filter((l) => l.cmp === "shape").length}・前が無い ${st.filter((l) => l.cmp === "nobase").length}${ph.stopped ? `・止めた（${ph.stopWhy}）` : ""}${ph.confirm.length ? `・確かめた ${ph.confirm.length}` : ""}`);
    // 確かめる人: 途中で止めた時は流さなかった問題を名指しする（黙って抜けない）
    if (ph.stopped) { const notRun = ph.ids.filter((id) => !st.some((l) => l.id === id)); if (notRun.length) log(`  ⏹ 止めたので流さなかった ${notRun.length}問: ${notRun.join(",")}`); }
  }
  for (const l of by("worse")) log(`  ✕ 悪化 ${l.id}[${l.stage}] ${l.cmpWhy}・${l.verdict === "real" ? "本当の悪化（確かめの回でも同じ）" : l.verdict === "flake" ? "揺れ（回で割れた・揺れる問題）" : "1回だけ（確かめていない）"}`);
  for (const l of by("better")) log(`  ○ 良くなった ${l.id}[${l.stage}] ${l.cmpWhy}・${l.verdict ?? ""}`);
  // 10/20 COST①: 前（main）の答えの数（版ごとの取り置きを使えたか）
  const bs = phases.reduce((s, p) => ({ reused: s.reused + p.base.reused, carried: s.carried + p.base.carried, ran: s.ran + p.base.ran, deferred: [...new Set([...s.deferred, ...p.base.deferred])] }), { reused: 0, carried: 0, ran: 0, deferred: [] as string[] });
  log(`前（main）の答え: 使い回した ${bs.reused}・前の main から持ち越した ${bs.carried}・今 main で解いた ${bs.ran}${bs.deferred.length ? `・今は解かず夜中に回した ${bs.deferred.length}（${bs.deferred.join(",")}＝前との比べに入らない）` : ""}`);
  if (bs.deferred.length) ensureMainWarm({ force: true, cont: true }); // --main-missing=night は人が選んだ＝夜に回すのは続き扱い
  const real = by("worse").filter((l) => l.verdict !== "flake");
  log(real.length ? "⚠ 本当の悪化か確かめていない悪化がある＝このまま入れない" : "前より悪くなった問題は無い（揺れを除く）");
  // 10/17 ① 小さな確かめの記録（同じ版で悪化なし＝次は仕上げ）
  if (pl.phase !== "off") {
    const clean = !real.length && !phases.some((p) => p.stopped);
    appendPhaseLog({ at: new Date().toISOString(), label, phase: pl.phase, keys: pl.versionKey, clean, ids: [...pl.items.keys()] });
    if (pl.phase === "small") log(clean ? `小さな確かめが通った（まだ main に入れない＝仕上げが要る）→直しが終わったら同じ命令でもう一度＝仕上げ（${pl.allPicks.length}問・使う物が同じ問題は今の結果を使う）` : "小さな確かめに悪化 → 直してもう一度（小さな確かめのまま）");
  }
  const labels = [...phases.map((p) => p.label), ...phases.flatMap((p) => p.mainLabels)];
  const sp = await spendOf(labels, startedAt).catch(() => ({ n: 0, usd: 0 }));
  const judge = phases.reduce((s, p) => { const c = readCost(p.label); return { usd: s.usd + (c?.judgeUsd ?? 0), n: s.n + (c?.judgeCalls ?? 0) }; }, { usd: 0, n: 0 });
  log(`費用（この実行・llm_usage_logs の ${labels.length}つの route）: ${sp.n}回 ${sp.usd.toFixed(3)}＋判定 ${judge.n}回 ${judge.usd.toFixed(3)}`);
  // 10/23 節約の台帳: この回の無駄（2倍の時間・flash で足りる型・キャッシュ・重なり・回数・出力・off のスイッチ）を数えて足す。質を変えないスイッチが off なら次から自動で戻す
  try { log((await detectAndRecord(sb, { since: new Date(startedAt), labels, env: process.env, write: !!process.env.SUPABASE_SERVICE_ROLE_KEY, mode: "add", onceLabel: label, autoApply: true })).text); }
  catch (e) { log(`（節約の台帳: ${String(e instanceof Error ? e.message : e).slice(0, 160)}）`); }
  // 10/20 QUALITY⑤ 外れの理由を読む（flash・短い JSON）→ 型ごとに数えて保存（次の --conduct の材料）
  if (!flag("no-reasons") && (process.env.EXAM_REASONS ?? "").trim().toLowerCase() !== "off") {
    try { await readFailureReasons(label, phases, pl); } catch (e) { log(`（外れの理由が読めない: ${String(e instanceof Error ? e.message : e).slice(0, 160)}）`); }
  }
  log(`台帳: ${ledger.length}行（npx tsx scripts/exam-brain.ts --ledger --id=<問題>）`);
}

// ─── 10/20 QUALITY⑤ 外れの理由の読み手（flash） ─────────────────────────────────
/** 問題の材料（伏せた会話の写し: お客様の発言と直前のこちらの送信。竹内さんの実送信 staffText は出さない） */
function readerProblemOf(p: AnyProblem | undefined, id: string): ReaderProblem {
  const q = (p ?? { id, type: "" }) as AnyProblem & { customer?: string; context?: Array<{ s?: string; t?: string; aix?: boolean }>; mustNot?: string[]; asks?: ReaderProblem["asks"]; ng?: string[] };
  const lastStaff = [...(q.context ?? [])].reverse().filter((m) => m.s === "staff").slice(0, 1).map((m) => `${m.aix ? "【AIX】" : ""}${m.t ?? ""}`).join("");
  return { id, type: String(q.type ?? ""), customer: String(q.customer ?? ""), lastStaff, accept: q.accept, mustNot: q.mustNot, asks: q.asks, ng: q.ng };
}
async function readFailureReasons(label: string, phases: PhaseResult[], pl: Plan) {
  const max = Math.max(0, Number(arg("reasons-max", "10")) || 10);
  // 今の答案: 下書きまで流した問題は下書きの段の答案（ブレインの欄も入っている）・それ以外はブレインの段
  const curOf = new Map<string, ReaderRow[]>(), mainOf = new Map<string, ReaderRow[]>();
  for (const ph of phases) {
    const rows = readRows(ph.label) as ReaderRow[];
    const base = ph.baseLabels.flatMap((b) => readRows(b)) as ReaderRow[];
    for (const id of ph.ids) {
      const rs = rows.filter((r) => r.id === id);
      if (rs.length && (ph.label.endsWith("-d") || !curOf.has(id))) curOf.set(id, rs);
      const bs = base.filter((r) => r.id === id);
      if (bs.length && (ph.label.endsWith("-d") || !mainOf.has(id))) mainOf.set(id, bs);
    }
  }
  const failed = [...curOf].filter(([, rs]) => failedOf(rs)).map(([id]) => id);
  if (!failed.length) { log("外れの理由: 落ちた問題なし"); return; }
  const tally = newTally();
  const out: Reason[] = [];
  const goldPeers = (() => { try { const j = JSON.parse(readFileSync(join(EXAM_BRAIN_DIR, "gold-check", "latest.json"), "utf8")) as { conflicts?: GoldConflict[] }; return conflictPeers(j.conflicts ?? []); } catch { return {} as ReturnType<typeof conflictPeers>; } })();
  for (const id of failed.slice(0, max)) {
    const cur = curOf.get(id) ?? [], main = mainOf.get(id) ?? [];
    const m = machineReason(id, cur);
    if (m) { out.push(m); continue; }
    // 10/20 QUALITY⑥: 正解の食い違いの一覧（scripts/exam-gold-check.ts）にある問題は「似た場面の正解」を手がかりに足す（正解が揺れているかを読む材料）
    const peerHint = (goldPeers[id] ?? []).slice(0, 3).map((x) => `似た場面の ${x.id} の正解は ${x.accept.join("|")}（食い違い・${x.strength}）`);
    const user = safeLines(buildReaderUser(readerProblemOf(pl.probs.get(id), id), cur, main, peerHint)).text;
    const r = parseReason(id, (await callConductorLlm("failure-reader", C_FLASH, READER_SYSTEM, user, tally, { maxTokens: 200 })) ?? "");
    if (r) out.push(r);
  }
  const agg = aggregateReasons(out);
  log(`\n外れの理由（読み手 flash・${out.length}/${failed.length}問${failed.length > max ? `・上限 ${max}問` : ""}）: ${agg.map((a) => `${a.kind} ${a.n}`).join("・") || "読めなかった"}`);
  for (const r of out) log(`  ${r.id}: ${r.kind}（${r.confidence}${r.by === "machine" ? "・決まり" : ""}）— ${r.evidence}`);
  if (tally.calls || tally.refused || tally.failed) log(`  読み手の費用: ${tally.calls}回 $${tally.usd.toFixed(4)}${tally.refused ? `・個人の値で送らなかった ${tally.refused}` : ""}${tally.failed ? `・失敗 ${tally.failed}` : ""}`);
  mkdirSync(CONDUCTOR_DIR, { recursive: true });
  const rec = { label, at: new Date().toISOString(), failed, reasons: out, aggregate: agg.map((a) => ({ kind: a.kind, n: a.n, ids: a.ids })), kinds: REASON_KINDS, llm: tally };
  writeFileSync(join(CONDUCTOR_DIR, `${label}.reasons.json`), JSON.stringify(rec, null, 1));
  writeFileSync(join(CONDUCTOR_DIR, "reasons-latest.json"), JSON.stringify(rec, null, 1));
  log(`  保存: ${join(CONDUCTOR_DIR, `${label}.reasons.json`)}（次の --conduct の材料）`);
  // 2026-10-23 弱い所の台帳（brain_weaknesses）に型ごとに足して、この回で触った開いている弱い所を出す（止める BRAIN_WEAKNESS_LEDGER=off・失敗しても試験は止めない）
  log(await recordExamWeaknesses(sb, label, weaknessHitsFromExamReasons(label, out, rec.at)));
}
/** 前の実行の外れの理由（次の --conduct の材料）。無ければ null */
function loadLatestReasons(): { label: string; at: string; reasons: Reason[]; aggregate: Array<{ kind: string; n: number; ids: string[] }> } | null {
  try { return JSON.parse(readFileSync(join(CONDUCTOR_DIR, "reasons-latest.json"), "utf8")) as ReturnType<typeof loadLatestReasons>; } catch { return null; }
}

// ─── 予約を流す ─────────────────────────────────────────────────────────
async function runQueue() {
  const now = new Date();
  if (!isCheapWindow(now) && !flag("force")) { log(`今は DeepSeek の混雑の時間（平日 JST 10-13・15-19）→ 流さない（--force で流す）`); return; }
  // 10/20 COST①: 安い時間の予約の口で main の版の取り置きを確かめる（merge の後の最初の夜に1回だけ・今流す）
  ensureMainWarm({ runNow: true });
  // 2026-10-22 ⑤ 1本ずつ（10/22 の夜: 166問の取り置きが約 11時間 夜のタスク（IgnoreNew）を塞ぎ、比べの予約が遅れた）:
  //   比べ（取り置き以外）を先に作った順で流す → 取り置きは最後に1本だけ（何本予約されていても子は「今の main」を作る＝古い版の物は捨てる）。
  //   取り置きは予算（EXAM_WARM_BUDGET_MIN・既定 90分）で自分で切り、続きは予約し直す＝次の回（30分おき）でも比べが先に流れる。
  //   1回の上限（EXAM_QUEUE_MAX_MIN・既定 300分）を過ぎたら次の予約は始めない。1本の上限（EXAM_QUEUE_ITEM_MAX_MIN・既定 240分）を超えた子は止める
  const due0 = readQueue({ onBad: (f, why) => log(`⚠⚠ 予約を読めない（流さない・消さない）: ${f} — ${why}。予約は enqueue（scripts/lib/exam-brain-io.ts）で書き直す`) }).filter((x) => Date.parse(x.at) <= now.getTime());
  const { run: due, drop } = orderQueue(due0, { currentVk: mainHead()?.vk ?? null });
  for (const d of drop) { log(`予約を捨てる: ${d.item.label}（${d.why}）`); dequeue(d.item.file); }
  // 古い鍵・控え（止まった実行の条件の行の控え）を脇へ（消さない）: 夜の作業ツリー・main の作業ツリー・予約の作業ツリー
  try {
    const wts = [process.cwd(), resolve(process.cwd(), "..", "brain-exam-main"), ...due.map((x) => x.cwd)];
    sweepStaleBackups(wts.map((d) => join(d, "scripts", ".replay-out")), { log });
  } catch (e) { log(`  古い控えの見回りができない: ${String(e).slice(0, 120)}`); }
  if (!due.length) log("予約: 流す物が無い");
  else log(`予約の順（1本ずつ・比べが先・取り置きは最後）: ${due.map((x) => x.label).join(" → ")}`);
  await runQueueItems(due);
  // 2026-10-18 竹内さん 10/18 OK「毎晩の自己点検を朝の報告に載せる」: 予約の後にブレインの自己点検を1回（1日の上限 $10 の内・1回 $1 まで・
  //   今日済んでいれば流さない・結果は表 brain_self_review_runs へ＝朝の報告が読む）。申込以降の会話は対象外のまま。止める BRAIN_SELF_REVIEW_NIGHTLY=off
  if ((process.env.BRAIN_SELF_REVIEW_NIGHTLY ?? "").trim().toLowerCase() !== "off" && existsSync(join(process.cwd(), "scripts", "brain-self-review.ts"))) {
    log("毎晩の自己点検を流す（scripts/brain-self-review.ts --nightly）");
    await new Promise<void>((res) => { const ch = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "--env-file=.env.local", "scripts/brain-self-review.ts", "--nightly", "--from=both", "--max=10", "--usd-max=1"].map(q), { cwd: process.cwd(), stdio: "inherit", shell: process.platform === "win32" }); ch.on("error", (e) => { log(`  自己点検を流せない: ${String(e).slice(0, 120)}`); res(); }); ch.on("close", () => res()); });
  }
}
async function runQueueItems(due: ReturnType<typeof readQueue>) {
  const t0 = Date.now(), total = queueTotalMs(process.env), hard = itemHardMs(process.env);
  for (const x of due) {
    if (total !== null && Date.now() - t0 >= total) { log(`予約: この回の上限 ${Math.round(total / 60_000)}分を過ぎた → 残り ${due.length - due.indexOf(x)}本は次の回（予約はそのまま）`); break; }
    // 版ごとの取り置き（全部の問題）は夜の作業ツリー（origin/main の今のコード）で流す＝予約した担当の作業ツリーの古いコードで回さない
    const whole = x.argv.includes("--warm-main") && !x.argv.some((a) => /^--(types|stage|only)=/.test(a));
    const cwd = whole && existsSync(join(process.cwd(), "scripts", "exam-brain.ts")) ? process.cwd() : x.cwd;
    log(`予約を流す: ${x.label}（${x.createdAt} に予約・見込み $${x.estUsd.toFixed(2)}${cwd !== x.cwd ? `・夜の作業ツリーで` : ""}）`);
    // 2026-10-17 確かめる人: 予約した作業ツリーが消えていると spawn が error で落ち、後ろの予約も流れない＝飛ばす
    //   10/23 査読: 黙って消していた（cwd の区切りが抜けた手書きの予約もここで消えた）→ 大きく知らせて残す（直せば次の回に流れる）
    if (!existsSync(cwd)) { log(`  ⚠⚠ 予約した作業ツリーが無い（${cwd}）→ 流さず残す（${x.file}）${cwdLooksStripped(cwd) ? "。cwd の区切り（\\）が抜けている＝手書きの JSON。enqueue（JSON.stringify・path.resolve）で書き直す" : "。作業ツリーを戻すか予約を消す"}`); continue; }
    dequeue(x.file);
    const ts = Date.now();
    // EXAM_FROM_QUEUE: 夜中の予約の実行＝上限を超える時も収まる分だけ流す（capSplit の fill）
    await new Promise<void>((res) => {
      const ch = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "--env-file=.env.local", "scripts/exam-brain.ts", ...x.argv].map(q), { cwd, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, EXAM_FROM_QUEUE: "1" } });
      // 1本の上限: 超えたら子の木ごと止める（止まった子の控え・鍵は次の回の見回りで脇へ寄る）
      const timer = hard === null ? null : setTimeout(() => {
        log(`  ⏹ ${x.label} が ${Math.round(hard / 60_000)}分を超えた → 止める（EXAM_QUEUE_ITEM_MAX_MIN）`);
        try { if (process.platform === "win32" && ch.pid) execFileSync("taskkill", ["/PID", String(ch.pid), "/T", "/F"], { stdio: "ignore" }); else ch.kill("SIGTERM"); } catch { /* 既に終わった */ }
      }, hard);
      const done = () => { if (timer) clearTimeout(timer); res(); };
      ch.on("error", (e) => { log(`  流せない: ${String(e).slice(0, 120)}`); done(); }); ch.on("close", done);
    });
    log(`  ${x.label}: ${Math.round((Date.now() - ts) / 60_000)}分`);
  }
}

// ─── 本番に入れた版の答えを取り置く ───────────────────────────────────────────
async function warmMain() {
  const now = new Date();
  // 2026-10-22 --warm-plan: 下見だけ（AI を呼ばない）。今の main で入力が前の main と同じ問題はその答案を取り置き、違う問題の数と見込みの費用を出す
  const PLAN = flag("warm-plan");
  const w = decideWhen({ when: PLAN ? "now" : (arg("when", "night") as When), estUsd: 99, gate: true, now });
  if (!w.runNow) {
    if (!flag("wait")) { const f = enqueue({ label: `warm-${jst(now).slice(5, 10)}`, argv: [...args.filter((a) => !/^--when=/.test(a)), "--when=now"], cwd: process.cwd(), at: w.at.toISOString(), createdAt: now.toISOString(), estUsd: 0 }); log(`取り置きを予約した（${jst(w.at)} JST から）: ${f}`); return; }
    while (Date.now() < w.at.getTime()) await sleep(Math.min(10 * 60_000, w.at.getTime() - Date.now() + 1000));
  }
  const { spec, full } = loadExamProblems();
  const types = list("types");
  const ids = spec.filter((p) => !types.length || types.includes(p.type)).map((p) => p.id);
  const reps = Object.fromEntries(ids.map((id) => { const p = effective((full.get(id) ?? spec.find((s) => s.id === id)!) as AnyProblem); return [id, warmRepsOf(REPS_MODE, flakeVerdict(readObs(id), { problemHash: problemHash(p), model: "deepseek-all" }).verdict, MAX_REPS)]; }));
  // 10/17 ② 1日の上限: 取り置きも数える（守る線は無い）。10/20: 全部か0かでなく、残りの額で回せる数だけ今（--baseline-limit）・残りは次の夜中に続き
  //   （旧は見込み全部が上限を超えると毎晩先送りされた。取り置きに無い問題だけ回す＝使い回し・持ち越しは0円なので、見込みは回す問題の上限）
  //   10/22: 上限は「本当に回す（入力が前の main と違う）」問題に当てる（下見で同じだった問題は0円＝上限を使わない）
  const cap = dailyCapUsd(process.env);
  const peakK = isDeepseekPeakAt(new Date()) ? UNIT_USD.peakRatio : 1;
  let limit: number | null = null;
  if (cap !== null && !flag("over-cap") && !PLAN) {
    const used = await readDailySpend(sb).then((x) => x.usd).catch(() => cap);
    limit = warmLimit({ cap, usedUsd: used, unitUsd: UNIT_USD.brain * peakK * Math.max(1, ...Object.values(reps)) });
    if (!limit) {
      const at = nextNightRun(new Date());
      const f = enqueue({ label: arg("warm-vk") ? `warm-auto-${arg("warm-vk")}` : `warm-${jst(at).slice(5, 10)}`, argv: [...args.filter((a) => !/^--when=/.test(a)), "--when=now"], cwd: process.cwd(), at: at.toISOString(), createdAt: new Date().toISOString(), estUsd: 0 });
      log(`取り置き: 今日 $${used.toFixed(2)}・上限 $${cap}＝今は1問も回せない → 次の夜中（${jst(at)} JST）に回した: ${f}`);
      return;
    }
    log(`取り置き: 今日 $${used.toFixed(2)}・上限 $${cap} → 入力が前の main と違う問題を今 ${limit}問まで回す（残りは次の夜中）`);
  }
  // 10/22 ⑤ 1本ずつ: 取り置きは時間の予算（EXAM_WARM_BUDGET_MIN・既定 90分・off で無し）で自分で切る。残りはすぐ予約し直す
  //   （夜のタスクは30分おき・予約は比べを先に流す＝長い取り置きが比べを塞がない）。main が途中で進んだら古い main の答えを作り続けない
  const budgetMs = PLAN ? null : budgetMsOf(arg("budget-min") || (process.env.EXAM_WARM_BUDGET_MIN ?? "90"));
  const t0 = Date.now();
  const budgetArg = () => budgetMs === null ? [] : [`--baseline-budget-min=${Math.max(1, Math.round((budgetMs - (Date.now() - t0)) / 60_000))}`];
  const h = arg("warm-vk") ? { vk: arg("warm-vk"), commit: "" } : mainHead();
  mkdirSync(join(EXAM_BRAIN_DIR, "run"), { recursive: true });
  const repsFile = resolve(join(EXAM_BRAIN_DIR, "run", `warm-${Date.now().toString(36)}.reps.json`));
  writeFileSync(repsFile, JSON.stringify(reps));
  let left = 0, failed = false, commit = h?.commit ?? "";
  const why = new Set<string>();
  const plans: Array<{ stage: string; same: number; changed: string[]; usd: number }> = [];
  for (const stage of (arg("stage") ? list("stage") : ["brain"])) {
    const label = `warm-${Date.now().toString(36)}-${stage}`;
    const o = await runBrainExam([`--label=${label}`, `--only=${ids.join(",")}`, `--stage=${stage}`, "--baseline=main", "--baseline-only", REPLAY, `--repeat=${MAX_REPS}`, `--reps-file=${repsFile}`,
      ...(limit !== null ? [`--baseline-limit=${limit}`] : []), ...budgetArg(), ...(PLAN ? ["--baseline-plan-only"] : []),
      ...(JUDGE === "lazy" ? ["--judge=lazy"] : []), ...(JUDGE_PREFIX !== "as-is" ? [`--judge-prefix=${JUDGE_PREFIX}`] : []), ...(CONV ? [`--conv=${CONV}`] : []), ...PASS], CONV ? {} : { REPLAY_FLOOR_FILE: `scripts/.replay-out/brain-exam-floor-${label}.json` });
    const s = readBaselineSummary(label);
    if (o.code !== 0 || !s) failed = true;
    if (s) {
      left += s.deferred.length; if (s.deferWhy) why.add(s.deferWhy);
      if (limit !== null) limit = Math.max(0, limit - s.run.length);
      plans.push({ stage, same: s.planSame.length, changed: s.planChanged, usd: s.planUsd });
      log(`取り置き（${stage}）: 使い回し ${s.reused}（うち下見で入力が同じ ${s.planSame.length}）・持ち越し ${s.carried.length}・${PLAN ? `入力が違う ${s.planChanged.length}問（見込み 約 $${s.planUsd.toFixed(2)}）` : `今回した ${s.run.length}`}・残り ${s.deferred.length}${s.deferWhy ? `（${s.deferWhy}）` : ""}`);
    }
    try { commit = commit || (JSON.parse(readFileSync(join(RESULTS_DIR, `${label}.baseline.json`), "utf8")) as { commit?: string }).commit || ""; } catch { /* */ }
  }
  if (PLAN) {
    for (const p of plans) log(`\n📋 今の main の取り置きの見込み（${p.stage}）: 下見で入力が前の main と同じ ${p.same}問（0円）／入力が違う＝本当に回す ${p.changed.length}問・約 $${p.usd.toFixed(2)}${p.changed.length ? `（${p.changed.join(",")}）` : ""}`);
    return;
  }
  // 10/20 COST③: flash にした型・問題の「前」は flash の main で比べる（構成が違う置き場）→ 同じ夜に flash でも取り置く（1問 約 1/4 の値段）。--model=pro の時はしない
  if (arg("model", "auto") === "auto" && (arg("stage") ? list("stage") : ["brain"]).includes("brain") && !why.has("main-moved") && (budgetMs === null || Date.now() - t0 < budgetMs)) {
    const mc = readModelCheck();
    const fids = ids.filter((id) => { const t = String(spec.find((s) => s.id === id)?.type ?? ""); return !mc.badIds.has(id) && (mc.okTypes.has(t) || mc.okIds.has(id)); });
    if (fids.length && (limit === null || limit > 0)) {
      const label = `warm-${Date.now().toString(36)}-brain-fl`;
      const o = await runBrainExam([`--label=${label}`, `--only=${fids.join(",")}`, "--stage=brain", "--baseline=main", "--baseline-only", REPLAY, `--repeat=${MAX_REPS}`, `--reps-file=${repsFile}`,
        ...(limit !== null ? [`--baseline-limit=${Math.floor(limit / UNIT_USD.flashRatio)}`] : []), ...budgetArg(),
        ...(JUDGE === "lazy" ? ["--judge=lazy"] : []), ...(JUDGE_PREFIX !== "as-is" ? [`--judge-prefix=${JUDGE_PREFIX}`] : []), ...(CONV ? [`--conv=${CONV}`] : []), ...PASS],
        { ...(CONV ? {} : { REPLAY_FLOOR_FILE: `scripts/.replay-out/brain-exam-floor-${label}.json` }), DEEPSEEK_MODEL: FLASH_MODEL, EXAM_JUDGE_MODEL: PRO_MODEL });
      const s = readBaselineSummary(label);
      if (o.code !== 0 || !s) failed = true;
      if (s) { left += s.deferred.length; if (s.deferWhy) why.add(s.deferWhy); log(`取り置き（brain・flash ${fids.length}問）: 使い回し ${s.reused}（うち下見で入力が同じ ${s.planSame.length}）・持ち越し ${s.carried.length}・今回した ${s.run.length}・残り ${s.deferred.length}${s.deferWhy ? `（${s.deferWhy}）` : ""}`); }
    }
  } else if (budgetMs !== null && Date.now() - t0 >= budgetMs) { why.add("budget"); left += 1; }
  // 10/20 COST①: 版ごとの取り置きの記録（全部取れたら同じ版は二度と予約しない・途中なら続き）
  if (h?.vk) {
    writeWarmLog(h.vk, { at: new Date().toISOString(), commit, done: !failed && left === 0, left, label: `warm-${jst(new Date())}` });
    if (why.has("main-moved")) {
      // 10/22: 途中で main が進んだ＝古い版の続きは要らない。今の main の版の取り置きを今予約する（次の夜のタスクの回で比べの後に流れる）
      mainHeadMemo = undefined;
      log("取り置き: 途中で main が進んだ → 古い版の続きはやめ、今の main の取り置きを予約する");
      ensureMainWarm({ runNow: true });
    } else if (why.has("budget") && !failed) {
      // 予算で切った続き: すぐ予約し直す（同じ label＝同じ版。30分おきの夜のタスクが比べの後に流す）
      const f = enqueue({ label: arg("warm-vk") ? `warm-auto-${arg("warm-vk")}` : `warm-auto-${h.vk}`, argv: [...args.filter((a) => !/^--(when|warm-vk)=/.test(a)), "--when=now", `--warm-vk=${h.vk}`], cwd: process.cwd(), at: new Date().toISOString(), createdAt: new Date().toISOString(), estUsd: 0 });
      log(`取り置き: 時間の予算で切った（残り ${left}問）→ 続きを予約した（次の夜のタスクの回で、比べの予約の後に流す）: ${f}`);
    } else if (failed || left) ensureMainWarm({ cont: true });
  }
}

// ─── 8. モデルの比べ（flash で質が落ちないか・型ごと） ───────────────────────────────
async function modelCheck() {
  const { spec, full } = loadExamProblems();
  const types = list("types"), only = list("only");
  const n = Math.max(1, Number(arg("n", "8")) || 8);
  let ps = spec.filter((p) => (!only.length || only.includes(p.id)) && (!types.length || types.includes(p.type)));
  // 10/23: 型ごとの枠の中は、まだ比べていない問題を先に（旧＝spec の先頭から毎回同じ問題＝再生だと同じ証拠を2回数える）。旧の選び: MODEL_CHECK_PICK=head
  if (!only.length) {
    if (process.env.MODEL_CHECK_PICK === "head") { const c = new Map<string, number>(); ps = ps.filter((p) => { const k = c.get(p.type) ?? 0; if (k >= Math.ceil(n / Math.max(1, new Set(ps.map((x) => x.type)).size))) return false; c.set(p.type, k + 1); return true; }).slice(0, n); }
    else { let mc0: Parameters<typeof modelCheckedCounts>[0] = {}; try { mc0 = JSON.parse(readFileSync(MODEL_CHECK_FILE, "utf8")); } catch { /* 初回 */ } const pick = new Set(pickModelCheckIds(ps, { n, checked: modelCheckedCounts(mc0) })); ps = ps.filter((p) => pick.has(p.id)); }
  }
  const ids = ps.map((p) => p.id);
  const label = arg("label") || `mc-${Date.now().toString(36)}`;
  const common = (lb: string) => [`--label=${lb}`, `--only=${ids.join(",")}`, "--stage=brain", REPLAY, "--repeat=1", ...(JUDGE === "lazy" ? ["--judge=lazy"] : []), ...(CONV ? [`--conv=${CONV}`] : [])];
  const fl = (lb: string): Record<string, string> => (CONV ? {} : { REPLAY_FLOOR_FILE: `scripts/.replay-out/brain-exam-floor-${lb}.json` });
  log(`モデルの比べ: ${ids.length}問（${ids.join(",")}）を pro と flash のブレインで（判定はどちらも pro）`);
  const since = new Date().toISOString();
  await runBrainExam(common(`${label}-pro`), fl(`${label}-pro`));
  await runBrainExam(common(`${label}-flash`), { ...fl(`${label}-flash`), DEEPSEEK_MODEL: FLASH_MODEL, EXAM_JUDGE_MODEL: PRO_MODEL });
  const a = readRows(`${label}-pro`), b = readRows(`${label}-flash`);
  const prev = existsSync(MODEL_CHECK_FILE) ? JSON.parse(readFileSync(MODEL_CHECK_FILE, "utf8")) as { byType: Record<string, ModelCheckStat>; byId?: Record<string, ModelCheckStat>; runs?: unknown[] } : { byType: {}, byId: {}, runs: [] };
  const lines: string[] = [];
  for (const id of ids) {
    const x = a.find((r) => r.id === id && !r.error), y = b.find((r) => r.id === id && !r.error);
    if (!x || !y) { lines.push(`  ${id}: 片方が無い`); continue; }
    const t = String(full.get(id)?.type ?? spec.find((s) => s.id === id)?.type ?? "");
    // 10/23: pro も flash もブレインが全部「録った答えの再生」＝前の比べと同じ証拠 → 数えない（型の n を水増ししない）
    if (!modelPairCountable([x, y] as never)) { lines.push(`  ・ ${id}[${t}] 両方とも録った答えの再生＝前と同じ証拠なので数えない`); continue; }
    const e = prev.byType[t] ?? { n: 0, samePath: 0, proOk: 0, flashOk: 0 };
    e.n++; if (x.path?.code === y.path?.code) e.samePath++; if (x.path?.ok) e.proOk++; if (y.path?.ok) e.flashOk++;
    prev.byType[t] = e;
    // 10/20 COST③: 問題ごとにも残す（型が通っていなくても、その問題で何度も同じなら flash・違ったら型が通っていても pro）
    const ei = (prev.byId ??= {})[id] ?? { n: 0, samePath: 0, proOk: 0, flashOk: 0 };
    ei.n++; if (x.path?.code === y.path?.code) ei.samePath++; if (x.path?.ok) ei.proOk++; if (y.path?.ok) ei.flashOk++;
    prev.byId[id] = ei;
    lines.push(`  ${x.path?.code === y.path?.code ? "＝" : "≠"} ${id}[${t}] pro=${x.path?.code}${x.path?.ok ? "○" : "✕"} flash=${y.path?.code}${y.path?.ok ? "○" : "✕"}`);
  }
  (prev.runs ??= []).push({ at: since, label, ids });
  mkdirSync(EXAM_BRAIN_DIR, { recursive: true });
  writeFileSync(MODEL_CHECK_FILE, JSON.stringify(prev, null, 1));
  for (const l of lines) log(l);
  const sp = await spendOf([`${label}-pro`, `${label}-flash`], since).catch(() => ({ n: 0, usd: 0 }));
  const sa = await spendOf([`${label}-pro`], since).catch(() => ({ n: 0, usd: 0 })), sbb = await spendOf([`${label}-flash`], since).catch(() => ({ n: 0, usd: 0 }));
  log(`型ごと（累計）: ${Object.entries(prev.byType).map(([k, v]) => `${k} 道が同じ ${v.samePath}/${v.n}・合う pro ${v.proOk}/flash ${v.flashOk}`).join("／")}`);
  { const m = readModelCheck(); log(`flash にしてよい型（${FLASH_TYPE_MIN_N}回以上・道が同じ 9割以上・合う数が pro 以上）: ${[...m.okTypes].join("・") || "まだ無い"}／問題（2回以上いつも同じ）: ${[...m.okIds].join(",") || "まだ無い"}／flash にしない問題（道が違った）: ${[...m.badIds].join(",") || "なし"}`); }
  log(`費用: pro ${sa.n}回 $${sa.usd.toFixed(4)}・flash ${sbb.n}回 $${sbb.usd.toFixed(4)}（合計 ${sp.n}回 $${sp.usd.toFixed(4)}・判定は別）`);
}

// ─── 9. 台帳 ───────────────────────────────────────────────────────────
function showLedger() {
  const id = arg("id");
  const days = Math.max(1, Number(arg("days", "14")) || 14);
  const since = Date.now() - days * 86_400_000;
  const ls = readLedger().filter((l) => (!id || l.id === id) && Date.parse(l.at) >= since);
  const ids = id ? [id] : [...new Set(ls.map((l) => l.id))].sort();
  for (const pid of ids) {
    const obs = readObs(pid, FLAKE_DIR, Date.now(), days).sort((a, b) => a.at.localeCompare(b.at));
    const lines = ls.filter((l) => l.id === pid);
    log(`\n■ ${pid}（揺れの記録 ${obs.length}回・試験のブレインの台帳 ${lines.length}行）`);
    for (const l of lines) log(`  ${jst(new Date(l.at))} ${l.label}[${l.stage}] 版 ${l.head}/${l.scopeKey} ${l.model} 回${l.reps} 道=${l.codes.join("/")}${l.pathOk ? "○" : "✕"} 合格${l.pass ? "○" : "✕"} 前と=${l.cmp}${l.verdict ? `（${l.verdict === "real" ? "本当" : l.verdict === "flake" ? "揺れ" : "未確認"}）` : ""}${l.reused ? " ♻" : ""}`);
    if (id) for (const o of obs.slice(-30)) log(`  · ${jst(new Date(o.at))} ${o.label}#${o.rep} ${o.model} コード ${o.codeKey} ${o.sig}${o.independent ? "" : "（再生）"}`);
  }
  if (!ids.length) log("台帳は空（試験のブレインで流すと残る・揺れの記録は --id= で見る）");
}

// ─── 止まった実行の残りの片付け ────────────────────────────────────────────
async function cleanup() {
  const label = arg("label"); const conv = arg("conv");
  if (!label || !conv) throw new Error("--cleanup は --conv=YUMA2〜5 と --label=<止まった実行の label> が要る");
  // 置き場: --from=<作業ツリー>（無ければ全部の作業ツリーから label の控えを探す）
  let dir = arg("from") ? join(arg("from"), "scripts", ".replay-out") : "";
  if (!dir) {
    const root = join(execSync("git rev-parse --path-format=absolute --git-common-dir").toString().trim(), "..");
    const cands = [join(root, "scripts", ".replay-out"), ...readdirSync(join(root, ".claude", "worktrees")).map((d) => join(root, ".claude", "worktrees", d, "scripts", ".replay-out"))];
    dir = cands.find((d) => existsSync(join(d, `brain-exam-floor-${label}-${conv.toLowerCase()}.json`)) || existsSync(join(d, `.brain-exam-${label}-ledger-ids.json`))) ?? "";
    if (!dir) throw new Error(`label ${label} の控えが見つからない（--from=<作業ツリー> で指す）`);
  }
  const pl = planCleanup(conv, label, dir);
  log(`片付け: ${pl.conv.name}（${pl.conv.id}）・label ${label}・置き場 ${dir}・止まった実行 pid ${pl.runPid ?? "-"}（${pl.runAlive ? "生きている" : "止まっている"}）${pl.leaseLock ? `・会話の鍵 pid ${pl.leaseLock.pid}（${pl.leaseLock.alive ? "生きている" : "止まっている"}）` : ""}`);
  const r = await runCleanup(sb, pl, flag("apply"));
  log(flag("apply") ? `片付けた: 通 ${r.messages}・台帳 ${JSON.stringify(r.ledger)}・条件の行 ${r.pc ? "戻した" : "なし"}` : "（数えただけ。--apply で片付ける）");
}


// ─── 10/20 司令塔（pro）と読み手（flash）— 設計知見 ea215526・487b8921・98bca000・5be49dda（P0）・c0884407（P0） ─────────────
//   --conduct          直した中身を読み手（flash）が読み → RAG の選び＋外れの型の地図＋つなぎの線の候補 → 司令塔（pro・短い JSON）が重点・段・回数・モデル・判定の段を決める（流さない）
//   --run-plan[=<label か file>] 司令塔の計画どおり流す（2倍の時間の仕上げは今まで通り夜中に予約）→ 結果を外れの型で返し・前と並べ・次の重点の候補を出す
//   --miss-map [--source=latest]  外れの型の地図（既定は本番に入れた版 main の答案）
//   --coverage [--json] 試験の地図（申込までの地図×外れの型×ピッカー×つなぎの線の覆いと空き）
const pct0 = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
function conductorProblems(): ProblemLike[] { return loadExamProblems().spec.map((p) => effective(p) as unknown as ProblemLike); }
function buildMap(source: "main" | "latest", ps = conductorProblems()): MissMap {
  return buildMissMap(ps, (id) => { const p = ps.find((x) => x.id === id)!; return source === "main" ? mainRowsOf(p) : latestRowsOf(p); });
}
function printMissMap(m: MissMap, title: string) {
  log(`\n=== 外れの型の地図（${title}・${m.n}問・合格 ${m.ok}（${pct0(m.ok, m.n)}）・答案が無い ${m.noData.length}問）===`);
  log(`外れの型（多い順・過半数の回に出た型）: ${Object.entries(m.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("・") || "なし"}`);
  if (m.byPart) log(`  段ごと: ブレイン ${Object.entries(m.byPart.brain).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("・") || "なし"}／下書き ${Object.entries(m.byPart.draft).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("・") || "なし"}`);
  log(`脳の働きの型: ${Object.entries(m.byFn).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("・") || "なし"}`);
  log(`つなぎの線（外れ/問題）: ${LINK_IDS.map((l) => `${l} ${LINKS[l].label} ${m.byLink[l].miss}/${m.byLink[l].n}`).join("・")}`);
  log(`申込までの地図（外れ/問題）: ${MAP_STAGES.map((s) => `${MAP_STAGE_JA[s]} ${m.byStage[s].miss}/${m.byStage[s].n}`).join("・")}`);
  const src = new Map<string, number>();
  for (const e of m.entries) { const k = String(e.source ?? "").replace(/ v-\S*$/, "").replace(/ [\w.-]+（.*$/, ""); src.set(k, (src.get(k) ?? 0) + 1); }
  log(`答案の出どころ: ${[...src].map(([k, n]) => `${k} ${n}`).join("・")}`);
}
async function showMissMap() {
  const source = arg("source", "main") === "latest" ? "latest" : "main";
  const m = buildMap(source);
  printMissMap(m, source === "main" ? "本番に入れた版 main の答案" : "作業の結果も含めた一番新しい答案");
  for (const e of m.entries.filter((x) => !x.ok).slice(0, Number(arg("n", "40")) || 40)) log(`  ✕ ${e.id} [${e.type}] ${MAP_STAGE_JA[e.stage]}・${e.links.join(",") || "-"}・${e.kinds.join("／") || "-"}${e.flakyKinds.length ? `（揺れ: ${e.flakyKinds.join("／")}）` : ""}`);
  log(`保存: ${saveMissMap(m, `${source}-${jst(new Date()).slice(0, 10)}`)}`);
}
function readGolds(): GoldLite[] {
  try {
    const g = (JSON.parse(readFileSync("scripts/parts-eval/gold-20.json", "utf8")) as { golds: Array<GoldLite & { asks?: Array<{ id?: string }> }> }).golds;
    let x: Record<string, { asks?: Record<string, { pickers?: string[]; referent?: unknown; sure?: string }> }> = {};
    try { x = JSON.parse(readFileSync("scripts/parts-eval/gold-20.extra.json", "utf8")); } catch { /* */ }
    return g.map((gg) => ({ id: gg.id, asks: (gg.asks ?? []).map((a) => ({ ...a, ...(((x[gg.id]?.asks ?? {}) as Record<string, object>)[(a as { id?: string }).id ?? ""] ?? {}) })) }));
  } catch { return []; }
}
async function showCoverage() {
  const ps = conductorProblems();
  const golds = readGolds();
  const c = buildCoverage(ps, golds);
  log(`\n=== 試験の地図（覆いの地図・${ps.length}問＋パーツの正解 ${golds.length}問）===`);
  log(`申込までの地図: ${c.stage.map((s) => `${MAP_STAGE_JA[s.stage]} ${s.n}`).join("・")}`);
  log(`つなぎの線: ${c.link.map((l) => `${l.link} ${LINKS[l.link].label} ${l.n}問`).join("・")}`);
  log("外れの型（測れる問題の数）:");
  for (const k of c.kind) log(`  ${k.measurable < 3 ? "□" : "■"} ${k.kind} ${k.measurable}（${k.how}）`);
  log(`ピッカー（正解にピッカーまで書いた問題）: ${c.picker.map((p) => `${p.label}${p.planned ? "※" : ""} ${p.n}`).join("・")}`);
  log("段×線（問題の数・0 は空き）:");
  log(`  ${"".padEnd(3, "　")}${LINK_IDS.map((l) => l.padStart(4)).join("")}`);
  for (const s of MAP_STAGES) log(`  ${MAP_STAGE_SHORT[s].padEnd(3, "　")}${LINK_IDS.map((l) => String(c.stageXlink.find((x) => x.stage === s && x.link === l)?.n ?? 0).padStart(4)).join("")}`);
  log(`  （段: ${MAP_STAGES.map((s) => `${MAP_STAGE_SHORT[s]}＝${MAP_STAGE_JA[s]}`).join("・")}）`);
  log("試験が測っている道具:");
  for (const x of c.tools) log(`  ${x.n ? "■" : "□"} ${x.tool} ${x.n}問（${x.how}）`);
  log("\n空いている所と足し方の案:");
  for (const h of c.holes) log(`  ・${h.where}（${h.why}）\n     → ${h.add}`);
  if (flag("json")) { mkdirSync(CONDUCTOR_DIR, { recursive: true }); const f = join(CONDUCTOR_DIR, `coverage-${jst(new Date()).slice(0, 10)}.json`); writeFileSync(f, JSON.stringify(c, null, 1)); log(`保存: ${f}`); }
}
/** 今までのやり方の見込み（比べる用）: 旧＝選んだ問題全部・小さな確かめ＝今の既定（どちらも1回・使い回しは数えない） */
function oldWayEst(pl: Plan, peak: boolean): { off: number; small: number; offN: number; smallN: number } {
  const unit = (draft: boolean) => (UNIT_USD.brain + (draft ? UNIT_USD.draftExtra : 0)) * (peak ? UNIT_USD.peakRatio : 1);
  const draftAll = pl.cls === "draft" || pl.cls === "both";
  const off = pl.allPicks.reduce((s, p) => s + unit(draftAll && draftEligibleOf(pl, p.id)), 0);
  const sm = pickSmall(pl.allPicks);
  const small = sm.reduce((s, p) => s + unit(draftAll && draftEligibleOf(pl, p.id)), 0);
  return { off, small, offN: pl.allPicks.length, smallN: sm.length };
}
/**
 * 試験の印（LLM_TEST_MODE／LLM_TEST_FINAL_CLAUDE）を付けて呼ばれた時は、試験の入口（setupLlmTest）を通してから LLM を呼ぶ（記録・録音・Claude の鍵の歯止め）。
 *   印が無い時（今の exam-brain の普段の使い方＝子にだけ印を付ける）は今まで通り直に呼ぶ。子（brain-exam）を回す前には入れない（Claude の鍵を偽の値にするため）
 */
async function llmGate(name: string): Promise<{ finish: () => Promise<unknown> } | null> {
  if (!process.env.LLM_TEST_MODE && !process.env.LLM_TEST_FINAL_CLAUDE) return null;
  const { setupLlmTest } = await import("./lib/llm-test-harness");
  const h = await setupLlmTest(name);
  // 2026-10-20 確かめ: 入口を通しても DeepSeek への直の呼び出し（callDeepSeek）は llm_usage_logs に残らない（0行）＝手元の記録（local-llm-spend）は止めない
  setLocalSpendRecording(true);
  return { finish: () => h.finish() };
}
async function conduct() {
  const gate = await llmGate("exam-conductor");
  try { await conductInner(); } finally { await gate?.finish(); }
}
async function conductInner() {
  const now = new Date();
  const label = arg("label") || `cd-${jst(now).slice(5, 10).replace("-", "")}-${Math.random().toString(36).slice(2, 6)}`;
  if (!/^[\w.-]+$/.test(label)) throw new Error(`--label は英数字・-・_ だけ: ${label}`);
  const tally = newTally();
  // 10/20 COST①: 新しい main の版の答えが無ければ夜中の取り置きを予約（新しい問題の「前」をその場で解かずに済む）
  ensureMainWarm();
  if (isDeepseekPeakAt(now)) log("⚠ 今は DeepSeek の2倍の時間（平日 JST 10〜13・15〜19）。司令塔と読み手の分（1回 約 $0.01）も2倍で数える");
  // ① 直した中身（伏せ字・個人の値がある行は捨てる）
  const mat = await diffMaterial(sb, ".", { range: arg("range") || undefined });
  // 2026-10-20 範囲（--range か main の作業ツリーで自動で決めた起点）を RAG の選びにも渡す（作業ツリーの差＝main そのものだと 0 になっていた）
  if (mat.range) RANGE = mat.range;
  if (mat.rangeWhy) log(`見た範囲: ${mat.rangeWhy}（${mat.range}）`);
  log(`\n直した中身: ${mat.cls}・ファイル ${mat.files.length}・コミット ${mat.commits.length}・設計知見 ${mat.kbIds.join(",") || "なし"}${mat.dropped ? `・個人の値の網で捨てた行 ${mat.dropped}` : ""}${mat.note ? `（${mat.note}）` : ""}`);
  // ② 読み手（flash）: 差分が効く所・外れの型・線・段・探す言葉
  let reading: DiffReading | null = null;
  if (mat.files.length && !flag("no-reader")) {
    const user = [`【変えたファイル】\n${mat.files.slice(0, 30).map((f) => `${f.file}（${f.cls}・${f.why}）`).join("\n")}`, `【コミットの文】\n${mat.commits.slice(0, 8).join("\n―\n").slice(0, 1500) || "なし"}`, `【差分（足した・消した行・伏せ字）】\n${mat.diffText}`].join("\n\n");
    reading = parseDiffReading((await callConductorLlm("diff-reader", C_FLASH, DIFF_READER_SYSTEM, user, tally, { maxTokens: 600 })) ?? "");
    log(`読み手（flash）: ${reading ? `効く所 ${reading.effects.map((e) => e.what).join("・") || "-"}／型 ${reading.kinds.join("・") || "-"}／線 ${reading.links.join("・") || "-"}／段 ${reading.stages.map((s) => MAP_STAGE_JA[s]).join("・") || "-"}／探す言葉「${reading.query}」` : "読めなかった（司令塔は差分の名前だけで決める）"}`);
    if (reading) EXTRA_Q = [reading.query, ...reading.effects.map((e) => e.what)].filter(Boolean).join(" ");
  }
  // ③ 今の試験のブレインの選び（RAG＋必ず流す物）を候補の土台に（RAG の言葉に読み手の探す言葉を足す）
  PHASE_ARG = "final";
  const pl = await makePlan(label);
  const ps = conductorProblems();
  const byId = new Map(ps.map((p) => [p.id, p]));
  const map = buildMap("main", ps);
  const ent = new Map(map.entries.map((e) => [e.id, e]));
  const prev = loadLatestResult();
  const cands = new Map<string, Candidate>();
  const addCand = (id: string, why: string) => {
    const p = byId.get(id); if (!p) return;
    const c = cands.get(id);
    if (c) { if (why && !c.why.includes(why)) c.why.push(why); return; }
    const e = ent.get(id), it = pl.items.get(id);
    const fv = flakeVerdict(readObs(id), { problemHash: problemHash((pl.probs.get(id) ?? p) as never), model: "deepseek-all" });
    const whys = pl.allPicks.find((x) => x.id === id)?.why ?? [];
    cands.set(id, { id, type: p.type, stage: mapStageOf(p), links: linksOf(p), why: [...whys, ...(why && !whys.includes(why) ? [why] : [])], flaky: fv.verdict === "flaky", reuse: !!it?.reuse,
      draftEligible: draftEligible(p as PlanProblem), lastOk: e ? e.ok : null, lastKinds: e?.kinds ?? [], protectedPick: whys.some((w) => /名指し|前に落ちた/.test(w)) });
    // 司令塔の守る線は名指し・前に落ちた問題だけ（竹内さんのお手本・竹内さんの番は強い候補として渡し、仕上げ（--phase=final・--gate）で今まで通り全部流す＝小さな確かめと同じ扱い）
  };
  // 2026-10-20 確かめる人: 選びが「全部」（道具の変更等）の時に q001〜q040 の並びだけが候補になり、前の結果・読み手の型の候補が入らなかった＝
  //   小さな確かめの順（名指し→前に落ちた→直した所に近い→お手本）で 24 まで → 前の結果 → 読み手の型・線 → 残りの順で 40 まで
  const ranked = pl.allPicks.map((p, i) => ({ p, i, ...smallRank(p.why) })).sort((a, b) => a.tier - b.tier || b.sim - a.sim || a.i - b.i);
  for (const x of ranked) if (x.tier <= 1.5 || cands.size < 24) addCand(x.p.id, "");
  for (const f of prev?.next ?? []) addCand(f.id, `前の結果: ${f.why}`);
  // 10/20 QUALITY⑤: 前の実行で読み手が付けた外れの理由（「正解が揺れている」「判定の誤り」は直す的でない＝候補の理由に書くだけ）
  const lastReasons = loadLatestReasons();
  for (const r of lastReasons?.reasons ?? []) addCand(r.id, `前の外れの理由「${r.kind}」${r.evidence ? `: ${r.evidence.slice(0, 30)}` : ""}`);
  if (reading) {
    for (const e of map.entries) {
      if (cands.size >= 40) break;
      const hitK = e.kinds.find((k) => reading!.kinds.includes(k)), hitL = e.links.find((l) => reading!.links.includes(l));
      if (hitK || hitL) addCand(e.id, hitK ? `読み手の型「${hitK}」で今外れ` : `読み手の線 ${hitL}（${LINKS[hitL!].label}）`);
    }
  }
  for (const x of ranked) { if (cands.size >= 40) break; addCand(x.p.id, ""); }
  let candidates = [...cands.values()].slice(0, 40);
  // 10/20 QUALITY⑧ 見張りの釣り合い: 直す的（名指し・前に落ちた・直した所に近い・読み手の型・前の外れの理由・前の結果）ごとに、
  //   周りの今合っている問題（同じ型 → 同じ段・同じ線 → 同じ段）を見張りの候補に足す（最大8）。司令塔が重点に見張りを付けなければ normalizePlan が1つ足す
  const seeds = candidates.filter((c) => c.protectedPick || c.why.some((w) => /差分の言葉に近い|知見|読み手の|前の外れの理由|前の結果/.test(w))).slice(0, 8);
  const pool = ps.flatMap((p) => { const e = ent.get(p.id); if (!e?.ok) return []; return [{ id: p.id, type: p.type, stage: mapStageOf(p), links: linksOf(p), lastOk: true as const, flaky: flakeVerdict(readObs(p.id), { problemHash: problemHash((pl.probs.get(p.id) ?? p) as never), model: "deepseek-all" }).verdict === "flaky", reuse: !!pl.items.get(p.id)?.reuse }]; });
  const watch = watchNeighbors(seeds.map((c) => ({ id: c.id, type: c.type, stage: c.stage, links: c.links })), pool, { perFix: 2, max: 8 });
  for (const [seed, ws] of Object.entries(watch)) for (const w of ws) addCand(w.id, w.why.replace("見張り（", `見張り（${seed} の周り・`).replace(`直す的 ${seed} の周り: `, ""));
  candidates = [...new Map([...candidates, ...[...cands.values()].filter((c) => Object.values(watch).some((ws) => ws.some((w) => w.id === c.id)))].map((c) => [c.id, c])).values()];
  // ④ 上限（この実行の上限と、1日の上限の残りの小さい方）
  const cap = dailyCapUsd(process.env);
  const used = cap === null ? null : await readDailySpend(sb, now).catch(() => null);
  const runCap = Number(arg("cap-usd", process.env.EXAM_CONDUCT_CAP_USD ?? "0.5")) || 0.5;
  const capUsd = Math.max(0, Math.min(runCap, cap === null ? Infinity : cap - (used?.usd ?? cap)));
  const mc = readModelCheck();
  const input: ConductorInput = {
    change: { cls: mat.cls, files: mat.files.map((f) => ({ file: f.file, cls: f.cls })), kbIds: mat.kbIds, commits: mat.commits, reading },
    missTop: Object.entries(map.byKind).sort((a, b) => b[1] - a[1]).map(([kind, n]) => ({ kind, n })),
    linkMiss: LINK_IDS.map((l) => ({ link: l, label: LINKS[l].label, n: map.byLink[l].n, miss: map.byLink[l].miss })),
    reasons: (lastReasons?.aggregate ?? []).map((a) => ({ kind: a.kind, n: a.n })),
    candidates, capUsd, unit: UNIT_USD, flashOkTypes: [...mc.okTypes, ...[...mc.okIds].filter((id) => !mc.badIds.has(id))], prevFocus: prev?.next ?? [],
  };
  // ⑤ 司令塔（pro・短い JSON）。答えない時は決まった順の代わり
  const rawText = flag("no-conductor") ? null : await callConductorLlm("conductor", C_PRO, CONDUCTOR_SYSTEM, buildConductorUser(input), tally, { maxTokens: 900 });
  const raw = rawText ? looseJson(rawText) : null;
  // 2026-10-20 確かめる人: 司令塔が答えない・答えが空（候補に無い id だけ等）の時は今までの小さな確かめの選び（pickSmall）の順に戻す
  const smallIds = new Set(pickSmall(pl.allPicks).map((p) => p.id));
  const fbCands = candidates.filter((c) => smallIds.has(c.id));
  const fb = () => fallbackRaw(fbCands.length ? fbCands : candidates, fbCands.length || 8);
  // 2026-10-20 新しい問題（main の答案が1つも無い）は司令塔の答えに関わらず決まった計算で入れる（1回・一番安くて足りるモデル・1日の上限の残りまで）
  const answered = mainAnsweredIds();
  const freshIds = freshProblemIds(ps, (p) => answered.has(p.id));
  const fresh = { items: freshIds.map((id) => ({ id, type: byId.get(id)!.type })), dailyLeftUsd: cap === null ? null : cap - (used?.usd ?? cap) };
  const nopt = { draftChange: mat.cls === "draft" || mat.cls === "both", allowTier: flag("judge-tier") || process.env.EXAM_JUDGE_TIER === "on", fresh, watch };
  let plan = normalizePlan(raw ?? fb(), input, nopt);
  const nonFresh = (pp: typeof plan) => pp.focus.filter((x) => !(pp.fresh ?? []).includes(x.id)).length;
  if (!raw) plan.source = "fallback";
  else if (!nonFresh(plan) && candidates.length) { const d = plan.dropped; plan = normalizePlan(fb(), input, nopt); plan.source = "fallback"; plan.dropped = [...d, ...plan.dropped]; plan.note = "司令塔の答えが空→小さな確かめの順"; }
  let head = ""; try { head = execSync("git rev-parse --short HEAD").toString().trim(); } catch { /* */ }
  const f = savePlan({ label, at: now.toISOString(), head, conv: CONV, plan, candidates: candidates.length, material: { cls: mat.cls, files: mat.files.length, kbIds: mat.kbIds, reading }, llm: tally, ragNote: pl.ragNote });
  // 表示
  const peak = isDeepseekPeakAt(now);
  const old = oldWayEst(pl, false);
  log(`\n=== 司令塔の計画（${label}・${plan.source === "pro" ? "司令塔 pro" : "司令塔なし＝決まった順"}・候補 ${candidates.length}問）===`);
  log(`材料: 選び ${pl.ragNote || "-"}・外れの型 ${input.missTop.slice(0, 4).map((x) => `${x.kind} ${x.n}`).join("・") || "-"}・前の次の重点 ${prev?.next.length ?? 0}`);
  const freshSet = new Set(plan.fresh ?? []);
  const line = (it: (typeof plan.focus)[number], mark: string) => log(`  ${mark} ${it.id} [${byId.get(it.id)?.type}] 段 ${it.stage === "draft" ? "ブレイン→下書き" : "ブレイン"}・回 ${it.reps}・${it.model}${cands.get(it.id)?.reuse ? "・前の結果を使える" : ""} ← ${it.why}`);
  for (const it of plan.focus) if (!freshSet.has(it.id)) line(it, it.role === "fix" ? "◎重点" : "○見張り");
  const freshDropped = plan.dropped.filter((d) => freshIds.includes(d.id));
  if (freshIds.length) {
    log(`新しい問題（答案なし）: ${freshSet.size}/${freshIds.length}問を入れた（main の答案が1つも無い＝司令塔の前に決まった計算で・1回・一番安くて足りるモデル・1日の上限の残りまで）`);
    for (const it of plan.focus) if (freshSet.has(it.id)) line(it, "☆新しい");
    if (freshDropped.length) log(`  1日の上限で今は入れない: ${freshDropped.map((d) => d.id).join(",")}`);
  }
  if (plan.dropped.length) log(`  削った: ${plan.dropped.map((d) => `${d.id}（${d.why}）`).join("・")}`);
  { const fixN = plan.focus.filter((x) => x.role === "fix").length, guardN = plan.focus.filter((x) => x.role === "guard" && !freshSet.has(x.id)).length, seedN = Object.keys(watch).length;
    log(`見張りの釣り合い: 重点 ${fixN}・見張り ${guardN}（直す的 ${seedN}の周りの候補 ${Object.values(watch).flat().length}問・同じ型 → 同じ段・同じ線 → 同じ段・今合っている問題から）`); }
  log(`判定の段: ${plan.judge === "tier" ? "機械の照らし → flash 2回 → 割れた項目だけ pro（EXAM_JUDGE_TIER=on）" : `pro（今まで通り）${plan.judgeAdvice === "tier" ? "・司令塔の勧めは段の判定（--judge-tier で使う＝前（main）の取り置きも段の判定で作り直す）" : ""}`}`);
  log(`最後の Claude の確かめ: ${plan.claudeFinal ? `要る（${plan.claudeWhy}）＝本番に入れる前に LLM_TEST_FINAL_CLAUDE=1 で重点だけ` : `要らない${plan.claudeWhy ? `（${plan.claudeWhy}）` : ""}`}`);
  log(`見込み: 司令塔の計画 約 $${plan.estUsd.toFixed(3)}（${plan.focus.length}問・上限 $${capUsd.toFixed(2)}${cap !== null ? `・今日 $${(used?.usd ?? 0).toFixed(2)}/上限 $${cap}` : ""}）＋判定／今までのやり方: 小さな確かめ 約 $${old.small.toFixed(3)}（${old.smallN}問）・選んだ問題全部 約 $${old.off.toFixed(3)}（${old.offN}問）（どれも通常の値段・1回${peak ? "・今は2倍の時間＝流すのは 13〜15 時か夜中" : ""}）`);
  log(`司令塔と読み手の費用: ${tally.calls}回 $${tally.usd.toFixed(4)}（${Object.entries(tally.byRole).map(([k, v]) => `${k} ${v.calls}回 $${v.usd.toFixed(4)}`).join("・")}）${tally.refused ? `・個人の値で送らなかった ${tally.refused}` : ""}${tally.failed ? `・失敗 ${tally.failed}` : ""}`);
  if (plan.note) log(`司令塔のひと言: ${plan.note}`);
  log("※ これは直しの途中の確かめ（小さな確かめの代わり）。本番に入れる前の仕上げは今まで通り --phase=final（お手本・竹内さんの番を含む選んだ問題全部）か --gate");
  log(`計画: ${f}\n  流す: npx tsx --env-file=.env.local scripts/exam-brain.ts --run-plan=${label}${CONV ? ` --conv=${CONV}` : ""}`);
}
/** 結果の振り分け（flash）: 機械で中身が分からない外れだけ。材料は伏せ字の札・正解の要点・答案の要約（1行ずつ伏せて、個人の値の行は捨てる） */
async function triageUnknown(ids: string[], rowsOf: (id: string) => RowLite[], tally: ReturnType<typeof newTally>): Promise<TriageItem[]> {
  if (!ids.length) return [];
  const { loadCards } = await import("./lib/exam-rag-store");
  const cards = (await loadCards(sb).catch(() => ({}))) as Record<string, { words?: string }>;
  const { spec } = loadExamProblems();
  const lines: string[] = [];
  for (const id of ids.slice(0, 8)) {
    const p = spec.find((x) => x.id === id) as unknown as ProblemLike | undefined; if (!p) continue;
    const r = rowsOf(id).find((x) => !x.error) as (RowLite & { brain?: Record<string, unknown> }) | undefined;
    const b = (r?.brain ?? {}) as Record<string, unknown>;
    const tc = b.turn_contract as { asks?: Array<{ quote?: string; route?: string; answer?: string }> } | undefined;
    lines.push([`■ ${id}（${p.type}）`, `お客様: ${String(cards[id]?.words ?? "").slice(0, 300)}`, `正解の道: ${(p.accept ?? []).join("|")}`,
      `正解の要点: ${(p.asks ?? []).map((a, i) => `${i + 1}.${a.route}:${a.point ?? ""}`).join(" ／ ").slice(0, 400)}`,
      `答案: 道=${r?.path?.code ?? "?"}・action=${String(b.action ?? "")}・方向=${String(b.reply_direction ?? "").slice(0, 160)}・依頼=${(tc?.asks ?? []).map((a) => `${a.route}:${String(a.answer ?? a.quote ?? "").slice(0, 40)}`).join(" ／ ").slice(0, 300)}`].join("\n"));
  }
  const user = safeLines(lines.join("\n\n")).text;
  return parseTriage((await callConductorLlm("triage", C_FLASH, TRIAGE_SYSTEM, user, tally, { maxTokens: 800 })) ?? "", ids);
}
async function runPlan() {
  const v = args.find((x) => /^--run-plan(=|$)/.test(x))?.split("=").slice(1).join("=") ?? "";
  const sp = loadPlan(v || undefined);
  if (!sp) throw new Error(`司令塔の計画が無い（--conduct で作る・--run-plan=<label か plan.json>）: ${v}`);
  CONDUCTED = sp;
  // 2026-10-20 確かめる人: 上限で夜中に回した分（--only＝計画の一部）を流す時は、その分だけ（計画の全部に戻さない）
  const onlyArg = arg("only").split(",").map((s) => s.trim()).filter(Boolean);
  const ids = sp.plan.focus.map((f) => f.id).filter((id) => !onlyArg.length || onlyArg.includes(id));
  if (!ids.length) { log("計画の問題が0"); return; }
  const label = arg("label") || `${sp.label}-r`;
  // 計画の問題だけ・仕上げの形（司令塔がもう絞った）・夜中の予約に回る時もこの計画で流れるようにファイル名を固定
  for (let i = args.length - 1; i >= 0; i--) if (/^--(run-plan|only|label|phase|select|select-q|name)(=|$)/.test(args[i])) args.splice(i, 1);
  args.push(`--run-plan=${join(CONDUCTOR_DIR, `${sp.label}.plan.json`)}`, `--only=${ids.join(",")}`, `--label=${label}`);
  PHASE_ARG = "final";
  const ps = conductorProblems();
  const sub = ps.filter((p) => ids.includes(p.id));
  log(`\n=== 司令塔の計画で流す（${sp.label}・${ids.length}問・判定 ${sp.plan.judge}）===`);
  await runMain();
  // 結果（今回の答案）を外れの型で返す（下書きまで流した問題は下書きの答案＝ブレインの欄も入っている）
  const labels = [label, `${label}-fl`, `${label}-d`, `${label}-fl-d`];
  const rowsBy = (id: string) => { const d = [...readRows(`${label}-d`), ...readRows(`${label}-fl-d`)].filter((r) => r.id === id); return d.length ? d : [...readRows(label), ...readRows(`${label}-fl`)].filter((r) => r.id === id); };
  if (!ids.some((id) => rowsBy(id).length)) { log("（今回の答案が無い＝夜中に予約したか止まった。流れた後にもう一度 --run-plan で結果を出す＝使い回しで費用0）"); return; }
  // 前＝main の答案は流した後に読む（この実行で今の main の版の答えを作った時はそれを使う＝台帳の比べと同じ前）
  const before = buildMissMap(sub, (id) => mainRowsOf(sub.find((x) => x.id === id)!));
  const after = buildMissMap(sub, (id) => { const rs = rowsBy(id); return rs.length ? { rows: refreshPath(sub.find((x) => x.id === id)!, rs as RowLike[]), source: "今回" } : null; });
  const cmp = compareMissMaps(before, after);
  const tally = newTally();
  const unknown = after.entries.filter((e) => e.kinds.includes("合否の外れ（中身は不明）")).map((e) => e.id);
  let tri: TriageItem[] = [];
  if (!flag("no-triage") && unknown.length) {
    const gate = await llmGate("exam-conductor-triage");
    try { tri = await triageUnknown(unknown, (id) => rowsBy(id) as RowLite[], tally); } finally { await gate?.finish(); }
  }
  for (const t of tri) { const e = after.entries.find((x) => x.id === t.id); if (e) { e.kinds = e.kinds.map((k) => k === "合否の外れ（中身は不明）" ? t.kind : k); if (t.link && !e.links.includes(t.link)) e.links.push(t.link); } }
  if (tri.length) { after.byKind = {}; for (const e of after.entries) for (const k of e.kinds) after.byKind[k] = (after.byKind[k] ?? 0) + 1; }
  const next = nextFocus(after, cmp);
  printMissMap(after, `今回 ${label}`);
  log(`前（main の答案）と並べる（型: 前→今）: ${cmp.kinds.map((k) => `${k.kind} ${k.before}→${k.after}`).join("・") || "外れなし"}`);
  log(`直った ${cmp.fixed.length}（${cmp.fixed.join(",") || "-"}）・壊れた ${cmp.broke.length}（${cmp.broke.join(",") || "-"}）・同じ ${cmp.same}`);
  for (const t of tri) log(`  読み手の振り分け ${t.id}: ${t.kind}${t.link ? `・${t.link}` : ""}${t.missing.length ? `・抜け: ${t.missing.join("／")}` : ""}`);
  log(`次の重点の候補（次の --conduct の材料）: ${next.map((n) => `${n.id}（${n.why}）`).join("・") || "なし"}`);
  if (tally.calls) log(`読み手（振り分け）の費用: ${tally.calls}回 $${tally.usd.toFixed(4)}`);
  const js = labels.map(readCostTier).reduce((s, c) => ({ any: s.any || c.any, machine: s.machine + c.machine, flash: s.flash + c.flash, pro: s.pro + c.pro, proCalls: s.proCalls + c.proCalls, flashCalls: s.flashCalls + c.flashCalls }), { any: false, machine: 0, flash: 0, pro: 0, proCalls: 0, flashCalls: 0 });
  if (js.any) log(`判定の段: 機械で決めた ${js.machine}項目・flash で揃った ${js.flash}項目・割れて pro ${js.pro}項目（flash ${js.flashCalls}回・pro ${js.proCalls}回）`);
  log(`保存: ${saveResult({ label, at: new Date().toISOString(), planLabel: sp.label, compare: cmp, next, triage: tri, llm: tally })}`);
}
function readCostTier(label: string): { any: boolean; machine: number; flash: number; pro: number; proCalls: number; flashCalls: number } {
  try {
    const j = JSON.parse(readFileSync(join(RESULTS_DIR, `${label}.cost.json`), "utf8")) as { judge?: { tier?: { machine?: number; flash?: number; pro?: number; proCalls?: number; flashCalls?: number } } };
    const t = j.judge?.tier;
    return t ? { any: true, machine: t.machine ?? 0, flash: t.flash ?? 0, pro: t.pro ?? 0, proCalls: t.proCalls ?? 0, flashCalls: t.flashCalls ?? 0 } : { any: false, machine: 0, flash: 0, pro: 0, proCalls: 0, flashCalls: 0 };
  } catch { return { any: false, machine: 0, flash: 0, pro: 0, proCalls: 0, flashCalls: 0 }; }
}

// 2026-10-20 --range の版がこの倉庫に無い（別の倉庫の commit 等）時は、お金を使う前に分かる言葉で止める（前は RAG の選びが落ちて「安全側で全部」になっていた）
const checkRange = () => { if (arg("range")) verifyRange(arg("range"), "."); };
// 2026-10-22 AIX の文の段（押した後の1通目・2通目・✨この会話に合った文を本番の入口で作り、竹内さんが送った文と比べる）: scripts/exam-aix-text.ts を子で回す
//   --aix-text の後ろ（-- の後ろ）はそのまま渡す。例: exam-brain.ts --aix-text -- --label=fix1 --switch=AIX_TAKEUCHI_FORM=off
async function aixText(): Promise<void> {
  const env = { ...process.env };
  for (const [k, v] of ENV_FP.pairs) env[k] = v;
  const code = await new Promise<number>((res) => { const c = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "--env-file=.env.local", "scripts/exam-aix-text.ts", ...SWITCH_ARGS, ...PASS].map(q), { stdio: "inherit", env, shell: process.platform === "win32" }); c.on("error", () => res(1)); c.on("close", (n) => res(n ?? 1)); });
  if (code) process.exitCode = code;
}
const main0 = flag("aix-text") ? aixText : flag("spend-today") ? spendToday : flag("conduct") ? conduct : args.some((x) => /^--run-plan(=|$)/.test(x)) ? runPlan : flag("miss-map") ? showMissMap : flag("coverage") ? showCoverage : flag("ledger") ? async () => showLedger() : flag("cleanup") ? cleanup : flag("run-queue") ? runQueue : flag("warm-main") ? warmMain : flag("model-check") ? modelCheck : runMain;
const main = async () => { checkRange(); await main0(); };
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
