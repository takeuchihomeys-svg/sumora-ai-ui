// scripts/audit-aix-json-edge.ts — AIX の出口の端の名残落とし（aix-message-json.stripJsonEdgeResidue）が人の文・送った文を変えないか／下書きの名残を落とせるかを数える（読むだけ・LLM なし）
// 2026-10-07 竹内（Ryoichi kiritsuke 10/05 の AIX【物件ピックアップした】の下書きの末尾の "}）
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-json-edge.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { stripJsonEdgeResidue } from "../app/lib/aix-message-json";
import { detectOutgoingResidue } from "../app/lib/outgoing-residue";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");

async function pageAll<T>(table: string, cols: string, filter: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await filter(sb.from(table).select(cols)).order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const sent = await pageAll<{ text: string | null; created_at: string; is_aix_generated: boolean | null }>("messages", "text, created_at, is_aix_generated", (q) => q.eq("sender", "staff").gte("created_at", since));
  let nS = 0, chS = 0;
  for (const r of sent) {
    const t = r.text ?? "";
    if (!t.trim()) continue;
    nS++;
    const e = stripJsonEdgeResidue(t);
    if (e.stripped) { chS++; console.log(`送信で変わる ${r.created_at.slice(0, 16)} ${r.is_aix_generated ? "AIX" : "手"} ${JSON.stringify(t).slice(-120)}`); }
  }
  const gens = await pageAll<{ generated_text: string | null; created_at: string; action_type: string }>("aix_generate_log", "generated_text, created_at, action_type", (q) => q.gte("created_at", since));
  let nG = 0, chG = 0, residueBefore = 0, residueAfter = 0;
  for (const r of gens) {
    const t = r.generated_text ?? "";
    if (!t.trim()) continue;
    nG++;
    const before = detectOutgoingResidue(t).length > 0;
    const e = stripJsonEdgeResidue(t);
    const after = detectOutgoingResidue(e.text).length > 0;
    if (before) residueBefore++;
    if (after) residueAfter++;
    if (e.stripped || before) {
      if (e.stripped) chG++;
      console.log(`下書き ${r.created_at.slice(0, 16)} ${r.action_type} ${e.stripped ? "落とした" : "触らない"} 名残 ${before ? "あり" : "なし"}→${after ? "あり" : "なし"}\n   前: ${JSON.stringify(t).slice(-90)}\n   後: ${JSON.stringify(e.text).slice(-90)}`);
    }
  }
  console.log(`\nスタッフの送信 ${nS}通で変わる ${chS}（0 でなければ入れない）／AIX の下書き ${nG}通で落とした ${chG}・名残（送信 API の網）${residueBefore}→${residueAfter}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
