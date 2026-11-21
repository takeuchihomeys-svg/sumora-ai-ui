// scripts/lib/timeline-coverage.ts — お客様の言った日時（時の言葉）が、絶対の日付に直されて今の状況の記録（meta.situation_now.timeline.words）に入っているかを数える（純関数）
//
// 2026-11-21 作業員L（台帳 #7「時系列（いつ言った・いつした）の把握」の続き・統括役の頼み）。
//   1番 = 会話の今の判断（suggested_aix_meta）と、その判断より前のお客様の発言（直近40通・BRAIN_SITUATION_TIMELINE と同じ窓）。
//   期待 = その発言を resolveTimeWords で読んだ時の言葉（問いの文は除く・buildTimeline と同じ線）／記録 = meta.situation_now.timeline.words。
//   入った = 期待の言葉が記録にある（言葉と絶対の日付の始まりが同じ）。漏れ = 期待にあって記録に無い。余り = 記録にあって期待に無い（窓の外・後の発言）。
//   記録が無い番（situation_now が無い・timeline が無い）は「記録なし」で分けて数える（スイッチ off・古い判断）。
import { buildTimeline } from "../../app/lib/situation-timeline";

export type TlMsg = { text: string | null; atMs: number };
export type TlRecWord = { word: string; said?: string; from?: string | null };
export type TlTurn = { conv: string; msgs: ReadonlyArray<TlMsg>; recWords: ReadonlyArray<TlRecWord> | null; nowMs: number; /** ブレインが読む窓（直近 BRAIN_MSG_WINDOW 通）の始まり。これより前の発言の言葉は「窓の外」 */ windowStartMs?: number | null };
export type TlResult = { conv: string; expected: number; hit: number; missing: string[]; extra: number; noRecord: boolean; outOfWindow: number; outOfWindowHit: number };

const day = (ms: number | null | undefined) => (ms == null || !Number.isFinite(ms) ? "" : new Date(ms + 9 * 36e5).toISOString().slice(0, 10));
export function timelineCoverageOf(t: TlTurn): TlResult {
  const exp = buildTimeline({ customerMsgs: t.msgs.slice(-40), calendar: [], nowMs: t.nowMs }).words;
  const out = (w: { saidAtMs: number }) => t.windowStartMs != null && w.saidAtMs < t.windowStartMs;
  if (!t.recWords) return { conv: t.conv, expected: exp.length, hit: 0, missing: exp.map((w) => w.word), extra: 0, noRecord: true, outOfWindow: exp.filter(out).length, outOfWindowHit: 0 };
  const recKey = new Set(t.recWords.map((w) => `${w.word}|${day(w.from ? Date.parse(w.from) : null)}`));
  const expKey = exp.map((w) => ({ w: w.word, k: `${w.word}|${day(w.fromMs)}`, out: out(w) }));
  const hit = expKey.filter((x) => recKey.has(x.k)).length;
  const missing = expKey.filter((x) => !recKey.has(x.k)).map((x) => x.w);
  const expSet = new Set(expKey.map((x) => x.k));
  return { conv: t.conv, expected: exp.length, hit, missing, extra: [...recKey].filter((k) => !expSet.has(k)).length, noRecord: false, outOfWindow: expKey.filter((x) => x.out).length, outOfWindowHit: expKey.filter((x) => x.out && recKey.has(x.k)).length };
}
export function summarizeTimeline(rs: ReadonlyArray<TlResult>): { turns: number; withWords: number; noRecord: number; expected: number; hit: number; outOfWindow: number; outOfWindowHit: number; missingTop: Array<[string, number]> } {
  const withWords = rs.filter((r) => r.expected > 0);
  const miss = new Map<string, number>();
  for (const r of withWords) for (const w of r.missing) miss.set(w, (miss.get(w) ?? 0) + 1);
  return {
    turns: rs.length, withWords: withWords.length, noRecord: withWords.filter((r) => r.noRecord).length,
    expected: withWords.filter((r) => !r.noRecord).reduce((a, r) => a + r.expected, 0), hit: withWords.filter((r) => !r.noRecord).reduce((a, r) => a + r.hit, 0),
    outOfWindow: withWords.filter((r) => !r.noRecord).reduce((a, r) => a + r.outOfWindow, 0), outOfWindowHit: withWords.filter((r) => !r.noRecord).reduce((a, r) => a + r.outOfWindowHit, 0),
    missingTop: [...miss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}
