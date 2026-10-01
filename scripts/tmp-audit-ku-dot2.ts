// 「く・」の全件（スタッフの文＋AIX 生成ログ）を表示（読むだけ）
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function pull(table: string, cols: string, extra?: (q: any) => any) {
  const out: any[] = [];
  for (let p = 0; p < 300; p++) {
    let q = sb.from(table).select(cols).order("created_at").range(p * 1000, p * 1000 + 999);
    if (extra) q = extra(q);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
async function main() {
  const re = /[^\s]く・/g;
  const msgs = (await pull("messages", "conversation_id, text, is_aix_generated", (q) => q.eq("sender", "staff"))).filter((r) => r.text && !isTestConversation(r.conversation_id));
  console.log("staff all-time", msgs.length);
  const ctx = new Map<string, number>();
  for (const r of msgs) for (const m of r.text.matchAll(re)) { const i = m.index!; const k = r.text.slice(Math.max(0, i - 3), i + 2); ctx.set(k, (ctx.get(k) ?? 0) + 1); console.log(r.is_aix_generated ? "[AIX]" : "[人]", r.text.slice(Math.max(0, i - 20), i + 30).replace(/\n/g, "⏎")); }
  console.log([...ctx.entries()]);
  const gl = (await pull("aix_generate_log", "conversation_id, generated_text, action_type")).filter((r) => r.generated_text && !isTestConversation(r.conversation_id));
  const g2 = new Map<string, number>(); let n = 0;
  for (const r of gl) for (const m of r.generated_text.matchAll(re)) { n++; const i = m.index!; const k = r.generated_text.slice(Math.max(0, i - 3), i + 2); g2.set(k, (g2.get(k) ?? 0) + 1); }
  console.log("aix_generate_log rows", gl.length, "hits", n, [...g2.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30));
  const tg = (await pull("aix_template_generate_log", "conversation_id, generated_text").catch(() => [])) as any[];
  console.log("template log", tg.length);
}
main();
