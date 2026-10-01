// scripts/audit-installment-lump-sum.ts — 「初期費用は一括（お振込）のみ」「分割は難しい」型のスタッフの送信を全部出す（読むだけ・LLM なし）
// 2026-10-02 竹内さんの決定「カード払いなら分割可（手数料3.24%）にそろえる。9/30・10/01 の『分割は難しい・一括のみ』は規則と食い違う」:
//   出口（company-fact-guard）に足す形を実送信で確かめる。会社の事実に沿う文（クレジットカードが無い場合は一括）を当てないこと。
// 実行: npx tsx --env-file=.env.local scripts/audit-installment-lump-sum.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { findCompanyFactContradictionsUngated } from "../app/lib/company-fact-guard";
import { isTestConversation } from "../app/lib/test-conversations";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string; created_at: string; text: string; is_aix_generated: boolean | null }> = [];
  for (let i = 0; ; i += 1000) { const r = await sb.from("messages").select("conversation_id, created_at, text, is_aix_generated").neq("sender", "customer").gte("created_at", since).or("text.ilike.%一括%,text.ilike.%分割%,text.ilike.%振込のみ%").order("created_at").range(i, i + 999); if (r.error) throw r.error; rows.push(...(r.data as typeof rows)); if ((r.data ?? []).length < 1000) break; }
  let hit = 0;
  for (const m of rows) {
    if (isTestConversation(m.conversation_id)) continue;
    const h = findCompanyFactContradictionsUngated(m.text).filter((x) => x.factId === "credit_card");
    const mark = h.length ? "★当たる" : "  ";
    if (h.length) hit++;
    if (/一括|振込のみ|分割[^\n]{0,12}(難し|出来ない|できない|不可)/.test(m.text)) console.log(`${mark} ${m.conversation_id.slice(0, 8)} ${m.created_at.slice(0, 10)} ${m.is_aix_generated ? "AIX" : "手打ち"}｜${m.text.replace(/\n/g, " ").slice(0, 150)}`);
  }
  console.log(`\nスタッフの送信 ${rows.length}通（一括・分割・振込のみ を含む）のうち 会社の事実（credit_card）の断定に当たる ${hit}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
