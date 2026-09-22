// 「もう少し見てみたい／ほかもあれば見てみたい」＝他のお部屋も見たい、の直後にスタッフが何を返したか（実送信）
// 2026-09-22 竹内（𝓡さん事例）「引き続き新着物件が優先。実際の LINE 見てもそうなってると思う」
// 実行: npx tsx --env-file=.env.local scripts/audit-see-more-intent.ts
import { createClient } from "@supabase/supabase-js";
import { customerAsksMoreListings } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const PICKUP_RE = /新着|ピックアップ|出次第|随時|探させて|お探し|ご紹介/;
const ESTIMATE_RE = /見積/;
const VIEWING_RE = /ご案内させて|ご内覧/;

async function main() {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const rows: Array<{ id: string; conversation_id: string; text: string | null; created_at: string }> = [];
  for (const kw of ["%見てみたい%", "%見たい%", "%見れたら%"]) {
    for (let p = 0; p < 10; p++) {
      const { data } = await sb.from("messages").select("id, conversation_id, text, created_at").eq("sender", "customer").ilike("text", kw).gte("created_at", since).range(p * 1000, p * 1000 + 999);
      const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
    }
  }
  const hits = [...new Map(rows.filter((r) => customerAsksMoreListings(r.text)).map((r) => [r.id, r])).values()];
  let pickup = 0, estimate = 0, viewing = 0, replied = 0;
  for (const h of hits) {
    const { data: nx } = await sb.from("messages").select("text").eq("conversation_id", h.conversation_id).eq("sender", "staff").gt("created_at", h.created_at).order("created_at").limit(3);
    const reply = ((nx ?? []) as Array<{ text: string | null }>).map((x) => x.text ?? "").filter((t) => !/^\s*\[画像\]\s*$/.test(t)).join(" ／ ");
    if (!reply) { console.log("客:", (h.text ?? "").replace(/\s+/g, " ").slice(0, 70), "\n  → （文の返信なし）"); continue; }
    replied++;
    if (PICKUP_RE.test(reply)) pickup++;
    if (ESTIMATE_RE.test(reply)) estimate++;
    if (VIEWING_RE.test(reply)) viewing++;
    console.log("客:", (h.text ?? "").replace(/\s+/g, " ").slice(0, 70), "\n  → 実送信:", reply.replace(/\s+/g, " ").slice(0, 150));
  }
  console.log(`\n該当 ${hits.length}件・文の返信 ${replied}件 ／ 引き続きのご紹介 ${pickup} ／ 見積書 ${estimate} ／ 内覧の案内 ${viewing}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
