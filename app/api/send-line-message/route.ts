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

// アカウントキーを解決する
// UIで明示指定されたアカウント（providedAccount）を最優先で使用する
// → long-press→アカウント変更でユーザーが指定したアカウントを確実に尊重する
async function resolveAccountKey(lineUserId: string, providedAccount?: string): Promise<string> {
  // UIから明示的に指定されたアカウントキーを最優先
  const validKeys = ["ieyasu", "giga", "hasu", "sumora"];
  if (providedAccount && validKeys.includes(providedAccount)) {
    return providedAccount;
  }
  // 日本語名で渡された場合も変換して使用
  if (providedAccount && ACCOUNT_KEY_MAP[providedAccount]) {
    return ACCOUNT_KEY_MAP[providedAccount];
  }

  // 未指定の場合のみ line_contacts を参照（フォールバック）
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
