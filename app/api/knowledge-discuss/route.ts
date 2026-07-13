import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";
import { syncConfirmedToPromptRule } from "@/app/lib/knowledge-promote";

// 🤝 ナレッジ打ち合わせ（チャット形式）
// TemplateModal のナレッジ承認パネル「🤝 打ち合わせ」から呼ばれる。
//
// POST /api/knowledge-discuss                  … チャット1往復（reply を返す）
// POST /api/knowledge-discuss?action=finalize  … 会話を元に最終ナレッジを確定・DB反映
//
// finalize の処理:
//   1. 会話履歴から Sonnet が最終ナレッジ content を抽出/改善
//   2. ai_reply_knowledge.content を UPDATE
//   3. hypothesis_status を 'confirmed' に UPDATE
//   4. syncConfirmedToPromptRule() で ai_prompt_rules に即時反映

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 50_000, maxRetries: 1 });

type ChatMessage = { role: "user" | "assistant"; content: string };

type DiscussBody = {
  id?: string;
  title?: string;
  content?: string;
  category?: string | null;
  conversation_state?: string | null;
  messages?: ChatMessage[];
  userMessage?: string;
};

function buildSystemPrompt(title: string, content: string, category: string | null | undefined): string {
  return `あなたは不動産仲介AIアシスタントです。
以下のナレッジについて竹内悠馬さんと打ち合わせをしています。
竹内さんの意見を聞いてナレッジを改善してください。

【ナレッジタイトル】${title}
【内容】${content}
【カテゴリ】${category ?? "なし"}

打ち合わせのルール:
- 不動産仲介業務の専門家として、ナレッジの妥当性・改善点を具体的に議論する
- 竹内さんの意見を反映したナレッジの改善案を提案する
- 回答は簡潔に（長くても400文字程度）
- 竹内さんが「反映して」「これでOK」「確定」など確定の意思を示したら「了解しました。確定ボタンを押してください。」とだけ返す`;
}

// 会話履歴を Anthropic の messages 形式に整形（先頭は必ず user である必要がある）
function toAnthropicMessages(history: ChatMessage[], finalUserMessage: string): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim() !== "")
    .map((m) => ({ role: m.role, content: m.content }));
  if (msgs.length > 0 && msgs[0].role === "assistant") {
    msgs.unshift({ role: "user", content: "このナレッジについて打ち合わせをお願いします。" });
  }
  msgs.push({ role: "user", content: finalUserMessage });
  return msgs;
}

function extractText(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// ─────────────────────────────────────────────
// チャット1往復
// ─────────────────────────────────────────────
async function handleChat(body: DiscussBody): Promise<NextResponse> {
  const { title, content, category, messages, userMessage } = body;

  if (!title || !content || !userMessage) {
    return NextResponse.json({ ok: false, error: "title / content / userMessage は必須です" }, { status: 400 });
  }

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    system: buildSystemPrompt(title, content, category),
    messages: toAnthropicMessages(messages ?? [], userMessage),
  });

  const reply = extractText(res);
  if (!reply) {
    return NextResponse.json({ ok: false, error: "AIの返答が空でした" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, reply });
}

// ─────────────────────────────────────────────
// 確定・反映（?action=finalize）
// ─────────────────────────────────────────────
async function handleFinalize(body: DiscussBody): Promise<NextResponse> {
  const { id, title, content, category, conversation_state, messages } = body;

  if (!id || !title || !content) {
    return NextResponse.json({ ok: false, error: "id / title / content は必須です" }, { status: 400 });
  }

  // 1. 会話履歴を元に Sonnet が最終ナレッジ content を抽出/改善
  const finalizeInstruction = `以上の打ち合わせ内容を踏まえて、このナレッジの最終版の【内容】を出力してください。

元のナレッジ:
【タイトル】${title}
【内容】${content}

要件:
- 打ち合わせで竹内さんが指摘・合意した修正をすべて反映する
- 打ち合わせで変更の合意がなければ元の内容をそのまま出力する
- LINE返信AIのプロンプトに注入される業務ルールとして簡潔・明確に書く（500文字以内）
- 最終ナレッジの本文のみ出力する（前置き・見出し・コードフェンス不要）`;

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: buildSystemPrompt(title, content, category),
    messages: toAnthropicMessages(messages ?? [], finalizeInstruction),
  });

  const updatedContent = extractText(res);
  if (!updatedContent) {
    return NextResponse.json({ ok: false, error: "最終ナレッジの生成結果が空でした" }, { status: 500 });
  }

  // 2. ai_reply_knowledge を UPDATE（content のみ更新）+ 3. hypothesis_status を confirmed に
  const { error: updateError } = await supabase
    .from("ai_reply_knowledge")
    .update({ content: updatedContent, hypothesis_status: "confirmed" })
    .eq("id", id);

  if (updateError) {
    console.error("[knowledge-discuss] finalize update failed:", updateError.message);
    return NextResponse.json({ ok: false, error: `DB更新に失敗しました: ${updateError.message}` }, { status: 500 });
  }

  // 4. ai_prompt_rules に即時反映（importance は DB から取得。取得失敗時は安全サイドでスキップ）
  const { data: row, error: fetchError } = await supabase
    .from("ai_reply_knowledge")
    .select("importance")
    .eq("id", id)
    .single();
  if (fetchError) {
    console.error("[knowledge-discuss] importance fetch failed:", fetchError.message);
    // importance 不明時は importance=7 を仮定してサイレント昇格するバグを防ぐため sync をスキップ
    return NextResponse.json({ ok: true, updatedContent, synced: false, reason: "importance_fetch_failed" });
  }

  await syncConfirmedToPromptRule({
    id,
    title,
    content: updatedContent,
    conversation_state: conversation_state ?? null,
    importance: row.importance as number,
  });

  return NextResponse.json({ ok: true, updatedContent, synced: (row.importance as number) >= 7 });
}

// ─────────────────────────────────────────────
// エントリポイント
// ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const action = req.nextUrl.searchParams.get("action");
    const body = (await req.json()) as DiscussBody;

    if (action === "finalize") {
      return await handleFinalize(body);
    }
    return await handleChat(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.error("[knowledge-discuss] error:", e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
