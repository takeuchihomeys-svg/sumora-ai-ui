// scripts/audit-pickup-mismatch-phrases.ts（読むだけ・LLM なし）: スタッフの物件ピックアップの送付文で「〇〇では御座いませんが」「〇〇は募集ございませんでしたので」の型を数える（2026-10-07 会話「し」）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
(async () => {
  const rows: any[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from("messages").select("id,conversation_id,text,created_at").eq("sender", "staff").ilike("text", "%ご査収%").gte("created_at", "2026-04-01").range(from, from + 999);
    if (error) { console.log(error.message); break; }
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break; from += 1000;
  }
  const pick = rows.filter((r) => r.conversation_id !== YUMA && /ピックアップ|募集に(?:で|出)ました/.test(r.text) && !/見積/.test(r.text));
  console.log("pickup sends", pick.length);
  const RE = /([^\n！!。]{0,40}(?:では(?:ござ|御座)いませんが|ではないですが|ではありませんが|ではないのですが|じゃないですが|では無いですが|ございませんでしたが|御座いませんでしたが|ございませんでしたので|御座いませんでしたので|出ておりませんでしたので|ありませんでしたので|上がりますが|超えますが|外れますが|オーバーしますが|少し離れますが|ございませんが)[^\n]{0,60})/;
  const hits = pick.filter((r) => RE.test(r.text));
  console.log("with mismatch-ack", hits.length);
  const cat: Record<string, number> = {};
  for (const r of hits.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const m = r.text.match(RE)![1];
    const k = /では(?:ござ|御座)いませんが|ではないですが|ではありませんが|ではないのですが|では無いですが/.test(m) ? "Aではございませんが" : /でしたが|でしたので/.test(m) ? "B無かったので/が" : /上がりますが|超えますが|オーバー/.test(m) ? "C超えますが" : "Dその他";
    cat[k] = (cat[k] ?? 0) + 1;
    console.log(k, r.created_at.slice(0, 10), r.conversation_id.slice(0, 8), "|", m.slice(0, 140));
  }
  console.log(cat);
})();
