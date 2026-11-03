// app/lib/property-key.ts — 物件・お部屋の鍵を1つに（土台の8つ ⑤・2026-11-03 作業員1・作業員2の設計 §3）
//
// 今は号室の正規化が6か所にあり、答えが割れる（例「A0205」: property-brain.normalizeRoomKey と sent-property-record.normalizeRoomNo は
//   英字を落として「205」＝B0205 とぶつかる／listing-text.roomKey は「A0205」／sent-room-match.roomKeyOf は「A205」／
//   customer-state.normalizeRoomNo と own-property-match.normalizeRoom は読めない＝null）。
// ここの1つの形（決めた線）:
//   号室: NFKC（全角→半角）→ 空白・「号室」「号」を外す → 大文字 → 長いハイフンを「-」 → 数字の並びの頭の 0 を外す（0301→301・A0205→A205・005A→5A・B-0101→B-101）
//         数字を1つも含まない・9字以上は号室として読まない（null）
//   建物: customer-state.buildingKeyOf と同じ（NFKC・記号・空白・長音を外し小文字・【N】🌟 を外す）
//   鍵: `${建物}|${号室}`（号室が無ければ建物だけ）
// 古い6つは、scripts/audit-property-key.ts で過去の全件に当てて違いを目で読み、誤った寄せが0になってから
//   この関数の薄い包みにする（挙動の変わる所は PROPERTY_KEY_UNIFIED・既定 off）。今はまだどこも呼んでいない（読み比べの段）
import { buildingKeyOf } from "./customer-state";

export function unifiedRoomKey(room: string | null | undefined): string | null {
  const s = String(room ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/号室?$/, "").replace(/^第/, "").toUpperCase().replace(/[‐‑‒–—―ー－]/g, "-");
  if (!s || s.length > 8 || !/\d/.test(s) || !/^[0-9A-Z-]+$/.test(s)) return null;
  return s.replace(/(^|[^0-9])0+(?=\d)/g, "$1");
}
export function unifiedBuildingKey(name: string | null | undefined): string {
  return buildingKeyOf(String(name ?? "").replace(/^【\s*\d+\s*(?:🌟|★|☆)*\s*】\s*/u, "").replace(/^[🌟★☆\s]+/u, ""));
}
export function propertyKey(building: string | null | undefined, room: string | null | undefined): string | null {
  const b = unifiedBuildingKey(building);
  if (b.length < 2) return null;
  const r = unifiedRoomKey(room);
  return r ? `${b}|${r}` : b;
}
export const propertyKeyUnifiedOn = (env: Record<string, string | undefined> = process.env) => String(env.PROPERTY_KEY_UNIFIED ?? "").trim().toLowerCase() === "on";
