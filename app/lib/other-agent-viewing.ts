// other-agent-viewing.ts — 他社（別の不動産屋・掲載元）で内覧する／した物件を、弊社で申込めるかの質問か（純関数）
//
// 2026-10-18 弱い所B（q166・本番 a3cc571e 10/11）: お客様「明日もともとスーモに乗せていた / 不動産屋さんに依頼して / 内覧予定になってるんですが /
//   気に入ればそのまま / こちらでお願いとかもできますか？」。竹内さんは「はい😊！！そのまま弊社でのお手続きで大丈夫です・弊社でもご内覧可能です」と即答（返信）。
//   旧: 会社の事実 other_company_viewing の網は「他社・別の不動産」の語だけ＋改行で窓が切れる＝当たらず、
//       場面の材料（aix-scene-evidence S4）は「内覧」の語だけで内覧の希望（候補 viewing_invite）と渡し、ブレインは AIX 内覧日調整を選んだ。
//   直し: 「他社で内覧する話＋こちらで申込めるか」を1か所で読み、会社の事実を渡す・内覧の希望の材料にしない（内覧日の調整はブレインが決める・材料を正す）。
//   戻す OTHER_AGENT_VIEWING=off（旧の網だけ）

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
export function otherAgentViewingEnabled(env: Env = envOf()): boolean {
  return (env.OTHER_AGENT_VIEWING ?? "").trim().toLowerCase() !== "off";
}

/** 他社・掲載元の不動産屋の話（「不動産屋さんに依頼して」「スーモに載せていた業者」「他社で」） */
const OTHER_AGENT_RE = /他(?:社|の(?:不動産|会社|業者|お店|店舗))|別の(?:不動産|会社|業者|お店)|違う(?:不動産|会社|業者)|(?:不動産屋|不動産会社|業者|仲介(?:業者|会社)?)(?:さん)?(?:に|で|経由|から)|(?:スーモ|SUUMO|ホームズ|HOME'?S|アットホーム|ポータル)(?:に|で)(?:載|乗|掲載|出)(?:せ|し|て)/i;
/** その話の内覧（依頼して・予約して・内覧予定・内見した） */
const VIEWING_RE = /内覧|内見|見学|案内/;
/** こちらで申込める／お願いできるかの問い（「こちらでお願いとかもできますか」「御社で申し込めますか」）。
 *  10/18 確かめる人: 「他社で内覧した物件ですが、こちらでも内覧お願いできますか」（弊社で内覧したい＝本当の内覧の希望）は当てない＝こちらで〜の間に内覧の語がある時は外す */
const APPLY_HERE_RE = /(?:こちら|そちら|御社|貴社|弊社|スモラ|イエヤス|ギガ)(?:さん|様)?(?:で|に)(?:(?!内覧|内見|見学|案内)[^。]){0,14}(?:お願い|申込|申し込|契約|手続|借り|進め|抑え|押さえ)/;
const ASK_RE = /[?？]|でき(?:ます|る)|出来(?:ます|る)|可能|大丈夫|いけ(?:ます|る)|ですか|でしょうか|もらえ|頂け|いただけ/;

/**
 * 1通（連投の1つ）が「他社で内覧する／した物件を弊社で申込めるか」の質問か。
 * 改行で割れた1通（「不動産屋さんに依頼して / 内覧予定に… / こちらでお願いとかもできますか？」）も1つの文として読む。
 * ⚠ 「スーモで見た物件を内覧したい」（弊社への内覧の希望）は当てない＝こちらで申込めるかの問いと他社の話が両方ある時だけ。
 */
export function isOtherAgentViewingApplyQuestion(text: string | null | undefined, env: Env = envOf()): boolean {
  if (!otherAgentViewingEnabled(env)) return false;
  const s = String(text ?? "").normalize("NFKC").replace(/\s+/g, " ");
  if (!s.trim()) return false;
  return OTHER_AGENT_RE.test(s) && VIEWING_RE.test(s) && APPLY_HERE_RE.test(s) && ASK_RE.test(s);
}

// ── 2026-10-20 竹内さんの決定（設計知見 d6b6edc1・愛実 c16e9f4a 10/20）: 他社で内覧する予定を伝えられた時は否定せず、弊社でも内覧できる・弊社で内覧する利点で誘う ──
//   お客様「他社さんで〇〇の内見の予定あって、一度そっちでサクッと内見だけしてこようかなと思ってるんですが大丈夫でしょうか？？」
//   竹内さん「大丈夫です😊！！ / 〇〇さんよろしければ弊社にてご内見可能です！！ / ご挨拶も兼ねまして一度ご内見頂ければ〇〇さんもご安心してお任せ頂けると思います！！」
//   本番の下書きは「全然大丈夫です・他社で内覧した後でも弊社で申込できます」だけで②③が抜けた。
//   ⚠ 「他社で内覧しました・こちらで申込できますか」（もう見た＝過去）は今まで通り（申込できる＋弊社でも内覧できる）。予定（これから見る）の時だけ。
//   戻す OTHER_VIEWING_INVITE=off（会社の事実の追加をやめる）
export function otherViewingInviteEnabled(env: Env = envOf()): boolean {
  return (env.OTHER_VIEWING_INVITE ?? "").trim().toLowerCase() !== "off";
}
/** これから見る（予定・予約・してこよう・依頼して・明日 等）。「見てきました」「内覧しました」（過去）は当てない */
//  10/20: 「別の不動産屋でオンライン内見してここにきめようかなと」（内覧して決めよう＝これから）も当てる。「内見して決めました」（過去）は当てない
const PLAN_RE = /(?:内覧|内見|見学)して[^。]{0,10}(?:きめ|決め)よう(?!と(?:思って(?:た|まし|いた|いまし)|思った|思いまし|して(?:た|まし|いた|いまし)))|予定|予約|(?:し|見|行っ)てこよ|見に行(?:く|こう|き(?:ます|たい))|行(?:く|こう)(?:と|か)|(?:し|見|行っ)てきます|依頼して|これから|明日|明後日|あさって|今度|今週|来週|週末|(?:する|見る|行く)(?:つもり|かも|ので|んです|のです)/;
/** 弊社で内覧したい（本当の内覧の希望）は誘いではなく内覧の調整＝外す */
const VIEW_HERE_RE = /(?:こちら|そちら|御社|貴社|弊社|スモラ|イエヤス|ギガ)(?:さん|様)?(?:で|に)(?:も)?[^。、]{0,6}(?:内覧|内見|見学|案内)/;
/** 他社での内覧の取り消し・やめた（「他社の内見はキャンセルしました」）も外す */
const OTHER_CANCEL_RE = /キャンセル|取り消|断(?:り|っ|る)|やめ(?:ます|まし|た)|なしで|なくな/;
/** 10/20 確かめる人: もう見た（過去）なのに「明日申込」「来週契約予定」「予約できますか」等の別の語で予定と読んでいた＝内覧が過去の形なら外す（今まで通り other_company_viewing だけ） */
const VIEWED_PAST_RE = /(?:内覧|内見|見学)(?:を|は)?(?:し(?:ました|た(?![いくら])|てきました|てきた|てみました|てもらいました|てもらった)|済)|見てきました/;

/**
 * 1通（連投の1つ）が「他社（別の不動産屋）でこれから内覧する予定」を伝えている（大丈夫かの問いを含む）か。
 * 例: 「他社さんで内見の予定あって、一度そっちでサクッと内見だけしてこようかなと思ってるんですが大丈夫でしょうか？？」
 *     「明日スーモに乗せていた不動産屋さんに依頼して内覧予定… こちらでお願いとかもできますか？」（予定＋申込の問い＝両方当たる）
 * ✕ 「他社で内覧しましたが、こちらで申込できますか」（過去）／「他社で見た物件、こちらでも内覧お願いできますか」（弊社での内覧の希望）
 */
export function isOtherAgentViewingPlan(text: string | null | undefined, env: Env = envOf()): boolean {
  if (!otherAgentViewingEnabled(env) || !otherViewingInviteEnabled(env)) return false;
  const s = String(text ?? "").normalize("NFKC").replace(/\s+/g, " ");
  if (!s.trim()) return false;
  if (!OTHER_AGENT_RE.test(s) || !VIEWING_RE.test(s) || !PLAN_RE.test(s)) return false;
  if (VIEW_HERE_RE.test(s) || OTHER_CANCEL_RE.test(s) || VIEWED_PAST_RE.test(s)) return false;
  return true;
}

// ── 2026-10-21 竹内さんの答え（B8・C8）: ブレインの材料の行（決まった文ではなく判断の原則）──────────────────────────
//   B8「良い 状況にもよるがお客さんをサポートする姿勢の文をブレイン判断」: 「気に入ればこちらで（お願いできますか）」の問いには、
//     お客様をサポートする姿勢の一文を入れるかをブレインが状況で決める（言い回しは固定しない）。戻す SUPPORT_STANCE_NOTE=off
//   C8「別の物件をだすやくそくしてAIX物件ピックアップや物件オススメからおくる」: 条件が合わず他（他社）で探すと言われた番は、
//     お礼で終えず別の物件を出す約束をして、物件の AIX（物件ピックアップした／物件オススメ）から送る。
//     ⚠ 他社で契約が決まった（C7＝お礼で終える）は当てない。戻す LOOK_ELSEWHERE_PICKUP=off
export function supportStanceNoteEnabled(env: Env = envOf()): boolean {
  return (env.SUPPORT_STANCE_NOTE ?? "").trim().toLowerCase() !== "off";
}
export function lookElsewherePickupEnabled(env: Env = envOf()): boolean {
  return (env.LOOK_ELSEWHERE_PICKUP ?? "").trim().toLowerCase() !== "off";
}
const LIKE_THEN_HERE_RE = /気に入(?:れば|ったら|りましたら|った場合)[^。]{0,16}(?:こちら|そちら|御社|貴社|スモラ|イエヤス|ギガ)(?:さん|様)?(?:で|に)/;
/** 「気に入ればこちらで（お願いできますか）」の問いか（他社で内覧＋こちらで申込の問い・気に入ればこちらでの形） */
export function isLikeThenHereQuestion(text: string | null | undefined, env: Env = envOf()): boolean {
  const s = String(text ?? "").normalize("NFKC").replace(/\s+/g, " ");
  if (!s.trim()) return false;
  return isOtherAgentViewingApplyQuestion(s, env) || (LIKE_THEN_HERE_RE.test(s) && ASK_RE.test(s));
}
export const SUPPORT_STANCE_LINE = "【今の番（材料・竹内さんの答え 10/21 B8）】お客様は「気に入ればこちらで」と聞いている。答え（弊社でお手続き・ご内覧できる）に加えて、お客様をサポートする姿勢の一文を入れるかは会話の状況を読んであなたが決める（決まった言い回しは無い・同じ文を毎回使わない・押し付けない）。";

const ELSEWHERE_RE = /他(?:社|の(?:不動産|会社|業者|お店|ところ|所)|で|を|も|当た)|別の(?:不動産|会社|業者|お店|ところ)|違う(?:不動産|会社|ところ)|自分で/;
const SEARCH_RE = /探(?:し|す|そう|してみ)|当たっ?て|見てみ|あたっ?て/;
const MISMATCH_RE = /条件|合わ(?:な|ず)|合いそうに|希望(?:に|の)[^。]{0,6}(?:な|無|合)|予算|無さそう|なさそう|ないので|無いので|厳し|難しそう|見つからな/;
const CONTRACT_DONE_RE = /(?:決ま|決め|契約(?:し|が決|する事|することに))(?:り|た|まし|て)|申込(?:み)?(?:し|ま)(?:ました|た)/;
/** 条件が合わず他（他社）で探すと言った番か（他社で契約が決まった番は外す） */
export function isLookElsewhereForConditions(text: string | null | undefined, env: Env = envOf()): boolean {
  if (!lookElsewherePickupEnabled(env)) return false;
  const s = String(text ?? "").normalize("NFKC").replace(/\s+/g, " ");
  if (!s.trim() || CONTRACT_DONE_RE.test(s)) return false;
  return ELSEWHERE_RE.test(s) && SEARCH_RE.test(s) && MISMATCH_RE.test(s);
}
export const LOOK_ELSEWHERE_LINE = "【今の番（材料・竹内さんの答え 10/21 C8）】お客様は条件が合わず他で探すと言っている。お礼だけで終えず、別の物件をお出しする約束（route=promise・about=search_condition）にし、物件は AIX【物件ピックアップした】（複数）／【物件オススメ】（1件）から送る。他社で契約が決まった時だけはお礼で終える。";
