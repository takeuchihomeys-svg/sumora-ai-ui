import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { isApplicationFormMessage, hasApplyHintKeyword, PRE_APPLY_STATUSES } from "@/app/lib/application-form-detect";
import { classifyByKeywords, classifyByAI, type ConditionIntent } from "@/app/lib/condition-intent";
import { mergeConditions, type ConditionFields } from "@/app/lib/condition-merge";
import { isPropertySiteUrl } from "@/app/api/parse-condition-url/route";
import { runBrainAndNotify } from "@/app/lib/brain-core";
import { BG_ASYNC_SKIP_STATUSES } from "@/app/lib/conversation-status";
import { recordConditionHistory } from "@/app/lib/condition-history";

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
// 定義は conversation-status.ts（BG_ASYNC_SKIP_STATUSES）に集約。
// bg-async・cron 側も同じ定数を import しているため、変更は conversation-status.ts のみで行う。

// ── P4: 顧客メッセージ自体に条件語彙が含まれるかの判定 ─────────────────────
// スタッフ側がヒアリング文脈でなくても（内覧調整中・物件フィードバック中など）、
// 顧客が自発的に条件を漏らした場合に P4 抽出を発火させるための語彙正規表現。
const CUSTOMER_CONDITION_VOCAB_RE = /ペット|(?:バス|風呂|トイレ).*別|オートロック|洗面|駐車場|広さ|㎡|帖|畳|築\d|万円|エリア|駅.*徒歩|間取り|日当たり|洗濯機.*置|ベランダ|[2-9]階以上|角部屋|独立洗面|宅配ボックス|インターネット|Wi.Fi|2LDK|1LDK|1K/;

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

// ── 引用リプライ → 送付物件の解決（Writer 3）─────────────────────────────────
// 顧客がスタッフの物件カード/物件メッセージを引用して返信したとき、
// messages.referenced_property_id と sent_properties.customer_reaction を事実化する。
// 非ブロッキング: after() から呼ばれ、失敗しても warn のみ。
async function resolvePropertyReference(
  db: ReturnType<typeof getDb>,
  convId: string,
  msgId: string,
  quotedMessageId: string,
  replyText: string,
): Promise<void> {
  // 1. 引用先スタッフメッセージを解決（line_message_id で JOIN）
  const { data: quoted } = await db
    .from("messages")
    .select("id, sender, text, image_url")
    .eq("line_message_id", quotedMessageId)
    .maybeSingle();
  if (!quoted || quoted.sender === "customer") return;

  // 2. 引用先メッセージ → sent_properties マッチ（この会話の直近20件）
  const { data: props } = await db
    .from("sent_properties")
    .select("id, property_name, room_no, image_url, property_url")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: false })
    .limit(20);
  const qText = (quoted.text as string | null) ?? "";
  const hit = (props ?? []).find((p) =>
    (p.image_url && p.image_url === quoted.image_url) ||                                        // 物件カード画像一致
    (p.property_url && qText.includes(p.property_url as string)) ||                             // URL一致
    (p.property_name && (p.property_name as string).length >= 3 && qText.includes(p.property_name as string)) // 物件名一致
  );
  if (!hit) return;

  // 3. messages.referenced_property_id
  const { error: refErr } = await db
    .from("messages")
    .update({ referenced_property_id: hit.id })
    .eq("id", msgId);
  if (refErr) console.warn("[resolvePropertyReference] referenced_property_id:", refErr.message);

  // 4. sent_properties.customer_reaction（キーワード分類。'no_response' は別途cron担当）
  const rejected = /見送|やめ|他で決|別の(物件|部屋)|なし|違う|微妙|イメージと/.test(replyText);
  const { error: reactErr } = await db
    .from("sent_properties")
    .update({ customer_reaction: rejected ? "rejected" : "interested" })
    .eq("id", hit.id);
  if (reactErr) console.warn("[resolvePropertyReference] customer_reaction:", reactErr.message);
}

// ── 流入元判定（conversations.acquisition_source）────────────────────────────
// 初回顧客メッセージのテキストから決定論的に判定する（brain信号TikTokの事実化）
function detectAcquisitionSource(t: string, accountKey: string): string {
  if (/tiktok|ティックトック|ティクトク|動画\s*(見|みて)|広告(を)?(見|みて)/i.test(t)) return "tiktok";
  if (/インスタ|instagram|ストーリー/i.test(t)) return "instagram";
  if (/紹介|知人|友人から|友達から/.test(t)) return "referral";
  if (accountKey === "ieyasu") return "tiktok"; // イエヤスLPはTikTok専用導線
  return "organic";
}

// ── テキストメッセージ保存 ────────────────────────────────────────────────
async function handleTextMessage(
  userId: string,
  text: string,
  account: AccountConfig,
  lineMessageId?: string,
  quotedMessageId?: string,
  skipDraftTrigger?: boolean,
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

  const { data: insertedMsg, error: msgErr } = await db.from("messages").insert({
    conversation_id: convId,
    sender: "customer",
    text,
    ...(lineMessageId ? { line_message_id: lineMessageId } : {}),
    // LINEリプライ（引用）: 引用元メッセージID（物件カードへの引用→物件興味判定に使う）
    quoted_message_id: quotedMessageId ?? null,
    created_at: now,
  }).select("id").maybeSingle();
  const insertedMsgId = insertedMsg?.id ? String(insertedMsg.id) : null;
  if (msgErr) {
    if (msgErr.code === "23505") {
      // UNIQUE制約違反 = sync-from-screeningが同時に保存済み。正常扱い（Writer 3はスキップ）
    } else {
      console.error("[line-webhook] message保存失敗:", msgErr.message);
      return false;
    }
  }

  // 引用リプライ → 物件カード解決（messages.referenced_property_id + sent_properties.customer_reaction）
  if (quotedMessageId && insertedMsgId) {
    after(async () => {
      await resolvePropertyReference(db, convId, insertedMsgId, quotedMessageId, text)
        .catch((e) => console.warn("[resolvePropertyReference]", e));
    });
  }

  await db
    .from("conversations")
    .update({ last_message: text, last_sender: "customer", updated_at: now, is_flagged: true, suggested_aix_meta: null })
    .eq("id", convId);

  // FIX: stale __SHOWN__ 残留対策 — 前サイクルでスタッフ閲覧済み（ai_draft='__SHOWN__'）のまま
  // 新着顧客メッセージが来ると、brain分析が失敗した場合に brain-sweep が「表示済み」と誤認して
  // 永久に補填しなくなる。__SHOWN__ センチネルのみを null に戻す（.eq ガードにより実ドラフトには
  // 触れないため、after() B の bg-async ロック保護とも競合しない）
  await db
    .from("conversations")
    .update({ ai_draft: null })
    .eq("id", convId)
    .eq("ai_draft", "__SHOWN__");

  // 顧客返信 → pending property_check タスクを自動キャンセル（brain呼び出し前に同期実行）
  // stale なタスクが残ると brain-core L699 等が「確認待ち」と誤判断して property_check_result を
  // 強制提案してしまう。顧客が返信した時点でタスクを消去し LLM が文脈から正しく判断できるようにする。
  await db
    .from("line_tasks")
    .update({ status: "cancelled" })
    .eq("conversation_id", convId)
    .eq("task_type", "property_check")
    .eq("status", "pending");

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
      if (!BG_ASYNC_SKIP_STATUSES.has(convStatus)) return; // bg-async側のbrain直列実行に任せる
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
      // 流入元を初回メッセージから判定して記録（冪等: NULLの時のみセット、二重webhook配信でも上書きしない）
      await db
        .from("conversations")
        .update({ acquisition_source: detectAcquisitionSource(text, account.key) })
        .eq("id", convId)
        .is("acquisition_source", null)
        .then(({ error }) => { if (error) console.warn("[acquisition_source]", error.message); });

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
      // applying_text_received=true をセット → 画像も揃ったら tryPromoteToApplying で applying に昇格
      // （テキスト単体では applying にしない。本人確認画像との両方が必要）
      // .in(PRE_APPLY_STATUSES)ガードで冪等（既にapplying以降なら何もしない）
      const { data: updated, error: applyErr } = await db
        .from("conversations")
        .update({ applying_text_received: true, updated_at: now })
        .eq("id", convId)
        .in("status", PRE_APPLY_STATUSES)
        .select("id");
      if (applyErr) {
        console.error(`[line-webhook] applying_text_received更新失敗: conv=${convId}`, applyErr.message);
      } else if ((updated ?? []).length > 0) {
        console.log(`[line-webhook] 申込フォーム検知 → applying_text_received=true: conv=${convId} type=${detectSource}`);
        await tryPromoteToApplying(db, convId, now, `text:${detectSource}`);
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
        await autoParseFormat(db, userId, convId, text, account);
      } catch (e) { console.error("[autoParseFormat]", e); }
    });
  }

  // after() B: draft_pending_at設定 + bg-async直接トリガー
  // skipDraftTrigger=true のとき（スタンプ・同一会話の重複イベント等）は登録しない
  if (!skipDraftTrigger) {
    after(async () => {
      try {
        const { data: conv } = await db
          .from("conversations")
          .select("status")
          .eq("id", convId)
          .maybeSingle();
        const convStatus = (conv?.status as string) || "hearing";

        const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
          ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

        // 申込以降ステータスはai_summary・ai_draft生成不要（bg-async/cronと同じ共有定数）
        if (BG_ASYNC_SKIP_STATUSES.has(convStatus)) return;

        const pendingNow = new Date().toISOString();
        const fiveMinAgoStr = new Date(Date.now() - 5 * 60 * 1000).toISOString();

        // draft_pending_at は常に更新（cronフォールバックのシグナル）
        // draft_attempted_at は bg-async 側のみが管理する — webhook 側では絶対にリセットしない
        // （リセットするとbg-asyncのatomic claimロックが破壊され多重生成を引き起こす）
        await db.from("conversations")
          .update({ draft_pending_at: pendingNow })
          .eq("id", convId);

        // ai_draft は「bg-asyncが現在ロック中でない場合のみ」リセット
        // ロック中（draft_attempted_at が5分以内）は既存下書きを保護する
        // ただし [AIX誘導中] はセンチネル値なので顧客メッセージ到着時に必ずクリアする
        // （suggested_aix_meta が null にリセットされた後も [AIX誘導中] が固着するバグを防ぐ）
        await db.from("conversations")
          .update({ ai_draft: null })
          .eq("id", convId)
          .or(`draft_attempted_at.is.null,draft_attempted_at.lt.${fiveMinAgoStr},ai_draft.eq."[AIX誘導中]"`);

        // 直接トリガー: 60s debounce待ちを排除して即座にbg-asyncを起動
        // - bg-asyncは即200を返す（実処理は自身のafter()で行う）→ 3秒でほぼ確実に完了
        // - awaitにすることでVercelがafter()コールバック終了前にプロセスを終了させるリスクを排除
        // - draft_pending_at は維持されるため、失敗してもcronが60-120s後にfallbackとして拾う
        await fetch(`${baseUrl}/api/generate-draft-bg-async`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation_id: convId, source: "direct" }),
          signal: AbortSignal.timeout(3000),
        }).catch((e) => console.warn("[line-webhook] direct bg-async trigger failed:", e));
      } catch (e) {
        console.error("[line-webhook] after() draft_pending_at update failed:", e);
      }
    });
  }

  // after() C: エリア指定検知 → resolve-area抽出 → desired_area更新 + LINE通知
  if (isAreaSpecificationMessage(text)) {
    after(async () => {
      await detectAndAnnounceAreaChange(db, convId, text)
        .catch((e) => console.warn("[detectAndAnnounceAreaChange]", e));
    });
  }

  // after() E: P4 — カジュアル返信から条件を自動抽出（Haiku: 明示条件を高速・安価に取得）
  // 物件検索フェーズ（hearing / property_search / hot / proposing）のみ実行し無駄なAPI消費を防止
  if (!applyFormDetected && !isFormatMessage(text) && text.length >= 5) {
    after(async () => {
      try {
        const { data: cs } = await db.from("conversations").select("status").eq("id", convId).maybeSingle();
        const status = (cs?.status as string | null) ?? "";
        if (!["hearing", "property_search", "hot", "proposing"].includes(status)) return;
        await extractConditionsFromCasualReply(db, convId, text);
      } catch (e) {
        console.warn("[line-webhook] extractConditionsFromCasualReply:", e);
      }
    });
  }

  // after() F: runConditionBrain は brain-core.ts の runBrainAndNotify が
  // checkpoint_stage / condition_change_type を検出した場合に直接起動（brain信号制御に移設済み）

  // after() D: FIX #09 — suggest-next-action → notify-group（顧客別スタッフ指示を通知）
  // 返信受信後にAIが次アクションを提案し、スタッフグループLINEに送信する（fire-and-forget）

  return true;
}

async function autoUpgradeToHot(db: ReturnType<typeof getDb>, userId: string) {
  const { data } = await db
    .from("property_customers")
    .select("id, status, customer_name")
    .eq("line_user_id", userId)
    .in("status", ["new_inquiry", "property_search", "hot", "proposing"])
    .limit(1)
    .maybeSingle();
  if (data?.id) {
    const shouldUpgradePropStatus = data.status === "new_inquiry" || data.status === "property_search";
    // conversations.is_hot はbrainが担う（watermark競合解消）
    if (shouldUpgradePropStatus) {
      await db.from("property_customers")
        .update({ status: "hot", updated_at: new Date().toISOString() })
        .eq("id", data.id);
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
  // 物件サイトURLが含まれる場合、残りテキストに変更意図キーワードがなければ条件フォーマットとみなさない
  // （SUUMO等のURLカードに付くタイトル「十三 1LDK 9階」を条件更新と誤解析するバグ防止）
  if (isPropertySiteUrl(text)) {
    const textOnly = text.replace(/https?:\/\/[^\s]+/g, "").trim();
    if (textOnly.length < 15) return false;
    const hasChangeIntent = [
      "変えたい", "変更", "に変えて", "修正", "更新",
      "追加", "も見たい", "広げ", "せばめ",
    ].some((k) => textOnly.includes(k));
    if (!hasChangeIntent) return false;
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
    "上げ", "下げ", "にしようかな",
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
  // 自転車 + 分数 → エリア指定として扱う（自転車圏内→駅リスト展開）
  if (/自転車|チャリ/.test(text) && /\d+分/.test(text)) return true;

  // 行政区画トークン（従来の検知）
  const adminMatches = text.match(/[^\s]{1,6}[都道府県市区町村]/g) ?? [];
  const hasTrigger = /辺り|あたり|周辺|エリア|で探|でも探|も探|希望|沿線/.test(text);

  // 駅・路線の明示パターン（新規追加）
  // ① 「〇〇駅」: 漢字/カタカナ/英数字 + 駅 → 明示的な駅指定
  const hasStationWord = /[一-鿿a-zA-Zａ-ｚＡ-Ｚァ-ヶ]{1,10}駅/.test(text);
  // ② 「〇〇線」: 漢字/カタカナ 2文字以上 + 線 → 路線名指定
  const hasLineName = /[一-鿿ァ-ヶ]{2,10}線/.test(text);
  // ③ 路線事業者プレフィックス + 続く語 → 「阪急梅田」「JR高槻」等
  const hasLinePrefix = /(?:阪急|阪神|JR|近鉄|京阪|南海|大阪メトロ|地下鉄|東急|小田急|京王|西武|東武|東京メトロ|都営)[\S]{1,8}/.test(text);
  // ④ 漢字・カタカナ語 + 場所サフィックス → 「梅田周辺」「難波あたり」「心斎橋エリア」
  //    ひらがなのみのトークン（「そのあたり」「ご希望」等）は除外
  const hasPlaceWithSuffix = /[一-鿿ァ-ヶ]{1,8}(?:あたり|周辺|エリア|沿線|辺り)/.test(text);

  // エリア追加パターン: 「〜区もお願い」「〜市もお願い」等
  const hasAreaAddRequest = /[一-鿿]{1,6}[区市](?:も|をお願い|もお願い)/.test(text);

  return adminMatches.length >= 2
    || (adminMatches.length >= 1 && (hasTrigger || hasAreaAddRequest))
    || hasStationWord
    || hasLineName
    || hasLinePrefix
    || hasPlaceWithSuffix;
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
  if (parsed.commute_station || parsed.commute_minutes) {
    const cs = parsed.commute_station ? `${parsed.commute_station}まで` : "";
    const cm = parsed.commute_minutes ? `電車${parsed.commute_minutes}分` : "";
    parts.push(`通勤: ${cs}${cm}`);
  }
  if (parsed.move_in_time)       parts.push(`入居: ${parsed.move_in_time}`);
  if (parsed.building_age)       parts.push(`築年: ${parsed.building_age}年以内`);
  if (parsed.initial_cost_limit) parts.push(`初期: ${Math.floor((parsed.initial_cost_limit as number) / 10000)}万以内`);
  if (parsed.preferences)        parts.push(`希望: ${parsed.preferences}`);
  if (parsed.ng_points)          parts.push(`NG: ${parsed.ng_points}`);
  if (parsed.other_requests)     parts.push(`その他: ${parsed.other_requests}`);
  return parts.join(" / ");
}

// ── スモラが使う希望条件フォーマット定義（AI分類・抽出プロンプトに埋め込む）──
// スタッフがお客さんに送るテンプレートの形式。これを知ることで誤判定を防ぐ。
const CONDITION_FORMAT_TEMPLATE = `
【スモラの希望条件フォーマット（スタッフがお客さんに送るテンプレート）】
お客さんがこの形式で送ってきたものが「正式フォーマット」です:
①希望エリア：（例: 梅田・北摂エリア、塚本駅・梅田駅沿線）
②希望間取り：（例: 1LDK、2K以上）
③希望家賃（上限）：（例: 8万円以内）
④入居時期：（例: 来月、9月）
⑤初期費用（上限）：（例: 30万以内）
⑥徒歩（駅から）：（例: 10分以内） ← 最寄り駅まで歩いて何分か
⑦築年数（上限）：（例: 築20年）
⑧こだわり条件：（例: オートロック、独立洗面台）
⑨NG条件：（例: 1階NG、木造NG）
⑩その他ご要望：（例: 駐車場あれば尚良し）
⑪通勤先（任意）：（例: 難波駅まで電車で30分以内） ← 電車で通勤先まで何分か
番号は多少前後・欠番があってもOK。項目名が多少違っても内容で判断。
`;

// ── Haiku 分類プロンプト（条件メッセージかどうかを文脈付きで判定）──
const CLASSIFY_CONDITION_SYSTEM_PROMPT = `あなたは日本の不動産業者のアシスタントです。
お客さんのLINEメッセージを以下の4種類に分類し、JSONのみ返してください。

${CONDITION_FORMAT_TEMPLATE}

【分類ルール】
- "formal_format": 上記フォーマットに沿った条件一覧。①〜番号付き条件項目が3つ以上含まれる。
- "condition_change": 特定条件を変更したい表現（「エリアを〜に変えたい」「やっぱり〜で」「〜にしてほしい」等）
- "condition_add": 条件を追加したい表現（「〜も追加で」「〜もOKです」「〜も良いです」等）
- "not_condition": 上記以外（挨拶・感謝・質問・申込書類・内覧日程・物件感想・プロフィール送付等）

【必ず "not_condition" にするもの】
- 「①申込書 ②本人確認書類」のような申込手続きに関する番号付きリスト
- 「この物件、良いですね！」のような物件への感想・反応
- 「内覧できますか？」「〇日に見たいです」のような内覧・日程調整
- 「ありがとうございます」「よろしくお願いします」などの挨拶・礼儀
- 会話の流れと無関係な番号付きリスト

返すJSON:
{"type":"formal_format"|"condition_change"|"condition_add"|"not_condition","confidence":0.0〜1.0}

JSONのみ。説明不要。`;

// ── Haiku で条件メッセージを分類（フォーマット知識 + 会話文脈を利用）──
async function classifyConditionMessage(
  anthropic: Anthropic,
  customerText: string,
  recentContext: Array<{ sender: string; text: string }>,
): Promise<{ type: "formal_format" | "condition_change" | "condition_add" | "not_condition"; confidence: number }> {
  const contextLines = recentContext
    .map((m) => `[${m.sender === "staff" ? "スタッフ" : "お客さん"}] ${m.text.slice(0, 150)}`)
    .join("\n");
  const userContent = `【直近の会話履歴】\n${contextLines || "（なし）"}\n\n【今回のお客さんのメッセージ】\n${customerText.slice(0, 500)}`;
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      system: [{ type: "text", text: CLASSIFY_CONDITION_SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: userContent }],
    });
    const raw = (res.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "").trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { type: "not_condition", confidence: 0 };
    const parsed = JSON.parse(m[0]) as { type?: string; confidence?: number };
    const validTypes = ["formal_format", "condition_change", "condition_add", "not_condition"] as const;
    const t = validTypes.find((v) => v === parsed.type) ?? "not_condition";
    return { type: t, confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5 };
  } catch {
    return { type: "not_condition", confidence: 0 };
  }
}

// ── autoParseFormat 用の静的システムプロンプト（prompt cache 対象）──
// 動的テキスト（cleanText）は user メッセージ側に分離し、この静的部分のみキャッシュする
const PARSE_FORMAT_SYSTEM_PROMPT = `あなたは日本の不動産業者のアシスタントです。
ユーザーメッセージのテキストから物件検索条件を読み取ってJSONで返してください。

【金額の変換ルール（最重要）】
- 日本では 1万円 = 10,000円 です
- 「11万」「11万円」「11万以内」→ 110000
- 「7万5千」「7.5万」→ 75000
- 「8万〜10万」→ rent_min: 80000, rent_max: 100000
- 「60,000円」「6万円」→ 60000
- 金額はすべて円単位の整数で返す

【家賃 vs 初期費用の文脈判断ルール】
「〇万円以内でお願いします」のように何の費用か明示されていない場合:
- 「家賃」「賃料」「月々」という語句が近くにある → rent_max
- 「初期費用」「敷金」「礼金」「引越し費用」という語句が近くにある → initial_cost_limit
- どちらも不明な場合は金額で推測:
  ・〜19万円 → 家賃（rent_max）の可能性が高い
  ・20万円以上 → 初期費用（initial_cost_limit）の可能性が高い

【徒歩 vs 通勤の区別（重要）】
「最寄り駅まで徒歩○分」「駅から徒歩○分」など最寄り駅への歩行時間 → walk_minutes（整数）
「○○駅まで電車で○分」「○○駅まで○分以内」など通勤先駅への電車時間 → commute_station + commute_minutes
例: 「難波まで30分以内」→ commute_station: "難波駅", commute_minutes: 30
例: 「駅徒歩10分以内」→ walk_minutes: 10

【エリアと駅名の扱い】
「希望エリア」に地名（梅田周辺）と駅名（塚本駅・梅田駅）が混在する場合、両方まとめて desired_area に入れる。
例: 「梅田周辺、塚本駅・梅田駅沿線」→ desired_area: "梅田周辺・塚本駅・梅田駅"

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
  "walk_minutes": 最寄り駅まで徒歩分数の数値か null,
  "commute_station": "通勤先駅名（文字列またはnull。例: 難波駅）",
  "commute_minutes": 通勤先まで電車での所要分数の数値か null,
  "floor_plan": "希望間取り（文字列またはnull）",
  "initial_cost_limit": 初期費用上限の数値か null,
  "building_age": 築年数上限の数値か null,
  "floor_area_min": 希望する部屋の広さの最低㎡数（数値か null。例:「30㎡以上」→ 30）,
  "preferences": "こだわり・希望条件（オートロック・ペット可・駐車場あり等。文字列またはnull）",
  "ng_points": "NG条件（1階NG・木造NG・角部屋希望等。文字列またはnull）",
  "other_requests": "その他要望・備考（文字列またはnull）"
}

JSONのみ返してください。説明文・コードブロック・マークダウンは一切不要です。`;

// エリアテキストから area_mode を推定（駅が1つでも含まれれば 'station'）
// classify-area-modes cron と同じ分類ロジック。条件更新時に即時反映するために使用。
async function inferAreaMode(db: ReturnType<typeof getDb>, rawArea: string): Promise<'station' | 'ward' | 'auto'> {
  const PFX_RE = /^(?:阪急|阪神|南海|近鉄|JR|京阪|大阪メトロ|地下鉄)/;
  const tokens = rawArea
    .split(/[,、・\/\s　]+|又は|もしくは|など/)
    .map(t => t.replace(/駅$|周辺$|付近$|近く$|近辺$|沿線$|エリア$|あたり$/, "").trim())
    .filter(t => t.length >= 2 && !/^[0-9０-９]/.test(t) && !t.endsWith("線"));
  if (tokens.length === 0) return 'auto';

  const { data: lsRows } = await db.from("line_stations").select("station_name");
  const stationNames = new Set<string>((lsRows ?? []).map((r: { station_name: string }) => r.station_name));

  function isStation(token: string): boolean {
    const variants = [token, token.replace(/[町村]$/, ""), token.replace(PFX_RE, ""), token.replace(PFX_RE, "").replace(/[町村]$/, "")];
    return variants.some(v => stationNames.has(v));
  }
  function isRegion(token: string): boolean {
    return /[市区郡]/.test(token) || /(?:市内|府内|県内|都内)$/.test(token);
  }

  const stCount = tokens.filter(t => isStation(t)).length;
  const rgCount = tokens.filter(t => isRegion(t)).length;
  if (stCount > 0) return 'station';
  if (rgCount > 0) return 'ward';
  return 'auto';
}

async function autoParseFormat(db: ReturnType<typeof getDb>, userId: string, convId: string, text: string, account: AccountConfig) {
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

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 30_000,
    maxRetries: 1,
    defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
  });

  // ── Step 1: Haiku で分類（フォーマット知識＋会話文脈を使用） ────────
  // Sonnet 5 を呼ぶ前に「本当に条件メッセージか」を確認し、無関係なら早期リターン（コスト削減）
  const { data: recentMsgs } = await db
    .from("messages")
    .select("sender, text")
    .eq("conversation_id", convId)
    .not("text", "is", null)
    .order("created_at", { ascending: false })
    .limit(6);
  const recentContext = (recentMsgs ?? [])
    .reverse()
    .filter((m): m is { sender: string; text: string } => typeof m.text === "string");
  const classification = await classifyConditionMessage(anthropic, text, recentContext);
  if (classification.type === "not_condition" || classification.confidence < 0.6) {
    console.log(`[autoParseFormat] skip: type=${classification.type} confidence=${classification.confidence}`);
    return;
  }
  const isFormalFormat = classification.type === "formal_format";

  // ── Step 2: Sonnet 5 でフィールド抽出 ──────────────────────────────
  // URLを除去してからClaudeに渡す（物件サイトURLパラメータの誤解釈防止）
  const cleanText = text.replace(/https?:\/\/[^\s]+/g, "[URL省略]").trim();
  let parsed: Record<string, unknown>;
  try {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      // Sonnet 5 は thinking 省略時に adaptive がデフォルトON → max_tokens 1024 を食い潰すため明示的に無効化
      thinking: { type: "disabled" },
      // prompt cache: 静的な解析指示は system でキャッシュし、動的テキストのみ user に渡す
      system: [
        { type: "text", text: PARSE_FORMAT_SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [{
        role: "user",
        content: `テキスト:\n${cleanText}`,
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

  // isFormalFormat は Step 1 の AI 分類結果を使用（丸数字カウントは廃止）

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
  for (const f of ["move_in_time", "rent_min", "rent_max", "desired_area", "walk_minutes", "commute_station", "commute_minutes", "floor_plan", "initial_cost_limit", "building_age", "floor_area_min", "preferences", "ng_points", "other_requests"]) {
    if (parsed[f] !== null && parsed[f] !== undefined) parsedFields[f] = parsed[f];
  }
  // 正式フォーマット受信時は新着要望バナーに通知エントリを追加（スタッフへの物件検索通知）
  // ※ null クリアではなく "format" パターンエントリを書き込み → フロントがバナー表示
  if (isFormalFormat) {
    parsedFields.additional_conditions = `[${getJSTTimestamp()}|format] 正式条件フォーマット受信 → 物件を検索してください`;
    // 条件が新しくなるため拡張ツールの更新日制約をリセット（新条件で全件検索できるよう）
    parsedFields.last_property_sent_at = null;
    parsedFields.rp_update_days = null;
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
    .select("id, customer_name, desired_area, floor_plan, rent_min, rent_max, walk_minutes, commute_station, commute_minutes, move_in_time, building_age, floor_area_min, initial_cost_limit, preferences, ng_points, other_requests")
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
    // auto エントリ（ブレイン自動反映済み）→ バナーに表示するが確認のみ・アクションボタンなし
    const newEntry = `[${getJSTTimestamp()}|auto] ${note}`;
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
      // エリア条件が含まれている場合は area_mode を即時推定・更新
      if (parsedFields.desired_area) {
        const _area = parsedFields.desired_area as string;
        const _cid = customerId;
        after(async () => {
          const mode = await inferAreaMode(db, _area);
          if (mode !== 'auto') {
            await db.from("property_customers").update({ area_mode: mode }).eq("id", _cid);
            console.log(`[inferAreaMode] Path-A: ${_area} → ${mode}`);
          }
        });
      }
    } else {
      // カジュアル更新 → インテント分類 → スマートマージ（「追加」「除外」「変更」を正しく処理）
      const { mergedConds, intent } = await computeCasualUpdate(existing as Record<string, unknown>);
      await db.from("property_customers")
        .update({ ...baseFields, ...mergedConds, customer_name: resolvedName, last_property_sent_at: null, rp_update_days: null })
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
        .select("desired_area, floor_plan, rent_min, rent_max, walk_minutes, commute_station, commute_minutes, move_in_time, building_age, floor_area_min, initial_cost_limit, preferences, ng_points, other_requests")
        .eq("id", linkedId)
        .maybeSingle();
      const { mergedConds, intent } = await computeCasualUpdate(linkedConds as Record<string, unknown> | null);
      await db.from("property_customers")
        .update({ ...baseFields, ...mergedConds, line_user_id: userId, customer_name: resolvedName, last_property_sent_at: null, rp_update_days: null })
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

// フリーテキスト条件（preferences / ng_points / other_requests）のマージ保存用ヘルパー。
// 既存値を上書きせず「・」区切りで重複排除しつつ結合する。
function mergeFreeText(existing: string | null | undefined, extracted: string | null | undefined): string | null {
  if (!extracted?.trim()) return existing ?? null;
  if (!existing?.trim()) return extracted;
  const existingItems = existing.split(/[・\n,]/).map(s => s.trim()).filter(Boolean);
  const newItems = extracted.split(/[・\n,]/).map(s => s.trim()).filter(Boolean);
  const merged = [...new Set([...existingItems, ...newItems])];
  return merged.join("・");
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
  // 顧客テキスト側の最低限フィルタ（完全に無関係なメッセージを除外してAPI節約）
  if (/^https?:\/\/\S+$/.test(customerText.trim())) return; // URLのみは対象外
  if (isPropertySiteUrl(customerText)) return; // 物件サイトURL含む → 物件シェアであり条件更新ではない
  if (customerText.length < 3) return;

  // スタッフの直近3件を取得（1件だけだと「ご希望は？」の後に別メッセージが来たとき文脈を失う）
  const { data: recentStaffMsgs } = await db
    .from("messages")
    .select("text")
    .eq("conversation_id", convId)
    .eq("sender", "staff")
    .not("text", "is", null)
    .order("created_at", { ascending: false })
    .limit(3);

  const staffTexts = (recentStaffMsgs ?? []).map((m) => (m.text as string).slice(0, 200));
  if (staffTexts.length === 0) return;
  const combinedStaffText = staffTexts.join(" ");

  // スタッフメッセージ群が条件ヒアリング文脈かを確認
  const hasStrongCondSignal = /ご希望|希望エリア|希望間取り|希望家賃|ご予算|入居時期|初期費用|こだわり|徒歩.*何分|何分.*徒歩|築年数|通勤|電車.*駅|.*駅まで.*分/.test(combinedStaffText);
  const hasMedCondSignal = /エリア|間取り|家賃|予算|入居/.test(combinedStaffText);
  const isViewingContext = /内覧|集合場所|ご案内.*場所|案内.*場所/.test(combinedStaffText);
  const isConditionContext = (hasStrongCondSignal || hasMedCondSignal) && !isViewingContext;
  // 顧客メッセージ自体に条件語彙が含まれる場合もOR発火（内覧調整中等に漏れる条件を拾う）
  const customerMentionsCondition = CUSTOMER_CONDITION_VOCAB_RE.test(customerText || "");
  if (!isConditionContext && !customerMentionsCondition) return;

  // Haiku で「本当に条件メッセージか」を分類（フォーマット知識＋文脈利用）
  const anthropicP4 = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 15_000,
    maxRetries: 1,
    defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
  });
  const recentContext = staffTexts.reverse().map((t) => ({ sender: "staff" as const, text: t }));
  const p4Class = await classifyConditionMessage(anthropicP4, customerText, recentContext);
  if (p4Class.type === "not_condition" || p4Class.confidence < 0.6) {
    console.log(`[P4] skip: type=${p4Class.type} confidence=${p4Class.confidence}`);
    return;
  }

  // conversations から property_customer_id を取得
  const { data: conv } = await db
    .from("conversations")
    .select("property_customer_id")
    .eq("id", convId)
    .maybeSingle();
  const pcId = conv?.property_customer_id as string | null;
  if (!pcId) return; // 紐付けなし → スキップ

  let extracted: Record<string, unknown>;
  try {
    const staffContext = staffTexts.slice().reverse().map((t, i) => `[スタッフ発言${i + 1}] ${t}`).join("\n");
    const res = await anthropicP4.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: "あなたは不動産営業アシスタントです。JSONのみで回答してください。",
      messages: [{
        role: "user",
        content: `お客さんの返信から物件希望条件を抽出してください。

【スタッフの直近メッセージ（文脈）】
${staffContext}

【今回のお客さんの返信】
${customerText.slice(0, 600)}

【金額の文脈判断ルール（最重要）】
お客さんが「〇万円以内でお願いします」のように金額のみ言った場合、スタッフの質問から何の金額か判断すること:
● スタッフが「家賃」「賃料」「月々」「毎月」について聞いていた → rent_max
● スタッフが「初期費用」「初期コスト」「敷金」「礼金」「引越し」について聞いていた → initial_cost_limit
● 文脈不明な場合は金額の大きさで推測:
  - 〜19万円 → 家賃（rent_max）の可能性が高い
  - 20万円以上 → 初期費用（initial_cost_limit）の可能性が高い

【徒歩 vs 通勤の区別（重要）】
「最寄り駅まで徒歩○分」「駅から歩いて○分」など歩行時間 → walk_minutes（整数）
「○○駅まで電車で○分」「○○まで○分以内で行きたい」など通勤先への電車時間 → commute_station + commute_minutes
例: 「なんばまで電車30分以内で行けるところ」→ commute_station: "難波駅", commute_minutes: 30

【エリアと駅名の扱い】
エリア名（梅田周辺等）と駅名（梅田駅・塚本駅等）が両方ある場合、両方まとめて desired_area に入れる。

【こだわり・NG条件の優先度タグ（preferences / ng_points）】
絶対に譲れない条件には[必須]、あれば嬉しい条件には[希望]タグを付けること。
例: 風呂トイレ別[必須]・オートロック[希望]。顧客の言い方（「絶対」「〜じゃないと無理」→[必須]、「できれば」「あったら嬉しい」→[希望]）から判定。判断できない場合はタグなし。

読み取れた条件のみ以下の形式で返してください（不明な項目は省略してください）。
※お客さんの返信に明示された条件のみ。スタッフのメッセージに含まれる数字・条件は絶対に抽出しないこと。
金額はすべて円単位の整数（「8万」→80000、「8万円」→80000）。
{
  "desired_area": "希望エリア・駅名",
  "floor_plan": "間取り（例: 1LDK）",
  "rent_max": 最高家賃（円・整数）,
  "rent_min": 最低家賃（円・整数）,
  "walk_minutes": 最寄り駅まで徒歩分数（整数）,
  "commute_station": "通勤先駅名（例: 難波駅）",
  "commute_minutes": 通勤先まで電車での所要分数（整数）,
  "move_in_time": "入居時期（例: 9月、来月）",
  "building_age": 築年数上限（整数）,
  "initial_cost_limit": 初期費用上限（円・整数）,
  "preferences": "こだわり条件（例: オートロック[希望]・独立洗面・ペット可[必須]）",
  "ng_points": "NG条件（例: 1階NG[必須]・木造NG[希望]）",
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

  // C1: 非 null・非空 フィールドのみ UPDATE 対象にする
  const CONDITION_FIELDS = [
    "desired_area", "floor_plan", "rent_max", "rent_min",
    "walk_minutes", "commute_station", "commute_minutes",
    "move_in_time", "building_age", "initial_cost_limit",
    "preferences", "ng_points", "other_requests",
  ];

  // 型検証: 数値カラムに文字列が入るとUPDATE全体が失敗するため number 以外は破棄
  const NUMERIC_FIELDS = new Set(["rent_max", "rent_min", "walk_minutes", "commute_minutes", "building_age", "initial_cost_limit"]);
  for (const f of NUMERIC_FIELDS) {
    if (extracted[f] !== undefined && typeof extracted[f] !== "number") delete extracted[f];
  }

  // after() C（resolve-area正規化）と競合するため、エリア指定メッセージでは desired_area を書かない
  if (isAreaSpecificationMessage(customerText)) delete extracted.desired_area;

  const { data: existingPc } = await db
    .from("property_customers")
    .select(["desired_area", "floor_plan", "rent_max", "rent_min", "walk_minutes", "commute_station", "commute_minutes", "move_in_time", "building_age", "initial_cost_limit", "preferences", "ng_points", "other_requests"].join(","))
    .eq("id", pcId)
    .maybeSingle();

  // desired_area: インテント分類してマージ（「〜区もお願い」等の追加要求で既存エリアを上書きしない）
  const existingPcRec = existingPc as unknown as Record<string, unknown> | null;
  if (extracted.desired_area && existingPcRec?.desired_area) {
    const existingArea = (existingPcRec.desired_area ?? "") as string;
    const intentRes = classifyByKeywords(customerText, existingArea)
      ?? await classifyByAI(anthropicP4, customerText, existingArea);
    if (intentRes.intent === "ADD") {
      const newAreas = (extracted.desired_area as string)
        .split(/[・、,]+/)
        .map((s: string) => s.trim())
        .filter((a: string) => a && !existingArea.includes(a));
      extracted.desired_area = newAreas.length
        ? `${existingArea}・${newAreas.join("・")}`
        : existingArea;
    }
  }

  const FIELD_LABELS: Record<string, string> = {
    desired_area: "エリア", floor_plan: "間取り", rent_max: "家賃上限", rent_min: "家賃下限",
    walk_minutes: "徒歩分数", commute_station: "通勤先駅", commute_minutes: "通勤時間",
    move_in_time: "入居時期", building_age: "築年数",
    initial_cost_limit: "初期費用上限", preferences: "こだわり", ng_points: "NG条件", other_requests: "その他",
  };

  // フリーテキスト3カラムは上書きではなくマージ保存（「ペット可・2階以上」→新抽出「オートロック」で消える問題の防止）
  const FREE_TEXT_FIELDS = new Set(["preferences", "ng_points", "other_requests"]);

  const updates: Record<string, unknown> = {};
  const changedFields: Record<string, unknown> = {}; // 実際に値が変わるフィールド（バナー表示用）
  for (const f of CONDITION_FIELDS) {
    const v = extracted[f];
    if (v === null || v === undefined || v === "") continue;
    const existingVal = (existingPc as Record<string, unknown> | null)?.[f];
    if (FREE_TEXT_FIELDS.has(f)) {
      const merged = mergeFreeText(existingVal as string | null | undefined, typeof v === "string" ? v : String(v));
      if (merged === null) continue;
      updates[f] = merged;
      // マージ結果が既存値と変わる場合のみバナー対象（新規項目の追加があったケース）
      if (existingVal !== merged) changedFields[f] = merged;
      continue;
    }
    updates[f] = v;
    // 値が変わる場合のみ changedFields に追加（同じ値の上書きはバナー不要）
    if (existingVal !== v) changedFields[f] = v;
  }

  if (Object.keys(updates).length === 0) return; // 抽出条件なし → スキップ

  const { error: updateErr } = await db
    .from("property_customers")
    .update({ ...updates, updated_at: new Date().toISOString(), last_property_sent_at: null, rp_update_days: null })
    .eq("id", pcId);

  if (updateErr) {
    console.warn("[line-webhook] P4 property_customers update failed:", updateErr.message);
  } else {
    // desired_area が更新された場合は area_mode を即時推定・上書き
    if (updates.desired_area) {
      const mode = await inferAreaMode(db, updates.desired_area as string);
      if (mode !== 'auto') {
        await db.from("property_customers").update({ area_mode: mode }).eq("id", pcId);
        console.log(`[inferAreaMode] Path-B: ${updates.desired_area} → ${mode}`);
      }
    }
    console.log(`[line-webhook] P4 条件抽出: conv=${convId} fields=${Object.keys(updates).join(",")}`);
    void recordConditionHistory(db, pcId, existingPc as Record<string, unknown> | null, updates)
      .catch((e) => console.warn("[condition-history] P4:", e));

    // 変更があった場合のみ新着要望バナーにPENDINGエントリを追加（スタッフへの物件再検索通知）
    if (Object.keys(changedFields).length > 0) {
      const noteText = Object.entries(changedFields)
        .map(([k, v]) => `${FIELD_LABELS[k] ?? k}: ${v}`)
        .join("、");
      const pendingEntry = `[${getJSTTimestamp()}|auto] ${noteText}`;
      const { data: cur } = await db.from("property_customers")
        .select("additional_conditions").eq("id", pcId).maybeSingle();
      const prev = (cur?.additional_conditions as string | null) ?? "";
      await db.from("property_customers")
        .update({ additional_conditions: prev ? `${prev}\n${pendingEntry}` : pendingEntry })
        .eq("id", pcId);
    }
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
      realpro?: { station_names?: string[]; city_codes?: string[] };
      itandi?: { station_names?: string[]; ward_names?: string[] };
      normalized_area?: string | null;
    };
    // 駅名（realpro/itandi） + 区名（ward_names）を dedup して統合
    const stationNames = [
      ...(areaJson.realpro?.station_names ?? []),
      ...(areaJson.itandi?.station_names ?? []),
    ];
    const wardNames = areaJson.itandi?.ward_names ?? [];
    const extractedAreas: string[] = [...new Set([...stationNames, ...wardNames])];
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
    // エリアが更新されたので area_mode を即時推定・上書き
    {
      const mode = await inferAreaMode(db, merged);
      if (mode !== 'auto') {
        await db.from("property_customers").update({ area_mode: mode }).eq("id", pc.id as string);
        console.log(`[inferAreaMode] Path-C: ${merged} → ${mode}`);
      }
    }

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

  // FIX: stale __SHOWN__ 残留対策（テキスト経路と同一。画像経路には after() B の ai_draft リセットが
  // 存在しないため、ここでクリアしないと brain-sweep が永久に補填しない）
  await db
    .from("conversations")
    .update({ ai_draft: null })
    .eq("id", convId)
    .eq("ai_draft", "__SHOWN__");

  // 顧客返信（画像）→ pending property_check タスクを自動キャンセル（テキスト経路と同一理由）
  await db
    .from("line_tasks")
    .update({ status: "cancelled" })
    .eq("conversation_id", convId)
    .eq("task_type", "property_check")
    .eq("status", "pending");

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

// ── テキスト・画像の両方が揃ったら applying に昇格する共通ヘルパー ──────────
// applying_text_received（申込フォームテキスト受信済み）と
// applying_image_received（申込書依頼後の顧客画像受信済み）が両方 true のときのみ昇格する。
// どちらか片方だけでは applying にならない（誤昇格バグ修正 2026-08-20）。
async function tryPromoteToApplying(
  db: ReturnType<typeof getDb>,
  convId: string,
  now: string,
  trigger: string,
): Promise<void> {
  const { data: conv } = await db
    .from("conversations")
    .select("status, applying_text_received, applying_image_received")
    .eq("id", convId)
    .maybeSingle();
  if (!conv) return;
  const status = (conv.status as string) ?? "";
  if (!PRE_APPLY_STATUSES.includes(status)) return; // 既にapplying以降
  if (!conv.applying_text_received || !conv.applying_image_received) return; // 片方未受信

  const { data: updated, error } = await db
    .from("conversations")
    .update({ status: "applying", updated_at: now })
    .eq("id", convId)
    .in("status", PRE_APPLY_STATUSES)
    .select("id");
  if (error) {
    console.error(`[line-webhook] applying昇格失敗: conv=${convId}`, error.message);
  } else if ((updated ?? []).length > 0) {
    console.log(`[line-webhook] テキスト+画像両方揃い → applying自動昇格: conv=${convId} trigger=${trigger}`);
    void (async () => {
      const { error: stageErr } = await db.from("conversation_stage_history").insert({
        conversation_id: convId,
        from_status: status,
        to_status: "applying",
        trigger: "customer_message",
      });
      if (stageErr) console.warn("[stage_history] applying:", stageErr.message);
    })();
  }
}

// ── 申込書依頼直後の顧客画像 → applying_image_received=true に更新 ──────────
// 条件: (1) 現ステータスが申込前 (2) 直近のスタッフメッセージに申込書依頼の文言がある
// テキストで検知できない画像フォーム（写真で送られた記入済み申込書）の遷移漏れを塞ぐ。
// applying_text_received も true なら tryPromoteToApplying で applying に昇格する。
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
      .update({ applying_image_received: true, updated_at: now })
      .eq("id", convId)
      .in("status", PRE_APPLY_STATUSES)
      .select("id");
    if (error) {
      console.error(`[line-webhook] applying_image_received更新失敗: conv=${convId}`, error.message);
    } else if ((updated ?? []).length > 0) {
      console.log(`[line-webhook] 申込書依頼後の画像受信 → applying_image_received=true: conv=${convId}`);
      await tryPromoteToApplying(db, convId, now, "image_form");
    }
  } catch (e) {
    console.warn("[line-webhook] autoPromoteApplyingOnFormImage:", e);
  }
}

// ── Claude Vision で画像内容を日本語テキスト抽出 + 画像種別分類 ─────────────
// buf: LINE Content API から取得済みの ArrayBuffer（二重ダウンロード不要）
// 既存のVision 1回呼び出しに分類を相乗りさせる（追加APIコストゼロ）
// imageType: 'estimate' | 'floor_plan' | 'property_photo' | 'id_document' | 'other'
async function extractImageContent(
  buf: ArrayBuffer,
  mimeType: string,
): Promise<{ imageType: string; content: string }> {
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
                text: "1行目に必ず「TYPE: estimate|floor_plan|property_photo|id_document|other」の形式で画像の種類を1つだけ出力してください。\n- estimate=見積書/初期費用明細, floor_plan=間取り図/物件資料, property_photo=室内外の物件写真,\n  id_document=本人確認書類（免許証・保険証・マイナンバー等）, other=それ以外（LINEスクショ含む）\n2行目以降に、この画像に写っているテキスト・会話・情報をすべて書き起こしてください。LINEスクリーンショットの場合は発言者と内容を整理して返してください。画像の説明は不要で、内容だけ返してください。",
              },
            ],
          },
        ],
      }),
    });
    if (!visionRes.ok) {
      console.warn("[line-webhook] Vision API失敗 status=", visionRes.status);
      return { imageType: "", content: "" };
    }
    const visionData = await visionRes.json() as {
      content?: Array<{ type: string; text?: string }>;
    };
    const raw = visionData.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
    const typeMatch = raw.match(/^TYPE:\s*(estimate|floor_plan|property_photo|id_document|other)/i);
    const imageType = typeMatch ? typeMatch[1].toLowerCase() : (raw ? "other" : "");
    const content = raw.replace(/^TYPE:[^\n]*\n?/, "").trim();
    return { imageType, content };
  } catch (e) {
    console.warn("[line-webhook] Vision抽出エラー:", e);
    return { imageType: "", content: "" };
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
    const extracted = visionResult.status === "fulfilled" ? visionResult.value.content : "";
    const extractedType = visionResult.status === "fulfilled" ? visionResult.value.imageType : "";
    const newText = extracted ? `[画像] ${extracted}` : "[画像]";

    // image_type: Vision失敗時はNULLのまま（"other"を書かない — 後日バックフィル可能に）
    const { error: updateErr } = await db
      .from("messages")
      .update({
        image_url: urlData.publicUrl,
        text: newText,
        ...(extractedType ? { image_type: extractedType } : {}),
      })
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

  // 同一POSTバッチ内で同一ユーザーに対してafter() Bが複数登録されるのを防ぐ
  // （LINEが1回のPOSTに複数eventを詰めて送った場合の多重bg-asyncトリガー対策）
  const draftTriggeredUserIds = new Set<string>();

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
      // 同一POSTバッチ内で同一ユーザーに対してドラフトトリガーが複数発火するのを防ぐ
      // 1回目は通常通り実行、2回目以降はskipDraftTrigger=trueでafter() Bをスキップ
      const skipDraft = draftTriggeredUserIds.has(userId);
      draftTriggeredUserIds.add(userId);
      // sync-from-screeningより高速な直接経路で保存（line_message_idで重複防止）
      const ok = await handleTextMessage(userId, text, matchedAccount, lineMessageId, quotedMessageId, skipDraft);
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
      // skipDraftTrigger=true: スタンプでai_draft生成は不要（連打で多重生成が起きるのを防ぐ）
      const lineMessageId = event.message?.id;
      const ok = await handleTextMessage(userId, "[スタンプ]", matchedAccount, lineMessageId, undefined, true);
      if (!ok) anyFailed = true;
      continue;
    } else {
      // 未対応msgType（video/audio/file等）: ブレイン誘導のみクリア（draft生成は不要）
      const db = getDb();
      const { data: conv } = await db
        .from("conversations")
        .select("id")
        .eq("line_user_id", userId)
        .eq("account", matchedAccount.key)
        .maybeSingle();
      if (conv?.id) {
        await db.from("conversations")
          .update({ suggested_aix_meta: null })
          .eq("id", conv.id as string);
        // FIX: stale __SHOWN__ 残留対策 — この経路は meta をクリアするだけで brain 再分析が走らず、
        // 補填は brain-sweep のみ。__SHOWN__ が残っていると sweep が誤スキップするためクリアする
        await db.from("conversations")
          .update({ ai_draft: null })
          .eq("id", conv.id as string)
          .eq("ai_draft", "__SHOWN__");
      }
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
