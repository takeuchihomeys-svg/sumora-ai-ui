import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 60;

// POST /api/cron/eval-winning-pattern（毎週月曜 JST 9:00 = UTC 0:00）
// 中1: winning_pattern の成果検証ループ。
// customer-summary が winning_pattern_logs に記録した予測のうち actual_outcome IS NULL の直近60日分を取得し、
// 対応する conversations.status が closed_won / closed_lost に確定していれば
// actual_outcome を記録し、Sonnet で「予測パターンは結果と整合していたか」を判定して was_correct を更新する。
// 結果サマリーは ai_prompts の key='winning_pattern_eval_latest' に upsert する。
const BATCH_LIMIT = 200;
const JUDGE_CHUNK = 20;

type PatternLog = {
  id: string;
  conversation_id: string;
  predicted_pattern: string;
  created_at: string;
};

// ── Sonnet 4.6 呼び出し（save-reply-example の callClaude と同パターン）────────
async function callSonnet(prompt: string, maxTokens = 2048): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return "";
    const data = await res.json() as { content?: Array<{ text: string }> };
    return data.content?.[0]?.text?.trim() || "";
  } catch {
    return "";
  }
}

// ── Sonnet で予測 vs 実結果の正否をまとめて判定（JUDGE_CHUNK件ずつ）────────────
async function judgeWithSonnet(
  items: Array<{ id: string; predicted_pattern: string; actual_outcome: string }>
): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>();
  for (let i = 0; i < items.length; i += JUDGE_CHUNK) {
    const chunk = items.slice(i, i + JUDGE_CHUNK);
    const listText = chunk
      .map((it, idx) => `${idx + 1}. [id:${it.id}] 結果:${it.actual_outcome === "closed_won" ? "成約" : "失注"} / 予測パターン:「${it.predicted_pattern}」`)
      .join("\n");
    const text = await callSonnet(`あなたは賃貸仲介営業のAIコーチです。
AIが会話中に予測した「成約につながる決まるパターン（winning_pattern）」と、その後の実際の結果（成約=closed_won / 失注=closed_lost）を突合し、予測が正しかったかを判定してください。

判定基準:
・成約（closed_won）した場合 → 予測パターンが成約への道筋として妥当だったなら true、成約はしたが予測が的外れ（無関係な行動を推奨していた）なら false
・失注（closed_lost）した場合 → 予測パターンが実行可能で妥当だったのに結果が伴わなかった、または予測自体が的外れだった → false。ただし失注理由が予測と無関係な外部要因（他社決定・引越し中止等）と推測でき、予測自体は筋が良かった場合のみ true

【判定対象】
${listText}

JSONのみで返答（説明不要）:
{"results": [{"id": "...", "was_correct": true}, ...]}`);
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) continue;
      const parsed = JSON.parse(match[0]) as { results?: Array<{ id: string; was_correct: boolean }> };
      for (const r of parsed.results ?? []) {
        if (typeof r.id === "string" && typeof r.was_correct === "boolean") {
          verdicts.set(r.id, r.was_correct);
        }
      }
    } catch (e) {
      console.warn("[eval-winning-pattern] Sonnet判定JSONパース失敗（このチャンクはスキップ）:", e);
    }
  }
  return verdicts;
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const runLogId = await startCronLog("eval-winning-pattern");

  try {
    const since60d = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();

    // 未評価（actual_outcome IS NULL）の直近60日分
    const { data: pendingLogs, error: logsErr } = await supabase
      .from("winning_pattern_logs")
      .select("id, conversation_id, predicted_pattern, created_at")
      .is("actual_outcome", null)
      .gte("created_at", since60d)
      .order("created_at", { ascending: false })
      .limit(BATCH_LIMIT);

    if (logsErr) {
      await finishCronLog(runLogId, false, undefined, logsErr.message);
      return NextResponse.json({ ok: false, error: logsErr.message }, { status: 500 });
    }

    const logs = (pendingLogs ?? []) as PatternLog[];
    if (logs.length === 0) {
      await finishCronLog(runLogId, true, { evaluated: 0, pending: 0 });
      return NextResponse.json({ ok: true, evaluated: 0, pending: 0 });
    }

    // 対応する conversations.status を一括取得
    const convIds = [...new Set(logs.map(l => l.conversation_id))];
    const { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id, status")
      .in("id", convIds);
    if (convErr) {
      await finishCronLog(runLogId, false, undefined, convErr.message);
      return NextResponse.json({ ok: false, error: convErr.message }, { status: 500 });
    }
    const statusByConv = new Map(
      ((convs ?? []) as Array<{ id: string; status: string }>).map(c => [c.id, c.status])
    );

    // 成約/失注が確定した予測のみ評価対象（それ以外は次回まで pending のまま）
    const resolved = logs
      .map(l => ({ ...l, outcome: statusByConv.get(l.conversation_id) }))
      .filter((l): l is PatternLog & { outcome: string } =>
        l.outcome === "closed_won" || l.outcome === "closed_lost"
      );

    if (resolved.length === 0) {
      await finishCronLog(runLogId, true, { evaluated: 0, pending: logs.length });
      return NextResponse.json({ ok: true, evaluated: 0, pending: logs.length });
    }

    // Sonnet で予測 vs 結果の正否を判定
    const verdicts = await judgeWithSonnet(
      resolved.map(l => ({ id: l.id, predicted_pattern: l.predicted_pattern, actual_outcome: l.outcome }))
    );

    // actual_outcome + was_correct を UPDATE（Sonnet判定が得られなかった行は outcome のみ記録）
    let correct = 0;
    let wrong = 0;
    for (const l of resolved) {
      const wasCorrect = verdicts.has(l.id) ? verdicts.get(l.id)! : null;
      if (wasCorrect === true) correct += 1;
      if (wasCorrect === false) wrong += 1;
      await supabase
        .from("winning_pattern_logs")
        .update({ actual_outcome: l.outcome, was_correct: wasCorrect })
        .eq("id", l.id);
    }

    const judged = correct + wrong;
    const accuracy = judged > 0 ? Math.round((correct / judged) * 1000) / 1000 : null;
    const summary = {
      evaluated: resolved.length,
      judged,
      correct,
      wrong,
      accuracy,
      won: resolved.filter(l => l.outcome === "closed_won").length,
      lost: resolved.filter(l => l.outcome === "closed_lost").length,
      pending: logs.length - resolved.length,
      evaluated_at: new Date().toISOString(),
    };

    // 結果サマリーを ai_prompts に保存（key='winning_pattern_eval_latest'）
    await supabase.from("ai_prompts").upsert({
      key: "winning_pattern_eval_latest",
      label: "winning_pattern 成果検証（週次・最新）",
      content: JSON.stringify(summary),
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });

    await finishCronLog(runLogId, true, summary);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("[eval-winning-pattern]", e);
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

// GET: Vercel Cron は GET でリクエストするため、認証チェック後 POST へ委譲
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
