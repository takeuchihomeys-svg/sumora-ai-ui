// scripts/measure-list-load.ts — 会話一覧（AIX LINX の画面）を開いた時・30秒ごとの読み直しで読む量を、本番のデータで測る（anon キー・読み取りのみ）
// 実行: npx tsx --env-file=.env.local scripts/measure-list-load.ts
// 2026-10-06 ⑫ 竹内「AIXツールひらくとき重すぎる…今全部見ている気がする」。旧（全件＋メッセージ丸ごと）と新（conversation-list-sync）を並べる
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const COLS = "id,customer_name,status,line_user_id,last_message,last_sender,profile_image_url,updated_at,created_at,account,property_customer_id,is_post_apply,is_hot,is_flagged,ai_draft,draft_pending_at,has_viewed,auto_send_enabled,auto_sent_at,auto_sent_draft,success_pattern_at,loss_analyzed_at,draft_attempted_at,line_status,suggested_next_aix,draft_fail_count,draft_last_error,reply_mode_decision,suggested_aix_meta,brain_analyzed_at,learned_at,brain_full_analyzed_at,brain_full_msg_count,brain_deep_analyzed_at,brain_deep_msg_count,acquisition_source,applying_text_received,applying_image_received,screening_last_status,status_manual_back_at,auto_send_enabled_at,line_source_type,send_blocked_reason,call_tapped_at";
const PC = "id,customer_name,status,last_property_sent_at,property_viewed_at,desired_area,floor_plan,rent_min,rent_max,move_in_time,preferences,ng_points,walk_minutes,other_requests,building_age,initial_cost_limit,additional_conditions,ai_summary,floor_area_min,floor_area_max,pet,rp_update_days";
type R = { name: string; kb: number; ms: number; rows: number };
async function m(name: string, f: () => PromiseLike<{ data: unknown }>): Promise<R & { data: unknown }> {
  const t = Date.now(); const r = await f(); const ms = Date.now() - t;
  const kb = Buffer.byteLength(JSON.stringify(r.data ?? null)) / 1024;
  return { name, kb, ms, rows: Array.isArray(r.data) ? r.data.length : 0, data: r.data };
}
const show = (title: string, rs: R[]) => {
  console.log(`\n== ${title}: 合計 ${rs.reduce((a, r) => a + r.kb, 0).toFixed(0)}KB・${rs.reduce((a, r) => a + r.ms, 0)}ms（順に読んだ場合）`);
  for (const r of rs) console.log(`   ${r.name.padEnd(40)} ${String(r.rows).padStart(5)}行 ${r.kb.toFixed(0).padStart(5)}KB ${r.ms}ms`);
};
(async () => {
  const first = await m("最初の40件（一覧を出す）", () => sb.from("conversations").select(COLS).order("updated_at", { ascending: false }).limit(40));
  const all = await m("会話 全件", () => sb.from("conversations").select(COLS).order("updated_at", { ascending: false }).limit(1000));
  const since = new Date(Date.now() - 90 * 86400_000).toISOString();
  const msgs = await m("メッセージ 90日（max_rows で1000行）", () => sb.from("messages").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(5000));
  const ids = [...new Set(((all.data ?? []) as Array<{ property_customer_id?: string }>).map((c) => c.property_customer_id).filter(Boolean))] as string[];
  const pcs = await m("物件顧客（紐付けの全員）", () => sb.from("property_customers").select(PC).in("id", ids));
  const lc = await m("お客様の最後の発言の時刻（集計）", () => sb.rpc("conversation_last_customer_at"));
  const delta = await m("差分（更新時刻が直近90秒の行）", () => sb.from("conversations").select(COLS).gte("updated_at", new Date(Date.now() - 90_000).toISOString()).limit(200));
  show("旧: 開いた時（最初の40件の後に続けて読む物）", [first, all, msgs, pcs]);
  show("新: 開いた時", [first, all, lc, pcs]);
  const oldPerMin = (all.kb + msgs.kb + pcs.kb) * 2;
  const newPerMin = delta.kb * 2 + (all.kb + lc.kb) / 5;
  console.log(`\n== 読み直し（毎分）: 旧 ${oldPerMin.toFixed(0)}KB（30秒ごとに丸ごと×2・丸ごとの読み直し 2回/分）→ 新 ${newPerMin.toFixed(0)}KB（差分×2＋5分ごとの丸ごと・丸ごと 0.2回/分）`);
})();
