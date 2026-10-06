// scripts/apply-household-akari.ts — あかり（10/02「私一人になるかもです」「ちっさくて大丈夫です！」）の条件を世帯の変わり目に合わせて直す（竹内さん承認済み 2026-10-06）
// 実行: npx tsx --env-file=.env.local scripts/apply-household-akari.ts           … 何が変わるかだけ出す（書かない）
//       npx tsx --env-file=.env.local scripts/apply-household-akari.ts --apply   … 書く（webhook と同じ applyHouseholdChange・履歴 p4・帯 auto）
// 書くのはこの1人の行だけ。戻す時は条件の画面の「戻す」（property_condition_history）
import { createClient } from "@supabase/supabase-js";
import { applyHouseholdChange } from "../app/lib/household-change-server";
import { householdChangeOf, smallerOkOf } from "../app/lib/condition-reading";
import { planHouseholdConditions } from "../app/lib/household-change";

const CONV = "c024b7b9-5a84-452c-8386-65699c229d08";
const PC = "4c075f30-c269-4e59-a059-baa271f4a282";
const MSGS = [
  { id: "0e6ec2ec-a951-442d-a482-995cefc524cc", text: "私一人になるかもです" },
  { id: "243505c4-f7ca-4b05-bb25-e564ab602b71", text: "ここの部屋に似た感じでちっさくて大丈夫です！" },
];
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const apply = process.argv.includes("--apply");
  const { data: conv } = await sb.from("conversations").select("property_customer_id").eq("id", CONV).maybeSingle();
  if (conv?.property_customer_id !== PC) throw new Error(`会話の紐付け先が想定と違う: ${conv?.property_customer_id}`);
  for (const m of MSGS) {
    const { data: cur } = await sb.from("property_customers").select("preferences, other_requests, floor_area_min, floor_plan, additional_conditions").eq("id", PC).single();
    const plan = planHouseholdConditions(cur as never, householdChangeOf(m.text), smallerOkOf(m.text));
    console.log(`「${m.text}」→ ${JSON.stringify(plan.updates)}／帯: ${plan.banner}`);
    if (apply) console.log("  書いた:", JSON.stringify(await applyHouseholdChange(sb, CONV, m.text, m.id)));
  }
  const { data: after } = await sb.from("property_customers").select("preferences, other_requests, additional_conditions").eq("id", PC).single();
  console.log(apply ? "後の行:" : "（--apply なし・書いていない）今の行:", JSON.stringify(after));
}
main().catch((e) => { console.error(e); process.exit(1); });
