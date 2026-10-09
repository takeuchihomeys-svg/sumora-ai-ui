// 読むだけ（LLM なし）: 確認事項の「先の時期の相談」（request-ledger.DEFERRED_RE・2026-10-08 竹内さん⑤）が、365日のお客様の依頼・質問のどれに当たるかを並べる。
//   当たった文が全部「先の時期の相談」で、今の依頼（見積・空き・内覧）を外していない事を目で読む。
// 実行: npx tsx --env-file=.env.local scripts/audit-request-ledger-deferred.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { splitRequests } from "../app/lib/request-ledger";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=365").split("=")[1]);
(async () => {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  let n = 0, items = 0; const hits: string[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db.from("messages").select("conversation_id, created_at, text").eq("sender", "customer").gte("created_at", since)
      .or("text.ilike.%相談%,text.ilike.%連絡%,text.ilike.%お声がけ%,text.ilike.%探し%").order("created_at").range(off, off + 999);
    if (error) throw error;
    for (const m of data ?? []) {
      if (m.conversation_id === YUMA_CONVERSATION_ID) continue;
      n++;
      for (const x of splitRequests([m.text ?? ""], m.created_at)) { items++; if (x.deferred) hits.push(`${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)} [${x.topic}] ${x.quote}`); }
    }
    if (!data || data.length < 1000) break;
  }
  console.log(`お客様の発言（相談・連絡・探し を含む）${n}通 → 依頼・質問 ${items} 行 → 先の時期の相談 ${hits.length}\n${hits.join("\n")}`);
})();
