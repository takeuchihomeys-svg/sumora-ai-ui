// tmp: YUMA にスタッフとして1通送る（画面の送信と同じ記録）。--draft＝今の下書き／--text=… 固定文
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { draftToSendableText } from "../app/lib/draft-text";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const BASE = process.env.SIM_BASE ?? "https://sumora-ai-ui.vercel.app";
const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
function secret(): string {
  const e = (process.env.INTERNAL_API_SECRET ?? "").trim();
  if (e) return e;
  const l = readFileSync(".env.prod", "utf8").split(/\r?\n/).find((x) => x.startsWith("INTERNAL_API_SECRET=")) ?? "";
  return l.slice("INTERNAL_API_SECRET=".length).trim().replace(/^"(.*)"$/, "$1");
}
async function main() {
  const { data: c } = await sb.from("conversations").select("line_user_id, account, ai_draft").eq("id", Y).single();
  const useDraft = args.includes("--draft");
  const text = useDraft ? draftToSendableText(c?.ai_draft ?? null) : arg("text");
  if (!text) { console.log("送る文なし"); return; }
  const dbOnly = args.includes("--db-only");
  const res = dbOnly ? new Response(JSON.stringify({ sentMessageIds: [] }), { status: 200 }) : await fetch(`${BASE}/api/send-line-message`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret()}` },
    body: JSON.stringify({ line_user_id: c?.line_user_id, message: text, account: c?.account ?? "sumora", conversation_id: Y, origin: "manual" }),
  });
  const j = (await res.json().catch(() => ({}))) as { sentMessageIds?: string[]; error?: string };
  if (!res.ok) { console.log("送信失敗", res.status, j.error); return; }
  const now = new Date().toISOString();
  const lineMessageId = j.sentMessageIds?.[0] ?? null;
  await sb.from("messages").insert({ conversation_id: Y, sender: "staff", text, created_at: now, is_aix_generated: false, ...(lineMessageId ? { line_message_id: lineMessageId } : {}) });
  if (useDraft) {
    const cutoff = new Date(Date.now() - 3600_000).toISOString();
    const { data: bl } = await sb.from("brain_decision_logs").select("id").eq("conversation_id", Y).is("outcome", null).gt("created_at", cutoff).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (bl?.id) await sb.from("brain_decision_logs").update({ outcome: "draft_followed", outcome_recorded_at: now }).eq("id", bl.id);
  }
  await sb.from("conversations").update({ last_message: text, last_sender: "staff", updated_at: now, ai_draft: null, suggested_aix_meta: null, draft_attempted_at: null, draft_pending_at: null }).eq("id", Y);
  console.log("送った:", text.replace(/\n/g, " ⏎ ").slice(0, 200));
}
main().catch((e) => { console.error(e); process.exit(1); });
