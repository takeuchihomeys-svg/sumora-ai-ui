// app/lib/fixed-content-notes.ts — 返信の生成の「確定・最優先」の注記（中身を決め打ちする型）の当たりの語と、ブレインの判断がある番の扱い（純関数）
//
// generate-reply は お客様の文の語だけで「確定・最優先 — 他のどのルールより上位」の型を渡していた:
//   予算・条件指定の在庫質問（正直に→代替→ピックアップ宣言）／入居時期・特定月の入居可否（確認と言わず直接答える）／
//   新条件・追加要望（ピックアップ宣言＋全力サポートの締め・質問と難しさと代替は禁止）。
// どれもブレインの判断（【🧭 この番の本質】・reply_direction）より上に置かれ、ブレインが「聞く」「確認の約束」「難しさを伝える」と決めた番でも型が勝っていた。
// 2026-10-15 監査の残り #10（scripts/audit-rest-1015.ts --part=notes）: ブレインの判断がある番は見出しを「材料（型の候補）」にし、中身は本質に従わせる。
//   ブレインの判断が無い番（T2/T3）は今まで通り（決定論の保険）。禁止語・言い切りの安全（断言しない・作らない）は本文の安全の注記と最終チェックの側。
// 戻す: FIXED_NOTE_BRAIN=off

export type FixedNoteKind = "budget_inventory" | "move_in_month" | "move_in_timing" | "new_condition";

export const BUDGET_INVENTORY_RE = /(?:賃料|家賃|月々?|円以内|万(?:以内|円台|円くら|以下))[^\n]{0,20}(?:物件|お?部屋|もの|ところ)[^\n]{0,30}(?:ありますか|あります？|ありませんか|ございますか|ないですか)/;
export const BUDGET_INVENTORY_SOURCE_RE = /TikTok|tiktok|ティックトック|Instagram|インスタ|SNS|広告|掲載|サイト|スモラ|弊社/;
export const MOVE_IN_TIMING_RE = /最長.{0,12}(?:いつ|何月|どこまで|伸ばせ|延長|延ばせ)|入居.{0,10}(?:最長|いつまで|延長|伸ばせ|どこまで)|いつ.{0,8}(?:まで|入居)|[0-9０-９一二三四五六七八九十]{1,2}月.{0,12}(?:に入居|まで入居|入居でき|入居は可能|入居間に合)|入居(?:でき|は可能|間に合).{0,8}(?:ます|ますか|でしょうか)/i;
export const SPECIFIC_MONTH_MOVE_IN_RE = /[0-9０-９一二三四五六七八九十]{1,2}月.{0,12}(?:に入居|まで入居|入居でき|入居は可能|入居間に合)|入居(?:でき|は可能|間に合).{0,8}(?:ます|ますか|でしょうか)/i;
const NEW_CONDITION_RES: RegExp[] = [
  /(?:条件|エリア|家賃|間取り|築年数|駅|徒歩|広さ|収納|ペット|駐車場|オートロック|バストイレ別?|WIC|SIC|日当た|南向き)[^。！!？?\n]{0,24}(?:の(?:お?部屋|物件)|で(?:探|お願|大丈夫)|は(?:あります|ないです|ありません|可能))/i,
  /(?:でも|も)(?:大丈夫|良いです|いいです|平気|構いま|OK|オッケー)/i,
  /(?:もう少し|もっと|さらに)[^。！!？?\n]{0,12}(?:広|安|新し|駅近|抑え|きれい|綺麗)/,
  /(?:ような|みたいな|といった)[^。！!？?\n]{0,8}(?:お?部屋|物件)[^。！!？?\n]{0,12}(?:あります|ないです|ありません)/,
];
/** route の isNewConditionMsg の語の部分（brain-core の PROPERTY_CONDITION_INQUIRY_RE の補完は route 側） */
export function isNewConditionText(text: string): boolean {
  return NEW_CONDITION_RES.some((re) => re.test(text ?? ""));
}
export function isBudgetInventoryText(text: string): boolean {
  const t = text ?? "";
  return BUDGET_INVENTORY_RE.test(t) || (BUDGET_INVENTORY_SOURCE_RE.test(t) && /ありますか|ございますか/.test(t));
}

/** 監査用: お客様の文で当たる注記（route の他の条件＝募集状況の文脈・条件変更の注記の有無は見ない近似） */
export function classifyFixedNoteTriggers(text: string, o: { customerAsked?: boolean } = {}): FixedNoteKind[] {
  const out: FixedNoteKind[] = [];
  if (o.customerAsked !== false && isBudgetInventoryText(text)) out.push("budget_inventory");
  if (MOVE_IN_TIMING_RE.test(text ?? "")) out.push(SPECIFIC_MONTH_MOVE_IN_RE.test(text ?? "") ? "move_in_month" : "move_in_timing");
  if (isNewConditionText(text)) out.push("new_condition");
  return out;
}

export function fixedNoteBrainEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.FIXED_NOTE_BRAIN ?? "").toLowerCase() !== "off";
}

/**
 * ブレインの判断がある番の「確定・最優先」の注記の見出しを材料に下げる。
 * 見出しの（確定・最優先 …）を（材料・型の候補 — 中身と向きは【🧭 この番の本質】に従う）に置き換え、
 * 本文の「【🚫 絶対禁止】」「【返信の型（この要素以外を入れない）】」を候補の言い方にする（禁止語の決まり＝NG_PHRASE 等は別の注記で残る）。
 */
export function demoteFixedNote(note: string, brainDecided: boolean, env: Record<string, string | undefined> = process.env): string {
  if (!note || !brainDecided || !fixedNoteBrainEnabled(env)) return note;
  return note
    .replace(/（確定・最優先(?:[^）]*)?）/, "（材料・型の候補 — 中身と向きは【🧭 この番の本質】に従う。本質と食い違う所はこの型を使わない）")
    .replace(/【返信の型（この要素以外を入れない）】/g, "【返信の型の候補（本質に合う時だけ）】")
    .replace(/【✅ 正しい回答方針（必ず守る）】/g, "【✅ 回答方針の候補（本質に合う時だけ）】")
    .replace(/【✅ この質問への正しい返信の型】/g, "【✅ 返信の型の候補（本質に合う時だけ）】")
    .replace(/【🚫 絶対禁止(CTA)?（フェーズ別パターンより上位）】/g, "【🚫 避ける形$1（本質が求める時は除く）】")
    .replace(/【🚫 絶対禁止】/g, "【🚫 避ける形（本質が求める時は除く）】")
    .replace(/【🚫 解説禁止】/g, "【🚫 避ける形】")
    .replace(/【🔴 絶対NG】/g, "【🔴 避ける形】");
}
