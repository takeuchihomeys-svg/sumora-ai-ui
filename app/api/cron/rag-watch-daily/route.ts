// app/api/cron/rag-watch-daily/route.ts — RAG の見張りの毎朝の拾い上げ（読むだけ・LLM なし・費用 0）
//
// 2026-11-15 作業員H（統括役の頼み 土台①）: rag_call_logs（app/lib/rag-watch.ts の包みが書く）の直近24時間と、その前の24時間を RPC ごとに数え、
//   0件が続く・失敗が続く・遅い・前の日は呼ばれていたのに今日は0回、の RAG を cron_run_logs（cron_name=rag-watch-daily）に残す。
//   決まりは app/lib/rag-watch.ts の ragWatchFindings（テスト付き）。止める: RAG_WATCH_DAILY_CRON=off。JST 5:25（営業時間の外）
import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { ragWatchStats, ragWatchFindings, type RagCallRow } from "@/app/lib/rag-watch";
import { ragRealProbeOn, runRealProbe, realProbeFindings, type RealProbeResult } from "@/app/lib/rag-real-probe";

export const maxDuration = 120; // 11/20: 本番に近い問いの9回（遅い時は1回 8秒の打ち切り）を足した
export const dynamic = "force-dynamic";

type Row = Pick<RagCallRow, "rpc" | "ok" | "rows" | "top_sim" | "ms" | "route">;
async function readRows(sb: SupabaseClient, fromIso: string, toIso: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < 200_000; i += 1000) {
    const { data, error } = await sb.from("rag_call_logs").select("rpc, ok, rows, top_sim, ms, route").gte("created_at", fromIso).lt("created_at", toIso).order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    const a = (data ?? []) as unknown as Row[];
    out.push(...a);
    if (a.length < 1000) break;
  }
  return out;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if ((process.env.RAG_WATCH_DAILY_CRON ?? "").trim().toLowerCase() === "off") return NextResponse.json({ ok: true, skipped: "RAG_WATCH_DAILY_CRON=off" });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const logId = await startCronLog("rag-watch-daily");
  try {
    const now = Date.now(), d = 86_400_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const [today, prev] = await Promise.all([readRows(sb, iso(now - d), iso(now)), readRows(sb, iso(now - 2 * d), iso(now - d))]);
    const stats = ragWatchStats(today);
    const prevCalls: Record<string, number> = {};
    for (const r of prev) prevCalls[r.rpc] = (prevCalls[r.rpc] ?? 0) + 1;
    const findings: Array<{ rpc: string; kind: string; detail?: string }> = [...ragWatchFindings(stats, prevCalls)];
    // 2026-11-20 作業員H（統括役の決め）: 本番に近い問い（embedding_cache の最近の問い）で3つの関数を本番と同じ引数で呼んで測る。
    //   夜の測りを表の中の行でやって本番と違った（11/18）をくり返さない。止める RAG_REAL_PROBE=off（app/lib/rag-real-probe.ts）
    let realProbe: RealProbeResult[] | null = null;
    if (ragRealProbeOn()) {
      try { realProbe = await runRealProbe(sb as never, 3); findings.push(...realProbeFindings(realProbe)); }
      catch (e) { findings.push({ rpc: "(本番に近い問い)", kind: "real_error", detail: e instanceof Error ? e.message : String(e) }); }
    }
    // 2026-11-21 作業員L（統括役の頼み）: 約束の取りこぼしの見張りを営業時間の外のこの便で数える（新しい cron は足さない・RAG の結果とは別・失敗しても RAG の見張りは止めない）。
    //   既定は記録だけ（cron_run_logs の promise-drop-watch）。送るのは PROMISE_DROP_WATCH=on の時に staff-todo-list の最初の便（app/lib/promise-drop-watch-server.ts）
    let promiseDrops: { mode: string; count: number } | null = null;
    try { const { recordPromiseDrops } = await import("@/app/lib/promise-drop-watch-server"); promiseDrops = await recordPromiseDrops(sb as never); }
    catch (e) { console.warn("[rag-watch-daily] promise-drop-watch skipped:", e instanceof Error ? e.message : String(e)); }
    const summary = today.length === 0 ? "RAG の記録が0行（RAG_WATCH が off か、包みが入っていない）"
      : `RAG ${stats.length}種・${today.length}回・拾い上げ ${findings.length}件${findings.length ? `（${findings.map((f) => `${f.rpc}:${f.kind}`).join("・")}）` : ""}`;
    const result = { summary, calls: today.length, stats, findings, real_probe: realProbe, promise_drops: promiseDrops };
    await finishCronLog(logId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, {}, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
