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
