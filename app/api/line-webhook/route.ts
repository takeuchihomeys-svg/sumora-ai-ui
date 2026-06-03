import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

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

// ── conversation 取得 or 作成（共通）────────────────────────────────────
async function ensureConversation(
  db: ReturnType<typeof getDb>,
  userId: string,
  account: AccountConfig,
  now: string,
): Promise<string | null> {
  const { data: convRows } = await db
    .from("conversations")
    .select("id, account")
    .eq("line_user_id", userId)
    .limit(1);

  if (convRows && convRows.length > 0) {
    const convId = convRows[0].id as string;
    if (convRows[0].account !== account.key) {
      await db.from("conversations").update({ account: account.key }).eq("id", convId);
    }
    return convId;
  }

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
    return null;
  }
  return created.id as string;
}

// ── プロフィール非同期更新（共通）────────────────────────────────────────
function updateProfileAsync(
  db: ReturnType<typeof getDb>,
  userId: string,
  convId: string,
  account: AccountConfig,
  lastMessage: string,
  now: string,
): void {
  void (async () => {
    try {
      if (!account.token) return;
      const profile = await fetchLineProfile(userId, account.token);
      if (!profile) return;

      await db.from("line_contacts").upsert(
        {
          line_user_id: userId,
          line_name: profile.displayName ?? "名称未設定",
          line_profile_image: profile.pictureUrl ?? "",
          account: account.name,
          last_message: lastMessage.slice(0, 500),
          last_message_at: now,
        },
        { onConflict: "line_user_id,account" },
      );

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

// ── テキストメッセージ保存 ────────────────────────────────────────────────
async function handleTextMessage(
  userId: string,
  text: string,
  account: AccountConfig,
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const convId = await ensureConversation(db, userId, account, now);
  if (!convId) return;

  const { error: msgErr } = await db.from("messages").insert({
    conversation_id: convId,
    sender: "customer",
    text,
    created_at: now,
  });
  if (msgErr) console.error("[line-webhook] message保存失敗:", msgErr.message);

  await db
    .from("conversations")
    .update({ last_message: text, last_sender: "customer", updated_at: now })
    .eq("id", convId);

  updateProfileAsync(db, userId, convId, account, text, now);

  // 返信きたお客さんを自動で毎日物件出し（hot）に格上げ
  autoUpgradeToHot(db, userId);

  // LINEフォーマット自動検知・解析
  if (isFormatMessage(text)) {
    void (async () => {
      try { await autoParseFormat(db, userId, text); } catch {}
    })();
  }
}

async function autoUpgradeToHot(db: ReturnType<typeof getDb>, userId: string) {
  const { data } = await db
    .from("property_customers")
    .select("id, status, customer_name")
    .eq("line_user_id", userId)
    .in("status", ["new_inquiry", "property_search"])
    .limit(1)
    .single();
  if (data?.id) {
    await db
      .from("property_customers")
      .update({ status: "hot", updated_at: new Date().toISOString() })
      .eq("id", data.id);
    void notifyHanbancyoGroup(db, data.customer_name ?? "");
  }
}

function isFormatMessage(text: string): boolean {
  // 丸数字が2つ以上 → フォーマットと判定
  const circled = (text.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g) ?? []).length;
  if (circled >= 2) return true;
  // フォーマットキーワードが3つ以上含まれている
  const keywords = ["入居時期", "希望家賃", "家賃", "希望地域", "希望エリア", "間取り", "徒歩", "初期費用", "築年数", "エリア"];
  return keywords.filter((k) => text.includes(k)).length >= 3;
}

async function autoParseFormat(db: ReturnType<typeof getDb>, userId: string, text: string) {
  // AI でフォーマット解析（先に実行）
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let parsed: Record<string, unknown>;
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `あなたは不動産業者のアシスタントです。
以下のテキストから物件検索条件を読み取ってJSONで返してください。

【重要】
- フォーマットが崩れていたり、書き方がバラバラでも最大限読み取る
- 「11万以内」→ rent_max: 110000 のように数値（円）に変換
- 「2ヶ月後くらい」のような曖昧な表現もそのまま文字列で入れる
- 「1DK・1LDK」のように複数ある場合はそのまま文字列で入れる
- 不明な項目は null にする（絶対に省略しない）

返すJSONの形式（これ以外の形式で返さない）:
{
  "move_in_time": "入居時期（文字列またはnull）",
  "rent_min": 最低賃料の数値か null,
  "rent_max": 最高賃料の数値か null,
  "desired_area": "希望地域・駅名（文字列またはnull）",
  "walk_minutes": 徒歩分数の数値か null,
  "floor_plan": "希望間取り（文字列またはnull）",
  "initial_cost_limit": 初期費用上限の数値か null,
  "building_age": 築年数上限の数値か null,
  "other_requests": "その他要望（文字列またはnull）"
}

テキスト:
${text}

JSONのみ返してください。説明文・コードブロック・マークダウンは一切不要です。`,
      }],
    });
    const raw = res.content[0].type === "text" ? res.content[0].text : "";
    const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
    if (!match) return;
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return;
  }

  // 保存するフィールドを準備
  const parsedFields: Record<string, unknown> = {
    format_received: true,
    raw_format_text: text,
    updated_at: new Date().toISOString(),
  };
  for (const f of ["move_in_time", "rent_min", "rent_max", "desired_area", "walk_minutes", "floor_plan", "initial_cost_limit", "building_age", "other_requests"]) {
    if (parsed[f] !== null && parsed[f] !== undefined) parsedFields[f] = parsed[f];
  }

  // property_customers を line_user_id で検索
  const { data: existing } = await db
    .from("property_customers")
    .select("id, customer_name")
    .eq("line_user_id", userId)
    .limit(1)
    .single();

  let customerId: string;
  let customerName: string;

  if (existing?.id) {
    // 既存顧客 → UPDATE（nullは上書きしない）
    await db.from("property_customers").update(parsedFields).eq("id", existing.id);
    customerId = existing.id as string;
    customerName = existing.customer_name as string;
  } else {
    // 未登録 → 会話から名前を取得して自動新規登録
    const { data: conv } = await db
      .from("conversations")
      .select("customer_name")
      .eq("line_user_id", userId)
      .limit(1)
      .single();
    customerName = (conv?.customer_name as string | undefined) ?? "名称未設定";

    const { data: newCustomer } = await db
      .from("property_customers")
      .insert({ customer_name: customerName, line_user_id: userId, status: "new_inquiry", ...parsedFields })
      .select("id")
      .single();
    if (!newCustomer?.id) return;
    customerId = newCustomer.id as string;
  }

  // conversations.property_customer_id を自動セット → 紐付け済みバッジが立つ
  await db
    .from("conversations")
    .update({ property_customer_id: customerId })
    .eq("line_user_id", userId)
    .is("property_customer_id", null);

  // 売上番長グループに通知
  void notifyFormatReceived(db, customerName);
}

async function notifyFormatReceived(db: ReturnType<typeof getDb>, customerName: string) {
  const { data } = await db
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .single();
  const groupId = data?.value as string | undefined;
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  if (!groupId || !token) return;

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      to: groupId,
      messages: [{ type: "text", text: `🏠 ${customerName}様からフォーマットが届きました！\n条件を自動取得・売上サポに登録しました。今すぐ物件を探しましょう！` }],
    }),
  });
}

async function notifyHanbancyoGroup(db: ReturnType<typeof getDb>, customerName: string) {
  const { data } = await db
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .single();
  const groupId = data?.value as string | undefined;
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  if (!groupId || !token) return;

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: groupId,
      messages: [{
        type: "text",
        text: `🔥 ${customerName}様から返信が来ました！\n自動でhotに格上げしました。今すぐ物件を送りましょう！`,
      }],
    }),
  });
}

// ── 画像メッセージ即時保存（LINEへの応答前に完了させる軽量処理）────────────
// 重複防止のため line_message_id で存在確認してから insert
async function handleImageMessageSave(
  userId: string,
  lineMessageId: string,
  account: AccountConfig,
): Promise<{ convId: string; msgId: string } | null> {
  const db = getDb();
  const now = new Date().toISOString();

  const convId = await ensureConversation(db, userId, account, now);
  if (!convId) return null;

  // 重複チェック（LINEのリトライで同じ lineMessageId が来ることがある）
  const { data: existing } = await db
    .from("messages")
    .select("id")
    .eq("line_message_id", lineMessageId)
    .maybeSingle();
  if (existing) {
    console.log("[line-webhook] 重複スキップ:", lineMessageId);
    return null;
  }

  // image_url は後から埋める。まず line_message_id だけ保存して即座に会話に表示
  const { data: msgData, error: msgErr } = await db.from("messages").insert({
    conversation_id: convId,
    sender: "customer",
    text: "[画像]",
    image_url: null,
    line_message_id: lineMessageId,
    created_at: now,
  }).select("id").single();

  if (msgErr) {
    console.error("[line-webhook] image message保存失敗:", msgErr.message);
    return null;
  }

  await db
    .from("conversations")
    .update({ last_message: "[画像]", last_sender: "customer", updated_at: now })
    .eq("id", convId);

  updateProfileAsync(db, userId, convId, account, "[画像]", now);
  return { convId, msgId: String(msgData.id) };
}

// ── LINE Content API から画像を取得してStorageに保存（after()で非同期実行）──
async function fetchAndUploadLineImage(
  lineMessageId: string,
  msgId: string,
  account: AccountConfig,
): Promise<void> {
  if (!account.token) return;
  const db = getDb();

  try {
    const contentRes = await fetch(
      `https://api-data.line.me/v2/bot/message/${lineMessageId}/content`,
      { headers: { Authorization: `Bearer ${account.token}` } },
    );

    if (!contentRes.ok) {
      console.warn(`[line-webhook] Content API失敗 status=${contentRes.status} msgId=${lineMessageId}`);
      return;
    }

    const contentType = contentRes.headers.get("content-type") || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : contentType.includes("gif") ? "gif" : "jpg";

    // Blob を使用（Buffer よりも Supabase Storage との互換性が高い）
    const blob = new Blob([await contentRes.arrayBuffer()], { type: contentType });
    const storagePath = `line-images/${lineMessageId}.${ext}`;

    const { error: uploadErr } = await db.storage
      .from("property-images")
      .upload(storagePath, blob, { contentType, upsert: true });

    if (uploadErr) {
      console.error("[line-webhook] Storage upload失敗:", uploadErr.message, "msgId:", lineMessageId);
      return;
    }

    const { data: urlData } = db.storage
      .from("property-images")
      .getPublicUrl(storagePath);

    const { error: updateErr } = await db.from("messages")
      .update({ image_url: urlData.publicUrl })
      .eq("id", msgId);

    if (updateErr) {
      console.error("[line-webhook] image_url更新失敗:", updateErr.message);
    } else {
      console.log("[line-webhook] 画像保存完了:", lineMessageId);
    }
  } catch (e) {
    console.error("[line-webhook] 画像処理エラー:", e);
  }
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

  // 画像メッセージの後処理用（after()で非同期実行する分）
  const imageJobs: Array<{ lineMessageId: string; msgId: string; account: typeof matchedAccount }> = [];

  for (const ev of events) {
    const event = ev as {
      type: string;
      source?: { userId?: string };
      message?: { type: string; id?: string; text?: string };
    };

    if (event.type !== "message") continue;
    if (event.source?.userId == null) continue;

    const msgType = event.message?.type;
    const userId = event.source.userId;

    if (msgType === "text") {
      const text = event.message?.text;
      if (!text) continue;
      await handleTextMessage(userId, text, matchedAccount);
    } else if (msgType === "image") {
      const lineMessageId = event.message?.id;
      if (!lineMessageId) continue;
      // 即時保存（重複チェック込み）してから後処理キューに積む
      const saved = await handleImageMessageSave(userId, lineMessageId, matchedAccount);
      if (saved) {
        imageJobs.push({ lineMessageId, msgId: saved.msgId, account: matchedAccount });
      }
    }
    // video / audio / file は現状スキップ
  }

  // LINEへの200レスポンスを先に返し、画像fetch/uploadはレスポンス後に実行
  // after()はNext.js 14.1+の機能。レスポンス送信後もVercel functionを維持する
  if (imageJobs.length > 0) {
    after(async () => {
      for (const { lineMessageId, msgId, account } of imageJobs) {
        await fetchAndUploadLineImage(lineMessageId, msgId, account);
      }
    });
  }

  return NextResponse.json({ ok: true });
}
