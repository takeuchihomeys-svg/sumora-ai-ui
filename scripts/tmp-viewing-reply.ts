// tmp: 手元サーバー(:3000)の /api/generate-reply で YUMA の今の会話の返信下書きを作る（page.tsx generateReply と同じ組み立て・送らない）
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const MSG_SEP = "\n⁣\n";
async function main() {
  const t0 = new Date().toISOString();
  const { data: conv } = await sb.from("conversations").select("customer_name, status, has_viewed").eq("id", Y).single();
  const { data: ms } = await sb.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(60);
  const all = ((ms ?? []) as Array<Record<string, unknown>>).reverse();
  const lastStaffIdx = all.map((m, i) => (m.sender === "staff" ? i : -1)).filter((i) => i >= 0).at(-1);
  const after = lastStaffIdx !== undefined ? all.slice(lastStaffIdx + 1) : all;
  const unreplied = after.filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]").slice(-10).map((m) => String(m.text));
  const lastCust = [...all].reverse().find((m) => m.sender === "customer");
  const message = unreplied.length ? unreplied.join(MSG_SEP) : String(lastCust?.text ?? "");
  const c = conv as Record<string, unknown>;
  const body = { message, customerMessages: unreplied.length ? unreplied : [message], state: String(c.status ?? "proposing"), conversationId: Y, customerName: String(c.customer_name), hasViewed: !!c.has_viewed, activeTaskTypes: [] as string[],
    recentMessages: all.slice(-25).map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), isAix: !!m.is_aix_generated })) };
  const res = await fetch("http://localhost:3000/api/generate-reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(280_000) });
  const raw = await res.text();
  const nl = raw.indexOf("\n");
  let meta: Record<string, unknown> | null = null; let text = raw;
  if (nl >= 0) { try { meta = JSON.parse(raw.slice(0, nl)); text = raw.slice(nl + 1); } catch { meta = null; } }
  const aixM = text.match(/<<<SUGGESTED_AIX:([\s\S]*?)>>>/);
  const visible = text.replace(/\n?<<<[A-Z_]{3,}:[\s\S]*?(?:>>>|$)/g, "").trim();
  console.log("HTTP", res.status, "meta", JSON.stringify(meta)?.slice(0, 200), "AIX", aixM?.[1]?.slice(0, 200) ?? "-");
  console.log("=== 下書き全文 ===\n" + visible + "\n=== ここまで ===");
  await new Promise((r) => setTimeout(r, 4000));
  const { data: llm } = await sb.from("llm_usage_logs").select("action,model").eq("conversation_id", Y).gte("created_at", t0);
  console.log("llm:", (llm ?? []).map((l) => `${(l as Record<string, string>).action}:${(l as Record<string, string>).model}`).join(", "));
}
main();
