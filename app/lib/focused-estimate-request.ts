// app/lib/focused-estimate-request.ts
// 気に入ったお部屋が決まっていて、お客様が見積もりを頼んだ → AIX【見積書送る】（estimate_sheet）。
//
// 2026-09-27 竹内（YUMA の返信テスト）: こちらが送ったエステムコート大阪WEST に「いいですね」→「見積もりお願いできますか」。
//   ブレインは AIX【物件確認した】（募集状況を確認して報告）を選んだ。竹内さん「この場面は見積書を正解にする」。
//   （お客様の気に入った物件は、送って頂いたら最大限割引した初期費用の御見積書＝feedback_customer_property_estimate_flow）
//
// 決まり（四者同名: この関数 resolveFocusedEstimateRequest ／ brain-core の decision_source 'signal:focused_estimate_request' ／
//   プロンプトの【主のお部屋への見積もりの依頼】／監査 scripts/audit-focused-estimate-request.ts）:
//   ① 主のお部屋（customer-state の focus）がある・終了していない・**こちらが送ったお部屋**（sentByUs）
//   ② お客様の今回の連投（未返信）が見積もりの依頼（見積もりお願い・見積もり欲しい・初期費用いくら・費用出して 等）
//   ③ 同じ連投に新しい探す条件・別のお部屋の依頼が無い（条件の見直しが主題 → 物件ピックアップ）
//   ④ 同じ連投で空き・募集状況も聞いていない（下の「空きも聞いている時」）
//
// 入れないもの（今まで通り）:
//   - 物件が決まっていない見積もりの依頼（feedback_estimate_needs_property）: ① が無ければ何もしない（AIX なし／「初期費用を抑える」一文は従来の規則）
//   - お客様が持ち込んだお部屋（URL・画像・他社で見つけた）: こちらはまだ空きを知らない → 募集状況の確認＋御見積書（物件確認した＋同封・従来通り）
//   - 空き・募集状況も同じ連投で聞いている時: AIX【見積書送る】は見積書のカバー文だけで募集状況を報告しない。
//     AIX【物件確認した】は御見積書の同封ができる（aix/action の「御見積書同封させて頂きました」）ので、両方に1通で答えられるのは物件確認した。
//     → ブレインの判断に任せる（この決まりでは上書きしない）
//
// 実送信での線（scripts/audit-focused-estimate-request.ts・2026-09-27・直近180日・グループと YUMA を除く）は memory/dept_line_reply.md と設計知見に記録。

import { FORM_LABEL_RE, isConditionFormMessage } from "./line-reply-prompts";

/**
 * 見積もりの依頼。見積の依頼形（CUSTOMER_ESTIMATE_REQUEST_RE と同じ形から「ありがとう」「合わせて」を外した物）＋
 * 初期費用の金額を出してほしい形（「初期費用いくらですか」「費用出してもらえますか」「総額教えてください」）。
 * 共有の CUSTOMER_ESTIMATE_REQUEST_RE は見積書の受領（「見積もり書ありがとうございます」）も拾う（返信側の解禁の用途）ため、
 * ここでは使わない（監査で b87d85db・f2967621 の見積書へのお礼が依頼に数えられた）。
 * 2026-09-27 竹内「初期費用しりたいはAIXの初期費用おくるから見積書おくってる」: ひらがなの「しりたい」も依頼に数える（ad97cd40「こちら初期費用しりたいです！」）
 * 費用の中身の質問（「家賃だけで住めますか」＝cost_breakdown）・値引きの相談・安さへの不審（cost_explain）は含めない
 */
export const FOCUSED_ESTIMATE_ASK_RE =
  /(?:御|お)?見積(?:書|り|もり)?(?:を|も|が|は|の|だけ|の方)?[^\n。]{0,8}(?:お願い|欲しい|ほしい|ください|下さい|頂け|いただけ|出して|だして|送って|作って|貰え|もらえ|(?:いただき|頂き|もらい|貰い)たい|可能|できます|出来ます|ですか|見たい|みたい|欲しく|ほしく|依頼)|(?:初期費用|費用|総額)(?![】：:]|の限度|の上限|\s*[⇒→])(?:は|が|って|の|も|とか|面|等)?[^\n。]{0,8}(?:いくら|どのくらい|どれくらい|どれ位|教えて|知りたい|しりたい|出して|だして|出せ|見せて|計算)/;

/** 空き・募集状況の質問（「まだ空いてますか」「募集中ですか」「申込入ってますか」「上の階は空きないでしょうか」） */
export const VACANCY_ASK_RE =
  /空いて(?:ます|いま|る|おり|ない|な)|空き(?:は|が|あり|状況|です|ます|ない|無い)|空室(?:です|ですか|か|状況|確認)|募集(?:中|状況|して|終了|まだ|出て)|まだ(?:あり|残って|借りられ|住め|大丈夫|募集)|埋まって|申し?込み?(?:入って|が入|はいって|ありますか)|決まって(?:ない|ません|ますか|いませんか)/;

/** 内覧の希望・可否（同じ連投にあれば内覧が主題になり得る → ブレインに任せる。brain-core 信号0.96 の viewingReq と同じ形） */
const VIEWING_ASK_RE = /(内覧|内見|見学)[^。！!？?\n]{0,6}(したい|希望|でき|出来|可能|いつ|日程|調整|お願い)|見に(行|い)きたい|みにいきたい/;

/** 別のお部屋・新しい条件の依頼（条件の見直しが主題 → 見積書ではなく物件ピックアップ。brain-core 信号0.96 の otherPropertyReq と同じ形＋条件の語） */
const OTHER_PROPERTY_OR_CONDITION_RE =
  /(安|抑え)[^。！!？?\n]{0,10}(物件|お?部屋)|(物件|お?部屋)[^。！!？?\n]{0,8}(ない(です|でしょう)?か|あります|ありません)|(別|他|違う|ほか)の?(お?部屋|物件)|[0-9０-９.]+\s*万(円)?(以下|以内|まで|台)|徒歩\s*[0-9０-９]+\s*分(以内|まで)|(条件|エリア)[^。\n]{0,6}(変え|変更|広げ)|探して(欲しい|ほしい|ください|下さい|もらえ|頂け|いただけ)/;

export type FocusRoomLite = { name: string; sentByUs: boolean; ended: boolean };

export type FocusedEstimateReason =
  | "focused_estimate_request" // 見積書送るにする
  | "not_estimate_ask" | "no_focus" | "focus_not_ours" | "focus_ended" | "condition_change" | "also_vacancy" | "also_viewing";

export type FocusedEstimate = { hit: boolean; reason: FocusedEstimateReason; focusName: string | null; alsoVacancy: boolean };

/**
 * @param turnText お客様の今回の連投（最後のこちらの発言より後・未返信・古い→新しいを改行でつないだ文字。brain-aix-feedback.unrepliedCustomerTurn の text）
 * @param focus    customer-state の主のお部屋（無ければ null）
 */
export function resolveFocusedEstimateRequest(turnText: string | null | undefined, focus: FocusRoomLite | null): FocusedEstimate {
  const raw = (turnText ?? "").trim();
  const body = raw.replace(FORM_LABEL_RE, " ");
  const alsoVacancy = VACANCY_ASK_RE.test(body);
  const out = (hit: boolean, reason: FocusedEstimateReason): FocusedEstimate => ({ hit, reason, focusName: focus?.name ?? null, alsoVacancy });
  // 条件フォーム（【初期費用の限度額】⇒…）は見積もりの依頼ではない
  if (!raw || isConditionFormMessage(raw) || !FOCUSED_ESTIMATE_ASK_RE.test(body)) return out(false, "not_estimate_ask");
  if (!focus) return out(false, "no_focus");
  if (focus.ended) return out(false, "focus_ended");
  if (!focus.sentByUs) return out(false, "focus_not_ours");
  if (OTHER_PROPERTY_OR_CONDITION_RE.test(body)) return out(false, "condition_change");
  if (alsoVacancy) return out(false, "also_vacancy");
  if (VIEWING_ASK_RE.test(body)) return out(false, "also_viewing");
  return out(true, "focused_estimate_request");
}
