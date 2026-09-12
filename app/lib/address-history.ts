// 2026-09-12 竹内方針C: 呼び名の決定に使う履歴のつなぎ方（純関数。address-name-server とテストが使う）
import type { AddrMsg } from "./validate-reply";

export type AddressWindowMsg = { sender: string; text?: string | null; createdAt?: string | null; isAix?: boolean | null };
export type AddressDbMsg = { sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

const tsOf = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/** 窓（page / bg から来た直近メッセージ）の前に DB の履歴（新しい順で受け取る）をつなぐ（古い順で返す）。
 *  窓に createdAt があれば窓より前の DB 行だけ、無ければ窓と同じ本文の DB 行を除いてつなぐ。窓の isAix が無ければ DB の is_aix_generated で補う */
export function mergeHistoryForAddress(windowMsgs: AddressWindowMsg[], dbRowsNewestFirst: AddressDbMsg[]): AddrMsg[] {
  const db = [...dbRowsNewestFirst].reverse();
  const aixByKey = new Map<string, boolean>();
  for (const r of db) { const t = tsOf(r.created_at); if (t !== null) aixByKey.set(`${r.sender}|${t}`, !!r.is_aix_generated); }
  const win: AddrMsg[] = windowMsgs.map((m) => {
    const t = tsOf(m.createdAt);
    const isAix = m.isAix ?? (t !== null ? aixByKey.get(`${m.sender}|${t}`) : undefined) ?? null;
    return { sender: m.sender, text: m.text ?? "", createdAt: m.createdAt ?? null, isAix };
  });
  const winTimes = windowMsgs.map((m) => tsOf(m.createdAt)).filter((t): t is number => t !== null);
  let older: AddressDbMsg[];
  if (winTimes.length) {
    const cutoff = Math.min(...winTimes);
    older = db.filter((r) => { const t = tsOf(r.created_at); return t !== null && t < cutoff; });
  } else {
    const keys = new Set(windowMsgs.map((m) => `${m.sender}|${(m.text ?? "").trim()}`));
    older = db.filter((r) => !keys.has(`${r.sender}|${(r.text ?? "").trim()}`));
  }
  return [...older.map((r) => ({ sender: r.sender, text: r.text, createdAt: r.created_at, isAix: !!r.is_aix_generated })), ...win];
}
