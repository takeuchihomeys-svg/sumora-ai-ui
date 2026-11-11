// app/lib/check-question-brain-first.ts — 「聞かれた事の確認の約束」（two-stage の check_question）をブレイン自身の答えより先に当てない
//   2026-11-11 作業員7（統括役の決め・P0 9eb6aa9c「判断はすべてブレイン基準」と同じ向き）。既定 off: TWO_STAGE_CHECK_QUESTION_BRAIN_FIRST=on
//
//   型（試験の答案 4日分・本質は正解で最後が外れた番の check_question 19）: ブレイン自身の生の aix が空なのに、場面の信号の
//   物件確認した（scene_evidence の候補）＋お客様の問いだけで「聞かれた事の確認の約束」（2段:check）に書き換えた。
//     q009・q090（ブレインはピックアップの約束・正解 2段:pickup／AIX:物件）・q145（ブレインは返信・正解 返信・mustNot 2段:check）。
//   弱い所 349（審査の問い）・351（送った物件への反応）はこの型の狭い場合（どちらも「ブレインの aix が空で返信」の時だけ外す）。
//   守り: ブレインが自分で aix を選んだ番（q177・q180・q015・q163 は aix=物件確認した で正解 2段:check／q092 は viewing_invite で正解 2段:check）は触らない。
//         依頼に確認の約束（管理会社・募集状況・可否…）がある番（q088・q100・q149）も触らない。
type Env = Record<string, string | undefined>;

export function checkQuestionBrainFirstOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TWO_STAGE_CHECK_QUESTION_BRAIN_FIRST ?? "").trim().toLowerCase() === "on";
}

type Ask = { route?: unknown; aix?: unknown; about?: unknown; answer?: unknown };
const CHECK_AIX = /^(?:property_check_result|acknowledge_check)/;
const CHECK_WORDS = /管理会社|募集状況|空き|空室|可否|問い合わせ|問合せ/;

/** 依頼の中に確認の約束があるか（ある番は今まで通り check_question を当てる） */
export function contractHasCheckPromise(asks: ReadonlyArray<Ask>): boolean {
  return asks.some((a) => a?.route === "promise" && (CHECK_AIX.test(String(a?.aix ?? "")) || CHECK_WORDS.test(String(a?.answer ?? ""))));
}

/**
 * check_question の代わりにブレインの道を取る時の種類。null＝今まで通り（書き換える）。
 *   pickup: ブレインがピックアップの約束（promisesPickup＝override-demote.brainContractPromisesPickup の答え）→ 2段:pickup
 *   reply : 依頼が全部 reply／none → AIX を外して返信
 */
export function checkQuestionBrainRoute(i: { rawAix: unknown; contract: unknown; promisesPickup: boolean }): "pickup" | "reply" | null {
  if (!/^(?:|null|none|undefined)$/i.test(String(i.rawAix ?? "").trim())) return null; // ブレインが自分で AIX を選んだ番は触らない
  const c = i.contract as { asks?: unknown; close_only?: unknown } | null;
  const asks = c && Array.isArray(c.asks) ? (c.asks as Ask[]) : [];
  if (!asks.length || contractHasCheckPromise(asks)) return null;
  if (i.promisesPickup) return "pickup";
  if (asks.every((a) => a?.route === "reply" || a?.route === "none")) return "reply";
  return null;
}
