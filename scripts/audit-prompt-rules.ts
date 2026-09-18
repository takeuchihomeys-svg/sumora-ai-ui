// scripts/audit-prompt-rules.ts
// 「ai_prompt_rules に入っているのに、プロンプトに届いていないルール」を全部出す点検。
// 実行: npx tsx --env-file=.env.local scripts/audit-prompt-rules.ts
//
// 2026-09-18 竹内「改善おねがい」: ルールは DB に貯まるが、届いているかを見る道具が無かった。
//   届かない入口は4つ ①誰も取りに行かない action_type ②誰も渡さない condition_key
//   ③priority が下限未満 ④1回のフェッチの上限（200件）で後ろが落ちる
//   ①②③は行ごとに、④は経路ごとに数える。
import { createClient } from "@supabase/supabase-js";
import {
  classifyPromptRuleReachability,
  REACHABILITY_LABELS,
  PROMPT_RULE_ROUTES,
  PROMPT_RULE_LIMIT_HIGH,
  PROMPT_RULE_LIMIT_PERMANENT,
  PROMPT_RULE_MIN_PRIORITY,
  type PromptRuleAuditRow,
  type ReachabilityFailure,
} from "../app/lib/prompt-rule-registry";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

type Row = PromptRuleAuditRow & { rule_text: string; updated_at: string | null; created_at: string | null };

async function loadAll(): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("ai_prompt_rules")
      .select("rule_key, action_type, condition_key, condition_value, priority, is_active, is_permanent, rule_text, updated_at, created_at")
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    out.push(...(data as Row[]));
    if (data.length < 1000) break;
  }
  return out;
}

(async () => {
  const rows = await loadAll();
  console.log(`ai_prompt_rules: ${rows.length}行\n`);

  // ── ①②③ 行ごとの到達可能性 ─────────────────────────────
  const failures = new Map<ReachabilityFailure, Row[]>();
  const partials: Array<{ row: Row; routes: string[]; key: string }> = [];
  const templateOnly: Row[] = [];
  for (const r of rows) {
    const v = classifyPromptRuleReachability(r);
    if (v.reachable) {
      if (v.partial) partials.push({ row: r, routes: v.partial.routes, key: v.partial.conditionKey });
      if (v.templateOnly) templateOnly.push(r);
      continue;
    }
    if (!failures.has(v.reason)) failures.set(v.reason, []);
    failures.get(v.reason)!.push(r);
  }

  // 「無効」「LEARN-*」は意図した除外なので件数だけ、それ以外は中身を出す
  const QUIET: ReachabilityFailure[] = ["inactive", "learn_excluded"];
  console.log("=== 届いていないルール ===");
  for (const [reason, list] of [...failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n【${REACHABILITY_LABELS[reason]}】${list.length}件`);
    if (QUIET.includes(reason)) { console.log("  （意図した除外）"); continue; }
    for (const r of list) {
      console.log(`  ・${r.rule_key}  action_type=${r.action_type ?? "(global)"} cond=${r.condition_key ?? "-"}=${r.condition_value ?? "-"} priority=${r.priority} 作成=${(r.created_at ?? "").slice(0, 10)}`);
      console.log(`      ${r.rule_text.replace(/\s+/g, " ").slice(0, 100)}`);
    }
  }
  if (!failures.size) console.log("  （なし）");

  if (partials.length) {
    console.log(`\n=== 一部の経路にだけ届くルール（${partials.length}件） ===`);
    for (const p of partials) {
      console.log(`  ・${p.row.rule_key}  "${p.key}" を渡さない経路: ${p.routes.join(", ")}`);
    }
  }

  if (templateOnly.length) {
    console.log(`\n=== AIX 本体には効かず「✨ 会話を合わせる」経由でだけ届くルール（${templateOnly.length}件） ===`);
    for (const r of templateOnly) {
      console.log(`  ・${r.rule_key}  action_type=${r.action_type}  ${r.rule_text.replace(/\s+/g, " ").slice(0, 70)}`);
    }
  }

  // ── ④ 経路ごとに上限で落ちる件数 ───────────────────────────
  console.log(`\n=== 上限で落ちる件数（非永久 ${PROMPT_RULE_LIMIT_HIGH} / 永久 ${PROMPT_RULE_LIMIT_PERMANENT}）===`);
  const active = rows.filter((r) => r.is_active !== false && !(r.rule_key.startsWith("LEARN-") && !r.rule_key.startsWith("LEARN-AIX-")));
  const order = (a: Row, b: Row) =>
    (b.priority ?? 0) - (a.priority ?? 0) ||
    String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) ||
    a.rule_key.localeCompare(b.rule_key);

  for (const route of [...Object.keys(PROMPT_RULE_ROUTES), "(global)"]) {
    const at = route === "(global)" ? null : route;
    // includeGlobal=true の経路は action 別 ＋ global を1つの枠で取る（fetchPromptRules と同じ）
    const pool = active.filter((r) => (at === null ? r.action_type === null : (r.action_type === at || r.action_type === null)));
    const high = pool.filter((r) => r.is_permanent !== true && (r.priority ?? 0) >= PROMPT_RULE_MIN_PRIORITY).sort(order);
    const perm = pool.filter((r) => r.is_permanent === true).sort(order);
    const droppedHigh = Math.max(0, high.length - PROMPT_RULE_LIMIT_HIGH);
    const droppedPerm = Math.max(0, perm.length - PROMPT_RULE_LIMIT_PERMANENT);
    if (droppedHigh === 0 && droppedPerm === 0) continue;
    const kept = high[PROMPT_RULE_LIMIT_HIGH - 1];
    console.log(`  ・${route}: ${high.length}件中 ${droppedHigh}件が落ちる（最後に入るのは priority=${kept?.priority}・${kept?.rule_key}）`
      + (droppedPerm ? ` / 永久 ${perm.length}件中 ${droppedPerm}件` : ""));
    for (const r of high.slice(PROMPT_RULE_LIMIT_HIGH, PROMPT_RULE_LIMIT_HIGH + 5)) {
      console.log(`      落ちる例: ${r.rule_key}(priority=${r.priority}) ${r.rule_text.replace(/\s+/g, " ").slice(0, 70)}`);
    }
    if (droppedHigh > 5) console.log(`      … 他 ${droppedHigh - 5}件`);
  }

  const unreachable = [...failures.entries()].filter(([k]) => !QUIET.includes(k)).reduce((n, [, l]) => n + l.length, 0);
  console.log(`\n直すべき行: ${unreachable}件`);
  process.exit(unreachable > 0 ? 1 : 0);
})();
