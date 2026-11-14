// scripts/audit-scene-push-hearing-phone.ts — 読むだけ・LLM なし（2026-11-15 作業員H・統括役の頼み）
//   本番の見張り（line_watch_turns）の直近 N 日から、竹内さん本人の番で
//   ① ブレインの場面が AIX:application_push / AIX:condition_hearing / AIX:phone_call の番
//   ② 竹内さんの最初の一手が AIX【申込へ】【条件ヒアリング】【電話】の番
//   を全部出し、前後の会話（伏せ字・短く）を並べる。申込へ を押した後の番は外す（その押した番は残す）。
//   使い方: npx tsx --env-file=<.env.local> scripts/audit-scene-push-hearing-phone.ts [--days=14] [--ctx=6] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { readWatchTurns, readStaffMsgs, aixFamily } from "./lib/prod-yardstick-db";
import { staffFirstMove, aixLogsFromWatch } from "../app/lib/staff-first-move";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "14")), CTX = Number(arg("ctx", "6")), OUT = arg("out", "");
const TARGET = new Set(["application_push", "condition_hearing", "phone_call"]);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

/** 伏せ字（電話・メール・郵便番号・長い数字） */
export function maskText(s: string): string {
  return s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "＜メール＞").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "＜番号＞").replace(/\d{3}-\d{4}/g, "＜郵便＞").replace(/\d{7,}/g, "＜数字＞");
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const turns = await readWatchTurns(sb, since);
  const convs = [...new Set(turns.map((w) => w.conversation_id))];
  const msgs = await readStaffMsgs(sb, convs, since);
  // 申込へ を押した時刻（会話ごとの最初）
  const pushAt = new Map<string, number>();
  for (let i = 0; i < convs.length; i += 100) {
    const { data } = await sb.from("aix_usage_logs").select("conversation_id, created_at, aix_type").in("conversation_id", convs.slice(i, i + 100)).eq("aix_type", "application_push").order("created_at", { ascending: true });
    for (const r of (data ?? []) as Array<{ conversation_id: string; created_at: string }>) if (!pushAt.has(r.conversation_id)) pushAt.set(r.conversation_id, Date.parse(r.created_at));
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const w of turns) {
    const tAt = Date.parse(w.customer_turn_at);
    const fm = staffFirstMove(tAt, msgs.get(w.conversation_id) ?? [], aixLogsFromWatch(w.staff_aix));
    const brain = w.brain_action ?? "";
    const staffAix = fm?.kind === "aix" ? fm.aix ?? "" : "";
    const hitScene = TARGET.has(brain) || TARGET.has(staffAix);
    if (!hitScene) continue;
    const pa = pushAt.get(w.conversation_id);
    const afterPush = pa != null && pa < tAt - 60_000;
    rows.push({ id: w.id, conv: w.conversation_id.slice(0, 8), conversation_id: w.conversation_id, at: w.customer_turn_at, scene: w.scene_key, brain, staff: fm ? (fm.kind === "aix" ? `AIX:${staffAix}` : "返信") : "なし", writer: fm?.writer ?? "unknown", min: fm ? Math.round((fm.at - tAt) / 60_000) : null, family_hit: fm ? aixFamily(brain) === aixFamily(fm.kind === "aix" ? fm.aix : null) : null, verdict: w.verdict, decision_id: w.decision_id, afterPush, staff_aix_all: (w.staff_aix ?? []).map((a) => a.aix_type) });
  }
  // 前後の会話（伏せ字・各通 160 字まで）
  for (const r of rows) {
    const tAt = Date.parse(String(r.at));
    const { data: before } = await sb.from("messages").select("sender, created_at, text, staff_writer, image_url, is_aix_generated").eq("conversation_id", r.conversation_id as string).lte("created_at", new Date(tAt + 1000).toISOString()).order("created_at", { ascending: false }).limit(CTX);
    const { data: after } = await sb.from("messages").select("sender, created_at, text, staff_writer, image_url, is_aix_generated").eq("conversation_id", r.conversation_id as string).gt("created_at", new Date(tAt + 1000).toISOString()).order("created_at", { ascending: true }).limit(3);
    const fmt = (m: Record<string, unknown>) => `${String(m.created_at).slice(5, 16)} ${m.sender === "customer" ? "客" : `店(${m.staff_writer ?? "?"}${m.is_aix_generated ? "・AIX" : ""})`}: ${maskText(String(m.text ?? (m.image_url ? "［画像］" : ""))).replace(/\s+/g, " ").slice(0, 220)}`;
    r.ctx_before = ((before ?? []) as Array<Record<string, unknown>>).reverse().map(fmt);
    r.ctx_after = ((after ?? []) as Array<Record<string, unknown>>).map(fmt);
    if (r.decision_id) {
      const { data: d } = await sb.from("brain_decision_logs").select("*").eq("id", r.decision_id as string).maybeSingle();
      if (d) { const x = d as Record<string, unknown>; r.decision = Object.fromEntries(Object.entries(x).filter(([k, v]) => v != null && !/embedding|prompt_text|raw/.test(k)).map(([k, v]) => [k, typeof v === "string" ? maskText(v).slice(0, 600) : JSON.stringify(v).slice(0, 600)])); }
    }
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(rows, null, 1));
  for (const r of rows) console.log(`#${r.id} ${r.conv} ${String(r.at).slice(5, 16)} 場面=${r.scene} ブレイン=${r.brain} 竹内側=${r.staff}(${r.writer}・${r.min}分) 系統一致=${r.family_hit} 申込後=${r.afterPush}`);
  console.log(`計 ${rows.length} 番`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
