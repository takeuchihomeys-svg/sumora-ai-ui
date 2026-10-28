// scripts/audit-equip-burner3.ts — EQUIP_BURNER3 の影響: 条件に「3口」を持つお客様の数と、その売上サポの行で設備の判定（コンロ）が変わる物件の数（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-equip-burner3.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { readEquipmentItemsFromText } from "../app/lib/listing-equipment";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const days = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "90");
(async () => {
  const { data: pcs, error: pe } = await sb.from("property_customers").select("id, preferences, other_requests, ng_points").limit(5000);
  if (pe) throw new Error(pe.message);
  const re = /(?:3|３|三)口/;
  const hit = ((pcs ?? []) as Array<Record<string, string | null> & { id: string }>).filter((p) => re.test([p.preferences, p.other_requests, p.ng_points].join(" ")));
  console.log(`条件に「3口」: ${hit.length}人（全 ${(pcs ?? []).length}人）`);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const trans: Record<string, number> = {};
  let rows = 0;
  for (const p of hit) {
    const { data: cv } = await sb.from("conversations").select("id").eq("property_customer_id", p.id);
    for (const c of (cv ?? []) as Array<{ id: string }>) {
      const { data: pk } = await sb.from("property_pickups").select("pdf_text, equipment").eq("conversation_id", c.id).gte("created_at", since).limit(500);
      for (const r of (pk ?? []) as Array<{ pdf_text: string | null; equipment: { facts?: Record<string, { s?: string }> } | null }>) {
        rows++;
        const items = readEquipmentItemsFromText(r.pdf_text ?? "");
        const b2 = r.equipment?.facts?.burner2?.s ?? items.burner2.status;
        const k = `今 burner2=${b2} → on burner3=${items.burner3.status}`;
        trans[k] = (trans[k] ?? 0) + 1;
      }
    }
  }
  console.log(`その売上サポの行（${days}日）: ${rows}件`);
  for (const [k, v] of Object.entries(trans).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
})();
