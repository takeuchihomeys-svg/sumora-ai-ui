import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { analyzeAndSaveBrainMeta, BRAIN_SKIP_STATUSES } from "@/app/lib/brain-core";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

// ── brain-sweep: 脳分析バックストップ（5分毎）─────────────────────────────
// FIX(Fable5 #2): 分析の主経路は line-webhook のイベント駆動（顧客メッセージ受信 =
// suggested_aix_meta を消すのと同じ場所で再分析）。本 cron は webhook の分析が
// 失敗/中断した会話（meta が null のまま残った行）だけを拾う保険。
// 通常運転ではほぼ毎回 0 件（純粋な DB read のみ）で終わる。
// 旧 brain-weekly（週100件のHaiku分析 → webhookのwipeで全破棄される金銭浪費）は廃止した。

export const maxDuration = 120;

// 1回の sweep で分析する最大会話数（コスト・レイテンシガード）
const MAX_SWEEP_PER_RUN = 10;

// webhook の after() 分析が進行中の可能性がある直近の会話はスキップ（二重分析防止）
// M4(Fable5): 2分→3分 — 旧値は webhook の maxDuration=120秒とちょうど同値で、境界上の after() 分析と
// 二重分析になり得た。maxDuration を超える猶予にして境界レースを解消
const IN_FLIGHT_GRACE_MS = 3 * 60 * 1000; // 3 minutes

// H3(Fable5): 失敗バックオフ — analyzeAndSaveBrainMeta は失敗時も brain_analyzed_at を書くため、
// 直近30分以内に試行済みの行は再試行しない（決定的に失敗する会話の永久リトライ・sweep飢餓を防ぐ）
const RETRY_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const runLogId = await startCronLog("brain-sweep");

  try {
    const cutoff = new Date(Date.now() - IN_FLIGHT_GRACE_MS).toISOString();
    const backoffCutoff = new Date(Date.now() - RETRY_BACKOFF_MS).toISOString();
    const { data: conversations, error } = await supabase
      .from("conversations")
      .select("id")
      .is("suggested_aix_meta", null)
      // B7(Fable5): 旧 .not("status","in",...) は SQL の NOT IN で NULL 行を除外してしまう
      // （writer 側の analyzeAndSaveBrainMeta は null status を許容 → 永久に分析されない盲点だった）
      .or(`status.is.null,status.not.in.(${BRAIN_SKIP_STATUSES.join(",")})`)
      // H3(Fable5): 30分バックオフ（未試行 or 前回試行から30分経過した行のみ）
      .or(`brain_analyzed_at.is.null,brain_analyzed_at.lt.${backoffCutoff}`)
      .lt("updated_at", cutoff)
      .order("updated_at", { ascending: false })
      .limit(MAX_SWEEP_PER_RUN);

    if (error) {
      await finishCronLog(runLogId, false, undefined, error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const rows = (conversations ?? []) as Array<{ id: string }>;
    if (rows.length === 0) {
      await finishCronLog(runLogId, true, { processed: 0 });
      return NextResponse.json({ ok: true, processed: 0 });
    }

    let processed = 0;
    let failed = 0;
    await withConcurrency(rows, 3, async (conv) => {
      const saved = await analyzeAndSaveBrainMeta(conv.id).catch((e) => {
        // B10(Fable5): 旧実装は throw されたエラーメッセージも握り潰していた
        console.error("[brain-sweep] analyze failed:", conv.id, e instanceof Error ? e.message : e);
        return false;
      });
      if (saved) processed++;
      else failed++;
    });

    const result = { processed, failed, total: rows.length };
    await finishCronLog(runLogId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(runLogId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
