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
//   この関数の薄い包みにする（挙動の変わる所は PROPERTY_KEY_UNIFIED・11/04 から既定 on）。今はまだどこも呼んでいない（読み比べの段）
import { buildingKeyOf } from "./customer-state";

/** 間取りの形（1K・1LDK・2SLDK・1R・1DK）＝号室ではない（11/03 夜 読み比べで「1LDK」「1K 202」を号室と読んでいた） */
const LAYOUT_RE = /^\d+(?:S?L?D?K|R)$/;
const LAYOUT_HEAD_RE = /^\d+(?:S?L?D?K|R)(?=\d{3,4}$)/; // 「1K 202」だけ（「8K1」「5K03」のような型の分からない物は外さない）
export function unifiedRoomKey(room: string | null | undefined): string | null {
  let s = String(room ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/号室?$/, "").replace(/^第/, "").toUpperCase().replace(/[‐‑‒–—―ー－]/g, "-");
  // 頭の間取り（「1K 202」→「202」）と階（「1階 102」→「102」）を外す。間取りだけ（「1LDK」）は号室にしない
  s = s.replace(LAYOUT_HEAD_RE, "").replace(/^\d{1,2}階(?=\d)/, "");
  if (LAYOUT_RE.test(s)) return null;
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
/** PROPERTY_KEY_UNIFIED: off／shadow（今まで通りの鍵で動かし、新しい鍵だと答えが変わる号室だけ記録）／on（既定・新しい鍵）
 *  2026-11-04 指揮役: 既定 on（夜の監査 送付済みの線・30日の重複で off/on が全く同じ・英字を落とす誤った寄せ 0＝竹内さんの決定「悪化0なら全部に」）。
 *  on でも答えが変わった号室は property-key:on で記録する（入れた後3日、毎朝この記録と送り直しの数を見て、増えたらその日に =off） */
export function propertyKeyMode(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): "off" | "shadow" | "on" {
  const v = String(env.PROPERTY_KEY_UNIFIED ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "shadow" ? "shadow" : "on";
}
export const propertyKeyUnifiedOn = (env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}) => propertyKeyMode(env) === "on";
const shadowSeen = new Set<string>();
/** 古い関数の答え（legacy）と1つの鍵を合わせる口。on＝1つの鍵（読めなければ legacy）／shadow＝legacy のまま・違う時だけ記録（1つの処理で同じ号室は1回・最大50）／off＝legacy */
export function unifiedRoomOr(fn: string, raw: string | null | undefined, legacy: string): string {
  const mode = propertyKeyMode();
  if (mode === "off") return legacy;
  const u = unifiedRoomKey(raw);
  if (u && u !== legacy) {
    const k = `${fn}|${String(raw)}`;
    if (!shadowSeen.has(k) && shadowSeen.size < 50) { shadowSeen.add(k); console.log(JSON.stringify({ tag: `property-key:${mode}`, fn, raw: String(raw).slice(0, 20), legacy, unified: u })); }
  }
  return mode === "on" ? u ?? legacy : legacy;
}
