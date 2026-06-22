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
  if (conv.last_sender === "staff") return NextResponse.json({ action: null, reason: "" });

  const currentStatus = (conv.status as string) ?? "hearing";
  const statusLabel = STATUS_LABEL[currentStatus] ?? currentStatus;

  // ---- 過去パターンデータを取得 ----
  const { data: patternRows } = await supabase
    .from("action_pattern_logs")
    .select("action_type, customer_msg_summary")
    .eq("conversation_status", currentStatus)
    .order("created_at", { ascending: false })
    .limit(60);

  // アクション頻度集計
  const freq: Record<string, number> = {};
  for (const row of patternRows ?? []) {
    const a = row.action_type as string;
    freq[a] = (freq[a] ?? 0) + 1;
  }
  const totalPatterns = Object.values(freq).reduce((s, n) => s + n, 0);

  // 上位3アクションを頻度付きで表示
  const topActions = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([action, count]) => {
      const pct = Math.round((count / totalPatterns) * 100);
      return `- ${action}: ${count}件 (${pct}%)`;
    })
    .join("\n");

  // 具体的な過去例（最新5件）
  const examples = (patternRows ?? [])
    .filter((r) => (r.customer_msg_summary as string)?.trim())
    .slice(0, 5)
    .map((r) => `  顧客:「${(r.customer_msg_summary as string).slice(0, 60)}」→ ${r.action_type}`)
    .join("\n");

  const recentText = [...messages]
    .reverse()
    .map((m) => `[${m.sender === "staff" ? "スタッフ" : "顧客"}] ${(m.text as string) || "(画像)"}`)
    .join("\n");

  const patternSection = totalPatterns >= 3
    ? `## 過去の実績データ（ステータス「${statusLabel}」のとき、実際に取られたアクション）
アクション頻度:
${topActions}

具体的な過去例:
${examples || "  (なし)"}

`
    : "";

  const prompt = `あなたは不動産営業AIのアドバイザーです。
${patternSection}## 現在の会話
顧客名: ${conv.customer_name as string}
ステータス: ${statusLabel}

直近の会話（古い順）:
${recentText}

## 指示
上記の過去実績データ（あれば）と現在の会話内容を総合して、スタッフが次に取るべき最適なアクションを1つ選んでください。

選択肢:
- property_send: 物件を送る（条件整理済み・物件を求めている）
- viewing_invite: 内覧を提案する（物件に興味あり）
- application_push: 申込を促す（内覧後・前向き）
- estimate_sheet: 見積書を送る（費用・初期費用の質問）
- meeting_place: 待ち合わせを決める（内覧日時が確定しそう）
- null: 特に次のアクションなし

## 出力形式（JSONのみ。reasonは日本語10文字以内）
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
