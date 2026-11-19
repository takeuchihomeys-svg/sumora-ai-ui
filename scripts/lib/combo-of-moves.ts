// scripts/lib/combo-of-moves.ts — 竹内さんの実送信から「返信と AIX の組」を読む（純関数・2026-11-13 作業員7b・scripts/audit-combo-vs-takeuchi.ts が使う）
import type { SendCombo } from "../../app/lib/send-combo-table";

export type StaffMove = { at: number; aix: boolean; writer: string | null; customer?: boolean; /** AIX の種類（aix_usage_logs の近い行から・assignAixKinds） */ aixKind?: string | null };
/** 物件オススメ＋ピックアップは1つの束（オススメ1＋9 の型・竹内さんの初回10件）。同じ束の AIX が続くのは AIX → AIX ではない */
const bundleOf = (k: string | null | undefined): string | null => { const b = String(k ?? "").split("/")[0]; return /^(?:property_send|property_recommendation)$/.test(b) ? "property_bundle" : b || null; };
/**
 * 2026-11-19 作業員M（台帳 #404・組の表の次の穴: 物件を送る でブレインは AIX だけ・竹内さんは AIX → AIX 19件／60日）:
 *   AIX の通に種類を付ける（その通の時刻の前10分〜後2分に押した AIX の記録・staff-first-move と同じ線）。付けられない通は null のまま
 */
export function assignAixKinds(moves: readonly StaffMove[], aixLogs: ReadonlyArray<{ at: number; aixType: string }>): StaffMove[] {
  return moves.map((m) => {
    if (!m.aix || m.aixKind) return m;
    const near = aixLogs.filter((a) => a.at >= m.at - 10 * 60_000 && a.at <= m.at + 2 * 60_000).sort((a, b) => Math.abs(a.at - m.at) - Math.abs(b.at - m.at))[0];
    return near ? { ...m, aixKind: near.aixType } : m;
  });
}
/** 竹内さんの組（純関数）。moves はお客様の番の後の通（時刻順・お客様の次の発言で切る） */
export function takeuchiCombo(turnAt: number, moves: readonly StaffMove[]): SendCombo | null {
  const ms: StaffMove[] = [];
  for (const m of [...moves].filter((x) => x.at >= turnAt && x.at - turnAt < 24 * 3_600_000).sort((a, b) => a.at - b.at)) { if (m.customer) break; ms.push(m); }
  if (!ms.length) return null;
  // AIX の通（画像・本文が続く）は1つにまとめる（60秒以内に続く AIX の通）
  const seq: StaffMove[] = [];
  //   2026-11-19 作業員M: 同じ束の AIX（オススメ＋ピックアップ）は、間に返信が無く10分以内なら1つ（種類が付いている時だけ・付いていなければ今まで通り60秒）
  for (const m of ms) {
    const last = seq[seq.length - 1];
    if (last && last.aix && m.aix && m.at - last.at <= 60_000) continue;
    if (last && last.aix && m.aix && m.at - last.at <= 10 * 60_000 && bundleOf(last.aixKind) && bundleOf(last.aixKind) === bundleOf(m.aixKind)) { last.at = m.at; continue; }
    seq.push({ ...m });
  }
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
