/**
 * ITANDI BB のボタン・欄を「1つずつ」理解して強化するための台帳（2026-11-17）
 *
 *   竹内さん「リアプロとitandiのボタンや仕様をすべて細かく把握する／この考え方は大切にする」
 *
 * ⚠ 純関数。サイトは itandi 専用（リアプロと路線名・駅名表記を混ぜない）。
 * ⚠ リアプロ台帳（realpro-buttons.ts）と id を揃えない（同じ「間取り」でも name が違う）。
 * ★ 2026-11-17 作業員B洗い出し: filter_wards_open・chip・offer_conditions_updated_at 等を正本化。
 */

export type ItandiButton = {
  /** 束・課題で使う正名（ITANDI の name / 画面ラベル） */
  id: string;
  /** 画面上の呼び方 */
  label: string;
  /** select / checkbox / button / modal / text / radio / chip / nav */
  kind: "select" | "checkbox" | "button" | "modal" | "text" | "radio" | "chip" | "nav";
  /** 別名・課題表記 */
  aliases?: string[];
  /** DOM のヒント（学習・監査用・任意） */
  domHint?: string;
};

/**
 * 検索フォームで1つずつ押す・理解する対象（所在地/路線→条件→検索）。
 *   正本: itandi-page-script.js / itandi-form-guard.js / itandi-update-days.js
 */
export const ITANDI_BUTTONS: readonly ItandiButton[] = [
  { id: "filter_wards_open", label: "所在地で絞り込み", kind: "button", aliases: ["エリアで絞り込む", "所在地を絞り込む", "地域で絞り込む"] },
  { id: "filter_stations_open", label: "路線・駅で絞り込み", kind: "button", aliases: ["沿線・駅で絞り込む", "路線で絞り込む", "路線を選ぶ"] },
  { id: "modal_nav_kinki", label: "近畿", kind: "nav", aliases: ["regionName", "地方"] },
  { id: "modal_nav_osaka", label: "大阪府", kind: "nav", aliases: ["prefectureId"] },
  { id: "batchCity_select", label: "大阪市一括", kind: "modal", aliases: ["大阪市内全区", "batchCity"] },
  { id: "city_radio", label: "市区町村", kind: "radio", aliases: ["区", "市", "ward"] },
  { id: "ward_chip", label: "所在地チップ", kind: "chip", aliases: ["区チップ"] },
  { id: "modal_confirm", label: "確定", kind: "button", aliases: ["確定して閉じる"] },
  { id: "modal_close", label: "閉じる", kind: "button", aliases: ["aria-label=閉じる", "close"] },
  { id: "line_checkbox", label: "路線チェック", kind: "checkbox", aliases: ["路線名", "大阪メトロ"] },
  { id: "station_checkbox", label: "駅チェック", kind: "checkbox", aliases: ["駅名", "駅を選ぶ"] },
  { id: "station_chip", label: "路線・駅チップ", kind: "chip" },
  { id: "rent:gteq", label: "賃料下限", kind: "text", aliases: ["家賃下限"], domHint: 'input[name="rent:gteq"]' },
  { id: "rent:lteq", label: "賃料上限", kind: "text", aliases: ["家賃上限", "万円"], domHint: 'input[name="rent:lteq"]' },
  { id: "totalRentCheck", label: "管理費・共益費込み", kind: "checkbox", aliases: ["共益費込み"], domHint: 'input[name="totalRentCheck"]' },
  { id: "offer_conditions_updated_at:gteq", label: "募集条件更新N日以内", kind: "text", aliases: ["更新日", "itandi_update_days", "募集条件更新"] },
  { id: "station_walk_minutes:lteq", label: "駅徒歩", kind: "text", aliases: ["徒歩", "分"], domHint: 'input[name="station_walk_minutes:lteq"]' },
  { id: "building_age:lteq", label: "築年数", kind: "text", aliases: ["築年", "年以内"] },
  { id: "floor_area_amount:gteq", label: "専有面積下限", kind: "text", aliases: ["面積下限", "㎡"] },
  { id: "floor_area_amount:lteq", label: "専有面積上限", kind: "text", aliases: ["面積上限"] },
  { id: "room_layout:in", label: "間取り", kind: "checkbox", aliases: ["間取りチェック", "1K", "2LDK"], domHint: 'input[name="room_layout:in"]' },
  { id: "structure_type:in", label: "構造", kind: "checkbox", aliases: ["木造", "RC"] },
  { id: "option_id:pet", label: "ペット相談", kind: "checkbox", aliases: ["ペット可", "22010"], domHint: "option_id:all_in#22010" },
  { id: "option_id:bt", label: "バス・トイレ別", kind: "checkbox", aliases: ["バストイレ別", "11010"], domHint: "option_id:all_in#11010" },
  { id: "shikirei_none", label: "敷金・礼金なし", kind: "checkbox", aliases: ["敷金礼金なし", "敷礼なし"] },
  { id: "condition_delete", label: "条件削除", kind: "button", aliases: ["条件クリア", "クリア", "条件リセット", "リセット"] },
  { id: "search", label: "検索", kind: "button", aliases: ["検索する", "この条件で検索"] },
] as const;

/** 別名 → 正名 */
export function resolveItandiButtonId(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  for (const b of ITANDI_BUTTONS) {
    if (b.id === s || b.label === s) return b.id;
    if ((b.aliases || []).some((a) => a === s || s.includes(a) || a.includes(s))) return b.id;
  }
  if (/^[a-z_]+(:[a-z0-9_]+)*$/i.test(s)) return s;
  return null;
}

/** 弱い課題表記を ITANDI 正名に直し、台帳順で1つずつ */
export function orderItandiButtonsOneByOne(names: string[]): string[] {
  const resolved = names
    .map((n) => resolveItandiButtonId(n) || String(n || "").trim())
    .filter(Boolean);
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const id of resolved) {
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push(id);
  }
  const order = ITANDI_BUTTONS.map((b) => b.id);
  return [...uniq].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia < 0 && ib < 0) return a.localeCompare(b);
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  });
}

export function itandiButtonLabel(id: string): string {
  const b = ITANDI_BUTTONS.find((x) => x.id === id);
  return b ? b.label : id;
}
