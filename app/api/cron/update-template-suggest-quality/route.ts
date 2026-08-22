// POST /api/cron/update-template-suggest-quality
// template_selection_logs を分析して、suggest-template の精度フィードバックを
// ai_reply_knowledge に蓄積する週次cron。
// 「AIが推薦しなかったのにスタッフが選んだ」パターンを学習してRAGに乗せる。

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 120;

const client = new Anthropic({
  apiKey: (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, ""),
  timeout: 30_000,
});

type SelectionLog = {
  template_id: string | null;
  template_category: string | null;
  recommended_rank: number | null;
  was_recommended: boolean | null;
  conversation_status: string | null;
  aix_action_type: string | null;
  final_sent_text: string | null;
};

type KnowledgeInsight = {
  title: string;
  content: string;
  category: string;
  conversation_state: string | null;
};

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = { analyzed: 0, inserted: 0, skipped: 0, errors: [] as string[] };

  // ── 直近8日の選択ログを取得 ─────────────────────────────────────────────────
  const since = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const { data: logs, error: logsErr } = await supabase
    .from("template_selection_logs")
    .select("template_id, template_category, recommended_rank, was_recommended, conversation_status, aix_action_type, final_sent_text")
    .gte("created_at", since)
    .not("final_sent_text", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);

  if (logsErr) {
    return NextResponse.json({ ...results, error: logsErr.message });
  }

  const allLogs = (logs ?? []) as SelectionLog[];

  // ── カテゴリ×状態でグループ化 ──────────────────────────────────────────────
  const groups = new Map<string, SelectionLog[]>();
  for (const log of allLogs) {
    const key = `${log.template_category ?? "unknown"}__${log.conversation_status ?? "unknown"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(log);
  }

  for (const [key, groupLogs] of groups) {
    if (groupLogs.length < 3) { results.skipped++; continue; }

    const [categoryRaw, statusRaw] = key.split("__");
    const category = categoryRaw ?? "unknown";
    const status = statusRaw ?? "unknown";

    // AI推薦から採用したケース vs 手動選択ケースを集計
    const aiPicks = groupLogs.filter((l) => l.was_recommended === true);
    const manualPicks = groupLogs.filter((l) => l.was_recommended !== true);

    // AI推薦が少なすぎる（スタッフが自分で選ぶことが多い）場合に学習価値あり
    const manualRate = manualPicks.length / groupLogs.length;
    if (manualRate < 0.4 && aiPicks.length >= 3) {
      // AIがうまく機能しているので今回はスキップ
      results.skipped++;
      continue;
    }

    // 同一カテゴリ×状態のナレッジが直近3日以内に存在すれば重複防止でスキップ
    const { count: existingCount } = await supabase
      .from("ai_reply_knowledge")
      .select("id", { count: "exact", head: true })
      .eq("source", "template-suggest-quality-cron")
      .ilike("title", `%${category.slice(0, 20)}%`)
      .gte("created_at", new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString());
    if ((existingCount ?? 0) > 0) { results.skipped++; continue; }

    // Haiku でパターン抽出
    const sampleTexts = manualPicks
      .slice(0, 6)
      .map((l) => `- [${l.aix_action_type ?? "-"}] ${(l.final_sent_text ?? "").slice(0, 80)}`)
      .join("\n");
    const aiSampleTexts = aiPicks
      .slice(0, 3)
      .map((l) => `- [rank${l.recommended_rank ?? "?"}] ${(l.final_sent_text ?? "").slice(0, 80)}`)
      .join("\n");

    let insight: KnowledgeInsight | null = null;
    try {
      const resp = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content:
            `スモラ不動産のLINE営業テンプレート選定AIの改善のため、以下のデータを分析してください。\n\n` +
            `カテゴリ: ${category}\n会話フェーズ: ${status}\n` +
            `AI推薦採用数: ${aiPicks.length}件 / 手動選択数: ${manualPicks.length}件\n\n` +
            `【スタッフが自ら選んだテンプレ文（AIが推薦しなかった）】\n${sampleTexts || "なし"}\n\n` +
            `【AIが推薦したテンプレ文】\n${aiSampleTexts || "なし"}\n\n` +
            `この状況での適切なテンプレート選定の知見を、次回のAI選定に役立つ形で1〜2文にまとめてください。\n` +
            `出力形式（JSONのみ）:\n` +
            `{"title":"30字以内タイトル","content":"知見（100字以内）"}`,
        }],
      });
      const text = ((resp.content[0] as { text: string }).text ?? "").trim();
      const match = text.match(/\{[\s\S]+\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { title?: string; content?: string };
        if (parsed.title && parsed.content) {
          insight = {
            title: parsed.title,
            content: parsed.content,
            category: "template_selection",
            conversation_state: status !== "unknown" ? status : null,
          };
        }
      }
    } catch (e) {
      results.errors.push(`haiku ${key}: ${String(e).slice(0, 80)}`);
      continue;
    }

    if (!insight) { results.skipped++; continue; }

    // ai_reply_knowledge に挿入（embedding は backfill-embeddings cron が翌日補完）
    const { error: insertErr } = await supabase.from("ai_reply_knowledge").insert({
      category: insight.category,
      title: insight.title,
      content: insight.content,
      importance: 3,
      conversation_state: insight.conversation_state,
      source: "template-suggest-quality-cron",
      hypothesis_status: "hypothesis",
    });
    if (insertErr) {
      results.errors.push(`insert ${key}: ${insertErr.message}`);
    } else {
      results.inserted++;
    }
    results.analyzed++;
  }

  return NextResponse.json(results);
}
