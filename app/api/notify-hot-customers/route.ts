import { NextRequest, NextResponse } from "next/server";

const ACCOUNT_LABEL: Record<string, string> = {
  sumora: "スモラ",
  ieyasu: "イエヤス",
  giga: "ギガ賃貸",
  hasu: "ハス",
};

function getRelativeTime(dateString?: string): string {
  if (!dateString) return "不明";
  const diff = Date.now() - new Date(dateString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

export async function POST(req: NextRequest) {
  const { customers } = await req.json() as {
    customers: Array<{
      name: string;
      account: string;
      lastMessage: string;
      updatedAt?: string;
    }>;
  };

  if (!customers || customers.length === 0) {
    return NextResponse.json({ ok: false, error: "No customers" }, { status: 400 });
  }

  const targetId = process.env.LINE_STAFF_GROUP_ID;
  if (!targetId) {
    return NextResponse.json({ ok: false, error: "LINE_STAFF_GROUP_ID not configured" }, { status: 500 });
  }

  const token = process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "LINE token not configured" }, { status: 500 });
  }

  const lines = customers.map((c, i) => {
    const acct = ACCOUNT_LABEL[c.account] ?? c.account;
    const time = getRelativeTime(c.updatedAt);
    const preview = c.lastMessage.length > 25 ? c.lastMessage.slice(0, 25) + "…" : c.lastMessage;
    return `${i + 1}. ${c.name}（${acct}）\n   ${time} | ${preview}`;
  });

  const message = `🔥 あついお客さん（${customers.length}人）\n\nLINE返信を優先してください！\n\n${lines.join("\n\n")}\n\n—— AIX LINX ——`;

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: targetId,
      messages: [{ type: "text", text: message }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("notify-hot-customers LINE error:", text);
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sent: customers.length });
}
