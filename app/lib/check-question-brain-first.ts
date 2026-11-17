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
  return (env.TWO_STAGE_CHECK_QUESTION_BRAIN_FIRST ?? "").trim().toLowerCase() !== "off"; // 2026-11-18 既定 on（k1115-cqbf-p2/p3・k1118-cqbf-p1a＝9問＋守り 悪化0）
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

// ─── 2026-11-15 作業員H（統括役の頼み・試験の外れの台帳で通算一番多い「2段で道が変わる」の調べ）────────────────
//   上の型の反対側: ブレインが自分の依頼（turn_contract）で route="aix"（その AIX で結果を送る）と決めた番まで、
//   聞かれた事の確認の約束（check_question）に書き換えていた。試験の答案 14日（scripts/audit-exam-two-stage-essence.ts）:
//   check_question の書き換えが入った答案 18 のうち、本質（ブレインの道）が当たりで書き換えで外れた番 2・書き換えで当たりになった番 0。
//   実物: q411（物件確認した＋御見積書同封の後の「鍵交換代は必須ですか」→ 竹内さんは AIX【確認した】・ブレインは route=aix の物件確認した/設備）。
//   P0 ca55d42b（スタッフだけが知る事は AIX）と決定 0f4604a9（手元に無ければ約束・あればどのボタン）: 手元にあるかを決めるのはブレイン（P0 9eb6aa9c）。
//   守り: ブレインが route="promise" と書いた番（q177・q180・q015・q163・q092 の形＝aix の欄が物件確認したでも依頼は約束）は今まで通り書き換える。
//   既定 off（TWO_STAGE_CHECK_QUESTION_KEEP_AIX=on）
export function checkQuestionKeepAixOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.TWO_STAGE_CHECK_QUESTION_KEEP_AIX ?? "").trim().toLowerCase() === "on";
}
/** ブレインの依頼に route="aix" で今の AIX（または同じボタン）を送る ask があり、確認の約束（route=promise）の ask が無いか */
export function brainChoseAixForQuestion(i: { finalAix: unknown; contract: unknown }): boolean {
  const fa = String(i.finalAix ?? "").trim();
  if (!fa || /^(?:null|none|undefined)$/i.test(fa)) return false;
  const c = i.contract as { asks?: unknown } | null;
  const asks = c && Array.isArray(c.asks) ? (c.asks as Ask[]) : [];
  if (!asks.length || contractHasCheckPromise(asks)) return false;
  const btn = fa.split("/")[0];
  return asks.some((a) => a?.route === "aix" && String(a?.aix ?? "").split("/")[0] === btn);
}
