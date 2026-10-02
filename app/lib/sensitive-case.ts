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

// ── 2026-10-02 竹内さんの指示「誤発火の3つを実送信で線を引き直す」（scripts/audit-overfire-three.ts・365日・お客様の番 3,636）──
//   当たった 25通（＋お客様の発言全体で 38通）を全部読み、こちらとの約束のキャンセル・本当の否決ではない2つの形を外した:
//   ①否決の「仮定」: 「審査落ちた場合の候補です」「急いで落ちた場合再度検討」「審査申し込みの家落ちた場合」「もし審査が通らなかった時に代理契約でも」
//     ＝まだ起きていない（質問・段取りの話）。「審査落ちたってことですかね？」「審査ダメでしたか？」（結果の問い）は今までどおり当てる
//   ②物件1件をやめる: 「gm 粉浜やめます。（＋次の条件）」「ここはやめときます」「(谷川ハイツはやめておきます)」「こちらはやばそうなんでやめときます」
//     「そちらの物件拝見しましたが 今回はやめておきます」＝物件の取捨で、続けて探す流れ（普通の返事でよい）。引越し・お部屋探し・申込・内覧・契約を
//     やめる文は今までどおり当てる。「見送らせて」「キャンセル」「辞退」は物件1件でも今までどおり当てる（内覧・申込の取り消しと区別できないため）
//   残した誤りの候補（判断待ち・件数1ずつ）: 今の家の「明日物件解約します」・前の発言の取り消し「取り消します」
const REJECT_HYPOTHETICAL_RE = /(?:審査[^。！!？?\n]{0,10})?(?:落ち|通らなかっ|通りませんでし|ダメだっ)た?(?:場合|時|とき|ら(?![れ]))/g;
const DECLINE_WORD_RE = /やめ(?:たい|ます|ておき|とき)/g;
const DECLINE_OBJECT_RE = /ここ|こちら|そちら|そこ|物件|号室|[ァ-ヴー]{2,}|[A-Za-zＡ-Ｚａ-ｚ]{2,}/;
const DECLINE_SEARCH_RE = /引っ?越|お?部屋探し|家探し|契約|申込|申し込|内覧|内見|お願い|依頼|仲介/;
/** 物件1件をやめる文か（同じ文の「やめ〜」より前に物件を指す語があり、引越し・探す事・申込・内覧・契約の語が無い）。
 *  文が「今回は」だけで始まる時は1つ前の文（「そちらの物件拝見しましたが」）も見る */
function isPropertyDecline(text: string, idx: number): boolean {
  const head = text.slice(0, idx);
  const cut = Math.max(head.lastIndexOf("。"), head.lastIndexOf("\n"), head.lastIndexOf("！"), head.lastIndexOf("!"));
  let before = head.slice(cut + 1);
  if (/^\s*今回は\s*$/.test(before)) {
    const prev = head.slice(0, Math.max(cut, 0)).replace(/[\s⁣]+$/, "");
    const cut2 = Math.max(prev.lastIndexOf("。"), prev.lastIndexOf("\n"), prev.lastIndexOf("！"), prev.lastIndexOf("!"));
    before = `${prev.slice(cut2 + 1)}${before}`;
  }
  return DECLINE_OBJECT_RE.test(before) && !DECLINE_SEARCH_RE.test(before);
}
function withoutPropertyDeclines(text: string): string {
  return text.replace(DECLINE_WORD_RE, (m, idx: number) => (isPropertyDecline(text, idx) ? "" : m));
}

// ── 2026-10-02（続き）竹内「それでおねがい」: 残っていた候補3つも外す ──
//   ③今の家の解約: 「最寄り駅石橋阪大前6万までの…物件ありますか？ 明日物件解約します。 入居が10/1に予定してます。」
//     ＝今住んでいる家の解約（探し続けている）。同じ発言に探している・入居の予定の語があり、解約の文に申込・審査・こちらの契約の語が無い時は外す。
//     「今の家／現在の家／今住んでいる」を付けた解約も外す。「解約しますやっぱり」（探す語なし＝申込以降のこちらの契約）は今までどおり当てる
//   ④自分の発言の取り消し: 「取り消します。 兄が仕事中断してくれるみたいで 夜入力します。」＝前に自分が書いた事を取り消して、続けて進める。
//     目的語の無い「取り消します」で始まり、同じ発言で進める語（入力します・進めます・やります・送ります・行きます）がある時は外す
//   ⑤画像の読み取りの中の「否決」: 審査結果の通知の画面（審査・保証会社・結果・可否の語がある読み取り）だけ見る。本人確認書類・請求書・約款等の読み取りの
//     「否決」は外す（365日の実物で当たりは0通＝先回り。10/02 の監査で「画像の否決」と読んだ1件は、同じ番の後の「審査ダメでしたか？」＝本当の問いだった）
const SEARCH_CONTINUES_RE = /物件(?:あります|有ります|探)|お部屋(?:探|あります)|探して(?:ます|います|おります)|入居(?:が|は|を|の)?[^。\n]{0,8}予定|引っ?越し先/;
const OUR_CONTRACT_RE = /申込|申し込|お申込|審査|ご契約|こちらの契約|仮押さえ/;
const CURRENT_HOME_WORD_RE = /今の(?:家|部屋|お部屋|住まい|物件)|現在の(?:家|部屋|お部屋|住まい|物件)|今住んで|住んでいる(?:家|部屋|物件)/;
function sentenceAround(text: string, idx: number): string {
  const head = text.slice(0, idx), tail = text.slice(idx);
  const a = Math.max(head.lastIndexOf("。"), head.lastIndexOf("\n"), head.lastIndexOf("！"), head.lastIndexOf("!"), head.lastIndexOf("？"), head.lastIndexOf("?"));
  const bs = [tail.indexOf("。"), tail.indexOf("\n")].filter((x) => x >= 0);
  return text.slice(a + 1, idx + (bs.length ? Math.min(...bs) : tail.length));
}
/** 今の家の解約（探し続けている）を外す */
function withoutCurrentHomeLeaseEnd(text: string): string {
  const searching = SEARCH_CONTINUES_RE.test(text);
  return text.replace(/解約/g, (m, idx: number) => {
    const s = sentenceAround(text, idx);
    if (OUR_CONTRACT_RE.test(s)) return m;
    return CURRENT_HOME_WORD_RE.test(s) || searching ? "" : m;
  });
}
const SELF_RETRACT_RE = /^\s*(?:先ほどの|さっきの|上の|前の)?(?:(?:メッセージ|発言|内容|連絡)(?:は|を)?)?取り?消し?ます[。！!]?/;
const PROCEED_RE = /入力(?:します|しておきます)|進めます|やります|送ります|行きます|お送りします|提出します/;
/** 自分の前の発言の取り消し（続けて進める）を外す。発言ごと（連投の区切り）に見る */
function withoutSelfRetraction(text: string): string {
  return text.split(/(\n⁣\n|\n\s*---\s*\n)/).map((u) => (SELF_RETRACT_RE.test(u) && PROCEED_RE.test(u) && !OUR_CONTRACT_RE.test(u) && !/内覧|内見|予約/.test(u) ? u.replace(SELF_RETRACT_RE, "") : u)).join("");
}
const SCREENING_NOTICE_RE = /審査|保証会社|結果|可否/;
/** 否決を見る本文: 画像の読み取りは審査結果の通知らしい物だけ残す */
function rejectSource(text: string): string {
  return String(text ?? "").split(/\n⁣\n|\n\s*---\s*\n/).filter((u) => !/^\s*\[画像\]/.test(u) || SCREENING_NOTICE_RE.test(u)).join("\n");
}

export type SensitiveKind = "クレーム" | "審査否決" | "キャンセル・リスケ";

export function detectSensitiveCase(text: string | null | undefined): SensitiveKind | null {
  if (!text) return null;
  const body = withoutImageReadouts(text);
  const claimText = body.replace(CLAIM_RECEIVED_RE, "").replace(SCAM_QUESTION_RE, "");
  if (SENSITIVE_CLAIM_RE.test(claimText)) return "クレーム";
  // 否決は画像の読み取りのうち審査結果の通知らしい物も見る・キャンセルは画像の読み取りも今までどおり見る
  if (SENSITIVE_REJECT_RE.test(rejectSource(text).replace(REJECT_HYPOTHETICAL_RE, ""))) return "審査否決";
  if (SENSITIVE_CANCEL_RE.test(withoutSelfRetraction(withoutCurrentHomeLeaseEnd(withoutPropertyDeclines(text))))) return "キャンセル・リスケ";
  return null;
}
