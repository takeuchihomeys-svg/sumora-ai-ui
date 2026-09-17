import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { resolveScreeningSync } from "@/app/lib/conversation-status";
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
    const raw = msg.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
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

/** 審査管理から実際に送ったスタッフの発言が会話の最新なら、会話の最後の発言者・最後のメッセージをこの発言にする */
async function markStaffMessageAsLatest(conversationId: string, messageId: string, text: string, createdAt: string): Promise<void> {
  try {
    const { data: newest } = await supabase.from("messages").select("id, created_at").eq("conversation_id", conversationId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!newest || newest.id !== messageId) return;
    const { data: conv } = await supabase.from("conversations").select("updated_at").eq("id", conversationId).maybeSingle();
    // updated_at は進める時だけ（巻き戻さない）
    const advance = !!createdAt && Date.parse(createdAt) > Date.parse(String(conv?.updated_at ?? "1970-01-01T00:00:00Z"));
    const { error } = await supabase.from("conversations").update({
      last_message: (text || "[画像]").slice(0, 500), last_sender: "staff", ai_draft: null, suggested_aix_meta: null,
      ...(advance ? { updated_at: createdAt } : {}),
    }).eq("id", conversationId);
    if (error) console.warn("[sync] mark staff latest failed:", error.message);
    else console.log(JSON.stringify({ tag: "sync:staff-latest", conversationId }));
  } catch (e) {
    console.warn("[sync] mark staff latest failed:", e instanceof Error ? e.message : e);
  }
}

/** 同期で状態を動かした時は履歴に残す（2026-09-15 隼斗事例: 同期の書き込みだけ履歴が無く「誰が審査中に戻したか」を追えなかった） */
async function recordSyncStatusChange(c: { convId: string; from: string | null; to: string } | null): Promise<void> {
  if (!c) return;
  const { error } = await supabase.from("conversation_stage_history").insert({
    conversation_id: c.convId, from_status: c.from, to_status: c.to, trigger: "sync_screening",
  });
  if (error) console.warn("[sync] stage_history insert failed:", error.message);
  console.log(JSON.stringify({ tag: "sync:status-change", conversationId: c.convId, from: c.from, to: c.to }));
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

    // 注意: acquisition_source は絶対に upsertData に含めない。
    // line-webhook が初回顧客メッセージから一度だけセットする（sync で上書きすると事実が消える）
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

    const { data: existingConv } = await supabase
      .from("conversations")
      .select("account, updated_at, status, is_post_apply, screening_last_status, status_manual_back_at")
      .eq("id", String(record.id))
      .maybeSingle();

    // 2026-09-14 竹内（タクミ事例）「申込中にしているのに物件提案中に戻ってしまう」: 状態はこちら（AIXLINX）でスタッフが管理している。
    //   審査管理も同じ LINE を受けて会話を更新するたびにここが呼ばれ、先方の状態（property_recommendation）で無条件に上書きしていた
    //   （申込中にした後、お客様の「よろしくお願い致します！」の同期で物件提案中に戻った）。先の段階へ進める時だけ書く（conversation-status.ts）
    // 2026-09-15 竹内（隼斗事例）「否決で物件提案中に戻したのに、時間が経つと申込・審査中に戻る」: 審査管理の状態は否決の後も screening のまま届き続け、
    //   「先へ進める」で何度も審査中に戻していた。審査管理の状態が前回の同期から変わった時だけ動かす（resolveScreeningSync・screening_last_status）
    let statusChange: { convId: string; from: string | null; to: string } | null = null;
    // 2026-09-15 竹内（ゆうこ・S・YUYA 事例「AIX をセットしているのに一覧に AIX が出ない」）: 審査管理の会話の last_message / last_sender は、
    //   LINE に送っていない審査管理の AI 自動生成文（スタッフ扱い）で更新される。それで既存の会話を上書きしていたため、お客様の発言が最新なのに
    //   「最後の発言者＝スタッフ」「最後のメッセージ＝送っていない AI の文」になった（直近7日で会話80件中26件）。
    //   → 一覧の AIX・要対応の印が消え、下書きの自動作成（bg-async・取りこぼし救済）・brain-sweep も「お客様の番ではない」で止まる。
    //   既存の会話のこの2つは、こちらの受信（line-webhook）・送信（画面・予約送信）・審査管理から実際に送った発言の同期（下の messages）が書く
    if (existingConv) {
      delete upsertData.last_message;
      delete upsertData.last_sender;
    }
    if (existingConv) {
      // 2026-09-16 竹内（𝒮 さん事例）: スタッフが手で前の段階に戻した会話は、同期で自動で前に戻さない
      const r = resolveScreeningSync(existingConv.status as string | null, upsertData.status as string | null,
        (existingConv as { screening_last_status?: string | null }).screening_last_status ?? null,
        { isPostApply: !!existingConv.is_post_apply, manualBack: !!(existingConv as { status_manual_back_at?: string | null }).status_manual_back_at });
      if (r.status === null) delete upsertData.status;
      else upsertData.status = r.status;
      upsertData.screening_last_status = r.lastSeen;
      if (r.status !== null && r.status !== existingConv.status) statusChange = { convId: String(record.id), from: (existingConv.status as string | null) ?? null, to: r.status };
    } else {
      upsertData.screening_last_status = (upsertData.status as string | null) ?? null;
    }

    // 手動設定済みのアカウントを上書きしない
    // スモラ・イエヤス両方に問い合わせているお客さんで、
    // 同期のたびに resolvedAccount が変わってアカウントが入れ替わるのを防ぐ
    if (resolvedAccount && !existingConv?.account) {
      // 新規 or 未設定の場合のみアカウントをセット
      upsertData.account = resolvedAccount;
    }

    // P3(診断修正): updated_at は「既存値より新しい場合のみ」上書きする。
    // brain-core B5 の楽観ロック（.eq("updated_at", watermark)）が sync の巻き戻し/同値上書きで
    // 不一致になり suggested_aix_meta の書き戻しが no-op になる競合を減らす。
    if (existingConv) {
      const incoming = upsertData.updated_at ? new Date(String(upsertData.updated_at)).getTime() : NaN;
      const current = existingConv.updated_at ? new Date(String(existingConv.updated_at)).getTime() : NaN;
      if (Number.isNaN(incoming) || (!Number.isNaN(current) && incoming <= current)) {
        delete upsertData.updated_at;
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
      // 既存行（同じ LINE ユーザー×アカウント）への UPDATE でも、状態は審査管理の状態が変わった時に先の段階へ進める時だけ書く
      let fallbackChange: { convId: string; from: string | null; to: string } | null = null;
      {
        let curQuery = supabase.from("conversations").select("id, status, is_post_apply, screening_last_status, status_manual_back_at").eq("line_user_id", upsertData.line_user_id as string);
        if (resolvedAccount) curQuery = curQuery.eq("account", resolvedAccount);
        const { data: curRow } = await curQuery.limit(1).maybeSingle();
        const incoming = (record.status as string | null) ?? null;
        const r = curRow
          ? resolveScreeningSync(curRow.status as string | null, incoming, (curRow as { screening_last_status?: string | null }).screening_last_status ?? null,
              { isPostApply: !!curRow.is_post_apply, manualBack: !!(curRow as { status_manual_back_at?: string | null }).status_manual_back_at })
          : { status: incoming, lastSeen: incoming };
        if (r.status === null) delete updateFields.status;
        else updateFields.status = r.status;
        updateFields.screening_last_status = r.lastSeen;
        // 既存行の最後のメッセージ・最後の発言者は上書きしない（上の upsert と同じ理由）
        if (curRow) { delete updateFields.last_message; delete updateFields.last_sender; }
        if (curRow && r.status !== null && r.status !== curRow.status) fallbackChange = { convId: String(curRow.id), from: (curRow.status as string | null) ?? null, to: r.status };
      }
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
      await recordSyncStatusChange(fallbackChange);
      return NextResponse.json({ ok: true, synced: "conversation", id: record.id, account: resolvedAccount, deduped: true });
    }

    if (error) {
      console.error("sync conversations error:", error.code, error.message, error.details, error.hint);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    await recordSyncStatusChange(statusChange);
    return NextResponse.json({ ok: true, synced: "conversation", id: record.id, account: resolvedAccount });
  }

  if (table === "messages") {
    if (record.sender === "staff") {
      // P1(診断修正): 旧実装はここで破棄（ignored_staff_message）していたため、
      // conversations.last_sender="staff" に上書きされるのに messages にはスタッフ返信が残らず、
      // 「トーク画面では未返信に見えるのに全AIゲートが沈黙する」不整合の根本原因になっていた。
      // screening-admin 側スタッフ返信も messages に保存して可視化する（コードは触らずDB同期のみ）。
      const staffText = String(record.text ?? "");
      const staffLmid =
        (record.line_message_id as string) ||
        (record.lineMessageId as string) ||
        (record.message_id as string) ||
        null;

      // line_message_id なし = LINEに送信されていないscreening-adminのAI自動生成文 → 表示しない
      if (!staffLmid) {
        return NextResponse.json({ ok: true, action: "staff_message_skipped_no_line_message_id" });
      }

      // 重複ガード1: line_message_id が既に保存済みならスキップ
      if (staffLmid) {
        const { data: dupByLmid } = await supabase
          .from("messages")
          .select("id")
          .eq("line_message_id", staffLmid)
          .limit(1)
          .maybeSingle();
        if (dupByLmid) {
          return NextResponse.json({ ok: true, action: "staff_message_already_synced", via: "line_message_id" });
        }
      }

      // 重複ガード2: 同一会話・同一本文・±2分以内の staff メッセージがあればスキップ
      // （sumora-ai-ui から送信したメッセージが screening-admin 経由でエコーバックした場合の二重表示防止）
      if (staffText && record.created_at) {
        const baseTime = new Date(String(record.created_at)).getTime();
        if (!Number.isNaN(baseTime)) {
          const from = new Date(baseTime - 2 * 60 * 1000).toISOString();
          const to = new Date(baseTime + 2 * 60 * 1000).toISOString();
          const { data: dupByText } = await supabase
            .from("messages")
            .select("id")
            .eq("conversation_id", String(record.conversation_id))
            .eq("sender", "staff")
            .eq("text", staffText)
            .gte("created_at", from)
            .lte("created_at", to)
            .limit(1);
          if (dupByText && dupByText.length > 0) {
            return NextResponse.json({ ok: true, action: "staff_message_already_synced", via: "text_window" });
          }
        }
      }

      const { error: staffErr } = await supabase
        .from("messages")
        .upsert(
          {
            id: record.id,
            conversation_id: record.conversation_id,
            sender: "staff",
            text: staffText,
            image_url: (record.image_url as string) ?? null,
            ...(staffLmid ? { line_message_id: staffLmid } : {}),
            created_at: record.created_at,
          },
          { onConflict: "id" }
        );
      if (staffErr) {
        if (staffErr.code === "23505") {
          // UNIQUE制約違反 = 既に保存済み。正常扱い
          console.log("[sync] staffメッセージ重複を検知・スキップ:", staffErr.message);
        } else {
          console.error("sync staff message error:", staffErr.code, staffErr.message);
          return NextResponse.json({ error: staffErr.message }, { status: 500 });
        }
      } else {
        // 2026-09-15: 審査管理から実際に送った発言（line_message_id あり）が会話の最新なら、最後の発言者・最後のメッセージをこの発言にする
        //   （旧: 会話の同期が審査管理の last_message / last_sender で上書きしていた＝送っていない AI 文でも上書きされた）。
        //   こちらの送信と同じく、下書きとブレインの判断は消す（送信後に古い AIX が残らないように・page.tsx の送信と同じ）
        await markStaffMessageAsLatest(String(record.conversation_id), String(record.id), staffText, String(record.created_at ?? ""));
      }
      return NextResponse.json({ ok: true, synced: "staff_message", id: record.id });
    }

    let imageUrl: string | null = (record.image_url as string) ?? null;

    // 画像メッセージ検出: より広い条件で判定
    const msgText = String(record.text ?? "");
    const msgType = String(record.message_type ?? record.type ?? "");
    // 2026-09-17 竹内（友哉事例）: ファイル（PDF 等）を画像として扱わない。
    //   旧: 本文が空の顧客メッセージは無条件で画像とみなしていたので、file レコードが来ると
    //   PDF を line-images（画像だけ許可のバケット）に上げようとして必ず失敗していた。
    //   LINE の file は line-webhook が受け持つ（handleFileMessageSave）
    const isFileMsg = msgType === "file" || msgText.startsWith("[ファイル]");
    const isImageMsg = !imageUrl && record.sender === "customer" && !isFileMsg && (
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
