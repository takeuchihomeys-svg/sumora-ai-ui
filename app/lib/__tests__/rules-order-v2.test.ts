// 2026-10-07 6巡目（竹内さん「２最善のみなおしをする」）: 返信生成のルールの並び v2（prompt-rules-format.orderRulesForInjection）と
//   見直しの一覧（rules-review-r6.ts）の回帰テスト。実行: npx tsx app/lib/__tests__/rules-order-v2.test.ts
import { orderRulesForInjection, ruleOrigin, promptRulesOrderV2, PROMPT_RULE_V2_MIN_PRIORITY } from "../prompt-rules-format";
import { RULES_REVIEW_R6, R6_RETIRE_KEYS, R6_TEXT_OVERRIDES, R6_AIX_RETIRE } from "../rules-review-r6";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const r = (rule_key: string, priority: number, updated_at: string) => ({ rule_key, rule_text: rule_key, condition_key: null, condition_value: null, priority, updated_at });

t("出どころ: DIFF-POLICY・WEEKLY は auto", ruleOrigin("DIFF-POLICY-FULL-x") === "auto" && ruleOrigin("WEEKLY-hearing-1") === "auto");
t("出どころ: FEEDBACK-*-gr は routing・BOUNDARY-*-gr は human（線引き）", ruleOrigin("FEEDBACK-a-1-gr") === "routing" && ruleOrigin("BOUNDARY-a-1-gr") === "human");
t("出どころ: FEEDBACK・GLOB・PROP は human", ruleOrigin("FEEDBACK-a-1") === "human" && ruleOrigin("GLOB-TIKTOK-001") === "human" && ruleOrigin("PROP-URL-REPLY-001") === "human");
// 今の形: p8 の古い人の決め（7/24）が毎日の自動の学習（10/05）に押し出されない
const rows = [
  r("BOUNDARY-1", 9, "2026-08-05"), r("FEEDBACK-old-1", 8, "2026-07-24"), r("DIFF-POLICY-new", 8, "2026-10-05"), r("DIFF-POLICY-old", 8, "2026-07-22"),
  r("FEEDBACK-route-1-gr", 7, "2026-08-12"), r("GLOB-PUNCT-001", 7, "2026-07-09"), r("WEEKLY-x", 6, "2026-08-31"),
];
const o3 = orderRulesForInjection(rows, { limit: 3 }).map((x) => x.rule_key);
t("v2: 上限3 → p9・p8 の人の決め・p8 の新しい自動の学習（古い自動の学習が落ちる）", JSON.stringify(o3) === JSON.stringify(["BOUNDARY-1", "FEEDBACK-old-1", "DIFF-POLICY-new"]));
const all = orderRulesForInjection(rows, { limit: 200 }).map((x) => x.rule_key);
t("v2: p7・p6 と AIX の振り分けは入らない（枠が空いても下から入り込まない）", !all.includes("FEEDBACK-route-1-gr") && !all.includes("GLOB-PUNCT-001") && !all.includes("WEEKLY-x") && all.length === 4);
t("v2: 下限は 8", PROMPT_RULE_V2_MIN_PRIORITY === 8);
t("v2: 既定 on・PROMPT_RULES_ORDER=v1 で旧", promptRulesOrderV2({}) && !promptRulesOrderV2({ PROMPT_RULES_ORDER: "v1" }));
// 見直しの一覧
const keys = RULES_REVIEW_R6.map((d) => d.key);
t("一覧: rule_key に重なりが無い", new Set(keys).size === keys.length);
t("一覧: id は UUID の形", [...RULES_REVIEW_R6, ...R6_AIX_RETIRE].every((d) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.id)));
t("一覧: 書き換えには新しい文がある・無効には無い", RULES_REVIEW_R6.every((d) => (d.verdict === "edit") === !!d.newText));
t("一覧: 5巡目の6本を含む", ["f6e3cd53", "ac177394", "744f95e0", "f4410208", "886ac923", "3f36ddb5"].every((p) => RULES_REVIEW_R6.some((d) => d.id.startsWith(p) && d.verdict === "retire")));
t("一覧: b2d7bf7f から「周辺全域から」の一文が消える", !/周辺全域から/.test(R6_TEXT_OVERRIDES["FEEDBACK-92c5b253-2f5b-4731-8a63-3613da211255-1"] ?? "x"));
t("一覧: 冒頭の呼び名はその日最初だけ", /その日最初/.test(R6_TEXT_OVERRIDES["FEEDBACK-bb58c6ee-57ab-4ead-bbfb-0fbcbcb398a3-1"] ?? "") && /同じ日に続いている/.test(R6_TEXT_OVERRIDES["FEEDBACK-bb58c6ee-57ab-4ead-bbfb-0fbcbcb398a3-1"] ?? ""));
t("一覧: 持ち込みは募集状況＋御見積書の両方（PROP-URL-REPLY-001）", /募集状況/.test(R6_TEXT_OVERRIDES["PROP-URL-REPLY-001"] ?? "") && /御見積書/.test(R6_TEXT_OVERRIDES["PROP-URL-REPLY-001"] ?? ""));
t("一覧: 書き換えの文に禁止の言い回し（少々お待ちください・お客様と呼ぶ）を入れない", Object.values(R6_TEXT_OVERRIDES).every((s) => !/少々お待ち/.test(s)));
t("一覧: 無効の数", R6_RETIRE_KEYS.length === RULES_REVIEW_R6.filter((d) => d.verdict === "retire").length);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
