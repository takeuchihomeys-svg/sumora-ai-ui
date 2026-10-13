// app/lib/__tests__/brain-only-summary.test.ts — 2026-10-13 要約はブレインの戦略の層だけが書く
//   実行: npx tsx app/lib/__tests__/brain-only-summary.test.ts
import { brainOnlySummaryEnabled, aixMetaPatchEnabled, strategySummaryPatternsEnabled, mergeStrategySummaryJson, summaryPredictionRows, formatSummaryPatternsForStrategy } from "../brain-only-summary";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

t("既定は要約をブレインだけ", brainOnlySummaryEnabled({}) === true);
t("BRAIN_ONLY_SUMMARY=off で戻す", brainOnlySummaryEnabled({ BRAIN_ONLY_SUMMARY: "off" }) === false);
t("aix_meta_patch は既定 off", aixMetaPatchEnabled({}) === false);
t("AIX_META_PATCH=on で戻す", aixMetaPatchEnabled({ AIX_META_PATCH: "on" }) === true);
t("戦略への成約パターンは既定 on", strategySummaryPatternsEnabled({}) && !strategySummaryPatternsEnabled({ STRATEGY_SUMMARY_PATTERNS: "off" }));

// our_actions・inspection は戦略の層が出さない → 残す
const ex = { situation: "旧", our_actions: ["物件送付", "見積書送付"], inspection: { requested: true, done: true }, estimate: { requested: true } };
const nx = { situation: "内覧後に検討中", next_action: "見積書の反応を待つ", winning_pattern: "初期費用を抑えた見積で背中を押す" };
const m = mergeStrategySummaryJson(ex, nx)!;
t("新しい状況が入る", m.situation === "内覧後に検討中");
t("our_actions を残す", Array.isArray(m.our_actions) && (m.our_actions as string[]).length === 2);
t("inspection を残す", (m.inspection as { done?: boolean }).done === true);
t("estimate を残す", (m.estimate as { requested?: boolean }).requested === true);
t("新しい JSON が our_actions を持てばそちら", (mergeStrategySummaryJson(ex, { our_actions: ["内覧誘導"] })!.our_actions as string[])[0] === "内覧誘導");
t("空の配列は前を残す", (mergeStrategySummaryJson(ex, { our_actions: [] })!.our_actions as string[]).length === 2);
t("新しい JSON が無ければ null", mergeStrategySummaryJson(ex, null) === null && mergeStrategySummaryJson(ex, [1]) === null);
t("前が無くても新しい JSON をそのまま", mergeStrategySummaryJson(null, nx)!.situation === "内覧後に検討中");

// 予測の記録
const r = summaryPredictionRows({ customerId: "pc1", conversationId: "c1", summaryJson: { ...nx, personality_profile: "慎重" }, isTest: false });
t("next_action の行", r.nextAction?.predicted_action === "見積書の反応を待つ" && r.nextAction.conversation_id === "c1");
t("winning_pattern の行（人間性つき）", r.winningPattern?.predicted_pattern === "初期費用を抑えた見積で背中を押す" && r.winningPattern.personality_profile === "慎重" && r.winningPattern.was_correct === null);
t("テストの会話は書かない", summaryPredictionRows({ customerId: "pc1", conversationId: "c1", summaryJson: nx, isTest: true }).nextAction === null);
t("会話 ID が無ければ winning_pattern は書かない", summaryPredictionRows({ customerId: "pc1", conversationId: null, summaryJson: nx, isTest: false }).winningPattern === null);
t("\"null\" の文字は書かない", summaryPredictionRows({ customerId: "pc1", conversationId: "c1", summaryJson: { next_action: "null" }, isTest: false }).nextAction === null);

// 戦略の材料
const f = formatSummaryPatternsForStrategy([
  { content: "【人間性が似た顧客で実際に当たった一手】人間性: 慎重 → 当たった一手: 内覧を先に" },
  { content: "【人間性が似た顧客で実際に当たった一手】人間性: 慎重 → 当たった一手: 内覧を先に" },
  { content: "既に出ている行のはじまりの四十字以上の文がここにありますので重ねないようにしますあいうえお" },
  { content: "" },
], "- 既に出ている行のはじまりの四十字以上の文がここにありますので重ねないようにしますあいうえお");
t("重複と既出を外す", f.split("\n").length === 1 && f.startsWith("- 【人間性"));
t("4件まで", formatSummaryPatternsForStrategy(Array.from({ length: 9 }, (_, k) => ({ content: `成約パターン${k} ${"x".repeat(50)}` })), "").split("\n").length === 4);

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
