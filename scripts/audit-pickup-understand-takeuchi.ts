// scripts/audit-pickup-understand-takeuchi.ts — 竹内さん本人のピックアップの番で、AIX の材料に物件ごとの事実・合う点・合わない点・読めていない欄がどれだけ揃っているか（読むだけ・LLM なし・費用0）
//   作業員P・2026-11-23・台帳 #479（前の作業員K2 の分）。欄の埋まり方は K2 の scripts/audit-pickup-understanding.ts の fieldStates をそのまま使う。木の決め方は app/lib/pickup-understand-map.ts。
//   番＝送ったピックアップの物件（property_pickups.status=sent）のうち、送った時刻の前後10分にこちらが送った AIX の通が竹内さん本人（messages.staff_writer=takeuchi・端末の記録）の物。
//   「なぜ選んだか」は作業員A の growth:pickup_select（audit-pickup-select-link）が数える＝ここでは数えない。
//   文・名前は出さない（欄の数だけ）。営業時間（JST 9〜22時）は --days=2 --max-conv=10 に絞る（--force で外す）。
// 実行（22時以降）: npx tsx --env-file=<env> scripts/audit-pickup-understand-takeuchi.ts [--days=60] [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { fieldStates } from "./audit-pickup-understanding";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";
import { pickupUnderstandSummaryOf, PICKUP_GROUP_JA, type PickupUnderstandRow } from "../app/lib/pickup-understand-map";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  let days = Number(arg("days", "60")) || 60, maxConv = Number(arg("max-conv", "400")) || 400;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !process.argv.includes("--force")) { days = Math.min(days, 2); maxConv = Math.min(maxConv, 10); console.log(`営業時間なので --days=${days} --max-conv=${maxConv} に絞った`); }
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data, error } = await sb.from("property_pickups").select("id, conversation_id, status, sent_at, property_name, room_no, summary_text, pdf_text, verdict, reason_codes, terms, location, equipment, image_analysis, image_facts").eq("status", "sent").gte("sent_at", since).limit(3000);
  if (error) throw new Error(error.message);
  const picks = ((data ?? []) as Array<Record<string, unknown> & { id: string; conversation_id: string | null; sent_at: string | null }>).filter((r) => r.conversation_id && r.sent_at && !isTestConversation(r.conversation_id) && !isNoLineTestConversation(r.conversation_id));
  const byConv = new Map<string, typeof picks>();
  for (const p of picks) byConv.set(p.conversation_id!, [...(byConv.get(p.conversation_id!) ?? []), p]);
  const rows: PickupUnderstandRow[] = [];
  let notTakeuchi = 0;
  for (const [c, ps] of [...byConv].slice(0, maxConv)) {
    const lo = new Date(Math.min(...ps.map((p) => Date.parse(p.sent_at!))) - 10 * 6e4).toISOString(), hi = new Date(Math.max(...ps.map((p) => Date.parse(p.sent_at!))) + 10 * 6e4).toISOString();
    const { data: md } = await sb.from("messages").select("sender, created_at, is_aix_generated, staff_writer").eq("conversation_id", c).gte("created_at", lo).lte("created_at", hi).limit(2000);
    const aix = ((md ?? []) as Array<{ sender: string; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null }>).filter((m) => m.sender !== "customer" && m.is_aix_generated);
    for (const p of ps) {
      const t = Date.parse(p.sent_at!);
      const near = aix.filter((m) => Math.abs(Date.parse(m.created_at) - t) <= 10 * 6e4);
      if (!near.length || !near.every((m) => m.staff_writer === "takeuchi")) { notTakeuchi++; continue; }
      rows.push({ id: String(p.id), conv: c.slice(0, 8), at: p.sent_at!.slice(0, 16), states: fieldStates(p as never) });
    }
  }
  const s = pickupUnderstandSummaryOf(rows);
  console.log(`物件の理解の土台（${days}日・竹内さん本人のピックアップ ${rows.length}件・竹内さん以外 ${notTakeuchi}）: 揃っている／届いていない（元はあるのに空）／読めていない（元も無い）`);
  for (const [g, v] of Object.entries(s)) console.log(`  ${PICKUP_GROUP_JA[g] ?? g}: ${v.filled}/${v.n}（${v.n ? Math.round((v.filled / v.n) * 1000) / 10 : "—"}%）・届いていない ${v.gap}・読めていない ${v.none}`);
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify(rows, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
