// scripts/audit-okyaku-address.ts — 相手を「お客様」と呼ぶ文の出口（app/lib/okyaku-address.ts）が何を変えるか（読むだけ・LLM なし）
// 2026-10-02 竹内「お客様って言葉使わない」:
//   ①本番のスタッフの送信（人の手打ち・AIX）の「お客様」を全部出し、出口で変わる通を前後で出す（他の人を指す文が変わったら誤り）
//   ②AI の下書き（ai_reply_examples.ai_draft）で変わる通の数と例
// 実行: npx tsx --env-file=.env.local scripts/audit-okyaku-address.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { fixSecondPersonOkyaku } from "../app/lib/okyaku-address";
import { isTestConversation } from "../app/lib/test-conversations";

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const ctx = (t: string) => [...t.matchAll(/.{0,18}お客様.{0,18}/g)].map((m) => m[0].replace(/\n/g, "⏎")).join(" ｜ ");

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Array<{ conversation_id: string; created_at: string; text: string | null; is_aix_generated: boolean | null }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, created_at, text, is_aix_generated").eq("sender", "staff").gte("created_at", since).ilike("text", "%お客様%").order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const c = { human: 0, humanChanged: 0, aix: 0, aixChanged: 0 };
  console.log("=== 本番のスタッフの送信で「お客様」を含む通（変わった通は → の後）");
  for (const r of rows) {
    if (isTestConversation(r.conversation_id) || !r.text) continue;
    const f = fixSecondPersonOkyaku(r.text, "Aさん");
    if (r.is_aix_generated) { c.aix++; if (f.changes.length) c.aixChanged++; } else { c.human++; if (f.changes.length) c.humanChanged++; }
    console.log(`${r.is_aix_generated ? "AIX" : "人 "} ${r.created_at.slice(0, 10)} ${f.changes.length ? "【変わる】" : "　　　　"} ${ctx(r.text)}${f.changes.length ? `\n      → ${ctx(f.text) || f.changes.join("・")}` : ""}`);
  }
  const ex: Array<{ ai_draft: string | null; created_at: string }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("ai_reply_examples").select("ai_draft, created_at").ilike("ai_draft", "%お客様%").gte("created_at", since).range(i, i + 999);
    if (error) throw new Error(error.message);
    ex.push(...((data ?? []) as typeof ex));
    if (!data || data.length < 1000) break;
  }
  let dChanged = 0;
  console.log("\n=== AI の下書きで変わる通（例）");
  for (const r of ex) {
    const f = fixSecondPersonOkyaku(r.ai_draft, "Aさん");
    if (!f.changes.length) continue;
    dChanged++;
    if (dChanged <= 15) console.log(`${r.created_at.slice(0, 10)} ${f.changes.join("・")} ｜ ${ctx(r.ai_draft ?? "").slice(0, 120)}`);
  }
  console.log(`\n=== ${DAYS}日: 人の手打ち「お客様」${c.human}通 → 変わる ${c.humanChanged}／AIX ${c.aix}通 → 変わる ${c.aixChanged}／AI の下書き「お客様」${ex.length}通 → 変わる ${dChanged}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
