/**
 * リアプロのボタン・欄を「1つずつ」理解して強化するための台帳（2026-11-16）
 *
 *   竹内さん「1つずつリアプロのボタンのことを理解すればより強化する」
 *   竹内さん「リアプロとitandiのボタンや仕様をすべて細かく把握する／この考え方は大切にする」
 *
 * ⚠ 純関数。サイトは realpro 専用（itandi/reins は混ぜない）。
 * ★ 2026-11-17 作業員A洗い出し: 地域の設定へ進む・pref_code・structured_type・go_search 等を追加。
 */

export type RealproButton = {
  /** 束・課題で使う正名 */
  id: string;
  /** 画面上の呼び方 */
  label: string;
  /** select / checkbox / button / modal / text */
  kind: "select" | "checkbox" | "button" | "modal" | "text";
  /** 別名・課題表記 */
  aliases?: string[];
};

/** 検索フォームで1つずつ押す・理解する対象（上から下・モーダル段含む） */
export const REALPRO_BUTTONS: readonly RealproButton[] = [
  { id: "住居検索", label: "住居検索（左メニュー）", kind: "button", aliases: ["住居", "左の住居検索"] },
  { id: "所在地絞り込み＋", label: "所在地絞り込み＋", kind: "button", aliases: ["所在地", "区を選ぶ"] },
  { id: "pref_code", label: "都道府県（大阪府）", kind: "checkbox", aliases: ["大阪府", "pref"] },
  { id: "city_code[]", label: "区・市チェック", kind: "checkbox", aliases: ["区を選ぶ", "市区郡", "one_city"] },
  { id: "地域の設定へ進む", label: "地域の設定へ進む", kind: "button", aliases: ["詳細な地域の設定へ進む", "next_step_button2", "ward_next"] },
  { id: "town_code[]", label: "町字チェック", kind: "checkbox", aliases: ["町字", "詳細地域", "one_town"] },
  { id: "沿線・駅絞り込み＋", label: "沿線・駅絞り込み＋", kind: "button", aliases: ["沿線を選ぶ"] },
  { id: "route_id[]", label: "沿線チェック", kind: "checkbox", aliases: ["沿線を選ぶ", "路線", "one_line"] },
  { id: "駅の設定へ進む", label: "駅の設定へ進む", kind: "button", aliases: ["駅へ進む"] },
  { id: "station_id[]", label: "駅チェック", kind: "checkbox", aliases: ["駅を選ぶ", "one_station"] },
  { id: "沿線の設定へ戻る", label: "沿線の設定へ戻る", kind: "button", aliases: ["沿線を選び直す", "路線を選び直す"] },
  { id: "確定してリストへ", label: "確定してリストへ", kind: "button", aliases: ["confirm_list", "リストへ", "決定", "この条件で絞り込む"] },
  { id: "×とじる", label: "×とじる（確定の劣後）", kind: "button", aliases: ["this_window_close", "とじる"] },
  { id: "transportation_id", label: "移動手段", kind: "select", aliases: ["徒歩プルダウン"] },
  { id: "required_time", label: "駅徒歩（分）", kind: "text", aliases: ["徒歩"] },
  { id: "update_date", label: "更新日", kind: "select" },
  { id: "rental_cost1", label: "賃料下限", kind: "select" },
  { id: "rental_cost2", label: "賃料上限", kind: "select" },
  { id: "include_common_fee", label: "管理費・共益費込み", kind: "checkbox", aliases: ["管理費・共益費含む", "共益費"] },
  { id: "deposit_recommpence", label: "敷金・礼金なし", kind: "checkbox", aliases: ["敷金礼金なし", "敷礼なし"] },
  { id: "structured_date", label: "築年数", kind: "select", aliases: ["築年"] },
  { id: "structured_type[]", label: "構造", kind: "checkbox", aliases: ["構造タイプ", "鉄筋"] },
  { id: "square_meter_l", label: "面積下限", kind: "select" },
  { id: "square_meter_h", label: "面積上限", kind: "select" },
  { id: "間取り絞り込み＋", label: "間取り絞り込み＋", kind: "button", aliases: ["間取り絞り込み"] },
  { id: "room_layout_id[]", label: "間取り", kind: "checkbox" },
  { id: "絞り込み条件＋", label: "絞り込み条件＋", kind: "button", aliases: ["絞り込み条件", "検索条件を表示"] },
  { id: "eq_rm[]", label: "ペット相談", kind: "checkbox", aliases: ["ペット"] },
  { id: "go_search", label: "検索（DOM）", kind: "button", aliases: ["go_search_submit"] },
  { id: "検索", label: "検索", kind: "button", aliases: ["検索を押す", "物件を検索する", "条件で検索"] },
] as const;

/** 別名 → 正名 */
export function resolveRealproButtonId(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  for (const b of REALPRO_BUTTONS) {
    if (b.id === s || b.label === s) return b.id;
    if ((b.aliases || []).some((a) => a === s || s.includes(a) || a.includes(s))) return b.id;
  }
  // 既知の name 属性はそのまま
  if (/^[a-z_]+(\[\])?$/i.test(s)) return s;
  return null;
}

/**
 * 弱い課題表記をリアプロ正名に直し、**1つずつ**の強化順にする。
 *   台帳の並び（フォーム上の流れ）を優先し、台帳外は末尾。
 */
export function orderRealproButtonsOneByOne(names: string[]): string[] {
  const resolved = names
    .map((n) => resolveRealproButtonId(n) || String(n || "").trim())
    .filter(Boolean);
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const id of resolved) {
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push(id);
  }
  const order = REALPRO_BUTTONS.map((b) => b.id);
  const ranked = [...uniq].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia < 0 && ib < 0) return a.localeCompare(b);
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  });
  return ranked;
}

export function realproButtonLabel(id: string): string {
  const b = REALPRO_BUTTONS.find((x) => x.id === id);
  return b ? b.label : id;
}
