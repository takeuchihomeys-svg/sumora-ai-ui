// app/lib/__tests__/next-action-unify.test.ts
// 2026-10-08 竹内「一本化する」: 次の一手（suggest-next-action）の LLM をやめ、AIX の推しはブレインの判断だけにする部品のテスト。
//   ① LLM のスイッチは既定 off ② テンプレート一覧の 💡 はブレインの判断の AIX から（AIX なし＝出さない）③ 重ね呼びの使い回し
//   ④ aix-shadow-eval はブレインの値で測る ⑤ LLM を止めている間は次の一手の温めをしない
// 実行: npx tsx app/lib/__tests__/next-action-unify.test.ts（自己完結・env 不要・全 OK で exit 0）
import {
  isOnSwitch, suggestNextActionLlmEnabled, checkPatternTemplateCategory, brainTemplateSuggestion, brainCheckPatternFor,
  nextActionFetchKey, reusableNextAction, NEXT_ACTION_REUSE_MS, brainShadowEval, shadowPredictor,
} from "../next-action-unify";
import { buildPrefixWarmTargets } from "../prefix-warm";
import { CUSTOMER_SUMMARY_SYSTEM } from "../customer-summary-prompt";
import { brainAixButtonLabel } from "../aix-button-view";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}

// page.tsx の AIX_ACTION_META の一部（実物の値）
const META: Record<string, { label: string; color: string; templateCategory: string }> = {
  property_recommendation: { label: "物件オススメ", color: "#2196F3", templateCategory: "物件オススメ【AIX】" },
  property_send: { label: "物件ピックアップした", color: "#00897B", templateCategory: "物件ピックアップした【AIX】" },
  property_check_result: { label: "物件確認した", color: "#4CAF50", templateCategory: "物件確認した【AIX】" },
  estimate_sheet: { label: "見積書送る", color: "#FF9800", templateCategory: "見積書送る【AIX】" },
  viewing_invite: { label: "内覧日調整", color: "#9C27B0", templateCategory: "内覧へ！【AIX】" },
  cost_explain: { label: "初期費用を説明", color: "#2E7D32", templateCategory: "" },
};
// 本番の ai_prompts.aix_template_chain_stats.recommended（2026-10-04 更新）から route が作る template_rec_by_action の形
const REC = {
  property_check_result: { recommended_template_id: "da3156f9-c996-4e5f-b9db-11389b65c97f", recommended_template_sequence: [{ id: "da3156f9-c996-4e5f-b9db-11389b65c97f", seq: 1 }] },
  estimate_sheet: { recommended_template_id: "66de6ba7-1e5b-48cb-86af-381440f69445", recommended_template_sequence: null },
  viewing_invite: { recommended_template_id: "1fe5810c-5dd0-4e2c-8fd7-1af6ab69c3cb", recommended_template_sequence: [{ id: "1fe5810c-5dd0-4e2c-8fd7-1af6ab69c3cb", seq: 1 }, { id: "x2", seq: 2 }] },
};

console.log("── ① LLM のスイッチ（既定 off）");
t("未設定は呼ばない", suggestNextActionLlmEnabled(undefined) === false && suggestNextActionLlmEnabled("") === false);
t("on / 1 / true で戻す", suggestNextActionLlmEnabled("on") && suggestNextActionLlmEnabled(" ON ") && suggestNextActionLlmEnabled("1") && suggestNextActionLlmEnabled("true"));
t("off・その他は呼ばない", !suggestNextActionLlmEnabled("off") && !suggestNextActionLlmEnabled("0") && !isOnSwitch("yes"));

console.log("── ② テンプレート一覧の 💡（ブレインの判断の AIX から）");
{
  const none = brainTemplateSuggestion({ brainAction: null, actionMeta: META, recByAction: REC });
  t("ブレインが AIX なし → 💡・カテゴリ・色・順番すべて無し", none.label === undefined && none.category === undefined && none.color === undefined && none.priorityTemplateIds === undefined, none);
  const est = brainTemplateSuggestion({ brainAction: "estimate_sheet", buttonLabel: brainAixButtonLabel("estimate_sheet"), actionMeta: META, recByAction: REC });
  t("見積書送る: 💡 見積書送るがオススメ・カテゴリ・色", est.label === "💡 見積書送るがオススメ" && est.category === "見積書送る【AIX】" && est.color === "#FF9800", est);
  t("順番が無い時は単発の推奨テンプレ1件", JSON.stringify(est.priorityTemplateIds) === JSON.stringify(["66de6ba7-1e5b-48cb-86af-381440f69445"]));
  const vi = brainTemplateSuggestion({ brainAction: "viewing_invite", buttonLabel: brainAixButtonLabel("viewing_invite"), actionMeta: META, recByAction: REC });
  t("内覧日調整: シーケンスの順番", JSON.stringify(vi.priorityTemplateIds) === JSON.stringify(["1fe5810c-5dd0-4e2c-8fd7-1af6ab69c3cb", "x2"]) && vi.label === "💡 内覧日調整がオススメ", vi);
  const avail = brainTemplateSuggestion({ brainAction: "property_check_result", checkPattern: "available", buttonLabel: brainAixButtonLabel("property_check_result", "available"), actionMeta: META, recByAction: REC });
  t("物件確認した（募集状況）: 物件確認したのカテゴリ・推奨テンプレあり", avail.category === "物件確認した【AIX】" && avail.label === "💡 物件確認したがオススメ" && avail.priorityTemplateIds?.[0] === "da3156f9-c996-4e5f-b9db-11389b65c97f", avail);
  const mgmt = brainTemplateSuggestion({ brainAction: "property_check_result", checkPattern: "mgmt_initial_cost", buttonLabel: brainAixButtonLabel("property_check_result", "mgmt_initial_cost"), actionMeta: META, recByAction: REC });
  t("確認した（条件・交渉）: 管理会社に確認したのカテゴリ・名前は「確認した（条件・交渉）」・募集状況の定番テンプレは推さない",
    mgmt.category === "管理会社に確認した【AIX】" && mgmt.label === "💡 確認した（条件・交渉）がオススメ" && mgmt.priorityTemplateIds === undefined, mgmt);
  const old = brainTemplateSuggestion({ brainAction: "property_check", actionMeta: META, recByAction: REC });
  t("旧名 property_check は property_check_result と同じ", old.category === "物件確認した【AIX】");
  const ce = brainTemplateSuggestion({ brainAction: "cost_explain", actionMeta: META, recByAction: REC });
  t("テンプレのカテゴリが無い AIX（初期費用を説明）: カテゴリ無し・💡 は出す", ce.category === undefined && ce.label === "💡 初期費用を説明がオススメ", ce);
  const unknown = brainTemplateSuggestion({ brainAction: "no_such_action", actionMeta: META, recByAction: REC });
  t("画面に無い AIX → 何も出さない", unknown.label === undefined);
  const noRec = brainTemplateSuggestion({ brainAction: "estimate_sheet", actionMeta: META, recByAction: null });
  t("API がまだ返っていない（rec なし）→ 💡 は出す・順番は無し", noRec.label === "💡 見積書送るがオススメ" && noRec.priorityTemplateIds === undefined);
  t("確認先の分け方（page.tsx の旧 templateCategoryForLatestAix と同じ）",
    checkPatternTemplateCategory("nearby_parking") === "近隣の月極駐車場を確認した【AIX】" && checkPatternTemplateCategory("owner_other") === "オーナーに確認した【AIX】"
    && checkPatternTemplateCategory("vacate_date") === "管理会社に確認した【AIX】" && checkPatternTemplateCategory("mgmt_pet") === "管理会社に確認した【AIX】"
    && checkPatternTemplateCategory("available") === undefined && checkPatternTemplateCategory(null) === undefined);
  t("check_pattern は同じ AIX の判断の物だけ（別の AIX の判断の check_pattern は使わない）",
    brainCheckPatternFor("property_check_result", [null, { action: "estimate_sheet", check_pattern: "mgmt_pet" }, { action: "property_check_result", check_pattern: "vacate_date" }]) === "vacate_date"
    && brainCheckPatternFor("property_check_result", [{ action: "viewing_invite", check_pattern: "mgmt_pet" }]) === null
    && brainCheckPatternFor(null, [{ action: "property_check_result", check_pattern: "mgmt_pet" }]) === null
    && brainCheckPatternFor("property_check_result", [{ action: "property_check", check_pattern: "owner_other" }]) === "owner_other");
}

console.log("── ③ 重ね呼びの使い回し");
{
  const base = { convId: "c1", latestCustomerTs: "2026-10-08T01:00:00Z", lastSender: "customer", lastAixAction: null, available: null, status: "proposing" };
  const k = nextActionFetchKey(base)!;
  t("鍵が作れる", typeof k === "string" && k.startsWith("c1|"));
  t("最新のお客様の発言が分からない → 使い回さない（null）", nextActionFetchKey({ ...base, latestCustomerTs: null }) === null);
  t("新しいお客様の発言 → 別の鍵", nextActionFetchKey({ ...base, latestCustomerTs: "2026-10-08T02:00:00Z" }) !== k);
  t("送信の後（最後の送り手が staff）→ 別の鍵", nextActionFetchKey({ ...base, lastSender: "staff" }) !== k);
  t("AIX を送った（last_aix が変わる）→ 別の鍵", nextActionFetchKey({ ...base, lastAixAction: "property_check_result" }) !== k);
  t("空室の結果 true/false/不明 → 別の鍵", new Set([nextActionFetchKey({ ...base, available: true }), nextActionFetchKey({ ...base, available: false }), k]).size === 3);
  t("ステータスが変わる → 別の鍵", nextActionFetchKey({ ...base, status: "applying" }) !== k);
  const NOW = Date.parse("2026-10-08T01:05:00Z");
  const entry = { key: k, at: NOW - 60_000, value: { entry: null, rec: {} } };
  t("同じ鍵・時間内 → 前の結果", reusableNextAction(entry, k, NOW) === entry.value);
  t("違う鍵 → 呼ぶ", reusableNextAction(entry, nextActionFetchKey({ ...base, lastSender: "staff" }), NOW) === undefined);
  t("鍵 null → 呼ぶ", reusableNextAction(entry, null, NOW) === undefined);
  t("10分を過ぎた → 呼ぶ", reusableNextAction({ ...entry, at: NOW - NEXT_ACTION_REUSE_MS - 1 }, k, NOW) === undefined);
  t("前の結果が無い → 呼ぶ", reusableNextAction(undefined, k, NOW) === undefined);
}

console.log("── ④ aix-shadow-eval はブレインの値で測る（本番 aix_usage_logs 10/05〜08 の実物の組）");
{
  const rows = [
    { aix_type: "property_recommendation", suggested_action: "property_send" },
    { aix_type: "greeting_viewing", suggested_action: "none" },
    { aix_type: "application_push", suggested_action: "application_push" },
    { aix_type: "estimate_sheet", suggested_action: "none" },
    { aix_type: "property_check_result", suggested_action: "property_check_result" },
    { aix_type: "viewing_invite", suggested_action: "viewing_invite" },
    { aix_type: "property_recommendation", suggested_action: null },
  ];
  const r = rows.map(brainShadowEval);
  t("判断の無い行（null）は測らない", r[6].evaluated === false);
  t("違う AIX → 外れ（予想は property_send）", r[0].evaluated && r[0].predicted === "property_send" && !r[0].matched);
  t("none → 予想は null・外れ", r[1].evaluated && r[1].predicted === null && !r[1].matched && r[3].evaluated && !r[3].matched);
  t("同じ AIX → 当たり", r[2].evaluated && r[2].matched && r[4].evaluated && r[4].matched && r[5].evaluated && r[5].matched);
  const old = brainShadowEval({ aix_type: "property_check_result", suggested_action: "property_check" });
  t("旧名 property_check も当たり", old.evaluated && old.matched);
  t("既定はブレイン・suggest で旧に戻す", shadowPredictor(undefined) === "brain" && shadowPredictor("brain") === "brain" && shadowPredictor("suggest") === "suggest" && shadowPredictor(" Suggest ") === "suggest");
}

console.log("── ⑤ LLM を止めている間は次の一手の温めをしない");
{
  const common = { finalCheck: { dbRules: "\n\n【永久ルール】\n・x", finalCheckRules: "・y" }, summary: { systemPrompt: CUSTOMER_SUMMARY_SYSTEM, nextActionRuleContents: ["ルールA"] } };
  const off = buildPrefixWarmTargets({ ...common, nextAction: null });
  const on = buildPrefixWarmTargets({ ...common, nextAction: { aixLogicRows: [{ key: "aix_logic_x", content: "x" }], boundaryRuleRows: [], aixFlowGuide: "g" } });
  t("止めている（null）→ 5つ・suggest_next_action_warm は無い", off.length === 5 && !off.some((x) => x.name === "suggest_next_action_warm"), off.map((x) => x.name));
  t("戻した（on）→ 6つ（旧と同じ）", on.length === 6 && on[5].name === "suggest_next_action_warm");
  t("他の5つの鍵は変わらない", off.every((x, i) => x.key === on[i].key && x.name === on[i].name));
}

console.log(`\n${passed} OK / ${failed} NG`);
if (failed > 0) process.exit(1);
