// app/lib/tpo-hint.ts
// ブレインのナレッジ検索に使う TPO（場面ラベル）の判定（純関数・DB 依存なし）
//
// 2026-09-13 RAG 監査 改善5: 判定を「今回のお客様の発言」中心に並べ替えた。
//   旧（brain-core 内の即時関数）: 最新の1通だけを見て、ブレイン自身の前回の出力（prevMeta.action=property_send 等）からの
//   「物件送付後」が「検討中フォロー」「感謝返し」より先 → 同じ顧客発言でも実行ごとに TPO が入れ替わり
//   （8b260f7e: 09:52 検討中フォロー → 10:14 物件送付後）、他決の連絡まで「物件送付後」になっていた（a64dbdd1）。
//   TPO はナレッジ検索（match_reply_knowledge の boost_state＝距離への加点）と問いの先頭ラベルに使うので、外れると検索がずれる。
//   新: ①未返信の連投全体を見る ②顧客発言を根拠にする判定を先に ③前回の出力・直前のスタッフ発言からの判定は最後の手段
//   ④どれにも当たらなければ null（加点しない）

export type TpoInput = {
  /** 未返信のお客様の連投（無ければ最新のお客様発言） */
  customerTurn: string;
  /** 直前のスタッフ発言（無ければ null＝会話の冒頭） */
  lastStaffMsg: string | null;
  convStatus: string | null;
  prevIntent?: string | null;
  prevAction?: string | null;
  prevEmotion?: string | null;
};

/** 他決・辞退（「他で決めました」「別の不動産で契約」「今回は見送ります」）。単独の「決まりました」「見つかりました」は含めない（「良い物件見つかりました！ここにします」） */
const DECLINE_RE = /やめ(とき|ておき)?ます|キャンセル|見送り|(他|別)(社|の(会社|不動産|ところ|物件))?で[^\n]{0,8}(決め|決ま|見つか|契約|申込)|今回は(大丈夫|結構|遠慮)/;
const ANXIETY_RE = /不安|心配|審査.*(通|落)|落ち(る|たら)|大丈夫でしょうか/;
const APPLY_INTENT_RE = /申(し)?込(み)?(たい|します|お願い)|契約したい|決め(ます|ました)|ここにします/;
const VIEWING_RE = /内覧|内見|見学|現地|待ち合わせ|見てみたい|見に行/;
const COST_RE = /初期費用|見積|敷金|礼金|仲介手数料|保証(会社|料)|家賃.*(いくら|交渉)|費用.*(いくら|どのくらい|教えて)|総額/;
const CONSIDER_RE = /検討|迷って|考え(て|させて)|悩んで/;
// 感謝返し: 返信生成の isGratitudeReplyTPO と同じ 60字・同じキーワード・質問/依頼の除外（RAG の場面ラベルと返信方針を同じ条件で発火させる）
const THANKS_RE = /ありがとう|ありがとございます|感謝|助かり(ます|ました)|嬉しい|よろしくお願い|宜しくお願い|おねがいします|おねがいいたします|おねがい致します|お願いします|お願いいたします|お願い致します|承知|かしこまり|わかりました|分かりました|了解|楽しみ|お任せ|おまかせ|引き続き/;
const THANKS_EXCLUDE_RE = /[?？]|希望|したい|教えて|どうすれば|送って(ください|ほしい|もらえ)|ください(?!ませ)/;
const PICKUP_STAFF_RE = /ピックアップ|お部屋.*送|物件.*(紹介|送付|お送り)/;

export function inferTpoHint(o: TpoInput): string | null {
  const msg = o.customerTurn ?? "";
  const intent = o.prevIntent ?? "";
  const action = o.prevAction ?? "";
  const emotion = o.prevEmotion ?? "";
  // ── 状態で確定するもの ──
  if (o.convStatus === "applying" || o.convStatus === "screening") return "申込後説明";
  // ── 今回の顧客発言を根拠にするもの（先に見る）──
  if (DECLINE_RE.test(msg)) return "拒否対応";
  if (ANXIETY_RE.test(msg)) return "不安対応";
  if (APPLY_INTENT_RE.test(msg)) return "申込前クロージング";
  if (VIEWING_RE.test(msg)) return "内覧調整";
  if (COST_RE.test(msg)) return "費用説明";
  if (CONSIDER_RE.test(msg)) return "検討中フォロー";
  if (msg.length < 60 && !THANKS_EXCLUDE_RE.test(msg) && THANKS_RE.test(msg)) return "感謝返し";
  // ── 会話の冒頭 ──
  if (!o.lastStaffMsg || o.convStatus === "initial" || o.convStatus === "new") return "初回対応";
  // ── 最後の手段: ブレインの前回の出力・直前のスタッフ発言から ──
  if (intent === "negative") return "拒否対応";
  if (/不安|心配|anxious|worried/.test(emotion)) return "不安対応";
  if (action === "application_push") return "申込打診";
  if (action === "viewing_invite" || action === "meeting_place") return "内覧調整";
  if (intent === "consultation" || action === "follow_up" || action === "followup_revive") return "検討中フォロー";
  if (action === "property_send" || action === "property_recommendation" || action === "estimate_sheet" || PICKUP_STAFF_RE.test(o.lastStaffMsg)) {
    return "物件送付後";
  }
  return null;
}
