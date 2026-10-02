// scripts/audit-check-result-name.ts
// 2026-10-02 ⑫ 11巡目: AIX【物件確認した（募集中）】の物件名が直近10通に出ているか（availableNameGrounded）を、本番で送った AIX の文に当てる。
//   根拠なしになる通＝出口が [物件名と号室] に戻す通。スタッフが送った名前が正しかったなら戻しは止めすぎ（目で読む）。読むだけ・LLM なし。
// 実行: npx tsx --env-file=.env.local scripts/audit-check-result-name.ts [--days=120]
import { createClient } from "@supabase/supabase-js";
import { availableNameGrounded } from "../app/lib/property-name-verbatim";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=120").slice(7));
type M = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null };
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data: hits } = await sb.from("messages").select("id, conversation_id, created_at").eq("sender", "staff").eq("is_aix_generated", true).gte("created_at", since).ilike("text", "%募集中となります%").limit(3000);
  let n = 0, un = 0;
  for (const h of (hits ?? []) as Array<{ id: string; conversation_id: string; created_at: string }>) {
    const { data } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url").eq("conversation_id", h.conversation_id).lte("created_at", h.created_at).order("created_at", { ascending: false }).limit(12);
    const rows = ((data ?? []) as M[]).reverse();
    const self = rows.find((r) => r.id === h.id); if (!self) continue;
    const before = rows.filter((r) => r.id !== h.id).slice(-10);
    const r = availableNameGrounded(self.text ?? "", before.map((x) => x.text ?? ""));
    if (!r.name) continue;
    n++;
    if (!r.grounded) { un++; const img = before.some((x) => x.image_url); console.log(`${h.conversation_id.slice(0, 8)} ${h.created_at.slice(0, 10)} 名前「${r.name}」 直近10通に無い${img ? "（画像あり＝画像から読んだ形）" : ""}`); }
  }
  console.log(`\n本番の AIX【物件確認した（募集中）】で名前のある通 ${n}・直近10通に名前が無い ${un}`);
})();
