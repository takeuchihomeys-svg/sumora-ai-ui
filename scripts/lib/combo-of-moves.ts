// scripts/lib/combo-of-moves.ts — 竹内さんの実送信から「返信と AIX の組」を読む（純関数・2026-11-13 作業員7b・scripts/audit-combo-vs-takeuchi.ts が使う）
import type { SendCombo } from "../../app/lib/send-combo-table";

export type StaffMove = { at: number; aix: boolean; writer: string | null; customer?: boolean };
/** 竹内さんの組（純関数）。moves はお客様の番の後の通（時刻順・お客様の次の発言で切る） */
export function takeuchiCombo(turnAt: number, moves: readonly StaffMove[]): SendCombo | null {
  const ms: StaffMove[] = [];
  for (const m of [...moves].filter((x) => x.at >= turnAt && x.at - turnAt < 24 * 3_600_000).sort((a, b) => a.at - b.at)) { if (m.customer) break; ms.push(m); }
  if (!ms.length) return null;
  // AIX の通（画像・本文が続く）は1つにまとめる（60秒以内に続く AIX の通）
  const seq: StaffMove[] = [];
  for (const m of ms) { const last = seq[seq.length - 1]; if (last && last.aix && m.aix && m.at - last.at <= 60_000) continue; seq.push(m); }
  const [a, b] = seq;
  if (!a.aix) {
    const firstAix = seq.find((m) => m.aix);
    if (firstAix && firstAix.at - a.at <= 120_000) return "reply_then_aix_quick";
    if (firstAix) return "promise_then_aix_later";
    return b && !b.aix && b.at - a.at <= 10 * 60_000 ? "reply_reply" : "reply_only";
  }
  if (b && !b.aix && b.at - a.at <= 10 * 60_000) return "aix_then_reply";
  if (b && b.aix && b.at - a.at <= 10 * 60_000) return "aix_then_aix";
  return "aix_only";
}
