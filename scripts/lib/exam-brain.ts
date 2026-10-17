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
/**
 * 足して確かめる問題: 1回目が前（main）と違った問題（揺れか本当の変化かを分ける・揺れる問題も）。はっきり良い時は良くなった問題と悪くなった問題（判断だけ変わった問題は省く）。done＝もう max 回ある問題
 *   2026-10-17 確かめる人: はっきり良い（揺れない問題の悪化0）でも揺れる問題の悪化はあり得る＝悪化は必ず確かめる（1回だけの悪化を見逃さない）
 */
export function confirmTargets(cmps: Array<{ id: string; cmp: Cmp }>, done: Set<string>, o: { clearlyGood?: boolean } = {}): string[] {
  return cmps.filter((c) => !done.has(c.id) && (c.cmp === "worse" || c.cmp === "better" || (!o.clearlyGood && c.cmp === "changed"))).map((c) => c.id);
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
  // 2026-10-17 穴②（確かめる人）: 下書きは brainMetaDirect でブレインの meta を丸ごと受け取る＝道・合否・道の符号が同じでも、ブレインだけのファイル
  //   （例 app/lib/open-search-ack.ts の材料の見出し）を直すと下書きが変わり得る（10/16 q158 の型）。最後の関所は直した所が何でも下書きを全部流す
  //   （夜中の予約・使う物が同じ問題は前の結果を使う）。直しの確かめは「判断が変わった問題」に turn_contract の形の変化（cmp=shape）も入れる
  if (o.gate) return { ids: el.map((p) => p.id), why: "最後の関所（下書きはブレインの meta を丸ごと受け取る＝判断が同じでも変わり得るので全部）" };
  if (cls === "draft" || cls === "both") return { ids: el.map((p) => p.id), why: cls === "draft" ? "下書きに効くファイルを直した" : "ブレインと下書きの両方に効くファイルを直した" };
  const ids = el.filter((p) => brainChanged.has(p.id)).map((p) => p.id);
  return { ids, why: ids.length ? "ブレインの判断が前（main）と変わった問題だけ" : "判断が前と変わった問題が無い（下書きは前と同じ見込み）" };
}

// ─── 比べ（前＝main と今） ─────────────────────────────────────────────
export type RowLite = { id: string; rep: number; error?: string; path?: { code?: string; ok?: boolean }; score?: { pass?: boolean }; draft?: { code?: string; pass?: boolean; ok?: boolean } | null; brain?: { turn_contract?: unknown } | null };
export type Cmp = "worse" | "better" | "same" | "changed" | "shape" | "nobase" | "nocur";
/**
 * turn_contract の形（自由文でない欄だけ）: 依頼の数・依頼ごとの route と aix（並びは見ない）・close_only・ack_form・気持ちを受けるか。
 *   quote・answer・must_not・proposals・situation・background は回ごとに言い回しが違う＝比べない。turn_contract が無い答案は null（比べない）。
 *   形は app/lib/brain-layers.ts の tc の要約（数:r/p/a/n:c:w）に倣い、aix のキーと気持ちを受けるかを足した物
 */
export function contractShape(tc: unknown): string | null {
  if (!tc || typeof tc !== "object") return null;
  const c = tc as { asks?: unknown; close_only?: unknown; ack_form?: unknown; feeling?: unknown };
  const asks = Array.isArray(c.asks) ? (c.asks as Array<Record<string, unknown> | null>) : [];
  const s = (v: unknown) => { const t = typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v); return t === "null" ? "" : t; };
  const routes = asks.map((a) => `${s(a?.route) || "-"}${s(a?.aix) ? `:${s(a?.aix)}` : ""}`).sort();
  const close = c.close_only === true || c.close_only === "true";
  const af = s(c.ack_form);
  const ack = (c.feeling as { acknowledge?: unknown } | null | undefined)?.acknowledge;
  return `${asks.length}[${routes.join(",")}]${close ? ":c" : ""}${af ? `:${af}` : ""}${ack === true || ack === "true" ? ":f" : ""}`;
}
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
  // 2026-10-17 穴②: 道・合否・道の符号が同じでも turn_contract の形（route・close_only 等）が変われば下書きが変わり得る。両方に形がある時だけ比べる（古い答案は比べない）
  const shapes = (rs: RowLite[]) => [...new Set(rs.map((r) => contractShape(r.brain?.turn_contract)).filter((x): x is string => x !== null))].sort().join("/");
  const csh = shapes(c), bsh = shapes(b);
  if (csh && bsh && csh !== bsh) return { cmp: "shape", why: `turn_contract の形 ${bsh}→${csh}（道・合否は同じ）` };
  return { cmp: "same", why: "同じ" };
}
/** 判断が前と変わった（下書きまで流す理由）＝道・合格・判断の符号・turn_contract の形のどれかが違う（形だけの変化は確かめの回には足さない＝合否は同じ） */
export function brainChangedOf(cmps: Array<{ id: string; cmp: Cmp }>): Set<string> {
  return new Set(cmps.filter((c) => c.cmp === "worse" || c.cmp === "better" || c.cmp === "changed" || c.cmp === "shape" || c.cmp === "nobase").map((c) => c.id));
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
    return { action: "fewer", why: `${seen.length}問中 ${better.length}問が良くなり悪化0＝はっきり良い（確かめは良くなった・悪くなった問題だけ）`, worse, better };
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
/** 問題の結果の鍵＝この問題が使う物（問題の hash・段・効くファイルの中身の鍵・試験の道具の鍵・構成・モデル・紐付く知見の版・その段が読む DB の表の指紋） */
export function reuseKey(o: { problemHash: string; stage: "brain" | "draft"; scopeKey: string; toolKey: string; cfgHash: string; model: string; kbKey: string; dbKey: string; convKey?: string }): string {
  // 2026-10-17 ③: 会話の鍵は「会話の違いが答えに効く」時だけ足す（効かない＝"-"・付けない時は旧の鍵と同じ＝今までの置き場をそのまま使える）
  const base = [o.problemHash, o.stage, o.scopeKey, o.toolKey, o.cfgHash, o.model, o.kbKey, o.dbKey];
  return createHash("sha256").update(JSON.stringify(o.convKey && o.convKey !== "-" ? [...base, `conv:${o.convKey}`] : base)).digest("hex").slice(0, 16);
}

// ─── 10/17 ③ 会話の違いが答えに効くか（作る人と確かめる人で結果を分け合う） ─────────────
/**
 * 試験の会話（YUMA2〜5・YUMA）の「答えに効く所」の指紋。試験が問題ごとに書き直す所（条件の行の PC_FIELDS・通・台帳の写し）と、
 *   名前・id・時刻（名前は maskPII で伏せてから LLM に渡す・id は録音の鍵でも伏せる）は入れない。残り＝会話の行・条件の行の効く欄と、
 *   線（REPLAY_FLOOR）で隠せない会話ごとの表の件数（deal_outcomes・outcome_events・conversation_stage_history）。
 *   2026-10-17 確かめた: YUMA2〜5 の会話の行・条件の行で違うのは id・名前・line_user_id・時刻だけ・残りの表は全部0
 */
export const CONV_CTX_FIELDS = {
  conversations: ["account", "is_post_apply", "is_hot", "is_flagged", "auto_send_enabled", "conversation_direction", "acquisition_source", "line_source_type", "send_blocked_reason", "brain_strategy", "line_status", "screening_last_status"],
  property_customers: ["status", "priority", "assignee", "area", "max_rent", "layout", "property_memo", "account", "additional_conditions", "raw_format_text", "exclusion_areas", "town_names", "adjacent_ok", "area_normalized", "structure_types", "condition_summary", "requirement_strength", "profile_label", "parent_customer_id", "itandi_update_days", "rp_update_days", "format_received"],
  gapTables: ["deal_outcomes", "outcome_events", "conversation_stage_history"],
} as const;
export type ConvCtx = { name: string; ok: boolean; conv: Record<string, unknown> | null; pc: Record<string, unknown> | null; gaps: Record<string, number>; why?: string };
export function convCtxHash(c: ConvCtx): string | null {
  if (!c.ok) return null;
  const pick = (r: Record<string, unknown> | null, ks: readonly string[]) => ks.map((k) => [k, r?.[k] ?? null]);
  return createHash("sha256").update(JSON.stringify([pick(c.conv, CONV_CTX_FIELDS.conversations), pick(c.pc, CONV_CTX_FIELDS.property_customers), CONV_CTX_FIELDS.gapTables.map((t) => [t, c.gaps[t] ?? 0])])).digest("hex").slice(0, 10);
}
/**
 * 会話の鍵: 今の会話の指紋が試験の会話（YUMA2〜5）全部と同じ＝会話の違いは答えに効かない → "-"（鍵に足さない・どの会話の結果も使い回す）／
 *   違う（線で隠せない行がある・効く欄が違う）→ 今の会話の指紋（同じ指紋の会話の結果だけ使い回す）／読めない → null（使い回さない）
 */
export function convKeyOf(cur: ConvCtx, all: ConvCtx[]): { key: string | null; why: string } {
  const h = convCtxHash(cur);
  if (!h) return { key: null, why: `会話 ${cur.name} の効く所が読めない（${cur.why ?? ""}）→ 使い回さない` };
  const hs = all.map((c) => ({ name: c.name, h: convCtxHash(c) }));
  const diff = hs.filter((x) => x.h !== h);
  if (!diff.length) return { key: "-", why: `会話の違いは答えに効かない（${hs.map((x) => x.name).join("・")} の会話の行・条件の行の効く欄・線で隠せない表が同じ）＝別の会話・別の作業ツリーの結果も使う` };
  return { key: h, why: `会話 ${cur.name} は ${diff.map((x) => x.name).join("・")} と効く所が違う → 会話も鍵に（同じ指紋の会話の結果だけ使う）` };
}
// 2026-10-17 穴③（確かめる人）: 使い回しの鍵に DB の中身が入っていなかった（ブレインが毎回読む ai_reply_knowledge・ai_prompt_rules 等を変えても前の結果を使っていた）。
//   表ごとの指紋（件数・最終の時刻・小さい表は中身の hash）を試験の始めに1回読み（exam-brain-io.ts の readDbFingerprint・読むだけ）、段の鍵に足す
export type DbPart = { table: string; ok: boolean; sig: string; why?: string };
/** 段の DB の鍵: その段が読む表の指紋の hash。1つでも読めない（または読んでいない）表があれば null＝使い回さない（安全側） */
export function dbKeyOf(parts: DbPart[] | null, tables: string[]): string | null {
  if (!parts) return null;
  const by = new Map(parts.map((p) => [p.table, p]));
  const sigs: string[] = [];
  for (const t of [...new Set(tables)].sort()) { const p = by.get(t); if (!p || !p.ok) return null; sigs.push(`${t}=${p.sig}`); }
  return createHash("sha256").update(sigs.join("\n")).digest("hex").slice(0, 12);
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

// ─── 10/17 ① 2段（直している途中は小さく・最後に1回だけ仕上げ） ─────────────────────
/**
 * 竹内さん 10/17「1 2 3 順に改善」: 試験の費用の8割はブレイン本体で、作る人が直しの途中で何度も試験を回す（1日 28〜63回）のが大きい。
 *   直しの途中の確かめ＝小さな確かめ（関係する5〜8問だけ・繰り返し最小）、直しが止まって小さな確かめが通ったら1回だけ仕上げ（選んだ問題全部＝今の --plan の選び）。
 *   off＝旧（毎回選んだ問題全部）
 */
export type Phase = "small" | "final" | "off";
export const SMALL_N = { min: 5, max: 8 };
/** 小さな確かめの繰り返しの上限（1回目が前と違った問題だけ2回目＝同じ向きか割れたかは分かる） */
export const SMALL_MAX_REPS = 2;
/** 小さな確かめの順（小さいほど先）: 名指し → 前に落ちた → 直した所に近い（近さの大きい順）→ お手本・竹内さんの番 → 残り */
export function smallRank(why: string[]): { tier: number; sim: number } {
  const has = (re: RegExp) => why.some((w) => re.test(w));
  const sims = why.flatMap((w) => [...w.matchAll(/[（(]([01]\.\d+)/g)].map((m) => Number(m[1]))).filter((x) => Number.isFinite(x));
  const sim = sims.length ? Math.max(...sims) : 0;
  if (has(/名指し/)) return { tier: 0, sim };
  if (has(/前に落ちた/)) return { tier: 1, sim };
  if (has(/差分の言葉に近い|知見 .{0,12}を(入れた|変えた|退役した)|差分で当たった知見|知見 .{0,12}に近い/)) return { tier: 2, sim };
  if (has(/お手本|竹内さんの番/)) return { tier: 3, sim };
  return { tier: 4, sim };
}
/** 小さな確かめの問題: 名指しは全部・残りは順に max まで（同じ段の中は近さの大きい順・元の順） */
export function pickSmall(picks: Pick[], o: { max?: number } = {}): Pick[] {
  const max = o.max ?? SMALL_N.max;
  const r = picks.map((p, i) => ({ p, i, ...smallRank(p.why) })).sort((a, b) => a.tier - b.tier || b.sim - a.sim || a.i - b.i);
  const named = r.filter((x) => x.tier === 0);
  const rest = r.filter((x) => x.tier !== 0).slice(0, Math.max(0, max - named.length));
  const keep = new Set([...named, ...rest].map((x) => x.p.id));
  return picks.filter((p) => keep.has(p.id));
}
export type SmallRecord = { at: string; label: string; phase: Phase; keys: string; clean: boolean; ids: string[] };
/**
 * 小さな確かめか仕上げか: 明示（--phase）＞ 最後の関所（gate）＝仕上げ ＞ 選んだ問題が max 問以下＝仕上げ（小さな確かめと同じ）＞
 *   同じ版（効くファイル・道具・構成・DB の鍵が同じ）の小さな確かめが前と比べて悪化なしで通っている＝直しが止まった → 仕上げ ＞ それ以外＝小さな確かめ
 */
export function decidePhase(o: { explicit?: string; gate?: boolean; pickCount: number; keys: string; history: SmallRecord[]; max?: number }): { phase: Phase; why: string } {
  const e = (o.explicit ?? "").trim().toLowerCase();
  if (e === "off" || e === "old") return { phase: "off", why: "旧のやり方（--phase=off／EXAM_PHASE=off＝毎回選んだ問題全部）" };
  if (e === "small") return { phase: "small", why: "--phase=small" };
  if (e === "final") return { phase: "final", why: "--phase=final" };
  if (o.gate) return { phase: "final", why: "最後の関所＝仕上げ" };
  if (o.pickCount <= (o.max ?? SMALL_N.max)) return { phase: "final", why: `選んだ問題が ${o.pickCount}問（${o.max ?? SMALL_N.max}問以下）＝小さな確かめと同じ＝仕上げ` };
  const same = o.history.filter((h) => h.phase === "small" && h.keys === o.keys).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (same?.clean) return { phase: "final", why: `同じ版の小さな確かめ（${same.label}・${same.ids.length}問）が悪化なしで通った＝直しが止まった → 仕上げ` };
  if (same) return { phase: "small", why: `同じ版の小さな確かめ（${same.label}）に悪化があった → まだ直しの途中＝小さな確かめ` };
  return { phase: "small", why: "直しの途中（この版の小さな確かめがまだ無い）＝小さな確かめ。通ったら同じ命令でもう一度＝仕上げ" };
}

// ─── 10/17 ② 1日の上限（試験 env の DeepSeek＋Claude・JST の日） ─────────────────────
export const DAILY_CAP_DEFAULT_USD = 10;
/** EXAM_DAILY_CAP_USD（既定 10・off/0 で無し）。本番（VERCEL_ENV=production）には付けない＝null */
export function dailyCapUsd(env: Record<string, string | undefined>): number | null {
  if (env.VERCEL_ENV === "production") return null;
  const raw = String(env.EXAM_DAILY_CAP_USD ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "none") return null;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : DAILY_CAP_DEFAULT_USD;
}
/** JST の日の始まり（UTC の Date）。夜中の予約の実行は実行した日の JST に数える */
export function jstDayStart(d: Date): Date { const j = new Date(d.getTime() + 9 * 3600_000); return new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) - 9 * 3600_000); }
/** 夜中の予約の時刻（タスクスケジューラ SumoraExamNight が --run-queue を流す JST 1:40）。今より後の一番近い 1:40 */
export const NIGHT_RUN_JST_MIN = 100;
export function nextNightRun(d: Date): Date {
  const t = new Date(jstDayStart(d).getTime() + NIGHT_RUN_JST_MIN * 60_000);
  return t.getTime() > d.getTime() ? t : new Date(t.getTime() + 86_400_000);
}
/** 守る線（上限を超えても今流す）: 名指し・前に落ちた・竹内さんのお手本（竹内さんの番も同じ削らない札） */
export function isProtected(why: string[]): boolean { return why.some((w) => /名指し|前に落ちた|お手本|竹内さんの番/.test(w)); }
/**
 * 上限の分け方: 今日の使用額＋この実行の見込み ≤ 上限 → 全部今／超える → 守る線を先に今（守る線だけでも超えるなら、今は流さず全部夜中）・残りを夜中の予約に回す（止めて終わりにしない）。
 *   estOf は問題の組の見込み（$）
 */
export function capSplit(o: { ids: string[]; whyOf: (id: string) => string[]; estOf: (ids: string[]) => number; usedUsd: number; cap: number | null; force?: boolean }): {
  mode: "off" | "ok" | "split" | "night" | "force"; now: string[]; later: string[]; estNow: number; estLater: number; why: string;
} {
  const all = o.estOf(o.ids);
  if (o.cap === null) return { mode: "off", now: o.ids, later: [], estNow: all, estLater: 0, why: "1日の上限なし（EXAM_DAILY_CAP_USD=off）" };
  const left = o.cap - o.usedUsd;
  if (o.usedUsd + all <= o.cap) return { mode: "ok", now: o.ids, later: [], estNow: all, estLater: 0, why: `収まる（今日 $${o.usedUsd.toFixed(2)}＋見込み $${all.toFixed(2)} ≤ 上限 $${o.cap}）` };
  if (o.force) return { mode: "force", now: o.ids, later: [], estNow: all, estLater: 0, why: `上限を超えるが --over-cap で全部今（今日 $${o.usedUsd.toFixed(2)}＋見込み $${all.toFixed(2)} ＞ 上限 $${o.cap}）` };
  const prot = o.ids.filter((id) => isProtected(o.whyOf(id)));
  const rest = o.ids.filter((id) => !prot.includes(id));
  const ep = o.estOf(prot);
  if (prot.length && ep <= left) return { mode: "split", now: prot, later: rest, estNow: ep, estLater: o.estOf(rest), why: `上限を超える（今日 $${o.usedUsd.toFixed(2)}＋見込み $${all.toFixed(2)} ＞ $${o.cap}）→ 守る線 ${prot.length}問（$${ep.toFixed(2)}）を今・残り ${rest.length}問を夜中に` };
  return { mode: "night", now: [], later: o.ids, estNow: 0, estLater: all, why: `上限を超える（今日 $${o.usedUsd.toFixed(2)}・残り $${Math.max(0, left).toFixed(2)}${prot.length ? `・守る線だけでも $${ep.toFixed(2)}` : "・守る線の問題が無い"}）→ 全部を夜中に（今すぐなら --over-cap）` };
}

// ─── 10/17 2倍の時間（DeepSeek は平日 JST 10〜13・15〜19 が2倍） ───────────────────────
/** 2倍の時間の警告と、急がない物（仕上げ）を夜中に回すか。小さな確かめは急ぐ（直しの途中）＝警告だけ */
export function peakAdvice(o: { now: Date; phase: Phase; gate?: boolean; when: When }): { peak: boolean; defer: boolean; warn: string | null } {
  const peak = isDeepseekPeakAt(o.now);
  if (!peak) return { peak, defer: false, warn: null };
  const defer = o.when === "auto" && !o.gate && o.phase === "final";
  return { peak, defer, warn: `⚠ 今は DeepSeek の2倍の時間（平日 JST 10〜13・15〜19）。${defer ? "仕上げは急がない＝夜中に回す（今なら --when=now）" : o.phase === "small" ? "小さな確かめは今流す（急がない物は 13:00〜15:00 か夜中に）" : "急がない物は 13:00〜15:00 か夜中に"}` };
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
