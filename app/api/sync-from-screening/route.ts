import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import webpush from "web-push";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

const anthropic = new Anthropic({ timeout: 30_000 });

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:takeuchi.homeys@gmail.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Supabase Database Webhook payload shape
interface DbWebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

// LINE アカウント定義（どのBotをフォローしているかで判定）
const LINE_ACCOUNTS = [
  { key: "ieyasu", token: process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN },
  { key: "giga",   token: process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN },
  { key: "sumora", token: process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN },
] as const;

// LINE Profile API でどのアカウントのBotをフォローしているか判定（line_contactsをキャッシュとして使用）
async function resolveAccountByLineUserId(lineUserId: string): Promise<string | null> {
  const ACCOUNT_MAP: Record<string, string> = {
    "スモラ": "sumora", sumora: "sumora",
    "イエヤス": "ieyasu", ieyasu: "ieyasu",
    "ギガ賃貸": "giga", giga: "giga",
  };
  const { data: contact } = await supabase
    .from("line_contacts")
    .select("account")
    .eq("line_user_id", lineUserId)
    .limit(1)
    .maybeSingle();
  if (contact?.account) {
    return ACCOUNT_MAP[contact.account as string] ?? null;
  }

  for (const acct of LINE_ACCOUNTS) {
    if (!acct.token) continue;
    try {
      const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
        headers: { Authorization: `Bearer ${acct.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return acct.key;
    } catch { /* skip */ }
  }
  return null;
}

// フォーマットメッセージ検知（①入居時期 などのキーワードを含む長文）
function isFormatMessage(text: string): boolean {
  if (text.length < 30) return false;
  const hasNumbered = text.includes("①") || text.includes("②") || text.includes("③");
  const hasKeyword =
    text.includes("入居時期") ||
    text.includes("希望家賃") ||
    (text.includes("家賃") && text.includes("地域")) ||
    (text.includes("家賃") && text.includes("間取"));
  return hasNumbered || hasKeyword;
}

// 内覧・内見・申込意思ありキーワード検知
function isNaikanIntent(text: string): boolean {
  const keywords = [
    // 内覧・内見系
    "内覧", "内見", "見に行", "見学", "見せてほしい", "見せてください", "お部屋見",
    // 行きたい系
    "見たい", "行きたい",
    // 気に入り系
    "気に入り", "気に入った", "気にいり", "気にいった",
    // 申込系
    "申込", "申し込", "申込み",
    // 決定系
    "決めたい", "決めました", "決めます", "決まり", "ここにし", "これにし",
    "ここで決", "これで決", "ここにします", "これにします",
  ];
  return keywords.some(kw => text.includes(kw));
}

// Anthropic でフォーマットテキストを条件JSONに変換
async function parseConditionsWithAI(text: string): Promise<Record<string, unknown> | null> {
  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `不動産検索条件をJSONで返してください。数値は円単位。不明はnull。
返すJSONのみ（説明不要）:
{"move_in_time":null,"rent_min":null,"rent_max":null,"desired_area":null,"walk_minutes":null,"floor_plan":null,"initial_cost_limit":null,"building_age":null,"other_requests":null}

テキスト:
${text}`,
      }],
    });
    const raw = msg.content[0].type === "text" ? msg.content[0].text : "";
    const match = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// LINEフォーマットが届いたとき: property_customer を自動作成・紐付け or 追加条件を保存
async function handleFormatMessage(conversationId: string, msgText: string): Promise<void> {
  const { data: conv } = await supabase
    .from("conversations")
    .select("id, customer_name, property_customer_id, line_user_id, account")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv) return;

  if (!conv.property_customer_id) {
    // 初回フォーマット: 条件解析 → 新規 property_customer 作成 → 紐付け
    const conditions = await parseConditionsWithAI(msgText);
    const { data: newCustomer } = await supabase
      .from("property_customers")
      .insert({
        customer_name: conv.customer_name || "名前未設定",
        line_user_id: conv.line_user_id || null,
        account: conv.account || null,
        status: "new_inquiry",
        format_received: true,
        ...(conditions || {}),
      })
      .select()
      .maybeSingle();
    if (newCustomer) {
      await supabase
        .from("conversations")
        .update({ property_customer_id: (newCustomer as { id: string }).id })
        .eq("id", conversationId);
    }
  } else {
    // 追加フォーマット: additional_conditions に追記
    const { data: existing } = await supabase
      .from("property_customers")
      .select("additional_conditions")
      .eq("id", conv.property_customer_id)
      .maybeSingle();
    const prev = (existing as { additional_conditions?: string } | null)?.additional_conditions || "";
    const ts = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const updated = prev ? `${prev}\n\n[${ts}]\n${msgText}` : `[${ts}]\n${msgText}`;
    await supabase
      .from("property_customers")
      .update({ additional_conditions: updated })
      .eq("id", conv.property_customer_id);
  }
}

// Web Push: 全登録端末に通知を送る
async function sendWebPush(title: string, body: string) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;

  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth");
  if (!subs || subs.length === 0) return;

  const payload = JSON.stringify({ title, body, url: "/" });
  const staleEndpoints: string[] = [];

  await Promise.allSettled(
    subs.map(async (s: { endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        );
      } catch (err: unknown) {
        // 期限切れ・無効なsubscriptionを削除
        if (err && typeof err === "object" && "statusCode" in err &&
            ((err as { statusCode: number }).statusCode === 410 || (err as { statusCode: number }).statusCode === 404)) {
          staleEndpoints.push(s.endpoint);
        }
      }
    })
  );

  if (staleEndpoints.length > 0) {
    await supabase.from("push_subscriptions").delete().in("endpoint", staleEndpoints);
  }
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-sync-secret");
  if (!process.env.SYNC_SECRET || secret !== process.env.SYNC_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: DbWebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { type, table, record } = payload;

  if (type === "DELETE" || !record) {
    return NextResponse.json({ ok: true, action: "ignored" });
  }

  if (table === "conversations") {
    const ACCOUNT_MAP: Record<string, string> = {
      "スモラ":   "sumora",  sumora:  "sumora",
      "イエヤス": "ieyasu",  ieyasu:  "ieyasu",
      "ギガ賃貸": "giga",    giga:    "giga",
    };
    const rawAccount = record.account as string | null | undefined;
    let resolvedAccount = rawAccount ? (ACCOUNT_MAP[rawAccount] ?? rawAccount) : null;

    if (!resolvedAccount && record.line_user_id) {
      resolvedAccount = await resolveAccountByLineUserId(record.line_user_id as string);
    }

    const upsertData: Record<string, unknown> = {
      id: String(record.id),
      customer_name: record.customer_name ?? null,
      status: record.status ?? null,
      line_user_id: record.line_user_id ?? "",
      last_message: record.last_message ?? null,
      last_sender: record.last_sender ?? null,
      updated_at: record.updated_at ?? null,
      profile_image_url: record.profile_image_url ?? null,
    };

    // 手動設定済みのアカウントを上書きしない
    // スモラ・イエヤス両方に問い合わせているお客さんで、
    // 同期のたびに resolvedAccount が変わってアカウントが入れ替わるのを防ぐ
    if (resolvedAccount) {
      const { data: existingConv } = await supabase
        .from("conversations")
        .select("account")
        .eq("id", String(record.id))
        .maybeSingle();
      if (!existingConv?.account) {
        // 新規 or 未設定の場合のみアカウントをセット
        upsertData.account = resolvedAccount;
      }
    }

    const { error } = await supabase
      .from("conversations")
      .upsert(upsertData, { onConflict: "id" });

    // M-7: id は違うが同一 (line_user_id, account) の会話が既に存在する場合、
    // 部分UNIQUEインデックス idx_conversations_line_user_id_account_unique に当たって
    // duplicate key (23505) になる。この場合は既存行への UPDATE にフォールバックする。
    // ※ onConflict: "line_user_id,account" は部分インデックスのため PostgREST の推論が効かず使えない
    if (error && error.code === "23505" && upsertData.line_user_id) {
      const { id: _dupId, account: _dupAccount, ...updateFields } = upsertData;
      let updateQuery = supabase
        .from("conversations")
        .update(updateFields)
        .eq("line_user_id", upsertData.line_user_id as string);
      if (resolvedAccount) updateQuery = updateQuery.eq("account", resolvedAccount);
      const { error: fallbackErr } = await updateQuery;
      if (fallbackErr) {
        console.error("sync conversations fallback update error:", fallbackErr.code, fallbackErr.message);
        return NextResponse.json({ error: fallbackErr.message }, { status: 500 });
      }
      console.log("[sync] conversations duplicate (line_user_id, account) → 既存行にUPDATEフォールバック:", upsertData.line_user_id);
      return NextResponse.json({ ok: true, synced: "conversation", id: record.id, account: resolvedAccount, deduped: true });
    }

    if (error) {
      console.error("sync conversations error:", error.code, error.message, error.details, error.hint);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, synced: "conversation", id: record.id, account: resolvedAccount });
  }

  if (table === "messages") {
    if (record.sender === "staff") {
      return NextResponse.json({ ok: true, action: "ignored_staff_message" });
    }

    let imageUrl: string | null = (record.image_url as string) ?? null;

    // 画像メッセージ検出: より広い条件で判定
    const msgText = String(record.text ?? "");
    const msgType = String(record.message_type ?? record.type ?? "");
    const isImageMsg = !imageUrl && record.sender === "customer" && (
      msgText === "[画像]" ||
      msgText === "[image]" ||
      msgText === "" ||
      msgType === "image"
    );

    if (isImageMsg) {
      // LINE message IDを複数フィールド名で探す（DBのIDではなくLINEのメッセージID）
      const lineMessageId = (
        (record.line_message_id as string) ||
        (record.lineMessageId as string) ||
        (record.message_id as string) ||
        (record.line_id as string) ||
        null
      );

      console.log("[sync] 画像メッセージ検出:", {
        id: record.id,
        text: msgText,
        type: msgType,
        line_message_id: lineMessageId,
        keys: Object.keys(record).join(","),
      });

      if (lineMessageId) {
        const { data: conv } = await supabase
          .from("conversations")
          .select("account")
          .eq("id", String(record.conversation_id))
          .maybeSingle();

        const TOKEN_MAP: Record<string, string | undefined> = {
          sumora: process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN,
          ieyasu: process.env.LINE_IEYASU_CHANNEL_ACCESS_TOKEN,
          giga:   process.env.LINE_GIGA_CHANNEL_ACCESS_TOKEN,
        };
        const token = conv?.account ? TOKEN_MAP[conv.account as string] : undefined;

        if (token) {
          try {
            const contentRes = await fetch(
              `https://api-data.line.me/v2/bot/message/${lineMessageId}/content`,
              { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }
            );
            if (contentRes.ok) {
              const contentType = contentRes.headers.get("content-type") || "image/jpeg";
              const ext = contentType.includes("png") ? "png" : contentType.includes("gif") ? "gif" : "jpg";
              const arrayBuffer = await contentRes.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              const storagePath = `${lineMessageId}.${ext}`;

              const { error: uploadErr } = await supabase.storage
                .from("line-images")
                .upload(storagePath, buffer, { contentType, upsert: true });

              if (!uploadErr) {
                const { data: urlData } = supabase.storage
                  .from("line-images")
                  .getPublicUrl(storagePath);
                imageUrl = urlData.publicUrl;
                console.log("[sync] LINE画像を取得・保存:", storagePath);
              } else {
                console.error("[sync] Storage upload error:", uploadErr.message);
              }
            } else {
              console.warn("[sync] LINE Content API returned", contentRes.status, "for message", lineMessageId);
            }
          } catch (err) {
            console.error("[sync] LINE Content API fetch error:", err);
          }
        }
      } else {
        console.warn("[sync] line_message_id が見つかりません。利用可能なフィールド:", Object.keys(record).join(", "));
      }
    }

    const expiresAt = isImageMsg && imageUrl
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    // 顧客テキストメッセージは line-webhook が唯一の保存経路
    // screening-admin のレコードに line_message_id が含まれないため UNIQUE 制約が機能せず
    // line_message_id の有無に関わらず常にスキップする
    let skipUpsert = false;
    if (!isImageMsg && record.sender === "customer") {
      skipUpsert = true;
      const lmid = (record.line_message_id as string) || (record.lineMessageId as string) || (record.message_id as string) || null;
      console.log("[sync] 顧客テキストスキップ (line-webhook管轄):", lmid ?? `id=${record.id}`);
    }

    if (!skipUpsert) {
      const { error } = await supabase
        .from("messages")
        .upsert(
          {
            id: record.id,
            conversation_id: record.conversation_id,
            sender: record.sender,
            text: record.text ?? "",
            image_url: imageUrl,
            ...(expiresAt ? { image_expires_at: expiresAt } : {}),
            created_at: record.created_at,
          },
          { onConflict: "id" }
        );

      if (error) {
        if (error.code === "23505") {
          // UNIQUE制約違反 = line-webhookが同時に保存済み。正常扱い
          console.log("[sync] DB UNIQUE制約で重複を検知・スキップ:", error.message);
        } else {
          console.error("sync messages error:", error);
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
      }
    }

    // フォーマットメッセージ検知 → property_customer 自動作成・追加条件保存
    if (record.sender === "customer" && isFormatMessage(msgText)) {
      handleFormatMessage(String(record.conversation_id), msgText).catch(() => {});
    }

    // 内覧/申込意思キーワード → 🔥自動セット（未設定の場合のみ）
    if (record.sender === "customer" && isNaikanIntent(msgText)) {
      const { data: convData } = await supabase
        .from("conversations")
        .select("is_hot")
        .eq("id", String(record.conversation_id))
        .maybeSingle();
      if (convData && !convData.is_hot) {
        await supabase
          .from("conversations")
          .update({ is_hot: true })
          .eq("id", String(record.conversation_id));
      }
    }

    // お客さんのメッセージが届いたら Web Push 通知を送る
    if (record.sender === "customer") {
      const notifBody = isImageMsg
        ? "📷 画像が届きました"
        : msgText || "新しいメッセージが届きました";
      sendWebPush("AIX LINX — 新着メッセージ", notifBody).catch(() => {});
    }

    return NextResponse.json({ ok: true, synced: "message", id: record.id, image_fetched: !!imageUrl });
  }

  // ── カレンダーイベント同期 ──────────────────────────────────────────────────
  if (table === "calendar_events") {
    const { error } = await supabase
      .from("calendar_events")
      .upsert(
        {
          id:            String(record.id),
          title:         record.title         ?? "",
          event_type:    record.event_type    ?? "other",
          customer_name: record.customer_name ?? "",
          start_at:      record.start_at      ?? new Date().toISOString(),
          end_at:        record.end_at        ?? null,
          all_day:       record.all_day       ?? false,
          notes:         record.notes         ?? "",
        },
        { onConflict: "id" }
      );

    if (error) {
      console.error("sync calendar_events error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, synced: "calendar_event", id: record.id });
  }

  return NextResponse.json({ ok: true, action: "ignored_unknown_table", table });
}
