// tmp(コミットしない・2026-10-01 2(b)): AIX【物件ピックアップ】（複数）の直後の2通目を、YUMA の材料で送らずに生成だけ回す
//   事前に YUMA の送った行の sent_at を今にしておく（呼び出し側 SQL）→ 終わったら戻す
// 実行: SIM_BASE=http://localhost:3200 npx tsx --env-file=.env.local scripts/tmp-pickup-second-gen.ts --n=3
import { createClient } from "@supabase/supabase-js";
import { findAiPhrases } from "../app/lib/second-message-style";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.SIM_BASE ?? "http://localhost:3200";
const N = Number(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? "3");
async function main() {
  const { data: conv } = await sb.from("conversations").select("customer_name, status").eq("id", Y).single();
  const c = conv as { customer_name: string; status: string };
  const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(15);
  const recent = ((ms ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated }));
  const first = "YUMAさん\n\n北区・福島区からYUMAさんにオススメできるお部屋ピックアップさせて頂きました😊！！\n\nお手隙の際にご査収ください😌！！";
  const now = new Date().toISOString();
  const recent2 = [...recent, { sender: "staff", text: "[画像]", rawCreatedAt: now, isAix: true }, { sender: "staff", text: "[画像]", rawCreatedAt: now, isAix: true }, { sender: "staff", text: "[画像]", rawCreatedAt: now, isAix: true }, { sender: "staff", text: first, rawCreatedAt: now, isAix: true }].slice(-15);
  for (let i = 0; i < N; i++) {
    const r = await fetch(`${BASE}/api/aix-template-generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      actionType: "property_send", actionCategory: "物件ピックアップした【AIX】", conversationId: Y, customerName: c.customer_name ?? "YUMA", conversationState: c.status,
      recentMessages: recent2, customerConditions: null, noEmoji: false, pendingScheduledMessages: [], staffMessagedToday: true, pickupType: null, lastAixCheckPattern: null, sentMessage: first,
    }), signal: AbortSignal.timeout(150_000) });
    const j = await r.json().catch(() => ({})) as { text?: string; error?: string };
    console.log(`\n[pickup-${i + 1}] 2通目${j.error ? ` ERROR:${j.error}` : ""}\n${j.text ?? ""}\n   → ${findAiPhrases(j.text ?? "").map((h) => h.key).join(",") || "AI語なし"}・${(j.text ?? "").length}字`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
