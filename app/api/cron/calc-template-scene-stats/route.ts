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
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
// HINT-1: brain の template_hint ラベル許可リスト（一致率集計のラベル抽出に使用）と知識化ユーティリティ
import { TEMPLATE_HINT_ALLOWED_LABELS } from "@/app/lib/brain-core";
import { upsertKnowledge } from "@/app/lib/knowledge-utils";
// ステータスキー新旧不整合の修正: ログには旧ステータス名（viewing, property_recommendation 等）が
// 残っているため、集計前に normalizeStatus で新5段階（hearing/proposing/applying）へ正規化する。
// suggest-next-action は正規化後のステータスで recommended を引くため、ここで揃えないとミスマッチする。
import { normalizeStatus } from "@/app/lib/status-normalize";

export const maxDuration = 60;

type ChainAgg = { selected: number; sent: number; adapted: number };

async function run() {
  // 学習ヘルスモニタリング用の実行記録（morning-report が cron_run_logs を読んで状態を報告する）
  const runLogId = await startCronLog("calc-template-scene-stats");
  const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // テンプレ選択ログ（select フェーズ全件。sent 判定は final_sent_text の有無で行う）
  const { data: logs, error } = await supabase
    .from("template_selection_logs")
    .select("template_id, conversation_status, aix_action_type, picker_mode, was_adapted, final_sent_text, prev_template_id, aix_session_id, sequence_no, template_category, brain_template_hint")
    .not("template_id", "is", null)
    .gte("created_at", since90d)
    .limit(10000);

  if (error) {
    await finishCronLog(runLogId, false, undefined, error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // status × template_id の出現回数を集計（H4: 実際に送信された final_sent_text あり のみ）
  // ※ conversation_status は正規化してから集計する（旧名で分散した実績を新キーに統合。
  //   templates.status_pick_stats への保存キーも正規化済みステータスで統一される）
  const stats: Record<string, Record<string, number>> = {};
  for (const log of logs ?? []) {
    if (!log.final_sent_text) continue;
    const status = normalizeStatus((log.conversation_status as string) || "unknown");
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
      normalizeStatus((log.conversation_status as string) || "unknown"),
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
    bump(normalizeStatus((log.conversation_status as string) || "unknown"), aixType, picker, tid, { sent: true, adapted: true });
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

  // ---- HINT-1: brain template_hint vs 実選択の一致率学習（テンプレ却下学習） ----
  // brain が提示した template_hint（ラベルカテゴリ）と、スタッフが実際に送信したテンプレの
  // template_category の一致/不一致をラベル別に集計し、
  //  ① trigger_action_rules に TEMPLATE_HINT_ACCEPT_RATE:<ラベル> として upsert
  //     → brain-core の自己修正ゲートが 10件以上・一致率30%未満のラベルの提示を抑制する
  //  ② ai_prompts key=template_hint_mismatch_stats にラベル別の実選択上位カテゴリを保存
  //     → 将来 recommend-templates のプロンプト注入に使う（Phase 3）
  //  ③ N>=10 かつ一致率<50% のラベルのみ ai_reply_knowledge に知識化（厳しめ閾値でノイズ抑制）
  const normalizeHintText = (s: string) => s.replace(/[①②③④⑤\s]/g, "");
  const hintLabelMatches = (label: string, category: string | null): boolean => {
    if (!category) return false;
    const nl = normalizeHintText(label);
    const nc = normalizeHintText(category);
    if (!nl || !nc) return false;
    return nl.includes(nc) || nc.includes(nl);
  };
  type HintAgg = { total: number; matched: number; topPicked: Record<string, number>; byStatus: Record<string, number> };
  const hintAgg: Record<string, HintAgg> = {};
  for (const log of logs ?? []) {
    const hint = (log.brain_template_hint as string | null)?.trim();
    // 一致率の定義: 「hint 提示中に実際に送信されたテンプレ」のみ対象（select だけで送らなかった行は除外）
    if (!hint || !log.final_sent_text) continue;
    const label = TEMPLATE_HINT_ALLOWED_LABELS.find((l) => hint.includes(l));
    if (!label) continue;
    const category = (log.template_category as string | null) ?? null;
    const e = hintAgg[label] ?? { total: 0, matched: 0, topPicked: {}, byStatus: {} };
    e.total += 1;
    if (hintLabelMatches(label, category)) e.matched += 1;
    const catKey = category || "(カテゴリなし)";
    e.topPicked[catKey] = (e.topPicked[catKey] ?? 0) + 1;
    const status = normalizeStatus((log.conversation_status as string) || "unknown");
    e.byStatus[status] = (e.byStatus[status] ?? 0) + 1;
    hintAgg[label] = e;
  }

  // ① TEMPLATE_HINT_ACCEPT_RATE:<ラベル> を trigger_action_rules に upsert（SOURCE_ACCEPT_RATE と同型）
  let hintRatesUpdated = 0;
  for (const [label, agg] of Object.entries(hintAgg)) {
    const confidence = agg.total > 0 ? Math.round((agg.matched / agg.total) * 1000) / 1000 : 0;
    const { error: hintUpsertError } = await supabase.from("trigger_action_rules").upsert(
      {
        action_type: "template_hint",
        keyword: `TEMPLATE_HINT_ACCEPT_RATE:${label}`,
        occurrence_count: agg.matched,
        total_occurrence: agg.total,
        confidence,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "action_type,keyword" }
    );
    if (!hintUpsertError) hintRatesUpdated++;
    else console.error("[calc-template-scene-stats] hint rate upsert error:", label, hintUpsertError.message);
  }

  // ② ラベル別の実選択上位3カテゴリを ai_prompts に保存（Phase 3 のプロンプト注入・俯瞰確認用）
  const perLabel = Object.fromEntries(
    Object.entries(hintAgg).map(([label, agg]) => [
      label,
      {
        total: agg.total,
        matched: agg.matched,
        match_rate: agg.total > 0 ? Math.round((agg.matched / agg.total) * 1000) / 1000 : 0,
        topPicked: Object.entries(agg.topPicked)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 3)
          .map(([category, count]) => ({ category, count })),
      },
    ])
  );
  if (Object.keys(hintAgg).length > 0) {
    await supabase.from("ai_prompts").upsert(
      {
        key: "template_hint_mismatch_stats",
        label: "テンプレヒント vs 実選択 一致統計",
        content: JSON.stringify({ updated: new Date().toISOString(), perLabel }),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );
  }

  // ③ N>=10 かつ一致率<50% のラベルのみ知識化（毎回リセットして最新集計で全置換）
  let hintKnowledgeWritten = 0;
  const mismatchLabels = Object.entries(hintAgg).filter(
    ([, agg]) => agg.total >= 10 && agg.matched / agg.total < 0.5
  );
  if (mismatchLabels.length > 0) {
    await supabase.from("ai_reply_knowledge").delete().ilike("title", "テンプレヒント傾向:%");
    for (const [label, agg] of mismatchLabels) {
      const topPicked = Object.entries(agg.topPicked)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([category, count]) => `${category}(${count}回)`)
        .join(" / ");
      const matchRatePct = Math.round((agg.matched / agg.total) * 100);
      const topStatus = Object.entries(agg.byStatus).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      const { result } = await upsertKnowledge(supabase, {
        title: `テンプレヒント傾向: ${label}`,
        content: `brainが「${label}」をtemplate_hintとして提示した際、スタッフが実際に送ったテンプレの同カテゴリ一致率は${matchRatePct}%（${agg.matched}/${agg.total}件）。実際に選ばれた上位カテゴリ: ${topPicked}。このヒント提示時は実選択傾向に合わせた提案を優先すること。`,
        category: "pattern",
        importance: 6,
        ...(topStatus ? { conversation_state: topStatus } : {}),
      });
      if (result === "inserted") hintKnowledgeWritten++;
    }
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

  await finishCronLog(
    runLogId,
    updateErrors.length === 0,
    {
      total_logs: (logs ?? []).length,
      status_count: Object.keys(stats).length,
      templates_updated: updated,
      chain_combos: chains.length,
      chain_recommended_scopes: Object.keys(recommended).length,
      template_transitions: Object.keys(transitions).length,
      hint_labels: hintRatesUpdated,
      hint_knowledge_written: hintKnowledgeWritten,
    },
    updateErrors.length > 0 ? updateErrors.join(" / ") : undefined,
  );
  return NextResponse.json({
    ok: updateErrors.length === 0,
    total_logs: (logs ?? []).length,
    status_count: Object.keys(stats).length,
    templates_updated: updated,
    chain_combos: chains.length,
    chain_recommended_scopes: Object.keys(recommended).length,
    template_transitions: Object.keys(transitions).length,
    hint_labels: hintRatesUpdated,
    hint_knowledge_written: hintKnowledgeWritten,
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
