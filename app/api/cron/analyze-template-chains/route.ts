// GET /api/cron/analyze-template-chains  ← Vercel Cron（週1回・月曜JST 8:30 = UTC 23:30 日曜）
// POST /api/cron/analyze-template-chains ← 手動実行
//
// CHAIN-3: Opus 4.8 による週次テンプレートチェーン分析。
// calc-template-scene-stats（月曜JST 8:00）が集計した aix_template_chain_stats /
// template_chain_transitions を入力に、前週スナップショットとの差分（急増/急減/新出）を
// 純ロジックで計算した上で、Opus 4.8 に1回だけ一括分析させる。
// 出力:
//   ai_prompts key=template_improvement_report — テンプレ改善提案（morning-report が月曜に読む）
//   ai_prompts key=template_scene_insights     — 営業シーン別の使い方インサイト
//   ai_prompts key=chain_stats_history         — 週次スナップショット履歴（最新8件・新しい順）

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 300;

type Chain = {
  conversation_status: string;
  aix_type: string;
  picker_mode: string | null;
  template_id: string;
  selected: number;
  sent: number;
  adapted: number;
};

type Transition = { next: string; count: number };

type Snapshot = { week: string; chains: Chain[] };

type ImprovementProposal = {
  template_label?: string;
  issue?: string;
  proposal?: string;
  priority?: string;
};

type SceneInsight = {
  pattern_name?: string;
  description?: string;
  aix_type?: string;
  template_labels?: string[];
};

type WeeklyChanges = { summary?: string; notable?: string };

type AnalysisJson = {
  improvement_proposals?: ImprovementProposal[];
  scene_insights?: SceneInsight[];
  weekly_changes?: WeeklyChanges;
};

// Opus 4.8 直接呼び出し（analyze-closed-conversation の callOpus と同パターン）
// ※ Opus 4.8 は temperature 等のサンプリングパラメータを受け付けない（400）ため付けない
async function callOpus(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.warn("[analyze-template-chains] Opus API error:", res.status, await res.text().catch(() => ""));
      return "";
    }
    const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
    return data.content?.find((b) => b.type === "text")?.text?.trim() || "";
  } catch (e) {
    console.warn("[analyze-template-chains] Opus呼び出し失敗:", e);
    return "";
  }
}

// ai_prompts から key の content(JSON) を取得。行がない/壊れていれば null
async function fetchPromptJson<T>(key: string): Promise<T | null> {
  const { data } = await supabase
    .from("ai_prompts")
    .select("content")
    .eq("key", key)
    .maybeSingle();
  if (!data?.content) return null;
  try {
    return JSON.parse(data.content as string) as T;
  } catch {
    return null;
  }
}

async function upsertPrompt(key: string, label: string, content: unknown): Promise<void> {
  await supabase.from("ai_prompts").upsert(
    {
      key,
      label,
      content: JSON.stringify(content),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );
}

// チェーンの識別キー（週次比較用）
function chainKey(c: Chain): string {
  return `${c.conversation_status}|${c.aix_type}|${c.picker_mode ?? "-"}|${c.template_id}`;
}

async function run() {
  const runLogId = await startCronLog("analyze-template-chains");

  // ---- Step 1: データ収集 ----
  const [chainStats, transStats, history] = await Promise.all([
    fetchPromptJson<{ updated?: string; chains?: Chain[] }>("aix_template_chain_stats"),
    fetchPromptJson<{ updated?: string; transitions?: Record<string, Transition> }>("template_chain_transitions"),
    fetchPromptJson<{ snapshots?: Snapshot[] }>("chain_stats_history"),
  ]);

  const chains = chainStats?.chains ?? [];
  const transitions = transStats?.transitions ?? {};

  // 初回実行時などデータが空なら早期リターン（分析対象なし）
  if (chains.length === 0) {
    await finishCronLog(runLogId, true, { skipped: true, reason: "no_chain_data" });
    return NextResponse.json({ ok: true, skipped: true, reason: "no_chain_data" });
  }

  // テンプレ本文マップ（上位20チェーン分のIDで取得）
  const top20 = chains.slice(0, 20);
  const topIds = [...new Set(top20.map((c) => c.template_id))];
  // 遷移パターンで登場するIDもラベル解決に含める
  const transIds = Object.entries(transitions)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .flatMap(([from, t]) => [from, t.next]);
  const allIds = [...new Set([...topIds, ...transIds])];

  const templateMap = new Map<string, { label: string; text: string }>();
  if (allIds.length > 0) {
    const { data: templates } = await supabase
      .from("templates")
      .select("id, label, text")
      .in("id", allIds);
    for (const t of templates ?? []) {
      templateMap.set(t.id as string, {
        label: (t.label as string) || "(ラベルなし)",
        text: (t.text as string) || "",
      });
    }
  }
  const labelOf = (id: string) => templateMap.get(id)?.label ?? `テンプレ${id.slice(0, 8)}`;

  // ---- Step 3: 週次変化の差分計算（モデル不使用・純ロジック）----
  // ※ Step 2 のスナップショット保存より先に前週データを参照する（保存後だと今週分が先頭になるため）
  const prevSnapshot = history?.snapshots?.[0] ?? null;
  const surging: string[] = [];
  const dropping: string[] = [];
  const newPattern: string[] = [];

  if (prevSnapshot?.chains && prevSnapshot.chains.length > 0) {
    const prevByKey = new Map<string, Chain>(prevSnapshot.chains.map((c) => [chainKey(c), c]));
    const describe = (c: Chain, note: string) =>
      `${c.aix_type} × ${labelOf(c.template_id)}（${note}）`;

    for (const c of chains) {
      const prev = prevByKey.get(chainKey(c));
      if (!prev) {
        newPattern.push(describe(c, `新規・今週${c.sent}回送信`));
        continue;
      }
      if (prev.sent > 0 && c.sent >= prev.sent * 1.5) {
        surging.push(describe(c, `${prev.sent}回→${c.sent}回`));
      } else if (prev.sent > 0 && c.sent <= prev.sent * 0.5) {
        dropping.push(describe(c, `${prev.sent}回→${c.sent}回`));
      }
    }
  }

  // ---- Step 2: 前週スナップショット保存（最新8件・新しい順にスタック）----
  const weekStr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JST日付
  const newSnapshots: Snapshot[] = [
    { week: weekStr, chains },
    ...(history?.snapshots ?? []).filter((s) => s.week !== weekStr),
  ].slice(0, 8);

  // ---- Step 4: Opus 4.8 で一括分析（1回のみ）----
  const chainLines = top20.map((c) => {
    const adaptedRate = c.sent > 0 ? Math.round((c.adapted / c.sent) * 100) : 0;
    return `- ${c.aix_type} × ${c.picker_mode ?? "-"} × ${labelOf(c.template_id)} → sent ${c.sent}回 / adapted率 ${adaptedRate}%（status: ${c.conversation_status}）`;
  });

  const transLines = Object.entries(transitions)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([from, t]) => `- ${labelOf(from)} → ${labelOf(t.next)} → ${t.count}回`);

  const hasPrev = prevSnapshot != null;
  const changeSection = hasPrev
    ? `急増: ${surging.length > 0 ? surging.join(" / ") : "なし"}
急減: ${dropping.length > 0 ? dropping.join(" / ") : "なし"}
新出: ${newPattern.length > 0 ? newPattern.join(" / ") : "なし"}`
    : "（前週データなし・今週が初回集計のため前週比較はスキップ）";

  const prompt = `あなたは賃貸仲介営業ツールのLINEテンプレート活用パターンを分析する専門家です。

【今週のテンプレート使用チェーン上位20件】
${chainLines.join("\n")}

【テンプレート連続送信パターン（遷移上位10件）】
${transLines.length > 0 ? transLines.join("\n") : "（データなし）"}

【今週の変化（前週比）】
${changeSection}

以下をJSONで返してください（説明不要・JSONのみ）：

{
  "improvement_proposals": [
    {
      "template_label": "テンプレートの名前",
      "issue": "問題点（adapted率が高い/毎回同じ修正がある/必ずセットで使われるなど）",
      "proposal": "具体的な改善提案（テンプレ本文の変更案・統合案など）",
      "priority": "high|medium|low"
    }
  ],
  "scene_insights": [
    {
      "pattern_name": "このパターンの営業シーン名（例：内覧後空室確認即答パターン）",
      "description": "どういうシーンでどう使うか（スタッフ向けの言葉で・1文）",
      "aix_type": "AIXアクション名",
      "template_labels": ["テンプレA", "テンプレB"]
    }
  ],
  "weekly_changes": {
    "summary": "今週の全体的な傾向を1〜2文で",
    "notable": "特に注目すべき変化（急増・急減・新パターン）を1〜2文で"
  }
}`;

  const rawText = await callOpus(prompt);

  let analysis: AnalysisJson | null = null;
  if (rawText) {
    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) analysis = JSON.parse(match[0]) as AnalysisJson;
    } catch {
      // JSON解析失敗 → エラーログのみ（再試行は翌週に任せる）
      console.error("[analyze-template-chains] 分析JSONの解析に失敗:", rawText.slice(0, 300));
    }
  } else {
    console.error("[analyze-template-chains] Opus応答なし");
  }

  // ---- Step 5: 結果保存 ----
  // スナップショット履歴は分析の成否に関わらず更新（翌週の差分計算に必要）
  await upsertPrompt("chain_stats_history", "チェーン統計 週次スナップショット履歴", {
    updated: new Date().toISOString(),
    snapshots: newSnapshots,
  });

  if (analysis) {
    await upsertPrompt("template_improvement_report", "テンプレ改善提案（週次Opus分析）", {
      updated: new Date().toISOString(),
      week: weekStr,
      improvement_proposals: analysis.improvement_proposals ?? [],
      weekly_changes: analysis.weekly_changes ?? {},
    });
    await upsertPrompt("template_scene_insights", "テンプレ営業シーンインサイト（週次Opus分析）", {
      updated: new Date().toISOString(),
      week: weekStr,
      scene_insights: analysis.scene_insights ?? [],
    });
  }

  const result = {
    ok: true,
    analyzed: analysis != null,
    chains_total: chains.length,
    chains_analyzed: top20.length,
    transitions_analyzed: transLines.length,
    prev_comparison: hasPrev,
    surging: surging.length,
    dropping: dropping.length,
    new_pattern: newPattern.length,
    proposals: analysis?.improvement_proposals?.length ?? 0,
    insights: analysis?.scene_insights?.length ?? 0,
    snapshots_kept: newSnapshots.length,
  };
  await finishCronLog(runLogId, true, result);
  return NextResponse.json(result);
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
