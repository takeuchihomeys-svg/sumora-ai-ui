// scripts/audit-implicit-rent-min.ts
// 2026-10-02 竹内さんの決定（⑫）「上限しか無い時も、おおよその下限を出して、ずっと安い物件を送らない（10万の上限で5万の部屋は質が下がる）」の線引き。
//   スタッフが選んで送った物件（🌟の推し・売上サポで送った物）の 家賃（＋管理費）÷ そのお客様の上限 を、下限の無いお客様だけで数える（読むだけ・LLM なし）。
//   上限は今の顧客の行（rent_max）。条件が途中で変わった人は外せないので、上限を超えた送付（言い直し・広げ）は別に数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-implicit-rent-min.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").slice(7));
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data: convs } = await sb.from("conversations").select("id, property_customer_id").not("property_customer_id", "is", null).limit(5000);
  const { data: pcs } = await sb.from("property_customers").select("id, rent_min, rent_max").limit(5000);
  const pc = new Map(((pcs ?? []) as Array<{ id: string; rent_min: number | null; rent_max: number | null }>).map((p) => [p.id, p]));
  const pcOf = new Map(((convs ?? []) as Array<{ id: string; property_customer_id: string }>).map((c) => [c.id, pc.get(c.property_customer_id)]));
  const ratios: { noMin: number[]; withMin: number[] } = { noMin: [], withMin: [] };
  for (let f = 0; f < 400_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, text").eq("sender", "staff").gte("created_at", since).like("text", "%🌟%").range(f, f + 999);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ conversation_id: string; text: string }>) {
      if (isTestConversation(r.conversation_id)) continue;
      const p = pcOf.get(r.conversation_id);
      if (!p?.rent_max || p.rent_max < 30_000) continue;
      const t = r.text.normalize("NFKC").replace(/,/g, "");
      // 「家賃管理費込74000円」「・家賃66000円・管理費10000円(合計76000円)」「家賃70000円」
      const total = Number((t.match(/(?:管理費込み?|合計)\s*([0-9]{5,6})\s*円/) ?? [])[1] ?? NaN);
      const rentOnly = Number((t.match(/家賃\s*([0-9]{5,6})\s*円/) ?? [])[1] ?? NaN);
      const v = Number.isFinite(total) ? total : rentOnly;
      if (!Number.isFinite(v)) continue;
      (p.rent_min ? ratios.withMin : ratios.noMin).push(v / p.rent_max);
    }
    if ((data ?? []).length < 1000) break;
  }
  const show = (name: string, xs: number[]) => {
    const s = xs.filter((x) => x <= 1.0).sort((a, b) => a - b);
    const q = (p: number) => s[Math.floor((s.length - 1) * p)]?.toFixed(2);
    const below = (r: number) => `${s.filter((x) => x < r).length}（${((s.filter((x) => x < r).length / Math.max(1, s.length)) * 100).toFixed(1)}%）`;
    console.log(`${name}: 上限内 ${s.length}・上限超え ${xs.length - s.length}｜5% ${q(0.05)}・10% ${q(0.1)}・25% ${q(0.25)}・中央 ${q(0.5)}｜60%未満 ${below(0.6)}・65%未満 ${below(0.65)}・70%未満 ${below(0.7)}・75%未満 ${below(0.75)}`);
  };
  show("下限なしのお客様（🌟の推し）", ratios.noMin);
  show("下限ありのお客様（参考）", ratios.withMin);
})();
