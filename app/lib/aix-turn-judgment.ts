// app/lib/aix-turn-judgment.ts — AIX の番の「竹内さんの最初の一手」と「送る直前のブレインの判断」を同じ物差しで比べる（純関数・DB/LLM なし）
//
// 2026-11-23 作業員A（竹内さん 11/23「AIX の番の判断なんでこんなに弱いのか」）。scripts/audit-aix-turn-judgment.ts と、毎朝の物差しが同じ決まりで数えるための関数。
//   数え方の誤り（2段の後の AIX を「AIX の番」と数える・AIX の中身の手打ちを「返信の番」と数える）を外す。決まり:
//     P0 ca55d42b（AIX と返信の分け方）・0f4604a9（要る→手元に無ければ約束の返信→あればボタン）・10/02 の決定「いつも約束の返信を先に」（2段）。
export type TurnMove = { at: number; aix: boolean; aixKind?: string | null };
export type TurnClass = "aix_first" | "quick" | "two_stage" | "hand_aix" | "reply";
export type BrainRoute = { route: "aix" | "two_stage" | "reply"; kind: string | null };
export type TurnVerdict = "一致" | "種類違い" | "返信の番をAIX" | "AIXの番を返信" | "先後" | "返信一致";

/** AIX の種類の束（オススメ＋ピックアップは1つ・見張りの aixBundleFamily と同じ見方）。aix-catalog の鍵（ボタン/ピッカー）はボタンだけ */
export function aixBundle(k: string | null | undefined): string | null {
  const b = String(k ?? "").split("/")[0].trim();
  if (!b) return null;
  if (/^(?:property_send|property_recommendation|new_arrival)/.test(b)) return "property";
  return b;
}

/** 竹内さんの番の分け（moves は時刻順・お客様の次の発言の手前まで）。handKeys は手打ちの文の本来の AIX（aix-should-be の strong）の鍵 */
export function turnClassOf(moves: readonly TurnMove[], handKeys: readonly string[] = []): TurnClass {
  if (!moves.length) return "reply";
  const first = moves[0];
  if (first.aix) return "aix_first";
  const firstAix = moves.find((m) => m.aix);
  if (firstAix) return firstAix.at - first.at <= 120_000 ? "quick" : "two_stage";
  return handKeys.length ? "hand_aix" : "reply";
}

/** この番の竹内さんの AIX の種類（最初の AIX・無ければ手打ちの本来の AIX）。束にした名前 */
export function aixKindOfTurn(moves: readonly TurnMove[], handKeys: readonly string[] = []): string | null {
  const a = moves.find((m) => m.aix && m.aixKind);
  if (a) return aixBundle(a.aixKind);
  if (moves.some((m) => m.aix)) return "?";
  return handKeys.length ? aixBundle(handKeys[0]) : null;
}

/** 送る直前のブレインの道（decision_source の two_stage_promise は2段＝約束の返信→後で AIX） */
export function brainRouteOf(mode: string | null | undefined, action: string | null | undefined, source: string | null | undefined): BrainRoute {
  if (/two_stage_promise/.test(String(source ?? ""))) return { route: "two_stage", kind: aixBundle(action) };
  if (mode === "aix" && action) return { route: "aix", kind: aixBundle(action) };
  return { route: "reply", kind: null };
}

/**
 * 1番の判定。
 *   aix_first・quick・hand_aix: ブレインの AIX が同じ種類なら一致・別の種類は種類違い・2段か返信なら「AIXの番を返信」
 *   two_stage: ブレインが2段か返信（約束）なら一致・同じ種類の AIX を今と言ったら先後・別の AIX は種類違い
 *   reply: ブレインが AIX なら「返信の番をAIX」（ブレインの言い過ぎ）・それ以外は返信一致
 */
export function judgeTurn(cls: TurnClass, takeuchiKind: string | null, b: BrainRoute): TurnVerdict {
  if (cls === "reply") return b.route === "aix" ? "返信の番をAIX" : "返信一致";
  if (cls === "two_stage") {
    if (b.route !== "aix") return "一致";
    return b.kind === takeuchiKind ? "先後" : "種類違い";
  }
  if (b.route !== "aix") return "AIXの番を返信";
  return b.kind === takeuchiKind ? "一致" : "種類違い";
}
