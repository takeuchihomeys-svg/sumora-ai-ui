// scripts/audit-first-greeting-returning.ts
// 2026-10-02 ⑫ 1巡目（再生 first_contact_05）: この LINE での最初のお客様の発言が「お世話になっております。まだ家探ししてるのですが、相談よろしいでしょうか？」
//   （前にやり取りのあるお客様）に、初回の下書きが「はじめまして😊！！…担当させて頂きます鈴木と申します」を付けた。スタッフは「お世話になっております！！」。
//   会話の最初のお客様の発言（会話の最初の通が期間内）で「お世話になっております／お世話になってます／以前」を含む物に、スタッフの最初の返事の冒頭が
//   「はじめまして」か「お世話になっております」かを数える（読むだけ・LLM なし）。
// 実行: npx tsx --env-file=.env.local scripts/audit-first-greeting-returning.ts [--days=240]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=240").slice(7));
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: M[] = [];
  for (let f = 0; f < 600_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, f + 999);
    if (error) throw error; rows.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, M[]>();
  for (const r of rows) { if (!by.has(r.conversation_id)) by.set(r.conversation_id, []); by.get(r.conversation_id)!.push(r); }
  const tally: Record<string, number> = {};
  const ex: string[] = [];
  let firstTotal = 0, firstHajime = 0;
  for (const [cid, ms] of by) {
    if (isTestConversation(cid)) continue;
    const i = ms.findIndex((m) => m.sender === "customer");
    if (i !== 0) continue; // 会話の最初がお客様（期間の最初からの会話だけ）
    const c = ms[0].text ?? "";
    const s = ms.find((m) => m.sender !== "customer" && !m.is_aix_generated && (m.text ?? "").trim() && !/^\[画像\]/.test(m.text ?? ""));
    if (!s) continue;
    const st = s.text ?? "";
    firstTotal++;
    if (/はじめまして|初めまして/.test(st)) firstHajime++;
    if (!/お世話になって(?:おります|ます|います)|以前|前回|またお願い|再度/.test(c)) continue;
    const k = /はじめまして|初めまして/.test(st) ? "はじめまして" : /お世話になっております/.test(st) ? "お世話になっております" : "その他";
    tally[k] = (tally[k] ?? 0) + 1;
    if (ex.length < 40) ex.push(`${cid.slice(0, 8)} ${k}｜C:${c.replace(/\n/g, " ").slice(0, 60)}｜S:${st.replace(/\n/g, " ").slice(0, 60)}`);
  }
  console.log(`最初の返事 ${firstTotal}・うち はじめまして ${firstHajime}`);
  console.log(`お客様の最初の発言が「お世話になっております/以前…」: ${JSON.stringify(tally)}`);
  for (const e of ex) console.log("  " + e);
})().catch((e) => { console.error(e); process.exit(1); });
