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

  // P4: LINE push レスポンスの sentMessages から message id を取得
  // （aix_usage_logs.line_message_id に記録し、AIX送信メッセージの厳密特定に使う）
  let sentMessageIds: string[] = [];
  try {
    const lineJson = await res.json() as { sentMessages?: Array<{ id?: string }> };
    sentMessageIds = (lineJson.sentMessages ?? [])
      .map((m) => m.id)
      .filter((x): x is string => Boolean(x));
  } catch {
    // レスポンスがJSONでなくても送信自体は成功しているので続行
  }

  // スタッフ送信メッセージに「物件ピックアップ・お送り」フレーズ → 物件出しタスク自動作成 + ステータス変更
  if (message) {
    const STAFF_SEND_KEYWORDS = [
      "物件ピックアップ", "お部屋ピックアップ", "ピックアップさせて頂", "ピックアップ出来次第",
      "物件をお送り", "物件お送り", "お部屋をお送り", "お部屋お送り",
      "物件を送らせていただ", "物件を送ります", "物件送ります",
      "物件をピックアップ", "ピックアップします",
    ];
    // 「ご査収ください」はAIX物件送るの完了文に含まれる→実際の送信であり予告ではないので除外
    const isActualSend = message.includes("ご査収ください");

    // 実際に物件を送った → pending の property_send タスクをサーバー側でも自動完了（安全網）
    if (isActualSend) {
      void (async () => {
        try {
          const { data: convRow } = await supabase
            .from("conversations")
            .select("id")
            .eq("line_user_id", line_user_id)
            .eq("account", accountKey)
            .maybeSingle();
          if (!convRow?.id) return;
          const { data: pendingTask } = await supabase
            .from("line_tasks")
            .select("id")
            .eq("conversation_id", convRow.id as string)
            .eq("task_type", "property_send")
            .eq("status", "pending")
            .maybeSingle();
          if (pendingTask?.id) {
            const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "https://sumora-ai-ui.vercel.app";
            fetch(`${baseUrl}/api/line-tasks/complete`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: pendingTask.id }),
            }).catch(() => {});
          }
        } catch {}
      })();
    }

    const triggered = !isActualSend && STAFF_SEND_KEYWORDS.some((k) => message.includes(k));
    if (triggered) {
      void (async () => {
        try {
          const { data: convRow } = await supabase
            .from("conversations")
            .select("id, customer_name, status")
            .eq("line_user_id", line_user_id)
            .eq("account", accountKey)
            .maybeSingle();
          if (!convRow?.id) return;

          const { data: existing } = await supabase
            .from("line_tasks")
            .select("id")
            .eq("conversation_id", convRow.id as string)
            .eq("task_type", "property_send")
            .eq("status", "pending")
            .maybeSingle();

          // タスク未作成の場合のみ: タスク作成 + ステータス昇格 + 要対応 + 通知
          if (!existing?.id) {
            const currentStatus = (convRow.status as string) ?? "";
            const earlyStatuses = ["hearing", "first_reply", "condition_hearing", "availability_check"];
            const customerName = (convRow.customer_name as string) ?? "お客様";

            await Promise.all([
              supabase.from("line_tasks").insert({
                conversation_id: convRow.id as string,
                task_type: "property_send",
                customer_name: customerName,
                status: "pending",
              }),
              // ヒアリング段階なら物件提案中に昇格、それ以外でも is_flagged=true
              earlyStatuses.includes(currentStatus)
                ? supabase.from("conversations")
                    .update({ status: "proposing", is_flagged: true })
                    .eq("id", convRow.id as string)
                : supabase.from("conversations")
                    .update({ is_flagged: true })
                    .eq("id", convRow.id as string),
            ]);

            // 売上番長グループへアナウンス
            let groupId: string | null = null;
            const envId = process.env.LINE_STAFF_GROUP_ID;
            if (envId) {
              groupId = envId;
            } else {
              const { data: grpRow } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").single();
              groupId = grpRow?.value ?? null;
            }
            const groupToken = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
            if (groupId && groupToken) {
              await fetch("https://api.line.me/v2/bot/message/push", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${groupToken}` },
                body: JSON.stringify({
                  to: groupId,
                  messages: [{ type: "text", text: `🏠【物件出し開始】\n${customerName}さんへの物件ピックアップを開始しました` }],
                }),
              }).catch(() => {});
            }
          }
        } catch {}
      })();
    }
  }

  return NextResponse.json({ ok: true, account: accountKey, sentMessageIds });
}
