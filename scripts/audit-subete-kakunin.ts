// 「お気に召されたお部屋〇〇か全て確認させて頂きます」（property-send-match の固定文）が実送信・下書きで何回か（読み取りのみ）
// 2026-09-22 竹内「③約束している場面」の分析で、AI だけが書いてスタッフが消す約束の上位に出た
// 実行: npx tsx --env-file=.env.local scripts/audit-subete-kakunin.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const RE = /お気に召された(?:お部屋|物件)[^\n]{0,40}全て確認させて/;

async function main() {
  let sent = 0, sentAix = 0, sentMsgs = 0;
  for (let p = 0; p < 40; p++) {
    const { data } = await sb.from("messages").select("text, is_aix_generated").eq("sender", "staff").ilike("text", "%全て確認させて%").range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as Array<{ text: string | null; is_aix_generated: boolean | null }>;
    sentMsgs += r.length;
    for (const x of r) if (RE.test(x.text ?? "")) { sent++; if (x.is_aix_generated) sentAix++; }
    if (r.length < 1000) break;
  }
  const ex: Array<{ ai_draft: string | null; sent_reply: string | null }> = [];
  for (let p = 0; p < 10; p++) {
    const { data } = await sb.from("ai_reply_examples").select("ai_draft, sent_reply").ilike("ai_draft", "%全て確認させて%").range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof ex; ex.push(...r); if (r.length < 1000) break;
  }
  const inDraft = ex.filter((x) => RE.test(x.ai_draft ?? ""));
  const kept = inDraft.filter((x) => RE.test(x.sent_reply ?? ""));
  console.log(`実送信（全期間）: 「全て確認させて」を含む ${sentMsgs}通 ／ 固定文の形 ${sent}通（うち AIX ${sentAix}通）`);
  console.log(`AI 下書き: 固定文の形 ${inDraft.length}件 → そのまま実送信に残った ${kept.length}件`);
}
main().catch((e) => { console.error(e); process.exit(1); });
