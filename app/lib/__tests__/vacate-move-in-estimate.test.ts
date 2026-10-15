// 2026-10-15 竹内さんの決定②（退去予定の最短の入居時期の目安を逆算）・決定③（check_pattern をブレインが決める）
// 実行: npx tsx app/lib/__tests__/vacate-move-in-estimate.test.ts
import { moveInEstimateFromVacate, vacatingMoveInPromptLine } from "../vacate-move-in-estimate";
import { routeContractTerm } from "../contract-terms-question";
import { routeConfirmTopic } from "../procedure-question";
import { materialGroundsAssertion } from "../validate-reply";
import { resolveCheckKindWithBrain, normalizeBrainCheckPattern, brainCheckPatternSchemaField } from "../brain-check-pattern";
import { propertyCheckKindFor } from "../aix-taxonomy";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`, info ?? ""); } };
const NOW = Date.parse("2026-10-15T03:00:00Z");

console.log("■ 逆算（竹内さんの実送信の組）");
t("10月末 → 11月中旬〜下旬（q145・8590144d）", moveInEstimateFromVacate("10月末", NOW)?.label === "11月中旬〜下旬", moveInEstimateFromVacate("10月末", NOW));
t("10月31日 → 11月中旬〜下旬", moveInEstimateFromVacate("10月31日", NOW)?.label === "11月中旬〜下旬");
t("10月20日 → 11月上旬〜中旬", moveInEstimateFromVacate("10月20日", NOW)?.label === "11月上旬〜中旬", moveInEstimateFromVacate("10月20日", NOW));
t("11月30日 → 12月中旬〜下旬", moveInEstimateFromVacate("11月30日", NOW)?.label === "12月中旬〜下旬");
t("旬だけ（10月下旬）は逆算しない", moveInEstimateFromVacate("10月下旬", NOW) === null);
t("もう過ぎた退去日は逆算しない", moveInEstimateFromVacate("10月1日", NOW) === null);
t("VACATE_MOVE_IN_ESTIMATE=off → null", moveInEstimateFromVacate("10月末", NOW, { VACATE_MOVE_IN_ESTIMATE: "off" }) === null);
t("1行に「確定の日は退去後」", /確定の日は退去後/.test(moveInEstimateFromVacate("10月末", NOW)?.fact ?? ""));
t("生成の1文: on は目安を写す・off は旧の禁止", /最短の入居時期の目安/.test(vacatingMoveInPromptLine({})) && /絶対禁止/.test(vacatingMoveInPromptLine({ VACATE_MOVE_IN_ESTIMATE: "off" })));

console.log("■ 材料（契約条件・確認した系）");
const lines = ["現況: 退去予定(10/31)", "入居時期: 相談"];
const r = routeContractTerm("move_in", { lines, terms: null, pdfText: null } as never);
t("契約条件の入居時期: 退去予定日＋目安の1行", r.route === "material" && r.facts.some((f) => /最短で\d+月/.test(f)), r);
const c = routeConfirmTopic("move_in", lines);
t("確認した系の入居: 退去予定日があれば目安で資料の答え", c.route === "material" && /逆算/.test(c.why), c);
const cOff = (() => { process.env.VACATE_MOVE_IN_ESTIMATE = "off"; try { return routeConfirmTopic("move_in", lines); } finally { delete process.env.VACATE_MOVE_IN_ESTIMATE; } })();
t("off → 確認した系は今まで通り確認", cOff.route === "confirm");
const facts = r.facts.join("\n");
t("最終チェックの免除: 目安の旬の文は資料のとおり", materialGroundsAssertion("MOVEIN_DATE_ASSERTION", "最短で11月中旬〜下旬のご入居となります！！", facts));
t("最終チェック: 目安に無い日付は免除しない", !materialGroundsAssertion("MOVEIN_DATE_ASSERTION", "11月5日からご入居可能です！！", facts));

console.log("■ check_pattern（ブレインが決める・決まりは網）");
const mgmtEq = propertyCheckKindFor("mgmt_equipment");
const a = resolveCheckKindWithBrain({ finalAix: "property_check_result", brainValue: "availability", ruleKind: mgmtEq, ruleDecided: false });
t("持ち込み物件＋条件の質問: ブレインが availability → 物件確認した（募集状況）", a.source === "brain" && a.kind?.ui_button === "物件確認した（募集状況）" && a.kind.check_pattern === "", a);
t("ブレインが条件の細目 → その細目", resolveCheckKindWithBrain({ finalAix: "property_check_result", brainValue: "mgmt_pet", ruleKind: null, ruleDecided: false }).kind?.check_pattern === "mgmt_pet");
t("ブレインが null → 決まり（網）", resolveCheckKindWithBrain({ finalAix: "property_check_result", brainValue: null, ruleKind: mgmtEq, ruleDecided: false }).kind === mgmtEq);
t("読めない値 → 決まり", resolveCheckKindWithBrain({ finalAix: "property_check_result", brainValue: "foo", ruleKind: mgmtEq, ruleDecided: false }).source === "rule");
t("決まりが AIX を決めた番 → 決まりの値（安全の線）", resolveCheckKindWithBrain({ finalAix: "property_check_result", brainValue: "availability", ruleKind: propertyCheckKindFor("interior_photo"), ruleDecided: true }).kind?.check_pattern === "interior_photo");
t("別の AIX → 触らない", resolveCheckKindWithBrain({ finalAix: "estimate_sheet", brainValue: "mgmt_pet", ruleKind: null, ruleDecided: false }).kind === null);
t("BRAIN_CHECK_PATTERN=off → 決まり", resolveCheckKindWithBrain({ finalAix: "property_check_result", brainValue: "availability", ruleKind: mgmtEq, ruleDecided: false, env: { BRAIN_CHECK_PATTERN: "off" } }).kind === mgmtEq);
t("結果の値（available）は availability に読む", normalizeBrainCheckPattern("available") === "availability");
t("出力の項目: on だけ", /"check_pattern"/.test(brainCheckPatternSchemaField({})) && brainCheckPatternSchemaField({ BRAIN_CHECK_PATTERN: "off" }) === "");

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
