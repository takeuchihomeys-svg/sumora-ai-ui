// app/lib/pickup-understand-map.ts — AIX ツールが物件を理解する土台の地図（純関数・DB/LLM なし・作業員P・2026-11-23・台帳 #479・前の作業員K2 の分）
//
// 竹内さん本人のピックアップの番（送った物件1件＝1番）で、AIX の材料に「物件ごとの事実・合う点・合わない点・読めていない欄」がどれだけ揃っているかを数える。
//   欄ごとの埋まり方は作業員K2 の scripts/audit-pickup-understanding.ts の FIELDS・fieldStates と同じ（埋まっている／元はあるのに空＝届いていない／元も無い＝読めていない）。
//   「なぜ選んだか」は作業員A の growth:pickup_select:理由あり（audit-pickup-select-link）が数える＝ここでは数えない（重ねない）。
//   木: 欄の群（事実・合う点と合わない点・設備）→ 欄 → 外れの型（届いていない／読めていない）。

export type FieldState = "filled" | "gap" | "none";
/** 欄の群（K2 の FIELDS の鍵を群に分ける）。fit（お客様の条件との合い方の判定）は A の「選んだ理由」と重なるので入れない */
export const PICKUP_FIELD_GROUP: Record<string, "facts" | "points" | "equip"> = {
  name: "facts", room: "facts", rent: "facts", admin: "facts", plan: "facts", area: "facts", walk: "facts", age: "facts", vacancy: "facts", initial_cost: "facts",
  reasons: "points",
  equip: "equip", counter_kitchen: "equip", stove: "equip",
};
export const PICKUP_GROUP_JA: Record<string, string> = { facts: "物件の事実", points: "合う点・合わない点（判定の札）", equip: "設備" };
export const PICKUP_FIELD_JA: Record<string, string> = {
  name: "名前", room: "号室", rent: "家賃", admin: "管理費", plan: "間取り", area: "広さ", walk: "駅徒歩", age: "築年", vacancy: "空き・入居時期", initial_cost: "初期費用",
  reasons: "推す点・合わない点", equip: "設備", counter_kitchen: "カウンターキッチンの有無", stove: "コンロ",
};

/** 監査の1行（送った物件1件） */
export type PickupUnderstandRow = { id: string; conv: string; at: string; states: Record<string, FieldState> };
/** 木の番に（純関数）: 1件の欄ごとに1番。外れの型＝field_gap（元はあるのに AIX の欄が空＝届いていない）／field_none（元も無い＝読めていない） */
export function pickupUnderstandTurnsOf(rows: readonly PickupUnderstandRow[]) {
  const out: Array<{ id: string; kind: string; scene: string; miss: "ok" | "field_gap" | "field_none"; cause: "material" | null }> = [];
  for (const r of rows) for (const [k, s] of Object.entries(r.states)) {
    const g = PICKUP_FIELD_GROUP[k];
    if (!g) continue;
    out.push({ id: `${r.id}:${k}`, kind: g, scene: k, miss: s === "filled" ? "ok" : s === "gap" ? "field_gap" : "field_none", cause: s === "filled" ? null : "material" });
  }
  return out;
}
/** 群ごとの数え（純関数）: 揃っている割合（欄×件）・届いていない・読めていない */
export function pickupUnderstandSummaryOf(rows: readonly PickupUnderstandRow[]) {
  const by: Record<string, { n: number; filled: number; gap: number; none: number }> = {};
  for (const t of pickupUnderstandTurnsOf(rows)) {
    const s = (by[t.kind] ??= { n: 0, filled: 0, gap: 0, none: 0 });
    s.n++; if (t.miss === "ok") s.filled++; else if (t.miss === "field_gap") s.gap++; else s.none++;
  }
  return by;
}
