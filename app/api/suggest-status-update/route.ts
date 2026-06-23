import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
const HAIKU = "claude-haiku-4-5-20251001";

// 昇格可能な次ステータス（現在→次）
const NEXT_STATUS: Record<string, { key: string; label: string }> = {
  hearing:   { key: "proposing", label: "物件提案中" },
  proposing: { key: "applying",  label: "申込・審査中" },
};

// 提案しないステータス
const SKIP = new Set(["applying", "closed_won", "closed_lost", "lost"]);

export async function POST(req: NextRequest) {
  const { conversation_id } = await req.json() as { conversation_id: string };
  if (!conversation_id) return NextResponse.json({ suggested: null });

  const [{ data: conv }, { data: messages }] = await Promise.all([
    supabase.from("conversations")
      .select("status, last_sender, customer_name")
      .eq("id", conversation_id)
      .single(),
    supabase.from("messages")
      .select("sender, text, created_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (!conv || !messages?.length) return NextResponse.json({ suggested: null });

  const rawStatus = (conv.status as string) ?? "hearing";

  // 旧ステータスキーを正規化
  const STATUS_ALIAS: Record<string, string> = {
    first_reply: "hearing", condition_hearing: "hearing",
    property_search: "hearing", property_recommendation: "proposing",
    viewing: "proposing", estimate_request: "proposing",
    availability_check: "proposing", application: "applying",
    screening: "applying", contract: "applying",
  };
  const currentStatus = STATUS_ALIAS[rawStatus] ?? rawStatus;

  if (SKIP.has(currentStatus)) return NextResponse.json({ suggested: null });
  const next = NEXT_STATUS[currentStatus];
  if (!next) return NextResponse.json({ suggested: null });

  // スタッフが最後に送信した場合は提案しない（お客様の反応待ち）
  if (conv.last_sender === "staff") return NextResponse.json({ suggested: null });

  const chatLog = [...messages].reverse()
    .map((m) => `${m.sender === "customer" ? "お客様" : "スタッフ"}: ${(m.text as string) ?? ""}`)
    .join("\n");

  const STATUS_CRITERIA: Record<string, string> = {
    hearing: `現在「初回対応」。以下の会話を見て、お客様の条件が揃い物件提案を開始できる状態かを判断してください。
判断基準: エリア・家賃・間取りなどの条件が明確になっている / 物件を見たいという意思表示がある`,
    proposing: `現在「物件提案中」。以下の会話を見て、お客様が申込・審査に進める状態かを判断してください。
判断基準: 特定の物件に強い興味を示している / 申込や審査について前向きな発言がある / 見積書を確認した`,
  };

  const prompt = `${STATUS_CRITERIA[currentStatus]}

【最近の会話（新しい順）】
${chatLog}

上記の会話を見て、ステータスを「${next.label}」に変更すべきか判断してください。
以下のJSON形式のみで返してください（説明不要）:
{"should_upgrade": true/false, "reason": "判断理由（10文字以内の日本語）"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU,
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) return NextResponse.json({ suggested: null });

  const data = await res.json() as { content?: Array<{ text: string }> };
  const raw = (data.content?.[0]?.text ?? "").replace(/```json?\s*/gi, "").replace(/```/g, "").trim();

  try {
    const parsed = JSON.parse(raw) as { should_upgrade: boolean; reason: string };
    if (!parsed.should_upgrade) return NextResponse.json({ suggested: null });
    return NextResponse.json({
      suggested: {
        status: next.key,
        label: next.label,
        reason: parsed.reason,
        current: currentStatus,
      },
    });
  } catch {
    return NextResponse.json({ suggested: null });
  }
}
