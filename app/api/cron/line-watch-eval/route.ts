// GET /api/cron/line-watch-eval  （Vercel Cron・毎日 JST 20:40 = UTC 11:40・vercel.json "40 11 * * *"・brain-aix-eval（20:20）の後）
// LINE の見張り 2段目の突き合わせ（2026-10-01 竹内「見張りの2段目おこなう」・設計 line-watch-design.md §3.2）:
//   番ごとに「実際」の列（staff_first_at・staff_texts・staff_aix・decision_id・draft_ready_before_staff）を埋め、
//   AI の案と比べた判定（verdict・verdict_detail・scene_key・judge_version）を決まった規則で書く（app/lib/line-watch-judge.ts）。
//   LLM は呼ばない。書くのは line_watch_turns の2段目の列だけ（送信・会話・AIX には触らない）。結果は cron_run_logs.result_json。
//   ?dry=1 … 書かない（判定の結果だけ返す）／ ?days=N … 直近 N 日の番をやり直す（既定4）
//   止め方: vercel.json から外す（書くのはこの表の列だけなので、止めても他は何も変わらない）
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { evaluateLineWatchTurns } from "@/app/lib/line-watch-eval-server";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const daysRaw = Number(req.nextUrl.searchParams.get("days") ?? "");
  const days = Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 30 ? Math.floor(daysRaw) : undefined;
  const logId = dry ? null : await startCronLog("line-watch-eval");
  try {
    const r = await evaluateLineWatchTurns(supabase, { dry, days });
    console.log(JSON.stringify({ tag: "cron:line-watch-eval", dry, read: r.read, judged: r.judged, pending: r.pending, updated: r.updated, failed: r.failed, orphans: r.orphans }));
    await finishCronLog(logId, r.ok, r as unknown as Record<string, unknown>, r.errors[0]);
    return NextResponse.json(r, { status: r.ok ? 200 : 500 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[line-watch-eval] failed:", msg);
    await finishCronLog(logId, false, { error: msg }, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
