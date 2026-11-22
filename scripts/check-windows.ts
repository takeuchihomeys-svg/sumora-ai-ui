// scripts/check-windows.ts — 穴の型③「読む窓が狭くて届かない」の点検（読むだけ・LLM なし・費用0・作業員N2・2026-11-21・台帳 #505）
//
// 統括役 11/21 の5つの型の③。決めと窓の一覧は scripts/lib/read-windows.ts。
//   標本: 直近 --hours 時間（既定72・24時間だと会話が15ほどしか無い）のブレインの判断（brain_decision_logs）から会話ごとに最新の1回・テストと申込以降の会話は除く・最大 --max（既定40）
//   会話ごとの読み: 判断の時までの発言（新しい順・1,000通まで・本文はこの台本の中で数えるだけで出さない）・総数・セーブデータの位置・送った物件・共有・カレンダー・ピックアップ・見積の数
//   出す: 窓ごとの「材料が窓の外にある会話」の割合（会話は id の頭8字だけ）。--write で穴（5% 以上・2会話以上）を台帳へ
//   重い読み（発言の本文 ×40会話）なので夜（JST 22〜9時）だけ回す。昼は --force が無ければ何もしない
// 実行: npx tsx --env-file=.env.local scripts/check-windows.ts [--hours=72] [--max=40] [--json] [--write] [--force]
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { READ_WINDOWS, windowMissOf, isWindowGap, type WinCase, type WindowMiss } from "./lib/read-windows";
import { brainMsgWindow } from "../app/lib/brain-msg-window";
import { situationTimelineWideOn } from "../app/lib/situation-timeline";
import { sentPropsFullOn, SENT_PROPS_FULL_LIMIT } from "../app/lib/sent-props-text";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";
import { isPostApplyStatus } from "../app/lib/llm-alt-provider";
import { addFoundGaps } from "./lib/found-gap-ledger";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAY = 86_400_000;
/** 夜（JST 22〜9時）か */
export const isNightJst = (ms = Date.now()) => { const h = new Date(ms + 9 * 3600e3).getUTCHours(); return h >= 22 || h < 9; };

async function caseOf(sb: SupabaseClient, conv: string, atIso: string): Promise<WinCase> {
  const atMs = Date.parse(atIso);
  const since60 = new Date(atMs - 60 * DAY).toISOString();
  const head = { count: "exact" as const, head: true };
  const [m, cnt, cp, sp, sh, cal, puOld, pu60, est] = await Promise.all([
    sb.from("messages").select("sender, text, created_at").eq("conversation_id", conv).lte("created_at", atIso).order("created_at", { ascending: false }).limit(1000),
    sb.from("messages").select("id", head).eq("conversation_id", conv).lte("created_at", atIso),
    sb.from("conversation_checkpoints").select("message_count_at_creation").eq("conversation_id", conv).lte("created_at", atIso).order("checkpoint_index", { ascending: false }).limit(1).maybeSingle(),
    sb.from("sent_properties").select("id", head).eq("conversation_id", conv).or("source.is.null,source.neq.line_group").lte("sent_at", atIso),
    sb.from("sent_properties").select("id", head).eq("conversation_id", conv).eq("source", "line_group").lte("sent_at", atIso),
    sb.from("calendar_events").select("id", head).eq("conversation_id", conv).gte("start_at", since60),
    sb.from("property_pickups").select("id", head).eq("conversation_id", conv).eq("status", "sent").lt("created_at", since60),
    sb.from("property_pickups").select("id", head).eq("conversation_id", conv).eq("status", "sent").gte("created_at", since60).lte("created_at", atIso),
    sb.from("estimate_records").select("id", head).eq("conversation_id", conv).lte("created_at", atIso),
  ]);
  return {
    conv, atMs,
    msgs: ((m.data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).map((x) => ({ sender: x.sender, text: x.text, atMs: Date.parse(x.created_at) })),
    total: cnt.count ?? 0,
    cpAt: (cp.data as { message_count_at_creation: number } | null)?.message_count_at_creation ?? null,
    sentProps: sp.count ?? 0, sharedProps: sh.count ?? 0, calendar60: cal.count ?? 0, pickupsOld: puOld.count ?? 0, pickups60: pu60.count ?? 0, estimates: est.count ?? 0,
  };
}

export async function checkWindows(sb: SupabaseClient, o: { hours?: number; max?: number } = {}): Promise<{ misses: WindowMiss[]; gaps: WindowMiss[]; n: number; brainWindow: number; timelineWide: boolean; sentPropsLimit: number }> {
  const hours = o.hours ?? 72, max = Math.min(o.max ?? 40, 80);
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const { data, error } = await sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, conversation_status").gte("created_at", since).order("created_at", { ascending: false }).limit(1000);
  if (error) throw new Error(`brain_decision_logs: ${error.message}`);
  const seen = new Set<string>();
  const picks: Array<{ conv: string; at: string }> = [];
  for (const r of (data ?? []) as Array<{ conversation_id: string; created_at: string; analyzed_msg_ts: string | null; conversation_status: string | null }>) {
    if (seen.has(r.conversation_id)) continue;
    seen.add(r.conversation_id);
    if (isTestConversation(r.conversation_id) || isNoLineTestConversation(r.conversation_id) || isPostApplyStatus(r.conversation_status)) continue;
    picks.push({ conv: r.conversation_id, at: r.analyzed_msg_ts ?? r.created_at });
    if (picks.length >= max) break;
  }
  const cases: WinCase[] = [];
  for (const p of picks) { try { cases.push(await caseOf(sb, p.conv, p.at)); } catch { /* 読めない会話は飛ばす */ } }
  const opt = { brainWindow: brainMsgWindow(), timelineWide: situationTimelineWideOn(), sentPropsLimit: sentPropsFullOn() ? SENT_PROPS_FULL_LIMIT : 20 };
  const misses = windowMissOf(cases, opt);
  return { misses, gaps: misses.filter(isWindowGap), n: cases.length, ...opt };
}

if (process.argv[1]?.endsWith("check-windows.ts")) (async () => {
  if (!isNightJst() && !process.argv.includes("--force")) { console.log("昼（JST 9〜22時）は回さない（発言の本文を読む重い読み）。--force で回す"); return; }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const r = await checkWindows(sb, { hours: Number(arg("hours", "72")) || 72, max: Number(arg("max", "40")) || 40 });
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r)); return; }
  console.log(`読む窓が狭くて届かない（会話 ${r.n}・窓 ${READ_WINDOWS.length}・ブレインの窓 ${r.brainWindow}通・時系列の帳面 WIDE ${r.timelineWide ? "on" : "off"}・穴 ${r.gaps.length}）`);
  for (const m of [...r.misses].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))) console.log(`- ${isWindowGap(m) ? "穴" : "  "}｜${m.label}（${m.limit}）｜窓の外 ${m.outside}/${m.n}＝${m.rate ?? "—"}%｜会話 ${m.convs.slice(0, 6).join(",") || "—"}`);
  if (process.argv.includes("--write")) {
    const added = await addFoundGaps(sb, r.gaps.map((m) => ({
      title: `読む窓が狭くて届かない: ${m.label}（${m.limit}）`, owner: m.stage, priority: 20,
      next: `check-windows（穴の型③）: 窓の外 ${m.outside}/${m.n}（${m.rate}%）・${m.why}・場所 ${m.where}・会話 ${m.convs.slice(0, 5).join(",")}・窓を広げるか別読み・要約で補い、試験で悪化0を確かめる（台帳 #505）`,
    })), "check-windows");
    console.log(`台帳に足した ${added.length}行${added.length ? `（#${added.join("・#")}）` : ""}`);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
