// scripts/lib/exam-shape-candidates.ts — 試験の問題を「形の欄の当てはめ」で選ぶ（作業員A・2026-11-27・作業員L の問題選び3段の②）
//   純関数・LLM なし・DB なし。problems.json の行（type・sub・accept・mustNot・hourJst・customer）だけで、スイッチの1行が効く形の問題（eff）と守り（guard）を出す。
//   当てはめを持たないスイッチは null（RAG の重心か辞書に任せる）。11/27 夕方に night_bundle_candidates の 11/29 の欄で手で選んだ物と同じ決まりを関数にした。
//   CHAIN_INSIGHT_LINE は照らしの json（駅・細かい状態・前の AIX）が要るので、ここではなく scripts/audit-chain-candidates.ts のまま（null）。
export type ProblemIn = { id: string; type?: string; sub?: string; accept?: string[]; mustNot?: string[]; hourJst?: number; customer?: string; tags?: string[] };
export type ShapeCandidates = { eff: string[]; guard: string[]; why: string };

/** 揺れる問題（11/27 までの晩で off どうしでも結果が変わった物）は効く・守りのどちらにも入れない */
export const UNSTABLE_PROBLEMS = new Set(["q008", "q014", "q176", "q202", "q322", "q405", "q419"]);
const has = (a: string[] | undefined, x: string | RegExp) => (a ?? []).some((v) => (typeof x === "string" ? v === x : x.test(v)));
const subIs = (p: ProblemIn, re: RegExp) => re.test(p.sub ?? "");
const byId = (a: ProblemIn, b: ProblemIn) => a.id.localeCompare(b.id);
const take = (ps: ProblemIn[], n: number) => ps.filter((p) => !UNSTABLE_PROBLEMS.has(p.id)).sort(byId).slice(0, n).map((p) => p.id);

type Rule = { eff: (p: ProblemIn) => boolean; guard: (p: ProblemIn) => boolean; nEff: number; nGuard: number; why: string };
const RULES: Record<string, Rule> = {
  // 今確かめられるか（管理会社の時間・前に確かめた物件）: 時間内に竹内さんがその場で AIX【物件確認した】／守り＝約束の返信が先で AIX【物件確認した】はいけない
  CHECK_NOW_POSSIBLE_LINE: {
    eff: (p) => has(p.accept, "AIX:property_check_result") && subIs(p, /^(?:question|property_share|apply):/) && (p.hourJst ?? -1) >= 10 && (p.hourJst ?? 99) <= 18,
    guard: (p) => has(p.accept, "2段:check") && !has(p.accept, "AIX:property_check_result") && has(p.mustNot, "AIX:property_check_result"),
    nEff: 8, nGuard: 6,
    why: "正解に AIX【物件確認した】（問い・物件の持ち込み・申込の番・10〜18時）／守り＝正解が2段:check で AIX【物件確認した】がしてはいけない",
  },
  // 送れる候補が今の条件にも合うか: 探す約束の後・条件の言い直しで AIX【物件】／守り＝2段:pickup が正解で AIX【物件】はいけない
  PICKUP_FIT_NOW_LINE: {
    eff: (p) => (has(p.accept, "AIX:物件") || has(p.accept, "AIX:property_send")) && subIs(p, /^(?:ack:約束の後|conditions:|other:その他・約束の後)/) && (has(p.mustNot, "返信") || has(p.mustNot, "2段:pickup")),
    guard: (p) => has(p.accept, "2段:pickup") && !has(p.accept, /^AIX:(?:物件|property_send|property_recommendation)$/) && has(p.mustNot, /^AIX:(?:物件|property_send)$/),
    nEff: 10, nGuard: 6,
    why: "正解に AIX【物件】（約束の後のお礼・条件の言い直し・返信か2段がしてはいけない）／守り＝2段:pickup が正解で AIX【物件】がしてはいけない",
  },
  // 物件への反応の番の柔らかい次の一手（#815）: 好意・中身の質問で竹内さんが誘った／守り＝誘いがしてはいけない反応の番
  ACK_SOFT_NEXT: {
    eff: (p) => has(p.accept, /^AIX:(?:viewing_invite|application_push|property_recommendation)$/) && subIs(p, /^(?:other|considering|question):/) && /気にな|いい|良い|見たい|見てみたい|即入居/.test(p.customer ?? ""),
    guard: (p) => has(p.mustNot, /^AIX:(?:viewing_invite|application_push)$/) && subIs(p, /^(?:considering|other|ack:物件を送った後|cost:支払い方)/),
    nEff: 7, nGuard: 6,
    why: "正解に内覧の誘い・申込へ・オススメ（物件への好意・中身の質問）／守り＝内覧の誘い・申込へがしてはいけない反応の番",
  },
  // 2択の形の番でブレインが候補にしていない全力サポートを外す（#818 案 A）
  SEARCH_CHOICE_TWO_MODE_SPLIT: {
    eff: (p) => has(p.mustNot, /^(?:AIX:zenryoku_support|右:全力)$/),
    guard: (p) => has(p.accept, "AIX:左右"),
    nEff: 8, nGuard: 4,
    why: "してはいけないに全力サポート（AIX:zenryoku_support・右:全力）／守り＝AIX:左右 が正解（ブレインが全力を候補にする番）",
  },
};

/** スイッチの形の当てはめ。当てはめを持たないスイッチは null */
export function shapeCandidates(sw: string, problems: ReadonlyArray<ProblemIn>): ShapeCandidates | null {
  const r = RULES[sw];
  if (!r) return null;
  const eff = take(problems.filter(r.eff), r.nEff);
  const effSet = new Set(eff);
  const guard = take(problems.filter((p) => !effSet.has(p.id) && r.guard(p)), r.nGuard);
  return { eff, guard, why: r.why };
}
export const SHAPE_SWITCHES = Object.keys(RULES);
