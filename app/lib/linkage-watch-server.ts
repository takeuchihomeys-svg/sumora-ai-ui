// app/lib/linkage-watch-server.ts — 連携の地図の見張り（読むだけ・LLM なし・費用0）。cron（app/api/cron/linkage-watch）と手元の台本（scripts/linkage-watch.ts）が使う
//
// 2026-11-15 作業員L（KB P0 3041baaa）。呼ぶ所: 作業員H の朝の1本の cron から runLinkageWatchAndLog（cron は足さない・上限100本）と手元の scripts/linkage-watch.ts。地図の行ごとに
//   (a) 作る側のスイッチが本番で on か（brain_switch_versions の最新の行・無い名前はコードの既定 linkage-switch-defaults）
//   (b) 読む側の親のスイッチが on か
//   (c) 本番の直近の判断の記録（conversations.suggested_aix_meta・表の直近の行）で、その欄が空でない割合
//   (d) RAG の空・失敗（作業員H の RAG の見張り＝まだつないでいない）
//   を数え、状態（つながっている／切れている／親が off／空が多い／測れない）と1行の要約を出す。重い読みはしない（meta は直近 60会話・表は件数だけ）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { LINKAGE_MAP, fillTimeColOf, rowStatus, switchStateOf, metaFills, summaryLine, mapSwitchNames, type RowResult, type SwitchState, type WatchReport } from "./linkage-map";
import { LINKAGE_SWITCH_DEFAULTS } from "./linkage-switch-defaults";
import { SWITCH_PREFIXES } from "./switch-fingerprint";
import { NO_LINE_TEST_CONVERSATION_IDS, STAFF_INTERNAL_CONVERSATION_IDS, YUMA_CONVERSATION_ID } from "./test-conversations";

export const LINKAGE_CRON_NAME = "linkage-watch";

export function parseSwitchText(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text ?? "").split(/\r?\n/)) { const i = line.indexOf("="); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return out;
}

export async function runLinkageWatch(sb: SupabaseClient, o: { metaLimit?: number; nowMs?: number } = {}): Promise<WatchReport & { summary: string; notes: string[] }> {
  const notes: string[] = [];
  const nowMs = o.nowMs ?? Date.now();
  // (a)(b) 本番のスイッチ
  let prod: Record<string, string> | null = null;
  {
    const { data, error } = await sb.from("brain_switch_versions").select("switches, last_seen_at").order("last_seen_at", { ascending: false }).limit(1);
    if (error) notes.push(`brain_switch_versions: ${error.message}`); else if (data?.[0]) prod = parseSwitchText((data[0] as { switches: string }).switches);
    if (!prod) notes.push("本番のスイッチの記録が無い＝コードの既定で見た");
  }
  const switches: Record<string, SwitchState> = {};
  for (const n of mapSwitchNames()) switches[n] = switchStateOf(n, prod, LINKAGE_SWITCH_DEFAULTS, SWITCH_PREFIXES);
  const sw = (n: string) => switches[n] ?? switchStateOf(n, prod, LINKAGE_SWITCH_DEFAULTS, SWITCH_PREFIXES);

  // (c) meta の欄（直近の会話の最新の判断・テストの会話は外す）
  const tests = new Set<string>([YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS, ...STAFF_INTERNAL_CONVERSATION_IDS]);
  const fills: Record<string, { rate: number | null; n: number } | undefined> = {};
  {
    const since = new Date(nowMs - 3 * 86_400_000).toISOString();
    const { data, error } = await sb.from("conversations").select("id, suggested_aix_meta").gte("brain_analyzed_at", since).not("suggested_aix_meta", "is", null).order("brain_analyzed_at", { ascending: false }).limit(o.metaLimit ?? 60);
    if (error) notes.push(`conversations: ${error.message}`);
    const metas = ((data ?? []) as Array<{ id: string; suggested_aix_meta: unknown }>).filter((r) => !tests.has(r.id)).map((r) => r.suggested_aix_meta);
    Object.assign(fills, metaFills(metas));
  }
  // (c) 表の直近の行の数と列が空でない割合（件数だけ読む）
  for (const r of LINKAGE_MAP) {
    if (r.fill.src !== "table") continue;
    const f = r.fill;
    const since = new Date(nowMs - f.days * 86_400_000).toISOString();
    // 2026-11-22 作業員M: sent_properties には created_at が無い（sent_at）＝read.sent_full・bridge.* の数えが列の誤りで落ちていた
    // 2026-11-28 作業員L（朝の1枚 11/26 の「記録に残らない」read.facts・read.fact_ledger3・sent.image_role）: customer_fact_ledger（built_at）・image_details（read_at）も
    //   created_at が無く読めていなかった＝数え方の穴。列の決めは linkage-map の fillTimeColOf の1か所に
    const timeCol = fillTimeColOf(f.table);
    // 2026-11-21 作業員L: where の値 "isnull:" は「その列（json の道も可）が空」（見張りの読み直しの印 verdict_detail->reopened のある行を外す・統括役の決め）
    const base = () => { let q = sb.from(f.table).select("*", { count: "exact", head: true }).gte(timeCol, since); for (const [k, v] of Object.entries(f.where ?? {})) q = v.startsWith("like:") ? q.like(k, v.slice(5)) : v === "isnull:" ? q.is(k, null) : q.eq(k, v); return q; };
    const all = await base();
    if (all.error) { notes.push(`${r.id}（${f.table}）: ${all.error.message}`); fills[r.id] = undefined; continue; }
    const n = all.count ?? 0;
    if (!f.col || !n) { fills[r.id] = { rate: n ? 1 : 0, n }; continue; }
    const nn = await base().not(f.col, "is", null);
    if (nn.error) { notes.push(`${r.id}（${f.table}.${f.col}）: ${nn.error.message}`); fills[r.id] = { rate: null, n }; continue; }
    fills[r.id] = { rate: (nn.count ?? 0) / n, n };
  }
  const results: RowResult[] = LINKAGE_MAP.map((r) => rowStatus(r, sw, fills));
  // 先週の切れている数（6日より前の一番新しい記録）
  let prevBroken: number | null = null;
  {
    const { data } = await sb.from("cron_run_logs").select("result_json, started_at").eq("cron_name", LINKAGE_CRON_NAME).eq("ok", true).lte("started_at", new Date(nowMs - 6 * 86_400_000).toISOString()).order("started_at", { ascending: false }).limit(1);
    const rj = (data?.[0] as { result_json?: { broken?: number } } | undefined)?.result_json;
    if (typeof rj?.broken === "number") prevBroken = rj.broken;
  }
  const rep: WatchReport = { at: new Date(nowMs).toISOString(), results, prevBroken, switches };
  return { ...rep, summary: summaryLine(rep), notes };
}

/** cron_run_logs に残す形（小さく: 状態ごとの数・切れている行の id と理由・メモ） */
export function compactResult(rep: Awaited<ReturnType<typeof runLinkageWatch>>) {
  const count = (s: string) => rep.results.filter((r) => r.status === s).length;
  return {
    summary: rep.summary, broken: count("broken"), parent_off: count("parent_off"), sparse: count("sparse"), connected: count("connected"), unknown: count("unknown"),
    cut: rep.results.filter((r) => r.status === "broken" || r.status === "sparse").map((r) => ({ id: r.id, s: r.status, why: r.why })),
    off: rep.results.filter((r) => r.status === "parent_off").map((r) => ({ id: r.id, sw: r.offSwitches })),
    // 2026-11-23 作業員L（作業員P の見つけ・統括役の頼み）: 測れなかった行（status=unknown＝RAG の見張りが未接続・本番の記録を読めなかった・測り方の無い行）の名前と理由。
    //   今までは数（unknown）だけで行の名前が残らず、読む側（P の conductorReachOf・N2 の台帳の conductor_reach）が cut／off に無い行を「つながっている」と見ていた
    unmeasured: rep.results.filter((r) => r.status === "unknown").map((r) => ({ id: r.id, why: r.why })),
    notes: rep.notes.slice(0, 20),
  };
}

/**
 * 2026-11-15 作業員L（統括役: Vercel の cron が上限 100本）: 新しい cron は足さない。作業員H がまとめる「朝の1本の cron から順に呼ぶ」形に乗せるための入口。
 *   呼ぶ側は sb（サーバーの鍵）を渡すだけ。cron_run_logs に cron_name=linkage-watch の1行を書き、要約の1行を返す。止める LINKAGE_WATCH=off。
 */
export async function runLinkageWatchAndLog(sb: SupabaseClient, env: Record<string, string | undefined> = process.env): Promise<{ ok: boolean; summary: string | null; error?: string }> {
  if ((env.LINKAGE_WATCH ?? "").trim().toLowerCase() === "off") return { ok: true, summary: null };
  const started = new Date().toISOString();
  try {
    const rep = await runLinkageWatch(sb);
    const result = compactResult(rep);
    await sb.from("cron_run_logs").insert({ cron_name: LINKAGE_CRON_NAME, started_at: started, finished_at: new Date().toISOString(), ok: true, result_json: result });
    return { ok: true, summary: rep.summary };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("cron_run_logs").insert({ cron_name: LINKAGE_CRON_NAME, started_at: started, finished_at: new Date().toISOString(), ok: false, error_message: msg.slice(0, 500) });
    return { ok: false, summary: null, error: msg };
  }
}
