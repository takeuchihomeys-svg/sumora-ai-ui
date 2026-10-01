// tmp: 本番 /api/aix/action で AIX の文を作るだけ（送らない）。usage: tmp-viewing-aixgen.ts <action> '<extra json>'
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
async function main() {
  const [action, extraJson] = process.argv.slice(2);
  const extra = extraJson ? JSON.parse(extraJson) : {};
  const { data: c } = await sb.from("conversations").select("account,customer_name,status,line_user_id").eq("id", Y).single();
  const cc = c as { account: string; customer_name: string; status: string; line_user_id: string };
  if (cc.customer_name !== "YUMA" || cc.line_user_id !== "U3d8d9e48f947d85f270da34a32413a67") throw new Error("not YUMA");
  const { data: ms } = await sb.from("messages").select("sender,text,image_url,created_at,is_aix_generated").eq("conversation_id", Y).order("created_at", { ascending: false }).limit(25);
  const recent = ((ms ?? []) as Array<Record<string, unknown>>).reverse().map((m) => ({ sender: String(m.sender), text: String(m.text ?? ""), imageUrl: (m.image_url as string | null) ?? undefined, createdAt: String(m.created_at), rawCreatedAt: String(m.created_at), isAix: !!m.is_aix_generated }));
  const body = { action, account: cc.account ?? "sumora", conversation_id: Y, customer_name: "YUMA", recent_messages: recent, conversation_status: cc.status, ...extra };
  const r = await fetch("https://sumora-ai-ui.vercel.app/api/aix/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  console.log(r.status, JSON.stringify({ text: j.message_text, notice: j.notice, send_hold: j.send_hold, error: j.error }, null, 1));
}
main();
