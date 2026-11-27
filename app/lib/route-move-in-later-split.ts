// app/lib/route-move-in-later-split.ts — 地図の分かれ道「入居時期が先」（move_in_later）の次の一手を、入居までの日数で2つに分ける（#737・2026-11-28 作業員A）
//   竹内さんの決定 11/28（AskUserQuestion「約110日にする」）: 入居まで約110日以内（日が分からない時も）は今から探してお送りする約束・それより先は時期を伝えて約束。
//   120日の照らし（分:move_in_later 27番・竹内さん 15番）: 地図の次の一手「申込の時期を逆算して伝え、再開の時期を約束する」との一致 1/27。
//     竹内さんは 34〜108日で今から探す（9番）・112〜157日で時期の約束（3番）・39日の時期の約束と162日の今から探すの2つだけ外れ（13番で 2）。日が分からない2番は2番とも今から探す。
//   線は time-map.MOVE_IN_SEARCH_NOW_DAYS（1か所で持つ）。材料の言葉だけ替える（道を決め直させる欄は足さない・q406/q065 の教訓）。
//   ROUTE_MOVE_IN_LATER_SPLIT（既定 off・段階で読む）・印 material_marks.route_move_in_later_split（1＝今から探す・2＝時期の約束）。off は同じ物を返す。サーバーだけで読む
import { stagedOn, STAGE_OFF } from "./switch-stage";
import { buildApplyRouteBrainText, type ApplyRouteLocation } from "./apply-route-map";
import { MOVE_IN_SEARCH_NOW_DAYS } from "./time-map";

type Env = Record<string, string | undefined>;
export const routeMoveInLaterSplitOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => stagedOn("ROUTE_MOVE_IN_LATER_SPLIT", env, STAGE_OFF);

export const MOVE_IN_SEARCH_NOW_NEXT = {
  label: `入居まで約${MOVE_IN_SEARCH_NOW_DAYS}日以内（日が分からない時も）なので、条件を確かめて今から探してお送りする約束（約束の返信→物件ピックアップした）`,
  aix: ["property_send"] as string[],
};
export const MOVE_IN_TELL_WHEN_NEXT = {
  label: `入居まで日がある（約${MOVE_IN_SEARCH_NOW_DAYS}日より先）ので、申込の時期を逆算して伝え、探し始める時期を約束する`,
  aix: [] as string[],
};

/** 入居までの日数（null＝分からない）で選ぶ（純関数） */
export function moveInLaterNextOf(daysUntilMoveIn: number | null): typeof MOVE_IN_SEARCH_NOW_NEXT {
  return daysUntilMoveIn == null || daysUntilMoveIn <= MOVE_IN_SEARCH_NOW_DAYS ? MOVE_IN_SEARCH_NOW_NEXT : MOVE_IN_TELL_WHEN_NEXT;
}

/** 分かれ道 move_in_later の時だけ次の一手を替えて、材料の文を作り直す */
export function withMoveInLaterSplit(ar: { text: string; loc: ApplyRouteLocation | null }, on: boolean, daysUntilMoveIn: number | null): { text: string; loc: ApplyRouteLocation | null; mark: 0 | 1 | 2 } {
  if (!on || !ar.loc || ar.loc.branch !== "move_in_later") return { ...ar, mark: 0 };
  const nx = moveInLaterNextOf(daysUntilMoveIn);
  const loc: ApplyRouteLocation = { ...ar.loc, next: { ...(ar.loc.next ?? { label: "", aix: [] }), label: nx.label, aix: [...nx.aix] } as ApplyRouteLocation["next"], evidence: [...ar.loc.evidence, `入居まで ${daysUntilMoveIn ?? "不明"}日（ROUTE_MOVE_IN_LATER_SPLIT）`] };
  return { text: buildApplyRouteBrainText(loc), loc, mark: nx === MOVE_IN_SEARCH_NOW_NEXT ? 1 : 2 };
}
