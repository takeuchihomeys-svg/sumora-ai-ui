// YUMA（テスト用会話）で「✂️ 画像トリミング → 確認してお客様に送る」を本番 API で通す（LLM は呼ばない）
// 手順: 既存のピックアップ行から PDF を借りて YUMA 宛の行を作る → /trim → /send → 結果を出す → テスト行を消す
// 実行: npx tsx --env-file=.env.local scripts/yuma-trim-send-test.ts [--base=https://sumora-ai-ui.vercel.app] [--keep=1]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const BASE = arg("base") ?? "https://sumora-ai-ui.vercel.app";
const KEEP = arg("keep") === "1";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const SECRET = (process.env.INTERNAL_API_SECRET ?? process.env.NEXT_PUBLIC_INTERNAL_API_SECRET ?? "").trim();

const INSERT_ONLY = arg("insert-only") === "1";   // 行だけ作って画面（売上サポ）から ✂️ と送信を押す用
const CLEANUP = arg("cleanup") === "1";           // YUMA_trim_test_* の行を消す

async function main() {
  if (CLEANUP) {
    const { data: del, error: dErr } = await sb.from("property_pickups").delete().like("batch_id", "YUMA_trim_test_%").select("id");
    console.log(dErr ? `消せない: ${dErr.message}` : `テスト行 ${(del ?? []).length}件を消した`);
    return;
  }
  if (!SECRET && !INSERT_ONLY) { console.log("INTERNAL_API_SECRET が無い（--insert-only=1 なら行だけ作れる）"); process.exit(1); }
  const { data: src } = await sb.from("property_pickups").select("property_name, room_no, summary_text, pdf_blob_url, rank, recommended").not("pdf_blob_url", "is", null).order("created_at", { ascending: false }).limit(2);
  const rows = (src ?? []) as Array<{ property_name: string; room_no: string | null; summary_text: string; pdf_blob_url: string; rank: number; recommended: number }>;
  if (rows.length === 0) { console.log("借りる PDF が無い"); process.exit(1); }
  const batchId = `YUMA_trim_test_${Date.now()}.pdf`;
  const ins = rows.map((r, i) => ({
    batch_id: batchId, property_customer_id: null, conversation_id: YUMA, customer_name: "YUMA", site: "realpro",
    rank: i + 1, property_name: r.property_name, room_no: r.room_no, summary_text: r.summary_text.replace(/^【\d+[^】]*】/u, `【${i + 1}${i === 0 ? "🌟★" : ""}】`),
    pdf_url: null, pdf_blob_url: r.pdf_blob_url, pdf_text: null, pdf_has_text: false, verdict: "pass", score: 80, reason_codes: [], reasons_ja: [],
    ad_yen: null, profit_yen: null, recommended: i === 0 ? 2 : 0, status: "pending",
  }));
  const { data: inserted, error } = await sb.from("property_pickups").insert(ins).select("id");
  if (error) { console.log("insert 失敗:", error.message); process.exit(1); }
  const ids = (inserted ?? []).map((r) => (r as { id: number }).id);
  console.log(`テスト行 ${ids.length}件を作成（batch=${batchId}）`);
  if (INSERT_ONLY) { console.log("売上サポ → ピックアップ → YUMA を開いて「✂️ 画像トリミング」→「確認してお客様に送る」。終わったら --cleanup=1"); return; }
  try {
    const t0 = Date.now();
    const trimRes = await fetch(`${BASE}/api/property-pickups/trim`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ item_ids: ids }) });
    const trimJson = await trimRes.json().catch(() => ({}));
    console.log(`/trim HTTP ${trimRes.status} ${Date.now() - t0}ms:`, JSON.stringify(trimJson).slice(0, 600));
    if (!trimRes.ok) return;
    const t1 = Date.now();
    const sendRes = await fetch(`${BASE}/api/property-pickups/send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ batch_id: batchId, item_ids: ids, action: "send", sent_by: "trim-test" }) });
    const sendJson = await sendRes.json().catch(() => ({}));
    console.log(`/send HTTP ${sendRes.status} ${Date.now() - t1}ms:`, JSON.stringify(sendJson).slice(0, 400));
    const { data: after } = await sb.from("property_pickups").select("id, status, trim_image_url, sent_at").in("id", ids);
    for (const r of after ?? []) console.log(`  id=${(r as { id: number }).id} status=${(r as { status: string }).status} trim=${(r as { trim_image_url: string | null }).trim_image_url}`);
    const { data: msgs } = await sb.from("messages").select("sender, text, image_url, created_at").eq("conversation_id", YUMA).order("created_at", { ascending: false }).limit(4);
    console.log("YUMA の直近メッセージ:");
    for (const m of msgs ?? []) console.log(`  ${String((m as { created_at: string }).created_at).slice(11, 19)} ${(m as { sender: string }).sender} ${String((m as { text: string }).text).replace(/\n/g, " ").slice(0, 60)} ${(m as { image_url: string | null }).image_url ? "[img]" : ""}`);
  } finally {
    if (!KEEP) {
      const { error: dErr } = await sb.from("property_pickups").delete().in("id", ids);
      console.log(dErr ? `テスト行を消せない: ${dErr.message}` : "テスト行を消した");
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
