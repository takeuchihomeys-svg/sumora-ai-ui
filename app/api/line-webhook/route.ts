import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ── LINE アカウント設定（スモラ・イエヤス・ギガ賃貸） ──────────────────
type AccountConfig = {
  name: string;
  key: string; // send-line-message/route.ts の getToken() と一致する英語キー
  secret: string | undefined;
  token: string | undefined;
};

const ACCOUNTS: AccountConfig[] = [
  {
    name: "スモラ",
    key: "sumora",
    secret: process.env.LINE_SUMORA_CHANNEL_SECRET,
    token: process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN,
  },
  {
    name: "イエヤス",
    key: "ieyasu",
    secret: process.env.LINE_IEYASU_CHANNEL_SECRET,
    token: process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN,
  },
  {
    name: "ギガ賃貸",
    key: "giga",
    secret: process.env.LINE_GIGA_CHANNEL_SECRET,
    token: process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN,
  },
];

// ── LINE 署名検証 ──────────────────────────────────────────────────────
async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signed)));
  return expected === signature;
}

// ── LINE プロフィール取得 ─────────────────────────────────────────────
async function fetchLineProfile(
  userId: string,
  token: string,
): Promise<{ displayName?: string; pictureUrl?: string } | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as { displayName?: string; pictureUrl?: string };
  } catch {
    return null;
  }
}

// ── Supabase クライアント ─────────────────────────────────────────────
function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

// ── メッセージ保存処理 ────────────────────────────────────────────────
async function handleTextMessage(
  userId: string,
  text: string,
  account: AccountConfig,
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  // 1. conversations を取得 or 作成
  const { data: convRows } = await db
    .from("conversations")
    .select("id, customer_name, profile_image_url, account")
    .eq("line_user_id", userId)
    .limit(1);

  let convId: number;

  if (convRows && convRows.length > 0) {
    convId = convRows[0].id as number;
    // account が違う場合は常に正しい値に修正（ADD COLUMN DEFAULT 'sumora' で全行が sumora になった対策）
    if (convRows[0].account !== account.key) {
      await db.from("conversations").update({ account: account.key }).eq("id", convId);
    }
  } else {
    const { data: created, error: createErr } = await db
      .from("conversations")
      .insert({
        line_user_id: userId,
        customer_name: "名称未設定",
        account: account.key,
        status: "first_reply",
        updated_at: now,
      })
      .select("id")
      .single();
    if (createErr || !created) {
      console.error("[line-webhook] conversation作成失敗:", createErr?.message);
      return;
    }
    convId = created.id as number;
  }

  // 2. messages テーブルに保存
  const { error: msgErr } = await db.from("messages").insert({
    conversation_id: convId,
    sender: "customer",
    text,
    created_at: now,
  });
  if (msgErr) console.error("[line-webhook] message保存失敗:", msgErr.message);

  // 3. conversations.last_message を更新
  await db
    .from("conversations")
    .update({ last_message: text, last_sender: "customer", updated_at: now })
    .eq("id", convId);

  // 4. LINE プロフィール取得 → line_contacts upsert + conversations 更新（非同期）
  void (async () => {
    try {
      if (!account.token) return;
      const profile = await fetchLineProfile(userId, account.token);
      if (!profile) return;

      // line_contacts upsert（LINE管理画面で使用）
      await db.from("line_contacts").upsert(
        {
          line_user_id: userId,
          line_name: profile.displayName ?? "名称未設定",
          line_profile_image: profile.pictureUrl ?? "",
          account: account.name,
          last_message: text.slice(0, 500),
          last_message_at: now,
        },
        { onConflict: "line_user_id,account" },
      );

      // conversations.customer_name / profile_image_url を更新
      const patch: Record<string, string> = {};
      if (profile.displayName) patch.customer_name = profile.displayName;
      if (profile.pictureUrl) patch.profile_image_url = profile.pictureUrl;
      if (Object.keys(patch).length > 0) {
        await db.from("conversations").update(patch).eq("id", convId);
      }
    } catch (e) {
      console.warn("[line-webhook] プロフィール取得エラー:", e);
    }
  })();
}

// destination → account key のマッピング（各LINE公式アカウントのBot User ID）
const DESTINATION_MAP: Record<string, string> = {
  [process.env.LINE_SUMORA_DESTINATION ?? ""]: "sumora",
  [process.env.LINE_IEYASU_DESTINATION ?? ""]: "ieyasu",
  [process.env.LINE_GIGA_DESTINATION ?? ""]: "giga",
};

// ── POST ──────────────────────────────────────────────────────────────
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  let body: { destination?: string; events?: unknown[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // 1. destination フィールドでアカウントを一発判定
  const destination = body.destination ?? "";
  const accountKey = DESTINATION_MAP[destination];
  const matchedAccount = ACCOUNTS.find((a) => a.key === accountKey);

  if (!matchedAccount) {
    console.warn("[line-webhook] 未知のdestination:", destination);
    return NextResponse.json({ error: "unknown destination" }, { status: 400 });
  }

  // 2. 署名検証（セキュリティ確保）
  if (matchedAccount.secret) {
    const valid = await verifySignature(rawBody, signature, matchedAccount.secret);
    if (!valid) {
      console.warn("[line-webhook] 署名検証失敗:", matchedAccount.key);
      return NextResponse.json({ error: "invalid signature" }, { status: 400 });
    }
  }

  const events = body.events ?? [];

  for (const ev of events) {
    const event = ev as {
      type: string;
      source?: { userId?: string };
      message?: { type: string; text?: string };
    };

    if (event.type !== "message") continue;
    if (event.source?.userId == null) continue;
    if (event.message?.type !== "text") continue;
    const text = event.message.text;
    if (!text) continue;

    await handleTextMessage(event.source.userId, text, matchedAccount);
  }

  return NextResponse.json({ ok: true });
}
