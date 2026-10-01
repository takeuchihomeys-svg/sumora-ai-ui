// tmp: YUMA 条件の入口テスト 1場面（お客様の文を入れて、条件・履歴・ブレイン・下書き・Jev・副作用を読む）
// 使い方: SCENE_LOG=<記録> npx tsx --env-file=.env.local scripts/tmp-yuma-cond-scene.ts --label=S1 --file=<本文ファイル> [--wait=240]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";
import { customerConditionItems, conditionHeadlineLines } from "../app/lib/customer-condition-view";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7", PC = "509cd061-60cc-49a9-8c5a-4f356c4a5f88";
const BASE = process.env.SIM_BASE ?? "https://sumora-ai-ui.vercel.app";
const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const LABEL = arg("label") ?? "S";
const WAIT = Number(arg("wait") ?? 240) * 1000;
const OUT = process.env.SCENE_LOG ?? "";
const COND = ["rent_min", "rent_max", "desired_area", "area_mode", "walk_minutes", "floor_plan", "floor_area_min", "building_age", "initial_cost_limit", "move_in_time", "pet", "commute_station", "commute_minutes", "structure_types", "preferences", "ng_points", "other_requests", "additional_conditions", "exclusion_areas", "town_names", "raw_format_text", "format_received"];
function secret(): string {
  const e = (process.env.INTERNAL_API_SECRET ?? "").trim();
  if (e) return e;
  const l = readFileSync(".env.prod", "utf8").split(/\r?\n/).find((x) => x.startsWith("INTERNAL_API_SECRET=")) ?? "";
  return l.slice("INTERNAL_API_SECRET=".length).trim().replace(/^"(.*)"$/, "$1");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => { console.log(s); if (OUT) appendFileSync(OUT, s + "\n"); };
/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
  const sinceArg = arg("since");
  const text = sinceArg ? "(再読: 入れない)" : readFileSync(arg("file") ?? "", "utf8").trim();
  const { data: before } = await sb.from("property_customers").select("*").eq("id", PC).single();
  const t0 = sinceArg ? new Date(sinceArg) : new Date();
  const res = sinceArg ? new Response("{}", { status: 200 }) : await fetch(`${BASE}/api/test/customer-sim`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret()}` },
    body: JSON.stringify({ conversation_id: Y, mode: "inject", text }), signal: AbortSignal.timeout(300_000),
  });
  const j = await res.json().catch(() => ({}));
  log(`\n==================== ${LABEL} (${t0.toISOString()}) ====================\n客: ${text.replace(/\n/g, " ⏎ ").slice(0, 300)}\ninject: HTTP ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
  if (!res.ok) return;
  // 手元の入口の直接起動は 3 秒で切れて cron 待ち（約7分）になる → 本番の bg-async を webhook と同じ形で起こす
  if (!sinceArg) {
    await sleep(4000);
    const r2 = await fetch(`${process.env.BG_BASE ?? "https://sumora-ai-ui.vercel.app"}/api/generate-draft-bg-async`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: Y, source: "direct" }), signal: AbortSignal.timeout(30000) }).catch((e) => ({ status: String(e) }));
    log(`bg-async: ${(r2 as { status: unknown }).status}`);
  }
  const since = t0.getTime() - 2000;
  let meta: any = null;
  let c: any = null;
  const start = Date.now();
  while (Date.now() - start < WAIT) {
    ({ data: c } = await sb.from("conversations").select("suggested_aix_meta, ai_draft, draft_pending_at, status").eq("id", Y).single());
    const m = c?.suggested_aix_meta;
    const at = m?.analyzed_msg_ts ? Date.parse(m.analyzed_msg_ts) : NaN;
    if (m && at >= since) meta = m;
    if (!meta) {
      const { data: bl } = await sb.from("brain_decision_logs").select("*").eq("conversation_id", Y).gte("analyzed_msg_ts", new Date(since).toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (bl) meta = { _from: "logs", action: bl.suggested_action, reply_mode: bl.suggested_reply_mode, check_pattern: bl.suggested_check_pattern };
    }
    if (meta && !c?.draft_pending_at) break;
    await sleep(6000);
  }
  await sleep(20000); // 条件の読み取り（after）・下書きを待つ
  ({ data: c } = await sb.from("conversations").select("suggested_aix_meta, ai_draft, draft_pending_at, status").eq("id", Y).single());
  if (c?.suggested_aix_meta?.analyzed_msg_ts && Date.parse(c.suggested_aix_meta.analyzed_msg_ts) >= since) meta = c.suggested_aix_meta;
  const draft: string | null = typeof c?.ai_draft === "string" ? c.ai_draft : c?.ai_draft ? JSON.stringify(c.ai_draft) : null;
  log(`待ち: ${Math.round((Date.now() - start) / 1000)}s status=${c?.status} draft_pending=${c?.draft_pending_at ?? "-"}`);
  const m = meta ?? {};
  const pick = (k: string) => (m[k] !== undefined && m[k] !== null ? `${k}=${typeof m[k] === "string" ? m[k] : JSON.stringify(m[k])}` : null);
  log(`ブレイン: ${["action", "reply_mode", "check_pattern", "picker", "condition_change_scope", "condition_change_type", "checkpoint_stage", "send_mode", "reason", "reasoning"].map(pick).filter(Boolean).join(" | ").slice(0, 900) || "(判断なし)"}`);
  if (meta) log(`  meta keys: ${Object.keys(m).join(",")}`);
  log(`下書き: ${(draft ?? "(なし)").replace(/\n/g, " ⏎ ").slice(0, 600)}`);
  const bad = ["お待たせ致しました", "お待たせいたしました", "お待たせしました"].filter((w) => (draft ?? "").includes(w));
  const metaLike = /(ブレイン|AIX|下書き|【メモ】|TODO|スタッフ向け|※確認)/.test((draft ?? "").replace("[AIX誘導中]", ""));
  if (bad.length || metaLike) log(`  ⚠ 下書きの禁止語/作業メモ候補: ${bad.join(",")} ${metaLike ? "meta-like" : ""}`);
  const { data: after } = await sb.from("property_customers").select("*").eq("id", PC).single();
  const diffs = COND.filter((k) => JSON.stringify((before as any)[k]) !== JSON.stringify((after as any)[k]));
  log(`条件の変化: ${diffs.length ? diffs.map((k) => `${k}: ${JSON.stringify((before as any)[k])} → ${JSON.stringify((after as any)[k])}`).join(" / ") : "なし"}`);
  const { data: hist } = await sb.from("property_condition_history").select("changed_field, old_value, new_value, source_message_id, created_at").eq("property_customer_id", PC).gte("created_at", t0.toISOString()).order("created_at");
  for (const h of (hist ?? []) as any[]) log(`  履歴: ${h.changed_field}: ${String(h.old_value).slice(0, 60)} → ${String(h.new_value).slice(0, 100)} (src=${h.source_message_id ?? "-"})`);
  const { data: jev } = await sb.from("jev_shadow_logs").select("kind, brain_action, jev_action, jev_action_prob, jev_check_pattern, brain_check_pattern, answers").eq("conversation_id", Y).gte("created_at", t0.toISOString());
  for (const x of (jev ?? []) as any[]) log(`  Jev[${x.kind}]: brain=${x.brain_action}/${x.brain_check_pattern ?? ""} jev=${x.jev_action}(${x.jev_action_prob != null ? Number(x.jev_action_prob).toFixed(2) : "-"})/${x.jev_check_pattern ?? ""} ${JSON.stringify(x.answers ?? null).slice(0, 220)}`);
  const { data: aix } = await sb.from("aix_action_items").select("*").eq("conversation_id", Y).gte("created_at", t0.toISOString());
  for (const a of (aix ?? []) as any[]) log(`  副作用 AIX要対応: id=${a.id} status=${a.status} ${JSON.stringify(a).slice(0, 200)}`);
  const { data: tasks } = await sb.from("line_tasks").select("id, task_type, status").eq("conversation_id", Y).gte("created_at", t0.toISOString());
  for (const t of (tasks ?? []) as any[]) log(`  副作用 タスク: ${JSON.stringify(t)}`);
  log(`🔎 お客様の条件: ${conditionHeadlineLines(customerConditionItems(after as any)).join(" ／ ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
