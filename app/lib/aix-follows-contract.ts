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
//   既定 off（BRAIN_AIX_FOLLOWS_CONTRACT=on）。③ は two-stage.ts の中で、このスイッチか TWO_STAGE_KIND_FROM_ABOUT のどちらかが on の時に当たる（古いスイッチは残す）。
type Env = Record<string, string | undefined>;

export function brainAixFollowsContractOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_AIX_FOLLOWS_CONTRACT ?? "").trim().toLowerCase() === "on";
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
