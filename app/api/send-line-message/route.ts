import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// LINE アカウント → チャンネルアクセストークンのマッピング
// line_contacts.account（日本語名）→ 英語キー の変換も行う
const ACCOUNT_KEY_MAP: Record<string, string> = {
  "イエヤス": "ieyasu",
  "ギガ賃貸": "giga",
  "スモラ":   "sumora",
};

function getToken(accountKey?: string): string | undefined {
  switch (accountKey) {
    case "ieyasu": return process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN;
    case "giga":   return process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN;
    case "hasu":   return process.env.LINE_HASU_CHANNEL_ACCESS_TOKEN;
    default:       return process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  }
}

// line_contacts からアカウントキーを取得
// line_contacts が最も信頼できる情報源（webhookが正確に保存している）
// conversations.account は ADD COLUMN DEFAULT で全行 sumora になった可能性があるため後回し
async function resolveAccountKey(lineUserId: string, providedAccount?: string): Promise<string> {
  // line_contacts を最優先で参照
  const { data } = await supabase
    .from("line_contacts")
    .select("account")
    .eq("line_user_id", lineUserId)
    .limit(1)
    .single();

  if (data?.account) {
    const key = ACCOUNT_KEY_MAP[data.account as string];
    if (key) return key;
  }

  // line_contacts にデータがない場合のみ conversations.account を使用
  if (providedAccount && ["ieyasu", "giga", "hasu"].includes(providedAccount)) {
    return providedAccount;
  }

  return "sumora";
}

export async function POST(req: NextRequest) {
  const { line_user_id, message, image_url, account } = await req.json() as {
    line_user_id?: string;
    message?: string;
    image_url?: string;
    account?: string;
  };

  if (!line_user_id || (!message && !image_url)) {
    return NextResponse.json({ ok: false, error: "line_user_id and message or image_url required" }, { status: 400 });
  }

  // conversations.account が null/wrong でも line_contacts から正しいアカウントを解決
  const accountKey = await resolveAccountKey(line_user_id, account);
  const token = getToken(accountKey);

  if (!token) {
    return NextResponse.json({ ok: false, error: `LINE token not configured for account: ${accountKey}` }, { status: 500 });
  }

  const messages: unknown[] = [];
  if (message) messages.push({ type: "text", text: message });
  if (image_url) messages.push({ type: "image", originalContentUrl: image_url, previewImageUrl: image_url });

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: line_user_id, messages }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`LINE push error [${accountKey}]:`, text);
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }

  return NextResponse.json({ ok: true, account: accountKey });
}
