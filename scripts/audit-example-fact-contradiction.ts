// scripts/audit-example-fact-contradiction.ts — 手本（ai_reply_examples.sent_reply）のうち会社の事実に反する断定（company-fact-guard）を含む物を数える（読むだけ・LLM なし）
// 2026-10-02 竹内さんの決定「分割はカード払いなら可にそろえる。食い違うスタッフの送信を手本にしない」→ example-hygiene.isUsableExampleText で外す前に、外れる手本を全部目で読む
// 実行: npx tsx --env-file=.env.local scripts/audit-example-fact-contradiction.ts
import { createClient } from "@supabase/supabase-js";
import { findCompanyFactContradictionsUngated } from "../app/lib/company-fact-guard";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function main() {
  let n = 0; const hits: string[] = [];
  for (let i = 0; ; i += 1000) {
    const r = await sb.from("ai_reply_examples").select("id, created_at, is_starred, entry_source, sent_reply").order("created_at").range(i, i + 999);
    if (r.error) throw r.error;
    for (const e of r.data ?? []) { n++; const h = findCompanyFactContradictionsUngated(e.sent_reply ?? ""); if (h.length) hits.push(`${e.id.slice(0, 8)} ${e.created_at.slice(0, 10)} ${e.is_starred ? "⭐" : "  "} ${e.entry_source} [${h.map((x) => x.factId).join(",")}]｜${(e.sent_reply ?? "").replace(/\n/g, " ").slice(0, 140)}`); }
    if ((r.data ?? []).length < 1000) break;
  }
  console.log(`手本 ${n}行のうち 会社の事実に反する断定を含む ${hits.length}`);
  for (const h of hits) console.log("  " + h);
}
main().catch((e) => { console.error(e); process.exit(1); });
