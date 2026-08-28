import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { runBrainAndNotify, BRAIN_SKIP_STATUSES } from "@/app/lib/brain-core";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

// ── brain-sweep: 脳分析バックストップ（5分毎）─────────────────────────────
// FIX(Fable5 #2): 分析の主経路は line-webhook のイベント駆動（顧客メッセージ受信 =
// suggested_aix_meta を消すのと同じ場所で再分析）。本 cron は webhook の分析が
// 失敗/中断した会話（meta が null のまま残った行）だけを拾う保険。
// 通常運転ではほぼ毎回 0 件（純粋な DB read のみ）で終わる。
// 旧 brain-weekly（週100件のHaiku分析 → webhookのwipeで全破棄される金銭浪費）は廃止した。

export const maxDuration = 120;

// 1回の sweep で分析する最大会話数（コスト・レイテンシガード）
// claude-sonnet-5 extended thinking: 1件最大60s × 並列3 = 1ラウンド最大60s → maxDuration=120s 内に収まるよう3件に制限
const MAX_SWEEP_PER_RUN = 3;

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
      // FIX(post-Fable5): sweep の存在意義は「webhook brain が失敗した会話の補填」。
      // webhook は顧客メッセージ受信時のみ brain を起動するため、失敗行は必ず last_sender="customer"。
      // staff が返信済みの行（last_sender="staff"）は次の顧客メッセージで webhook brain が必ず走るため sweep 不要。
      // このフィルタにより: (a) staff 返信30分後の sweep によるバナー復活を根絶、
      // (b) staff 返信ごとの無駄 Sonnet 呼び出しを削減。副作用なし（本来対象は全て条件を満たす）。
      .eq("last_sender", "customer")
      // B7(Fable5): 旧 .not("status","in",...) は SQL の NOT IN で NULL 行を除外してしまう
      // （writer 側の analyzeAndSaveBrainMeta は null status を許容 → 永久に分析されない盲点だった）
      .or(`status.is.null,status.not.in.(${BRAIN_SKIP_STATUSES.join(",")})`)
      // H3(Fable5): 30分バックオフ（未試行 or 前回試行から30分経過した行のみ）
      .or(`brain_analyzed_at.is.null,brain_analyzed_at.lt.${backoffCutoff}`)
      .lt("updated_at", cutoff)
      // FIX: SQL の neq は NULL 行を除外する（NULL比較は常にFALSE）。brain失敗行は
      // ai_draft が NULL のことが多く、まさに sweep が拾うべき行が漏れていた
      .or("ai_draft.is.null,ai_draft.neq.__SHOWN__")
      .order("updated_at", { ascending: false })
      .limit(MAX_SWEEP_PER_RUN);

    if (error) {
      await finishCronLog(runLogId, false, undefined, error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const rows = (conversations ?? []) as Array<{ id: string }>;
    if (rows.length === 0) {
      console.log("[brain-sweep] 対象なし（0件）— suggested_aix_meta=null の会話はありません");
      await finishCronLog(runLogId, true, { processed: 0 });
      return NextResponse.json({ ok: true, processed: 0 });
    }

    let processed = 0;
    let failed = 0;
    await withConcurrency(rows, 3, async (conv) => {
      const saved = await runBrainAndNotify(conv.id).catch((e) => {
        // B10(Fable5): 旧実装は throw されたエラーメッセージも握り潰していた
        const msg = e instanceof Error ? e.message : String(e);
        const kind = msg.includes("timed out") || msg.includes("timeout") ? "timeout" : "error";
        console.error(`[brain-sweep] analyze failed [${kind}]:`, conv.id, msg);
        return false;
      });
      if (saved) processed++;
      else failed++;
    });

    console.log(`[brain-sweep] 完了: 対象${rows.length}件 / 成功${processed}件 / 失敗${failed}件`);

    const result = { processed, failed, total: rows.length };
    await finishCronLog(runLogId, true, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(runLogId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
