// app/lib/search-focus.ts — 会話画面の「🔍 物件検索」→ 拡張のお客様の一覧の一番上へ（純関数・画面とサーバーの両方から使える・DB/fetch 無し）
//
// 2026-10-06 竹内（会話「H0N0KA.」・状態の帯を指して）「ここ広げたところに物件検索ボタンを出す。そうすると拡張ツール繰り上げられるようにする」
//   追加「スマホで押しても連携して拡張ツールのお客さんの一番上に繰り上がるようにする」
// 印は property_search_focus（お客様ごとに1行・押し直しで上書き）。消す書き込みはしない＝拡張の search-focus.js が
//   「押した後に検索した・送った・24時間たった」で効いていない印として扱う（同じ線: FOCUS_TTL_MS）。

/** 印が効く長さ（拡張の chrome-extension/search-focus.js の TTL_MS と同じ値） */
export const FOCUS_TTL_MS = 24 * 60 * 60 * 1000;

export type FocusDevice = "phone" | "pc";

/** 押した端末（User-Agent から・スマホ／PC だけ） */
export function deviceOf(ua: string | null | undefined): FocusDevice {
  return /iPhone|iPad|iPod|Android|Mobile/i.test(String(ua ?? "")) ? "phone" : "pc";
}

/** 条件の列の日本語（画面の「条件の最後の更新」用） */
const FIELD_JA: Record<string, string> = {
  desired_area: "希望エリア", rent_max: "家賃の上限", rent_min: "家賃の下限", floor_plan: "間取り",
  floor_area_min: "広さ", floor_area_max: "広さの上限", walk_minutes: "駅徒歩", building_age: "築年数",
  move_in_time: "入居時期", initial_cost_limit: "初期費用", other_requests: "その他", commute_station: "通勤先",
  commute_minutes: "通勤時間", preferences: "こだわり", ng_points: "NG", pet: "ペット", area_mode: "駅／地域",
};
export function conditionFieldJa(f: string): string {
  return FIELD_JA[f] ?? f;
}

export type ConditionHistoryRow = { changed_field: string; old_value: string | null; new_value: string | null; source_message_id: string | null; created_at: string };
export type LastConditionChange = { at: string; writer: string | null; fields: Array<{ field: string; label: string; old: string | null; new: string | null }> };

/**
 * 条件の変更の履歴（新しい順）から「一番新しい変更の束」（一番新しい行から WINDOW_MS 以内の行）をまとめる（純）。
 *   同じ列が束の中で複数回あれば一番新しい値だけ。履歴が無ければ null
 */
export function lastConditionChange(rows: ConditionHistoryRow[], windowMs = 2 * 60 * 1000): LastConditionChange | null {
  const sorted = [...(rows ?? [])].filter((r) => r && r.created_at).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!sorted.length) return null;
  const top = Date.parse(sorted[0].created_at);
  const seen = new Set<string>();
  const fields: LastConditionChange["fields"] = [];
  for (const r of sorted) {
    if (top - Date.parse(r.created_at) > windowMs) break;
    if (seen.has(r.changed_field)) continue;
    seen.add(r.changed_field);
    fields.push({ field: r.changed_field, label: conditionFieldJa(r.changed_field), old: r.old_value, new: r.new_value });
  }
  const src = String(sorted[0].source_message_id ?? "");
  const writer = src ? (src.split(":")[0] || null) : null;
  return { at: sorted[0].created_at, writer, fields };
}

/** 書き手の日本語（condition-history.ts の ConditionWriter） */
export function conditionWriterJa(w: string | null | undefined): string {
  switch (w) {
    case "p4": case "path_c": case "brain_bridge": case "condition_brain": return "LINE から自動";
    case "format": return "フォームから自動";
    case "screen_edit": return "画面で編集";
    case "undo": return "元に戻した";
    case "restore": return "戻した";
    default: return "";
  }
}
