// GET /api/cron/calc-template-scene-stats  ← Vercel Cron（週1回・月曜JST 8:00 = UTC 23:00 日曜）
// POST /api/cron/calc-template-scene-stats ← 手動実行
//
// H4: シーン×テンプレの事前分布学習。
// template_selection_logs から conversation_status × template_id の「実際に送信された」頻度を集計し、
// 各 status の上位5テンプレを templates.status_pick_stats (JSONB) に保存する。
// TemplateModal が現在の会話ステータスに合わせて上位テンプレを昇格表示する。
//
// CHAIN-1: AIX→テンプレート全チェーン学習。
// conversation_status × aix_type × picker_mode × template_id × was_adapted の組み合わせを
// template_selection_logs（テンプレモーダル経路）と aix_usage_logs（AIX直送信経路）の両方から集計し、
// ai_prompts key=aix_template_chain_stats に保存する。
// suggest-next-action がここから recommended_template_id を導出する。

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

type ChainAgg = { selected: number; sent: number; adapted: number };

async function run() {
  const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // テンプレ選択ログ（select フェーズ全件。sent 判定は final_sent_text の有無で行う）
  const { data: logs, error } = await supabase
    .from("template_selection_logs")
    .select("template_id, conversation_status, aix_action_type, picker_mode, was_adapted, final_sent_text, prev_template_id, aix_session_id, sequence_no")
    .not("template_id", "is", null)
    .gte("created_at", since90d)
    .limit(10000);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // status × template_id の出現回数を集計（H4: 実際に送信された final_sent_text あり のみ）
  const stats: Record<string, Record<string, number>> = {};
  for (const log of logs ?? []) {
    if (!log.final_sent_text) continue;
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

  // ---- CHAIN-1: AIX→テンプレ全チェーン集計 ----
  // key = `${status}|${aix_type}|${picker_mode}|${template_id}`
  const chainAgg: Record<string, ChainAgg> = {};
  const bump = (status: string, aixType: string, picker: string, tid: string, opts: { sent: boolean; adapted: boolean }) => {
    const key = `${status}|${aixType}|${picker}|${tid}`;
    const e = chainAgg[key] ?? { selected: 0, sent: 0, adapted: 0 };
    e.selected += 1;
    if (opts.sent) e.sent += 1;
    if (opts.adapted) e.adapted += 1;
    chainAgg[key] = e;
  };

  // 経路①: テンプレモーダル選択ログ（AIX経由のみ = aix_action_type あり）
  for (const log of logs ?? []) {
    const aixType = (log.aix_action_type as string | null)?.trim();
    const tid = log.template_id as string;
    if (!aixType || !tid) continue;
    bump(
      (log.conversation_status as string) || "unknown",
      aixType,
      (log.picker_mode as string | null) || "-",
      tid,
      { sent: !!log.final_sent_text, adapted: !!log.was_adapted },
    );
  }

  // 経路②: AIX直送信ログ（テンプレを構造ソースにしてAI生成→送信。送信済み確定・AI生成=adapted扱い）
  const { data: aixLogs, error: aixError } = await supabase
    .from("aix_usage_logs")
    .select("conversation_status, aix_type, template_id, check_pattern, app_sub_mode, send_mode")
    .not("template_id", "is", null)
    .gte("created_at", since90d)
    .limit(10000);
  for (const log of aixLogs ?? []) {
    const tid = log.template_id as string;
    const aixType = (log.aix_type as string | null)?.trim();
    if (!aixType || !tid) continue;
    const picker = (log.check_pattern as string | null) || (log.app_sub_mode as string | null) || (log.send_mode as string | null) || "-";
    bump((log.conversation_status as string) || "unknown", aixType, picker, tid, { sent: true, adapted: true });
  }

  // チェーン一覧: 送信実績 desc → 選択数 desc で上位100件
  const chains = Object.entries(chainAgg)
    .map(([key, agg]) => {
      const [status, aixType, picker, tid] = key.split("|");
      return { conversation_status: status, aix_type: aixType, picker_mode: picker === "-" ? null : picker, template_id: tid, ...agg };
    })
    .filter((c) => c.sent >= 1 || c.selected >= 2)
    .sort((a, b) => b.sent - a.sent || b.selected - a.selected)
    .slice(0, 100);

  // 推奨マップ: `${status}|${aix_type}` および `*|${aix_type}` → 最頻テンプレID
  // （suggest-next-action が O(1) で recommended_template_id を引けるように事前導出）
  // 定義: 「選択」= 送信確定した時点。送信実績ゼロ（選んだだけで送らなかった）のチェーンは推奨に使わない
  const bestByScope: Record<string, { template_id: string; sent: number; selected: number }> = {};
  for (const c of chains) {
    if (c.sent < 1) continue;
    for (const scope of [`${c.conversation_status}|${c.aix_type}`, `*|${c.aix_type}`]) {
      const cur = bestByScope[scope];
      if (!cur || c.sent > cur.sent || (c.sent === cur.sent && c.selected > cur.selected)) {
        bestByScope[scope] = { template_id: c.template_id, sent: c.sent, selected: c.selected };
      }
    }
  }
  const recommended = Object.fromEntries(
    Object.entries(bestByScope).map(([scope, v]) => [scope, v.template_id])
  );

  await supabase.from("ai_prompts").upsert(
    {
      key: "aix_template_chain_stats",
      label: "AIX→テンプレ チェーン統計",
      content: JSON.stringify({
        updated: new Date().toISOString(),
        chains,
        recommended,
      }),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  // ---- CHAIN-2: テンプレート連続送信の遷移集計 ----
  // 「テンプレAを送った直後にテンプレBを送る」頻度を prev_template_id から集計し、
  // ai_prompts key=template_chain_transitions に保存する。
  // suggest-next-action がここから recommended_template_sequence（送る順番の定番）を導出する。
  // ※ prev_template_id はクライアントが「同一AIXセッション内で直前に実送信したテンプレID」を記録したもの。
  //   送信確定した（final_sent_text あり）ログのみ遷移としてカウントする。
  const transitionCounts: Record<string, Record<string, number>> = {}; // from → { to: count }
  for (const log of logs ?? []) {
    const prev = log.prev_template_id as string | null;
    const tid = log.template_id as string;
    if (!prev || !tid || prev === tid || !log.final_sent_text) continue;
    transitionCounts[prev] ??= {};
    transitionCounts[prev][tid] = (transitionCounts[prev][tid] ?? 0) + 1;
  }
  // 各テンプレの最頻 next を抽出（同数タイは template_id 昇順で決定的に）
  const transitions: Record<string, { next: string; count: number }> = {};
  for (const [from, tos] of Object.entries(transitionCounts)) {
    const best = Object.entries(tos).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) transitions[from] = { next: best[0], count: best[1] };
  }

  await supabase.from("ai_prompts").upsert(
    {
      key: "template_chain_transitions",
      label: "テンプレ連続送信 遷移統計",
      content: JSON.stringify({
        updated: new Date().toISOString(),
        transitions,
      }),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

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
    chain_combos: chains.length,
    chain_recommended_scopes: Object.keys(recommended).length,
    template_transitions: Object.keys(transitions).length,
    aix_logs_error: aixError?.message ?? null,
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
