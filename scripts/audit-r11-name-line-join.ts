// scripts/audit-r11-name-line-join.ts — 11巡目: AIX の出口で「〇〇さん」だけの行を次の本文につなぐ（daily-greeting.joinNameOnlyLine）の全件監査（読むだけ・LLM なし）
//   ①AIX の生成文（aix_generate_log）で変わる通の数と前後（目で読む）②竹内さんが送った AIX の通で、名前だけの行を残した通・つないだ形との一致
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-name-line-join.ts [--since=2026-09-01] [--show=20]
import { createClient } from "@supabase/supabase-js";
import { joinNameOnlyLine } from "../app/lib/daily-greeting";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-09-01"); const SHOW = Number(arg("show", "20"));
async function readAll(q: (f: number, t: number) => any) { const out: any[] = []; for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break; } return out; }
(async () => {
  const gens = await readAll((f, t) => sb.from("aix_generate_log").select("action_type, generated_text").gte("generated_at", SINCE).not("generated_text", "is", null).range(f, t));
  const ch = gens.filter((g) => joinNameOnlyLine(g.generated_text) !== g.generated_text);
  console.log(`AIX の生成 ${gens.length}通 → 変わる ${ch.length}通`);
  const by: Record<string, number> = {}; for (const g of ch) by[g.action_type] = (by[g.action_type] ?? 0) + 1; console.log(by);
  for (const g of ch.slice(0, SHOW)) console.log(`--- ${g.action_type}\n前: ${g.generated_text.slice(0, 90).replace(/\n/g, "⏎")}\n後: ${joinNameOnlyLine(g.generated_text).slice(0, 90).replace(/\n/g, "⏎")}`);
  const sent = await readAll((f, t) => sb.from("messages").select("text, is_aix_generated").eq("staff_writer", "takeuchi").neq("sender", "customer").gte("created_at", SINCE).range(f, t));
  const nameOnly = sent.filter((m) => joinNameOnlyLine(m.text ?? "") !== (m.text ?? ""));
  console.log(`\n竹内さんの送信 ${sent.length}通のうち、つなぐ形に当たる（名前だけの行＋本文）${nameOnly.length}通（AIX ${nameOnly.filter((m) => m.is_aix_generated).length}・手打ち ${nameOnly.filter((m) => !m.is_aix_generated).length}）`);
})();
