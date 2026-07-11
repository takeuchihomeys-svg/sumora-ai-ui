import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";
import { requireInternalAuth } from "@/app/lib/api-auth";

export const maxDuration = 30;

const TOKEN = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? "";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15_000 });

type Customer = {
  id: string;
  customer_name: string;
  status: string;
  desired_area: string;
  last_property_sent_at: string | null;
  next_due_label: string;
  days_since_sent: number | null;
};

const STATUS_EMOJI: Record<string, string> = {
  new_inquiry:     "🆕",
  hot:             "🔥",
  property_search: "🏠",
};

const STATUS_LABEL: Record<string, string> = {
  new_inquiry:     "新規",
  hot:             "毎日",
  property_search: "3日ごと",
};

async function getTodayList(): Promise<Customer[]> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? "https://sumora-ai-ui.vercel.app"}/api/property-tasks`, {
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json() as { ok: boolean; customers: Customer[] };
  return data.ok ? data.customers : [];
}

async function getGroupId(): Promise<string | null> {
  const { data } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .maybeSingle();
  return data?.value ?? null;
}

async function pushToLine(to: string, text: string) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error("[send-property-list] LINE push failed:", res.status, await res.text());
  }
}

async function generateQuote(hotCount: number, totalCount: number): Promise<string> {
  const today = new Date().toLocaleDateString("ja-JP", { weekday: "long", timeZone: "Asia/Tokyo" });
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `あなたはスモラという賃貸仲介会社の営業チームに毎朝魂のメッセージを届ける役割です。

チームの目標：月の利益500万円
ミッション：コンフォートゾーンをぶち破り、チームの士気を最高潮に高める

今日の状況：
- ${today}
- 今日の物件出し対象：${totalCount}名
- うち毎日追跡中のホット顧客：${hotCount}名

以下の条件でメッセージを作ってください：
・ラベル・タイトルは一切つけない。本文のみ
・「安全圏にいる自分」を壊してもっと上へ行くことを促す内容
・読んだ瞬間に血が沸騰するような、魂に刺さる言葉
・甘い励ましではなく、本気でぶつかってくるような力強さ
・でも攻撃的すぎず、仲間として肩を並べる熱さ
・3〜4行以内でコンパクトに
・絵文字を1〜2個使う（炎・稲妻・星など強さを表すもの）
・毎回違う切り口・表現で（曜日・件数・状況を反映させる）
・日本語で`,
      }],
    });
    const text = res.content[0].type === "text" ? res.content[0].text : "";
    return text;
  } catch {
    return "";
  }
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;

  if (!TOKEN) {
    return NextResponse.json({ ok: false, error: "LINE token not configured" }, { status: 500 });
  }
  const groupId = await getGroupId();
  if (!groupId) {
    return NextResponse.json({ ok: false, error: "グループIDが未設定です" }, { status: 400 });
  }

  const customers = await getTodayList();

  if (customers.length === 0) {
    await pushToLine(groupId, "✅ 今日の物件出し対象者はいません！\nお疲れ様です😊");
    return NextResponse.json({ ok: true, count: 0 });
  }

  const today = new Date().toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" });
  const hotCount = customers.filter(c => c.status === "hot").length;

  const lines = [
    `📋 ${today} 物件出しリスト（${customers.length}名）`,
    "─────────────────",
    ...customers.map((c, i) => {
      const emoji = STATUS_EMOJI[c.status] ?? "🏠";
      const label = STATUS_LABEL[c.status] ?? "";
      const area = c.desired_area ? `　${c.desired_area}` : "";
      const days = c.days_since_sent !== null ? `（${c.days_since_sent}日前送信）` : "（未送信）";
      return `${i + 1}. ${emoji}【${label}】${c.customer_name}様${area}${days}`;
    }),
    "─────────────────",
    "完了したら「完了 [名前]」と返信してください",
  ];

  // 物件リストと名言を並行生成
  const [, quote] = await Promise.all([
    pushToLine(groupId, lines.join("\n")),
    generateQuote(hotCount, customers.length),
  ]);

  if (quote) {
    await pushToLine(groupId, quote);
  }

  return NextResponse.json({ ok: true, count: customers.length });
}
