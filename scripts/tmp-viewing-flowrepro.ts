import { createClient } from "@supabase/supabase-js";
import { resolveViewingFlow } from "../app/lib/viewing-flow";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
async function main() {
  const { data } = await sb.from("messages").select("sender,text,created_at").eq("conversation_id", Y).gte("created_at", "2026-09-30T11:26:00Z").order("created_at");
  const msgs = (data ?? []).map((m) => ({ sender: m.sender as string, text: m.text as string, createdAt: m.created_at as string }));
  const meetAt = msgs.find((m) => m.text.includes("現地エントランスお待ち合わせ"))!.createdAt;
  const inviteAts = msgs.filter((m) => m.sender === "staff" && m.text.includes("ご案内可能")).map((m) => m.createdAt);
  for (let n = msgs.length - 3; n <= msgs.length; n++) {
    const f = resolveViewingFlow({ messages: msgs.slice(0, n) as never, inviteAts, meetings: [{ at: meetAt, dateMD: "10/2", time: "14:00" }], nowMs: Date.now() });
    console.log(n, msgs[n - 1].sender, msgs[n - 1].text.slice(0, 30), "=>", f.stage, f.reason, f.currentReply, f.lastReply);
  }
}
main();
