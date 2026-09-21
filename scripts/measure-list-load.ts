// 一覧の読み込みの重さを、画面と同じ接続（公開キー）で測る（読み取りのみ）
// 2026-09-21 竹内「読み込み中が重い原因はなにかな？」
// 実行: npx tsx --env-file=.env.local scripts/measure-list-load.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
// app/page.tsx の CONVERSATION_LIST_COLUMNS と同じ
const COLS = "id,customer_name,status,line_user_id,last_message,last_sender,profile_image_url,updated_at,created_at,account,property_customer_id,is_post_apply,is_hot,is_flagged,ai_draft,draft_pending_at,has_viewed,auto_send_enabled,auto_sent_at,auto_sent_draft,success_pattern_at,loss_analyzed_at,draft_attempted_at,line_status,suggested_next_aix,draft_fail_count,draft_last_error,reply_mode_decision,suggested_aix_meta,brain_analyzed_at,learned_at,brain_full_analyzed_at,brain_full_msg_count,brain_deep_analyzed_at,brain_deep_msg_count,acquisition_source,applying_text_received,applying_image_received,screening_last_status,status_manual_back_at,auto_send_enabled_at,line_source_type,send_blocked_reason";

async function measure(label: string, cols: string) {
  const t0 = Date.now();
  const { data, error } = await sb.from("conversations").select(cols).order("updated_at", { ascending: false }).limit(1000);
  const ms = Date.now() - t0;
  if (error) { console.log(`${label}: ⚠ ${error.message}`); return; }
  const bytes = Buffer.byteLength(JSON.stringify(data ?? []), "utf8");
  console.log(`${label.padEnd(16)} ${String((data ?? []).length).padStart(4)}件  ${(bytes / 1024 / 1024).toFixed(2)} MB  ${ms} ms`);
}

async function main() {
  await measure("旧 select(*)", "*");
  await measure("新 列を指定", COLS);
  const t0 = Date.now();
  const since = new Date(Date.now() - 90 * 86400_000).toISOString();
  const { data } = await sb.from("messages").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(5000);
  console.log(`${"メッセージ5000".padEnd(16)} ${String((data ?? []).length).padStart(4)}件  ${(Buffer.byteLength(JSON.stringify(data ?? []), "utf8") / 1024 / 1024).toFixed(2)} MB  ${Date.now() - t0} ms`);
}
main().catch((e) => { console.error(e); process.exit(1); });
