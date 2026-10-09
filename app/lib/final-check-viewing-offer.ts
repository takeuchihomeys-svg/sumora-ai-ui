// app/lib/final-check-viewing-offer.ts — 最終チェックが「オンライン内見・室内の撮影の申し出」の一文を落とさない線（純関数・LLM なし）
//
// 2026-10-08 竹内さん①「出張中で日付の無い『内覧したい』: 返信で『お部屋を抑えた状態でのご内覧』＋『オンライン内見や、室内の撮影もご対応させて頂きます😊！！』」
//   （customer-circumstances.ONLINE_VIEWING_LINE・竹内さんの手打ち 5通の最多形）。オンライン内見・撮影が「できる」と申し出るのは会社の事実
//   （company-facts: 室内の写真や動画はスタッフが撮影して送れる）で、スタッフだけが知る事ではない＝返信の番（P0「AIX と返信の分け方」）。
//   撮影した写真を送る・撮影の日時を決めるのは AIX の番（ここでは通さない）。
//   YUMA（yuma-grasp-circumstances trip_now・10/08）で、ブレインの方向は「オンライン内見・室内撮影の対応と抑えた状態でのご内覧」なのに下書きから一文が消えていた:
//     ① 決定論 PHOTO_REPLACES_VIEWING（block）: お客様の「内覧したい」があると「撮影」の文を一律に内覧の置き換えと読む（「出張中で伺えない」を見ない）
//     ② 決定論 PHOTO_NO_PREMISE（block）: お客様の事情の語が「行けな・遠方」だけで「出張中・伺えない・予定が詰まって」を前提に数えない
//     ③ LLM の rule_check（AIX_BOUNDARY_PROMISE 等）: 「ご対応させて頂きます」をスタッフの作業の約束（AIX の番）と読む
//   → お客様がすぐ・現地に来られない事情を言っている時だけ、申し出の文（日時・金額・撮影済みの言い切りが無い）への①②③を出さない。
//   それ以外（お客様が自分で内覧したいだけ・事情なし）は今まで通り（人の実送信の監査: scripts/audit-viewing-offer-final-check.ts）。
//   戻す: FINAL_CHECK_VIEWING_OFFER=off
// テスト: app/lib/__tests__/final-check-viewing-offer.test.ts

export function viewingOfferExemptEnabled(env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  return (env.FINAL_CHECK_VIEWING_OFFER ?? "").trim().toLowerCase() !== "off";
}

/** お客様がすぐ・現地に来られない事情（customer-circumstances の SOON_RE・REMOTE_RE と appeal-timing の VIEWING_DELAYED_RE の語を合わせた物） */
export const CANNOT_COME_RE = /出張|遠方|県外|海外|(?:東京|神奈川|千葉|埼玉|名古屋|愛知|静岡|福岡|広島|岡山|山口|四国|九州|北海道|沖縄|東北|新潟|長野|石川|富山|地方)(?:に|で|の方に)?(?:住んで|在住|に住|おり|いて|居て|暮らし)|伺え(?:ない|ません)|伺う(?:こと|事)が(?:でき|出来)(?:ない|ません)|(?:行け|来られ|来れ|こられ)(?:ない|ません)|予定(?:が)?(?:詰ま|埋ま|立た|合わ)|しばらく|当分|今週は(?:内覧に|内見に)?(?:無理|難し|厳し|行けな)|(?:内見|内覧)(?:でき|出来)(?:ない|ません)|見に行けな|(?:都合|予定|行け|伺え|来られ|来れ)[^。\n]{0,14}(?:以降|以後)/;
//   ↑ 最後の「都合つくのが9月13日以降」は 2c434b28 8/30（竹内さん「一度弊社撮影またはオンライン内見をさせて頂き…抑えた状態で、9月13日以降のご内覧日に」）

/** オンライン内見・室内の撮影の語 */
//   「室内写真・動画を撮影しお送り」（YUMA busy_weak 10/08 の DeepSeek の下書き＝ブレインの方向どおりの撮影の約束が PHOTO_NO_PREMISE で消えた）も申し出に数える
const OFFER_WORD_RE = /オンライン(?:での)?内[見覧]|ビデオ通話|(?:室内|お部屋|写真|動画)[^。！!？?\n]{0,10}撮影|(?:弊社|スタッフ)(?:で|が|の)?撮影|撮影(?:や|も|または|か)/;
/** 申し出の形（これからできる・対応する） */
const OFFER_FORM_RE = /(?:ご?対応|行わ|させて(?:頂|いただ)|致し|いたし|可能|でき|出来)/;
/** 申し出ではない物（撮影済み・送った言い切り＝スタッフだけが知る結果／日時・金額） */
const NOT_OFFER_RE = /(?:撮影|お送り)(?:しました|致しました|いたしました|させて(?:頂|いただ)きました)|撮影した(?:お)?(?:写真|動画)|[0-9０-９]{1,2}\s*[\/／月:：時]|円/;

/** その1文が「オンライン内見・室内の撮影もできる」という申し出か */
export function isViewingOfferSentence(sentence: string | null | undefined): boolean {
  const s = String(sentence ?? "").normalize("NFKC");
  return OFFER_WORD_RE.test(s) && OFFER_FORM_RE.test(s) && !NOT_OFFER_RE.test(s);
}

function sentences(text: string): string[] {
  return (String(text ?? "").match(/[^。！!？?\n]+[。！!？?😊😌✨🌟]*/g) ?? []).map((x) => x.trim()).filter(Boolean);
}

/** お客様の発言（直近）に、すぐ・現地に来られない事情があるか */
export function customerCannotCome(customerTexts: string | null | undefined): boolean {
  return CANNOT_COME_RE.test(String(customerTexts ?? "").normalize("NFKC"));
}

/**
 * 決定論の PHOTO_NO_PREMISE／PHOTO_REPLACES_VIEWING を出さないか:
 *   お客様が来られない事情を言っていて、本文の「撮影」を含む文が全部、申し出の文である時だけ。
 */
export function photoOfferExempt(draft: string, customerTexts: string, env?: Record<string, string | undefined>): boolean {
  if (!viewingOfferExemptEnabled(env)) return false;
  if (!customerCannotCome(customerTexts)) return false;
  const photo = sentences(draft).filter((s) => /撮影/.test(s));
  return photo.length > 0 && photo.every(isViewingOfferSentence);
}

/** LLM の指摘で外す型（申し出を「AIX の番の約束」「余計な提案」「ルール違反」「会社の制度の捏造」と読む物）。金額・名前などは外さない
 *  FABRICATED_POLICY: オンライン内見・室内の撮影は会社の事実（company-facts・company-fact-guard「内覧はオンライン内見も選べる」）。YUMA の DeepSeek 2回目で anomaly_scan が付けた */
const OFFER_FLAG_CODES: ReadonlySet<string> = new Set([
  "AIX_BOUNDARY_PROMISE", "AIX_BOUNDARY_VIEWING", "AIX_BOUNDARY_DB", "RULE_VIOLATION", "UNPROMPTED_PROPOSAL", "FABRICATED_POLICY", "PHOTO_NO_PREMISE", "PHOTO_REPLACES_VIEWING",
]);

/**
 * LLM の指摘が、来られない事情のお客様への申し出の文だけを指しているか（＝外す）。
 *   引用（evidence）が本文のどれかの申し出の文の中にあり、引用自体もオンライン内見・撮影の語を含む時だけ。
 */
export function isViewingOfferFlag(code: string, evidence: string, draft: string, customerTexts: string, env?: Record<string, string | undefined>): boolean {
  if (!viewingOfferExemptEnabled(env)) return false;
  if (!OFFER_FLAG_CODES.has(code)) return false;
  if (!customerCannotCome(customerTexts)) return false;
  const ev = String(evidence ?? "").normalize("NFKC").replace(/[「」『』"]/g, "").trim();
  if (!ev || !OFFER_WORD_RE.test(ev)) return false;
  const core = ev.replace(/[。！!？?😊😌✨🌟\s]+$/u, "");
  return sentences(draft).some((s) => isViewingOfferSentence(s) && s.normalize("NFKC").includes(core));
}
