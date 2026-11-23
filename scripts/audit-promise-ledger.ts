// scripts/audit-promise-ledger.ts — 行動台帳の約束の、開いている数・期日超え・72時間で果たした割合（読むだけ・LLM なし・軽い読み）
// 2026-11-23 作業員L（台帳 #519）。読む物: 直近 --days 日の sent_facts の約束と済みの行だけ（会話の本文は読まない）。
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-ledger.ts [--days=14] [--metrics=<出力>] [--wide-close] [--list]
//   --wide-close（2026-11-23 作業員L・統括役の承認）: 開いている約束の会話だけ、発言・送付を読んで閉じる（promise-ledger-metrics.wideCloseOf・LLM なし）。
//     既定（付けない）は今と同じ数。読むのは開いている約束の会話だけ（その会話の一番古い開いた約束の時刻から・promise-drop-watch-server.loadPdInput）。
//   --list: 開いている約束と広げて閉じた約束を1行ずつ（会話の頭8字・種類・期日超えか・閉じた理由。本文は出さない）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { promiseStatesOf, summarizePromises, promiseMetricRows, widenPromiseStates, type FactRow, type PromiseState, type WideEvidence } from "./lib/promise-ledger-metrics";
import { loadPdInput } from "../app/lib/promise-drop-watch-server";
import { isTestConversation, isNoLineTestConversation, STAFF_INTERNAL_CONVERSATION_IDS } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const days = Number(arg("days", "14")) || 14;
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false } });
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
  const nowMs = Date.now();
  let states: PromiseState[] = promiseStatesOf(kept);
  if (process.argv.includes("--wide-close")) {
    const firstAt = new Map<string, string>();
    for (const p of states) if (!p.closedAt && (!firstAt.has(p.conv) || p.at < firstAt.get(p.conv)!)) firstAt.set(p.conv, p.at);
    const evs = new Map<string, WideEvidence>();
    const convs = [...firstAt.keys()];
    for (let k = 0; k < convs.length; k += 6) await Promise.all(convs.slice(k, k + 6).map(async (c) => {
      const i = await loadPdInput(sb as never, c, firstAt.get(c)!);
      evs.set(c, { status: i.status, msgs: i.msgs, sent: i.sent });
    }));
    const w = widenPromiseStates(states, (c) => evs.get(c));
    states = w.states;
    console.log(`--wide-close: 読んだ会話 ${convs.length}・閉じた理由 ${Object.entries(w.byReason).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  if (process.argv.includes("--list")) for (const p of states.filter((x) => !x.closedAt || x.closedBy)) console.log(`  ${p.conv.slice(0, 8)} ${p.kind} ${p.at.slice(5, 16)} ${p.closedBy ?? (nowMs > p.deadlineMs ? "期日超え" : "期日前")}`);
  const s = summarizePromises(states, nowMs);
  console.log(`行動台帳の約束（${days}日・行 ${kept.length}）: 開いている ${s.open}・うち期日超え ${s.overdue}・72〜144時間前にした約束 ${s.madeWindow} のうち72時間の内に閉じた ${s.keptWindow}`);
  if (arg("metrics", "")) writeFileSync(arg("metrics", ""), JSON.stringify(promiseMetricRows(s), null, 1));
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
