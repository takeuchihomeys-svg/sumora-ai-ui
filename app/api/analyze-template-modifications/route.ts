// GET /api/analyze-template-modifications  ← Vercel Cron（毎日深夜）
// POST /api/analyze-template-modifications ← 手動実行
//
// 「AIで最適化」後にスタッフが手修正したテキストのパターンを分析し、
// adaptation_improvement_rules テーブルにルールを蓄積する。
// 次回以降の「AIで最適化」時にこれらのルールが自動注入される。

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

type ModLog = {
  id: string;
  template_category: string | null;
  adapted_text: string | null;
  final_sent_text: string | null;
  conversation_status: string | null;
};

// H3: 生テンプレ手修正ログ（adapted_text なし・original_text vs final_sent_text の差分）
type RawModLog = {
  id: string;
  template_id: string | null;
  template_category: string | null;
  original_text: string | null;
  final_sent_text: string | null;
  conversation_status: string | null;
};

// H3: 文字bigramのDice係数による簡易テキスト類似度（0〜1）
function textSimilarity(a: string, b: string): number {
  const na = a.replace(/\s+/g, "");
  const nb = b.replace(/\s+/g, "");
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(na);
  const mb = bigrams(nb);
  let overlap = 0;
  for (const [g, ca] of ma) overlap += Math.min(ca, mb.get(g) ?? 0);
  return (2 * overlap) / (na.length - 1 + nb.length - 1);
}

type ExtractedRule = {
  rule: string;
  confidence: number;
};

// カテゴリ内の複数差分をまとめてClaudeに送り、共通パターンを抽出する
async function extractRulesFromBatch(
  client: Anthropic,
  category: string,
  logs: ModLog[]
): Promise<ExtractedRule[]> {
  const diffExamples = logs
    .map((log, i) => {
      const adapted = (log.adapted_text ?? "").slice(0, 500);
      const final = (log.final_sent_text ?? "").slice(0, 500);
      if (adapted.trim() === final.trim()) return null;
      return `【例${i + 1}】\n▼ 元の文（AI生成 or テンプレ原文）:\n${adapted}\n\n▼ スタッフが実際に送った文:\n${final}`;
    })
    .filter(Boolean)
    .join("\n\n────────────────\n\n");

  if (!diffExamples) return [];

  const prompt = `あなたはLINE賃貸営業AIの「改善ルール抽出エンジン」です。

## カテゴリ: ${category}

## スタッフによる修正事例（${logs.length}件）

${diffExamples}

## 指示

上記の修正事例を分析して、AIが次回から自動的に守るべきルールを抽出してください。

### 抽出条件（厳守）
- 「固有名詞（物件名・人名）だけが違う」修正はスキップ
- 「誤字・句読点だけ」の修正はスキップ
- 「文の順序の細かい入れ替え」はスキップ
- 複数の事例に共通するパターンを優先して抽出する
- 1つの事例にしか見られないパターンは confidence を 0.5 以下にする

### ルールの書き方
- 「〇〇の場合は△△と書く」「AIが□□と書いても、スタッフは□□に直している」
- 具体的かつ次のAI最適化で即使えるルール
- 1〜3件まで（多すぎない）

出力形式（JSONのみ・前置き禁止）:
[{"rule":"○○のときは△△と表現する。「□□」という表現はスタッフが毎回削除している。","confidence":0.85}]

ルールが抽出できない場合: []`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: "JSON配列のみで回答してください。説明文は一切付けないでください。",
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "[]";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]) as ExtractedRule[];
    return Array.isArray(parsed)
      ? parsed
          .map((r) => ({ rule: r.rule, confidence: Number(r.confidence) }))
          .filter((r) => r.rule && !isNaN(r.confidence) && r.confidence >= 0.5)
      : [];
  } catch {
    return [];
  }
}

async function runAnalysis(limit: number): Promise<{ analyzed: number; learned: number; categories: string[]; raw_analyzed: number; needs_update_templates: number }> {
  // 未処理の修正ログを取得（modification_analyzed=false かつ was_modified_after_adapt=true）
  const { data: logs, error } = await supabase
    .from("template_selection_logs")
    .select("id, template_category, adapted_text, final_sent_text, conversation_status")
    .eq("was_modified_after_adapt", true)
    .eq("modification_analyzed", false)
    .not("adapted_text", "is", null)
    .not("final_sent_text", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`fetch logs: ${error.message}`);

  // H3: 生テンプレ手修正ログを取得（adapted_text なし・テンプレ選択→直接手修正して送信）
  const { data: rawLogs, error: rawError } = await supabase
    .from("template_selection_logs")
    .select("id, template_id, template_category, original_text, final_sent_text, conversation_status")
    .eq("modification_analyzed", false)
    .is("adapted_text", null)
    .not("final_sent_text", "is", null)
    .not("original_text", "is", null)
    .not("template_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (rawError) {
    console.error("[analyze-template-modifications] raw logs fetch error:", rawError.message);
  }

  // 類似度0.95以上（=実質未修正）は analyzed マークだけ付けて除外
  const rawModified: RawModLog[] = [];
  const rawUnmodifiedIds: string[] = [];
  for (const log of (rawLogs ?? []) as RawModLog[]) {
    const sim = textSimilarity(log.original_text ?? "", log.final_sent_text ?? "");
    if (sim < 0.95) rawModified.push(log);
    else rawUnmodifiedIds.push(log.id);
  }
  if (rawUnmodifiedIds.length > 0) {
    await supabase
      .from("template_selection_logs")
      .update({ modification_analyzed: true })
      .in("id", rawUnmodifiedIds);
  }

  // 生テンプレ修正を ModLog 形式に正規化（base=original_text, final=final_sent_text）して既存フローに合流
  const rawAsModLogs: ModLog[] = rawModified.map((l) => ({
    id: l.id,
    template_category: l.template_category,
    adapted_text: l.original_text, // 比較元 = テンプレ原文
    final_sent_text: l.final_sent_text,
    conversation_status: l.conversation_status,
  }));

  const allLogs: ModLog[] = [...((logs ?? []) as ModLog[]), ...rawAsModLogs];

  // H3: テンプレ単位の修正頻度カウント → 5回以上修正されたテンプレを ai_prompts に記録
  let needsUpdateTemplates = 0;
  try {
    const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: freqLogs } = await supabase
      .from("template_selection_logs")
      .select("template_id, original_text, final_sent_text")
      .not("template_id", "is", null)
      .not("original_text", "is", null)
      .not("final_sent_text", "is", null)
      .gte("created_at", since90d)
      .limit(3000);

    const modCountByTemplate: Record<string, number> = {};
    for (const log of (freqLogs ?? []) as Array<{ template_id: string; original_text: string; final_sent_text: string }>) {
      if (textSimilarity(log.original_text, log.final_sent_text) >= 0.95) continue;
      modCountByTemplate[log.template_id] = (modCountByTemplate[log.template_id] ?? 0) + 1;
    }
    for (const [templateId, count] of Object.entries(modCountByTemplate)) {
      if (count < 5) continue;
      const { error: upsertError } = await supabase.from("ai_prompts").upsert(
        {
          key: `template_needs_update_${templateId}`,
          label: "テンプレ要更新候補（頻繁に手修正されている）",
          content: JSON.stringify({ template_id: templateId, modified_count: count, period_days: 90, updated: new Date().toISOString() }),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
      if (!upsertError) needsUpdateTemplates++;
    }
  } catch (freqErr) {
    console.error("[analyze-template-modifications] 修正頻度カウント error:", freqErr);
  }

  if (allLogs.length === 0) return { analyzed: 0, learned: 0, categories: [], raw_analyzed: rawUnmodifiedIds.length, needs_update_templates: needsUpdateTemplates };

  // カテゴリ別にグループ化
  const byCategory = new Map<string, ModLog[]>();
  for (const log of allLogs) {
    const cat = log.template_category ?? "全般";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(log);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "") });
  let learned = 0;
  const processedCategories: string[] = [];

  for (const [category, categoryLogs] of byCategory.entries()) {
    try {
    // 完全一致（=実質修正なし）を除外
    const realDiffs = categoryLogs.filter(
      (l) => l.adapted_text?.trim() !== l.final_sent_text?.trim()
    );

    if (realDiffs.length === 0) {
      // 全て完全一致 → analyzed マークだけ付けてスキップ
      await supabase
        .from("template_selection_logs")
        .update({ modification_analyzed: true })
        .in("id", categoryLogs.map((l) => l.id));
      continue;
    }

    // Claude でパターン抽出
    const rules = await extractRulesFromBatch(client, category, realDiffs);

    // ルールを adaptation_improvement_rules に保存
    for (const { rule, confidence } of rules) {
      // 同カテゴリ内で類似ルールが直近30日に存在するか確認（短縮版テキスト一致）
      const ruleKey = rule.slice(0, 50).replace(/[%_\\]/g, "\\$&"); // 先頭50文字で近似チェック（ilike特殊文字エスケープ）
      const { data: existing } = await supabase
        .from("adaptation_improvement_rules")
        .select("id, example_count, confidence")
        .eq("category", category)
        .ilike("rule_text", `${ruleKey}%`)
        .limit(1)
        .maybeSingle();

      if (existing) {
        await supabase
          .from("adaptation_improvement_rules")
          .update({
            example_count: existing.example_count + realDiffs.length,
            confidence: Math.min(Math.max(Number(existing.confidence), confidence) + 0.03, 0.99),
            last_triggered_at: new Date().toISOString(),
            is_active: true,
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("adaptation_improvement_rules").insert({
          category,
          rule_text: rule,
          confidence,
          example_count: realDiffs.length,
          is_active: confidence >= 0.5,
          last_triggered_at: new Date().toISOString(),
        });
      }
      learned++;
    }

    // 処理済みマーク
    await supabase
      .from("template_selection_logs")
      .update({ modification_analyzed: true })
      .in("id", categoryLogs.map((l) => l.id));
      processedCategories.push(category);
    } catch (catErr) {
      console.error(`[analyze-template-modifications] category ${category} error:`, catErr);
    }
  }

  return { analyzed: allLogs.length, learned, categories: processedCategories, raw_analyzed: rawModified.length + rawUnmodifiedIds.length, needs_update_templates: needsUpdateTemplates };
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "40") || 40, 100);
    const result = await runAnalysis(limit);

    console.log(`[analyze-template-modifications] analyzed=${result.analyzed} learned=${result.learned} categories=${result.categories.join(",")}`);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[analyze-template-modifications] error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return POST(req);
}
