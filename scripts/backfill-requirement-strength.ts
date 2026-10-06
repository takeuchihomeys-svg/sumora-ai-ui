// scripts/backfill-requirement-strength.ts — 紐付けのあるお客様の要望の強さを、直近14日のお客様の発言から読んで property_customers.requirement_strength に入れる
// 実行: npx tsx --env-file=.env.local scripts/backfill-requirement-strength.ts [--apply]（既定は見るだけ）
// 2026-10-06 ⑫ 竹内（ゆいと 10月後半入居）。以後は webhook（requirement-strength-server.refreshRequirementStrength）が新しい発言で書く
import { createClient } from "@supabase/supabase-js";
import { refreshRequirementStrength } from "../app/lib/requirement-strength-server";
import { readRequirementStrengths } from "../app/lib/requirement-strength";

const apply = process.argv.includes("--apply");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const { data: convs } = await sb.from("conversations").select("id, customer_name, property_customer_id, is_post_apply").not("property_customer_id", "is", null);
  let n = 0;
  for (const c of (convs ?? []) as Array<{ id: string; customer_name: string | null; property_customer_id: string; is_post_apply: boolean | null }>) {
    if (c.is_post_apply) continue;
    const { data: msgs } = await sb.from("messages").select("text, created_at").eq("conversation_id", c.id).eq("sender", "customer").gte("created_at", since).order("created_at").limit(200);
    const s = readRequirementStrengths(((msgs ?? []) as Array<{ text: string | null; created_at: string }>).map((m) => ({ text: m.text, at: m.created_at })));
    if (!Object.keys(s).length) continue;
    n++;
    console.log(c.customer_name, Object.fromEntries(Object.entries(s).map(([k, v]) => [k, `${v?.strength}「${v?.evidence.slice(0, 30)}」`])));
    if (apply) await refreshRequirementStrength(sb, c.id);
  }
  console.log(`${n}人${apply ? "に書いた" : "（見るだけ・書く時は --apply）"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
