// scripts/audit-timeline-coverage.ts — お客様の言った日時が絶対の日付に直されて今の状況の記録に入っているかを数える（読むだけ・LLM なし・軽い読み）
// 2026-11-21 作業員L（台帳 #7）。読む物: 直近 --hours 時間に判断した会話（最大 --max）の suggested_aix_meta と、その判断より前のお客様の発言 40通。
// 実行: npx tsx --env-file=.env.local scripts/audit-timeline-coverage.ts [--hours=24] [--max=60]
import { createClient } from "@supabase/supabase-js";
import { timelineCoverageOf, summarizeTimeline, type TlResult } from "./lib/timeline-coverage";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";
import { brainMsgWindow } from "../app/lib/brain-msg-window";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const hours = Number(arg("hours", "24")) || 24, max = Math.min(Number(arg("max", "60")) || 60, 150);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - hours * 36e5).toISOString();
  const { data, error } = await sb.from("conversations").select("id, brain_analyzed_at, suggested_aix_meta").gte("brain_analyzed_at", since).not("suggested_aix_meta", "is", null).order("brain_analyzed_at", { ascending: false }).limit(max);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<{ id: string; brain_analyzed_at: string; suggested_aix_meta: { situation_now?: { timeline?: { words?: Array<{ word: string; said?: string; from?: string | null }> } } } }>)
    .filter((r) => !isTestConversation(r.id) && !isNoLineTestConversation(r.id));
  const res: TlResult[] = [];
  for (const r of rows) {
    const { data: m } = await sb.from("messages").select("text, created_at").eq("conversation_id", r.id).eq("sender", "customer").lte("created_at", r.brain_analyzed_at).order("created_at", { ascending: false }).limit(40);
    const msgs = ((m ?? []) as Array<{ text: string | null; created_at: string }>).reverse().map((x) => ({ text: x.text, atMs: Date.parse(x.created_at) }));
    // ブレインが読む窓（直近の発言 BRAIN_MSG_WINDOW 通・既定 20）の始まり
    const { data: w } = await sb.from("messages").select("created_at").eq("conversation_id", r.id).lte("created_at", r.brain_analyzed_at).order("created_at", { ascending: false }).limit(brainMsgWindow());
    const ws = (w ?? []) as Array<{ created_at: string }>;
    const windowStartMs = ws.length >= brainMsgWindow() ? Date.parse(ws[ws.length - 1].created_at) : null;
    const tl = r.suggested_aix_meta?.situation_now?.timeline;
    res.push(timelineCoverageOf({ conv: r.id, msgs, recWords: tl ? (tl.words ?? []) : null, nowMs: Date.parse(r.brain_analyzed_at), windowStartMs }));
  }
  const s = summarizeTimeline(res);
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  console.log(`時系列の帳面の入り方（${hours}時間・判断した会話 ${s.turns}・お客様の時の言葉がある会話 ${s.withWords}）`);
  console.log(`記録が無い（situation_now／timeline が無い）: ${s.noRecord} 会話`);
  console.log(`記録がある会話の時の言葉: ${s.expected} → 絶対の日付つきで記録に入った ${s.hit}（${pct(s.hit, s.expected)}）`);
  console.log(`うちブレインの読む窓（直近 ${brainMsgWindow()} 通）より前に言った言葉: ${s.outOfWindow} → 入った ${s.outOfWindowHit}／窓の中の言葉: ${s.expected - s.outOfWindow} → 入った ${s.hit - s.outOfWindowHit}（${pct(s.hit - s.outOfWindowHit, s.expected - s.outOfWindow)}）`);
  if (s.missingTop.length) console.log(`漏れた言葉（多い順）: ${s.missingTop.map(([w, n]) => `${w}×${n}`).join("・")}`);
  for (const r of res.filter((x) => x.expected > 0 && (x.noRecord || x.missing.length))) console.log(`  ${r.conv.slice(0, 8)} 期待 ${r.expected}・入った ${r.hit}${r.noRecord ? "・記録なし" : `・漏れ ${r.missing.join("／")}`}`);
})().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
