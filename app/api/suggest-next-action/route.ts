import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STATUS_LABEL: Record<string, string> = {
  hearing: "ヒアリング中",
  proposing: "物件提案中",
  viewing: "内覧調整中",
  application: "申込手続き中",
  contract: "契約済み",
  lost: "失注",
};

// 提案しないステータス
const SKIP_STATUSES = new Set(["contract", "lost"]);

export async function POST(req: NextRequest) {
  const { conversation_id } = await req.json() as { conversation_id: string };
  if (!conversation_id) return NextResponse.json({ action: null, reason: "" });

  const [{ data: conv }, { data: messages }] = await Promise.all([
    supabase.from("conversations")
      .select("status, customer_name, last_sender")
      .eq("id", conversation_id)
      .single(),
    supabase.from("messages")
      .select("sender, text, created_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (!conv || !messages?.length) return NextResponse.json({ action: null, reason: "" });
  if (SKIP_STATUSES.has(conv.status as string)) return NextResponse.json({ action: null, reason: "" });

  // スタッフが最後に返信済みで顧客返信待ちなら提案不要
  if (conv.last_sender === "staff") return NextResponse.json({ action: null, reason: "" });

  const recentText = [...messages]
    .reverse()
    .map((m) => `[${m.sender === "staff" ? "スタッフ" : "顧客"}] ${(m.text as string) || "(画像)"}`)
    .join("\n");

  const statusLabel = STATUS_LABEL[conv.status as string] ?? conv.status;

  const prompt = `あなたは不動産営業AIのアドバイザーです。以下の会話を読んで、スタッフが次に取るべき最適なアクションを1つ選んでください。

## 会話状況
顧客名: ${conv.customer_name as string}
現在のステータス: ${statusLabel}

## 直近の会話（古い順）
${recentText}

## 選択できるアクション（1つだけ選ぶ。どれも不要なら null）
- property_send: 物件を送る（顧客が条件を伝えた・物件を求めている）
- viewing_invite: 内覧を提案する（物件に興味を示している）
- application_push: 申込を促す（内覧後・かなり前向き）
- estimate_sheet: 見積書を送る（費用・初期費用の質問）
- meeting_place: 待ち合わせを決める（内覧日時が決まりそう・決まった）
- null: 特に次のアクションなし

## 出力形式（JSONのみ。reason は日本語10文字以内）
{"action": "viewing_invite", "reason": "内覧希望が出た"}`;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      messages: [{ role: "user", content: prompt }],
    });

    const text = ((message.content[0] as { type: string; text: string }).text ?? "").trim();
    const match = text.match(/\{[^}]+\}/);
    if (!match) return NextResponse.json({ action: null, reason: "" });

    const result = JSON.parse(match[0]) as { action: string | null; reason?: string };
    return NextResponse.json({ action: result.action ?? null, reason: result.reason ?? "" });
  } catch {
    return NextResponse.json({ action: null, reason: "" });
  }
}
