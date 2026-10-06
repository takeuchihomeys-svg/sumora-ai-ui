// scripts/apply-household-9e04d916.ts — 9e04d916（6/4「別れたので別でお家探したい」）のその他に残った「二人入居可」を外す（竹内さん承認済み 2026-10-06「外して良い」）
// 実行: npx tsx --env-file=.env.local scripts/apply-household-9e04d916.ts [--apply]
// webhook と同じ applyHouseholdChange（履歴・帯）。戻す時は条件の画面の「戻す」（property_condition_history）
import { createClient } from "@supabase/supabase-js";
import { applyHouseholdChange } from "../app/lib/household-change-server";
import { householdChangeOf, smallerOkOf } from "../app/lib/condition-reading";
import { planHouseholdConditions } from "../app/lib/household-change";

const CONV = "9e04d916-ac8d-4f03-8649-c0d44947e2f3";
const PC = "506b07a4-1a62-4c1a-874c-8c7743b2bcec";
const MSG = { id: "dc0415cf-cdf6-45b4-a99f-fdf3b4734997", text: "別れたので別でお家探したいのですが可能でしょうか？" };
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const apply = process.argv.includes("--apply");
  const { data: conv } = await sb.from("conversations").select("property_customer_id").eq("id", CONV).maybeSingle();
  if (conv?.property_customer_id !== PC) throw new Error(`会話の紐付け先が想定と違う: ${conv?.property_customer_id}`);
  const { data: cur } = await sb.from("property_customers").select("preferences, other_requests, floor_area_min, floor_plan, additional_conditions").eq("id", PC).single();
  const plan = planHouseholdConditions(cur as never, householdChangeOf(MSG.text), smallerOkOf(MSG.text));
  console.log(`「${MSG.text}」→ ${JSON.stringify(plan.updates)}／帯: ${plan.banner}`);
  if (apply) console.log("  書いた:", JSON.stringify(await applyHouseholdChange(sb, CONV, MSG.text, MSG.id)));
  const { data: after } = await sb.from("property_customers").select("other_requests").eq("id", PC).single();
  console.log(apply ? "後の行:" : "（--apply なし・書いていない）今の行:", JSON.stringify(after));
}
main().catch((e) => { console.error(e); process.exit(1); });
