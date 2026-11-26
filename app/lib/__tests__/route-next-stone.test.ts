// app/lib/__tests__/route-next-stone.test.ts — 次の石（2026-11-26 作業員A・竹内さん 11/26 昼）
//   実行: npx tsx app/lib/__tests__/route-next-stone.test.ts
import { stoneMoveOf, stoneShare, nextStoneLine, nextStoneLineOn, NEXT_STONE, STONE_TOOLS, aixKindMissOf, VIEWING_STONES } from "../route-next-stone";
import { AIX_DICTIONARY } from "../aix-dictionary";
import { AIX_BOUNDARIES } from "../aix-boundary";
import { actTarget } from "../../../scripts/lib/route-progress";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("提案中 → 見積・気に入った物件の確かめは次の石", stoneMoveOf("proposing", "estimate") === "next_stone" && stoneMoveOf("proposing", "interested") === "next_stone");
t("提案中 → 内覧の誘いは先の仕込み（急ぎすぎではない）", stoneMoveOf("proposing", "viewing_arrange") === "plant_ahead");
t("提案中 → 申込のご案内は申込へ飛ばした", stoneMoveOf("proposing", "apply_prep") === "skip_apply");
t("見積 → 申込のご案内は次の石（内覧なしの道）・内覧後 → 申込も次の石", stoneMoveOf("estimate", "apply_prep") === "next_stone" && stoneMoveOf("viewed", "apply_prep") === "next_stone");
t("約束・答え・同じ駅・戻る・駅が分からない", stoneMoveOf("pickup", "promise") === "promise" && stoneMoveOf("pickup", null) === "hold" && stoneMoveOf("proposing", "proposing") === "same" && stoneMoveOf("estimate", "proposing") === "back" && stoneMoveOf(null, "estimate") === "unknown");
const sh = stoneShare(["next_stone", "promise", "plant_ahead", "skip_apply", "hold", "unknown"]);
t("割合: 一歩ずつ＝次の石へ＋約束・分母は駅が決まる番", sh.step === 2 && sh.plant === 1 && sh.skip === 1 && sh.n === 5);
t("材料の1行（既定 off・まだ配線しない）", nextStoneLine("interested").includes("内覧の誘い") && nextStoneLine("other") === "" && !nextStoneLineOn({}));
t("表: 本線の申込の手前の駅が全部ある", ["inquiry", "hearing", "pickup", "proposing", "interested", "estimate", "viewing_arrange", "viewing_scheduled", "viewed", "apply_prep"].every((k) => !!NEXT_STONE[k as keyof typeof NEXT_STONE]));
t("道具の表: AIX は全部辞書にある・境目の行は全部境目の表にある", Object.values(STONE_TOOLS).every((x) => x!.aix.every((a) => !!AIX_DICTIONARY[a]) && x!.boundary.every((b) => AIX_BOUNDARIES.some((y) => y.id === b))));
t("AIX の選び違い: 同じ石で種類違い（おすすめ⇄送る）は数える・違う石・返信は数えない", aixKindMissOf("pickup", "aix:property_send", "aix:property_recommendation", actTarget) && !aixKindMissOf("proposing", "aix:estimate_sheet", "aix:viewing_invite", actTarget) && !aixKindMissOf("pickup", "aix:property_send", "reply:", actTarget));
t("内覧の当日〜申込の細かい石: 4つ・AIX は辞書にある", VIEWING_STONES.length === 4 && VIEWING_STONES.every((v) => v.aix.every((a) => !!AIX_DICTIONARY[a])) && VIEWING_STONES.every((v) => !/さん[、「]/.test(v.phrase.join(""))));
console.log(`route-next-stone: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
