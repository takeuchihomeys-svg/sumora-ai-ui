// scripts/lib/exam-screen.ts — 試験の「flash でふるい → pro で確かめ（→ 関所だけ Claude）」の決め方（LLM も DB も使わない）
//
// 2026-10-23 竹内さん「テスト flash でして最後 pro とかでできるのか・効率逆に悪いか・どうすれば質も高く節約できるか」:
//   1段目（ふるい）: 選んだ問題を flash で今の版と前（main・flash の答えは main の版ごとに取り置き＝担当どうしで使い回す）の両方 1回
//   2段目（確かめ）: pro で流すのは ①flash で前と違った問題 ②直しの的（名指し・前に落ちた）③揺れる問題 ④flash で同じだった問題から抜き取り（既定 15%）
//                    ④は「flash では同じなのに pro では違う」（flash の見落とし）を数えるため。
//   3段目（関所だけ）: 既定 on に切り替える時（--gate）は pro で前と違った問題（最大 8問）を Claude（本番のブレイン）で
//   判定: pro・Claude を流した問題はそれで決める。flash だけの問題は「flash の今と前が同じ」時だけ「変わらない」と数える。
//   見落としの率: 抜き取り（と的・揺れる問題）で flash 同じ・pro 違う を型ごとに数え、率が線（既定 10%）を超えた型は次から flash でふるわない（最初から pro）
import { createHash } from "node:crypto";
import type { Cmp } from "./exam-brain";

export const SCREEN = {
  /** flash で同じだった問題から pro にも回す割合（見落としを数える） */
  auditRate: 0.15,
  /** 型の見落とし（はっきりの物）の率がこれを超えたら、その型は flash でふるわない */
  banRate: 0.10,
  /** auto（既定）で on にする条件: 見落としを数えた数がこれ以上で */
  autoMinN: 20,
  /** …見落とし（はっきり）の率がこれ以下 */
  autoMaxRate: 0.05,
  /** auto: flash で今と前が違う割合（前の回の記録）がこれを超えたら使わない＝ふるいの分が節約を上回る（損益の分かれ目 約 35〜40%＋抜き取り）。*/
  maxDiffRate: 0.6,
  /** ふるう問題がこれより少ない時はふるわない（子を1本多く流す手間に見合わない） */
  minQ: 10,
  /** 関所の Claude で確かめる最大の問題数 */
  claudeMax: 8,
} as const;

/** 型ごとの見落としの数え: n＝flash で同じだった問題を pro でも流した数・blind＝そのうち pro で道か合格が前と違った（はっきりの見落とし）・soft＝判断・形だけ違った */
export type ScreenStat = { n: number; blind: number; soft: number };
export type ScreenRun = { at: string; label: string; screened: number; unchanged: number; escalated: number; audit: number; flashSame: number };
export type ScreenStats = { byType: Record<string, ScreenStat>; runs?: ScreenRun[] };

export function totalsOf(st: ScreenStats): ScreenStat {
  return Object.values(st.byType ?? {}).reduce((a, v) => ({ n: a.n + v.n, blind: a.blind + v.blind, soft: a.soft + v.soft }), { n: 0, blind: 0, soft: 0 });
}

/**
 * ふるいを使うか。v＝EXAM_SCREEN（on|off|auto・既定 auto）。
 *   auto: 見落としを autoMinN 回以上数えて・はっきりの見落としの率が autoMaxRate 以下の時だけ on（まだ数えていない＝off＝今まで通り pro）。
 *   関所（--gate）は on を明示した時だけ（auto では入れない）
 */
export function screenModeOf(v: string | undefined, o: { gate: boolean; stats: ScreenStats }): { on: boolean; why: string } {
  const m = (v ?? "").trim().toLowerCase() || "auto";
  if (m === "off") return { on: false, why: "使わない（EXAM_SCREEN=off）" };
  if (m === "on") return { on: true, why: `使う（EXAM_SCREEN=on${o.gate ? "・関所＝確かめの後に Claude" : ""}）` };
  if (o.gate) return { on: false, why: "関所は auto では使わない（EXAM_SCREEN=on で使う）" };
  const t = totalsOf(o.stats);
  const rate = t.n ? t.blind / t.n : 1;
  if (t.n < SCREEN.autoMinN) return { on: false, why: `auto: 見落としの数えがまだ ${t.n}/${SCREEN.autoMinN}回 → 使わない（EXAM_SCREEN=on で試す）` };
  if (rate > SCREEN.autoMaxRate) return { on: false, why: `auto: 見落とし ${t.blind}/${t.n}（${Math.round(rate * 100)}%）が ${Math.round(SCREEN.autoMaxRate * 100)}% を超える → 使わない` };
  const d = escalateRateOf(o.stats, -1);
  if (d > SCREEN.maxDiffRate) return { on: false, why: `auto: flash で前と違う割合 ${Math.round(d * 100)}% が ${Math.round(SCREEN.maxDiffRate * 100)}% を超える＝ふるいの分が節約を上回る → 使わない` };
  return { on: true, why: `auto: 見落とし ${t.blind}/${t.n}（${Math.round(rate * 100)}%）≦ ${Math.round(SCREEN.autoMaxRate * 100)}% → 使う` };
}

/** flash でふるわない型（はっきりの見落としの率が banRate を超えた型。1回でも見落として数が少ない間は止まる＝安全側） */
export function bannedTypes(st: ScreenStats): Set<string> {
  return new Set(Object.entries(st.byType ?? {}).filter(([, v]) => v.blind > 0 && v.blind / Math.max(1, v.n) > SCREEN.banRate).map(([k]) => k));
}

export type ScreenItem = { id: string; type: string; model: "pro" | "flash"; reuse: boolean; draft: boolean };
/**
 * ふるう問題: pro で流す予定（flash の予定の問題はもともと flash）・使い回しでない（もともと0円）・下書きまでと決めた問題でない（下書きは pro で）・
 *   見落としの多い型でない。返す skip は理由付き（表示用）
 */
export function screenCandidates(items: ScreenItem[], banned: Set<string>): { screen: string[]; skip: Array<{ id: string; why: string }> } {
  const screen: string[] = [], skip: Array<{ id: string; why: string }> = [];
  for (const it of items) {
    if (it.model !== "pro") continue;
    if (it.reuse) continue;
    if (it.draft) { skip.push({ id: it.id, why: "下書きまで流す問題" }); continue; }
    if (banned.has(it.type)) { skip.push({ id: it.id, why: `型「${it.type}」は flash の見落としが多い` }); continue; }
    screen.push(it.id);
  }
  return { screen, skip };
}

/** 抜き取り（決まった選び: 同じ seed・同じ問題なら同じ答え）。候補が4問以上なら少なくとも1問 */
export function auditPick(ids: string[], rate: number, seed: string): string[] {
  if (!ids.length || rate <= 0) return [];
  if (rate >= 1) return [...ids];
  const h = (id: string) => parseInt(createHash("sha256").update(`${seed}|${id}`).digest("hex").slice(0, 8), 16) / 0xffffffff;
  const ranked = [...ids].sort((a, b) => h(a) - h(b));
  const want = Math.max(ids.length >= 4 ? 1 : 0, Math.round(ids.length * rate));
  return ranked.slice(0, want);
}

export type ScreenX = { id: string; cmp: Cmp; inputSame: boolean; fix: boolean; flaky: boolean };
/**
 * 1段目の後: pro に回す問題と「変わらない」と数える問題。
 *   変わらない＝flash の今と前が同じ（cmp=same・本当に呼んだ答えで）で、的・揺れる・抜き取りでない物だけ。
 *   flash の答えが無い（nocur）・前が無い（nobase）・形だけ違う（shape）も pro へ（分からない＝安全側）
 */
export function screenDecide(xs: ScreenX[], audit: Set<string>): { unchanged: string[]; escalate: Array<{ id: string; why: string }> } {
  const unchanged: string[] = [], escalate: Array<{ id: string; why: string }> = [];
  for (const x of xs) {
    // 入力が同じ（flash の要求が main と同じ）: pro の道は flash と別の段を通ることがある＝「変わらない」とは決めない。
    //   pro に回しても pro の下見（AI を呼ばない）で同じなら0円・違えば本当に呼ぶ＝安全で高くならない
    if (x.inputSame) { escalate.push({ id: x.id, why: "flash の入力が main と同じ（pro の下見で確かめる・同じなら0円）" }); continue; }
    if (x.cmp !== "same") { escalate.push({ id: x.id, why: x.cmp === "nocur" ? "flash の答えが無い" : x.cmp === "nobase" ? "flash の前が無い" : `flash で前と違った（${x.cmp}）` }); continue; }
    if (x.fix) { escalate.push({ id: x.id, why: "直しの的" }); continue; }
    if (x.flaky) { escalate.push({ id: x.id, why: "揺れる問題" }); continue; }
    if (audit.has(x.id)) { escalate.push({ id: x.id, why: "抜き取り（見落としを数える）" }); continue; }
    unchanged.push(x.id);
  }
  return { unchanged, escalate };
}

export type BlindObs = { id: string; type: string; hard: boolean; soft: boolean; proCmp: Cmp; why: string };
/** 見落としの観測: flash で同じ（入力が同じは除く）・pro で答えがあり前もある問題だけ。hard＝道か合格が違った・soft＝判断・形だけ違った */
export function blindObs(xs: Array<{ id: string; type: string; flashCmp: Cmp; inputSame: boolean; proCmp: Cmp; why?: string }>): BlindObs[] {
  return xs.filter((x) => x.flashCmp === "same" && !x.inputSame && x.proCmp !== "nocur" && x.proCmp !== "nobase")
    .map((x) => ({ id: x.id, type: x.type, hard: x.proCmp === "worse" || x.proCmp === "better", soft: x.proCmp === "changed" || x.proCmp === "shape", proCmp: x.proCmp, why: x.why ?? "" }));
}
export function mergeBlind(st: ScreenStats, obs: BlindObs[], run?: ScreenRun): ScreenStats {
  const byType: Record<string, ScreenStat> = Object.fromEntries(Object.entries(st.byType ?? {}).map(([k, v]) => [k, { ...v }]));
  for (const o of obs) { const e = byType[o.type] ?? { n: 0, blind: 0, soft: 0 }; e.n++; if (o.hard) e.blind++; else if (o.soft) e.soft++; byType[o.type] = e; }
  return { byType, runs: [...(st.runs ?? []), ...(run ? [run] : [])].slice(-200) };
}

/** 関所の Claude で確かめる問題: pro で前と違った問題（悪化 → 良くなった → 判断だけ）・入力が同じは除く・最大 max */
export function claudeTargets(cmps: Array<{ id: string; cmp: Cmp }>, o: { exclude?: Set<string>; max?: number } = {}): string[] {
  const rank: Partial<Record<Cmp, number>> = { worse: 0, better: 1, changed: 2 };
  return cmps.filter((c) => rank[c.cmp] !== undefined && !o.exclude?.has(c.id)).sort((a, b) => rank[a.cmp]! - rank[b.cmp]!).slice(0, o.max ?? SCREEN.claudeMax).map((c) => c.id);
}
/**
 * pro の答えと Claude の答えを合わせた判定: Claude を流した問題は Claude の比べで決める（前が無い・答えが無い時は pro のまま）
 */
export function finalCmpOf(pro: Cmp, claude: Cmp | undefined): { cmp: Cmp; by: "pro" | "claude" } {
  return claude && claude !== "nocur" && claude !== "nobase" ? { cmp: claude, by: "claude" } : { cmp: pro, by: "pro" };
}

/**
 * 前の回で flash の今と前が違った割合（ふるった問題のうち・抜き取りは含めない）。記録が無い時は def
 *   既定 0.5＝pro の台帳（10/15〜 brain 851行）で前と同じ（same）が 50%（429）・形だけ違う 26%・道/合格/判断が違う 23%
 */
export function escalateRateOf(st: ScreenStats, def = 0.5): number {
  const rs = (st.runs ?? []).filter((r) => r.screened > 0).slice(-20);
  const s = rs.reduce((a, r) => a + r.screened, 0);
  return s ? rs.reduce((a, r) => a + (r.screened - r.flashSame), 0) / s : def;
}

/**
 * 1回あたりの見込み（ブレインの段・判定は除く）。q 問・pro なら回 reps（自信の回の平均）。
 *   前: pro q×reps。後: flash q×1（今）＋ flash q×1×baseShare（前＝main の flash の答え・同じ main の版を使う担当で割る）＋ pro（esc×q）×reps
 *   esc は「flash で違った割合」＋（残りの）抜き取り
 */
export function estimateScreen(o: { q: number; reps: number; flashDiffRate: number; auditRate?: number; unitPro: number; unitFlash: number; baseShare?: number }): { before: number; after: number; escalated: number } {
  const audit = o.auditRate ?? SCREEN.auditRate;
  const escalated = o.q * (o.flashDiffRate + (1 - o.flashDiffRate) * audit);
  const before = o.q * o.reps * o.unitPro;
  const after = o.q * o.unitFlash * (1 + (o.baseShare ?? 1 / 3)) + escalated * o.reps * o.unitPro;
  return { before, after, escalated };
}
