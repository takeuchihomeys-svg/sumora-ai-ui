// app/lib/viewing-slot-plan.ts
// 内覧の候補の枠（「10/2(金) 13:00〜15:00」）の決め方を1か所に置く（純関数・DB 依存なし・画面とサーバーで共用）。
//
// 2026-09-30 竹内さん（YUMA に届いた「10/2(金) 13:00〜16:00／10/3(土) 10:00〜17:00にてご案内可能です」を見て）:
//   「内覧は1件なら1〜2時間の枠でせっていする（他に予定あれば特に気をつける）。予定の住所も踏まえた上で移動時間も含めて考える。
//     ※1件なら内覧30分ほどで完了するけど余裕もってお客さんに提案して内覧組みやすいようにしている。件数も含めて時間の枠ふやす。
//     例えば吹田で用事があって、次に東大阪だと、終了から次のアポまで2時間空けるなど。
//     内覧の始まりは11:00で、終了18:30までで設定行う。10:00〜19:00が営業時間の為（これはお客さんに伝えなくて大丈夫）」
//
// 決まり:
//   ① お客様に出す枠は 11:00 開始〜18:30 終了の中
//   ② 枠の長さは件数で決める（SLOT_LENGTH_BY_COUNT・1件＝1〜2時間）
//   ③ 前後の予定との間は、予定の場所と内覧の場所から移動の目安を空ける（TRAVEL_GAP）。場所が読めない内覧の予定は長め
//   ④ 長い空きはそのまま出さず、枠の長さで切って出す
//   ⑤ 営業時間（10:00〜19:00）はお客様への文に出さない＝この定数は枠の外側の事実として置くだけで、材料・文には渡さない
//
// 実送信（180日・153通・枠305個・scripts/audit-viewing-slot-width.ts）: 11:00 より前に始まる枠 10（3%）・18:30 より後に終わる枠 3（1%）＝①はほぼ今の線。
//   長さは 2時間以下 37%・3時間 35%・4時間以上 26%（9月は 2時間以下 51%）＝②④は今までより短くする側の変更（竹内さんの指示が根拠）。
import { distanceKm, stationPoint, stationsInText, townsInText, wardOfAddress, wardPoint, wardsInText, type LatLon } from "./osaka-geo";

const hm = (h: number, m = 0) => h * 60 + m;

/** お客様に出す枠の範囲（開始は 11:00 から・終了は 18:30 まで） */
export const OFFER_START_MIN = hm(11);
export const OFFER_END_MIN = hm(18, 30);
/** 画面の時間欄の初期値（予定で埋まった日を手で ON にした時など） */
export const VIEWING_DAY_START = "11:00";
export const VIEWING_DAY_END = "18:30";
/** 営業時間。お客様への文・AI の材料には出さない（枠の外側の事実として残すだけ） */
export const BUSINESS_HOURS_INTERNAL = { open: hm(10), close: hm(19) } as const;

/**
 * 件数 → 枠の長さ（分）。1件は実際 30分ほどで終わるが、組みやすいよう余裕を持たせて 1〜2時間。
 * 1件増えるごとに 30分（内覧 30分ぶん。物件どうしの移動は余裕の中）足す。5件以上は 4件と同じ
 */
export const SLOT_LENGTH_BY_COUNT: ReadonlyArray<{ count: number; min: number; max: number }> = [
  { count: 1, min: 60, max: 120 },
  { count: 2, min: 90, max: 150 },
  { count: 3, min: 120, max: 180 },
  { count: 4, min: 150, max: 210 },
];
export function slotLengthFor(count: number | null | undefined): { min: number; max: number } {
  const n = Math.max(1, Math.min(SLOT_LENGTH_BY_COUNT.length, Math.floor(Number(count) || 1)));
  const row = SLOT_LENGTH_BY_COUNT[n - 1];
  return { min: row.min, max: row.max };
}

/**
 * 2026-10-08 8巡目 竹内さん「内覧は1部屋15〜30分程。そこから2件目への移動時間も考える」:
 *   上の表の「1件増えるごとに30分」は内覧そのもの（1部屋15〜30分の上の方）と近い物件どうしの移動を余裕の中に含めた長さ。
 *   内覧する物件どうしが離れている時（物件の場所が2つ以上読めて、一番離れた組が near／far）は、その移動の分を件数の間ごとに足す。
 *   同じ区・市・場所が読めない時は今まで通り（0）。戻す VIEWING_SLOT_MOVE_R8=off
 */
export const INTER_PROPERTY_MOVE: Readonly<Record<"same" | "near" | "far", number>> = { same: 0, near: 30, far: 60 };
export function interPropertyMoveMinutes(count: number | null | undefined, places: ReadonlyArray<PlacePoint>): number {
  if ((typeof process !== "undefined" ? process.env.VIEWING_SLOT_MOVE_R8 : undefined) === "off") return 0;
  const n = Math.max(1, Math.min(SLOT_LENGTH_BY_COUNT.length, Math.floor(Number(count) || 1)));
  if (n < 2 || places.length < 2) return 0;
  let worst: "same" | "near" | "far" = "same";
  for (let i = 0; i < places.length; i++) for (let j = i + 1; j < places.length; j++) {
    const t = travelTierBetween([places[i]], [places[j]]);
    if (t === "far" || (t === "near" && worst === "same")) worst = t;
  }
  return INTER_PROPERTY_MOVE[worst] * (n - 1);
}

/**
 * 前後の予定との間に空ける時間（分）。予定の終わり → 内覧の枠の始まり／内覧の枠の終わり → 予定の始まり の両方に同じ値を使う。
 *   same    … 同じ区・市
 *   near    … 近い区・市（中心どうしが NEAR_KM 以内）
 *   far     … 離れた区・市（竹内さんの例: 吹田 → 東大阪は 2時間）
 *   unknown … 場所が読めない内覧の予定（安全側＝離れた所と同じ）
 *   desk    … 出かけない予定（電話・連絡・申込の作業・時間確保）。今までと同じ 1時間
 */
export type TravelTier = "same" | "near" | "far" | "unknown" | "desk";
export const TRAVEL_GAP: Readonly<Record<TravelTier, number>> = { same: 60, near: 90, far: 120, unknown: 120, desk: 60 };
/** 区・市の中心どうしの距離の線（km）。大阪市内の隣の区は 2〜5km・吹田〜東大阪は 約12km */
export const NEAR_KM = 6;
const SAME_KM = 1.5;

export type PlacePoint = { name: string; point: LatLon };

/**
 * 文（住所・物件名・予定のメモ）から場所を読む。住所（区・市）→ 区・市の名前 → 町名 → 駅名 の順で、先に読めた段だけを使う。
 * 2件以上の内覧のメモは複数の場所が返る（間の計算は一番離れた組で行う＝安全側）
 */
export function placesOfText(text: string | null | undefined): PlacePoint[] {
  const t = String(text ?? "");
  if (!t.trim()) return [];
  const out: PlacePoint[] = [];
  const add = (name: string | null, point: LatLon | null) => { if (name && point && !out.some((o) => o.name === name)) out.push({ name, point }); };
  for (const m of t.matchAll(/住所\s*[:：]?\s*([^\n/]+)/g)) { const w = wardOfAddress(m[1]); add(w, wardPoint(w)); }
  if (out.length > 0) return out;
  { const w = wardOfAddress(t); add(w, wardPoint(w)); }
  for (const w of wardsInText(t)) add(w.ward, wardPoint(w.ward));
  if (out.length > 0) return out;
  for (const w of townsInText(t)) add(w.ward, wardPoint(w.ward));
  if (out.length > 0) return out;
  for (const s of stationsInText(t)) add(`${s.station}駅`, stationPoint(s.station));
  return out;
}
/** 場所の名前だけ（画面の取り直しの合図・表示用） */
export function placeKeyOf(text: string | null | undefined): string {
  return placesOfText(text).map((p) => p.name).sort().join("・");
}

/** 2つの場所（それぞれ複数あり得る）の段。どちらかが読めなければ null */
export function travelTierBetween(a: ReadonlyArray<PlacePoint>, b: ReadonlyArray<PlacePoint>): "same" | "near" | "far" | null {
  if (a.length === 0 || b.length === 0) return null;
  let worst = 0;
  for (const x of a) for (const y of b) worst = Math.max(worst, x.name === y.name ? 0 : distanceKm(x.point, y.point));
  if (worst <= SAME_KM) return "same";
  return worst <= NEAR_KM ? "near" : "far";
}

/** カレンダーの予定1件（分は日本時間の 0:00 からの分） */
export type SlotBusy = {
  start: number;
  end: number;
  /** 場所を読む文（予定のメモ・タスクの本文） */
  text?: string | null;
  /** 出かける内覧の予定か（決まった内覧＝物件・住所のある予定）。false は電話・連絡・作業・時間確保 */
  outing?: boolean;
};

/** 決まった内覧の予定のメモか（物件・住所が書いてある。「【時間確保】」「件数: 1件 物件: （未確定）」「【必ず】連絡」は違う） */
export function isOutingViewingNotes(eventType: string | null | undefined, notes: string | null | undefined): boolean {
  if (eventType !== "viewing") return false;
  const n = notes ?? "";
  if (/^\s*【時間確保】/.test(n) || /物件:\s*（未確定）/.test(n)) return false;
  return /【物件】|【\d+件目】|住所\s*[:：]/.test(n);
}

/** その予定と内覧の間に空ける時間と、その段 */
export function travelGapFor(busy: SlotBusy, viewingPlaces: ReadonlyArray<PlacePoint>): { tier: TravelTier; minutes: number } {
  const tier: TravelTier = (() => {
    if (!busy.outing) {
      // 出かけない予定でも、本文に場所があり内覧の場所も分かる時は場所で決める（「吹田で用事」）
      const t = travelTierBetween(placesOfText(busy.text), viewingPlaces);
      return t === "far" || t === "near" ? t : "desk";
    }
    return travelTierBetween(placesOfText(busy.text), viewingPlaces) ?? "unknown";
  })();
  return { tier, minutes: TRAVEL_GAP[tier] };
}

const fmt = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const ceil30 = (m: number) => Math.ceil(m / 30) * 30;
const floor30 = (m: number) => Math.floor(m / 30) * 30;
/** 予定が無い日に最初に出す時刻（実送信の開始は 12〜13時台が 55%。今までの既定も 13:00 から） */
const EMPTY_DAY_FIRST_START = hm(13);
/** 当日の枠は今から何分後以降に始めるか */
export const SAME_DAY_LEAD_MIN = 60;

export type SlotPlan = {
  /** お客様に出す枠（"13:00〜15:00"）。早い順 */
  slots: string[];
  /** 予定ごとの空け方（点検・テスト用） */
  blocks: Array<{ start: number; end: number; tier: TravelTier; gap: number }>;
};

/**
 * その日の予定から内覧の候補の枠を作る。
 *   busy          … その日の予定
 *   count         … 内覧の件数（既定 1）
 *   place         … 内覧する物件の場所（住所・区・市・駅・物件名。読めなければ決まった内覧の予定とは長めに空ける）
 *   notBeforeMin  … 当日の「今」（分）。これ＋SAME_DAY_LEAD_MIN より後に始まる枠だけ
 *   maxSlots      … 1日に返す枠の数（既定 3）
 */
export function planDaySlots(o: { busy?: ReadonlyArray<SlotBusy>; count?: number | null; place?: string | null; notBeforeMin?: number | null; maxSlots?: number }): SlotPlan {
  const places = placesOfText(o.place);
  const base = slotLengthFor(o.count);
  const move = interPropertyMoveMinutes(o.count, places);
  const { min, max } = { min: base.min + move, max: base.max + move };
  const busy = (o.busy ?? []).filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));
  const blocks = busy.map((b) => {
    const g = travelGapFor(b, places);
    return { start: b.start - g.minutes, end: Math.max(b.end, b.start) + g.minutes, tier: g.tier, gap: g.minutes };
  });
  const merged: Array<[number, number]> = [];
  for (const b of [...blocks].sort((x, y) => x.start - y.start)) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last[1]) last[1] = Math.max(last[1], b.end);
    else merged.push([b.start, b.end]);
  }
  const earliest = Math.max(
    busy.length === 0 ? EMPTY_DAY_FIRST_START : OFFER_START_MIN,
    o.notBeforeMin != null && Number.isFinite(o.notBeforeMin) ? ceil30(o.notBeforeMin + SAME_DAY_LEAD_MIN) : 0,
    OFFER_START_MIN,
  );
  const free: Array<[number, number]> = [];
  let cursor = earliest;
  for (const [s, e] of merged) {
    if (s > cursor) free.push([cursor, Math.min(s, OFFER_END_MIN)]);
    cursor = Math.max(cursor, e);
    if (cursor >= OFFER_END_MIN) break;
  }
  if (cursor < OFFER_END_MIN) free.push([cursor, OFFER_END_MIN]);

  const slots: string[] = [];
  const limit = o.maxSlots ?? 3;
  for (const [fs, fe] of free) {
    let s = ceil30(fs);
    const end = floor30(fe);
    while (end - s >= min && slots.length < limit) {
      const e = Math.min(s + max, end);
      slots.push(`${fmt(s)}〜${fmt(e)}`);
      s = e;
    }
  }
  return { slots, blocks };
}
