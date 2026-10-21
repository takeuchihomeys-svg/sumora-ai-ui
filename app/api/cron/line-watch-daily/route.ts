// GET /api/cron/line-watch-daily  （Vercel Cron・毎日 JST 20:50 = UTC 11:50・vercel.json "50 11 * * *"・line-watch-eval（20:40）の後）
// LINE の見張りの毎日のまとめ（2026-10-01 竹内「見張りの2段目おこなう」・設計 line-watch-design.md §6）:
//   場面ごとの一致率（解禁の線までの残り・停止の線）・最終チェックの段ごとの指摘・返信遅れ・約束の未対応・カレンダー C1〜C7
//   （C7＝申込ツールの daily_tasks との食い違い・読むだけ）・物件検索・👍✋ を数え、「知らせる事」を決まった線で出す（app/lib/line-watch-daily.ts）。
//   LLM は呼ばない。結果は cron_run_logs.result_json（画面 /watch の「今日のまとめ」が読む）。LINE には送らない（売上番長グループは今まで通り AIX要対応だけ）。
//   2026-10-16: 同じ回で大きく直された番の拾い出し（edited-turn-miner・cron_run_logs の edited-turn-miner・数だけ）も回す。止める EDITED_TURN_MINER=off
//   ?dry=1 … 記録しない
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { buildLineWatchDailyReport } from "@/app/lib/line-watch-eval-server";
import { mineEditedTurns } from "@/app/lib/edited-turn-miner-server";
import { compactMined, editedTurnMinerEnabled } from "@/app/lib/edited-turn-miner";

export const maxDuration = 120;

/**
 * 2026-10-16 竹内さん「毎日、AI の下書き・AIX の文と実際に送った文を比べ、大きく直された番を自動で拾う」（app/lib/edited-turn-miner.ts）。
 *   窓は 48〜24時間前に始まった番（判定が閉じた番を1回ずつ数える）。DB を読むだけ・LLM なし・$0。結果は cron_run_logs の edited-turn-miner に数だけ
 *   （箱・型・場面・弱い所の候補の上位・関係する設計知見 id・代表の番は会話の hash の頭8字）＝文は残さない。試験の問題は手元の scripts/edited-turn-miner.ts。
 *   止める: EDITED_TURN_MINER=off。失敗しても毎日のまとめは止めない
 */
async function runEditedTurnMiner(dry: boolean): Promise<Record<string, unknown> | null> {
  if (!editedTurnMinerEnabled()) return null;
  const logId = dry ? null : await startCronLog("edited-turn-miner");
  try {
    const now = Date.now();
    const r = await mineEditedTurns(supabase, { sinceMs: now - 48 * 3600_000, untilMs: now - 24 * 3600_000 });
    const out = { ok: r.ok, since: r.since, until: r.until, skipped: r.skipped, ...compactMined(r.turns, r.pairs), errors: r.errors.slice(0, 5) };
    await finishCronLog(logId, r.ok, out, r.errors[0]);
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, { ok: false, error: msg }, msg);
    return { ok: false, error: msg };
  }
}
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const logId = dry ? null : await startCronLog("line-watch-daily");
  try {
    const report = await buildLineWatchDailyReport(supabase);
    const errText = Object.entries(report.errors).map(([k, v]) => `${k}: ${v}`).join(" / ");
    // 欄が1つ読めなくても、まとめは残す（ok は「全部読めた」か）
    await finishCronLog(logId, report.ok, report as unknown as Record<string, unknown>, errText || undefined);
    const editedTurns = await runEditedTurnMiner(dry);
    return NextResponse.json({ ...report, editedTurns }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[line-watch-daily] failed:", msg);
    await finishCronLog(logId, false, { error: msg }, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
