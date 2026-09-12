import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { isGenerationFailureText } from "@/app/lib/example-hygiene";
import { classifyStaffTextForLedger } from "@/app/lib/action-ledger";
import { runBrainAndNotify } from "@/app/lib/brain-core";

// 宣言直後のブレイン再分析（after 内で最大 ~20秒待ち＋分析）に余裕を持たせる
export const maxDuration = 120;

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
  const authError = requireInternalAuth(req);
  if (authError) return authError;

  const { line_user_id, message, image_url, account } = await req.json() as {
    line_user_id?: string;
    message?: string;
    image_url?: string;
    account?: string;
  };

  if (!line_user_id || (!message && !image_url)) {
    return NextResponse.json({ ok: false, error: "line_user_id and message or image_url required" }, { status: 400 });
  }
  // 2026-09-11 データ衛生（統合設計 §7）: 生成失敗文（「AI返信の生成に失敗しました…」）はお客様に送らない
  //   （9/11 に手動送信で実際に LINE 配信された。スタッフが下書き欄の失敗文をそのまま送信した経路を止める）
  if (message && isGenerationFailureText(message)) {
    return NextResponse.json({ ok: false, error: "generation_failure_text", message: "AI返信の生成に失敗した文は送信できません。再生成するか本文を入力してください" }, { status: 400 });
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
    // LINE APIハング時に関数がタイムアウト上限まで滞留するのを防ぐ
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`LINE push error [${accountKey}] status=${res.status}:`, text);

    // LINE APIエラーを種別判定し、ユーザー向けの日本語メッセージ + errorCode を返す
    // （生JSONをそのままUIに露出させない。フロントはerrorCodeで再試行可否を判断する）
    let errorCode: "monthly_limit" | "invalid_token" | "unknown" = "unknown";
    let friendlyError: string;
    if (res.status === 429 || text.includes("monthly limit")) {
      errorCode = "monthly_limit";
      friendlyError = "今月のLINE送信上限（200通）に達しました。プランをアップグレードするか、翌月になるまでお待ちください。";
    } else if (res.status === 401 || text.toLowerCase().includes("access token")) {
      errorCode = "invalid_token";
      friendlyError = "LINE APIトークンが無効です。管理者に連絡してください。";
    } else {
      // LINE APIレスポンス（JSON）から message だけを抽出して表示する
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        // JSONでなければ生テキストのまま
      }
      friendlyError = `LINE送信に失敗しました: ${detail}`;
    }
    return NextResponse.json(
      { ok: false, error: friendlyError, errorCode, lineStatus: res.status },
      { status: 500 }
    );
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
    // 「ご査収ください」はAIX物件ピックアップしたの完了文に含まれる→実際の送信であり予告ではないので除外
    const isActualSend = message.includes("ご査収ください");

    // 実際に物件を送った → pending の property_send タスクをサーバー側でも自動完了（安全網）
    if (isActualSend) {
      after(async () => {
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
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.INTERNAL_API_SECRET ?? ""}`,
              },
              body: JSON.stringify({ id: pendingTask.id }),
            }).catch(() => {});
          }
        } catch {}
      });
    }

    // 2026-09-12 竹内（あや事例）: 「お部屋お送り頂きますと…御見積させて頂きます」（お客様が送る側）・「お部屋お送りいただきありがとうございます」
    //   でも「お部屋お送り」のキーワードに当たり物件ピックアップのやることが作られていた。キーワード検知を別判断にせず、
    //   ブレインの約束の判定（行動台帳 classifyStaffTextForLedger の pickup_declared）と同じ判定で作る（旧 STAFF_SEND_KEYWORDS は削除）
    //   「新着が出次第お送り」の条件付きの約束は、いつ届けるか決まっていないのでやることを作らない（ブレインの約束→AIX と同じ扱い）
    const sendEntry = classifyStaffTextForLedger(message, null);
    const triggered = !isActualSend && sendEntry?.kind === "pickup_declared"
      && !/(?:新着|募集|出|見つかり)(?:が)?(?:出)?次第/.test(sendEntry.evidence ?? "");
    if (triggered) {
      after(async () => {
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

            // H2: タスク起因のステータス昇格を stage_history に記録
            if (earlyStatuses.includes(currentStatus)) {
              await supabase.from("conversation_stage_history").insert({
                conversation_id: convRow.id as string,
                from_status: currentStatus || null,
                to_status: "proposing",
                trigger: "staff_reply",
              });
            }

            // 旧「🏠【物件出し開始】〇〇さんへの物件ピックアップを開始しました」は 2026-09-12 に廃止。
            //   同じ送信でブレインが宣言→AIX【物件ピックアップした】を判断し、AIX要対応（〇〇さん → AIX【物件ピックアップした】）として
            //   売上番長グループへ届くため（二重通知になる）。条件付き（出次第）の宣言は AIX要対応にならない
            void customerName;
          }
        } catch {}
      });
    }
  }

  // 2026-09-12 竹内「見積書送る宣言したら AIX 見積書送る をセット。LINE グループにアナウンスするまでがセット」:
  //   スタッフが見積書・物件ピックアップを宣言した送信の直後にブレインを分析し直す（顧客の新着が無くても forceIncremental）。
  //   ブレインが「未履行の宣言 → それを履行する AIX」（aix-task-link.resolveStaffPromiseAix）と判断 → AIX要対応に登録・
  //   売上番長グループへ「〇〇さん → AIX【見積書送る】」。宣言の判定は行動台帳と同じ classifyStaffTextForLedger
  if (message) {
    const promiseEntry = classifyStaffTextForLedger(message, null);
    // 2026-09-12 竹内（Sさん事例）: 募集状況等の確認の宣言（「お送り頂きました物件、募集状況確認させて頂きます」）も対象
    //   → ブレインが AIX【物件確認した】をセット（お客様から確認の依頼があった時だけ・aix-task-link.resolveStaffPromiseAix）
    if (promiseEntry?.status === "promised" && (promiseEntry.kind === "estimate_declared" || promiseEntry.kind === "pickup_declared" || promiseEntry.kind === "confirmation_promised")) {
      const sentAtIso = new Date(Date.now() - 60_000).toISOString();
      after(async () => {
        try {
          const { data: convRow } = await supabase
            .from("conversations").select("id")
            .eq("line_user_id", line_user_id).eq("account", accountKey).maybeSingle();
          if (!convRow?.id) return;
          const cid = convRow.id as string;
          // 画面（page.tsx）がこの送信を messages に保存するのを待つ（ブレインが宣言を読めるように・最大15秒）
          for (let i = 0; i < 8; i++) {
            const { data: saved } = await supabase
              .from("messages").select("id")
              .eq("conversation_id", cid).eq("sender", "staff").gte("created_at", sentAtIso)
              .limit(1);
            if (saved && saved.length > 0) break;
            await new Promise((r) => setTimeout(r, 2000));
          }
          await new Promise((r) => setTimeout(r, 2000)); // 会話行の更新（updated_at）が落ち着いてから分析（ウォーターマーク競合を避ける）
          await runBrainAndNotify(cid, undefined, { forceIncremental: true });
        } catch (e) {
          console.warn("[send-line-message] brain after staff promise failed:", e instanceof Error ? e.message : e);
        }
      });
    }
  }

  // Fire-and-forget: 返信後の顧客反応を計測開始（reply_engagement_signals）
  // 時間閾値なし — 顧客の次の返信が来た時点で line-webhook 側が resolve する
  after(async () => {
    try {
      const { data: convRow } = await supabase
        .from("conversations")
        .select("id")
        .eq("line_user_id", line_user_id)
        .eq("account", accountKey)
        .maybeSingle();
      if (!convRow?.id) return;
      await supabase.from("reply_engagement_signals").insert({
        conversation_id: convRow.id as string,
        staff_sent_at: new Date().toISOString(),
        signal_type: "pending",
      });
    } catch {
      // 計測失敗は送信成功に影響させない
    }
  });

  return NextResponse.json({ ok: true, account: accountKey, sentMessageIds });
}
