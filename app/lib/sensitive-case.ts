// app/lib/sensitive-case.ts
// センシティブ案件（クレーム・審査否決・キャンセル/リスケ）の検知（純関数）。generate-reply の f-8 ゲートが最終チェックの SENSITIVE_CASE（block）に入れる。
//   block の下書きは自動送信の関所（auto-reply-policy canAutoReply の final_check_block）で必ず止まる＝誤って当たると「正しい返信が自動で送れない」。
//
// 2026-10-01 YUMA の再生テスト（scripts/yuma-replay-scenarios.ts・本番の初回の条件フォーム）で、
//   「木造の為か、騒音がうるさいとクレームが来て疲れてます」（今の家で**お客様が受けた**苦情＝引っ越しの理由）に SENSITIVE_CASE が付き、
//   スタッフが実際に送ったのとほぼ同じ下書き（同じ事）が関所で止まった（穴:G5 矯正の誤発火）。
//   実送信の線（365日・お客様の発言・YUMA 除く）: クレームの語に当たったのは4通で、こちらへのクレームは0通
//     ①上の騒音の苦情（今の家）②③[画像] の読み取りの文（物件資料・差入書の約款の「苦情」）④「ジェイリース？からショートメールが来たんですけど詐欺ですか？？」
//   → クレームの語は「お客様が受けた苦情（クレームが来た/入った/を受けた）」「詐欺かの問い」「画像の読み取りの文」では当てない（入口の判定だけ・本文は変えない）。
//   審査否決・キャンセル/リスケは変えていない（180日で否決 11通・キャンセル 27通は本当に人の判断が要る物＝申込以降が中心）。
// テスト: app/lib/__tests__/sensitive-case.test.ts（上の実物）

export const SENSITIVE_CLAIM_RE = /クレーム|苦情|納得(いか|でき)|話が違う|不誠実|誠意を|騙され|詐欺|訴え(る|ます|させ)|弁護士|消費者センター/;
export const SENSITIVE_REJECT_RE = /審査[^。！!？?\n]{0,8}(否決|落ち(た(?!ら)|まし|てしまい)|通りませんでした|通らなかった|不承認|NG(でし|になり|だっ)|ダメ(でし|だっ))|否決/;
// ※「キャンセル料」「キャンセルできますか」等の不安系質問は通常AI回答の範囲のため除外し、キャンセル・解約の「意向」とリスケ（日程変更）依頼のみ検知する
export const SENSITIVE_CANCEL_RE = /(?:キャンセル|解約|取消|取り消し?|白紙|辞退)(?!料|金|でき|出来|可能)(?:を|は|に|で)?(?:したい|します|させて|お願い|希望|することに|する事に)|なかったことに|見送(?:り(?:たい|ます)|らせて)|やめ(?:たい|ます|ておき|とき)|リスケ(?:[をはにで])?(?:したい|させて|お願い|希望|お願いし)|(?:日程|日にち|日時|予定)[^。！!？?\n]{0,6}(?:変更|ずら|延期)(?:[をにで])?(?:したい|させて|お願い|希望)/;

/** お客様が**受けた**苦情（今の家の近所・管理会社から）＝こちらへのクレームではない */
const CLAIM_RECEIVED_RE = /(?:クレーム|苦情)(?:が|を)?(?:来|き(?:て|た|ました)|入っ|入り|入れられ|受け|言われ|もらっ|貰っ)/g;
/** 詐欺かを尋ねている（第三者の連絡について）＝こちらへのクレームではない */
const SCAM_QUESTION_RE = /詐欺(?:です|でしょう|じゃない|ではない|なの|かな|か(?=[？?]))[^。\n]{0,6}/g;

/** 画像の読み取りの文（「[画像] …」で始まる発言）を外す。発言の区切りは generate-reply の MSG_SEP（改行＋U+2063＋改行）か「---」の行 */
export function withoutImageReadouts(text: string): string {
  return String(text ?? "")
    .split(/\n⁣\n|\n\s*---\s*\n/)
    .filter((u) => !/^\s*\[画像\]/.test(u))
    .join("\n");
}

export type SensitiveKind = "クレーム" | "審査否決" | "キャンセル・リスケ";

export function detectSensitiveCase(text: string | null | undefined): SensitiveKind | null {
  if (!text) return null;
  const body = withoutImageReadouts(text);
  const claimText = body.replace(CLAIM_RECEIVED_RE, "").replace(SCAM_QUESTION_RE, "");
  if (SENSITIVE_CLAIM_RE.test(claimText)) return "クレーム";
  // 否決・キャンセルは画像の読み取り（審査結果の通知の画面など）も今までどおり見る
  if (SENSITIVE_REJECT_RE.test(text)) return "審査否決";
  if (SENSITIVE_CANCEL_RE.test(text)) return "キャンセル・リスケ";
  return null;
}
