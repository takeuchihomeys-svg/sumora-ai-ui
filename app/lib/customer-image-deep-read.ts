/**
 * お客様が送った物件の画像の深い読み（2026-11-21 作業員G・台帳 #461 ②）— 純関数の部分
 *
 * なぜ: お客様が送った物件の画像の記録（customer_image_records）は、受け取り時の書き起こし（Haiku）から文字で拾うだけで、
 *   物件名 36%・駅徒歩 23%・築年 13/21 しか埋まっていなかった（#461 の数え）。画像そのものを DeepSeek の物件の読み
 *   （property-image-read の readPropertyImage・送った画像と同じ読み）で読み、**空の欄だけ**を埋める。
 *
 * 決まり:
 *   - 読むのは物件の種類の画像だけ（物件の資料・ポータルの画面・広告・物件の写真）。書類・人・ペット・見積は読まない（受け取り時の仕分けの線・KB 33a30792）
 *   - 埋めるのは空の欄だけ（書き起こしで読めた値は上書きしない）。物件が2件以上写る画像（一覧）は名前を埋めない
 *   - 読めなかった欄は空のまま（作らない）
 *   - 既定 off（CUSTOMER_IMAGE_DEEP_READ=on）。DeepSeek の回数は月 約80回の見込み（統括役の承認済み・夜に実測）
 */
import type { CustomerImageRecordRow } from "./customer-image-record";
import { ageFromBuiltYm, parseBuilt } from "./candidate-facts";

export const DEEP_READ_KINDS = new Set(["property_material", "property_screen", "property_ad", "property_photo"]);
export const CUSTOMER_IMAGE_DEEP_READ_VERSION = "g1121-deep1";

export function customerImageDeepReadOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CUSTOMER_IMAGE_DEEP_READ ?? "").trim().toLowerCase() === "on";
}

type Row = Pick<CustomerImageRecordRow, "kind" | "property_name" | "room_no" | "rent_yen" | "admin_yen" | "madori" | "area_sqm" | "station" | "walk_min" | "age_years">;

const FIELDS = ["property_name", "room_no", "rent_yen", "admin_yen", "madori", "area_sqm", "station", "walk_min", "age_years"] as const;

/** 深い読みが要るか（物件の種類で、空の欄がある） */
export function deepReadNeeded(row: Row): { need: boolean; missing: string[] } {
  if (!DEEP_READ_KINDS.has(String(row.kind))) return { need: false, missing: [] };
  const missing = FIELDS.filter((k) => row[k] == null || row[k] === "");
  return { need: missing.length > 0, missing };
}

export type DeepReadItem = {
  propertyName?: string | null; roomNumber?: string | null; rent?: number | null; adminFee?: number | null;
  floorPlan?: string | null; areaSqm?: number | null; station?: string | null; walkMinutes?: number | null; built?: string | null;
};

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const str = (v: unknown): string | null => { const s = typeof v === "string" ? v.trim() : ""; return s ? s : null; };

/** 読んだ値で空の欄だけを埋めた差分（埋めた欄だけを返す・何も無ければ空） */
export function deepReadPatch(row: Row, items: ReadonlyArray<DeepReadItem>, now: Date | string = new Date()): Partial<Row> {
  if (!items.length) return {};
  const single = items.length === 1;
  const it = items[0];
  const cand: Partial<Row> = {
    // 一覧（2件以上）は名前・号室・値を埋めない（どの部屋か決められない）。駅・築年は建物の値なので一覧でも同じ建物なら使えるが、作らない側に倒す
    ...(single ? {
      property_name: str(it.propertyName),
      room_no: str(it.roomNumber)?.replace(/号室$/, "") ?? null,
      rent_yen: num(it.rent, 15_000, 1_000_000),
      admin_yen: num(it.adminFee, 0, 100_000),
      madori: str(it.floorPlan),
      area_sqm: num(it.areaSqm, 8, 300),
      station: str(it.station),
      walk_min: num(it.walkMinutes, 0, 60),
      age_years: (() => { const b = str(it.built); if (!b) return null; const pb = parseBuilt(/築|新築/.test(b) ? b : `築年月 ${b}`); return pb.age ?? (pb.ym ? ageFromBuiltYm(pb.ym, now) : null); })(),
    } : {}),
  };
  const patch: Partial<Row> = {};
  for (const k of FIELDS) {
    const cur = row[k];
    const v = cand[k];
    if ((cur == null || cur === "") && v != null && v !== "") (patch as Record<string, unknown>)[k] = v;
  }
  return patch;
}
