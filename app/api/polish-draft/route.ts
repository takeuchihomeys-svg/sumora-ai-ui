import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "") });

export async function POST(req: NextRequest) {
  const { draft, customer_name, recent_messages, conversation_status } = await req.json() as {
    draft: string;
    customer_name?: string;
    recent_messages?: Array<{ sender: string; text: string }>;
    conversation_status?: string;
  };

  if (!draft?.trim()) {
    return NextResponse.json({ ok: false, error: "draft required" }, { status: 400 });
  }

  const name = customer_name
    ? `${customer_name.split(/[ 　]/)[0]}さん`
    : "お客様";

  // 全プロンプト・実例を並列取得
  const [
    { data: promptRows },
    { data: examples },
    { data: knowledge },
  ] = await Promise.all([
    // generation_system / reply_content_rules / smora_quick_patterns / real_estate_rules
    supabase
      .from("ai_prompts")
      .select("key, content")
      .in("key", ["generation_system", "reply_content_rules", "smora_quick_patterns", "real_estate_rules"]),
    // ☆付き実例（会話フェーズに合わせて取得）
    supabase
      .from("ai_reply_examples")
      .select("sent_reply")
      .eq("is_starred", true)
      .in("conversation_state", conversation_status
        ? [conversation_status, "proposing"]
        : ["proposing", "property_recommendation", "hearing"])
      .order("created_at", { ascending: false })
      .limit(6),
    // 差分学習ルール（importance高いもの）
    supabase
      .from("ai_reply_knowledge")
      .select("title, content")
      .ilike("title", "%差分学習%")
      .gte("importance", 7)
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  const promptMap: Record<string, string> = {};
  for (const row of promptRows ?? []) {
    promptMap[row.key as string] = row.content as string;
  }

  const styleGuide       = promptMap["generation_system"]    ?? "";
  const replyRules       = promptMap["reply_content_rules"]  ?? "";
  const quickPatterns    = promptMap["smora_quick_patterns"] ?? "";
  const realEstateRules  = promptMap["real_estate_rules"]    ?? "";

  const examplesText = (examples ?? []).length > 0
    ? "【⭐ スモラの実際の返信例（文体・テンポ・言い回しをこれに合わせる）】\n" +
      (examples as { sent_reply: string }[])
        .map((r, i) => `[例${i + 1}]\n${r.sent_reply}`)
        .join("\n\n")
    : "";

  const knowledgeText = (knowledge ?? []).length > 0
    ? "【🔴 過去の修正パターン（必ず守る）】\n" +
      (knowledge as { title: string; content: string }[])
        .map((r) => `・${r.title}: ${r.content}`)
        .join("\n")
    : "";

  const recentHistory = (recent_messages ?? [])
    .filter((m) => m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .slice(-10)
    .map((m) => `${m.sender === "customer" ? "お客様" : "スモラ"}: ${m.text}`)
    .join("\n");

  const system = [
    styleGuide,
    replyRules  ? `\n\n${replyRules}`      : "",
    realEstateRules ? `\n\n${realEstateRules}` : "",
    quickPatterns ? `\n\n${quickPatterns}` : "",
    knowledgeText ? `\n\n${knowledgeText}` : "",
    examplesText  ? `\n\n${examplesText}`  : "",
    `

【今回のタスク — 文章の整形・改善】
以下の「元の文章」を、上記スモラスタイルのルール・実例・修正パターンに従って整えてください。

【厳守ルール】
・元の文章に含まれる事実・情報・数字は一切変えない（正しい情報として扱う）
・物件名・金額・日付・物件番号などの具体的な値はそのまま使う
・文体・表現・感嘆符・言い回しのみスモラスタイルに修正する
・新しい文を追加しない（元の文章にない情報・話題・文を足すのは絶対禁止）
・文の順序を変えない（元の文章の並びのまま整える）
・絵文字は元の文章にあるものを維持する（新しい絵文字を追加しない・元の絵文字を勝手に削除しない）
・LINE向けのため長くしない（整形後の文字数は元の文章の±20%以内に収める）
・お客様名は「${name}」を使う
・整形後の文章のみ出力（説明・コメント・前置きは一切不要）`,
  ].join("");

  const userMsg = `元の文章（この情報をそのまま使って整えてください）:\n${draft}${recentHistory ? `\n\n【直近の会話履歴（流れを踏まえて整形すること）】\n${recentHistory}` : ""}`;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: userMsg }],
      system,
    });

    // テキストブロックを探して抽出（先頭ブロックがtext以外でも取りこぼさない）
    const textBlock = message.content.find(
      (b): b is Extract<typeof message.content[number], { type: "text" }> => b.type === "text",
    );
    const polished = textBlock ? textBlock.text.trim() : draft;
    return NextResponse.json({ ok: true, polished });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
