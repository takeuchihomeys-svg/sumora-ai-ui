import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 300;

// POST /api/cron/aix-shadow-eval（毎日 JST 20:00）
// シャドーモード: 実際には自動送信せず「もし自動だったら何%一致したか」を計測する精度計測基盤。
//
// フロー:
// 1. 前日(JST)の aix_usage_logs を取得
// 2. 各レコードの AIX 送信直前の顧客メッセージを取得
// 3. suggest-next-action を自サーバー fetch で呼び、predicted_aix_type を取得
// 4. actual_aix_type（実際に押された）と比較して matched を aix_shadow_logs に記録
// 5. 結果サマリーを ai_prompts に key='shadow_eval_latest' で保存
//
// 注意（既知の近似）: suggest-next-action は現在のDB状態（会話ステータス・メッセージ履歴）で
// 判定するため、送信当時の状態と完全一致ではない。傾向計測としては十分なので許容する。
const EVAL_LIMIT = 30; // maxDuration 300秒 / 1件あたり最大約8秒（Sonnetフォールバック含む）

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const runLogId = await startCronLog("aix-shadow-eval");

  try {
    // JST今日00:00 / 昨日00:00 をUTCで計算
    const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
    const todayStart = new Date(Date.UTC(
      nowJst.getUTCFullYear(),
      nowJst.getUTCMonth(),
      nowJst.getUTCDate()
    ) - 9 * 3600 * 1000);
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 3600 * 1000);
    const reportDate = yesterdayStart.toISOString().slice(0, 10);

    // 1. 前日の aix_usage_logs（sent_at は NULL がありうるため created_at で範囲抽出し、
    //    送信時刻としては sent_at ?? created_at を採用する）
    const { data: usageLogs, error: usageErr } = await supabase
      .from("aix_usage_logs")
      .select("id, conversation_id, aix_type, previous_action_type, sent_at, created_at")
      .gte("created_at", yesterdayStart.toISOString())
      .lt("created_at", todayStart.toISOString())
      .order("created_at", { ascending: true })
      .limit(EVAL_LIMIT);

    if (usageErr) {
      await finishCronLog(runLogId, false, undefined, usageErr.message);
      return NextResponse.json({ ok: false, error: usageErr.message }, { status: 500 });
    }

    const logs = (usageLogs ?? []) as Array<{
      id: string;
      conversation_id: string;
      aix_type: string;
      previous_action_type: string | null;
      sent_at: string | null;
      created_at: string;
    }>;

    if (logs.length === 0) {
      await finishCronLog(runLogId, true, { evaluated: 0, note: "no usage logs yesterday" });
      return NextResponse.json({ ok: true, evaluated: 0 });
    }

    // 手動再実行時の重複評価を防止（usage_log_id で既評価分をスキップ）
    const { data: existingRows } = await supabase
      .from("aix_shadow_logs")
      .select("usage_log_id")
      .in("usage_log_id", logs.map((l) => l.id));
    const evaluatedIds = new Set(((existingRows ?? []) as Array<{ usage_log_id: string | null }>).map((r) => r.usage_log_id));

    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

    let evaluated = 0;
    let matchedCount = 0;
    const sourceCounts: Record<string, { total: number; matched: number }> = {};
    // Fix-1a: collect per-evaluated-row feedback for confidence update
    const sessionFeedback: Array<{ action_type: string; matched: boolean }> = [];

    for (const log of logs) {
      if (evaluatedIds.has(log.id)) continue;
      const sendTime = log.sent_at ?? log.created_at;

      try {
        // 2. AIX送信直前の顧客メッセージ（受信時点の入力を再現する）
        const { data: lastMsg } = await supabase
          .from("messages")
          .select("text")
          .eq("conversation_id", log.conversation_id)
          .eq("sender", "customer")
          .lt("created_at", sendTime)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // 3. suggest-next-action を裏で実行（自動送信はしない）
        const res = await fetch(`${baseUrl}/api/suggest-next-action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: log.conversation_id,
            last_aix_action: log.previous_action_type ?? null,
            customer_message: (lastMsg?.text as string | undefined) ?? null,
          }),
          signal: AbortSignal.timeout(25_000),
        });
        if (!res.ok) continue;

        const suggestion = await res.json() as { action?: string | null; source?: string | null };
        const predicted = suggestion.action ?? null;
        const source = suggestion.source ?? null;
        const matched = predicted !== null && predicted === log.aix_type;

        // 4. 比較結果を記録
        const { error: insertErr } = await supabase.from("aix_shadow_logs").insert({
          usage_log_id: log.id,
          conversation_id: log.conversation_id,
          predicted_aix_type: predicted,
          actual_aix_type: log.aix_type,
          matched,
          source,
          predicted_at: sendTime,
          evaluated_at: new Date().toISOString(),
        });
        if (insertErr) {
          console.error("[aix-shadow-eval] insert failed:", insertErr.message);
          continue;
        }

        evaluated += 1;
        if (matched) matchedCount += 1;
        const srcKey = source ?? "none";
        sourceCounts[srcKey] ??= { total: 0, matched: 0 };
        sourceCounts[srcKey].total += 1;
        if (matched) sourceCounts[srcKey].matched += 1;
        // Fix-1a: record feedback only when a prediction was made (predicted != null)
        if (predicted !== null) {
          sessionFeedback.push({ action_type: predicted, matched });
        }
      } catch (e) {
        // 1件の失敗で全体を止めない（タイムアウト等）
        console.error("[aix-shadow-eval] eval failed for", log.id, e);
      }
    }

    // 6. Fix-1a: trigger_action_rules の confidence をフィードバック更新
    // sessionFeedback は今セッションで新たに評価した行のみを含む（重複評価は evaluatedIds で防止済み）。
    // predicted_aix_type 単位で matched/mismatched を集計し、差分に応じて
    //   mismatched 超過 → confidence × 0.95 （フロア 10）
    //   matched 超過   → confidence × 1.02 （シーリング 100）
    // を1回だけ適用する。これにより外れ続けるルールを徐々に降格できる。
    let rulesUpdated = 0;
    if (sessionFeedback.length > 0) {
      try {
        // predicted_aix_type ごとに集計
        const feedbackByType: Record<string, { matched: number; mismatched: number }> = {};
        for (const fb of sessionFeedback) {
          feedbackByType[fb.action_type] ??= { matched: 0, mismatched: 0 };
          if (fb.matched) feedbackByType[fb.action_type].matched++;
          else feedbackByType[fb.action_type].mismatched++;
        }

        for (const [actionType, counts] of Object.entries(feedbackByType)) {
          const netMismatch = counts.mismatched - counts.matched;
          if (netMismatch === 0) continue; // 相殺 → 変更なし

          // action_type に紐づくルールをすべて取得
          const { data: rules } = await supabase
            .from("trigger_action_rules")
            .select("id, confidence")
            .eq("action_type", actionType);
          if (!rules?.length) continue;

          for (const rule of rules as Array<{ id: string; confidence: number }>) {
            const current = rule.confidence ?? 50;
            let next: number;
            if (netMismatch > 0) {
              // ミスマッチ超過 → ペナルティ（×0.95 / フロア 10）
              next = Math.max(current * 0.95, 10);
            } else {
              // マッチ超過 → ブースト（×1.02 / シーリング 100）
              next = Math.min(current * 1.02, 100);
            }
            // 丸めて変化があるときだけ書き込む
            const nextRounded = Math.round(next * 1000) / 1000;
            if (nextRounded === current) continue;

            const { error: updateErr } = await supabase
              .from("trigger_action_rules")
              .update({ confidence: nextRounded, updated_at: new Date().toISOString() })
              .eq("id", rule.id);
            if (!updateErr) rulesUpdated++;
          }
        }
        console.log(`[aix-shadow-eval] confidence feedback: ${rulesUpdated} rules updated`);
      } catch (e) {
        // フィードバック失敗でも全体は止めない
        console.error("[aix-shadow-eval] confidence feedback failed:", e);
      }
    }

    // 5. サマリーを ai_prompts に保存（UIから確認可能）
    const matchRate = evaluated > 0 ? Math.round((matchedCount / evaluated) * 1000) / 1000 : null;
    const summary = {
      report_date: reportDate,
      target_logs: logs.length,
      evaluated,
      matched: matchedCount,
      match_rate: matchRate,
      by_source: sourceCounts,
      rules_updated: rulesUpdated,
      evaluated_at: new Date().toISOString(),
    };
    await supabase.from("ai_prompts").upsert(
      {
        key: "shadow_eval_latest",
        label: "自動返信シャドー評価（最新）",
        content: JSON.stringify(summary, null, 2),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );

    await finishCronLog(runLogId, true, { evaluated, matched: matchedCount, match_rate: matchRate, rules_updated: rulesUpdated });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("[aix-shadow-eval]", e);
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

// GET: Vercel CronはGETでリクエストするため、認証チェック後POSTへ委譲
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
