// scripts/lib/exam-brain.ts — 試験のブレイン（決める所を1か所に・純関数中心・LLM なし）
//
// 2026-10-17 竹内さん 10/16「判断する所はブレインにまとめて、質を高く節約する」（設計知見 4c91ffd9・P0）:
//   試験の回し方（どの問題・何回・どこまで・いつ・途中で止めるか・前の結果を使うか・採点・モデル・台帳）を、
//   決まりを重ねた引数の組み合わせではなく「試験のブレイン」1か所が決める。入口は scripts/exam-brain.ts（計画を先に出してから流す）。
//   LINE ブレインの決まりに倣う: 2段（まず判断＝stage=brain だけで全部・判断が前と変わった問題だけ下書き）・分析の省略（使う物が同じなら前の結果）・
//   深掘りは迷った時だけ（揺れる・前と違う問題だけ繰り返す）・台帳（どの問題がいつどの版でどうだったか）。
//   ここは決め方だけ（ファイル・DB・git は scripts/exam-brain.ts と exam-brain-io.ts）。単体テスト scripts/lib/__tests__/exam-brain.test.ts
import { createHash } from "node:crypto";
import { isDeepseekPeakAt } from "../../app/lib/llm-price";

export type PlanProblem = { id: string; type: string; tags?: string[]; accept?: string[]; acceptWhen?: { searchExhausted?: string[] }; stage?: string; addedAt?: string };
export type Pick = { id: string; why: string[]; must: boolean };

/** 必ず流す札（竹内さんのお手本・竹内さんの番）。設計知見: 削らない線 */
export const MUST_TAGS = ["お手本", "竹内さんの番"];

// ─── 1. どの問題 ───────────────────────────────────────────────────────
/**
 * 選びを1つにまとめる: RAG の選び（直したファイル・差分の言葉・変えた知見・前に落ちた・新しい問題・名指し）＋必ず流す物（名指し・お手本・毎日の弱い所）。
 *   gate（最後の関所）・RAG が「全部」と言った時は全部。必ず流す物は RAG が何を言っても入れる（守る線）。
 */
export function mergePicks(all: PlanProblem[], rag: { mode: "all" | "rag"; picked: Array<{ id: string; why: string[]; must: boolean }> } | null, o: {
  gate?: boolean; named?: string[]; weakSpotProblems?: Record<string, string[]>; mustTags?: string[];
}): Pick[] {
  const ids = new Set(all.map((p) => p.id));
  const why = new Map<string, { why: string[]; must: boolean }>();
  const add = (id: string, w: string, must: boolean) => { if (!ids.has(id)) return; const c = why.get(id) ?? { why: [], must: false }; if (!c.why.includes(w)) c.why.push(w); c.must = c.must || must; why.set(id, c); };
  if (o.gate) for (const p of all) add(p.id, "最後の関所（全部）", true);
  if (!rag) { if (!o.gate) for (const p of all) add(p.id, "選びが無い（安全側で全部）", true); }
  else for (const p of rag.picked) for (const w of p.why) add(p.id, w, p.must || rag.mode === "all");
  for (const id of o.named ?? []) add(id, "名指し", true);
  const tags = o.mustTags ?? MUST_TAGS;
  for (const p of all) for (const t of p.tags ?? []) if (tags.includes(t)) add(p.id, `竹内さんの${t === "お手本" ? "お手本" : "番"}（必ず）`, true);
  for (const [id, kbs] of Object.entries(o.weakSpotProblems ?? {})) add(id, `毎日拾った弱い所の知見 ${kbs.slice(0, 2).map((k) => k.slice(0, 8)).join("・")} に紐付く`, true);
  return all.filter((p) => why.has(p.id)).map((p) => ({ id: p.id, ...why.get(p.id)! }));
}

// ─── 2. 何回 ───────────────────────────────────────────────────────────
export type FlakeKind = "flaky" | "stable" | "unknown";
/**
 * 最初の回数。直しの確かめ（既定）は全部1回＝前（main）と同じ答えなら揺れを測る意味が無い（深掘りは迷った時だけ）。前と違った問題だけ後で max 回まで足す（confirmTargets）。
 *   最後の関所（gate）は揺れる問題だけ max（既定3）・それ以外は1回。
 *   2026-10-17 実測: 揺れる問題は 150問中 66問（44%）。直しの確かめで最初から3回にすると、今の1回の確かめより高くなる（1日の見込みが下がらない）
 */
export function firstReps(v: FlakeKind, max = 3, o: { gate?: boolean } = {}): number { return o.gate && v === "flaky" ? Math.max(1, max) : 1; }
/** 足して確かめる問題: 1回目が前（main）と違った問題（揺れか本当の変化かを分ける・揺れる問題も）。はっきり良い時は良くなった問題だけ。done＝もう max 回ある問題 */
export function confirmTargets(cmps: Array<{ id: string; cmp: Cmp }>, done: Set<string>, o: { clearlyGood?: boolean } = {}): string[] {
  return cmps.filter((c) => !done.has(c.id) && (o.clearlyGood ? c.cmp === "better" : c.cmp === "worse" || c.cmp === "better" || c.cmp === "changed")).map((c) => c.id);
}

// ─── 3. どこまで（2段） ─────────────────────────────────────────────────
/** 下書きを作る意味がある問題（正解に返信・約束の道がある＝brain-exam が下書きを作る条件と同じ） */
export function draftEligible(p: PlanProblem): boolean {
  return [...(p.accept ?? []), ...(p.acceptWhen?.searchExhausted ?? [])].some((a) => !a.startsWith("AIX"));
}
export type ChangeClass = "brain" | "draft" | "both" | "none";
/**
 * 下書きまで流す問題: 下書きに効くファイルを直した（draft・both）→ 下書きの意味がある全部の候補／ブレインだけ直した → 判断が前と変わった問題だけ／
 *   試験に効く変更なし → 判断が前と変わった問題だけ（無ければ0）。最後の関所も同じ決め方（全部の型を流すのは1段目）。
 */
export function draftTargets(cls: ChangeClass, ps: PlanProblem[], brainChanged: Set<string>, o: { gate?: boolean } = {}): { ids: string[]; why: string } {
  const el = ps.filter(draftEligible);
  // 2026-10-17: 関所も2段に倣う（下書きに効くファイルを直した時は全部・ブレインだけの直しは判断が変わった問題だけ）。o.gate は互換のため残す
  void o.gate;
  if (cls === "draft" || cls === "both") return { ids: el.map((p) => p.id), why: cls === "draft" ? "下書きに効くファイルを直した" : "ブレインと下書きの両方に効くファイルを直した" };
  const ids = el.filter((p) => brainChanged.has(p.id)).map((p) => p.id);
  return { ids, why: ids.length ? "ブレインの判断が前（main）と変わった問題だけ" : "判断が前と変わった問題が無い（下書きは前と同じ見込み）" };
}

// ─── 比べ（前＝main と今） ─────────────────────────────────────────────
export type RowLite = { id: string; rep: number; error?: string; path?: { code?: string; ok?: boolean }; score?: { pass?: boolean }; draft?: { code?: string; pass?: boolean; ok?: boolean } | null };
export type Cmp = "worse" | "better" | "same" | "changed" | "nobase" | "nocur";
const majority = (xs: boolean[]) => xs.filter(Boolean).length * 2 > xs.length;
/** 問題ごとの比べ: 道の過半数 → 合格の過半数 → 下書き（両方にある時）。道の符号の集まりが違えば changed（同じ合否でも判断が変わった） */
export function compareProblem(cur: RowLite[], base: RowLite[]): { cmp: Cmp; why: string } {
  const c = cur.filter((r) => !r.error), b = base.filter((r) => !r.error);
  if (!c.length) return { cmp: "nocur", why: "今の答案が無い" };
  if (!b.length) return { cmp: "nobase", why: "前（main）の答案が無い" };
  const cp = majority(c.map((r) => !!r.path?.ok)), bp = majority(b.map((r) => !!r.path?.ok));
  if (cp !== bp) return { cmp: cp ? "better" : "worse", why: `道 ${bp ? "○" : "✕"}→${cp ? "○" : "✕"}` };
  const cs = majority(c.map((r) => !!r.score?.pass)), bs = majority(b.map((r) => !!r.score?.pass));
  if (cs !== bs) return { cmp: cs ? "better" : "worse", why: `合格 ${bs ? "○" : "✕"}→${cs ? "○" : "✕"}` };
  const cd = c.filter((r) => r.draft), bd = b.filter((r) => r.draft);
  if (cd.length && bd.length) {
    const x = majority(cd.map((r) => !!r.draft?.pass)), y = majority(bd.map((r) => !!r.draft?.pass));
    if (x !== y) return { cmp: x ? "better" : "worse", why: `下書き ${y ? "○" : "✕"}→${x ? "○" : "✕"}` };
  }
  const codes = (rs: RowLite[]) => [...new Set(rs.map((r) => String(r.path?.code ?? "")))].sort().join("/");
  if (codes(c) !== codes(b)) return { cmp: "changed", why: `判断 ${codes(b)}→${codes(c)}（合否は同じ）` };
  return { cmp: "same", why: "同じ" };
}
/** 判断が前と変わった（下書きまで流す理由）＝道・合格・判断の符号のどれかが違う */
export function brainChangedOf(cmps: Array<{ id: string; cmp: Cmp }>): Set<string> {
  return new Set(cmps.filter((c) => c.cmp === "worse" || c.cmp === "better" || c.cmp === "changed" || c.cmp === "nobase").map((c) => c.id));
}

// ─── 5. 途中で止める ────────────────────────────────────────────────────
export type StopRule = { minSeen: number; worseN: number; betterN: number };
export const DEFAULT_STOP: StopRule = { minSeen: 4, worseN: 3, betterN: 3 };
/**
 * 最初の数問ではっきり悪化（道・合格が前より悪い問題が worseN 以上・良くなった数を worseN 以上上回る）→ 止める。
 *   はっきり良い（良くなった betterN 以上・悪化0）→ 確かめの繰り返しを減らす。どちらでもなければ続ける。
 *   揺れる問題の1回目は数えない（揺れで止めない）
 */
export function stopDecision(cmps: Array<{ id: string; cmp: Cmp }>, flaky: Set<string>, rule: StopRule = DEFAULT_STOP): { action: "stop" | "go" | "fewer"; why: string; worse: string[]; better: string[] } {
  const seen = cmps.filter((c) => c.cmp !== "nobase" && c.cmp !== "nocur" && !flaky.has(c.id));
  const worse = seen.filter((c) => c.cmp === "worse").map((c) => c.id), better = seen.filter((c) => c.cmp === "better").map((c) => c.id);
  if (seen.length >= rule.minSeen && worse.length >= rule.worseN && worse.length - better.length >= rule.worseN)
    return { action: "stop", why: `${seen.length}問中 ${worse.length}問が前より悪い（良くなった ${better.length}）＝はっきり悪化`, worse, better };
  if (seen.length >= rule.minSeen && better.length >= rule.betterN && !worse.length)
    return { action: "fewer", why: `${seen.length}問中 ${better.length}問が良くなり悪化0＝はっきり良い（確かめは良くなった問題だけ）`, worse, better };
  return { action: "go", why: `${seen.length}問: 悪化 ${worse.length}・良くなった ${better.length}`, worse, better };
}

// ─── 4. いつ ────────────────────────────────────────────────────────────
/**
 * DeepSeek の安い時間: 竹内さん 10/16「JST 1:30〜9:30」かつ app/lib/llm-price.ts の混雑時間（平日 JST 10-13・15-19 は2倍）でない時。
 *   2026-10-17 確かめた: llm-price は混雑の時間だけを持つ（1:30〜9:30 は混雑の外＝倍にならない）。両方を満たす所＝1:30〜9:30 を安い時間とする。
 */
export const CHEAP_WINDOW_JST = { startMin: 90, endMin: 570 };
const jstMin = (d: Date) => { const j = new Date(d.getTime() + 9 * 3600_000); return j.getUTCHours() * 60 + j.getUTCMinutes(); };
export function isCheapWindow(d: Date, w = CHEAP_WINDOW_JST): boolean { const m = jstMin(d); return m >= w.startMin && m < w.endMin && !isDeepseekPeakAt(d); }
/** 次の安い時間の始まり（今が安い時間ならそのまま） */
export function nextCheapStart(d: Date, w = CHEAP_WINDOW_JST): Date {
  if (isCheapWindow(d, w)) return d;
  const m = jstMin(d);
  const addMin = m < w.startMin ? w.startMin - m : 24 * 60 - m + w.startMin;
  const t = new Date(d.getTime() + addMin * 60_000);
  t.setUTCSeconds(0, 0);
  return t;
}
export type When = "now" | "night" | "auto";
/** 今すぐか予約か: night＝安い時間まで待つ／now＝今／auto＝最後の関所・大きい（見込み $bigUsd 以上）なら安い時間、小さければ今 */
export function decideWhen(o: { when: When; estUsd: number; gate?: boolean; now: Date; bigUsd?: number }): { runNow: boolean; at: Date; why: string } {
  const cheap = isCheapWindow(o.now);
  if (o.when === "now") return { runNow: true, at: o.now, why: cheap ? "今（安い時間）" : "今すぐ（--when=now）" };
  const big = !!o.gate || o.estUsd >= (o.bigUsd ?? 1);
  if (o.when === "auto" && !big) return { runNow: true, at: o.now, why: `小さい試験（見込み $${o.estUsd.toFixed(2)}）＝今すぐ` };
  if (cheap) return { runNow: true, at: o.now, why: "安い時間の中＝今すぐ" };
  const at = nextCheapStart(o.now);
  return { runNow: false, at, why: `${o.gate ? "最後の関所" : `大きい試験（見込み $${o.estUsd.toFixed(2)}）`}＝DeepSeek の安い時間（JST 1:30〜9:30）に予約` };
}

// ─── 6. 前の結果の使い回し ─────────────────────────────────────────────
/** 問題の結果の鍵＝この問題が使う物（問題の hash・段・効くファイルの中身の鍵・試験の道具の鍵・構成・モデル・紐付く知見の版） */
export function reuseKey(o: { problemHash: string; stage: "brain" | "draft"; scopeKey: string; toolKey: string; cfgHash: string; model: string; kbKey: string }): string {
  return createHash("sha256").update(JSON.stringify([o.problemHash, o.stage, o.scopeKey, o.toolKey, o.cfgHash, o.model, o.kbKey])).digest("hex").slice(0, 16);
}
/** 紐付く知見の版（知見 id → 本文の hash のうち、その問題に紐付く物だけ） */
export function kbKeyOf(links: Array<{ kbId: string }> | undefined, kbNow: Record<string, string> | null): string {
  if (!kbNow || !links?.length) return "-";
  return createHash("sha256").update([...new Set(links.map((l) => l.kbId))].sort().map((id) => `${id}:${kbNow[id] ?? "x"}`).join("\n")).digest("hex").slice(0, 10);
}
export const REUSE_MAX_AGE_DAYS = 7;
/** 使い回せるか（鍵が同じ・古すぎない・失敗の行が無い・回数が足りる） */
export function canReuse(e: { key: string; savedAt: string; rows: RowLite[] } | null, key: string, reps: number, now = Date.now(), maxAgeDays = REUSE_MAX_AGE_DAYS): boolean {
  if (!e || e.key !== key) return false;
  if (now - Date.parse(e.savedAt) > maxAgeDays * 86_400_000) return false;
  const ok = e.rows.filter((r) => !r.error);
  return ok.length >= reps && ok.length === e.rows.length;
}

// ─── 8. 場面でモデルを替える ───────────────────────────────────────────
/**
 * 問題のモデル: 既定は今まで通り（DEEPSEEK_MODEL・deepseek-v4-pro）。flash にするのは、比べの記録（model-check）で
 *   その型の道が pro と同じだった型だけ（質が落ちないか比べてから）。gate（最後の関所）は常に既定。
 */
export function modelOf(p: PlanProblem, o: { mode: "pro" | "flash" | "auto"; flashOkTypes: Set<string>; gate?: boolean }): "pro" | "flash" {
  if (o.gate || o.mode === "pro") return "pro";
  if (o.mode === "flash") return "flash";
  return o.flashOkTypes.has(p.type) ? "flash" : "pro";
}

// ─── 見込みの費用 ───────────────────────────────────────────────────────
/** 1問1回の費用（2026-10-17 実測: 作業ツリーの results/*.cost.json 49回 630問回＝ブレインまで $0.030・下書き 15回 306問回＝$0.031〜＋下書きの分）。flash は約 1/4 */
export const UNIT_USD = { brain: 0.030, draftExtra: 0.015, flashRatio: 0.25, peakRatio: 1.6 };
export type PlanItem = { id: string; reps: number; draft: boolean; reuse: boolean; model: "pro" | "flash"; why: string[] };
export function estimateUsd(items: PlanItem[], o: { peak?: boolean; baselineRuns?: number } = {}): { now: number; baseline: number; total: number } {
  let now = 0;
  for (const it of items) {
    if (it.reuse) continue;
    const u = (UNIT_USD.brain + (it.draft ? UNIT_USD.draftExtra : 0)) * (it.model === "flash" ? UNIT_USD.flashRatio : 1);
    now += u * it.reps;
  }
  const baseline = (o.baselineRuns ?? 0) * UNIT_USD.brain;
  const k = o.peak ? UNIT_USD.peakRatio : 1;
  return { now: now * k, baseline: baseline * k, total: (now + baseline) * k };
}

// ─── 7. 採点（決まりで決まる所は AI を呼ばない） ─────────────────────────
/**
 * 判定（DeepSeek）を呼ぶか: 依頼も言ってはいけない事も無く本質の道も要らない → 呼ばない（今まで通り）／
 *   lazy の時は、道が既に外れ（合格は決まりで✕）・本質の道も決まりで出る（LLM の最初の答えが AIX か無い）→ 呼ばない。
 *   返り値 false の時、答案の asks・ng は null（合否は道だけで決まる）
 */
export function needJudge(o: { asks: number; ng: number; needRawPath: boolean; pathOk: boolean; lazy: boolean }): boolean {
  if (!o.asks && !o.ng && !o.needRawPath) return false;
  if (o.lazy && !o.pathOk && !o.needRawPath) return false;
  return true;
}
