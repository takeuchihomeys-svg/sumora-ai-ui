// app/lib/aix-boundary.ts — AIX の隣どうしの境目（台帳 #688・竹内さん「ここ大切に」・決まった表・LLM なし）
// 2026-11-26 作業員A（統括役の頼み）: AIX の種類ごとの辞書（aix-catalog の when／lines）に、今日までに分かった「隣の AIX・返信との境目」を足す。
//   境目の出所（どれも竹内さん本人の番か竹内さんの決め）:
//     #744 割れる番の分かれ目: 直前のこちらの文が確認の約束 × お客様がお礼だけ → 物件確認した（AIX 13/14）／お客様が別の問い → 返信が先
//     竹内さんの決め 11/25（確認の約束の後 4つ）・11/26（探す約束の後のお礼: 送れる候補の有無）
//     q059・q069（Claude の確かめ）: 一般的な流れ・広告の仕組みの説明は返信で答える（物件確認した ではない）
//   ブレインには材料の1行で渡す（答えの規則ではない・判断は上書きしない）。MATERIAL_PRIORITY の控えの行（キー aix_boundary）に乗せる。
//   スイッチ AIX_BOUNDARY_LINE: 既定 off（材料に入れない）／on
export function aixBoundaryLineOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_BOUNDARY_LINE ?? "").trim().toLowerCase() === "on";
}
export type Boundary = { id: string; aix: string; vs: string; when: string; take: string; source: string };
/** 境目の表（左の AIX と右＝隣の AIX か返信。when の時は take） */
export const AIX_BOUNDARIES: readonly Boundary[] = [
  { id: "check_ack_wait", aix: "property_check_result", vs: "返信", when: "お客様が送ってきた物件の確認を約束済み・結果はまだ・お客様はお礼／了承だけ", take: "返信は書かず、確認の結果が揃ったら AIX【物件確認した】", source: "竹内さんの決め 11/25 ①・#744 13/14" },
  { id: "check_question", aix: "返信", vs: "property_check_result", when: "確認の約束の後に、お客様が別の問いを足した", take: "まず問いに返信・確認の結果は後で【物件確認した】", source: "竹内さんの決め 11/25 ②" },
  { id: "check_brought_new", aix: "返信", vs: "property_check_result", when: "お客様が今の通で物件を送ってきた・まだ確認の約束をしていない", take: "まず「確認させて頂きます」の約束の返信（結果が手元にある時だけすぐ【物件確認した】）", source: "竹内さんの決め 11/25 ③" },
  { id: "check_ack_plus", aix: "返信", vs: "property_check_result", when: "確認の約束の後、お客様が了承に一言足した", take: "足した所に返信・結果が揃ったら【物件確認した】", source: "竹内さんの決め 11/25 ④" },
  { id: "pickup_ack_ready", aix: "property_send", vs: "返信", when: "探す約束の後、お客様がお礼だけ・送れる候補が揃っている", take: "返信は書かず AIX【物件ピックアップした】", source: "竹内さんの決め 11/26（揃っている時 AIX 2/2）" },
  { id: "pickup_ack_not_ready", aix: "返信", vs: "property_send", when: "探す約束の後、お客様がお礼だけ・送れる候補がまだ揃っていない", take: "受けの短い返信（揃い次第お送り）・揃ったら【物件ピックアップした】", source: "竹内さんの決め 11/26（揃っていない時 返信 4/6）" },
  { id: "general_explain", aix: "返信", vs: "property_check_result", when: "退去予定の部屋の一般的な流れ・広告の仕組みなど、物件ごとの確かめが要らない説明を聞かれた", take: "確かめずに返信で説明する（確認の約束・物件確認した ではない）", source: "q059・q069（竹内さん本人は返信）" },
];
export type BoundaryCtx = { checkScene: string | null; pickupScene: string | null; customerAsked: boolean };
/** 今の番に当たる境目（純関数） */
export function boundariesFor(c: BoundaryCtx): Boundary[] {
  const ids: string[] = [];
  if (c.checkScene === "ack_wait") ids.push("check_ack_wait");
  if (c.checkScene === "question_after_promise") ids.push("check_question");
  if (c.checkScene === "brought_no_promise") ids.push("check_brought_new");
  if (c.checkScene === "ack_plus") ids.push("check_ack_plus");
  if (c.pickupScene === "ack_ready") ids.push("pickup_ack_ready");
  if (c.pickupScene === "ack_not_ready") ids.push("pickup_ack_not_ready");
  if (c.customerAsked && !ids.length) ids.push("general_explain");
  return AIX_BOUNDARIES.filter((b) => ids.includes(b.id));
}
/** 材料の1行（当たらない時は ""） */
export function aixBoundaryLine(bs: readonly Boundary[]): string {
  if (!bs.length) return "";
  return `【AIX と返信の境目（竹内さんの決め・材料・決めるのはあなた）】${bs.map((b) => `${b.when} → ${b.take}（${b.source}）`).join("／")}`;
}
