import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 60;

const ACCOUNT_LABEL: Record<string, string> = {
  sumora: "スモラ", ieyasu: "イエヤス", giga: "ギガ賃貸", hasu: "ハス",
};

// AIXアクション種別の表示ラベル（auto-template-candidates と同一マッピング）
const AIX_ACTION_LABEL: Record<string, string> = {
  property_send: "物件ピックアップした",
  property_recommendation: "オススメ",
  property_check_result: "物件確認",
  viewing_invite: "内覧誘導",
  application_push: "申込誘導",
  meeting_place: "待ち合わせ",
  condition_hearing: "ヒアリング",
  estimate_sheet: "見積書",
  greeting_viewing: "内覧挨拶",
};

function relTime(d?: string | null): string {
  if (!d) return "不明";
  const diff = Date.now() - new Date(d).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const runLogId = await startCronLog("morning-report");

  // LINEグループ設定
  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!groupId) {
    const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    groupId = (data?.value as string) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!groupId || !token) {
    return NextResponse.json({ ok: false, error: "LINE config missing" }, { status: 500 });
  }

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // B10: aix_action_attribution の最新期間フィルターをDB側に移動（JS-only limit:50 では大量テンプレ時に欠損する）
  //      直近2週分（今週 + 先週）のみ取得することで limit を超える前に正確に絞り込む
  const _jstNowW = new Date(Date.now() + 9 * 3600 * 1000);
  const _dowW = (_jstNowW.getUTCDay() + 6) % 7; // 月=0
  const _mondayJst = new Date(_jstNowW.getTime() - _dowW * 86400 * 1000);
  _mondayJst.setUTCHours(0, 0, 0, 0);
  const twoWeeksAgoMondayStr = new Date(_mondayJst.getTime() - 7 * 86400 * 1000).toISOString().slice(0, 10);

  // JST今日00:00 / 昨日00:00 をUTCで計算
  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayStart = new Date(Date.UTC(
    nowJst.getUTCFullYear(),
    nowJst.getUTCMonth(),
    nowJst.getUTCDate()
  ) - 9 * 60 * 60 * 1000); // JST today 00:00
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000); // JST yesterday 00:00

  // 並列取得
  const [
    { data: pendingTasks, error: tasksErr },
    { data: unrepliedConvs, error: unrepliedErr },
    { data: hotCustomers, error: hotErr },
    { data: attributionRow, error: attributionRowErr },
    { data: adoptionLogs, error: adoptionErr },
    { data: lossPatterns, error: lossErr },
    { data: topTemplates, error: templatesErr },
    { count: wonCount, error: wonErr },
    { count: pendingCandidates, error: candidatesErr },
    { data: aixLogs, error: aixErr },
    { data: attributionRows, error: attributionRowsErr },
    { data: readinessRow, error: readinessErr },
    { data: guardRow, error: guardErr },
  ] = await Promise.all([
    // ① 未完了タスク
    supabase
      .from("line_tasks")
      .select("id, conversation_id, task_type, customer_name, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(100),

    // ② 未返信の会話（お客さんが最後に送信 & 2日以内）
    supabase
      .from("conversations")
      .select("id, customer_name, account, updated_at")
      .eq("last_sender", "customer")
      .neq("status", "closed_won")
      .gte("updated_at", twoDaysAgo)
      .order("updated_at", { ascending: false })
      .limit(10),

    // ③ 今日物件を出すべきホット顧客
    supabase
      .from("property_customers")
      .select("id, customer_name, status, last_property_sent_at")
      .in("status", ["hot", "new_inquiry"])
      .order("last_property_sent_at", { ascending: true, nullsFirst: true })
      .limit(10),

    // ④ AI貢献率メトリクス（calc-ai-attribution が毎日計算）
    supabase
      .from("ai_prompts")
      .select("content")
      .eq("key", "ai_attribution_metrics")
      .maybeSingle(),

    // ⑤ 提案採択/却下ログ（直近7日）
    supabase
      .from("action_pattern_logs")
      .select("source")
      .in("source", ["suggestion_accepted", "suggestion_dismissed"])
      .gte("created_at", sevenDaysAgo)
      .limit(500),

    // ⑥ 失注パターントップ3
    supabase
      .from("ai_reply_knowledge")
      .select("title, importance")
      .ilike("title", "失注パターン%")
      .order("importance", { ascending: false })
      .limit(3),

    // ⑦ テンプレ使用ランキング（上位3件）
    // ※カラム名は label（name ではない）。use_count が NULL の行は末尾に回す
    supabase
      .from("templates")
      .select("label, category, use_count")
      .order("use_count", { ascending: false, nullsFirst: false })
      .limit(3),

    // ⑧ 昨日の成約数（closed_won になった件数）
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("status", "closed_won")
      .gte("updated_at", yesterdayStart.toISOString())
      .lt("updated_at", todayStart.toISOString()),

    // ⑨ AIXテンプレート候補の未レビュー件数
    supabase
      .from("ai_template_candidates")
      .select("*", { count: "exact", head: true })
      .eq("is_adopted", false)
      .eq("is_dismissed", false),

    // ⑩ 昨日のAIX使用ログ（アクション別サマリー用）
    supabase
      .from("aix_usage_logs")
      .select("aix_type")
      .gte("created_at", yesterdayStart.toISOString())
      .lt("created_at", todayStart.toISOString()),

    // ⑪ 成果アトリビューション（直近2週分をDB側で絞り込む — B10: JS-only limit では大量テンプレ時に欠損）
    supabase
      .from("aix_action_attribution")
      .select("action_type, template_label, win_rate, usage_count, period_start")
      .gte("period_start", twoWeeksAgoMondayStr)
      .order("period_start", { ascending: false })
      .limit(200),

    // ⑫ 自動返信化準備スコア（auto-reply-readiness cron が毎日更新）
    supabase
      .from("ai_prompts")
      .select("content")
      .eq("key", "auto_reply_readiness")
      .maybeSingle(),

    // ⑬ 自動返信ガードレール発動記録（auto-reply-guard cron が毎週月曜更新）
    supabase
      .from("ai_prompts")
      .select("content")
      .eq("key", "auto_reply_guard_latest")
      .maybeSingle(),
  ]);

  // クエリエラーのログ（レポート本体は送る。失敗したセクションは空になるだけ）
  if (tasksErr) console.error("[morning-report] tasks query:", tasksErr.message);
  if (unrepliedErr) console.error("[morning-report] unreplied query:", unrepliedErr.message);
  if (hotErr) console.error("[morning-report] hotCustomers query:", hotErr.message);
  if (attributionRowErr) console.error("[morning-report] attributionRow query:", attributionRowErr.message);
  if (adoptionErr) console.error("[morning-report] adoptionLogs query:", adoptionErr.message);
  if (lossErr) console.error("[morning-report] lossPatterns query:", lossErr.message);
  if (templatesErr) console.error("[morning-report] topTemplates query:", templatesErr.message);
  if (wonErr) console.error("[morning-report] wonCount query:", wonErr.message);
  if (candidatesErr) console.error("[morning-report] pendingCandidates query:", candidatesErr.message);
  if (aixErr) console.error("[morning-report] aixLogs query:", aixErr.message);
  if (attributionRowsErr) console.error("[morning-report] attributionRows query:", attributionRowsErr.message);
  if (readinessErr) console.error("[morning-report] readiness query:", readinessErr.message);
  if (guardErr) console.error("[morning-report] guard query:", guardErr.message);

  // AI貢献率フッター（メトリクスがあれば1行追加）
  let attributionLine = "";
  try {
    const m = attributionRow?.content ? JSON.parse(attributionRow.content as string) : null;
    if (m && typeof m.rate === "number" && typeof m.total === "number") {
      attributionLine = `\n\n🤖 AI貢献率: ${Math.round(m.rate * 100)}%（直近30日成約${m.total}件中${m.ai_assisted ?? 0}件AI貢献）`;
    }
  } catch {
    // JSONパース失敗時はスキップ（レポート本体は送る）
  }

  // 📊 統計サマリー（昨日の成約・提案採択率・失注パターン・テンプレランキング）
  const statsLines: string[] = [];

  // 昨日の成約数
  statsLines.push(`🎉 昨日の成約: ${wonCount ?? 0}件`);

  // 提案採択率（直近7日）
  const accepted = adoptionLogs?.filter((l) => l.source === "suggestion_accepted").length || 0;
  const dismissed = adoptionLogs?.filter((l) => l.source === "suggestion_dismissed").length || 0;
  const adoptionRate = (accepted + dismissed) > 0
    ? Math.round(accepted / (accepted + dismissed) * 100) : null;
  if (adoptionRate !== null) {
    statsLines.push(`✅ 提案採択率: ${adoptionRate}%（採択${accepted}件 / 却下${dismissed}件）`);
  }

  // 失注パターントップ3
  if (lossPatterns && lossPatterns.length > 0) {
    const lines = lossPatterns.map((p, i) => `  ${i + 1}. ${(p.title as string).replace(/^失注パターン[:：]?\s*/, "")}`);
    statsLines.push(`⚠️ 失注パターントップ3:\n${lines.join("\n")}`);
  }

  // テンプレ使用ランキング（use_count が 0 / NULL のテンプレは除外。クエリ失敗時も安全にスキップ）
  const usedTemplates = (topTemplates ?? []).filter((t) => (t.use_count ?? 0) > 0);
  if (usedTemplates.length > 0) {
    const rank = usedTemplates.map((t, i) => `${i + 1}位 ${t.label}(${t.use_count ?? 0}回)`).join(" / ");
    statsLines.push(`📄 テンプレ使用ランキング: ${rank}`);
  }

  // 昨日のAIX使用状況サマリー（アクション別件数）
  if (aixLogs && aixLogs.length > 0) {
    const typeCounts = new Map<string, number>();
    for (const log of aixLogs) {
      const t = (log.aix_type as string) ?? "unknown";
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }
    const summary = [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => `${AIX_ACTION_LABEL[type] ?? type}${n}回`)
      .join(" / ");
    statsLines.push(`🤖 昨日のAIX: ${summary}（計${aixLogs.length}回）`);
  }

  // AIXテンプレート候補の未レビュー件数（5件以上は警告マーク）
  if ((pendingCandidates ?? 0) > 0) {
    const mark = (pendingCandidates ?? 0) >= 5 ? " ⚠️ 溜まっています！レビューをお願いします" : "";
    statsLines.push(`📋 AIXテンプレート候補: ${pendingCandidates}件未レビュー${mark}`);
  }

  // 🤖 自動返信化候補（auto_reply_readiness で ready: true の aix_type がある場合のみ表示。0件ならセクション省略）
  try {
    const readiness = readinessRow?.content
      ? JSON.parse(readinessRow.content as string) as {
          scores?: Array<{ aix_type: string; acceptance_rate?: number | null; edit_rate?: number | null; ready?: boolean; reason?: string | null }>;
        }
      : null;
    const readyScores = (readiness?.scores ?? []).filter((s) => s.ready === true);
    if (readyScores.length > 0) {
      const lines = readyScores.map((s) => {
        const label = AIX_ACTION_LABEL[s.aix_type] ?? s.aix_type;
        const metrics = [
          typeof s.acceptance_rate === "number" ? `採択${Math.round(s.acceptance_rate * 100)}%` : "",
          typeof s.edit_rate === "number" ? `編集${Math.round(s.edit_rate * 100)}%` : "",
        ].filter(Boolean).join("・");
        return `  ・${label}${metrics ? `（${metrics}）` : ""}`;
      });
      statsLines.push(`🤖 自動返信化候補:\n${lines.join("\n")}`);
    }
  } catch {
    // JSONパース失敗時はスキップ（レポート本体は送る）
  }

  // ⚠️ 自動返信化の一時停止（auto-reply-guard のキルスイッチ発動時のみ・直近8日以内の記録が対象）
  try {
    const guard = guardRow?.content
      ? JSON.parse(guardRow.content as string) as {
          report_date?: string;
          paused?: Array<{ aix_type: string; week1_rate?: number; week2_rate?: number; week3_rate?: number }>;
        }
      : null;
    const isRecent = guard?.report_date
      ? Date.now() - new Date(guard.report_date).getTime() < 8 * 24 * 60 * 60 * 1000
      : false;
    if (isRecent && (guard?.paused?.length ?? 0) > 0) {
      const pct = (r?: number) => (typeof r === "number" ? `${Math.round(r * 100)}%` : "?");
      const lines = (guard?.paused ?? []).map((p) => {
        const label = AIX_ACTION_LABEL[p.aix_type] ?? p.aix_type;
        return `  ・${label}（採択率 ${pct(p.week1_rate)}→${pct(p.week2_rate)}→${pct(p.week3_rate)}）`;
      });
      statsLines.push(`⚠️ 自動返信化を一時停止:\n${lines.join("\n")}`);
    }
  } catch {
    // JSONパース失敗時はスキップ（レポート本体は送る）
  }

  // 成果アトリビューション（最新週の成約率上位3テンプレ）
  const latestPeriod = attributionRows?.[0]?.period_start as string | undefined;
  if (latestPeriod) {
    const topAttribution = (attributionRows ?? [])
      .filter((r) => r.period_start === latestPeriod && (r.usage_count ?? 0) > 0 && r.win_rate != null)
      .sort((a, b) => (b.win_rate as number) - (a.win_rate as number))
      .slice(0, 3);
    if (topAttribution.length > 0) {
      const lines = topAttribution.map((r, i) => {
        const label = (r.template_label as string) ?? AIX_ACTION_LABEL[r.action_type as string] ?? r.action_type;
        const pct = Math.round((r.win_rate as number) * 100);
        return `  ${i + 1}. ${AIX_ACTION_LABEL[r.action_type as string] ?? r.action_type}「${label}」— 成約率${pct}%（${r.usage_count}回使用）`;
      });
      statsLines.push(`🏆 先週の成果テンプレTOP3:\n${lines.join("\n")}`);
    }
  }

  // 📊 テンプレート週次レポート（月曜のみ。analyze-template-chains が月曜JST 8:30に更新 → 9:45のレポートで配信）
  const jstDay = new Date(Date.now() + 9 * 3600 * 1000).getUTCDay(); // JST曜日。0=日曜、1=月曜
  if (jstDay === 1) {
    try {
      const { data: reportRow } = await supabase
        .from("ai_prompts")
        .select("content")
        .eq("key", "template_improvement_report")
        .maybeSingle();
      const report = reportRow?.content
        ? JSON.parse(reportRow.content as string) as {
            updated?: string;
            improvement_proposals?: Array<{ template_label?: string; proposal?: string; priority?: string }>;
            weekly_changes?: { summary?: string; notable?: string };
          }
        : null;
      // 直近8日以内の更新のみ表示（analyze-template-chains 失敗週に古いレポートを再掲しない）
      const isRecent = report?.updated
        ? Date.now() - new Date(report.updated).getTime() < 8 * 24 * 60 * 60 * 1000
        : false;
      if (report && isRecent) {
        const lines: string[] = [];
        if (report.weekly_changes?.summary) lines.push(`今週の傾向: ${report.weekly_changes.summary}`);
        if (report.weekly_changes?.notable) lines.push(`注目変化: ${report.weekly_changes.notable}`);
        const highPriority = (report.improvement_proposals ?? [])
          .filter((p) => p.priority === "high" && p.proposal)
          .slice(0, 3);
        if (highPriority.length > 0) {
          lines.push("改善提案（優先度高）:");
          for (const p of highPriority) {
            lines.push(`・${p.template_label ? `${p.template_label}: ` : ""}${p.proposal}`);
          }
        }
        if (lines.length > 0) {
          statsLines.push(`📊 テンプレート週次レポート\n${lines.join("\n")}`);
        }
      }
    } catch {
      // JSONパース失敗時はスキップ（レポート本体は送る）
    }

    // 🎯 テンプレートシーン別パターン（analyze-template-chains の Opus 4.8 シーン名付け・上位3件）
    try {
      const { data: insightsRow } = await supabase
        .from("ai_prompts")
        .select("content")
        .eq("key", "template_scene_insights")
        .maybeSingle();
      const insights = insightsRow?.content
        ? JSON.parse(insightsRow.content as string) as {
            updated?: string;
            scene_insights?: Array<{ pattern_name?: string; description?: string; aix_type?: string }>;
          }
        : null;
      // 直近8日以内の更新のみ表示（analyze-template-chains 失敗週に古いインサイトを再掲しない）
      const insightsRecent = insights?.updated
        ? Date.now() - new Date(insights.updated).getTime() < 8 * 24 * 60 * 60 * 1000
        : false;
      const topInsights = (insights?.scene_insights ?? [])
        .filter((s) => s.pattern_name && s.description)
        .slice(0, 3);
      if (insightsRecent && topInsights.length > 0) {
        const lines = topInsights.map((s) => `・${s.pattern_name}: ${s.description}`);
        statsLines.push(`🎯 テンプレートシーン別パターン（上位3件）\n${lines.join("\n")}`);
      }
    } catch {
      // JSONパース失敗時はスキップ（レポート本体は送る）
    }
  }

  const statsBlock = statsLines.length > 0
    ? `\n\n——————\n\n📊 統計サマリー\n\n${statsLines.join("\n")}`
    : "";

  const sections: string[] = [];

  // ① 未完了タスク
  const tasks = pendingTasks ?? [];
  if (tasks.length > 0) {
    const TASK_EMOJI: Record<string, string> = { property_check: "🔍", property_send: "🏠" };
    const TASK_LABEL: Record<string, string> = { property_check: "物件確認", property_send: "物件出し" };
    const lines = tasks.map((t, i) =>
      `${i + 1}. ${TASK_EMOJI[t.task_type as string] ?? "📋"} ${t.customer_name ?? "不明"}さん — ${TASK_LABEL[t.task_type as string] ?? t.task_type}（${relTime(t.created_at as string)}～）`
    );
    sections.push(`📋 未完了タスク（${tasks.length}件）\n\n${lines.join("\n")}`);
  }

  // ② 未返信
  const unreplied = unrepliedConvs ?? [];
  if (unreplied.length > 0) {
    const lines = unreplied.map((c, i) => {
      const acct = ACCOUNT_LABEL[(c.account as string) ?? "sumora"] ?? "スモラ";
      return `${i + 1}. ${c.customer_name ?? "名称未設定"}さん（${acct}）— ${relTime(c.updated_at as string)}`;
    });
    sections.push(`💬 未返信のお客さん（${unreplied.length}件）\n\n${lines.join("\n")}`);
  }

  // ③ 今日物件を出すべき顧客
  const needsProp = (hotCustomers ?? []).filter((c) => {
    if (c.status === "new_inquiry") return true;
    if (c.status === "hot") {
      return !c.last_property_sent_at || new Date(c.last_property_sent_at as string) < todayStart;
    }
    return false;
  });

  if (needsProp.length > 0) {
    const lines = needsProp.map((c, i) => {
      const last = c.last_property_sent_at ? relTime(c.last_property_sent_at as string) : "未送信";
      const tag = c.status === "new_inquiry" ? "新規" : "毎日出し";
      return `${i + 1}. 🔥 ${c.customer_name ?? "不明"}さん（${tag}）— ${last}`;
    });
    sections.push(`🏠 今日物件を出すべきお客さん（${needsProp.length}件）\n\n${lines.join("\n")}`);
  }

  // B06: 主要データクエリの失敗数を集計（3件以上失敗時は偽陰性「ゼロです🎉」を防ぐ）
  const mainQueryErrors = [tasksErr, unrepliedErr, hotErr].filter(Boolean).length;
  const errorWarning = mainQueryErrors >= 3
    ? "\n\n⚠️ データ取得に失敗しました。実際のタスクは確認してください。"
    : mainQueryErrors > 0
    ? `\n\n⚠️ 一部データの取得に失敗しました（${mainQueryErrors}件）。`
    : "";

  const text = sections.length === 0
    ? `🌅 おはようございます！\n今日は未完了タスク・未返信ともにゼロです🎉\n引き続きよろしくお願いします！${statsBlock}${attributionLine}${errorWarning}`
    : `🌅 おはようございます！今日のタスクレポートです\n\n${sections.join("\n\n——————\n\n")}${statsBlock}\n\n全員対応よろしくお願いします！${attributionLine}${errorWarning}`;

  // LINEのtextメッセージ上限は5000字。超過時は切り詰めて送信（保険）
  const safeText = text.length > 4900 ? text.slice(0, 4900) + "\n…（以下省略）" : text;

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [{ type: "text", text: safeText }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[morning-report] LINE push failed:", res.status, body);
      return NextResponse.json({ ok: false, error: body }, { status: 500 });
    }
  } catch (err) {
    console.error("[morning-report] LINE push error:", err);
    return NextResponse.json({ ok: false, error: "LINE push failed" }, { status: 500 });
  }

  await finishCronLog(runLogId, true, { tasks: tasks.length, unreplied: unreplied.length, needsProp: needsProp.length });
  return NextResponse.json({ ok: true, tasks: tasks.length, unreplied: unreplied.length, needsProp: needsProp.length });
}
