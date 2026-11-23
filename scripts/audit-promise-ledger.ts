// scripts/audit-promise-ledger.ts — 行動台帳の約束の、開いている数・期日超え・72時間で果たした割合（読むだけ・LLM なし・軽い読み）
// 2026-11-23 作業員L（台帳 #519）。読む物: 直近 --days 日の sent_facts の約束と済みの行だけ（会話の本文は読まない）。
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-ledger.ts [--days=14] [--metrics=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { promiseStatesOf, summarizePromises, promiseMetricRows, type FactRow } from "./lib/promise-ledger-metrics";
import { isTestConversation, isNoLineTestConversation, STAFF_INTERNAL_CONVERSATION_IDS } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const days = Number(arg("days", "14")) || 14;
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows: FactRow[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await sb.from("sent_facts").select("conversation_id, kind, status, sent_at, evidence, detail")
      .gte("sent_at", since).in("kind", ["confirmation_promised", "pickup_declared", "estimate_declared", "confirmation_reported", "properties_sent", "estimate_sent"])
      .order("sent_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as FactRow[]));
    if ((data ?? []).length < 1000) break;
  }
  const internal = new Set<string>(STAFF_INTERNAL_CONVERSATION_IDS as readonly string[]);
  const kept = rows.filter((r) => !isTestConversation(r.conversation_id) && !isNoLineTestConversation(r.conversation_id) && !internal.has(r.conversation_id));
  const s = summarizePromises(promiseStatesOf(kept), Date.now());
  console.log(`行動台帳の約束（${days}日・行 ${kept.length}）: 開いている ${s.open}・うち期日超え ${s.overdue}・72〜144時間前にした約束 ${s.madeWindow} のうち72時間の内に閉じた ${s.keptWindow}`);
  if (arg("metrics", "")) writeFileSync(arg("metrics", ""), JSON.stringify(promiseMetricRows(s), null, 1));
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
