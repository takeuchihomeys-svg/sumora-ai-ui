// scripts/audit-pickup-ready-daily.ts — 「ピックアップはエリア＋家賃がそろってから」（KB 0f158fe3・P1）の毎日の数（読むだけ・LLM なし・費用0・軽い読み）
//
// 2026-11-22 作業員K2（台帳 #546・土台 k2.pickup_condition の本番の数字）。
//   audit-pickup-conditions-complete.ts（180日・全件の読み）は線を引く台本で重いので、毎朝の数はこちら（直近 N 日の最初のピックアップだけ）。
//   数える番: 直近 N 日に送った AIX の物件ピックアップ・物件オススメのうち、その会話で最初の物件の AIX だった物（テストの会話は外す）。
//   そろったか: app/lib/hearing-form.ts pickupConditionsReady（ブレインの rule:conditions_incomplete_hearing と同じ1か所）に
//     その会話の条件の行（property_customers・今の値＝その時点より上ぶれする）と、送る前のお客様の発言を渡す。
//   物件が既に会話にある番（見積書・物件確認の AIX が先）は決まりの対象外なので外す（ブレインの propertyAlreadyInPlay の AIX の部分と同じ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-ready-daily.ts [--days=7] [--show] [--json | --json=<道>]
//   --json: 1行の {days, n, ready, rate, missing:{area,rent}, convs:[頭8字・そろっていない番]}（毎朝の1枚の growth:pickup_ready 用）
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";
import { pickupConditionsReady, type HearingKnown } from "../app/lib/hearing-form";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const PICK = ["property_send", "property_recommendation"];
const IN_PLAY = ["property_send", "property_recommendation", "property_check_result", "estimate_sheet"];
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "7")) || 7;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: logs, error } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at").in("aix_type", PICK).gte("sent_at", since).order("sent_at").limit(2000);
  if (error) throw new Error(error.message);
  const firstInWindow = new Map<string, string>();
  for (const l of (logs ?? []) as Array<{ conversation_id: string | null; sent_at: string }>) {
    if (!l.conversation_id || isTestConversation(l.conversation_id) || isNoLineTestConversation(l.conversation_id)) continue;
    if (!firstInWindow.has(l.conversation_id)) firstInWindow.set(l.conversation_id, l.sent_at);
  }
  let n = 0, ready = 0; const missing = { area: 0, rent: 0 }; const notReady: string[] = [];
  for (const [cid, at] of firstInWindow) {
    const { count } = await sb.from("aix_usage_logs").select("id", { count: "exact", head: true }).eq("conversation_id", cid).in("aix_type", IN_PLAY).lt("sent_at", at);
    if ((count ?? 0) > 0) continue; // 最初の物件の AIX でない・物件が既に会話にある
    const { data: conv } = await sb.from("conversations").select("property_customer_id").eq("id", cid).maybeSingle();
    const pcId = (conv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
    const pc = pcId ? ((await sb.from("property_customers").select("desired_area, commute_station, rent_min, rent_max, floor_plan, move_in_time").eq("id", pcId).maybeSingle()).data as HearingKnown | null) : null;
    const { data: msgs } = await sb.from("messages").select("text").eq("conversation_id", cid).eq("sender", "customer").lt("created_at", at).order("created_at", { ascending: false }).limit(60);
    const r = pickupConditionsReady(pc, ((msgs ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").reverse());
    n++;
    if (r.ready) ready++;
    else { notReady.push(cid.slice(0, 8)); for (const m of r.missing) missing[m]++; }
  }
  const out = { days, n, ready, rate: n ? Math.round((ready / n) * 1000) / 10 : null, missing, convs: notReady };
  const jsonArg = process.argv.find((a) => a === "--json" || a.startsWith("--json="));
  if (jsonArg === "--json") { console.log(JSON.stringify(out)); return; }
  if (jsonArg) writeFileSync(jsonArg.slice(7), JSON.stringify(out, null, 2));
  console.log(`最初のピックアップ（${days}日・テストと物件が既に会話にある番を外す）: ${n}番・エリア＋家賃がそろっていた ${ready}（${out.rate ?? "-"}%）・足りない エリア ${missing.area}・家賃 ${missing.rent}`);
  if (process.argv.includes("--show") && notReady.length) console.log("  そろっていない番:", notReady.join("・"));
})().catch((e) => { console.error(e); process.exit(1); });
