// app/lib/route-estimate-next.ts — 申込までの地図の見積の駅の「次の一手の候補」を、竹内さんの一手に寄せる（#804・2026-11-28 作業員A・統括役の決め）
//   120日の木（route120・89番）で一番弱かった節 estimate: 地図の次の一手は全部 AIX【内覧日調整】、こちらの一手で AIX【内覧日調整】は 0番
//   （返信で答える 33・約束 15・内覧の誘い 14・見積の誘い 6・AIX は全部で 14）。申込まで届いたのは 返信の内覧の誘い 8/14・答える 13/33。
//   見立て: 向きは合っていて手段が違う。見積の後の誘いは返信で、日程を出す・聞くのは お客様が内覧を望んだ後の AIX【内覧日調整】（地図の viewing_arrange）。
//   竹内さんの決まりと合わせた言い方: 59b45146「日程を聞くのは AIX の仕事」（返信の誘いは『お気に召されましたらご案内させて頂きます』の形）・
//     1cd89eb0「内覧の候補日の質問は AIX で候補日を出す」。なので label は「返信で候補日を伺う」とは書かない。
//   材料の言葉を直すだけ（ブレインに道を決め直させる欄は足さない・q406/q065 の教訓）。ROUTE_ESTIMATE_NEXT_REPLY（既定 off・段階で読む）・印 material_marks.route_estimate_next
//   off の時は同じ物を返す（1文字も変わらない）。サーバーだけで読む（switch-stage）
import { stagedOn, STAGE_OFF } from "./switch-stage";
import { buildApplyRouteBrainText, type ApplyRouteLocation } from "./apply-route-map";

type Env = Record<string, string | undefined>;
export const routeEstimateNextOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => stagedOn("ROUTE_ESTIMATE_NEXT_REPLY", env, STAGE_OFF);

export const ESTIMATE_NEXT_REPLY = {
  label: "見積へのお客様の反応に返信で答える（費用の問いが先なら先に答える）。内覧へは「お気に召されましたらご案内させて頂きます」の形でやわらかく誘い、日程を出す・聞くのはお客様が内覧を望んだ後の AIX【内覧日調整】",
  aix: [] as string[],
};

/** 見積の駅（分かれ道でない）の時だけ次の一手を替えて、材料の文を作り直す。替えたかを changed で返す */
export function withEstimateNextReply(ar: { text: string; loc: ApplyRouteLocation | null }, on: boolean): { text: string; loc: ApplyRouteLocation | null; changed: boolean } {
  if (!on || !ar.loc || ar.loc.node !== "estimate" || ar.loc.branch) return { ...ar, changed: false };
  const loc: ApplyRouteLocation = { ...ar.loc, next: { ...(ar.loc.next ?? { label: "", aix: [] }), label: ESTIMATE_NEXT_REPLY.label, aix: [...ESTIMATE_NEXT_REPLY.aix] } as ApplyRouteLocation["next"], evidence: [...ar.loc.evidence, "見積の駅の次の一手を返信へ（ROUTE_ESTIMATE_NEXT_REPLY）"] };
  return { text: buildApplyRouteBrainText(loc), loc, changed: true };
}
