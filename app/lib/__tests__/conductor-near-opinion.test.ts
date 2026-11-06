// app/lib/__tests__/conductor-near-opinion.test.ts — 入口の意見（近い竹内さんの番の多数の一手・2026-11-07 作業員4）
import { nearOpinion, nearOpinionLine, nearOpinionOn, situationGist, nearOpinionDigest, type NearTurnRow } from "../conductor-near-opinion";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log(`  NG ${n}`); } };
const row = (i: number, route: "aix" | "reply", aix: string | null, d = 0.1): NearTurnRow => ({ key: `msg:${i}`, distance: d, route, aix, situation: `場面: property_share\n段階: proposing\n直前のこちら: 返信\nお客様: 〔物件のURL〕 ここ空いてますか ${i}` });

t("既定 off・on で動く", !nearOpinionOn({}) && nearOpinionOn({ CONDUCTOR_NEAR_OPINION: "on" }) && !nearOpinionOn({ CONDUCTOR_NEAR_OPINION: "shadow" }));
t("束の中が5件未満は意見なし", nearOpinion([row(1, "reply", null), row(2, "reply", null), row(3, "reply", null), row(4, "reply", null)]) === null);
t("束の外（0.2 超）は数えない", nearOpinion([...[1, 2, 3, 4].map((i) => row(i, "reply", null)), row(5, "reply", null, 0.25)]) === null);
const r5 = [1, 2, 3, 4, 5].map((i) => row(i, "reply", null));
const o1 = nearOpinion(r5);
t("全部返信＝返信・割合1", !!o1 && o1.move === "返信" && o1.share === 1 && o1.n === 5 && o1.agree === 5);
t("割合 0.8 未満は意見なし（3/5）", nearOpinion([row(1, "reply", null), row(2, "reply", null), row(3, "reply", null), row(4, "aix", "property_send"), row(5, "aix", "property_send")]) === null);
const mix = [row(1, "aix", "property_check_result", 0.05), row(2, "aix", "estimate_sheet", 0.06), row(3, "aix", "property_check_result", 0.07), row(4, "aix", "estimate_sheet", 0.08), row(5, "aix", "property_check_result", 0.09), row(6, "reply", null, 0.1)];
const o2 = nearOpinion(mix);
t("AIX の多数（5/6=0.83）・種類は一番多い物", !!o2 && o2.move === "AIX" && o2.aix === "property_check_result" && o2.share === 0.83 && o2.exemplar.key === "msg:1");
const line = nearOpinionLine(o2, "〇〇さんお世話になっております！！ 募集状況確認致しましたところ、現在も募集中となっております！！");
t("1行: 一手・割合・一番近い番の要約・竹内さんの実際の文・食い違いは材料を採る（KB e786394e の1組）",
  line.includes("AIX【property_check_result】") && line.includes("83%") && line.includes("お客様「［property_share］〔物件のURL〕 ここ空いてますか 1」") && line.includes("竹内さんの実際の文「") && line.includes("材料を採って reason"));
t("意見なしは空・文なしは文を省く", nearOpinionLine(null) === "" && !nearOpinionLine(o1).includes("実際の文"));
t("要約は60字で切る", situationGist(`場面: x\nお客様: ${"あ".repeat(80)}`).endsWith("…") && situationGist(null) === "");
t("digest", nearOpinionDigest(o2) === "AIX:property_check_result:6:0.83" && nearOpinionDigest(o1) === "返信:5:1" && nearOpinionDigest(null) === "-");
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
