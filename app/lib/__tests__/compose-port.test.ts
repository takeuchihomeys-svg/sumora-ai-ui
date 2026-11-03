// app/lib/__tests__/compose-port.test.ts — 文の受け口（純関数）
import { composeReturnOf, composeRagQuery, rerankComposeHits } from "../compose-port";
import { buildBlueprint, fallbackIntent } from "../compose-blueprint";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const bp = buildBlueprint({ intent: fallbackIntent([{ rank: 1, item: "募集状況を確認する", handling: "confirm" }]), requirements: [{ rank: 1, item: "募集状況を確認する", handling: "confirm" }] });
const ok = composeReturnOf({ blueprint: bp, draft: "かしこまりました！！\n募集状況確認させて頂きます！！\n何卒よろしくお願い致します！！" });
t("外れ0なら blueprintOk", ok.blueprintOk === true && ok.deviations.length === 0, ok);
const ng = composeReturnOf({ blueprint: bp, draft: "かしこまりました！！\nこちらのお部屋かなりオススメです！！" });
t("外れがあれば blueprintOk=false", ng.blueprintOk === false && ng.deviations.length > 0, ng.deviations);
t("設計図が無い番は null", composeReturnOf({ blueprint: null, draft: "x" }).blueprintOk === null);
const q = composeRagQuery({ customerText: "初期費用いくらですか", situationSummary: "見積書を送る前" });
t("問いは発言と状況だけ", /お客様: 初期費用/.test(q) && /状況: 見積書/.test(q) && !/場面|趣旨/.test(q), q);
const hits = [
  { message_id: "a", scene: "cost", purpose: "inform", similarity: 0.8, score: 0.80, weight: 1, read_beyond: [] },
  { message_id: "b", scene: "cost", purpose: "inform", similarity: 0.78, score: 0.78, weight: 1, read_beyond: ["cost", "support"] },
];
t("心配の札が重なる手本を上に", rerankComposeHits(hits, { worries: ["cost"] }, 1)[0].message_id === "b" && rerankComposeHits(hits, {}, 1)[0].message_id === "a");
console.log(`compose-port: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
