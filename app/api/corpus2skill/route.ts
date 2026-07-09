import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, generateEmbedding, buildKnowledgeEmbeddingInput } from "@/app/lib/knowledge-utils";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 300;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 120_000, maxRetries: 1 });

const STATE_NORMALIZE: Record<string, string> = {
  condition_hearing: "hearing", property_search: "hearing",
  property_recommendation: "proposing", viewing: "proposing",
  estimate_request: "proposing", availability_check: "proposing",
  application: "applying", screening: "applying", contract: "applying",
};

type Example = {
  sent_reply: string;
  ai_draft: string | null;
  conversation_state: string;
  customer_message: string;
};

type Skill = {
  title: string;
  content: string;
  trigger?: string;
};

async function synthesizeSkills(state: string, examples: Example[]): Promise<Skill[]> {
  const examplesText = examples.slice(0, 15).map((e, i) => `
--- 例${i + 1} ---
顧客: ${(e.customer_message || "").slice(0, 150)}
${e.ai_draft ? `AI案: ${e.ai_draft.slice(0, 300)}\n` : ""}実際に送った返信: ${e.sent_reply.slice(0, 300)}`).join("\n");

  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2000,
    temperature: 0,
    system: `あなたは賃貸仲介の営業コーチです。スタッフの実際の返信例を分析し、優秀な担当者が使う普遍的なスキルを抽出します。`,
    messages: [{
      role: "user",
      content: `以下は【${state}】フェーズでの過去7日間の返信例です。

${examplesText}

これらから「優秀な賃貸営業担当者が使う普遍的なスキル・パターン」を3〜5個抽出してください。

条件：
- 固有名詞・物件名・日時に依存しない、どの顧客にも使える普遍パターンのみ
- 複数の例に共通して見られるものを優先
- 「できる営業担当者は〇〇する」という形式で書く
- AIが間違えたことではなく、スタッフが実践している「良い習慣・技術」にフォーカス

JSON配列のみ返す（説明不要）：
[
  {
    "title": "スキル名（25文字以内）",
    "content": "このスキルの詳細説明と具体的な使い方（200文字以内）",
    "trigger": "このスキルが特に活きる顧客状況の例文（50文字以内）"
  }
]`,
    }],
  });

  const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as Skill[];
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: examples } = await supabase
    .from("ai_reply_examples")
    .select("sent_reply, ai_draft, conversation_state, customer_message")
    .gte("created_at", since)
    .not("sent_reply", "is", null)
    .limit(200) as { data: Example[] | null };

  if (!examples || examples.length === 0) {
    return NextResponse.json({ ok: false, reason: "no examples found" });
  }

  // 正規化されたフェーズ別にグループ化
  const byState = new Map<string, Example[]>();
  for (const ex of examples) {
    const state = STATE_NORMALIZE[ex.conversation_state] ?? ex.conversation_state ?? "hearing";
    const arr = byState.get(state) ?? [];
    arr.push(ex);
    byState.set(state, arr);
  }

  let totalInserted = 0;
  let totalMerged = 0;

  for (const [state, stateExamples] of byState) {
    if (stateExamples.length < 3) {
      console.log(`[corpus2skill] ${state}: ${stateExamples.length}件のためスキップ（3件以上必要）`);
      continue;
    }

    console.log(`[corpus2skill] ${state}: ${stateExamples.length}件からスキル合成開始`);

    let skills: Skill[];
    try {
      skills = await synthesizeSkills(state, stateExamples);
    } catch (e) {
      console.error(`[corpus2skill] ${state} 合成失敗:`, e);
      continue;
    }

    for (const skill of skills) {
      if (!skill.title || !skill.content || skill.content.length < 20) continue;

      const embeddingInput = buildKnowledgeEmbeddingInput({
        trigger_example: skill.trigger,
        content: skill.content,
        conversation_state: state,
      });
      const embedding = await generateEmbedding(embeddingInput).catch(() => null);

      const result = await upsertKnowledge(supabase, {
        title: `[corpus2skill] ${skill.title}`,
        content: skill.content,
        category: "pattern",
        importance: 9,
        conversation_state: state,
        ...(embedding ? { embedding } : {}),
        ...(skill.trigger ? { trigger_example: skill.trigger } : {}),
      });

      if (result === "inserted") totalInserted++;
      else if (result === "merged") totalMerged++;
    }
  }

  console.log(`[corpus2skill] 完了: inserted=${totalInserted}, merged=${totalMerged}`);
  return NextResponse.json({ ok: true, inserted: totalInserted, merged: totalMerged, examplesProcessed: examples.length });
}
