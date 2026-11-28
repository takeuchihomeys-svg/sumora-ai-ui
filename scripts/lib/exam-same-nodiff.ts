// scripts/lib/exam-same-nodiff.ts — 前の晩に差なしだった組と同じ組を積む前に見る関所（台帳 #803 ③・統括役の決め 11/28・純関数）
// 2026-11-28 作業員L: 止める条件は全部そろった時だけ＝①前の 36時間に同じ組（係の brain-exam・on のスイッチの組・問題の組が同じ）があり、その結果が差なし
//   （exam-efficiency の classifyJob＝nodiff）②その依頼の後に答えに効くコード（app/・scripts/brain-exam/）のコミットが無い
//   ③材料の元（設計知見・手本・ナレッジ・竹内さんの手本の倉庫・勝ちの型・統括の学び）の行がその後に足されて・直されていない（DB の中身が変わると答えも変わる）。
//   EXAM_SAME_NO_DIFF_GATE: shadow（既定・記録だけ＝止めない・止めた「つもり」を記録して朝の1枚に）／on（止める・--force で越える）／off（見ない）
//   注意: ai_reply_examples・ai_reply_knowledge は created_at しか無い＝足した行は分かるが、直した行は分からない
import { classifyJob } from "./exam-efficiency";

export type SameGateMode = "off" | "shadow" | "on";
export function sameNoDiffMode(env: Record<string, string | undefined> = {}): SameGateMode {
  const v = String(env.EXAM_SAME_NO_DIFF_GATE ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "shadow";
}
export type GateJob = { label: string; runner?: string; env?: Record<string, string>; only?: string; createdAt?: string };
export type GateResult = { worseSure?: unknown[] | null; worseFlake?: unknown[] | null; better?: number | null; worse?: number | null };
const OFF_VAL = /^(?:off|0|false|)$/i;
/** 組の鍵: on のスイッチの組 × 問題の組（順は問わない）。brain-exam で両方ある時だけ */
export function sameKeyOf(j: GateJob): string | null {
  if (j.runner && j.runner !== "brain-exam") return null;
  const sw = Object.entries(j.env ?? {}).filter(([, v]) => !OFF_VAL.test(String(v ?? "").trim())).map(([k, v]) => `${k}=${String(v).trim().toLowerCase()}`).sort();
  const qs = String(j.only ?? "").split(",").map((s) => s.trim()).filter(Boolean).sort();
  if (!sw.length || !qs.length) return null;
  return `${sw.join("&")}|${qs.join(",")}`;
}
export const SAME_WINDOW_H = 36;
/** 前の 36時間で同じ組の一番新しい依頼（差なしかどうかに関わらず・新しい方が差ありなら止めない） */
export function prevSameOf(cand: GateJob, prev: ReadonlyArray<{ job: GateJob; result: GateResult | null }>, nowMs: number): { job: GateJob; result: GateResult | null } | null {
  const key = sameKeyOf(cand);
  if (!key) return null;
  const hits = prev.filter((p) => p.job.label !== cand.label && sameKeyOf(p.job) === key && p.job.createdAt && nowMs - Date.parse(p.job.createdAt) <= SAME_WINDOW_H * 3_600_000 && Date.parse(p.job.createdAt) < nowMs)
    .sort((a, b) => Date.parse(b.job.createdAt!) - Date.parse(a.job.createdAt!));
  return hits[0] ?? null;
}
export type SameVerdict = { wouldSkip: boolean; why: string; prevLabel: string | null };
/** 止める（つもり）か。codeCommits＝前の依頼の後の答えに効くコミットの数（null＝読めない）・materialChanged＝その後に足された／直された材料の元（null＝読めない） */
export function sameNoDiffVerdict(prev: { job: GateJob; result: GateResult | null } | null, codeCommits: number | null, materialChanged: readonly string[] | null): SameVerdict {
  if (!prev) return { wouldSkip: false, why: "前の 36時間に同じ組が無い", prevLabel: null };
  const pl = prev.job.label;
  if (!prev.result) return { wouldSkip: false, why: `前の同じ組 ${pl} の結果がまだ無い`, prevLabel: pl };
  const cls = classifyJob(prev.result);
  if (cls !== "nodiff") return { wouldSkip: false, why: `前の同じ組 ${pl} は差あり（${cls}）`, prevLabel: pl };
  if (codeCommits == null) return { wouldSkip: false, why: `前の同じ組 ${pl} は差なし・コードの差が読めない`, prevLabel: pl };
  if (codeCommits > 0) return { wouldSkip: false, why: `前の同じ組 ${pl} は差なし・その後に答えに効くコミット ${codeCommits}`, prevLabel: pl };
  if (materialChanged == null) return { wouldSkip: false, why: `前の同じ組 ${pl} は差なし・材料の元の更新が読めない`, prevLabel: pl };
  if (materialChanged.length) return { wouldSkip: false, why: `前の同じ組 ${pl} は差なし・その後に材料の元が更新（${materialChanged.join("・")}）`, prevLabel: pl };
  return { wouldSkip: true, why: `前の同じ組 ${pl} は差なし・コードの差なし・材料の元の更新なし`, prevLabel: pl };
}
export type SameMark = { at: string; label: string; prevLabel: string | null; wouldSkip: boolean; mode: SameGateMode; planUsd: number | null; why: string };
/** 朝の1枚の1行（前の 24時間の記録） */
export function sameNoDiffMorningLine(marks: readonly SameMark[], nowMs: number): string | null {
  const recent = marks.filter((m) => nowMs - Date.parse(m.at) <= 24 * 3_600_000);
  if (!recent.length) return null;
  const would = recent.filter((m) => m.wouldSkip);
  const usd = would.reduce((a, m) => a + (Number(m.planUsd) || 0), 0);
  const mode = recent[recent.length - 1].mode;
  return `- 差なしの組の関所（#803 ③・EXAM_SAME_NO_DIFF_GATE=${mode}・前の24時間）: 見た組 ${recent.length}・${mode === "on" ? "止めた" : "止めたつもり"} ${would.length}（見込み $${usd.toFixed(2)}）${would.length ? `｜${would.slice(0, 5).map((m) => `${m.label}←${m.prevLabel}`).join("・")}` : ""}`;
}
