import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { isApplicationFormMessage, hasApplyHintKeyword, PRE_APPLY_STATUSES } from "@/app/lib/application-form-detect";
import { classifyByKeywords, classifyByAI, type ConditionIntent } from "@/app/lib/condition-intent";
import { mergeConditions, type ConditionFields } from "@/app/lib/condition-merge";
import { isPropertySiteUrl } from "@/app/api/parse-condition-url/route";
import { runBrainAndNotify } from "@/app/lib/brain-core";

// Vercel Functions のタイムアウト上限（秒）— after()内のAnthropicコール（30s）と画像処理に余裕を持たせる
export const maxDuration = 120;

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

// ── P1: AIXアクション日本語ラベルは brain-core.ts の AIX_LABEL_JP へ移設（2026-08 brain直列化）──
// required通知本体も runBrainAndNotify（brain-core）に移設済み

// ── bg-async / after() B と同期させる draft 生成スキップステータス集合 ─────────
// bg-async が draft 生成ごと早期スキップするステータス（= bg-async 内の brain 直列実行も
// 走らないステータス）。このリストを変える場合は after() B の早期return・
// generate-draft-bg-async の SKIP_STATUSES・cron 側も必ず同時に更新すること。
const BG_ASYNC_SKIP_STATUSES = ["applying", "application", "screening", "contract", "closed_won", "closed_lost", "approved", "lost"];

// ── 同一ユーザーのレート制限（3秒以内の連続AI解析をスキップ）─────────────
// 注意: このMapはインスタンス内のみ有効（Vercelサーバーレスでは複数インスタンスが
// 並行動作するためベストエフォート）。クロスインスタンスの実質的な保護は
// DBベースの2層で担保している:
//   1. handleTextMessage の line_message_id 重複チェック（LINEリトライを遮断）
//   2. autoParseFormat 冒頭の raw_format_text 重複チェック（同一テキスト再解析を遮断）
const recentLineUsers = new Map<string, number>(); // userId → lastProcessedMs
const RATE_LIMIT_WINDOW_MS = 3000;

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const lastTime = recentLineUsers.get(userId);
  if (lastTime && now - lastTime < RATE_LIMIT_WINDOW_MS) {
    return true;
  }
  recentLineUsers.set(userId, now);

  // Map肥大化防止（最も古いエントリから削除）
  if (recentLineUsers.size > 1000) {
    const oldestKey = recentLineUsers.keys().next().value;
    if (oldestKey !== undefined) recentLineUsers.delete(oldestKey);
  }
  return false;
}

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
      signal: AbortSignal.timeout(5_000),
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
    .eq("account", account.key)
    .limit(1);

  if (convRows && convRows.length > 0) {
    return convRows[0].id as string;
  }

  const { data: created, error: createErr } = await db
    .from("conversations")
    .insert({
      id: crypto.randomUUID(),
      line_user_id: userId,
      customer_name: "名称未設定",
      account: account.key,
      status: "hearing",
      updated_at: now,
    })
    .select("id")
    .maybeSingle();
  if (createErr || !created) {
    // 同時にsync-from-screeningが作成した場合がある → 再検索
    const { data: retry } = await db
      .from("conversations")
      .select("id")
      .eq("line_user_id", userId)
      .eq("account", account.key)
      .limit(1);
    if (retry && retry.length > 0) return retry[0].id as string;
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
  lineMessageId?: string,
  quotedMessageId?: string,
): Promise<boolean> {
  const db = getDb();
  const now = new Date().toISOString();

  const convId = await ensureConversation(db, userId, account, now);
  if (!convId) return false;

  // line_message_id重複チェック（sync-from-screeningとの二重保存防止）
  if (lineMessageId) {
    const { data: existingMsg } = await db
      .from("messages")
      .select("id")
      .eq("line_message_id", lineMessageId)
      .maybeSingle();
    if (existingMsg) {
      return true; // 既に保存済み = 正常
    }
  }

  const { error: msgErr } = await db.from("messages").insert({
    conversation_id: convId,
    sender: "customer",
    text,
    ...(lineMessageId ? { line_message_id: lineMessageId } : {}),
    // LINEリプライ（引用）: 引用元メッセージID（物件カードへの引用→物件興味判定に使う）
    quoted_message_id: quotedMessageId ?? null,
    created_at: now,
  });
  if (msgErr) {
    if (msgErr.code === "23505") {
      // UNIQUE制約違反 = sync-from-screeningが同時に保存済み。正常扱い
    } else {
      console.error("[line-webhook] message保存失敗:", msgErr.message);
      return false;
    }
  }

  await db
    .from("conversations")
    .update({ last_message: text, last_sender: "customer", updated_at: now, is_flagged: true, suggested_aix_meta: null })
    .eq("id", convId);

  // FIX(Fable5 #2 → brain直列化 2026-08): テキスト経路の脳分析は generate-draft-bg-async の
  // after() 入り口で直列実行される（brain完了 → 結果を brainMetaDirect で generate-reply に直接渡す）
  // ため、通常ステータスではここで起動しない（起動すると brain が二重実行され、書き込み競合が復活する）。
  // ただし bg-async は申込以降ステータスで draft 生成ごと早期スキップするため、その経路では
  // brain 再分析＋required通知が消滅してしまう。BG_ASYNC_SKIP_STATUSES に該当する会話のみ
  // 従来どおり webhook 側で brain を実行する（required通知も runBrainAndNotify 内で送信される）。
  // ※ brain-core 側の BRAIN_SKIP_STATUSES（contract/closed_won/closed_lost/lost/approved）は
  //   analyzeAndSaveBrainMeta 内で従来どおり適用されるため、実質 applying/application/screening のみ走る
  after(async () => {
    try {
      const { data: convRow } = await db
        .from("conversations")
        .select("status")
        .eq("id", convId)
        .maybeSingle();
      const convStatus = (convRow?.status as string) || "hearing";
      if (!BG_ASYNC_SKIP_STATUSES.includes(convStatus)) return; // bg-async側のbrain直列実行に任せる
      await runBrainAndNotify(convId);
    } catch (e) {
      console.warn("[line-webhook] brain-notify:", e);
    }
  });

  updateProfileAsync(db, userId, convId, account, text, now);

  // 返信きたお客さんを自動で毎日物件出し（hot）に格上げ
  after(async () => {
    await autoUpgradeToHot(db, userId).catch((e) => console.warn("[line-webhook] autoUpgradeToHot:", e));
  });

  // 最優先（is_flagged）客からの返信 → @鈴木メンション即時通知
  after(async () => {
    await notifySuzukiReply(db, convId, text).catch((e) => console.warn("[notifySuzukiReply]", e));
  });

  // 顧客返信 → pending中のエンゲージメントシグナルを resolve（fire-and-forget）
  // 成約パターンキーワード検出で positive / それ以外は neutral（時間閾値なし）
  after(async () => {
    await resolveEngagementSignal(db, convId, text).catch((e) => console.warn("[resolveEngagementSignal]", e));
  });

  // 新規客（初メッセージ）検知 → @鈴木即時通知
  after(async () => {
    const { count: msgCount } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", convId)
      .eq("sender", "customer");
    if ((msgCount ?? 0) === 1) {
      const { data: convInfo } = await db
        .from("conversations")
        .select("customer_name")
        .eq("id", convId)
        .maybeSingle();
      await notifyNewCustomer(db, convId, (convInfo?.customer_name as string) || "")
        .catch(e => console.warn("[notifyNewCustomer]", e));
    }
  });

  // ── 申込フォーム自動検知 → ステータスを申込・審査中(applying)に自動昇格 ──
  // これまでUI上の手動バナーしか経路がなく、会話を開いていないと遷移漏れしていた。
  // isFormatMessage より先に判定する（記入済みフォームの①②番号で希望条件と誤解析されるのを防ぐ）。
  let applyFormDetected = false;
  try {
    const applyForm = isApplicationFormMessage(text);
    applyFormDetected = applyForm.detected;
    let detectSource: string = applyForm.formType ?? "";

    // 分割送信フォールバック: 単発では閾値未満でもヒント語があれば直近8件の顧客メッセージを結合して再判定
    if (!applyFormDetected && hasApplyHintKeyword(text)) {
      const { data: recentMsgs } = await db
        .from("messages")
        .select("text")
        .eq("conversation_id", convId)
        .eq("sender", "customer")
        .order("created_at", { ascending: false })
        .limit(8);
      const joined = (recentMsgs ?? []).map((m) => (m.text as string) ?? "").reverse().join("\n");
      const joinedResult = isApplicationFormMessage(joined);
      applyFormDetected = joinedResult.detected;
      if (joinedResult.detected) detectSource = `${joinedResult.formType}(joined)`;
    }

    if (applyFormDetected) {
      // .in(PRE_APPLY_STATUSES)ガードで冪等（既にapplying以降なら何もしない）＋成約/失注からのダウングレード防止
      // P2: 更新前に現ステータスを取得（conversation_stage_history 記録用）
      const { data: convPreApply } = await db.from("conversations").select("status").eq("id", convId).maybeSingle();
      const applyFromStatus = convPreApply?.status as string | null;
      const { data: updated, error: applyErr } = await db
        .from("conversations")
        .update({ status: "applying", updated_at: now })
        .eq("id", convId)
        .in("status", PRE_APPLY_STATUSES)
        .select("id");
      if (applyErr) {
        console.error(`[line-webhook] applying自動昇格失敗: conv=${convId}`, applyErr.message);
      } else if ((updated ?? []).length > 0) {
        console.log(`[line-webhook] 申込フォーム検知 → applying自動昇格: conv=${convId} type=${detectSource}`);
        // P2: ステータス変遷を記録
        void (async () => {
          const { error: stageErr } = await db.from("conversation_stage_history").insert({
            conversation_id: convId,
            from_status: applyFromStatus,
            to_status: "applying",
            trigger: "customer_message",
          });
          if (stageErr) console.warn("[stage_history] apply-form:", stageErr.message);
        })();
      } else {
        console.log(`[line-webhook] 申込フォーム検知（ステータス変更なし・既にapplying以降）: conv=${convId}`);
      }
    }
  } catch (e) {
    console.error("[line-webhook] 申込フォーム検知エラー:", e);
  }

  // LINEフォーマット自動検知・解析 → ステータスを物件提案中に自動昇格
  // ※申込フォームと判定済みのメッセージは希望条件として誤解析しない
  if (!applyFormDetected && isFormatMessage(text)) {
    // hearing/first_reply 状態なら proposing に自動昇格
    // P2: 更新前に現ステータスを取得（conversation_stage_history 記録用）
    const { data: convPreProp } = await db.from("conversations").select("status").eq("id", convId).maybeSingle();
    const proposeFromStatus = convPreProp?.status as string | null;
    const { data: proposeUpdated } = await db
      .from("conversations")
      .update({ status: "proposing" })
      .eq("id", convId)
      .in("status", ["hearing", "first_reply"])
      .select("id");
    // P2: ステータス変遷を記録（実際に変わった場合のみ）
    if ((proposeUpdated ?? []).length > 0) {
      void (async () => {
        const { error: stageErr } = await db.from("conversation_stage_history").insert({
          conversation_id: convId,
          from_status: proposeFromStatus,
          to_status: "proposing",
          trigger: "customer_message",
        });
        if (stageErr) console.warn("[stage_history] proposing:", stageErr.message);
      })();
    }
  }

  // タスク自動検知（物件確認・物件出し）
  void autoDetectTask(db, convId, text).catch((e) => console.warn("[line-webhook] autoDetectTask:", e));

  // 「確認しました」→ 物件確認済み自動マーク
  if (isPropertyViewedMessage(text)) {
    void autoMarkPropertyViewed(db, userId).catch((e) => console.warn("[line-webhook] autoMarkPropertyViewed:", e));
  }

  // after() A: フォーマット解析（独立実行 — draft_pending_at更新と並列・30s Anthropicコールを含む）
  // ※申込フォームは希望条件AI解析の対象外
  if (!applyFormDetected && isFormatMessage(text)) {
    after(async () => {
      try {
        await autoParseFormat(db, userId, text, account);
      } catch (e) { console.error("[autoParseFormat]", e); }
    });
  }

  // after() B: ai_summary更新 + draft_pending_at設定（autoParseFormatに依存しない）
  after(async () => {
    try {
      const { data: conv } = await db
        .from("conversations")
        .select("property_customer_id, status")
        .eq("id", convId)
        .maybeSingle();
      const pcId = conv?.property_customer_id as string | null;
      const convStatus = (conv?.status as string) || "hearing";

      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

      // 申込以降ステータスはai_summary・ai_draft生成不要（bg-async/cronのSKIP_STATUSESと一致させること）
      if (BG_ASYNC_SKIP_STATUSES.includes(convStatus)) return;

      // ai_summary 自動更新（fire-and-forget）- 申込以降は上でreturnしているため不要
      if (pcId) {
        await fetch(`${baseUrl}/api/customer-summary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customer_id: pcId, conversation_id: convId, fetch_from_db: true }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }

      // 60秒デバウンス維持（cron fallback / バースト時の統合生成として機能し続ける）
      await db.from("conversations")
        .update({ draft_pending_at: new Date().toISOString(), ai_draft: null })
        .eq("id", convId);

      // 直接トリガー: 60s debounce待ちを排除して即座にbg-asyncを起動
      // - bg-asyncは即200を返す（実処理は自身のafter()で行う）→ 3秒でほぼ確実に完了
      // - awaitにすることでVercelがafter()コールバック終了前にプロセスを終了させるリスクを排除
      // - draft_pending_at は維持されるため、失敗してもcronが60-120s後にfallbackとして拾う
      await fetch(`${baseUrl}/api/generate-draft-bg-async`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: convId }),
        signal: AbortSignal.timeout(3000),
      }).catch((e) => console.warn("[line-webhook] direct bg-async trigger failed:", e));
    } catch (e) {
      console.error("[line-webhook] after() draft_pending_at update failed:", e);
    }
  });

  // after() C: エリア指定検知 → resolve-area抽出 → desired_area更新 + LINE通知
  if (isAreaSpecificationMessage(text)) {
    after(async () => {
      await detectAndAnnounceAreaChange(db, convId, text)
        .catch((e) => console.warn("[detectAndAnnounceAreaChange]", e));
    });
  }

  // after() E: P4 — カジュアル返信から条件を自動抽出
  // isFormatMessage が false（autoParseFormat 非対象）かつ申込フォームでもない返信が対象
  // スタッフの直近メッセージに条件ヒアリングの文脈がある場合のみ Haiku で抽出・保存
  if (!applyFormDetected && !isFormatMessage(text) && text.length >= 5) {
    after(async () => {
      try {
        await extractConditionsFromCasualReply(db, convId, text);
      } catch (e) {
        console.warn("[line-webhook] extractConditionsFromCasualReply:", e);
      }
    });
  }

  // after() D: FIX #09 — suggest-next-action → notify-group（顧客別スタッフ指示を通知）
  // 返信受信後にAIが次アクションを提案し、スタッフグループLINEに送信する（fire-and-forget）

  return true;
}

async function autoUpgradeToHot(db: ReturnType<typeof getDb>, userId: string) {
  const { data } = await db
    .from("property_customers")
    .select("id, status, customer_name")
    .eq("line_user_id", userId)
    // proposing/hot ステータスのお客さんもis_hot=trueにする（再メッセージ対応）
    .in("status", ["new_inquiry", "property_search", "hot", "proposing"])
    .limit(1)
    .maybeSingle();
  if (data?.id) {
    const now = new Date().toISOString();
    const shouldUpgradePropStatus = data.status === "new_inquiry" || data.status === "property_search";
    const convUpdate = db.from("conversations")
      .update({ is_hot: true, updated_at: now })
      .eq("line_user_id", userId)
      .eq("is_hot", false);
    if (shouldUpgradePropStatus) {
      await Promise.all([
        convUpdate,
        db.from("property_customers")
          .update({ status: "hot", updated_at: now })
          .eq("id", data.id),
      ]);
    } else {
      await convUpdate;
    }
    // ステータス格上げ時のみ売上番長に通知（hot/proposing の再メッセージは通知しない）
    if (shouldUpgradePropStatus) {
      notifyHanbancyoGroup(db, data.customer_name ?? "").catch((e) => console.warn("[line-webhook] autoUpgradeToHot notify:", e));
    }
  }
}

// ── reply_engagement_signals: 顧客返信でシグナルを resolve ────────────────────
// スタッフ送信時（send-line-message）に作成された pending シグナルを、顧客の次の返信で確定する。
// 時間閾値なし（LINEは返信が遅いのが普通）— 返信あり=neutral、成約パターン語検出=positive。
const ENGAGEMENT_POSITIVE_PATTERNS = [
  /内覧|見に行|見学|行きた|見たい|行きます/,
  /申し込|申込|契約|決めた|決めます|お願いします/,
  /気に入|いいね|いい感じ|良さそう|良い感じ|いい物件/,
  /ぜひ|是非|よろしく|お願いし/,
  /いつ|日程|日時|何日|何時|空いて/,
];

async function resolveEngagementSignal(
  db: ReturnType<typeof getDb>,
  convId: string,
  customerText: string,
): Promise<void> {
  const { data: signal } = await db
    .from("reply_engagement_signals")
    .select("id, staff_sent_at")
    .eq("conversation_id", convId)
    .eq("signal_type", "pending")
    .order("staff_sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!signal) return;

  const minutes = Math.round((Date.now() - new Date(signal.staff_sent_at as string).getTime()) / 60000);
  // 成約パターン基準でポジティブ判定（時間制限なし）
  const isPositive = ENGAGEMENT_POSITIVE_PATTERNS.some((p) => p.test(customerText ?? ""));

  await db
    .from("reply_engagement_signals")
    .update({
      customer_replied_at: new Date().toISOString(),
      response_minutes: minutes,
      customer_reply_text: (customerText ?? "").slice(0, 200),
      signal_type: isPositive ? "positive" : "neutral",
      signal_reason: isPositive ? "成約パターンキーワード検出" : "返信あり",
    })
    .eq("id", signal.id as string);
}

function isFormatMessage(text: string): boolean {
  // 物件サイトURLのみのメッセージは条件フォーマットとして扱わない（SUUMOバグ防止）
  if (isPropertySiteUrl(text)) {
    const textOnly = text.replace(/https?:\/\/[^\s]+/g, "").trim();
    if (textOnly.length < 15) return false;
    return isFormatMessage(textOnly);
  }

  // 丸数字が2つ以上 → フォーマット確定
  if ((text.match(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]/g) ?? []).length >= 2) return true;

  const conditionKeywords = [
    "入居時期", "希望家賃", "家賃", "希望地域", "希望エリア", "間取り", "徒歩",
    "初期費用", "築年数", "エリア", "LDK", "DK", "1K", "2K", "3K", "1R",
    "万以内", "万円以内", "万円まで", "万に", "万円に", "以下", "以内", "㎡", "平米",
    "ペット可", "ペット不可", "駐車場", "独立洗面", "バストイレ別",
    "オートロック", "駅近", "築浅", "築", "NG", "希望条件", "こだわり",
    "区", "市", "駅",
  ];

  // 変更意図を示すフレーズ（EXCLUDE系・ADD系も含む）
  const changeKeywords = [
    "変えたい", "変更", "に変えて", "に変更", "にしたい", "にしてほしい",
    "やっぱり", "修正", "更新", "に変わ", "に移", "広げ", "せばめ",
    "上げ", "下げ", "にしようかな", "検討",
    // EXCLUDE系: 除外・NG化の意図
    "は無し", "はなし", "除外", "やめ", "外して", "抜い",
    // ADD系: 条件追加の意図
    "追加", "も見たい", "も含め", "も良い", "もOK", "も可", "もあり",
  ];

  const condMatches = conditionKeywords.filter((k) => text.includes(k)).length;
  const hasChange = changeKeywords.some((k) => text.includes(k));

  // 変更フレーズ + 条件キーワード1個以上 → 条件更新メッセージと判定
  if (hasChange && condMatches >= 1) return true;
  // 条件キーワード2個以上 → フォーマット送信
  // ただし「区・市・駅」等の汎用キーワードだけの雑談（例:「渋谷区の駅から近いですか？」）で
  // 不要なAI解析（Anthropic呼び出し）が走らないよう、強いキーワードか数字の存在を必須にする
  if (condMatches >= 2) {
    const GENERIC_KEYWORDS = ["区", "市", "駅", "築", "NG", "以下", "以内"];
    const hasStrong = conditionKeywords.some(
      (k) => !GENERIC_KEYWORDS.includes(k) && text.includes(k),
    );
    const hasDigit = /[0-9０-９一二三四五六七八九十]/.test(text);
    return hasStrong || hasDigit;
  }
  return false;
}

// エリア指定メッセージ検知（autoParseFormatのisFormatMessageより先に通過したもの専用）
// 保守的条件: 市区町村サフィックス付きトークンが2個以上、またはトリガーワードと1個以上の組み合わせ
function isAreaSpecificationMessage(text: string): boolean {
  if (isFormatMessage(text)) return false; // autoParseFormat handles this
  const matches = text.match(/[^\s]{1,6}[都道府県市区町村]/g) ?? [];
  const hasTrigger = /辺り|あたり|周辺|エリア|で探|希望/.test(text);
  return matches.length >= 2 || (matches.length >= 1 && hasTrigger);
}

// JST タイムスタンプ（新着要望のログに使用）
function getJSTTimestamp(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
}

// JST 年月日（自動反映マーク用: 【YYYY/MM/DD 自動反映】）
function getJSTDate(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

// 解析結果から人読みメモを生成（新着要望ログ用）
function buildConditionNote(parsed: Record<string, unknown>): string {
  const parts: string[] = [];
  if (parsed.desired_area)   parts.push(`エリア: ${parsed.desired_area}`);
  if (parsed.floor_plan)     parts.push(`間取り: ${parsed.floor_plan}`);
  if (parsed.floor_area_min) parts.push(`広さ: ${parsed.floor_area_min}㎡以上`);
  if (parsed.rent_min || parsed.rent_max) {
    const mn = parsed.rent_min ? `${Math.floor((parsed.rent_min as number) / 10000)}万〜` : "〜";
    const mx = parsed.rent_max ? `${Math.floor((parsed.rent_max as number) / 10000)}万` : "";
    parts.push(`家賃: ${mn}${mx}`);
  }
  if (parsed.walk_minutes)       parts.push(`徒歩: ${parsed.walk_minutes}分以内`);
  if (parsed.move_in_time)       parts.push(`入居: ${parsed.move_in_time}`);
  if (parsed.building_age)       parts.push(`築年: ${parsed.building_age}年以内`);
  if (parsed.initial_cost_limit) parts.push(`初期: ${Math.floor((parsed.initial_cost_limit as number) / 10000)}万以内`);
  if (parsed.preferences)        parts.push(`希望: ${parsed.preferences}`);
  if (parsed.ng_points)          parts.push(`NG: ${parsed.ng_points}`);
  if (parsed.other_requests)     parts.push(`その他: ${parsed.other_requests}`);
  return parts.join(" / ");
}

async function autoParseFormat(db: ReturnType<typeof getDb>, userId: string, text: string, account: AccountConfig) {
  // ── 重複実行防止: 同じテキストを既に処理済みなら即リターン ──────────
  const { data: alreadyDone } = await db
    .from("property_customers")
    .select("id")
    .eq("line_user_id", userId)
    .eq("raw_format_text", text)
    .maybeSingle();
  if (alreadyDone?.id) return;

  // ── レート制限: 同一ユーザーの3秒以内の連続送信はAI解析をスキップ ──
  if (isRateLimited(userId)) {
    return;
  }

  // ── AI でフォーマット解析 ──────────────────────────────────────────
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 30_000,
    maxRetries: 1,
  });
  // URLを除去してからClaudeに渡す（物件サイトURLパラメータの誤解釈防止）
  const cleanText = text.replace(/https?:\/\/[^\s]+/g, "[URL省略]").trim();
  let parsed: Record<string, unknown>;
  try {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `あなたは日本の不動産業者のアシスタントです。
以下のテキストから物件検索条件を読み取ってJSONで返してください。

【家賃の変換ルール（最重要）】
- 日本では 1万円 = 10,000円 です
- 「11万」「11万円」「11万以内」→ rent_max: 110000 （= 11 × 10,000）
- 「7万5千」「7.5万」→ rent_max: 75000
- 「8万〜10万」→ rent_min: 80000, rent_max: 100000
- 「60,000円」「6万円」→ rent_max: 60000
- 家賃は必ず円単位（30000〜300000程度）の整数で返す

【その他ルール】
- フォーマットが崩れていても最大限読み取る
- 「2ヶ月後くらい」のような曖昧な表現もそのまま文字列で入れる
- 「1DK・1LDK」のように複数ある場合はそのまま文字列で入れる
- 不明な項目は null にする（省略しない）

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
  "floor_area_min": 希望する部屋の広さの最低㎡数（数値か null。例:「30㎡以上」→ 30）,
  "preferences": "こだわり・希望条件（オートロック・ペット可・駐車場あり等。文字列またはnull）",
  "ng_points": "NG条件（1階NG・木造NG・角部屋希望等。文字列またはnull）",
  "other_requests": "その他要望・備考（文字列またはnull）"
}

テキスト:
${cleanText}

JSONのみ返してください。説明文・コードブロック・マークダウンは一切不要です。`,
      }],
    });
    const raw = res.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
    const match = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
    if (!match) return;
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return;
  }

  // ── 家賃バリデーション（AIの単位誤りを自動修正）──────────────────
  for (const f of ["rent_min", "rent_max", "initial_cost_limit"]) {
    const v = parsed[f];
    if (typeof v === "number" && v > 0) {
      if (v <= 300) {
        // 万円単位で返ってきた（例: 11 → 110000）
        parsed[f] = v * 10000;
      } else if (v > 500000 && f !== "initial_cost_limit") {
        // 10倍誤り（例: 1100000 → 110000）
        parsed[f] = v / 10;
      }
    }
  }

  // 正式フォーマット（丸数字2個以上）か、カジュアル更新（変更フレーズ+キーワード）かを判定
  const isFormalFormat = (text.match(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]/g) ?? []).length >= 2;

  // ── 保存フィールドを準備 ──────────────────────────────────────────
  // ベースフィールド（メタデータのみ。カジュアル更新でのマージ基準として使う）
  const baseFields: Record<string, unknown> = {
    format_received: true,
    raw_format_text: text,
    updated_at: new Date().toISOString(),
  };
  // 正式フォーマット用フィールド（全条件フィールド + additional_conditions リセット）
  // 新規顧客INSERT・売上番長通知にも使用する
  const parsedFields: Record<string, unknown> = { ...baseFields };
  for (const f of ["move_in_time", "rent_min", "rent_max", "desired_area", "walk_minutes", "floor_plan", "initial_cost_limit", "building_age", "floor_area_min", "preferences", "ng_points", "other_requests"]) {
    if (parsed[f] !== null && parsed[f] !== undefined) parsedFields[f] = parsed[f];
  }
  // 正式フォーマット受信時のみ additional_conditions をリセット（カジュアルは追記で保持）
  if (isFormalFormat) {
    parsedFields.additional_conditions = null;
  }

  // ── LINEプロフィールから名前を先に取得（名称未設定を防ぐ）────────
  let resolvedName = "名称未設定";
  if (account.token) {
    const profile = await fetchLineProfile(userId, account.token);
    if (profile?.displayName) resolvedName = profile.displayName;
  }

  // ── 会話レコードを取得（紐付け済み顧客IDを確認）──────────────────
  const { data: conv } = await db
    .from("conversations")
    .select("customer_name, property_customer_id")
    .eq("line_user_id", userId)
    .limit(1)
    .maybeSingle();

  // プロフィールが取れなかった場合は会話の名前を使う
  if (resolvedName === "名称未設定" && conv?.customer_name && conv.customer_name !== "名称未設定") {
    resolvedName = conv.customer_name as string;
  }

  // ── 会話の名前もプロフィール名に更新 ─────────────────────────────
  if (resolvedName !== "名称未設定") {
    await db.from("conversations")
      .update({ customer_name: resolvedName })
      .eq("line_user_id", userId);
  }

  // ── property_customers を line_user_id で検索（カジュアル更新マージ用に条件フィールドも取得）──
  const { data: existing } = await db
    .from("property_customers")
    .select("id, customer_name, desired_area, floor_plan, rent_min, rent_max, walk_minutes, move_in_time, building_age, floor_area_min, initial_cost_limit, preferences, ng_points, other_requests")
    .eq("line_user_id", userId)
    .limit(1)
    .maybeSingle();

  let customerId: string;
  let isNewCustomer = false;

  // カジュアル更新時に additional_conditions へ追記するヘルパー
  // pattern を [MM/DD HH:MM|pattern] 形式で埋め込む（フロントのバッジ表示に使用）
  const appendAdditionalConditions = async (pcId: string, intent: ConditionIntent) => {
    const note = buildConditionNote(parsed);
    if (!note) return;
    const { data: cur } = await db.from("property_customers")
      .select("additional_conditions").eq("id", pcId).maybeSingle();
    const prev = (cur?.additional_conditions as string | null) ?? "";
    const pattern = intent === "ADD" ? "add" : intent === "EXCLUDE" ? "exclude" : "change";
    // 構造化フィールドは常に自動反映済みのため「【YYYY/MM/DD 自動反映】」をマーク
    // UIの parseConditionLog() でこのマークを認識して「自動反映」バッジを表示する
    const newEntry = `[${getJSTTimestamp()}|${pattern}] ${note} 【${getJSTDate()} 自動反映】`;
    await db.from("property_customers")
      .update({ additional_conditions: prev ? `${prev}\n${newEntry}` : newEntry, updated_at: new Date().toISOString() })
      .eq("id", pcId);
  };

  // カジュアル更新用: インテント分類 → フィールドマージ
  const computeCasualUpdate = async (existingRec: Record<string, unknown> | null) => {
    const existingConds = (existingRec ?? {}) as ConditionFields;
    let intentResult = classifyByKeywords(text, existingConds.desired_area as string | null);
    if (!intentResult) {
      intentResult = await classifyByAI(anthropic, text, existingConds.desired_area as string | null);
    }
    const mergedConds = mergeConditions(
      existingConds,
      parsed as unknown as ConditionFields,
      intentResult.intent,
      intentResult.excludeTargets,
    );
    return { mergedConds, intent: intentResult.intent };
  };

  if (existing?.id) {
    customerId = existing.id as string;
    if (isFormalFormat) {
      // 正式フォーマット → 全フィールド上書き（additional_conditions もリセット）
      await db.from("property_customers")
        .update({ ...parsedFields, customer_name: resolvedName })
        .eq("id", customerId);
    } else {
      // カジュアル更新 → インテント分類 → スマートマージ（「追加」「除外」「変更」を正しく処理）
      const { mergedConds, intent } = await computeCasualUpdate(existing as Record<string, unknown>);
      await db.from("property_customers")
        .update({ ...baseFields, ...mergedConds, customer_name: resolvedName })
        .eq("id", customerId);
      await appendAdditionalConditions(customerId, intent);
    }
  } else if (conv?.property_customer_id) {
    // 会話がすでに売上サポ顧客と紐付け済み
    const linkedId = conv.property_customer_id as string;
    customerId = linkedId;
    if (isFormalFormat) {
      await db.from("property_customers")
        .update({ ...parsedFields, line_user_id: userId, customer_name: resolvedName })
        .eq("id", customerId);
    } else {
      // カジュアル更新 → 既存条件フィールドを取得してマージ
      const { data: linkedConds } = await db.from("property_customers")
        .select("desired_area, floor_plan, rent_min, rent_max, walk_minutes, move_in_time, building_age, floor_area_min, initial_cost_limit, preferences, ng_points, other_requests")
        .eq("id", linkedId)
        .maybeSingle();
      const { mergedConds, intent } = await computeCasualUpdate(linkedConds as Record<string, unknown> | null);
      await db.from("property_customers")
        .update({ ...baseFields, ...mergedConds, line_user_id: userId, customer_name: resolvedName })
        .eq("id", customerId);
      await appendAdditionalConditions(customerId, intent);
    }
  } else {
    // 未登録 → 新規登録（race condition対策: 再チェック後INSERT）
    const { data: recheck } = await db
      .from("property_customers")
      .select("id")
      .eq("line_user_id", userId)
      .maybeSingle();

    if (recheck?.id) {
      await db.from("property_customers")
        .update({ ...parsedFields, customer_name: resolvedName })
        .eq("id", recheck.id);
      customerId = recheck.id as string;
    } else {
      const { data: newCustomer } = await db
        .from("property_customers")
        .insert({ customer_name: resolvedName, line_user_id: userId, status: "new_inquiry", ...parsedFields })
        .select("id")
        .maybeSingle();
      if (!newCustomer?.id) return;
      customerId = newCustomer.id as string;
      isNewCustomer = true;
    }
  }

  // ── conversations.property_customer_id を自動セット ───────────────
  await db
    .from("conversations")
    .update({ property_customer_id: customerId })
    .eq("line_user_id", userId)
    .is("property_customer_id", null);

  // 売上番長グループに通知（新規のみ）
  if (isNewCustomer) {
    notifyFormatReceived(db, resolvedName, parsedFields).catch((e) => console.warn("[line-webhook] notifyFormatReceived:", e));
  }
}

// ── P4: カジュアル返信から物件希望条件を自動抽出 ────────────────────────────
// isFormatMessage() が false のメッセージ（真のカジュアル返信）が対象。
// スタッフの直近メッセージが条件ヒアリング文脈のとき Haiku で条件を抽出し
// property_customers を部分 UPDATE する（NULL フィールドは更新しない）。
async function extractConditionsFromCasualReply(
  db: ReturnType<typeof getDb>,
  convId: string,
  customerText: string,
): Promise<void> {
  // 直近のスタッフメッセージを取得
  const { data: lastStaffMsg } = await db
    .from("messages")
    .select("text")
    .eq("conversation_id", convId)
    .eq("sender", "staff")
    .not("text", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const staffText = lastStaffMsg?.text as string | null;
  if (!staffText) return;

  // H1: 顧客テキスト側に条件シグナル（数字・条件語）がなければスキップ（「ありがとうございます」対策）
  // 物件カード送信後はスタッフ側正規表現がほぼ必ずマッチするため、顧客側のゲートが必須
  const hasConditionSignal = /[0-9０-９]|万|LDK|DK|ワンルーム|駅|区|市|町|徒歩|築|家賃|エリア|間取り|入居|来月|再来月|即入居/.test(customerText);
  if (!hasConditionSignal) return;
  if (/^https?:\/\/\S+$/.test(customerText.trim())) return; // URLのみは対象外

  // スタッフの質問が条件ヒアリング文脈かを確認（対象外は即リターン）
  const isConditionContext = /ご希望|エリア|間取り|家賃|いつ|駅|どこ|条件|予算|入居|徒歩|築/.test(staffText);
  if (!isConditionContext) return;

  // conversations から property_customer_id を取得
  const { data: conv } = await db
    .from("conversations")
    .select("property_customer_id")
    .eq("id", convId)
    .maybeSingle();
  const pcId = conv?.property_customer_id as string | null;
  if (!pcId) return; // 紐付けなし → スキップ

  // Haiku で条件を抽出（JSON のみ返す）
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 20_000,
    maxRetries: 1,
  });

  let extracted: Record<string, unknown>;
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: "あなたは不動産営業アシスタントです。JSONのみで回答してください。",
      messages: [{
        role: "user",
        content: `お客さんの返信から物件希望条件を抽出してください。

【スタッフの質問】
${staffText.slice(0, 200)}

【お客さんの返信】
${customerText.slice(0, 300)}

読み取れた条件のみ以下の形式で返してください（不明な項目は省略してください）。
※お客さんの返信に明示された条件のみ。スタッフの質問文に含まれる数字・条件は絶対に抽出しないこと。
{
  "desired_area": "希望エリア・駅名",
  "floor_plan": "間取り（例: 1LDK）",
  "rent_max": 最高家賃（円・整数。「8万」→80000）,
  "rent_min": 最低家賃（円・整数）,
  "walk_minutes": 徒歩分数（整数）,
  "move_in_time": "入居時期（例: 9月、来月）",
  "building_age": 築年数上限（整数）,
  "initial_cost_limit": 初期費用上限（円・整数）,
  "other_requests": "その他要望"
}`,
      }],
    });

    const rawText = res.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
    const m = rawText.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim().match(/\{[\s\S]*\}/);
    if (!m) return;
    extracted = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return; // Haiku 失敗 → サイレントスキップ
  }

  // 家賃バリデーション（autoParseFormat と同ロジック）
  for (const f of ["rent_min", "rent_max", "initial_cost_limit"]) {
    const v = extracted[f];
    if (typeof v === "number" && v > 0) {
      if (v <= 300) extracted[f] = v * 10000;
      else if (v > 500000 && f !== "initial_cost_limit") extracted[f] = v / 10;
    }
  }

  // C1: 非 null・非空 フィールドのみ UPDATE 対象にする + merge-if-null（DB既存の確定値は絶対に上書きしない）
  const CONDITION_FIELDS = [
    "desired_area", "floor_plan", "rent_max", "rent_min",
    "walk_minutes", "move_in_time", "building_age", "initial_cost_limit", "other_requests",
  ];

  // 型検証: 数値カラムに文字列が入るとUPDATE全体が失敗するため number 以外は破棄
  const NUMERIC_FIELDS = new Set(["rent_max", "rent_min", "walk_minutes", "building_age", "initial_cost_limit"]);
  for (const f of NUMERIC_FIELDS) {
    if (extracted[f] !== undefined && typeof extracted[f] !== "number") delete extracted[f];
  }

  // after() C（resolve-area正規化）と競合するため、エリア指定メッセージでは desired_area を書かない
  if (isAreaSpecificationMessage(customerText)) delete extracted.desired_area;

  const { data: existingPc } = await db
    .from("property_customers")
    .select(CONDITION_FIELDS.join(","))
    .eq("id", pcId)
    .maybeSingle();

  const updates: Record<string, unknown> = {};
  for (const f of CONDITION_FIELDS) {
    const v = extracted[f];
    if (v === null || v === undefined || v === "") continue;
    const existingVal = (existingPc as Record<string, unknown> | null)?.[f];
    if (existingVal !== null && existingVal !== undefined && existingVal !== "") continue; // 既存確定値を保護
    updates[f] = v;
  }

  if (Object.keys(updates).length === 0) return; // 抽出条件なし → スキップ

  const { error: updateErr } = await db
    .from("property_customers")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", pcId);

  if (updateErr) {
    console.warn("[line-webhook] P4 property_customers update failed:", updateErr.message);
  } else {
    console.log(`[line-webhook] P4 条件抽出: conv=${convId} fields=${Object.keys(updates).join(",")}`);
  }
}

async function notifyFormatReceived(
  db: ReturnType<typeof getDb>,
  customerName: string,
  conditions: Record<string, unknown>,
) {
  const { data } = await db
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .maybeSingle();
  const groupId = data?.value as string | undefined;
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  if (!groupId || !token) {
    console.warn("[notify] group_id or token missing — skip notification");
    return;
  }

  // 条件テキストを整形
  const lines: string[] = [];
  if (conditions.desired_area)    lines.push(`📍 エリア: ${conditions.desired_area}`);
  if (conditions.rent_max) {
    const man = Math.floor((conditions.rent_max as number) / 10000);
    const min = conditions.rent_min ? `${Math.floor((conditions.rent_min as number) / 10000)}万〜` : "〜";
    lines.push(`💰 家賃: ${min}${man}万円`);
  }
  if (conditions.floor_plan)      lines.push(`🏠 間取り: ${conditions.floor_plan}`);
  if (conditions.move_in_time)    lines.push(`📅 入居: ${conditions.move_in_time}`);
  if (conditions.walk_minutes)    lines.push(`🚶 徒歩: ${conditions.walk_minutes}分以内`);
  if (conditions.building_age)    lines.push(`🏗️ 築年数: ${conditions.building_age}年以内`);
  if (conditions.initial_cost_limit) {
    lines.push(`💴 初期費用: ${Math.floor((conditions.initial_cost_limit as number) / 10000)}万以内`);
  }
  if (conditions.other_requests)  lines.push(`📝 その他: ${conditions.other_requests}`);

  const condText = lines.length > 0
    ? "\n" + lines.join("\n")
    : "\n（条件詳細は売上サポで確認）";

  const text = `📋 新規条件が届きました！\n\n👤 ${customerName}様${condText}\n\n売上サポで確認して物件を探しましょう！`;

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    console.error("[notify] LINE push failed:", res.status, await res.text());
  }
}

// ── 物件確認済みキーワード検出 ────────────────────────────────────────────
const PROPERTY_VIEWED_KEYWORDS = [
  "確認しました", "確認できました", "確認取れました",
  "見ました", "見てみました", "見てます", "見てました",
  "チェックしました", "拝見しました", "拝見できました",
  "見せてもらいました", "見れました",
];

function isPropertyViewedMessage(text: string): boolean {
  return PROPERTY_VIEWED_KEYWORDS.some((k) => text.includes(k));
}

async function autoMarkPropertyViewed(
  db: ReturnType<typeof getDb>,
  userId: string,
): Promise<void> {
  // 物件を送った記録がある顧客だけマーク（誤検知防止）
  const { data: pc } = await db
    .from("property_customers")
    .select("id, last_property_sent_at")
    .eq("line_user_id", userId)
    .not("last_property_sent_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (!pc?.id) return;

  await db
    .from("property_customers")
    .update({ property_viewed_at: new Date().toISOString() })
    .eq("id", pc.id);
}

// ── メッセージからタスクを自動検知・作成 ──────────────────────────────────
const PROPERTY_CHECK_KEYWORDS = [
  "物件確認", "初期費用確認", "初期費用を確認",
  "内覧したい", "内覧させてほしい", "内覧お願い", "内覧を希望",
  "内覧できますか", "内覧は可能", "内覧申し込み",
  "見学したい", "見学させてほしい", "見学お願い",
  "空室確認",
];

const PROPERTY_SEND_KEYWORDS = [
  "物件送って", "物件を送", "物件探して", "物件を探",
  "物件ありますか", "物件お願い", "物件出して", "物件を出して",
  "物件ください", "物件紹介してほしい", "物件を紹介", "物件ピックアップ",
];

const CONFIRM_PHRASES = ["確認してほしい", "確認してください", "確認お願い", "確認をお願い", "確認できますか"];
const CONFIRM_TARGETS = ["物件", "初期費用", "空室", "この部屋", "この物件"];

function detectTaskType(text: string): "property_check" | "property_send" | null {
  if (PROPERTY_CHECK_KEYWORDS.some((k) => text.includes(k))) return "property_check";
  // "確認してほしい/ください/お願い" + 物件/初期費用 の組み合わせ
  if (CONFIRM_PHRASES.some((p) => text.includes(p)) && CONFIRM_TARGETS.some((t) => text.includes(t))) return "property_check";
  if (PROPERTY_SEND_KEYWORDS.some((k) => text.includes(k))) return "property_send";
  return null;
}

async function autoDetectTask(
  db: ReturnType<typeof getDb>,
  convId: string,
  text: string,
): Promise<void> {
  const taskType = detectTaskType(text);
  if (!taskType) return;

  // 既にpending中なら重複作成しない
  const { data: existing } = await db
    .from("line_tasks")
    .select("id")
    .eq("conversation_id", convId)
    .eq("task_type", taskType)
    .eq("status", "pending")
    .maybeSingle();
  if (existing?.id) return;

  // 顧客名を取得
  const { data: conv } = await db
    .from("conversations")
    .select("customer_name")
    .eq("id", convId)
    .maybeSingle();
  const customerName = (conv?.customer_name as string | null) ?? "お客様";

  // タスク作成 + 要対応フラグをセット
  await Promise.all([
    db.from("line_tasks").insert({
      conversation_id: convId,
      task_type: taskType,
      customer_name: customerName,
      status: "pending",
    }),
    db.from("conversations").update({ is_flagged: true }).eq("id", convId),
  ]);

  // 売上番長グループへアナウンス
  const { data: grpRow } = await db.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
  const groupId = grpRow?.value as string | undefined;
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  if (!groupId || !token) return;

  const label = taskType === "property_check" ? "物件確認" : "物件出し";
  const emoji = taskType === "property_check" ? "🔍" : "🏠";
  const msgText = `${emoji}【${label}依頼 自動検知】\n${customerName}さんから「${label}」の依頼が届きました\n対応よろしくお願いします！`;

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [{ type: "text", text: msgText }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("[autoDetectTask] LINE push failed:", res.status, await res.text());
    }
  } catch (e) {
    console.error("[autoDetectTask] LINE push error:", e);
  }
}

// 新規客が来た → @鈴木メンションで即時通知
async function notifyNewCustomer(db: ReturnType<typeof getDb>, convId: string, customerName: string) {
  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? process.env.LINE_GROUP_ID ?? null;
  if (!groupId) {
    const { data: grpRow } = await db.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    groupId = (grpRow?.value as string) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  if (!groupId || !token) return;

  const { data: suzukiRow } = await db.from("hanbancyo_settings").select("value").eq("key", "suzuki_line_user_id").maybeSingle();
  const suzukiUserId = suzukiRow?.value as string | undefined;

  // 今日の新着件数を取得
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  jstNow.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date(jstNow.getTime() - 9 * 60 * 60 * 1000).toISOString();
  const { count: todayNewCount } = await db
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .gt("created_at", todayStart);

  const name = customerName || "名称未設定";
  const countNote = (todayNewCount ?? 0) > 1 ? `（今日${todayNewCount}人目）` : "（今日初めての新着！）";

  const text = `@鈴木 祥平 【新着】${name}が入ってきた！！${countNote}\n第一印象で全部決まるから！！今日中に必ず返して！！`;

  type MentionMsg = { type: "text"; text: string; mentionees?: { index: number; length: number; type: "user"; userId: string }[] };
  const message: MentionMsg = suzukiUserId
    ? { type: "text", text, mentionees: [{ index: 0, length: 6, type: "user", userId: suzukiUserId }] }
    : { type: "text", text };

  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [message] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.warn("[notifyNewCustomer] push failed:", e);
  }
}

// 熱い（is_hot）客が返信 → @鈴木メンション + リスト即時通知
// ※is_flaggedは全客自動セットになったためis_hotのみで通知判定する
async function notifySuzukiReply(db: ReturnType<typeof getDb>, convId: string, msgText: string) {
  const { data: conv } = await db
    .from("conversations")
    .select("customer_name, is_flagged, is_hot")
    .eq("id", convId)
    .maybeSingle();
  if (!conv?.is_hot) return; // is_hot客のみ通知（is_flaggedは全客自動セットのため除外）

  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? process.env.LINE_GROUP_ID ?? null;
  if (!groupId) {
    const { data: grpRow } = await db.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    groupId = (grpRow?.value as string) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  if (!groupId || !token) return;

  const { data: suzukiRow } = await db.from("hanbancyo_settings").select("value").eq("key", "suzuki_line_user_id").maybeSingle();
  const suzukiUserId = suzukiRow?.value as string | undefined;

  // ターゲット全リスト取得（申込以降は除外）
  const { data: flagged } = await db
    .from("conversations")
    .select("id, customer_name, updated_at")
    .eq("is_flagged", true)
    .not("status", "in", "(applying,screening,contract,closed_won,closed_lost,lost)")
    .order("updated_at", { ascending: false })
    .limit(35);

  // 今日のスタッフメッセージ（✅/☑判定）
  const jstMidnight = new Date(Date.now() + 9 * 3600000);
  jstMidnight.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date(jstMidnight.getTime() - 9 * 3600000);
  const flaggedIds = (flagged ?? []).map((c) => c.id as string);
  const staffMsgMap = new Map<string, { hasAix: boolean }>();
  if (flaggedIds.length > 0) {
    const { data: todayMsgs } = await db
      .from("messages")
      .select("conversation_id, is_aix_generated")
      .eq("sender", "staff")
      .gte("created_at", todayStart.toISOString())
      .in("conversation_id", flaggedIds);
    for (const m of todayMsgs ?? []) {
      const prev = staffMsgMap.get(m.conversation_id) ?? { hasAix: false };
      staffMsgMap.set(m.conversation_id, { hasAix: prev.hasAix || !!m.is_aix_generated });
    }
  }

  // 今日「物件確認した」顧客セット（property_customers.property_viewed_at が今日）
  const flaggedNames = (flagged ?? []).map((c) => c.customer_name as string).filter(Boolean);
  const { data: viewedRows2 } = flaggedNames.length > 0
    ? await db.from("property_customers").select("customer_name")
        .in("customer_name", flaggedNames).gte("property_viewed_at", todayStart.toISOString())
    : { data: [] };
  const viewedNames2 = new Set((viewedRows2 ?? []).map((r) => r.customer_name as string));

  // ☑(AIX未送信 or 物件確認済み) → ・(未対応) → ✅(AIX済み) の優先ソート
  const getMarkPrio = (id: string, nm: string) => { const i = staffMsgMap.get(id); if (!i && !viewedNames2.has(nm)) return 1; if (i?.hasAix) return 2; return 0; };
  const getMark     = (id: string, nm: string) => { const i = staffMsgMap.get(id); if (!i && !viewedNames2.has(nm)) return "・"; if (i?.hasAix) return "✅"; return "☑"; };
  const sorted = [...(flagged ?? [])].sort((a, b) => getMarkPrio(a.id as string, a.customer_name as string) - getMarkPrio(b.id as string, b.customer_name as string));

  const name = (conv.customer_name as string) || "名称未設定";
  const preview = msgText.slice(0, 25) + (msgText.length > 25 ? "…" : "");

  const bodyLines: string[] = [
    `【熱い客】${name}から返信きた！！`,
    `「${preview}」`,
    "今が熱い！！今すぐ詰めて！！",
    "",
    "【しょーへいの今日のターゲット全リスト】",
  ];

  if (sorted.length > 0) {
    bodyLines.push("", "► 決まる（最優先）");
    sorted.forEach((c) => bodyLines.push(`${getMark(c.id as string, c.customer_name as string)}${c.customer_name || "名称未設定"}`));
  }

  const bodyText = bodyLines.join("\n");
  const message = suzukiUserId
    ? { type: "textV2", text: `{0} ${bodyText}`, substitution: { "0": { type: "mention", mentionee: { type: "user", userId: suzukiUserId } } } }
    : { type: "text", text: bodyText };

  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [message] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.warn("[notifySuzukiReply] push failed:", e);
  }
}

async function notifyHanbancyoGroup(db: ReturnType<typeof getDb>, customerName: string) {
  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? process.env.LINE_GROUP_ID ?? null;
  if (!groupId) {
    const { data: grpRow } = await db.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    groupId = (grpRow?.value as string) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  if (!groupId || !token) return;

  const { data: suzukiRow } = await db.from("hanbancyo_settings").select("value").eq("key", "suzuki_line_user_id").maybeSingle();
  const suzukiUserId = suzukiRow?.value as string | undefined;

  const text = `@鈴木 祥平 ${customerName}から返信きた！！今が熱い！！今すぐ詰めて！！`;
  type MentionMsg = { type: "text"; text: string; mentionees?: { index: number; length: number; type: "user"; userId: string }[] };
  const message: MentionMsg = suzukiUserId
    ? { type: "text", text, mentionees: [{ index: 0, length: 6, type: "user", userId: suzukiUserId }] }
    : { type: "text", text };

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [message] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("[notifyHanbancyoGroup] LINE push failed:", res.status, await res.text());
    }
  } catch (e) {
    console.warn("[notifyHanbancyoGroup] push failed:", e);
  }
}

// ── エリア指定検知 → resolve-area抽出 → desired_area更新 + LINE通知 ──────────
// isAreaSpecificationMessage() をパスしたメッセージのみ呼ばれる（after()内で実行）
async function detectAndAnnounceAreaChange(
  db: ReturnType<typeof getDb>,
  convId: string,
  msgText: string,
): Promise<void> {
  try {
    // conversations から property_customer_id を取得
    const { data: conv } = await db
      .from("conversations")
      .select("property_customer_id")
      .eq("id", convId)
      .maybeSingle();
    if (!conv?.property_customer_id) return; // 紐付けなし → スキップ

    // resolve-area API でエリア名を抽出（Claude Haiku が自然言語を解釈）
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

    const areaRes = await fetch(`${baseUrl}/api/resolve-area`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ desired_area: msgText }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!areaRes.ok) {
      console.warn("[detectAndAnnounceAreaChange] resolve-area failed:", areaRes.status);
      return;
    }
    const areaJson = await areaRes.json() as {
      realpro?: { areas?: string[] };
      itandi?: { areas?: string[] };
    };
    const extractedAreas: string[] = areaJson.realpro?.areas ?? areaJson.itandi?.areas ?? [];
    if (extractedAreas.length === 0) return; // 抽出失敗 → サイレントスキップ

    // property_customers の既存エリアを取得
    const { data: pc } = await db
      .from("property_customers")
      .select("id, desired_area, area, customer_name, assignee")
      .eq("id", conv.property_customer_id as string)
      .single();
    if (!pc) return;

    // ADDマージ: 既存エリアと重複を排除して結合（condition-merge.ts の ADD ロジックと同等）
    const oldArea = (pc.desired_area as string | null) ?? (pc.area as string | null) ?? "";
    const existing = oldArea.split(/[・、,]+/).filter(Boolean);
    const merged = [...new Set([...existing, ...extractedAreas])].join("・");
    if (merged === existing.join("・")) return; // 変化なし → 通知不要

    await db.from("property_customers")
      .update({ desired_area: merged, updated_at: new Date().toISOString() })
      .eq("id", pc.id as string);

    // LINE スタッフグループに通知
    let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? process.env.LINE_GROUP_ID ?? null;
    if (!groupId) {
      const { data: grpRow } = await db.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
      groupId = (grpRow?.value as string) ?? null;
    }
    const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
    if (!groupId || !token) return;

    const { data: suzukiRow } = await db.from("hanbancyo_settings").select("value").eq("key", "suzuki_line_user_id").maybeSingle();
    const suzukiUserId = suzukiRow?.value as string | undefined;

    const customerName = (pc.customer_name as string | null) ?? "お客様";
    const oldAreaDisplay = oldArea || "（未設定）";
    const bodyText = `【地域指定】${customerName}さんから地域変更\n${oldAreaDisplay} → ${merged}\n※条件に反映済み`;

    const message = suzukiUserId
      ? { type: "textV2", text: `{0} ${bodyText}`, substitution: { "0": { type: "mention", mentionee: { type: "user", userId: suzukiUserId } } } }
      : { type: "text", text: bodyText };

    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [message] }),
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => console.warn("[detectAndAnnounceAreaChange] LINE push failed:", e));
  } catch (e) {
    console.warn("[detectAndAnnounceAreaChange] error:", e);
  }
}

// ── 画像メッセージ即時保存（LINEへの応答前に完了させる軽量処理）────────────
// 重複防止のため line_message_id で存在確認してから insert
async function handleImageMessageSave(
  userId: string,
  lineMessageId: string,
  account: AccountConfig,
): Promise<{ convId: string; msgId: string } | "duplicate" | null> {
  const db = getDb();
  const now = new Date().toISOString();

  const convId = await ensureConversation(db, userId, account, now);
  if (!convId) return null; // 失敗（LINEにリトライさせる）

  // 重複チェック（LINEのリトライで同じ lineMessageId が来ることがある）
  const { data: existing } = await db
    .from("messages")
    .select("id")
    .eq("line_message_id", lineMessageId)
    .maybeSingle();
  if (existing) {
    return "duplicate"; // 既に保存済み = 正常（リトライ不要）
  }

  // image_expires_at = 30日後（デフォルト保存期限）
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // image_url は後から埋める。まず line_message_id だけ保存して即座に会話に表示
  const { data: msgData, error: msgErr } = await db.from("messages").insert({
    conversation_id: convId,
    sender: "customer",
    text: "[画像]",
    image_url: null,
    line_message_id: lineMessageId,
    image_expires_at: expiresAt,
    created_at: now,
  }).select("id").maybeSingle();

  if (msgErr || !msgData) {
    console.error("[line-webhook] image message保存失敗:", msgErr?.message);
    return null;
  }

  await db
    .from("conversations")
    .update({ last_message: "[画像]", last_sender: "customer", updated_at: now, is_flagged: true, suggested_aix_meta: null })
    .eq("id", convId);

  // H4: 画像受信もスタッフに基本通知（テキスト経路のP1通知に対応する最小版）
  after(async () => {
    try {
      const { data: convData } = await db.from("conversations")
        .select("customer_name").eq("id", convId).maybeSingle();
      const nm = (convData?.customer_name as string | null) || "名称未設定";
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
      await fetch(`${baseUrl}/api/notify-group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${nm}さんから画像きた\n\n次やること: 画像の内容を確認して返信` }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (e) { console.warn("[line-webhook] image notify:", e); }
  });

  // FIX(Fable5 #2+ズレ5): 画像受信でも brain分析 + required通知（🔴）を実行
  after(async () => {
    await runBrainAndNotify(convId).catch((e) => console.warn("[line-webhook] brain notify (image):", e));
  });

  // スタッフが申込書の記入を依頼した直後の顧客画像 → 記入済み申込書の可能性大 → applying自動昇格
  // （画像フォームはテキスト検知できないためヒューリスティックで補完）
  await autoPromoteApplyingOnFormImage(db, convId, now);

  // 会話内の画像が100枚を超えたら古い画像の保存期限を即時終了
  void expireOldImagesIfOverLimit(db, convId).catch((e) => console.warn("[line-webhook] expireOldImagesIfOverLimit:", e));

  updateProfileAsync(db, userId, convId, account, "[画像]", now);
  return { convId, msgId: String(msgData.id) };
}

// ── 申込書依頼直後の顧客画像 → applying自動昇格ヒューリスティック ────────────
// 条件: (1) 現ステータスが申込前 (2) 直近のスタッフメッセージに申込書依頼の文言がある
// テキストで検知できない画像フォーム（写真で送られた記入済み申込書）の遷移漏れを塞ぐ。
async function autoPromoteApplyingOnFormImage(
  db: ReturnType<typeof getDb>,
  convId: string,
  now: string,
): Promise<void> {
  try {
    const { data: conv } = await db
      .from("conversations")
      .select("status")
      .eq("id", convId)
      .maybeSingle();
    const status = (conv?.status as string) ?? "";
    if (!PRE_APPLY_STATUSES.includes(status)) return;

    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const { data: staffMsgs } = await db
      .from("messages")
      .select("text")
      .eq("conversation_id", convId)
      .eq("sender", "staff")
      .gt("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);
    const lastStaffText = (staffMsgs?.[0]?.text as string) ?? "";
    if (!/申込書|申込用紙|ご記入|入居申込/.test(lastStaffText)) return;

    const { data: updated, error } = await db
      .from("conversations")
      .update({ status: "applying", updated_at: now })
      .eq("id", convId)
      .in("status", PRE_APPLY_STATUSES)
      .select("id");
    if (error) {
      console.error(`[line-webhook] 画像申込書→applying昇格失敗: conv=${convId}`, error.message);
    } else if ((updated ?? []).length > 0) {
      console.log(`[line-webhook] 申込書依頼後の画像受信 → applying自動昇格: conv=${convId}`);
      // P2: ステータス変遷を記録（status は上部の SELECT で取得済み）
      void (async () => {
        const { error: stageErr } = await db.from("conversation_stage_history").insert({
          conversation_id: convId,
          from_status: status,
          to_status: "applying",
          trigger: "customer_message",
        });
        if (stageErr) console.warn("[stage_history] image-applying:", stageErr.message);
      })();
    }
  } catch (e) {
    console.warn("[line-webhook] autoPromoteApplyingOnFormImage:", e);
  }
}

// ── Claude Vision で画像内容を日本語テキスト抽出 ────────────────────────────
// buf: LINE Content API から取得済みの ArrayBuffer（二重ダウンロード不要）
async function extractImageContent(buf: ArrayBuffer, mimeType: string): Promise<string> {
  try {
    const base64 = Buffer.from(buf).toString("base64");
    // Claude Vision が受け付ける MIME タイプのみ渡す（非対応は image/jpeg にフォールバック）
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
    type AllowedMime = (typeof allowedTypes)[number];
    const safeType: AllowedMime = (allowedTypes as readonly string[]).includes(mimeType)
      ? (mimeType as AllowedMime)
      : "image/jpeg";

    const visionRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: safeType, data: base64 },
              },
              {
                type: "text",
                text: "この画像に写っているテキスト・会話・情報をすべて書き起こしてください。LINEスクリーンショットの場合は発言者と内容を整理して返してください。画像の説明は不要で、内容だけ返してください。",
              },
            ],
          },
        ],
      }),
    });
    if (!visionRes.ok) {
      console.warn("[line-webhook] Vision API失敗 status=", visionRes.status);
      return "";
    }
    const visionData = await visionRes.json() as {
      content?: Array<{ type: string; text?: string }>;
    };
    return visionData.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
  } catch (e) {
    console.warn("[line-webhook] Vision抽出エラー:", e);
    return "";
  }
}

// ── LINE Content API から画像を取得してStorageに保存（after()で非同期実行）──
// Vision抽出（claude-haiku-4-5）と Storage upload を並列実行し、
// 完了後に messages.text（[画像] <内容>）と messages.image_url を同時更新する。
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
      { headers: { Authorization: `Bearer ${account.token}` }, signal: AbortSignal.timeout(10_000) },
    );

    if (!contentRes.ok) {
      console.warn(`[line-webhook] Content API失敗 status=${contentRes.status} msgId=${lineMessageId}`);
      return;
    }

    const contentType = contentRes.headers.get("content-type") || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : contentType.includes("gif") ? "gif" : "jpg";
    const arrayBuf = await contentRes.arrayBuffer();
    const storagePath = `${lineMessageId}.${ext}`;

    // Vision抽出 と Storage upload を並列実行（arrayBuf は読み取り専用で両方に渡せる）
    const [visionResult, uploadResult] = await Promise.allSettled([
      extractImageContent(arrayBuf, contentType),
      db.storage
        .from("line-images")
        .upload(storagePath, new Blob([arrayBuf], { type: contentType }), { contentType, upsert: true }),
    ]);

    if (uploadResult.status === "rejected") {
      console.error("[line-webhook] Storage upload失敗:", uploadResult.reason, "msgId:", lineMessageId);
      return;
    }
    if (uploadResult.value.error) {
      console.error("[line-webhook] Storage upload失敗:", uploadResult.value.error.message, "msgId:", lineMessageId);
      return;
    }

    const { data: urlData } = db.storage.from("line-images").getPublicUrl(storagePath);

    // Vision 抽出結果を "[画像] <内容>" 形式でテキストとして保存
    const extracted = visionResult.status === "fulfilled" ? visionResult.value : "";
    const newText = extracted ? `[画像] ${extracted}` : "[画像]";

    const { error: updateErr } = await db
      .from("messages")
      .update({ image_url: urlData.publicUrl, text: newText })
      .eq("id", msgId);

    if (updateErr) {
      console.error("[line-webhook] image_url/text更新失敗:", updateErr.message);
    }
  } catch (e) {
    console.error("[line-webhook] 画像処理エラー:", e);
  }
}

// 会話内の画像が100枚を超えたら、超過分の古い画像を即時期限切れにする
async function expireOldImagesIfOverLimit(
  db: ReturnType<typeof getDb>,
  convId: string,
  limit = 100,
): Promise<void> {
  const { data: imgs } = await db
    .from("messages")
    .select("id, image_expires_at")
    .eq("conversation_id", convId)
    .eq("sender", "customer")
    .like("text", "[画像]%")
    .not("image_expires_at", "is", null)
    .gt("image_expires_at", new Date().toISOString()) // まだ有効なもの
    .order("created_at", { ascending: true });

  if (!imgs || imgs.length <= limit) return;

  // limit超過分の古い画像IDを即時期限切れにする
  const overflowIds = imgs.slice(0, imgs.length - limit).map((m) => m.id as string);
  await db
    .from("messages")
    .update({ image_expires_at: new Date().toISOString() })
    .in("id", overflowIds);
}

// destination → account key のマッピング（各LINE公式アカウントのBot User ID）
const DESTINATION_MAP: Record<string, string> = Object.fromEntries(
  ([
    [process.env.LINE_SUMORA_DESTINATION, "sumora"],
    [process.env.LINE_IEYASU_DESTINATION, "ieyasu"],
    [process.env.LINE_GIGA_DESTINATION, "giga"],
  ] as [string | undefined, string][]).filter(([k]) => !!k)
);

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
  // secret未設定のアカウントは検証不能のため処理を拒否（fail-close）
  if (!matchedAccount.secret) {
    console.error("[line-webhook] channel secret未設定のため処理を拒否:", matchedAccount.key);
    return NextResponse.json({ error: "channel secret not configured" }, { status: 500 });
  }
  const valid = await verifySignature(rawBody, signature, matchedAccount.secret);
  if (!valid) {
    console.warn("[line-webhook] 署名検証失敗:", matchedAccount.key);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const events = body.events ?? [];

  // 画像メッセージの後処理用（after()で非同期実行する分）
  const imageJobs: Array<{ lineMessageId: string; msgId: string; account: typeof matchedAccount }> = [];
  let anyFailed = false;

  for (const ev of events) {
    const event = ev as {
      type: string;
      source?: { type?: string; userId?: string };
      message?: { type: string; id?: string; text?: string; quotedMessageId?: string };
      unsend?: { messageId?: string };
    };

    // フォロー/ブロック/フォロー解除 → line_status を更新
    if (event.type === "follow") {
      const uid = event.source?.userId;
      if (uid) {
        const db = getDb();
        await Promise.all([
          db.from("conversations").update({ line_status: "active" }).eq("line_user_id", uid),
          db.from("line_contacts").update({ line_status: "active" }).eq("line_user_id", uid).eq("account", matchedAccount.key),
        ]).catch(() => {});
      }
      continue;
    }
    if (event.type === "unfollow") {
      const uid = event.source?.userId;
      if (uid) {
        const db = getDb();
        await Promise.all([
          db.from("conversations").update({ line_status: "unfollowed" }).eq("line_user_id", uid),
          db.from("line_contacts").update({ line_status: "unfollowed" }).eq("line_user_id", uid).eq("account", matchedAccount.key),
        ]).catch(() => {});
      }
      continue;
    }

    // 送信取消（unsend）→ 該当メッセージを削除し、学習例の☆を外す（学習データ汚染防止）
    // 取り消されたメッセージを ai_reply_examples の教師データとして残さない
    if (event.type === "unsend") {
      const unsendMessageId = event.unsend?.messageId;
      if (unsendMessageId) {
        const db = getDb();
        const { data: unsentMsg } = await db
          .from("messages")
          .select("id, text")
          .eq("line_message_id", unsendMessageId)
          .maybeSingle();
        if (unsentMsg) {
          const unsentText = (unsentMsg.text as string | null) ?? "";
          // sent_reply が取り消し文と一致する学習例の☆を外す（誤送信文の学習防止）
          // "[画像]" で始まるテキスト（Vision抽出付きも含む）は学習対象外
          if (unsentText.trim() && !unsentText.startsWith("[画像]")) {
            await db
              .from("ai_reply_examples")
              .update({ is_starred: false })
              .eq("sent_reply", unsentText);
          }
          // messages から物理削除（取り消されたメッセージは会話履歴・AI文脈から除外）
          await db.from("messages").delete().eq("id", unsentMsg.id);
        }
      }
      continue;
    }

    if (event.type !== "message") continue;
    // 自分自身（bot）からのメッセージはスキップ（返信送信時のエコーバック対策）
    if (event.source?.type === "bot") {
      continue;
    }
    if (event.source?.userId == null) continue;

    const msgType = event.message?.type;
    const userId = event.source.userId;

    // 鈴木のuserIdが未保存なら、プロフィールをチェックして自動保存
    after(async () => {
      try {
        const db2 = getDb();
        const { data: existing } = await db2.from("hanbancyo_settings").select("value").eq("key", "suzuki_line_user_id").maybeSingle();
        if (!existing?.value && matchedAccount.token) {
          const profile = await fetchLineProfile(userId, matchedAccount.token);
          if (profile?.displayName?.includes("鈴木")) {
            await db2.from("hanbancyo_settings").upsert({ key: "suzuki_line_user_id", value: userId }, { onConflict: "key" });
            console.log("[line-webhook] 鈴木のuserIdを自動保存:", userId, profile.displayName);
          }
        }
      } catch (e) {
        console.warn("[line-webhook] 鈴木userId自動検出エラー:", e);
      }
    });

    if (msgType === "text") {
      const lineMessageId = event.message?.id;
      const text = (event.message as { text?: string })?.text;
      if (!text) continue;
      // LINEリプライ（引用）機能: 引用元メッセージID（LINE API 2023年9月〜）
      const quotedMessageId = event.message?.quotedMessageId;
      // sync-from-screeningより高速な直接経路で保存（line_message_idで重複防止）
      const ok = await handleTextMessage(userId, text, matchedAccount, lineMessageId, quotedMessageId);
      if (!ok) anyFailed = true;
      continue;
    } else if (msgType === "image") {
      const lineMessageId = event.message?.id;
      if (!lineMessageId) continue;
      // 即時保存（重複チェック込み）してから後処理キューに積む
      const saved = await handleImageMessageSave(userId, lineMessageId, matchedAccount);
      if (saved === null) {
        anyFailed = true; // 失敗 → LINEにリトライさせる
      } else if (saved !== "duplicate") {
        imageJobs.push({ lineMessageId, msgId: saved.msgId, account: matchedAccount });
      }
    } else if (msgType === "sticker") {
      // H4: スタンプは保存も通知もされず消えていた → テキスト経路で "[スタンプ]" として保存・通知
      const lineMessageId = event.message?.id;
      const ok = await handleTextMessage(userId, "[スタンプ]", matchedAccount, lineMessageId);
      if (!ok) anyFailed = true;
      continue;
    }
    // video / audio / file は現状スキップ
  }

  // LINEへの200レスポンスを先に返し、画像fetch/uploadはレスポンス後に実行
  // after()はNext.js 14.1+の機能。レスポンス送信後もVercel functionを維持する
  if (imageJobs.length > 0) {
    after(async () => {
      await Promise.allSettled(
        imageJobs.map(({ lineMessageId, msgId, account }) => fetchAndUploadLineImage(lineMessageId, msgId, account))
      );
    });
  }

  // 保存失敗時は500を返してLINEにリトライさせる（line_message_id UNIQUE制約で重複保存は防止済み）
  if (anyFailed) {
    return NextResponse.json({ error: "message save failed, will retry" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
