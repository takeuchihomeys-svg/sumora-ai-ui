// scripts/yuma-replay-cleanup.ts — YUMA の再生テスト（scripts/yuma-replay-scenarios.ts）が残した物を消す（YUMA＝竹内さん本人のテスト用の会話だけ）
//   ①場面の通（messages.line_message_id="replay-…"・中断した時の片付け）
//   ② --logs-since=<ISO>: その時刻より後に再生が作った YUMA の生成の控え（aix_generate_log の 物件確認した／内覧調整／申込へ／確認します・
//      jev_shadow_logs のうち見積書以外）。見積書の物は別の担当（見積書ツール）の試験の物なので残す
//   --dry で数えるだけ
// 実行: npx tsx --env-file=.env.local scripts/yuma-replay-cleanup.ts [--dry] [--logs-since=2026-10-01T10:15:00Z]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DRY = process.argv.includes("--dry");
const SINCE = process.argv.find((a) => a.startsWith("--logs-since="))?.slice(13) ?? "";
async function del(table: string, ids: string[]) {
  console.log(`${table}: ${ids.length}`);
  if (DRY) return;
  for (let i = 0; i < ids.length; i += 200) {
    const r = await sb.from(table).delete().in("id", ids.slice(i, i + 200)).eq("conversation_id", YUMA);
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
  }
}
async function main() {
  const { data, error } = await sb.from("messages").select("id").eq("conversation_id", YUMA).like("line_message_id", "replay-%");
  if (error) throw new Error(error.message);
  await del("messages", ((data ?? []) as Array<{ id: string }>).map((r) => r.id));
  if (SINCE && Number.isFinite(Date.parse(SINCE))) {
    const g = await sb.from("aix_generate_log").select("id").eq("conversation_id", YUMA).gte("created_at", SINCE)
      .in("action_type", ["property_check_result", "viewing_invite", "application_push", "acknowledge_check"]);
    if (g.error) throw new Error(g.error.message);
    await del("aix_generate_log", ((g.data ?? []) as Array<{ id: string }>).map((r) => r.id));
    const j = await sb.from("jev_shadow_logs").select("id, brain_action").eq("conversation_id", YUMA).gte("created_at", SINCE);
    if (j.error) throw new Error(j.error.message);
    await del("jev_shadow_logs", ((j.data ?? []) as Array<{ id: string; brain_action: string | null }>).filter((r) => r.brain_action !== "estimate_sheet").map((r) => r.id));
  }
  console.log(DRY ? "（数えただけ）" : "消しました");
}
main().catch((e) => { console.error(e); process.exit(1); });
