// scripts/audit-draft-bubbles.ts — splitDraftBubbles（app/lib/draft-bubbles.ts）を人の実送信・AI の下書きに当てる（読むだけ・LLM なし）
//   ①竹内さんが2通に分けた番を「つないだ文」にして分けられるか（当たり）②1通で送った文を分けてしまうか（誤り＝0 にしたい）
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-bubbles.ts [--days=150]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { splitDraftBubbles } from "../app/lib/draft-bubbles";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "150");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs: M[] = [];
  const q = (i: number) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").eq("sender", "staff").gte("created_at", since).order("created_at").order("id").range(i, i + 999);
  for (let i = 0; i < 1_000_000; i += 1000) { let r = await q(i); for (let t = 0; t < 3 && r.error; t++) r = await q(i); if (r.error) throw new Error(r.error.message); msgs.push(...((r.data ?? []) as M[])); if ((r.data ?? []).length < 1000) break; }
  const hand = msgs.filter((m) => !m.is_aix_generated && !isTestConversation(m.conversation_id) && (m.text ?? "").length > 20);
  let wrong = 0; const ex: string[] = [];
  for (const m of hand) { const s = splitDraftBubbles(m.text); if (s) { wrong++; if (ex.length < 15) ex.push(`${m.conversation_id.slice(0, 6)} ${m.created_at.slice(5, 16)} ｜${s[0].replace(/\s+/g, " ").slice(-60)}｜→｜${s[1].replace(/\s+/g, " ").slice(0, 60)}`); } }
  // 人が2通に分けた（3分以内に続いた手打ちで、2通目が「あわせ」で始まる）
  let pairs = 0, hit = 0;
  for (let i = 1; i < hand.length; i++) {
    const a = hand[i - 1], b = hand[i];
    if (a.conversation_id !== b.conversation_id || Date.parse(b.created_at) - Date.parse(a.created_at) > 180_000) continue;
    if (!/^(?:あわせ|併せ|合わせ)/.test((b.text ?? "").trim())) continue;
    pairs++; if (splitDraftBubbles(`${a.text}\n\n${b.text}`)) hit++;
  }
  console.log(`== ${DAYS}日・手打ち ${hand.length}通: 1通で送った文を分けてしまう ${wrong}（下は目で読む）`);
  for (const e of ex) console.log("  " + e);
  console.log(`人が「あわせ〜」で2通に分けた組 ${pairs}: つないだ文を分けられた ${hit}`);
})().catch((e) => { console.error(e); process.exit(1); });
