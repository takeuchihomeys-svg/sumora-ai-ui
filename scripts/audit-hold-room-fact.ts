// scripts/audit-hold-room-fact.ts
// 2026-10-02 竹内「仮押さえ 会社の事実として入れる」: company-facts の hold_room（仮押さえ・お部屋を抑える）が
//   お客様の発言のどれに当たるかを全部出す（読むだけ・LLM なし）。費用を「抑える」に当たっていないかを目で読む。
// 実行: npx tsx --env-file=.env.local scripts/audit-hold-room-fact.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { COMPANY_FACTS, matchCompanyFacts } from "../app/lib/company-facts";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");
async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const rows: Array<{ text: string }> = [];
  for (const pat of ["%抑え%", "%押さえ%", "%おさえ%", "%押え%", "%キープ%", "%部屋止め%"]) {
    for (let p = 0; p < 10; p++) {
      const { data } = await sb.from("messages").select("id, text").eq("sender", "customer").gte("created_at", since).like("text", pat).range(p * 1000, p * 1000 + 999);
      rows.push(...((data ?? []) as Array<{ text: string }>)); if (!data || data.length < 1000) break;
    }
  }
  const f = COMPANY_FACTS.find((x) => x.id === "hold_room")!;
  const seen = new Set<string>(); let hit = 0, miss = 0;
  for (const r of rows) {
    const t = r.text ?? ""; if (seen.has(t)) continue; seen.add(t);
    const on = matchCompanyFacts(t).some((x) => x.id === f.id);
    if (on) hit++; else miss++;
    console.log(`${on ? "当" : "　"} ${t.replace(/\s+/g, " ").slice(0, 110)}`);
  }
  console.log(`\n当たり ${hit} ／ 外れ ${miss}（「抑え・押さえ・キープ・部屋止め」を含むお客様の発言・重複除く）`);
}
main();
