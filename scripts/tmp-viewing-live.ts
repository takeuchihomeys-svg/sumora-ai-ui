// tmp(コミットしない): YUMA 内覧・管理会社・審査期間の実送信テスト用の道具
// 使い方: npx tsx --env-file=.env.local scripts/tmp-viewing-live.ts <cmd> [...]
//   snap                     … 始める前の YUMA を控える（scratchpad/viewing-live-snap.json）
//   inject "<text>"          … お客様役（localhost:3100 の /api/test/customer-sim）で発言を入れる
//   state                    … 直近の会話・ブレインの判断・下書き・AIX 提案・要対応・タスク・予約送信を出す
//   send "<text>" [aixType]  … 本文を YUMA に実送信（/api/send-line-message）→ messages 記録（+ aixType があれば log-aix-usage）
//   cleanup                  … 控えより後の YUMA の副作用を消して会話を戻す（実送信 messages は残す）
//   pcdiff                   … property_customers の条件が控えと同じか
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const YUMA_LINE = "U3d8d9e48f947d85f270da34a32413a67";
const SP = "C:/Users/竹内悠~1/AppData/Local/Temp/claude/c--Users-------sumora-ai-ui/90d5437f-9ec8-479d-94e9-1097dde86432/scratchpad";
const SNAP = `${SP}/viewing-live-snap.json`;
const LOCAL = "http://localhost:3000";
const PROD = "https://sumora-ai-ui.vercel.app";
const localSecret = () => readFileSync(`${SP}/.localsec`, "utf8").trim();
function prodSecret(): string {
  const e = (process.env.INTERNAL_API_SECRET ?? "").trim();
  if (e) return e;
  const l = readFileSync(".env.prod", "utf8").split(/\r?\n/).find((x) => x.startsWith("INTERNAL_API_SECRET=")) ?? "";
  return l.slice("INTERNAL_API_SECRET=".length).trim().replace(/^"(.*)"$/, "$1");
}
const JST = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(5, 19).replace("T", " ") : "-");
const one = (s: unknown, n = 400) => String(s ?? "").replace(/\n/g, "⏎").slice(0, n);
type R = Record<string, unknown>;
const TABLES: Array<[string, string]> = [
  ["knowledge_apply_log", "applied_at"], ["reply_mode_shadow_logs", "created_at"], ["closing_strategy_logs", "proposed_at"],
  ["brain_decision_logs", "created_at"], ["aix_action_items", "created_at"], ["line_tasks", "created_at"], ["aix_generate_log", "created_at"],
  ["scheduled_messages", "created_at"],
];

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === "snap") {
    if (existsSync(SNAP)) { console.log("控えは既にある（上書きしない）"); return; }
    const t0 = new Date().toISOString();
    const conv = (await sb.from("conversations").select("*").eq("id", Y).single()).data;
    const pc = (await sb.from("property_customers").select("*").eq("id", PC).single()).data;
    const msgs = (await sb.from("messages").select("id").eq("conversation_id", Y)).data;
    const pre: Record<string, unknown[]> = {};
    for (const [t] of TABLES) pre[t] = ((await sb.from(t).select("*").eq("conversation_id", Y)).data ?? []);
    writeFileSync(SNAP, JSON.stringify({ t0, conv, pc, msgIds: (msgs ?? []).map((m) => (m as R).id), pre }, null, 1));
    console.log("控えた", t0, "messages", msgs?.length, Object.fromEntries(Object.entries(pre).map(([k, v]) => [k, v.length])));
    return;
  }
  if (cmd === "inject") {
    const r = await fetch(`${LOCAL}/api/test/customer-sim`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${prodSecret()}` }, body: JSON.stringify({ conversation_id: Y, mode: "inject", text: a1.startsWith("@") ? readFileSync(a1.slice(1), "utf8").split(String.fromCharCode(13)).join("").trimEnd() : a1 }), signal: AbortSignal.timeout(280_000) });
    console.log(r.status, (await r.text()).slice(0, 400));
    return;
  }
  if (cmd === "state") {
    const since = a1 ?? new Date(Date.now() - 3 * 3600_000).toISOString();
    const c = (await sb.from("conversations").select("status,ai_draft,suggested_aix_meta,last_message,last_sender,draft_pending_at,draft_attempted_at,last_brain_meta,brain_analyzed_at").eq("id", Y).single()).data as R;
    console.log("status:", c.status, "| draft_pending:", c.draft_pending_at, "| attempted:", c.draft_attempted_at);
    console.log("ai_draft:", one(c.ai_draft, 1500));
    console.log("suggested_aix_meta:", JSON.stringify(c.suggested_aix_meta)?.slice(0, 1500));
    const ms = ((await sb.from("messages").select("sender,text,created_at,is_aix_generated,line_message_id").eq("conversation_id", Y).gte("created_at", since).order("created_at")).data ?? []) as R[];
    console.log("--- messages since", since);
    for (const m of ms) console.log(`[${JST(m.created_at as string)} ${m.sender}${m.is_aix_generated ? "/AIX" : ""}${String(m.line_message_id ?? "").startsWith("sim-") ? "/sim" : ""}] ${one(m.text, 700)}`);
    const bd = ((await sb.from("brain_decision_logs").select("*").eq("conversation_id", Y).gte("created_at", since).order("created_at", { ascending: false }).limit(2)).data ?? []) as R[];
    console.log("--- brain_decision_logs (新→古 2件)");
    for (const b of bd) console.log(JSON.stringify(b).slice(0, 2500));
    for (const [t, col] of [["aix_action_items", "created_at"], ["line_tasks", "created_at"], ["scheduled_messages", "created_at"], ["aix_generate_log", "created_at"]] as const) {
      const rows = ((await sb.from(t).select("*").eq("conversation_id", Y).gte(col, since).order(col)).data ?? []) as R[];
      console.log(`--- ${t}: ${rows.length}`);
      for (const r of rows) console.log("  ", JSON.stringify(r).slice(0, 500));
    }
    const llm = ((await sb.from("llm_usage_logs").select("action,model,created_at").eq("conversation_id", Y).gte("created_at", since).order("created_at")).data ?? []) as R[];
    console.log("--- llm_usage_logs", llm.map((l) => `${l.action}:${l.model}`).join(", "));
    return;
  }
  if (cmd === "send") {
    const text = a1.startsWith("@") ? readFileSync(a1.slice(1), "utf8").split(String.fromCharCode(13)).join("").trimEnd() : a1; const aix = a2 || null;
    if (text.length < 5) throw new Error("本文が短すぎる: " + text);
    const { data: conv } = await sb.from("conversations").select("id,line_user_id,account,customer_name,status").eq("id", Y).single();
    const c = conv as { line_user_id: string; account: string; customer_name: string; status: string };
    if (c.line_user_id !== YUMA_LINE || c.customer_name !== "YUMA") throw new Error("宛先が YUMA ではない");
    const AUTH = { "Content-Type": "application/json", Authorization: `Bearer ${prodSecret()}` };
    const res = await fetch(`${PROD}/api/send-line-message`, { method: "POST", headers: AUTH, body: JSON.stringify({ line_user_id: c.line_user_id, message: text.trim(), account: c.account ?? "sumora", conversation_id: Y, origin: aix ? "aix" : "manual" }) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; sentMessageIds?: string[]; error?: string };
    const at = new Date().toISOString();
    console.log("send", res.status, JSON.stringify(j).slice(0, 200));
    if (!res.ok) return;
    await sb.from("messages").insert({ conversation_id: Y, sender: "staff", text: text.trim(), created_at: at, is_aix_generated: !!aix, ...(j.sentMessageIds?.[0] ? { line_message_id: j.sentMessageIds[0] } : {}) });
    await sb.from("conversations").update({ last_message: text.trim(), last_sender: "staff", updated_at: at, ai_draft: null, suggested_aix_meta: null }).eq("id", Y);
    if (aix) {
      const l = await fetch(`${PROD}/api/log-aix-usage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: Y, aix_type: aix, conversation_status: c.status, line_message_id: j.sentMessageIds?.[0] ?? null, sent_at: at, scheduled: false, send_mode: null, generated_text: text, was_edited: false, check_pattern: process.env.CHECK_PATTERN ?? null }) });
      console.log("log-aix-usage", l.status);
    }
    return;
  }
  if (cmd === "cleanup") {
    const s = JSON.parse(readFileSync(SNAP, "utf8")) as { t0: string; conv: R; pre: Record<string, R[]> };
    const t0 = a1 ?? s.t0; const partial = !!a1;
    // knowledge used_count
    const { data: kal } = await sb.from("knowledge_apply_log").select("id, knowledge_id").eq("conversation_id", Y).gte("applied_at", t0);
    const kc = new Map<string, number>();
    for (const r of (kal ?? []) as Array<{ knowledge_id: string | null }>) if (r.knowledge_id) kc.set(r.knowledge_id, (kc.get(r.knowledge_id) ?? 0) + 1);
    for (const [id, n] of kc) {
      const { data: k } = await sb.from("ai_reply_knowledge").select("used_count").eq("id", id).maybeSingle();
      await sb.from("ai_reply_knowledge").update({ used_count: Math.max(0, Number((k as R | null)?.used_count ?? 0) - n) }).eq("id", id);
    }
    for (const [t, col] of TABLES) {
      const { count, error } = await sb.from(t).delete({ count: "exact" }).eq("conversation_id", Y).gte(col, t0);
      console.log(`  ${t.padEnd(24)} ${error ? "⚠ " + error.message : (count ?? 0) + "行消した"}`);
    }
    const sim = await sb.from("messages").delete({ count: "exact" }).eq("conversation_id", Y).like("line_message_id", "sim-%").gte("created_at", t0);
    console.log("  messages(sim=お客様役)   ", sim.error ? sim.error.message : `${sim.count}行消した`);
    if (partial) { await sb.from("conversations").update({ ai_draft: null, suggested_aix_meta: null, draft_pending_at: null, draft_attempted_at: null }).eq("id", Y); console.log("  (部分の片付け)"); return; }
    // 送ったスタッフ発言の後にお客様の発言が消えたので last_* は元へ戻さず、会話は控えの列だけ戻す（last_message 等は実送信を反映して残す）
    const { data: now } = await sb.from("conversations").select("*").eq("id", Y).single();
    const patch: R = {};
    const keep = new Set(["updated_at", "id", "last_message", "last_sender", "last_message_at", "last_staff_message_at"]);
    for (const [k, v] of Object.entries(now as R)) if (!keep.has(k) && JSON.stringify(v) !== JSON.stringify(s.conv[k])) patch[k] = s.conv[k] ?? null;
    if (Object.keys(patch).length) { const { error } = await sb.from("conversations").update(patch).eq("id", Y); console.log("  conversations 戻した列:", Object.keys(patch).join(","), error?.message ?? ""); }
    else console.log("  conversations 変わった列なし");
    return;
  }
  if (cmd === "pcdiff") {
    const s = JSON.parse(readFileSync(SNAP, "utf8")) as { pc: R };
    const { data: now } = await sb.from("property_customers").select("*").eq("id", PC).single();
    const diff = Object.keys(s.pc).filter((k) => JSON.stringify((now as R)[k]) !== JSON.stringify(s.pc[k]));
    console.log("property_customers 差分の列:", diff.join(",") || "なし");
    return;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
