// app/lib/sent-image-fact.ts — 手の画像の送付を行動台帳の物件の送付にする中身（純関数・DB なし）。書くのは sent-facts.recordStaffImageSentFact
// 2026-11-24 作業員L（台帳 #672・SENT_IMAGE_FACT 既定 off）。説明は app/lib/sent-facts.ts の同じ日付の段
import type { LedgerEntry } from "./action-ledger";
type FactLike = Pick<LedgerEntry, "kind" | "status" | "evidence" | "detail">;
export const sentImageFactOn = (env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}) => (env.SENT_IMAGE_FACT ?? "").trim().toLowerCase() === "on";
/** 手の画像の送付の記録の中身（純関数）。書かない時は null（AIX の画像・照合できなかった・新しく書かなかった行）。 */
export function staffImageSentEntry(o: { source: string; matched: boolean; sentProperties: string; propertyName: string | null; roomNo?: string | null }): FactLike | null {
  if (o.source !== "staff_image" || !o.matched || o.sentProperties !== "inserted") return null;
  const name = (o.propertyName ?? "").trim();
  if (!name) return null;
  const room = (o.roomNo ?? "").trim();
  const label = room ? `${name} ${room}${/号室$/.test(room) ? "" : "号室"}` : name;
  return { kind: "properties_sent", status: "done", evidence: "[画像]", detail: { propertyNames: [label], propertyCount: 1 } } as FactLike;
}
