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
//   予約を流す: npx tsx --env-file=.env.local scripts/exam-brain.ts --run-queue（安い時間に。タスクスケジューラ等から）
//   台帳:       npx tsx scripts/exam-brain.ts --ledger [--id=q153] [--days=14]
//   モデル比べ: npx tsx --env-file=.env.local scripts/exam-brain.ts --model-check --conv=YUMA4 [--types=待って・閉じる] [--n=8]
//   片付け:     npx tsx --env-file=.env.local scripts/exam-brain.ts --cleanup --conv=YUMA2 --label=dg1016-a [--from=<作業ツリー>] [--apply]
// 決める事の引数（既定は試験のブレインが決める）:
//   --when=auto|now|night（auto: 最後の関所・見込み $1 以上は安い時間 JST 1:30〜9:30 に予約）・--wait（予約の代わりにその時間まで待って流す）
//   --max-reps=3・--no-early-stop・--stop-worse=3・--no-reuse・--judge=lazy|full（既定 lazy）・--judge-prefix=as-is|rubric（既定 as-is）
//   --model=pro|flash|auto（既定 pro・auto は model-check で道が同じだった型だけ flash）・--replay=strict・--select-n=12・--only=（範囲を絞る）
//   -- の後ろは brain-exam.ts にそのまま渡す
// 10/17 竹内さん「1 2 3 順に改善」「1日に上限は10ドル」:
//   --phase=auto|small|final|off（既定 auto・EXAM_PHASE）: 直しの途中は小さな確かめ（5〜8問・繰り返し2回まで）→ 同じ版で通ったら仕上げ（選んだ問題全部）。off＝旧
//   EXAM_DAILY_CAP_USD=10（off で無し）: 今日（JST）の試験 env の費用＋見込みが超えたら守る線を今・残りを夜中（--over-cap で全部今）
//   2倍の時間（平日 JST 10〜13・15〜19）は警告・仕上げは夜中に。EXAM_REUSE_CONV=off＝会話を見ずに使い回す（旧）
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  mergePicks, firstReps, confirmTargets, draftTargets, compareProblem, brainChangedOf, stopDecision, decideWhen, isCheapWindow, reuseKey, kbKeyOf, canReuse, dbKeyOf,
  modelOf, estimateUsd, DEFAULT_STOP, type PlanProblem, type Pick, type Cmp, type RowLite, type PlanItem, type When, type ChangeClass, type FlakeKind, type DbPart,
  decidePhase, pickSmall, SMALL_MAX_REPS, convKeyOf, dailyCapUsd, capSplit, nextNightRun, peakAdvice, UNIT_USD, type Phase,
} from "./lib/exam-brain";
import {
  loadExamProblems, workingScopeKeys, readReuse, writeReuse, appendLedger, readLedger, readRows, readCost, weakSpotProblems, enqueue, readQueue, dequeue,
  planCleanup, runCleanup, readDbFingerprint, dbTablesOf, EXAM_BRAIN_DIR, MODEL_CHECK_FILE, RESULTS_DIR, type AnyProblem, type LedgerLine,
  readPhaseLog, appendPhaseLog, readDailySpend, readConvContexts,
} from "./lib/exam-brain-io";
import { decideStageFromDiff } from "./lib/exam-scope";
import { problemHash, examConfig, configHash } from "./lib/brain-exam-baseline";
import { flakeVerdict, readObs, FLAKE_DIR } from "./lib/exam-flake";
import { isDeepseekPeakAt } from "../app/lib/llm-price";

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
const PHASE_ARG = arg("phase") || process.env.EXAM_PHASE || "auto";
const JUDGE = arg("judge", "lazy") === "full" ? "full" : "lazy";
// 2026-10-17 確かめ: rubric の並べ替えは判定の答えを変える（q113 の下書き 2/3→0/3）＝既定は旧の並び（as-is）。rubric は別に比べてから
const JUDGE_PREFIX = arg("judge-prefix", "as-is") === "rubric" ? "rubric" : "as-is";
const REPLAY = arg("replay") === "strict" ? "--replay=strict" : "--replay";
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
  db: { parts: DbPart[] | null; brain: string | null; draft: string | null };
  /** 10/17 ① 小さな確かめ／仕上げ／旧。allPicks＝仕上げで流す問題（今の選び全部）・versionKey＝同じ版か（効くファイル・道具・構成・DB の鍵） */
  phase: Phase; phaseWhy: string; allPicks: Pick[]; repsCap: number; versionKey: string;
  /** 10/17 ③ 会話の鍵（"-"＝会話の違いは答えに効かない・null＝読めない＝使い回さない） */
  conv: { key: string | null; why: string };
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
      const r = await ragSelect(sb, scope as never, { stageOf: stageOfAuto as never, topN: Math.max(1, Number(arg("select-n", "12")) || 12), extraQuery: arg("select-q") || undefined });
      rag = r; cls = r.decision.cls; clsNote = r.decision.note; ragNote = `${r.mode === "all" ? "全部" : `RAG ${r.picked.length}/${scope.length}問`}${r.note ? `・${r.note}` : ""}・変わったファイル ${r.decision.files.length}・知見の変化 ${r.kbChanged}`;
    } catch (e) { ragNote = `RAG の選びが失敗 → 安全側で全部（${String(e instanceof Error ? e.message : e).slice(0, 120)}）`; rag = null; const d = decideStageFromDiff("."); cls = d.cls; clsNote = d.note; }
  }
  let links: Record<string, Array<{ kbId: string; kind: string; score: number }>> = {};
  let kbNow: Record<string, string> | null = null;
  try { const st = await import("./lib/exam-rag-store"); links = await st.loadLinks(sb) as never; const { kbHashMap } = await import("./lib/exam-rag-run"); kbNow = kbHashMap(await st.loadKbRows(sb)); } catch (e) { log(`（知見の紐付けが読めない: ${String(e).slice(0, 100)}）`); }
  const weak = GATE ? {} : weakSpotProblems(links);
  const allPicks = mergePicks(scope as PlanProblem[], rag, { gate: GATE, named: list("name"), weakSpotProblems: weak });
  // 2. 何回・6. 使い回し・8. モデル
  const keys = workingScopeKeys(".");
  // 6. 使い回しの鍵に DB の中身（穴③）: ブレインと下書きが読む表の指紋を1回だけ読む（読むだけ）。--no-reuse の時は読まない
  const dbParts = flag("no-reuse") ? null : await readDbFingerprint(sb).catch((e) => { log(`（DB の指紋が読めない → 使い回さない: ${String(e).slice(0, 100)}）`); return null; });
  const db = { parts: dbParts, brain: dbKeyOf(dbParts, dbTablesOf("brain")), draft: dbKeyOf(dbParts, dbTablesOf("draft")) };
  const cfgHash = configHash(examConfig(process.env, { judge: JUDGE, judgePrefix: JUDGE_PREFIX, layer: "prod", ledger: true, repeat: MAX_REPS, exhaustedRule: EXHAUSTED_RULE }));
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
  const modelMode = (arg("model", "pro") as "pro" | "flash" | "auto");
  const items: Plan["items"] = new Map();
  for (const pk of picks) {
    const p = probs.get(pk.id)!;
    const model = modelOf(p as PlanProblem, { mode: modelMode, flashOkTypes: mc.okTypes, gate: GATE });
    const modelLabel = model === "flash" ? `deepseek-all:${FLASH_MODEL}` : "deepseek-all";
    const fv = flakeVerdict(readObs(p.id), { problemHash: problemHash(p), model: modelLabel });
    const reps = firstReps(fv.verdict, repsCap, { gate: GATE });
    const hash = problemHash(p);
    const kbKey = kbKeyOf(links[p.id], kbNow);
    const convKey = conv.key ?? "-";
    const key = reuseKey({ problemHash: hash, stage: "brain", scopeKey: keys.brain, toolKey: keys.tool, cfgHash, model: modelLabel, kbKey, dbKey: db.brain ?? "-", convKey });
    const draftKey = reuseKey({ problemHash: hash, stage: "draft", scopeKey: keys.draft, toolKey: keys.tool, cfgHash, model: modelLabel, kbKey, dbKey: db.draft ?? "-", convKey });
    const reuse = !flag("no-reuse") && !!db.brain && conv.key !== null && canReuse(readReuse(p.id, key), key, reps);
    items.set(p.id, { id: p.id, reps, draft: false, reuse, model, why: pk.why, stage1: "brain", draftWhy: "", flake: fv.verdict, flakeWhy: fv.why, key, draftKey, hash });
  }
  // 3. どこまで（下書きの見込み）
  const pl = scope.filter((p) => items.has(p.id)) as PlanProblem[];
  const dAll = draftTargets(cls, pl, new Set(pl.map((p) => p.id)), { gate: GATE });
  const draftMode: "all" | "if-changed" | "none" = GATE || cls === "draft" || cls === "both" ? "all" : dAll.ids.length ? "if-changed" : "none";
  const draftPlan = { ids: draftMode === "all" ? dAll.ids : [], why: draftMode === "all" ? dAll.why : "ブレインの判断が前（main）と変わった問題だけ（1段目の後に決める）", mode: draftMode };
  for (const id of draftPlan.ids) { const it = items.get(id); if (it) { it.draft = true; it.draftWhy = draftPlan.why; } }
  return { label, cls, clsNote, picks, items, probs, draftPlan, keys, cfgHash, ragNote, db, phase: ph.phase, phaseWhy: ph.why, allPicks, repsCap, versionKey, conv };
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
  if (x.budget) {
    const b = x.budget, s = b.split;
    log(`1日の上限: ${b.cap === null ? "なし（EXAM_DAILY_CAP_USD=off）" : `今日の使用額 ${b.used ? `$${b.used.usd.toFixed(2)}（JST ${jst(now).slice(5, 10)}・試験 env の DeepSeek＋Claude ${b.used.rows}行）` : `読めない（${b.usedErr ?? ""}）＝上限まで使った物として数える`}・上限 $${b.cap}・この実行の見込み $${((s?.estNow ?? 0) + (s?.estLater ?? 0)).toFixed(2)}`}${s ? ` → ${s.why}` : ""}`);
    if (s && s.later.length) log(`  夜中に回す ${s.later.length}問（JST ${jst(nextNightRun(now)).slice(5)} の --run-queue）: ${s.later.join(",")}`);
  }
  if (x.when) log(`いつ: ${x.when}`);
  log(`変わった所: ${pl.cls === "both" ? "ブレインと下書きの両方" : pl.cls === "brain" ? "ブレインだけ" : pl.cls === "draft" ? "下書きだけ" : "試験に効く変更なし"}${pl.clsNote ? `（${pl.clsNote}）` : ""}${pl.ragNote ? `・選び: ${pl.ragNote}` : ""}`);
  log(`効く所の鍵: ブレイン ${pl.keys.brain}・下書き ${pl.keys.draft}・試験の道具 ${pl.keys.tool}・構成 ${pl.cfgHash}・判定 ${JUDGE}/${JUDGE_PREFIX}`);
  const bad = (pl.db.parts ?? []).filter((x) => !x.ok);
  log(`DB の指紋（使い回しの鍵）: ${pl.db.parts ? `${pl.db.parts.length}表・ブレイン ${pl.db.brain ?? "読めない表あり"}・下書き ${pl.db.draft ?? "読めない表あり"}${bad.length ? `（読めない: ${bad.map((x) => `${x.table}＝${x.why ?? ""}`).join("／")} → その段は使い回さない）` : ""}` : "読まない（--no-reuse か読めない）＝使い回さない"}`);
  log(`問題 ${its.length}問（使い回し ${its.filter((x) => x.reuse).length}・揺れる ${its.filter((x) => x.flake === "flaky").length}・flash ${its.filter((x) => x.model === "flash").length}）`);
  for (const it of its) log(`  ${it.reuse ? "♻" : "▶"} ${it.id} [${pl.probs.get(it.id)?.type}] 回 ${it.reps}${it.flake === "flaky" ? "（揺れる）" : ""}・段 ブレイン${it.draft ? "→下書き" : pl.draftPlan.mode === "if-changed" && draftEligibleOf(pl, it.id) ? "（判断が変われば下書き）" : ""}${it.model === "flash" ? "・flash" : ""}${it.reuse ? "・前の結果を使う（使う物が同じ）" : ""} ← ${it.why.slice(0, 3).join("／")}`);
  log(`段: 1段目＝全部をブレインの判断まで（stage=brain）／2段目＝${pl.draftPlan.mode === "all" ? `下書きまで ${pl.draftPlan.ids.length}問（${pl.draftPlan.why}）` : pl.draftPlan.mode === "if-changed" ? `判断が前と変わった問題だけ下書きまで（最大 ${ifChangedMax}問）` : "下書きなし"}`);
  log(`途中で止める: ${flag("no-early-stop") ? "しない" : `最初の ${DEFAULT_STOP.minSeen}問以上で前より悪い問題が ${Number(arg("stop-worse", String(DEFAULT_STOP.worseN)))}問（揺れる問題は数えない）`}・前と違った問題は確かめに ${pl.repsCap}回まで足す（はっきり良い時は良くなった・悪くなった問題だけ）`);
  log(`見込みの費用（今の側・${peak ? "混雑時の値段込み" : "通常の値段"}）: 約 $${est.now.toFixed(2)}＋判断が変わった問題の下書き 最大 $${(ifChangedMax * 0.015 * (peak ? 1.6 : 1)).toFixed(2)}／前（main）の取り置きが無い問題は main でも回す（1問 約 $0.03・夜中の --warm-main で作っておけば0）`);
}
function draftEligibleOf(pl: Plan, id: string): boolean { const p = pl.probs.get(id); return !!p && [...(p.accept ?? []), ...(((p.acceptWhen as { searchExhausted?: string[] } | undefined)?.searchExhausted) ?? [])].some((a) => !a.startsWith("AIX")); }
function readModelCheck(): { okTypes: Set<string>; byType: Record<string, { n: number; samePath: number; proOk: number; flashOk: number }> } {
  try { const j = JSON.parse(readFileSync(MODEL_CHECK_FILE, "utf8")) as { byType: Record<string, { n: number; samePath: number; proOk: number; flashOk: number }> }; return { byType: j.byType, okTypes: new Set(Object.entries(j.byType).filter(([, v]) => v.n >= 3 && v.samePath / v.n >= 0.9 && v.flashOk >= v.proOk).map(([k]) => k)) }; }
  catch { return { okTypes: new Set(), byType: {} }; }
}

// ─── 1つの段を流す（使い回し → 子 → 途中で止める → 確かめの回） ─────────────────────────
type PhaseResult = { label: string; ids: string[]; cmps: Array<{ id: string; cmp: Cmp; why: string }>; baseLabels: string[]; mainLabels: string[]; stopped: boolean; stopWhy: string; confirm: string[] };
async function runPhase(pl: Plan, stage: "brain" | "draft", ids: string[], label: string, model: "pro" | "flash"): Promise<PhaseResult> {
  const res: PhaseResult = { label, ids, cmps: [], baseLabels: [], mainLabels: [], stopped: false, stopWhy: "", confirm: [] };
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
    ...(JUDGE === "lazy" ? ["--judge=lazy"] : []), ...(JUDGE_PREFIX === "rubric" ? ["--judge-prefix=rubric"] : []), ...(CONV ? [`--conv=${CONV}`] : []), ...PASS,
  ];
  const env: Record<string, string> = { EXAM_STOP_FILE: stopFile, ...(model === "flash" ? { DEEPSEEK_MODEL: FLASH_MODEL, EXAM_JUDGE_MODEL: PRO_MODEL } : {}) };
  if (!CONV && !process.env.REPLAY_FLOOR_FILE) env.REPLAY_FLOOR_FILE = `scripts/.replay-out/brain-exam-floor-${label}.json`;
  // 5. 途中で止める（1段目の最初の数問）
  const stopWorse = Number(arg("stop-worse", String(DEFAULT_STOP.worseN)));
  const watch = async (o: ChildOut) => {
    if (flag("no-early-stop") || res.stopped || !o.baseLabels.length) return;
    const cmps = compareAll(ids, label, o.baseLabels).filter((c) => c.cmp !== "nocur");
    const d = stopDecision(cmps, flaky, { ...DEFAULT_STOP, worseN: stopWorse });
    if (d.action === "stop") { writeFileSync(stopFile, JSON.stringify({ at: new Date().toISOString(), why: d.why, worse: d.worse })); res.stopped = true; res.stopWhy = d.why; log(`\n⏹ 試験のブレイン: ${d.why} → 止める（悪化: ${d.worse.join(",")}）`); }
  };
  const o1 = await runBrainExam(baseArgs(ids), env, watch);
  res.baseLabels = o1.baseLabels; res.mainLabels = o1.mainLabels;
  // 2026-10-17 確かめる人: brain-exam は「前」の結果ファイル（<baseLabel>.jsonl）を --only の問題だけで毎回書き直す＝確かめの回（--only=前と違った問題）の後に
  //   読み直すと他の問題が全部「前が無い（nobase）」になり、2段目の下書きが全部の候補になっていた。1回目の「前」を控え、確かめの回の分だけ差し替える
  let baseRows: RowLite[] = res.baseLabels.flatMap((b) => readRows(b));
  res.cmps = compareAll(ids, label, res.baseLabels, baseRows);
  if (o1.code !== 0) log(`⚠ brain-exam が ${o1.code} で終わった（取れた問題だけ比べる）`);
  if (res.stopped) return res;
  // 2. 確かめの回: 1回目が前と違った問題（揺れか本当の変化か）を max 回まで。はっきり良い時は良くなった・悪くなった問題だけ
  const d = stopDecision(res.cmps, flaky);
  const conf = pl.repsCap <= 1 ? [] : confirmTargets(res.cmps, new Set(ids.filter((id) => pl.items.get(id)!.reps >= pl.repsCap)), { clearlyGood: d.action === "fewer" });
  if (conf.length) {
    log(`\n🔁 確かめの回（前と違った ${conf.length}問 を ${pl.repsCap}回まで${pl.phase === "small" ? "・小さな確かめ＝繰り返し最小" : ""}${d.action === "fewer" ? "・はっきり良いので判断だけ変わった問題は省く" : ""}）: ${conf.join(",")}`);
    for (const id of conf) pl.items.get(id)!.reps = pl.repsCap;
    writeReps(Object.fromEntries(ids.map((id) => [id, pl.items.get(id)!.reps])));
    const o2 = await runBrainExam(baseArgs(conf), env);
    res.baseLabels = [...new Set([...res.baseLabels, ...o2.baseLabels])]; res.mainLabels = [...new Set([...res.mainLabels, ...o2.mainLabels])];
    const b2 = o2.baseLabels.flatMap((b) => readRows(b)).filter((r) => conf.includes(r.id));
    const got = new Set(b2.map((r) => r.id));
    baseRows = [...baseRows.filter((r) => !got.has(r.id)), ...b2];
    res.cmps = compareAll(ids, label, res.baseLabels, baseRows);
    res.confirm = conf;
  }
  return res;
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
      reps: ok.length, codes: [...new Set(ok.map((r) => String(r.path?.code ?? "")))], pathOk: maj((r) => !!r.path?.ok), pass: maj((r) => !!r.score?.pass), cmp: c.cmp, cmpWhy: c.why, flake: it.flake, reused, verdict: verdictOf(id, c.cmp, ok, it.flake === "flaky") });
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
  if (!w.runNow) {
    if (flag("wait")) { log(`安い時間まで待つ（--wait）…`); while (Date.now() < w.at.getTime()) await sleep(Math.min(10 * 60_000, w.at.getTime() - Date.now() + 1000)); }
    else {
      const f = enqueue({ label, argv: [...args.filter((a) => !/^--(when|phase)=/.test(a)), "--when=now", ...(pl.phase !== "off" ? [`--phase=${pl.phase}`] : []), ...(PASS.length ? ["--", ...PASS] : [])], cwd: process.cwd(), at: w.at.toISOString(), createdAt: now.toISOString(), estUsd: est.now });
      log(`予約した: ${f}\n  安い時間に流す: npx tsx --env-file=.env.local scripts/exam-brain.ts --run-queue（タスクスケジューラ SumoraExamNight が JST 1:40 に。今すぐなら --when=now）`);
      return;
    }
  }
  // ② 上限を超える分は夜中の予約に回す（止めて終わりにしない）。--wait で待った時はここで数える
  const split = (budget ?? await budgetOf(pl, pricePeak(pl, new Date()), new Date())).split;
  if (!budget && split) log(`1日の上限: ${split.why}`);
  if (split && split.later.length) {
    const keep = (a: string) => !/^--(when|only|name|select-q|select-n|select|types|phase|label|plan)(=|$)/.test(a);
    const f = enqueue({ label: `${label}-n`, argv: [...args.filter(keep), `--only=${split.later.join(",")}`, "--phase=final", "--when=now", `--label=${label}-n`, ...(PASS.length ? ["--", ...PASS] : [])], cwd: process.cwd(), at: nextNightRun(now).toISOString(), createdAt: now.toISOString(), estUsd: split.estLater });
    log(`上限: 夜中に回した ${split.later.length}問（${jst(nextNightRun(now))} JST・見込み $${split.estLater.toFixed(2)}・翌日の分として数える）: ${f}`);
    for (const id of split.later) pl.items.delete(id);
    pl.picks = pl.picks.filter((p) => pl.items.has(p.id));
    pl.draftPlan.ids = pl.draftPlan.ids.filter((id) => pl.items.has(id));
    if (!pl.items.size) { log("今流す問題は無い（全部夜中）"); return; }
  }
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
    const dt = draftTargets(pl.cls, g.ids.map((id) => pl.probs.get(id)!) as PlanProblem[], changed, { gate: GATE });
    log(`\n2段目（下書きまで）: ${dt.ids.length}問 — ${dt.why}${dt.ids.length ? `（${dt.ids.join(",")}）` : ""}`);
    const b = await runPhase(pl, "draft", dt.ids, `${lb}-d`, g.model);
    phases.push(b); ledger.push(...finishPhase(pl, b, "draft", g.model, head));
  }
  appendLedger(ledger);
  // 報告
  const by = (c: Cmp) => ledger.filter((l) => l.cmp === c);
  log(`\n=== 試験のブレインの結果（${label}）===`);
  for (const ph of phases) {
    const st = ledger.filter((l) => l.label === ph.label);
    log(`${ph.label}: ${st.length}問・道 ${st.filter((l) => l.pathOk).length}・合格 ${st.filter((l) => l.pass).length}・前より悪い ${st.filter((l) => l.cmp === "worse").length}・良い ${st.filter((l) => l.cmp === "better").length}・判断だけ変わった ${st.filter((l) => l.cmp === "changed").length}・turn_contract の形だけ変わった ${st.filter((l) => l.cmp === "shape").length}・前が無い ${st.filter((l) => l.cmp === "nobase").length}${ph.stopped ? `・止めた（${ph.stopWhy}）` : ""}${ph.confirm.length ? `・確かめた ${ph.confirm.length}` : ""}`);
  }
  for (const l of by("worse")) log(`  ✕ 悪化 ${l.id}[${l.stage}] ${l.cmpWhy}・${l.verdict === "real" ? "本当の悪化（確かめの回でも同じ）" : l.verdict === "flake" ? "揺れ（回で割れた・揺れる問題）" : "1回だけ（確かめていない）"}`);
  for (const l of by("better")) log(`  ○ 良くなった ${l.id}[${l.stage}] ${l.cmpWhy}・${l.verdict ?? ""}`);
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
  log(`費用（この実行・llm_usage_logs の ${labels.length}つの route）: ${sp.n}回 $${sp.usd.toFixed(3)}＋判定 ${judge.n}回 $${judge.usd.toFixed(3)}`);
  log(`台帳: ${ledger.length}行（npx tsx scripts/exam-brain.ts --ledger --id=<問題>）`);
}

// ─── 予約を流す ─────────────────────────────────────────────────────────
async function runQueue() {
  const now = new Date();
  const due = readQueue().filter((x) => Date.parse(x.at) <= now.getTime());
  if (!due.length) { log("予約: 流す物が無い"); return; }
  if (!isCheapWindow(now) && !flag("force")) { log(`今は安い時間ではない（JST 1:30〜9:30）→ 流さない（--force で流す）`); return; }
  for (const x of due) {
    log(`予約を流す: ${x.label}（${x.createdAt} に予約・見込み $${x.estUsd.toFixed(2)}）`);
    // 2026-10-17 確かめる人: 予約した作業ツリーが消えていると spawn が error で落ち、後ろの予約も流れない＝飛ばす
    if (!existsSync(x.cwd)) { log(`  予約した作業ツリーが無い（${x.cwd}）→ 飛ばす`); dequeue(x.file); continue; }
    dequeue(x.file);
    // EXAM_FROM_QUEUE: 夜中の予約の実行＝上限を超える時も収まる分だけ流す（capSplit の fill）
    await new Promise<void>((res) => { const ch = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "--env-file=.env.local", "scripts/exam-brain.ts", ...x.argv].map(q), { cwd: x.cwd, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, EXAM_FROM_QUEUE: "1" } }); ch.on("error", (e) => { log(`  流せない: ${String(e).slice(0, 120)}`); res(); }); ch.on("close", () => res()); });
  }
}

// ─── 本番に入れた版の答えを取り置く ───────────────────────────────────────────
async function warmMain() {
  const now = new Date();
  const w = decideWhen({ when: (arg("when", "night") as When), estUsd: 99, gate: true, now });
  if (!w.runNow) {
    if (!flag("wait")) { const f = enqueue({ label: `warm-${jst(now).slice(5, 10)}`, argv: [...args.filter((a) => !/^--when=/.test(a)), "--when=now"], cwd: process.cwd(), at: w.at.toISOString(), createdAt: now.toISOString(), estUsd: 0 }); log(`取り置きを予約した（${jst(w.at)} JST から）: ${f}`); return; }
    while (Date.now() < w.at.getTime()) await sleep(Math.min(10 * 60_000, w.at.getTime() - Date.now() + 1000));
  }
  const { spec, full } = loadExamProblems();
  const types = list("types");
  const ids = spec.filter((p) => !types.length || types.includes(p.type)).map((p) => p.id);
  const reps = Object.fromEntries(ids.map((id) => { const p = effective((full.get(id) ?? spec.find((s) => s.id === id)!) as AnyProblem); return [id, firstReps(flakeVerdict(readObs(id), { problemHash: problemHash(p), model: "deepseek-all" }).verdict, MAX_REPS, { gate: true })]; }));
  // 10/17 ② 1日の上限: 取り置きも数える（守る線は無い＝超えるなら次の夜中に回す）
  const cap = dailyCapUsd(process.env);
  if (cap !== null && !flag("over-cap")) {
    const estW = Object.values(reps).reduce((s, n) => s + n * UNIT_USD.brain, 0) * (isDeepseekPeakAt(new Date()) ? UNIT_USD.peakRatio : 1);
    const used = await readDailySpend(sb).then((x) => x.usd).catch(() => cap);
    if (used + estW > cap) {
      const at = nextNightRun(new Date());
      const f = enqueue({ label: `warm-${jst(at).slice(5, 10)}`, argv: [...args.filter((a) => !/^--when=/.test(a)), "--when=now"], cwd: process.cwd(), at: at.toISOString(), createdAt: new Date().toISOString(), estUsd: estW });
      log(`取り置き: 今日 $${used.toFixed(2)}＋見込み $${estW.toFixed(2)} ＞ 上限 $${cap} → 次の夜中（${jst(at)} JST）に回した: ${f}`);
      return;
    }
  }
  mkdirSync(join(EXAM_BRAIN_DIR, "run"), { recursive: true });
  const repsFile = resolve(join(EXAM_BRAIN_DIR, "run", `warm-${Date.now().toString(36)}.reps.json`));
  writeFileSync(repsFile, JSON.stringify(reps));
  for (const stage of (arg("stage") ? [arg("stage")] : ["brain"])) {
    const label = `warm-${Date.now().toString(36)}-${stage}`;
    await runBrainExam([`--label=${label}`, `--only=${ids.join(",")}`, `--stage=${stage}`, "--baseline=main", "--baseline-only", REPLAY, `--repeat=${MAX_REPS}`, `--reps-file=${repsFile}`,
      ...(JUDGE === "lazy" ? ["--judge=lazy"] : []), ...(JUDGE_PREFIX === "rubric" ? ["--judge-prefix=rubric"] : []), ...(CONV ? [`--conv=${CONV}`] : []), ...PASS], CONV ? {} : { REPLAY_FLOOR_FILE: `scripts/.replay-out/brain-exam-floor-${label}.json` });
  }
}

// ─── 8. モデルの比べ（flash で質が落ちないか・型ごと） ───────────────────────────────
async function modelCheck() {
  const { spec, full } = loadExamProblems();
  const types = list("types"), only = list("only");
  const n = Math.max(1, Number(arg("n", "8")) || 8);
  let ps = spec.filter((p) => (!only.length || only.includes(p.id)) && (!types.length || types.includes(p.type)));
  if (!only.length) { const c = new Map<string, number>(); ps = ps.filter((p) => { const k = c.get(p.type) ?? 0; if (k >= Math.ceil(n / Math.max(1, new Set(ps.map((x) => x.type)).size))) return false; c.set(p.type, k + 1); return true; }).slice(0, n); }
  const ids = ps.map((p) => p.id);
  const label = arg("label") || `mc-${Date.now().toString(36)}`;
  const common = (lb: string) => [`--label=${lb}`, `--only=${ids.join(",")}`, "--stage=brain", REPLAY, "--repeat=1", ...(JUDGE === "lazy" ? ["--judge=lazy"] : []), ...(CONV ? [`--conv=${CONV}`] : [])];
  const fl = (lb: string): Record<string, string> => (CONV ? {} : { REPLAY_FLOOR_FILE: `scripts/.replay-out/brain-exam-floor-${lb}.json` });
  log(`モデルの比べ: ${ids.length}問（${ids.join(",")}）を pro と flash のブレインで（判定はどちらも pro）`);
  const since = new Date().toISOString();
  await runBrainExam(common(`${label}-pro`), fl(`${label}-pro`));
  await runBrainExam(common(`${label}-flash`), { ...fl(`${label}-flash`), DEEPSEEK_MODEL: FLASH_MODEL, EXAM_JUDGE_MODEL: PRO_MODEL });
  const a = readRows(`${label}-pro`), b = readRows(`${label}-flash`);
  const prev = existsSync(MODEL_CHECK_FILE) ? JSON.parse(readFileSync(MODEL_CHECK_FILE, "utf8")) as { byType: Record<string, { n: number; samePath: number; proOk: number; flashOk: number }>; runs?: unknown[] } : { byType: {}, runs: [] };
  const lines: string[] = [];
  for (const id of ids) {
    const x = a.find((r) => r.id === id && !r.error), y = b.find((r) => r.id === id && !r.error);
    if (!x || !y) { lines.push(`  ${id}: 片方が無い`); continue; }
    const t = String(full.get(id)?.type ?? spec.find((s) => s.id === id)?.type ?? "");
    const e = prev.byType[t] ?? { n: 0, samePath: 0, proOk: 0, flashOk: 0 };
    e.n++; if (x.path?.code === y.path?.code) e.samePath++; if (x.path?.ok) e.proOk++; if (y.path?.ok) e.flashOk++;
    prev.byType[t] = e;
    lines.push(`  ${x.path?.code === y.path?.code ? "＝" : "≠"} ${id}[${t}] pro=${x.path?.code}${x.path?.ok ? "○" : "✕"} flash=${y.path?.code}${y.path?.ok ? "○" : "✕"}`);
  }
  (prev.runs ??= []).push({ at: since, label, ids });
  mkdirSync(EXAM_BRAIN_DIR, { recursive: true });
  writeFileSync(MODEL_CHECK_FILE, JSON.stringify(prev, null, 1));
  for (const l of lines) log(l);
  const sp = await spendOf([`${label}-pro`, `${label}-flash`], since).catch(() => ({ n: 0, usd: 0 }));
  const sa = await spendOf([`${label}-pro`], since).catch(() => ({ n: 0, usd: 0 })), sbb = await spendOf([`${label}-flash`], since).catch(() => ({ n: 0, usd: 0 }));
  log(`型ごと（累計）: ${Object.entries(prev.byType).map(([k, v]) => `${k} 道が同じ ${v.samePath}/${v.n}・合う pro ${v.proOk}/flash ${v.flashOk}`).join("／")}`);
  log(`flash にしてよい型（3問以上・道が同じ 9割以上・合う数が pro 以上）: ${[...readModelCheck().okTypes].join("・") || "まだ無い"}`);
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

const main = flag("ledger") ? async () => showLedger() : flag("cleanup") ? cleanup : flag("run-queue") ? runQueue : flag("warm-main") ? warmMain : flag("model-check") ? modelCheck : runMain;
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
