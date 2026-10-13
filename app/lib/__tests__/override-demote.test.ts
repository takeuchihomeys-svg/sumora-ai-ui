// app/lib/__tests__/override-demote.test.ts — 2026-10-13 決定論の上書きを材料＋食い違いのログに下げる
//   実行: npx tsx app/lib/__tests__/override-demote.test.ts
import { overrideDemoted, applyOverride, compactDemoted, DEMOTE_ENV, pickupReadyMaterialLine, brainContractSaysDirectPropertyAix, type DemotedOverride } from "../override-demote";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("既定は下げる（signal）", overrideDemoted("signal", {}));
t("BRAIN_DEMOTE_SIGNAL=off で旧の上書き", !overrideDemoted("signal", { BRAIN_DEMOTE_SIGNAL: "off" }));
t("家族ごとに別の環境変数", new Set(Object.values(DEMOTE_ENV)).size === Object.keys(DEMOTE_ENV).length);

// 本番の形: ブレインは AIX なし・信号は 物件ピックアップ（signal:property_send 0/20）
const list: DemotedOverride[] = [];
t("下げている時は上書きしない（false）", applyOverride(list, "signal", "signal:property_send", "property_send", null, {}) === false);
t("食い違いを残す", list.length === 1 && list[0].would === "property_send" && list[0].brain === null);
t("同じ src は1回", (applyOverride(list, "signal", "signal:property_send", "property_send", null, {}), list.length === 1));
t("ブレインと同じ答えは食い違いにしない", (applyOverride(list, "signal", "signal:scene_S10_phone_request", "phone_call", "phone_call", {}), list.length === 1));
t("戻した時は上書きする（true）・記録しない", applyOverride(list, "signal", "signal:scene_S8_cost_doubt", "cost_explain", null, { BRAIN_DEMOTE_SIGNAL: "off" }) === true && list.length === 1);
t("meta の形", JSON.stringify(compactDemoted(list)) === JSON.stringify([{ f: "signal", src: "signal:property_send", would: "property_send", brain: null }]));
t("空なら undefined", compactDemoted([]) === undefined);

// 4-3: 2段の約束
t("材料の行（候補あり／無し）", /直接出せる/.test(pickupReadyMaterialLine(true)) && /約束の返信/.test(pickupReadyMaterialLine(false)));
const direct = { asks: [{ quote: "新しいお部屋ありますか", route: "aix", aix: "property_send", topic: "物件の紹介" }] };
const promised = { asks: [{ quote: "大国町で1Kで", route: "promise", answer: "ご条件でピックアップしお送り", aix: "property_send" }] };
t("route=aix の物件の項目だけ → 直接", brainContractSaysDirectPropertyAix(direct, "property_send"));
t("約束の項目がある → 直接ではない", !brainContractSaysDirectPropertyAix({ asks: [...direct.asks, ...promised.asks] }, "property_send"));
t("約束だけ → 直接ではない", !brainContractSaysDirectPropertyAix(promised, "property_send"));
t("物件以外の AIX は対象外", !brainContractSaysDirectPropertyAix({ asks: [{ route: "aix", aix: "estimate_sheet" }] }, "estimate_sheet"));
t("turn_contract が無い → 直接ではない（安全側）", !brainContractSaysDirectPropertyAix(null, "property_send"));

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
