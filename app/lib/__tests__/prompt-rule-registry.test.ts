// app/lib/__tests__/prompt-rule-registry.test.ts
// 実行: npx tsx app/lib/__tests__/prompt-rule-registry.test.ts（自己完結ハーネス・全 PASS で exit 0）
import {
  PROMPT_RULE_ROUTES,
  PROMPT_RULE_ACTION_TYPES,
  PROMPT_RULE_CONDITION_KEYS,
  classifyPromptRuleReachability,
  normalizePromptRuleActionType,
  type PromptRuleAuditRow,
} from "../prompt-rule-registry";
import { promptRuleMatchesConditions } from "../prompt-rules-format";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
}

const row = (o: Partial<PromptRuleAuditRow>): PromptRuleAuditRow => ({
  rule_key: "X-1", action_type: null, condition_key: null, condition_value: null,
  priority: 8, is_active: true, is_permanent: false, ...o,
});

console.log("── 表の自己整合");
{
  t("すべての経路に呼び出し元が書かれている",
    Object.values(PROMPT_RULE_ROUTES).every((r) => r.callers.length > 0));
  t("always と sometimes が重複していない",
    Object.values(PROMPT_RULE_ROUTES).every((r) => !(r.sometimes ?? []).some((k) => r.always.includes(k))));
  t("condition_key の一覧は経路の合併と一致する",
    [...PROMPT_RULE_CONDITION_KEYS].every((k) =>
      Object.values(PROMPT_RULE_ROUTES).some((r) => [...r.always, ...(r.sometimes ?? [])].includes(k))));
  t("生成・検査の2経路が表にある", PROMPT_RULE_ACTION_TYPES.has("generate_reply") && PROMPT_RULE_ACTION_TYPES.has("final_check"));
  // 2026-09-18 に判明した抜け: ai-feedback の手書き一覧にこの3つが無く、黙って global に落ちていた
  t("cost_breakdown / phone_followup / guarantor_info が表にある",
    ["cost_breakdown", "phone_followup", "guarantor_info"].every((k) => PROMPT_RULE_ACTION_TYPES.has(k)));
}

console.log("── 届かない行を見分ける");
{
  // 実在した4件（2026-09-18 の点検で見つかった形）
  const vcc = classifyPromptRuleReachability(row({ rule_key: "PROP-VCC-001", action_type: "property_recommendation", condition_key: "vacancy_status", condition_value: "scheduled", priority: 9 }));
  t("誰も渡さない condition_key は届かない（PROP-VCC-001）",
    !vcc.reachable && vcc.reason === "unknown_condition_key", JSON.stringify(vcc));

  const all1 = classifyPromptRuleReachability(row({ rule_key: "CLOSEDWON-ALL-1", action_type: "all", priority: 80 }));
  t("誰も取りに行かない action_type は届かない（CLOSEDWON-ALL-1・priority 80 でも）",
    !all1.reachable && all1.reason === "unknown_action_type", JSON.stringify(all1));

  const applying = classifyPromptRuleReachability(row({ rule_key: "DIFF-POLICY-AIX-x", action_type: "applying" }));
  t("conversation_state を action_type に入れた行は届かない（applying は AIX アクションではない）",
    !applying.reachable && applying.reason === "unknown_action_type");

  // 2026-09-18 訂正: zenryoku_support は実在する AIX アクション（全力サポート）。
  //   aix-template-generate は actionType をそのまま渡すので届く（aix/action は自前で引かないので本体には効かない）
  const zen = classifyPromptRuleReachability(row({ rule_key: "DIFF-POLICY-AIX-z", action_type: "zenryoku_support" }));
  t("zenryoku_support は届く（ただし「✨ 会話を合わせる」経由だけ）", zen.reachable && !!zen.templateOnly, JSON.stringify(zen));
  t("property_recommendation は AIX 本体でも届く（templateOnly ではない）",
    (() => { const r = classifyPromptRuleReachability(row({ action_type: "property_recommendation" })); return r.reachable && !r.templateOnly; })());

  t("priority 3 は下限未満で届かない",
    (() => { const r = classifyPromptRuleReachability(row({ priority: 3 })); return !r.reachable && r.reason === "below_priority"; })());
  t("priority 3 でも永久ルールなら届く",
    classifyPromptRuleReachability(row({ priority: 3, is_permanent: true })).reachable);
  t("is_active=false は届かない",
    (() => { const r = classifyPromptRuleReachability(row({ is_active: false })); return !r.reachable && r.reason === "inactive"; })());
  t("LEARN-* は既定で除外",
    (() => { const r = classifyPromptRuleReachability(row({ rule_key: "LEARN-123" })); return !r.reachable && r.reason === "learn_excluded"; })());
  t("LEARN-AIX-* は除外されない", classifyPromptRuleReachability(row({ rule_key: "LEARN-AIX-1" })).reachable);
  t("condition_key があって値が無い行は設定ミスとして出る",
    (() => { const r = classifyPromptRuleReachability(row({ condition_key: "check_pattern", condition_value: null })); return !r.reachable && r.reason === "condition_without_value"; })());
}

console.log("── 届くが一部の経路では落ちる");
{
  const r = classifyPromptRuleReachability(row({ action_type: "application_push", condition_key: "has_estimate", condition_value: "true", priority: 10 }));
  t("has_estimate は一部の呼び出しだけが渡す（partial）", r.reachable && !!r.partial, JSON.stringify(r));

  const g = classifyPromptRuleReachability(row({ action_type: "generate_reply", condition_key: "conversation_state", condition_value: "applying" }));
  t("generate_reply の conversation_state は全経路が渡す（partial ではない）", g.reachable && !g.partial, JSON.stringify(g));

  const fe = classifyPromptRuleReachability(row({ action_type: "generate_reply", condition_key: "is_first_reply", condition_value: "true" }));
  t("is_first_reply は generate-reply だけなので partial", fe.reachable && !!fe.partial);
}

console.log("── 書き込む側の門");
{
  t("表にある値はそのまま", normalizePromptRuleActionType("property_send").actionType === "property_send");
  t("AIX アクションはそのまま（zenryoku_support）", normalizePromptRuleActionType("zenryoku_support").actionType === "zenryoku_support");
  t("表に無い値（conversation_state）は global に倒れる",
    (() => { const n = normalizePromptRuleActionType("applying"); return n.actionType === null && n.fellBackToGlobal && n.original === "applying"; })());
  t("空・null は global（設定ミスではない）",
    !normalizePromptRuleActionType(null).fellBackToGlobal && !normalizePromptRuleActionType("  ").fellBackToGlobal);
}

console.log("── 落ちた時の言葉が2種類に分かれる");
{
  let msg = "";
  const warn = (m: string) => { msg = m; };
  const base = { rule_key: "R-1", rule_text: "x", priority: 8 };

  promptRuleMatchesConditions({ ...base, condition_key: "vacancy_status", condition_value: "scheduled" }, {}, warn);
  t("誰も渡さないキーは「永久に届きません」と出る", msg.includes("永久に届きません") && msg.includes("R-1"), msg);

  promptRuleMatchesConditions({ ...base, condition_key: "check_pattern", condition_value: "available" }, {}, warn);
  t("他の経路では届くキーは「この呼び出しは渡していない」と出る", msg.includes("他の経路では届きます"), msg);

  t("条件が一致すれば通る",
    promptRuleMatchesConditions({ ...base, condition_key: "check_pattern", condition_value: "available" }, { check_pattern: "available" }, warn));
  t("条件が違えば落ちる",
    !promptRuleMatchesConditions({ ...base, condition_key: "check_pattern", condition_value: "available" }, { check_pattern: "unavailable" }, warn));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
