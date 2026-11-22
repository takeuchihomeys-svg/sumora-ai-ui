// scripts/audit-timeline-delivery.ts — 時系列の帳面の欄ごとに、ブレインと書き手に届く項目の数を数える（読むだけ・LLM なし・軽い読み）
// 2026-11-23 作業員L（台帳 #7）。読む物: 直近 --hours 時間に下書きを出した会話（最大 --max）の last_brain_meta.situation_now だけ。
// 実行: npx tsx --env-file=.env.local scripts/audit-timeline-delivery.ts [--hours=72] [--max=80] [--metrics=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { timelineDeliveryOf, sumTimelineDelivery, timelineMetricRows, TL_FIELDS } from "./lib/timeline-delivery";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const hours = Number(arg("hours", "72")) || 72, max = Math.min(Number(arg("max", "80")) || 80, 200);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const { data, error } = await sb.from("conversations").select("id, ai_draft_shown_at, last_brain_meta").gte("ai_draft_shown_at", new Date(Date.now() - hours * 36e5).toISOString()).order("ai_draft_shown_at", { ascending: false }).limit(max);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<{ id: string; ai_draft_shown_at: string; last_brain_meta: { situation_now?: unknown } | null }>).filter((r) => !isTestConversation(r.id) && !isNoLineTestConversation(r.id) && r.last_brain_meta?.situation_now);
  const sum = sumTimelineDelivery(rows.map((r) => timelineDeliveryOf(r.last_brain_meta!.situation_now as never, Date.parse(r.ai_draft_shown_at), process.env)));
  console.log(`時系列の帳面の届き方（${hours}時間・下書きを出した会話のうち帳面のある ${rows.length}）: 欄・項目の数 → ブレインに届く → 書き手に届く`);
  for (const k of TL_FIELDS) console.log(`${k.padEnd(9)} ${String(sum[k].n).padStart(3)} → ブレイン ${sum[k].toBrain} → 書き手 ${sum[k].toWriter}`);
  if (arg("metrics", "")) writeFileSync(arg("metrics", ""), JSON.stringify(timelineMetricRows(sum, hours), null, 1));
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
