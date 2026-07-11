import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge } from "@/app/lib/knowledge-utils";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";

export async function POST(request: NextRequest) {
  // 認証
  const auth = request.headers.get("x-internal-secret");
  if (!auth || auth !== INTERNAL_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // 1. ai_reply_examples から最新100件の sent_reply を取得
  const { data: examples, error } = await supabase
    .from("ai_reply_examples")
    .select("sent_reply")
    .not("sent_reply", "is", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error || !examples?.length) {
    return NextResponse.json({ ok: false, error: "no data", detail: error?.message }, { status: 500 });
  }

  // nullフィルタ+改行を含む文のみに絞る（改行なし文は参考にならない）
  const texts = examples
    .map(e => (e.sent_reply as string).trim())
    .filter(t => t && t.includes("\n"));

  if (texts.length < 10) {
    return NextResponse.json({ ok: false, error: "insufficient samples" });
  }

  // 2. Claude Sonnetで改行パターンを分析
  const sampleText = texts.slice(0, 50).map((t, i) => `--- 例${i + 1} ---\n${t}`).join("\n\n");

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    messages: [{
      role: "user",
      content: `以下はスモラ賃貸仲介スタッフが実際にLINEで送ったメッセージ50件です。
改行の使い方のパターン・癖を分析し、次回の文章生成に使えるルールとして抽出してください。

【メッセージサンプル】
${sampleText}

【分析観点】
- どのタイミングで改行しているか（挨拶後・提案後・！！後・話題の切り替えなど）
- 改行なしで続く場面と、改行を入れる場面の違い
- 典型的な構造（冒頭・本題・締めくくりの改行パターン）

【出力形式（JSONのみ）】
{
  "summary": "改行スタイルの全体要約（50文字以内）",
  "rules": [
    "ルール1（具体的・100文字以内）",
    "ルール2",
    "ルール3",
    "ルール4",
    "ルール5"
  ]
}

JSONのみ出力。説明不要。`,
    }],
  });

  const raw = res.content[0].type === "text" ? res.content[0].text.trim() : "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return NextResponse.json({ ok: false, error: "parse failed" });
  }

  let parsed: { summary: string; rules: string[] };
  try {
    parsed = JSON.parse(jsonMatch[0]) as { summary: string; rules: string[] };
  } catch {
    return NextResponse.json({ ok: false, error: "parse failed" });
  }

  const content = `【改行スタイル（${texts.length}件のメッセージから自動抽出）】\n` +
    parsed.rules.map((r, i) => `${i + 1}. ${r}`).join("\n");

  // 3. ai_reply_knowledge に保存（既存があれば上書き）
  // まず既存の同カテゴリを削除してから再INSERT（毎回最新分析で上書き）
  await supabase
    .from("ai_reply_knowledge")
    .delete()
    .eq("category", "line_format");

  const result = await upsertKnowledge(supabase, {
    title: `改行スタイル: スモラLINE返信フォーマット（${texts.length}件分析）`,
    content,
    category: "line_format",
    importance: 8,
  });

  return NextResponse.json({
    ok: true,
    result,
    summary: parsed.summary,
    rulesCount: parsed.rules.length,
    samplesUsed: texts.length,
  });
}
