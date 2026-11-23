// scripts/backfill-promise-due-text.ts — 行動台帳（sent_facts）の約束の行に detail.dueText を付け直す（一回きり・LLM なし・会話と時刻で絞る読み）
// 2026-11-23 作業員L（台帳 #645・統括役の決め: 14日の範囲で一回きり。書く前に対象の行の id と変わる期日を一覧にして目で確かめ、書いた後にもう一度数える）
// 実行: npx tsx --env-file=.env.local scripts/backfill-promise-due-text.ts [--days=14]            … 一覧だけ（書かない）
//       npx tsx --env-file=.env.local scripts/backfill-promise-due-text.ts [--days=14] --write    … dueText が無い行に足す（他の欄は変えない）
//   約束の通は、同じ会話のこちらの手打ちの通で、行の時刻の前後3分・evidence の頭10字を含む物（無ければその時刻の最初の通）。
import { createClient } from "@supabase/supabase-js";
import { promiseDeadlineMs } from "../app/lib/promise-drop-watch";
import { promiseDueTextOf, promiseDueFromText } from "../app/lib/promise-due-text";
import { isTestConversation, isNoLineTestConversation, STAFF_INTERNAL_CONVERSATION_IDS } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const day = (ms: number) => new Date(ms - 1 + 9 * 36e5).toISOString().slice(5, 16);
type Row = { id: number | string; conversation_id: string; kind: string; sent_at: string; evidence: string | null; detail: Record<string, unknown> | null };
(async () => {
  const days = Number(arg("days", "14")) || 14;
  const write = process.argv.includes("--write");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false } });
  const internal = new Set<string>(STAFF_INTERNAL_CONVERSATION_IDS as readonly string[]);
  const { data, error } = await sb.from("sent_facts").select("id, conversation_id, kind, sent_at, evidence, detail").eq("status", "promised")
    .in("kind", ["confirmation_promised", "pickup_declared", "estimate_declared"]).gte("sent_at", new Date(Date.now() - days * 864e5).toISOString()).order("sent_at").limit(2000);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Row[]).filter((r) => !isTestConversation(r.conversation_id) && !isNoLineTestConversation(r.conversation_id) && !internal.has(r.conversation_id));
  const plan: Array<{ r: Row; due: string; changed: boolean; from: string; to: string }> = [];
  let had = 0, noMsg = 0, noDue = 0;
  for (let k = 0; k < rows.length; k += 6) await Promise.all(rows.slice(k, k + 6).map(async (r) => {
    if (r.detail?.dueText) { had++; return; }
    const t0 = Date.parse(r.sent_at);
    const { data: ms } = await sb.from("messages").select("text").eq("conversation_id", r.conversation_id).eq("sender", "staff").eq("is_aix_generated", false)
      .gte("created_at", new Date(t0 - 180_000).toISOString()).lte("created_at", new Date(t0 + 180_000).toISOString()).limit(10);
    const ev = String(r.evidence ?? "").normalize("NFKC").slice(0, 10);
    const m = ((ms ?? []) as Array<{ text: string | null }>).find((x) => String(x.text ?? "").normalize("NFKC").includes(ev)) ?? ((ms ?? []) as Array<{ text: string | null }>)[0];
    if (!m) { noMsg++; return; }
    const due = promiseDueTextOf(String(m.text ?? ""), r.kind);
    if (!due) { noDue++; return; }
    const a = promiseDeadlineMs(String((r.detail as { sentence?: string } | null)?.sentence ?? r.evidence ?? ""), t0).ms;
    const b = promiseDueFromText(due, t0).ms;
    plan.push({ r, due, changed: Math.abs(a - b) >= 60_000, from: day(a), to: day(b) });
  }));
  console.log(`行 ${rows.length}・もう dueText あり ${had}・通が見つからない ${noMsg}・約束の文が取れない ${noDue}・足す ${plan.length}（うち期日が変わる ${plan.filter((p) => p.changed).length}）`);
  for (const p of plan.filter((x) => x.changed)) console.log(`  期日が変わる id=${p.r.id} ${p.r.conversation_id.slice(0, 8)} ${p.r.kind} ${p.r.sent_at.slice(5, 16)} ${p.from} → ${p.to}`);
  // 2026-11-23 統括役の決め: 一回きりの書き込みは、書く行の id を全部並べてから（目で確かめてから --write）
  for (const p of plan) console.log(`  書く id=${p.r.id} ${p.r.conversation_id.slice(0, 8)} ${p.r.kind} ${p.r.sent_at.slice(5, 16)} 期日 ${p.from}${p.changed ? ` → ${p.to}` : "（変わらない）"}`);
  if (!write) { console.log("（書いていない。--write で足す）"); return; }
  let ok = 0, ng = 0;
  for (const p of plan) {
    const { error: e } = await sb.from("sent_facts").update({ detail: { ...(p.r.detail ?? {}), dueText: p.due } }).eq("id", p.r.id);
    if (e) { ng++; console.log(`  書けなかった id=${p.r.id}: ${e.message}`); } else ok++;
  }
  console.log(`書いた ${ok}・失敗 ${ng}`);
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
