import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 60;

// B-3-①: 提案採択の学習ループ
// 直近30日の採択/却下ログ（action_pattern_logs.source =
// suggestion_accepted / suggestion_dismissed / prediction_match / prediction_mismatch）
// を集計して trigger_action_rules に action_type ごとの「真の予測一致率」を upsert する。
// - accepted 側: prediction_match（予測一致・送信完了）のみ
//   ※中3: suggestion_accepted（バナー「開く」）は同一送信で prediction_match と二重計上されるため total のみに含める
// - total 側: 上記 + suggestion_accepted + suggestion_dismissed（バナー「✕」）+ prediction_mismatch（予測外れ）+ suggestion_bypassed（提案無視で別行動）
//
// keyword は特殊キー "SUGGESTION_ACCEPT_RATE" を使用:
// - n-gram学習ルール（learn-trigger-rules）を上書きしない
// - suggest-next-action のキーワードマッチ（msg.includes(kw)）にも
//   チェーンルール（keyword = "AFTER:xxx"）にも誤マッチしない
const ACCEPT_RATE_KEYWORD = "SUGGESTION_ACCEPT_RATE";

// 中1: next_action_logs.was_accurate（予測精度）を action_type 別に集計して保存する特殊キー。
// suggest-next-action が読み取り、精度40%未満のアクションをランク下げする（isLowAccuracy）
const PREDICTION_ACCURACY_KEYWORD = "PREDICTION_ACCURACY";

// 中5: 提案経路別採択率の特殊キー接頭辞（SOURCE_ACCEPT_RATE:{action_type}:{suggestion_source}）。
// suggest-next-action が読み取り、keyword_hardcode 経由の採択率が低いアクションのキーワード判定をスキップする
const SOURCE_ACCEPT_RATE_PREFIX = "SOURCE_ACCEPT_RATE";

// 件数が少ないアクションはスキップ（統計的に無意味なため）
const MIN_SAMPLES = 5;

async function run() {
  // 学習ヘルスモニタリング用の実行記録（morning-report が cron_run_logs を読んで状態を報告する）
  const runLogId = await startCronLog("update-action-confidence");
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: logs, error } = await supabase
    .from("action_pattern_logs")
    .select("action_type, source, suggestion_source")
    .in("source", ["suggestion_accepted", "suggestion_dismissed", "prediction_match", "prediction_mismatch", "suggestion_bypassed"])
    .gte("created_at", thirtyDaysAgo)
    .limit(5000);

  if (error) {
    await finishCronLog(runLogId, false, undefined, error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // ※ 採択ログが0件でも中1の予測精度集計（next_action_logs）は実行するため早期returnしない

  // action_type ごとに採択/却下を集計
  // 中3: 同一AIX送信で suggestion_accepted（バナークリック）と prediction_match（送信完了）の
  // 2行が入り採択率が上振れするため、prediction_match のみを accepted の正とする。
  // - suggestion_accepted: total++ のみ（送信完了時の prediction_match が accepted を代表する）
  // - prediction_match:    accepted++ かつ total++
  // - dismissed系（suggestion_dismissed / prediction_mismatch / suggestion_bypassed）: total++ のみ
  const stats: Record<string, { accepted: number; total: number }> = {};
  // 中5: action_type × suggestion_source（提案経路）粒度の採択率。
  // どのルール経由（keyword_hardcode / trigger_rule / chain_rule / ai_fallback 等）の提案が
  // 実際に採択されているかを測り、suggest-next-action が低採択率ルートをスキップできるようにする
  const sourceStats: Record<string, { accepted: number; total: number }> = {};
  for (const log of logs ?? []) {
    const action = (log.action_type as string) ?? "";
    if (!action) continue;
    stats[action] ??= { accepted: 0, total: 0 };
    stats[action].total++;
    if (log.source === "prediction_match") stats[action].accepted++;

    const suggSource = (log.suggestion_source as string | null) ?? "";
    if (suggSource) {
      const key = `${action}:${suggSource}`;
      sourceStats[key] ??= { accepted: 0, total: 0 };
      sourceStats[key].total++;
      if (log.source === "prediction_match") sourceStats[key].accepted++;
    }
  }

  let updated = 0;
  let skipped = 0;
  const breakdown: Record<string, { accepted: number; total: number; confidence: number | null }> = {};

  for (const [action, { accepted, total }] of Object.entries(stats)) {
    if (total < MIN_SAMPLES) {
      skipped++;
      breakdown[action] = { accepted, total, confidence: null };
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

    if (upsertError) {
      console.error("[update-action-confidence] upsert error:", action, upsertError.message);
    } else {
      updated++;
      breakdown[action] = { accepted, total, confidence };
    }
  }

  // ── 中5: action_type × suggestion_source 粒度の採択率を SOURCE_ACCEPT_RATE:{action}:{source} で upsert ──
  let sourceUpdated = 0;
  const sourceBreakdown: Record<string, { accepted: number; total: number; confidence: number | null }> = {};
  for (const [key, { accepted, total }] of Object.entries(sourceStats)) {
    if (total < MIN_SAMPLES) {
      sourceBreakdown[key] = { accepted, total, confidence: null };
      continue;
    }
    const actionType = key.slice(0, key.indexOf(":"));
    const confidence = Math.round((accepted / total) * 1000) / 1000;
    const { error: upsertError } = await supabase.from("trigger_action_rules").upsert(
      {
        action_type: actionType,
        keyword: `${SOURCE_ACCEPT_RATE_PREFIX}:${key}`,
        occurrence_count: accepted,
        total_occurrence: total,
        confidence,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "action_type,keyword" }
    );
    if (upsertError) {
      console.error("[update-action-confidence] source upsert error:", key, upsertError.message);
    } else {
      sourceUpdated++;
      sourceBreakdown[key] = { accepted, total, confidence };
    }
  }

  // ── 中1: next_action_logs から action_type 別の was_accurate 率を集計して upsert ──
  // suggest-next-action が keyword='PREDICTION_ACCURACY' として参照し、
  // 精度40%未満（かつサンプル5件以上）のアクションをランク下げする
  let accuracyUpdated = 0;
  const accuracyBreakdown: Record<string, { accurate: number; total: number; accuracy: number | null }> = {};
  const { data: accuracyLogs, error: accuracyError } = await supabase
    .from("next_action_logs")
    .select("actual_aix_type, was_accurate")
    .eq("validated", true)
    .not("actual_aix_type", "is", null)
    .not("was_accurate", "is", null)
    .gte("validated_at", thirtyDaysAgo)
    .limit(5000);

  if (accuracyError) {
    console.error("[update-action-confidence] next_action_logs 取得エラー:", accuracyError.message);
  } else {
    const accuracyStats: Record<string, { accurate: number; total: number }> = {};
    for (const log of accuracyLogs ?? []) {
      const action = (log.actual_aix_type as string) ?? "";
      if (!action) continue;
      accuracyStats[action] ??= { accurate: 0, total: 0 };
      accuracyStats[action].total++;
      if (log.was_accurate === true) accuracyStats[action].accurate++;
    }

    for (const [action, { accurate, total }] of Object.entries(accuracyStats)) {
      if (total < MIN_SAMPLES) {
        accuracyBreakdown[action] = { accurate, total, accuracy: null };
        continue;
      }
      const accuracy = Math.round((accurate / total) * 1000) / 1000;
      const { error: upsertError } = await supabase.from("trigger_action_rules").upsert(
        {
          action_type: action,
          keyword: PREDICTION_ACCURACY_KEYWORD,
          occurrence_count: accurate,
          total_occurrence: total,
          confidence: accuracy,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "action_type,keyword" }
      );
      if (upsertError) {
        console.error("[update-action-confidence] accuracy upsert error:", action, upsertError.message);
      } else {
        accuracyUpdated++;
        accuracyBreakdown[action] = { accurate, total, accuracy };
      }
    }
  }

  // ── H2: サブモード予測の採択率集計（%_submode のログから）──
  // suggest-next-action が keyword='SUBMODE_ACCEPT:{action_type}_submode' として参照し、
  // ピッカー提案時のサブモードデフォルト選択に使う
  let submodeUpdated = 0;
  const submodeBreakdown: Record<string, { accepted: number; total: number; rate: number | null }> = {};
  const { data: submodeLogs, error: submodeError } = await supabase
    .from("action_pattern_logs")
    .select("action_type, source")
    .like("action_type", "%_submode")
    .in("source", ["prediction_accepted", "prediction_bypassed", "prediction_match", "suggestion_dismissed"])
    .gte("created_at", thirtyDaysAgo)
    .limit(3000);

  if (submodeError) {
    console.error("[update-action-confidence] submode logs 取得エラー:", submodeError.message);
  } else {
    const submodeStats: Record<string, { accepted: number; total: number }> = {};
    for (const log of submodeLogs ?? []) {
      const at = (log.action_type as string) ?? "";
      if (!at) continue;
      submodeStats[at] ??= { accepted: 0, total: 0 };
      submodeStats[at].total += 1;
      if (log.source === "prediction_accepted" || log.source === "prediction_match") {
        submodeStats[at].accepted += 1;
      }
    }

    // SUBMODE_ACCEPT:{action_type} として trigger_action_rules に保存
    // ※ サンプル3件未満は統計的に無意味なためスキップ
    for (const [actionType, stats] of Object.entries(submodeStats)) {
      if (stats.total < 3) {
        submodeBreakdown[actionType] = { ...stats, rate: null };
        continue;
      }
      const rate = Math.round((stats.accepted / stats.total) * 1000) / 1000;
      const { error: upsertError } = await supabase.from("trigger_action_rules").upsert(
        {
          keyword: `SUBMODE_ACCEPT:${actionType}`,
          action_type: actionType.replace(/_submode$/, ""), // 親アクション
          occurrence_count: stats.accepted,
          total_occurrence: stats.total,
          confidence: rate,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "action_type,keyword" }
      );
      if (upsertError) {
        console.error("[update-action-confidence] submode upsert error:", actionType, upsertError.message);
      } else {
        submodeUpdated++;
        submodeBreakdown[actionType] = { ...stats, rate };
      }
    }
  }

  await finishCronLog(runLogId, true, {
    total_logs: (logs ?? []).length,
    updated,
    skipped,
    source_updated: sourceUpdated,
    accuracy_updated: accuracyUpdated,
    submode_updated: submodeUpdated,
  });
  return NextResponse.json({
    ok: true,
    total_logs: (logs ?? []).length,
    updated,
    skipped,
    breakdown,
    source_updated: sourceUpdated,
    source_breakdown: sourceBreakdown,
    accuracy_updated: accuracyUpdated,
    accuracy_breakdown: accuracyBreakdown,
    submode_updated: submodeUpdated,
    submode_breakdown: submodeBreakdown,
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
