// scripts/lib/judge-basis-score.ts — 重点の物差し＋判断の根拠のメモの物差し（純関数・LLM なし・DB なし）
//
// 2026-11-12 作業員17（KB 1a78e4e3・7d6fe3eb・ef6626d7）。
//   正解: 試験の問題 spec の `basis`（BasisGold・人が付けた物）。無い問題は accept の AIX 型から重点だけ「推定」で出す（推定は別に数える）。
//   ブレインの側: 答案の行の brain.judge_basis（BRAIN_JUDGE_BASIS=on）の重点・深さ・優先・順番・読み。
//     judge_basis が無い行（off で回した答案）でも、重点は brain.conductor_focus.focus（conductor-focus の shadow）があればそれで数える。
//   出す物: 場面ごとの重点の当たり／深さ別の当たり／外れた段（読み・選び・深さ・優先・重点・順番・道）／選んだ順番が竹内さんと合ったか。
import { FOCUS_ORDER, focusOfAix, orderDigest, type Focus } from "../../app/lib/conductor-focus";
import { normalizeJudgeBasis, BASIS_ROUTE_WORD_RE, type JudgeBasis } from "../../app/lib/brain-judge-basis";
import { checkOrderById } from "../../app/lib/check-order";
import { DEPTH_KINDS, FOCUS_KINDS, FOCUS_TOP_PRIORITY, MISS_STAGES, PURPOSE_KINDS, MISSING_KINDS, type Purpose, type MissingKind, type BasisGold, type BasisMissStage, type BasisDepth } from "../../app/lib/judge-basis-types";

export type SpecLite = { id: string; type?: string; tags?: string[]; accept?: string[]; basis?: BasisGold | null; scene?: string | null };
export type AnswerRow = { id: string; rep?: number; brain?: Record<string, unknown> | null; path?: { ok?: boolean | null } | null; score?: { path?: boolean | null; pass?: boolean | null } | null };

/** 正解の重点・優先・順番・深さ（source: human＝spec の basis／inferred＝accept の AIX 型から推定・重点だけ） */
export type GoldBasis = { focus: Focus | null; priority: string[]; order: string[]; depth: BasisDepth | null; source: "human" | "inferred" | "none";
  /** 2026-11-12 作業員22: 目的（人が付けた物か、型の表の priority の先頭）・足りない情報（人が付けた物だけ・[] は無い）・押さえる要点（人が付けた物だけ） */
  purpose: Purpose | null; missing: MissingKind[] | null; keyPoint: string | null };

/** accept の符号（"AIX:property_send" 等）から重点を推す。「AIX:左右」等の系統名・返信・2段は決めない（null） */
export function inferFocusFromAccept(accept: ReadonlyArray<string> | undefined): Focus | null {
  const found = new Set<Focus>();
  for (const c of accept ?? []) {
    const m = c.trim().match(/^AIX:([a-z_]+)/);
    if (m) { const f = focusOfAix(m[1]); if (f) found.add(f); }
    else if (c.startsWith("2段:")) found.add("promise_make");
  }
  return found.size === 1 ? [...found][0] : null;
}

const orderOfFocus = (f: Focus | null): string[] => (f ? FOCUS_ORDER[f].map((s) => s.role).filter((r, i, a) => a[i - 1] !== r) : []);
const dedupeRuns = (xs: ReadonlyArray<string>): string[] => xs.filter((r, i, a) => a[i - 1] !== r);

export function goldOf(spec: SpecLite): GoldBasis {
  const g = spec.basis;
  const why = whyGoldOf(g);
  if (g && (g.focus || g.priority?.length || g.order?.length || g.depth || why.purpose || why.missing || why.keyPoint)) {
    const focus = g.focus && FOCUS_KINDS.includes(g.focus) ? g.focus : null;
    return { focus, priority: g.priority?.length ? [...g.priority] : focus ? [FOCUS_TOP_PRIORITY[focus]] : [], order: g.order?.length ? dedupeRuns(g.order) : orderOfFocus(focus), depth: g.depth && DEPTH_KINDS.includes(g.depth) ? g.depth : null, source: "human", ...why };
  }
  const f = inferFocusFromAccept(spec.accept);
  return f ? { focus: f, priority: [FOCUS_TOP_PRIORITY[f]], order: orderOfFocus(f), depth: null, source: "inferred", ...why } : { focus: null, priority: [], order: [], depth: null, source: "none", ...why };
}
/** 目的・足りない情報・要点の正解（人が付けた物だけ。目的は無ければ型の表の priority の先頭＝作業員16 の Need の名前のまま） */
function whyGoldOf(g: BasisGold | null | undefined): { purpose: Purpose | null; missing: MissingKind[] | null; keyPoint: string | null } {
  const purpose = g?.purpose && (PURPOSE_KINDS as readonly string[]).includes(g.purpose) ? g.purpose : g?.type ? (checkOrderById(g.type)?.priority[0] ?? null) : null;
  const missing = Array.isArray(g?.missing) ? g!.missing.filter((k): k is MissingKind => (MISSING_KINDS as readonly string[]).includes(k)) : null;
  return { purpose, missing, keyPoint: g?.keyPoint?.trim() ? g.keyPoint.trim() : null };
}
/** 要点の近さ（文字の2つ組の重なり・0〜1）。言い回しが違っても同じ所を押さえていれば近い */
export function keyPointOverlap(a: string, b: string): number {
  const bi = (s: string) => { const t = s.replace(/[\s、。・「」『』（）()]/g, ""); const out = new Set<string>(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); return out; };
  const x = bi(a), y = bi(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const k of x) if (y.has(k)) n++;
  return n / Math.min(x.size, y.size);
}
export const KEY_POINT_HIT = 0.4;
const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((x) => b.includes(x));

export type BrainBasis = { log: JudgeBasis | null; focus: Focus | null; focusFrom: "judge_basis" | "conductor_focus" | null; hasLog: boolean };
export function brainBasisOf(row: AnswerRow): BrainBasis {
  const b = (row.brain ?? {}) as Record<string, unknown>;
  const log = normalizeJudgeBasis(b.judge_basis);
  if (log?.focus) return { log, focus: log.focus, focusFrom: "judge_basis", hasLog: true };
  const cf = (b.conductor_focus as { focus?: string } | null | undefined)?.focus;
  const f = (FOCUS_KINDS as readonly string[]).includes(String(cf)) ? (cf as Focus) : null;
  return { log, focus: f, focusFrom: f ? "conductor_focus" : null, hasLog: !!log };
}

export type TurnVerdict = {
  id: string; rep: number; goldSource: GoldBasis["source"]; depth: BasisDepth | "none";
  focusHit: boolean | null; priorityHit: boolean | null; depthHit: boolean | null;
  /** 目的が合ったか／足りない情報の組が同じか／要点が近いか（keyPointOverlap ≥ KEY_POINT_HIT）／目的・足りない情報・要点に道の言葉が入ったか */
  purposeHit: boolean | null; missingHit: boolean | null; keyPointHit: boolean | null; routeWord: boolean | null;
  /** 選んだ順番が竹内さん（正解の順番）と合ったか。exact＝役の並びが同じ／head＝最初の2役が同じ */
  orderExact: boolean | null; orderHead: boolean | null;
  readRaised: boolean | null; readChosen: boolean | null;
  pathOk: boolean | null;
  missStage: BasisMissStage | null;
};
const eq = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((x, i) => x === b[i]);

export function scoreTurn(spec: SpecLite, row: AnswerRow): TurnVerdict {
  const gold = goldOf(spec), bt = brainBasisOf(row), log = bt.log;
  const pathOk = typeof row.score?.path === "boolean" ? row.score.path : typeof row.path?.ok === "boolean" ? row.path.ok : null;
  const focusHit = gold.focus && bt.focus ? bt.focus === gold.focus : null;
  // 優先は人が付けた物だけで数える（推定は重点の写しなので優先の独立した当たりにならない）
  const priorityHit = gold.source === "human" && gold.priority.length && log?.priority.length ? log.priority[0] === gold.priority[0] : null;
  const depthHit = gold.depth && log?.depth ? log.depth === gold.depth : null;
  const orderBrain = log?.order.length ? dedupeRuns(log.order) : null;
  const orderExact = gold.order.length && orderBrain ? eq(orderBrain, gold.order) : null;
  const orderHead = gold.order.length && orderBrain ? eq(orderBrain.slice(0, 2), gold.order.slice(0, 2)) : null;
  const readRaised = gold.focus && log?.readings.length ? log.readings.some((r) => r.focus === gold.focus) : null;
  const readChosen = gold.focus && log && log.chosen != null && log.readings[log.chosen] ? log.readings[log.chosen].focus === gold.focus : null;
  // 2026-11-12 作業員22: 目的（なぜ）・足りない情報（何が無いから）・押さえる要点（どこを）
  const purposeHit = gold.purpose && log?.purpose ? log.purpose === gold.purpose : null;
  const missingHit = gold.missing && log && log.missing ? sameSet(log.missing.map((m) => m.kind), gold.missing) : null;
  const keyPointHit = gold.keyPoint && log?.keyPoint ? keyPointOverlap(log.keyPoint, gold.keyPoint) >= KEY_POINT_HIT : null;
  // 道の言葉は目的のなぜと要点だけで数える（足りない情報は「申込の意思」「内覧の日時」等の情報の名前そのものに道の語が入るので数えない）
  const routeWord = log && (log.purposeWhy || log.keyPoint) ? BASIS_ROUTE_WORD_RE.test([log.purposeWhy, log.keyPoint].join(" ")) : null;
  // 外れた段: 左（読み）から先に外れた段を1つだけ
  let miss: BasisMissStage | null = null;
  if (readRaised === false) miss = "read";
  else if (readRaised === true && readChosen === false) miss = "pick";
  else if (depthHit === false) miss = "depth";
  else if (purposeHit === false) miss = "purpose";
  else if (missingHit === false) miss = "missing";
  else if (priorityHit === false) miss = "priority";
  else if (focusHit === false) miss = "focus";
  else if (orderExact === false && orderHead === false) miss = "order";
  else if (pathOk === false) miss = "path";
  return { id: spec.id, rep: row.rep ?? 0, goldSource: gold.source, depth: log?.depth ?? "none", focusHit, priorityHit, depthHit, purposeHit, missingHit, keyPointHit, routeWord, orderExact, orderHead, readRaised, readChosen, pathOk, missStage: miss };
}

export type Tally = { n: number; purN: number; purHit: number; misN: number; misHit: number; keyN: number; keyHit: number; routeN: number; routeWord: number; focusN: number; focusHit: number; priN: number; priHit: number; depthN: number; depthHit: number; ordN: number; ordExact: number; ordHead: number; pathN: number; pathOk: number; miss: Record<string, number> };
const emptyTally = (): Tally => ({ n: 0, purN: 0, purHit: 0, misN: 0, misHit: 0, keyN: 0, keyHit: 0, routeN: 0, routeWord: 0, focusN: 0, focusHit: 0, priN: 0, priHit: 0, depthN: 0, depthHit: 0, ordN: 0, ordExact: 0, ordHead: 0, pathN: 0, pathOk: 0, miss: {} });
export function addTo(t: Tally, v: TurnVerdict) {
  t.n++;
  if (v.focusHit !== null) { t.focusN++; if (v.focusHit) t.focusHit++; }
  if (v.priorityHit !== null) { t.priN++; if (v.priorityHit) t.priHit++; }
  if (v.depthHit !== null) { t.depthN++; if (v.depthHit) t.depthHit++; }
  if (v.purposeHit !== null) { t.purN++; if (v.purposeHit) t.purHit++; }
  if (v.missingHit !== null) { t.misN++; if (v.missingHit) t.misHit++; }
  if (v.keyPointHit !== null) { t.keyN++; if (v.keyPointHit) t.keyHit++; }
  if (v.routeWord !== null) { t.routeN++; if (v.routeWord) t.routeWord++; }
  if (v.orderExact !== null) { t.ordN++; if (v.orderExact) t.ordExact++; if (v.orderHead) t.ordHead++; }
  if (v.pathOk !== null) { t.pathN++; if (v.pathOk) t.pathOk++; }
  if (v.missStage) t.miss[v.missStage] = (t.miss[v.missStage] ?? 0) + 1;
}

export type Report = { total: Tally; byScene: Record<string, Tally>; byDepth: Record<string, Tally>; verdicts: TurnVerdict[]; noSpec: number; noGold: number };
/** 答案の行 × 問題の spec → 場面別・深さ別の表。scene は spec.scene か type（試験の問題の型）を使う */
export function buildReport(specs: ReadonlyArray<SpecLite>, rows: ReadonlyArray<AnswerRow>): Report {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const rep: Report = { total: emptyTally(), byScene: {}, byDepth: {}, verdicts: [], noSpec: 0, noGold: 0 };
  for (const r of rows) {
    const s = byId.get(r.id);
    if (!s) { rep.noSpec++; continue; }
    const v = scoreTurn(s, r);
    if (v.goldSource === "none") rep.noGold++;
    rep.verdicts.push(v);
    const scene = s.scene || s.type || "(場面なし)";
    addTo(rep.total, v);
    addTo((rep.byScene[scene] ??= emptyTally()), v);
    addTo((rep.byDepth[v.depth] ??= emptyTally()), v);
  }
  return rep;
}

const pct = (a: number, n: number) => (n ? `${a}/${n} ${Math.round((100 * a) / n)}%` : "-");
export function tallyLine(name: string, t: Tally): string {
  const miss = MISS_STAGES.filter((k) => t.miss[k]).map((k) => `${k}:${t.miss[k]}`).join(" ") || "-";
  return `${name.padEnd(14)} n=${String(t.n).padStart(3)}  目的 ${pct(t.purHit, t.purN).padEnd(10)} 足りない ${pct(t.misHit, t.misN).padEnd(10)} 要点 ${pct(t.keyHit, t.keyN).padEnd(10)} 道の言葉 ${pct(t.routeWord, t.routeN).padEnd(10)} 重点 ${pct(t.focusHit, t.focusN).padEnd(10)} 優先 ${pct(t.priHit, t.priN).padEnd(10)} 深さ ${pct(t.depthHit, t.depthN).padEnd(10)} 順番(同じ) ${pct(t.ordExact, t.ordN).padEnd(10)} 順番(頭2) ${pct(t.ordHead, t.ordN).padEnd(10)} 道 ${pct(t.pathOk, t.pathN).padEnd(10)} 外れた段 ${miss}`;
}
export function formatReport(r: Report): string {
  const out = [`# 重点・判断の根拠の物差し（問題の spec に無い行 ${r.noSpec}・正解の重点が決まらない行 ${r.noGold}）`, tallyLine("全体", r.total), "", "## 場面ごと"];
  for (const [k, t] of Object.entries(r.byScene).sort((a, b) => b[1].n - a[1].n)) out.push(tallyLine(k, t));
  out.push("", "## ブレインが選んだ深さ別（none＝judge_basis が無い行）");
  for (const k of [...DEPTH_KINDS, "none"]) if (r.byDepth[k]) out.push(tallyLine(k, r.byDepth[k]));
  return out.join("\n");
}
