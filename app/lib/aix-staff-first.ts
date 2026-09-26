// app/lib/aix-staff-first.ts
// 2026-09-15 竹内（みく事例）: AIX の生成では、スタッフが押した AIX の種類と画面で入れた事柄（確認結果・物件情報・同封する御見積書・内覧／申込誘導）が正。
//   ブレインの判断（avoid_topics・key_topics・成約戦略・今の物件）は「今回のお客様の発言」を見た時点の参考で、スタッフの入力と食い違うことがある。
//   事例: 物件確認した（物件あった・御見積書同封）で、ブレインの avoid_topics「見積書」「初期費用」が「絶対に言及しない」で入り、
//   key_topics・成約戦略が取り違えた物件（駒川中野・リアライズ長居公園通313号室）を指していた → 別の物件の確認前の文になった。
//   → AIX が送る事柄そのもの（見積書送る の「見積書」等）と、スタッフが入れた事柄は、ブレインの「避ける話題」から外す。依存ゼロ

/** AIX の種類ごとに「その AIX が送る事柄」（避ける話題にしてはいけない） */
const AIX_OWNED_TOPIC_RE: Record<string, RegExp> = {
  estimate_sheet: /見積|初期費用|費用|割引|金額|総額/,
  cost_explain: /見積|初期費用|費用|割引|金額|還元|仲介手数料/,
  cost_breakdown: /見積|初期費用|費用|金額|内訳|敷金|礼金|火災保険|日割/,
  viewing_invite: /内覧|内見|ご案内|案内|日程/,
  meeting_place: /内覧|内見|ご案内|案内|待ち合わせ|日程|住所/,
  greeting_viewing: /内覧|内見|ご案内|案内/,
  application_push: /申込|申し込み|審査|抑え|押さえ/,
  property_send: /物件|お部屋|ピックアップ/,
  property_recommendation: /物件|お部屋|オススメ|おすすめ/,
  // property_check_result は結果の報告なので種類では外さない（「他物件の募集状況確認」を避けるのは正しい）。同封する御見積書等はスタッフの入力で外す
  // 2026-09-16 カイナ事例: 打診中の内覧（viewing-thread の pending／画面の「流れを続ける」）は呼び出し側で viewingInvite=true 扱いにして VIEWING_RE を外す
  phone_call: /電話|通話/,
  // 2026-09-15 竹内（YUYA 事例）: 保証会社について は審査・保証会社の話そのものを送る（ブレインの avoid_topics「審査」で本題を禁止しない）
  guarantor_info: /保証会社|審査|保証人|独立系|信用系|LICC|信販/,   // 種類は3つ（2026-09-26）。LICC は旧の言い方
};
const ESTIMATE_RE = /見積|初期費用|費用|割引|金額|総額/;
const VIEWING_RE = /内覧|内見|ご案内|日程/;
const APPLICATION_RE = /申込|申し込み|抑え|押さえ/;

/** ブレインの「避ける話題」から、この AIX が送る事柄・スタッフが入れた事柄と食い違うものを外す */
export function avoidTopicsForAix(
  action: string,
  avoidTopics: ReadonlyArray<unknown> | null | undefined,
  staff: { estimateEnclosed?: boolean; viewingInvite?: boolean; applicationInvite?: boolean } = {},
): string[] {
  const owned = [
    AIX_OWNED_TOPIC_RE[action] ?? null,
    staff.estimateEnclosed ? ESTIMATE_RE : null,
    staff.viewingInvite ? VIEWING_RE : null,
    staff.applicationInvite ? APPLICATION_RE : null,
  ].filter((r): r is RegExp => r !== null);
  return (avoidTopics ?? [])
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .filter((t) => !owned.some((re) => re.test(t)));
}
