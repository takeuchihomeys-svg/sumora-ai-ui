// 初回ガードで空になった件の前後に、別の分析（incremental 等）が AIX を出していたかを見る（読み取りのみ）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const CONVS = ["ad97cd40", "35280559", "fbffca3d", "ae18c038", "58ae93f3", "de8017ef", "56c4f0b0", "cf2963d4", "f193d13d", "d46290ff", "8590144d", "a144d73e"];
async function main() {
  const { data } = await sb.from("brain_decision_logs")
    .select("conversation_id, created_at, suggested_action, analysis_mode, decision_source, conversation_status, analyzed_msg_ts")
    .gte("created_at", "2026-09-12").order("created_at");
  for (const p of CONVS) {
    const rows = (data ?? []).filter((r) => (r.conversation_id as string).startsWith(p)).slice(0, 8);
    console.log(`\n${p}`);
    for (const r of rows) console.log(`   ${String(r.created_at).slice(5, 16)} act=${(r.suggested_action ?? "-").padEnd(24)} mode=${String(r.analysis_mode ?? "-").padEnd(12)} src=${String(r.decision_source ?? "-").padEnd(22)} status=${r.conversation_status} msg_ts=${String(r.analyzed_msg_ts ?? "-").slice(5, 16)}`);
  }
  // 初回ガードの件数（09-12以降・全 status）
  const guard = (data ?? []).filter((r) => r.decision_source === "guard:first_contact");
  const byStatus = new Map<string, number>();
  for (const r of guard) byStatus.set(String(r.conversation_status), (byStatus.get(String(r.conversation_status)) ?? 0) + 1);
  console.log(`\nguard:first_contact 全体 ${guard.length}件（09-12以降）`, [...byStatus]);
}
main().catch((e) => { console.error(e); process.exit(1); });
