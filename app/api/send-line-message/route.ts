import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { isGenerationFailureText } from "@/app/lib/example-hygiene";
import { classifyStaffTextFacts } from "@/app/lib/action-ledger";
import { runBrainAndNotify } from "@/app/lib/brain-core";
import { buildCallRequestFlex, callUrlSettingKey, isValidLineCallUrl } from "@/app/lib/phone-call";

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

  const { line_user_id, message, image_url, account, conversation_id, origin, call_button } = await req.json() as {
    line_user_id?: string;
    message?: string;
    image_url?: string;
    account?: string;
    /** 送信時の記録（sent_facts）用。画面の手打ち送信が渡す（無い呼び出しは記録しない＝台帳は本文の読み直しで補う） */
    conversation_id?: string;
    /** "manual"＝手打ち（AI 下書きを含む）。"aix"＝AIX の本文（記録は log-aix-usage が AIX の種類・画面入力で書く） */
    origin?: "manual" | "aix";
    /** 2026-09-15 AIX【電話をかける】: LINEコールの「電話をかける」ボタンのカードを送る（行き先はアカウントごとの通話URL・aix_settings） */
    call_button?: boolean;
  };

  if (!line_user_id || (!message && !image_url && !call_button)) {
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
  // 「電話をかける」ボタン（通話リクエストと同じ見た目のカード）を先に送る。通話URL が未登録なら送らずに知らせる
  if (call_button) {
    const { data: urlRow } = await supabase.from("aix_settings").select("value").eq("key", callUrlSettingKey(accountKey)).maybeSingle();
    const callUrl = (urlRow?.value as string | undefined) ?? "";
    if (!isValidLineCallUrl(callUrl)) {
      return NextResponse.json({ ok: false, errorCode: "call_url_not_set", error: `${accountKey} の LINEコールの通話URLが未登録です。AIX【電話をかける】の画面で通話URLを登録してください` }, { status: 400 });
    }
    messages.push(buildCallRequestFlex(callUrl));
  }
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

  // 2026-09-14 竹内「自分が送った内容を記憶して次の解析に引き継ぐ」: 手打ちの送信は送った時に1回だけ分類して記録する（sent_facts）。
  //   行動台帳はこの記録を本文の読み直しより優先し、メッセージの取得範囲より古い送信も忘れない。待ち合わせの案内なら内覧の記録も書く
  const sentAtIsoForFacts = new Date().toISOString();
  if (message && conversation_id && origin !== "aix") {
    after(async () => {
      try {
        const { recordStaffTextFacts } = await import("@/app/lib/sent-facts");
        await recordStaffTextFacts({ conversationId: conversation_id, text: message, sentAt: sentAtIsoForFacts, lineMessageId: sentMessageIds[0] ?? null });
      } catch (e) {
        console.warn("[send-line-message] sent_facts record failed:", e instanceof Error ? e.message : e);
      }
    });
  }

  // ── 2026-09-20 竹内「お客さん毎に送った物件のテーブル作ってそこから読み取れるようにすれば良いのでは。
  //   その画像の読み込みに限定して deepseek V4.1 Flash のモデルを使う」──────────────────
  //   スタッフが手で送った画像は今まで1枚も物件に直せていなかった（直近30日 1,624枚中 24枚＝1%）。
  //   ブレインは sent_properties / sent_image_properties からしか物件を知らないので、
  //   画像だけで物件を送ると**ブレインが物件を1件も知らないまま文を書く**（文のすれ違いの元）。
  //   → 送信が終わった後（after）に画像を読み、**既知の物件名と照合できた物だけ**記録する。
  //     送信そのものは待たせない。失敗しても送信には影響しない。
  //   実測（スタッフの実画像10枚）: 10/10 読めて 10/10 照合を通過・月$2.02。
  //     誤読も照合で直った（「スプレンディッド堀江」→ スプランディッド堀江）
  if (image_url && conversation_id) {
    after(async () => {
      try {
        const [{ readPropertyImage }, { resolveReadProperty }, { extractPropertyLabels }] = await Promise.all([
          import("@/app/lib/property-image-read"),
          import("@/app/lib/property-name-match"),
          import("@/app/lib/action-ledger"),
        ]);
        const read = await readPropertyImage(image_url);
        if (read.items.length === 0) return;

        // その会話で既に分かっている物件名（照合の辞書）。無ければ記録しない＝誤読を入れない
        const known = new Set<string>();
        const { data: sp } = await supabase.from("sent_properties").select("property_name")
          .eq("conversation_id", conversation_id).limit(50);
        for (const r of (sp ?? []) as Array<{ property_name: string | null }>) if (r.property_name) known.add(r.property_name.trim());
        const { data: ms } = await supabase.from("messages").select("text")
          .eq("conversation_id", conversation_id).order("created_at", { ascending: false }).limit(80);
        const joined = ((ms ?? []) as Array<{ text: string | null }>).map((m) => m.text ?? "").join("\n");
        for (const lbl of extractPropertyLabels(joined)) known.add(lbl.replace(/\s*[0-9０-９]{1,4}号室\s*$/, "").trim());
        const dict = [...known].filter((s) => s.length >= 2);
        if (dict.length === 0) return;

        const fixed = read.items
          .map((x) => resolveReadProperty(x, dict))
          .filter((x): x is NonNullable<typeof x> => !!x);
        if (fixed.length === 0) return;

        // 画像1枚 → 物件1つ（image_url が主キー）。一覧の画像は最初の1件を代表にする
        const top = fixed[0];
        const { error } = await supabase.from("sent_image_properties").upsert(
          { image_url, conversation_id, property_name: top.propertyName, room_no: top.roomNumber, source: "staff_image_vision" },
          { onConflict: "image_url" },
        );
        console.log(JSON.stringify({
          tag: "send-line-message:image-property", conversationId: conversation_id,
          read: read.items.length, matched: fixed.length, saved: top.propertyName + (top.roomNumber ? ` ${top.roomNumber}` : ""),
          tokens: read.usage, error: error?.message ?? null,
        }));
      } catch (e) {
        console.warn("[send-line-message] 画像の物件読み取り失敗:", e instanceof Error ? e.message : e);
      }
    });
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
    // 2026-09-14: 1通に複数の行為があっても拾う（「御見積書を作成しお送り＋お部屋ピックアップさせて頂きます」のピックアップの約束・ゆうこ事例）
    const sendEntry = classifyStaffTextFacts(message, null).find((e) => e.kind === "pickup_declared") ?? null;
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
    const promiseEntry = classifyStaffTextFacts(message, null).find((e) => e.status === "promised" && (e.kind === "estimate_declared" || e.kind === "pickup_declared" || e.kind === "confirmation_promised")) ?? null;
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
