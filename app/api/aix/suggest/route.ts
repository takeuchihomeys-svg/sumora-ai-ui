// GET /api/aix/suggest?conversation_status=proposing&conversation_id=xxx
// action_pattern_logs の蓄積データから「このステータスで次に押すべきAIXボタン」を提案する
// データが少ない場合は null を返す（UI側はフォールバック）

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { normalizeStatus } from "@/app/lib/status-normalize";

export const maxDuration = 10;

// post_aix_* のステータスは推薦ログであり、ボタン押下パターンではないので除外
const EXCLUDE_STATUS_PREFIX = "post_aix_";

type PatternRow = { conversation_status: string; action_type: string };

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rawStatus = searchParams.get("conversation_status") ?? "";
    const conversationId = searchParams.get("conversation_id") ?? null;

    if (!rawStatus) {
      return NextResponse.json({ ok: false, error: "conversation_status required" }, { status: 400 });
    }

    const status = normalizeStatus(rawStatus);

    // ① 同ステータスでのボタン押下パターンを集計（最新500件）
    const { data: logs } = await supabase
      .from("action_pattern_logs")
      .select("conversation_status, action_type")
      .eq("conversation_status", status)
      .not("conversation_status", "ilike", `${EXCLUDE_STATUS_PREFIX}%`)
      .order("created_at", { ascending: false })
      .limit(500);

    if (!logs || logs.length === 0) {
      return NextResponse.json({ ok: true, suggested_action: null, confidence: 0, message: "データ不足" });
    }

    // ② 頻度集計
    const freq: Record<string, number> = {};
    for (const row of logs as PatternRow[]) {
      const a = row.action_type;
      freq[a] = (freq[a] ?? 0) + 1;
    }
    const total = logs.length;
    const sorted = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .map(([action, count]) => ({ action, count, confidence: Math.round((count / total) * 100) / 100 }));

    const top = sorted[0];
    if (!top || top.confidence < 0.15) {
      return NextResponse.json({ ok: true, suggested_action: null, confidence: 0, message: "傾向なし" });
    }

    // ③ この会話の直近AIXを参照して「前回と同じ」を避ける
    let suggestedAction = top.action;
    if (conversationId) {
      const { data: lastUsage } = await supabase
        .from("aix_usage_logs")
        .select("aix_type")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastAction = (lastUsage as { aix_type: string } | null)?.aix_type ?? null;
      if (lastAction && top.action === lastAction && sorted.length > 1) {
        // 直前と同じボタンなら2位を推薦
        suggestedAction = sorted[1].action;
      }
    }

    return NextResponse.json({
      ok: true,
      suggested_action: suggestedAction,
      confidence: top.confidence,
      alternatives: sorted.slice(0, 3),
      sample_size: total,
    });
  } catch (e) {
    console.error("[aix/suggest]", e);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
