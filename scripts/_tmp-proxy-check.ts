// 代理契約のピッカーの本番確認（カイナの実場面・可能/不可）。AIX は生成だけ（送信しない）
// 実行: npx tsx --env-file=.env.local scripts/_tmp-proxy-check.ts
import { createClient } from "@supabase/supabase-js";

const BASE = "https://sumora-ai-ui.vercel.app";
const CONV = "8dbdb3a0-b6ee-46c6-8b0f-a0a5e1a5e2f4"; // 後で実際の会話 ID に置き換える
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

async function main() {
  const { data: conv } = await sb.from("conversations").select("id, customer_name").ilike("customer_name", "%🐈%").limit(1).maybeSingle();
  const convId = (conv?.id as string) ?? CONV;
  const name = (conv?.customer_name as string) ?? "カイナ";
  const { data: msgs } = await sb.from("messages").select("sender, text, created_at, is_aix_generated")
    .eq("conversation_id", convId).order("created_at", { ascending: true }).limit(400);
  // 11:48 の実送信の直前まで（お客様の「代理契約可能か聞いてみて欲しいです」までの状態を再現）
  const cut = Date.parse("2026-09-16T02:45:00Z");
  const recent = (msgs ?? []).filter((m) => Date.parse(m.created_at) < cut).slice(-20)
    .map((m) => ({ sender: m.sender, text: m.text || "", rawCreatedAt: m.created_at, isAix: m.is_aix_generated || false }));
  console.log(`会話: ${name} (${convId}) / 直近: ${JSON.stringify(recent.slice(-2).map((r) => `${r.sender}: ${(r.text || "").slice(0, 40)}`))}`);

  for (const result of ["可能", "不可"] as const) {
    for (let i = 1; i <= 2; i++) {
      const res = await fetch(`${BASE}/api/aix/action`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "property_check_result", check_pattern: "mgmt_proxy",
          proxy_result: result, property_name: "アーバンフラッツ心斎橋", conversation_match: true,
          customer_name: name, conversation_id: convId, recent_messages: recent,
        }),
      });
      const d = await res.json().catch(() => ({})) as { ok?: boolean; message_text?: string; error?: string };
      console.log(`\n===== ${result} #${i} =====\n${d.message_text ?? `失敗: ${d.error ?? res.status}`}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
