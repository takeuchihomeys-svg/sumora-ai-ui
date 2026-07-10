// GET /api/cron/calc-template-scene-stats  ← Vercel Cron（週1回・月曜JST 8:00 = UTC 23:00 日曜）
// POST /api/cron/calc-template-scene-stats ← 手動実行
//
// H4: シーン×テンプレの事前分布学習。
// template_selection_logs から conversation_status × template_id の「実際に送信された」頻度を集計し、
// 各 status の上位5テンプレを templates.status_pick_stats (JSONB) に保存する。
// TemplateModal が現在の会話ステータスに合わせて上位テンプレを昇格表示する。

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

async function run() {
  const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // 実際に送信されたテンプレ選択ログ（final_sent_text あり = sent フェーズ完了）
  const { data: logs, error } = await supabase
    .from("template_selection_logs")
    .select("template_id, conversation_status")
    .not("template_id", "is", null)
    .not("final_sent_text", "is", null)
    .gte("created_at", since90d)
    .limit(10000);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // status × template_id の出現回数を集計
  const stats: Record<string, Record<string, number>> = {};
  for (const log of logs ?? []) {
    const status = (log.conversation_status as string) || "unknown";
    const tid = log.template_id as string;
    if (!tid) continue;
    stats[status] ??= {};
    stats[status][tid] = (stats[status][tid] ?? 0) + 1;
  }

  // 各 status の上位5テンプレを抽出 → テンプレ単位の { status: count } マップに転置
  const statsByTemplate: Record<string, Record<string, number>> = {};
  for (const [status, tidCounts] of Object.entries(stats)) {
    const top5 = Object.entries(tidCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [tid, count] of top5) {
      statsByTemplate[tid] ??= {};
      statsByTemplate[tid][status] = count;
    }
  }

  // templates.status_pick_stats を更新（今回の集計で全上書き = 古いシーン実績は自然消滅）
  let updated = 0;
  const updateErrors: string[] = [];
  for (const [templateId, pickStats] of Object.entries(statsByTemplate)) {
    const { error: updateError } = await supabase
      .from("templates")
      .update({ status_pick_stats: pickStats })
      .eq("id", templateId);
    if (updateError) {
      updateErrors.push(`${templateId}: ${updateError.message}`);
    } else {
      updated++;
    }
  }

  // 今回の集計対象外テンプレの status_pick_stats をリセット（上位5から陥落したテンプレの古い実績を消す）
  const keepIds = Object.keys(statsByTemplate);
  if (keepIds.length > 0) {
    await supabase
      .from("templates")
      .update({ status_pick_stats: {} })
      .not("id", "in", `(${keepIds.join(",")})`);
  }

  // 集計サマリーを ai_prompts に保存（俯瞰確認用）
  await supabase.from("ai_prompts").upsert(
    {
      key: "template_scene_stats_latest",
      label: "シーン×テンプレ分布統計",
      content: JSON.stringify({
        updated: new Date().toISOString(),
        status_count: Object.keys(stats).length,
        template_count: keepIds.length,
        total_logs: (logs ?? []).length,
      }),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  return NextResponse.json({
    ok: updateErrors.length === 0,
    total_logs: (logs ?? []).length,
    status_count: Object.keys(stats).length,
    templates_updated: updated,
    errors: updateErrors,
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
