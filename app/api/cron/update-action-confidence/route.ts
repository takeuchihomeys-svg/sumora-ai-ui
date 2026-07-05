import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

// B-3-①: 提案採択の学習ループ
// 直近30日の採択/却下ログ（action_pattern_logs.source =
// suggestion_accepted / suggestion_dismissed / prediction_match / prediction_mismatch）
// を集計して trigger_action_rules に action_type ごとの「真の予測一致率」を upsert する。
// - accepted 側: suggestion_accepted（バナー「開く」）+ prediction_match（予測一致）
// - rejected 側: suggestion_dismissed（バナー「✕」）+ prediction_mismatch（予測外れ）+ suggestion_bypassed（提案無視で別行動）
//
// keyword は特殊キー "SUGGESTION_ACCEPT_RATE" を使用:
// - n-gram学習ルール（learn-trigger-rules）を上書きしない
// - suggest-next-action のキーワードマッチ（msg.includes(kw)）にも
//   チェーンルール（keyword = "AFTER:xxx"）にも誤マッチしない
const ACCEPT_RATE_KEYWORD = "SUGGESTION_ACCEPT_RATE";

// 件数が少ないアクションはスキップ（統計的に無意味なため）
const MIN_SAMPLES = 5;

async function run() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: logs, error } = await supabase
    .from("action_pattern_logs")
    .select("action_type, source")
    .in("source", ["suggestion_accepted", "suggestion_dismissed", "prediction_match", "prediction_mismatch", "suggestion_bypassed"])
    .gte("created_at", thirtyDaysAgo)
    .limit(5000);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!logs?.length) {
    return NextResponse.json({ ok: true, updated: 0, skipped: 0, message: "no adoption logs in last 30 days" });
  }

  // action_type ごとに採択/却下を集計
  // accepted: suggestion_accepted + prediction_match
  // dismissed: suggestion_dismissed + prediction_mismatch + suggestion_bypassed
  const stats: Record<string, { accepted: number; dismissed: number }> = {};
  for (const log of logs) {
    const action = (log.action_type as string) ?? "";
    if (!action) continue;
    stats[action] ??= { accepted: 0, dismissed: 0 };
    if (log.source === "suggestion_accepted" || log.source === "prediction_match") stats[action].accepted++;
    else stats[action].dismissed++;
  }

  let updated = 0;
  let skipped = 0;
  const breakdown: Record<string, { accepted: number; dismissed: number; confidence: number | null }> = {};

  for (const [action, { accepted, dismissed }] of Object.entries(stats)) {
    const total = accepted + dismissed;
    if (total < MIN_SAMPLES) {
      skipped++;
      breakdown[action] = { accepted, dismissed, confidence: null };
      continue;
    }

    const confidence = Math.round((accepted / total) * 1000) / 1000;
    const { error: upsertError } = await supabase.from("trigger_action_rules").upsert(
      {
        action_type: action,
        keyword: ACCEPT_RATE_KEYWORD,
        occurrence_count: accepted,
        total_occurrence: total,
        confidence,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "action_type,keyword" }
    );

    if (!upsertError) {
      updated++;
      breakdown[action] = { accepted, dismissed, confidence };
    }
  }

  return NextResponse.json({
    ok: true,
    total_logs: logs.length,
    updated,
    skipped,
    breakdown,
  });
}

// GET: Vercel cron から呼ばれる（Authorization: Bearer <CRON_SECRET> を自動付与）
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return run();
}

// POST: 手動実行用
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return run();
}
