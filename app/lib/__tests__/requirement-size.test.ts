// app/lib/__tests__/requirement-size.test.ts — 2026-11-18 作業員K（広さの要望の強さ・REQUIREMENT_SIZE／REACH_SIZE）
//   実行: npx tsx app/lib/__tests__/requirement-size.test.ts
import { sizeStrengthOf, readRequirementStrengths, requirementSizeOn, normalizeRequirementStrengths } from "../requirement-strength";
import { conditionReachStats, reachSizeOn, sizeStatementOf } from "../prop-brain-daily";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra ?? ""); } };

t("スイッチ既定 off", !requirementSizeOn({}) && requirementSizeOn({ REQUIREMENT_SIZE: "on" }) && !reachSizeOn({}) && reachSizeOn({ REACH_SIZE: "on" }));
t("実物（11/15）: 出来れば35㎡…なければ全然小さくても大丈夫 → できれば", sizeStrengthOf("出来れば35㎡超えてれば嬉しいです、なければ全然小さくても大丈夫です！") === "nice");
t("30㎡以上は欲しい → 強い希望（絶対ではない）", sizeStrengthOf("30㎡以上は欲しいです") === "strong");
t("25㎡以上ないと無理 → 絶対", sizeStrengthOf("25㎡以上ないと無理です") === "must");
t("30平米以上必須 → 絶対", sizeStrengthOf("30平米以上必須です") === "must");
t("広さの話が無い → null", sizeStrengthOf("家賃8万で1Kです") === null);
t("強さの言い方が無い → null（読み過ぎない）", sizeStrengthOf("7帖以上で探してます") === null);
t("既定 off: readRequirementStrengths は size を書かない", !("size" in readRequirementStrengths([{ text: "出来れば35㎡超えてれば嬉しいです" }], { size: false })));
t("on: size を書く", readRequirementStrengths([{ text: "出来れば35㎡超えてれば嬉しいです" }], { size: true }).size?.strength === "nice");
t("保存の値の size も読む", normalizeRequirementStrengths({ size: { strength: "nice", evidence: "x" } }).size?.strength === "nice");
t("広さの発言の網", sizeStatementOf("40平米くらいがいいです") && !sizeStatementOf("1LDKでお願いします"));
const r = conditionReachStats({
  msgs: [{ conversation_id: "c1", text: "出来れば35㎡超えてれば嬉しいです", created_at: "2026-11-17T09:00:00Z" }],
  pcOfConv: new Map([["c1", "p1"]]),
  hist: [{ property_customer_id: "p1", changed_field: "floor_area_min", created_at: "2026-11-17T09:05:00Z" }],
  pcRow: new Map([["p1", { created_at: "2026-10-01T00:00:00Z" }]]),
  size: true,
});
t("REACH_SIZE: 広さの発言が floor_area_min に届いた", r.n === 1 && r.reached === 1 && r.byKind["広さ"]?.ok === 1, r);
const r0 = conditionReachStats({ msgs: [{ conversation_id: "c1", text: "出来れば35㎡超えてれば嬉しいです", created_at: "2026-11-17T09:00:00Z" }], pcOfConv: new Map([["c1", "p1"]]), hist: [], pcRow: new Map(), size: false });
t("off: 広さは数えない（今まで通り）", r0.n === 0);
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
