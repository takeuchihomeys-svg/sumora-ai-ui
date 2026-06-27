import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  const { draft, customer_name, recent_messages } = await req.json() as {
    draft: string;
    customer_name?: string;
    recent_messages?: Array<{ sender: string; text: string }>;
  };

  if (!draft?.trim()) {
    return NextResponse.json({ ok: false, error: "draft required" }, { status: 400 });
  }

  // generation_system をDBから取得（スタイルガイド）
  const { data: sysRow } = await supabase
    .from("ai_prompts")
    .select("content")
    .eq("key", "generation_system")
    .single();
  const styleGuide = sysRow?.content ?? "";

  const name = customer_name ? `${customer_name.split(/[ 　]/)[0]}さん` : "お客様";

  const recentHistory = (recent_messages ?? [])
    .filter((m) => m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .slice(-10)
    .map((m) => `${m.sender === "customer" ? "お客様" : "スモラ"}: ${m.text}`)
    .join("\n");

  const system = `${styleGuide}

【今回のタスク — 文章の整形・改善】
以下の「元の文章」を、上記スモラスタイルのルールに従って整えてください。

【厳守ルール】
・元の文章に含まれる事実・情報・数字は一切変えない（正しい情報として扱う）
・物件名・金額・日付・物件番号などの具体的な値はそのまま使う
・文体・表現・感嘆符・絵文字・言い回しのみスモラスタイルに修正する
・お客様名は「${name}」を使う
・整形後の文章のみ出力（説明・コメント・前置きは一切不要）`;

  const userMsg = `元の文章（この情報をそのまま使って整えてください）:\n${draft}${recentHistory ? `\n\n【参考：直近の会話履歴】\n${recentHistory}` : ""}`;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: userMsg }],
      system,
    });

    const polished = message.content[0].type === "text" ? message.content[0].text.trim() : draft;
    return NextResponse.json({ ok: true, polished });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
