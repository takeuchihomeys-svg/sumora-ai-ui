// app/lib/aix-follows-contract.ts — ブレインの出力の中の食い違い（aix の欄・決まった道の AIX と turn_contract の依頼）を、本質（turn_contract）の側に寄せる（純関数）
//
// 2026-11-13 作業員7b（統括役の了承・竹内さん 11/13「今分かっている弱い所も改善する。足りない土台の強化と具体的な細分化で直す」・P0 9eb6aa9c 判断はブレイン基準）:
//   V2 で数え直して残った「2段で道が変わる」外れの T3（q431・q092・q001）と T4（q009・q367）は、どれもブレイン自身の turn_contract と、
//   決まった道の AIX（ブレインの aix の欄・合図の物件の AIX）が食い違っていた。後ろの決まった計算（pickup_unless_ack・check_question・ピックアップの2択）は
//   AIX の欄だけを見て、ブレインの本質と違う道を作っていた。決まった計算の前に、本質の側に寄せる（道を新しく作らない・ブレインの答えの中で揃えるだけ）。
//   揃え方:
//     ① 物件の AIX なのに、turn_contract の依頼が全部 返信・なし（閉じる・受けるだけ）＝返信（q431「引き続きどうぞよろしくお願いいたします」route none）
//     ② 物件の AIX なのに、ブレインの aix の欄は空で、turn_contract に確認の AIX（物件確認した）の依頼がある＝その確認の AIX（q092#1「ここは最短11月中旬でしょうか？」aix/procedure）
//     ③ 探す約束（about=search_condition の promise）なのに AIX の欄が物件確認した＝ピックアップの約束（two-stage の TWO_STAGE_KIND_FROM_ABOUT の形・q009・q367）
//   当てない: 探す約束と物件の AIX が揃っている番（q001・出し切りの左右は別の決まり）・申込以降。
//   既定 on（11/14 試験で悪化0・既定 on。止める時は BRAIN_AIX_FOLLOWS_CONTRACT=off）。③ は two-stage.ts の中で、このスイッチか TWO_STAGE_KIND_FROM_ABOUT のどちらかが on の時に当たる（古いスイッチは残す）。
//   11/14 作業員D: q431 の直し（39d465e4・replyPlanAfterFollow）を入れた試験 wc-q431-on1-p1・p2 で q431 合格 3/3・比べた 6問で確かな悪化0
type Env = Record<string, string | undefined>;

export function brainAixFollowsContractOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  // 2026-11-14 作業員D: 11/14 試験で悪化0・既定 on（止める BRAIN_AIX_FOLLOWS_CONTRACT=off）
  return (env.BRAIN_AIX_FOLLOWS_CONTRACT ?? "on").trim().toLowerCase() !== "off";
}

const PROPERTY_AIX = /^(?:property_send|property_recommendation|property_search|property_pickup)$/;
const CHECK_AIX = /^(?:property_check_result|acknowledge_check)$/;
const emptyAix = (v: unknown) => /^(?:|null|none|undefined)$/i.test(String(v ?? "").trim());
const keyOf = (v: unknown) => String(v ?? "").trim().split(/[/（(]/)[0];

export type ContractAskLite = { route?: unknown; about?: unknown; aix?: unknown };
export type FollowVerdict = { to: "reply"; rule: "all_reply" } | { to: "aix"; aix: string; rule: "contract_check_aix" } | null;

/**
 * 決まった道の AIX（finalAix）を、ブレインの turn_contract の依頼に揃える。揃える必要が無い・分からない時は null（今のまま）。
 *   rawAix はブレインが aix の欄に書いた値（空なら決まった道の AIX は合図・規則から来た）
 */
// 2026-11-13 作業員C（q431 の悪化 w7b-t3-on3「前 2/2 → 今 0/1」の原因）: ① で道を返信に寄せても、返信の方向（reply_direction・key_topics）は
//   ブレインが物件の AIX に添えるつもりで書いた「約束した2LDKの物件ピックアップを実行して届ける」のまま残っていた。
//   採点は「依頼『引き続きよろしく』に返信で答える指示が無い」で✕（道は○）。書き手に渡ると「今送る」文になり、言ってはいけない事
//   「新しい物件を今送ったかのように書く」に当たる。竹内さんの実送信は「はい！！オススメできるお部屋出次第随時お送りさせていただきます」
//   （開いているピックアップの約束を、受けて続ける）。① で返信にした番だけ、今送る向きの方向を「受けて・約束を続けて締める」に揃える。
const SEND_NOW_RE = /(?:物件|お部屋|ピックアップ)[^。]{0,24}(?:送る|送付|届ける|お送りする|お届け|実行)|(?:送る|届ける|お送りする)$/;
const LATER_RE = /出次第|入り次第|見つかり次第|新着が出/; // 後で送る約束（今送る向きではない）
export type FollowReplyPlan = { direction: string; keyTopics: string[]; avoidTopics: string[]; changed: boolean };
/** ① で返信に寄せた番の返信の方向を揃える（純関数）。今送る向きの方向・話題が無ければ changed=false（今のまま） */
export function replyPlanAfterFollow(i: { direction: unknown; keyTopics: unknown; avoidTopics: unknown; openPickupPromise: boolean }): FollowReplyPlan {
  const dir = String(i.direction ?? "").trim();
  const kt = Array.isArray(i.keyTopics) ? i.keyTopics.map(String) : [];
  const av = Array.isArray(i.avoidTopics) ? i.avoidTopics.map(String) : [];
  const sendNowDir = SEND_NOW_RE.test(dir) && !LATER_RE.test(dir);
  const ktKeep = kt.filter((t) => !SEND_NOW_RE.test(t) || LATER_RE.test(t));
  if (!sendNowDir && ktKeep.length === kt.length) return { direction: dir, keyTopics: kt, avoidTopics: av, changed: false };
  const keep = "オススメできるお部屋が出次第随時お送りする";
  const direction = i.openPickupPromise
    ? `お客様の言葉を受け止め、${keep}と約束を続けて締める（今物件を送ったようには書かない）`
    : "お客様の言葉を受け止めて締める（今物件を送ったようには書かない）";
  const keyTopics = i.openPickupPromise && !ktKeep.some((t) => /出次第/.test(t)) ? [...ktKeep, keep] : ktKeep;
  const ng = "新しい物件を今送ったかのように書く";
  return { direction: sendNowDir ? direction : dir || direction, keyTopics, avoidTopics: av.includes(ng) ? av : [...av, ng], changed: true };
}

export function alignAixToContract(i: { finalAix: string | null | undefined; rawAix: unknown; asks: ReadonlyArray<ContractAskLite> | null | undefined }): FollowVerdict {
  const fa = keyOf(i.finalAix);
  if (!fa || !PROPERTY_AIX.test(fa)) return null;
  const asks = (i.asks ?? []).filter(Boolean);
  if (!asks.length) return null;
  // ① 依頼が全部 返信・なし（どの依頼も AIX・約束を言っていない）
  if (asks.every((a) => (a.route === "reply" || a.route === "none") && emptyAix(a.aix))) return { to: "reply", rule: "all_reply" };
  // ② ブレインの aix の欄は空・依頼に確認の AIX がある（物件の AIX は合図・規則から来た）
  if (emptyAix(i.rawAix)) {
    const chk = asks.find((a) => a.route === "aix" && CHECK_AIX.test(keyOf(a.aix)));
    if (chk) return { to: "aix", aix: keyOf(chk.aix), rule: "contract_check_aix" };
  }
  return null;
}
