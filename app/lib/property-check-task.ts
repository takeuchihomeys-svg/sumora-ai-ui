// app/lib/property-check-task.ts
// お客様の発言から「物件確認／物件出し」のタスク（line_tasks）を作るかの判定（純関数・DB 依存なし）。
// webhook（line-webhook-text の autoDetectTask）がここを使う。
//
// 2026-09-27 竹内さん「残っている課題も改善する」（お客様役のテストで見つけた: 「見積もりありがとうございます。内覧したいです」で
//   物件確認のタスクが自動で作られた）。決まり（2026-09-12 竹内「物件確認したもお客さんから物件確認の依頼があった場合となる」・
//   memory feedback_property_check_on_request）: 物件確認の依頼の判定は aix-scene-evidence の customerRequestedPropertyCheck **だけ**
//   （/api/line-tasks の作成はそこを通す）。ところが webhook は語の一覧（PROPERTY_CHECK_KEYWORDS）だけで直接 line_tasks に入れていて、
//   その判定を通っていなかった（「内覧したい」「見学したい」だけで作る）。
//   → 語の一覧は「候補」にだけ使い、物件確認は customerRequestedPropertyCheck も通った時だけ作る（作成の判定を1か所にそろえる）。
//   線は scripts/audit-property-check-task.ts（実送信・次にスタッフが押した AIX）で引いた。
//
// 2026-09-27 竹内さん決定「内覧したいといわれたら内覧日調整となる／AIXの内覧調整」（memory feedback_viewing_request_aix）:
//   お客様の内覧の希望（内覧・内見・見学したい）だけでは物件確認のタスクを作らない（やることは日程の調整＝AIX【内覧へ】viewing_invite）。
//   customerRequestedPropertyCheck の定義では「物件を指した内覧の依頼」も依頼に入るため（YUMA「こちらのお部屋、ぜひ内覧したい」）、
//   ここで内覧の希望だけの連投を外す（customerRequestedPropertyCheck 自体は /api/line-tasks・画面の判定と共有なので変えない）。
//   作る側に残す物: 連投に物件そのもの（画像・URL・号室）＝持ち込み物件／空き・募集・費用・見積・入居日・審査・確認の依頼の語。
//   線は scripts/audit-property-check-task.ts（120日）で前後を読んで引いた（dept_line_reply.md 2026-09-27）。
import { customerRequestedPropertyCheck, propertySpecifiedBy } from "@/app/lib/aix-scene-evidence";
import { CUST_WILL_SEND_SELF_PRED } from "@/app/lib/reply-context";
import { VIEWING_INTENT_RE, allVacancyWordsAreSlots } from "@/app/lib/scene-patterns";

export const PROPERTY_CHECK_KEYWORDS = [
  "物件確認", "初期費用確認", "初期費用を確認",
  "内覧したい", "内覧させてほしい", "内覧お願い", "内覧を希望",
  "内覧できますか", "内覧は可能", "内覧申し込み",
  "見学したい", "見学させてほしい", "見学お願い",
  "空室確認",
];

export const PROPERTY_SEND_KEYWORDS = [
  "物件送って", "物件を送", "物件探して", "物件を探",
  "物件ありますか", "物件お願い", "物件出して", "物件を出して",
  "物件ください", "物件紹介してほしい", "物件を紹介", "物件ピックアップ",
];

const CONFIRM_PHRASES = ["確認してほしい", "確認してください", "確認お願い", "確認をお願い", "確認できますか"];
const CONFIRM_TARGETS = ["物件", "初期費用", "空室", "この部屋", "この物件"];

/** 語の一覧だけでの候補（旧 detectTaskType と同じ） */
export function detectTaskTypeByKeywords(text: string): "property_check" | "property_send" | null {
  // 2026-09-12 竹内（じゅにあ事例）: 「何件か気になる物件送ってもいいですか？」はお客様が自分で送る予告 → タスクは作らない
  if (CUST_WILL_SEND_SELF_PRED(text).yes) return null;
  if (PROPERTY_CHECK_KEYWORDS.some((k) => text.includes(k))) return "property_check";
  if (CONFIRM_PHRASES.some((p) => text.includes(p)) && CONFIRM_TARGETS.some((t) => text.includes(t))) return "property_check";
  if (PROPERTY_SEND_KEYWORDS.some((k) => text.includes(k))) return "property_send";
  return null;
}

/** 内覧の希望と一緒でも物件確認に残す依頼の語（「空いて」は下で枠かどうかを見る。空き・募集・費用・見積・入居日・審査・確認の依頼） */
//   費用・見積・確認は「依頼の形」だけ（YUMA「見積もりありがとうございます…内覧したい」の御礼・「内容を確認して、内覧も」のお客様自身の確認は数えない）
const CHECK_ASK_WITH_VIEWING_RE = new RegExp([
  /空(?:き|室)|募集|まだ(?:あり|空|残|大丈夫)|埋ま|申込(?:み)?(?:入って|は入|ありま)/.source,
  /(?:見積|初期費用|費用)[^\n。！!]{0,10}?(?:お願い|出して|頂け|いただけ|欲し|ほし|知りたい|しりたい|教えて|くださ|下さ|ですか|ますか|[？?])|いくら/.source,
  /入居(?:日|可能|でき|出来)|審査/.source,
  /確認(?:してほしい|して(?:もら|頂|いただ|くだ|下さ)|お願い|をお願い|(?:でき|出来)(?:ます|ません))|住所/.source,
].join("|"));

/**
 * 今回のお客様の連投が「内覧の希望だけ」か（持ち込み物件でも確認の依頼でもない）。
 * true の時は物件確認のタスクを作らない（内覧日の調整＝AIX【内覧へ】の場面）。
 * @param recentMessages oldest-first・今回のお客様の発言まで
 */
export function isViewingWishOnlyTurn(recentMessages: ReadonlyArray<{ sender: string; text?: string | null }>): boolean {
  const msgs = [...recentMessages];
  while (msgs.length && msgs[msgs.length - 1].sender !== "customer") msgs.pop();
  const turn: string[] = [];
  let hasCustomerImage = false;
  for (let i = msgs.length - 1; i >= 0 && msgs[i].sender === "customer"; i--) {
    const t = (msgs[i].text ?? "").trim();
    if (/^\[画像\]/.test(t)) hasCustomerImage = true;
    else if (t) turn.unshift(t);
  }
  const text = turn.join("\n");
  if (!text || !VIEWING_INTENT_RE.test(text)) return false;
  // 持ち込み物件（画像・URL・号室）は今まで通り物件確認
  const specBy = propertySpecifiedBy(text, { hasCustomerImage });
  if (specBy === "image" || specBy === "url" || specBy === "room_no") return false;
  if (CHECK_ASK_WITH_VIEWING_RE.test(text)) return false;
  // 「空いて」は内覧の枠（「日程はいつ頃空いていますか」＝YUMA の実物）なら依頼に数えない（detectAvailabilityCheckContext と同じ見方）
  if (/空いて/.test(text) && !allVacancyWordsAreSlots(text)) return false;
  return true;
}

/**
 * 作るタスクの種類。物件確認は customerRequestedPropertyCheck（/api/line-tasks と同じ判定）も通り、
 * 内覧の希望だけの連投でない時だけ。
 * @param recentMessages oldest-first・今回のお客様の発言まで（無ければ語だけで判定＝旧の動き・内覧の希望だけは除く）
 */
export function decideAutoTask(
  text: string,
  recentMessages?: ReadonlyArray<{ sender: string; text?: string | null }> | null,
): "property_check" | "property_send" | null {
  const kind = detectTaskTypeByKeywords(text);
  if (kind !== "property_check") return kind;
  // 直前の会話が読めない時は語だけ（旧の動き）。ただし今回の文だけで内覧の希望だけと分かる物は作らない
  if (!recentMessages || recentMessages.length === 0) return isViewingWishOnlyTurn([{ sender: "customer", text }]) ? null : kind;
  if (!customerRequestedPropertyCheck({ recentMessages })) return null;
  // 内覧の希望だけ → 物件確認のタスクは作らない（2026-09-27 竹内さん決定・上の説明）
  if (isViewingWishOnlyTurn(recentMessages)) return null;
  return "property_check";
}
