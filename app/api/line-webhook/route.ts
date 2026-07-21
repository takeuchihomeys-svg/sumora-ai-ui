import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

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
    .update({ last_message: text, last_sender: "customer", updated_at: now })
    .eq("id", convId);

  updateProfileAsync(db, userId, convId, account, text, now);

  // 返信きたお客さんを自動で毎日物件出し（hot）に格上げ
  after(async () => {
    await autoUpgradeToHot(db, userId).catch((e) => console.warn("[line-webhook] autoUpgradeToHot:", e));
  });

  // LINEフォーマット自動検知・解析 → ステータスを物件提案中に自動昇格
  if (isFormatMessage(text)) {
    // hearing/first_reply 状態なら proposing に自動昇格
    await db
      .from("conversations")
      .update({ status: "proposing" })
      .eq("id", convId)
      .in("status", ["hearing", "first_reply"]);
  }

  // タスク自動検知（物件確認・物件出し）
  void autoDetectTask(db, convId, text);

  // 「確認しました」→ 物件確認済み自動マーク
  if (isPropertyViewedMessage(text)) {
    void autoMarkPropertyViewed(db, userId);
  }

  // バックグラウンドでAIX提案を先行計算してキャッシュ（Fix-1c）
  // derive SuggestedAix() が次回呼ばれたとき conversations.suggested_next_aix を即座に参照できる
  void (async () => {
    try {
      const _baseUrl = process.env.NEXT_PUBLIC_SITE_URL
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
      const res = await fetch(`${_baseUrl}/api/suggest-next-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: convId }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const data = await res.json() as { action?: string | null };
        if (data.action) {
          await db.from("conversations")
            .update({ suggested_next_aix: data.action })
            .eq("id", convId);
        }
      }
    } catch { /* サイレント失敗 — suggest-next-action が遅延しても webhook 応答に影響しない */ }
  })();

  // after() A: フォーマット解析（独立実行 — draft_pending_at更新と並列・30s Anthropicコールを含む）
  if (isFormatMessage(text)) {
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

      // ai_summary 自動更新（fire-and-forget）
      if (pcId) {
        fetch(`${baseUrl}/api/customer-summary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customer_id: pcId, conversation_id: convId, fetch_from_db: true }),
        }).catch(() => {});
      }

      // 申込以降ステータスはai_draft生成不要（bg-async/cronのSKIP_STATUSESと一致させること）
      if (["applying", "application", "screening", "contract", "closed_won", "closed_lost"].includes(convStatus)) return;

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

  return true;
}

async function autoUpgradeToHot(db: ReturnType<typeof getDb>, userId: string) {
  const { data } = await db
    .from("property_customers")
    .select("id, status, customer_name")
    .eq("line_user_id", userId)
    .in("status", ["new_inquiry", "property_search"])
    .limit(1)
    .maybeSingle();
  if (data?.id) {
    const now = new Date().toISOString();
    await Promise.all([
      db.from("property_customers")
        .update({ status: "hot", updated_at: now })
        .eq("id", data.id),
      // 会話一覧の🔥マークも連動して更新
      db.from("conversations")
        .update({ is_hot: true, updated_at: now })
        .eq("line_user_id", userId)
        .eq("is_hot", false),
    ]);
    notifyHanbancyoGroup(db, data.customer_name ?? "").catch((e) => console.warn("[line-webhook] autoUpgradeToHot notify:", e));
  }
}

function isFormatMessage(text: string): boolean {
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

  // 変更意図を示すフレーズ
  const changeKeywords = [
    "変えたい", "変更", "に変えて", "に変更", "にしたい", "にしてほしい",
    "やっぱり", "修正", "更新", "に変わ", "に移", "広げ", "せばめ",
    "上げ", "下げ", "にしようかな", "検討",
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

// JST タイムスタンプ（新着要望のログに使用）
function getJSTTimestamp(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
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
  let parsed: Record<string, unknown>;
  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
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
  const parsedFields: Record<string, unknown> = {
    format_received: true,
    raw_format_text: text,
    updated_at: new Date().toISOString(),
  };
  // 常に解析した条件フィールドを保存（カジュアル更新でも条件タグに反映する）
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

  // ── property_customers を line_user_id で検索 ─────────────────────
  const { data: existing } = await db
    .from("property_customers")
    .select("id, customer_name")
    .eq("line_user_id", userId)
    .limit(1)
    .maybeSingle();

  let customerId: string;
  let isNewCustomer = false;

  // カジュアル更新時に additional_conditions へ追記するヘルパー
  const appendAdditionalConditions = async (pcId: string) => {
    const note = buildConditionNote(parsed);
    if (!note) return;
    const { data: cur } = await db.from("property_customers")
      .select("additional_conditions").eq("id", pcId).maybeSingle();
    const prev = (cur?.additional_conditions as string | null) ?? "";
    const newEntry = `[${getJSTTimestamp()}] ${note}`;
    await db.from("property_customers")
      .update({ additional_conditions: prev ? `${prev}\n${newEntry}` : newEntry, updated_at: new Date().toISOString() })
      .eq("id", pcId);
  };

  if (existing?.id) {
    customerId = existing.id as string;
    if (isFormalFormat) {
      // 正式フォーマット → 全フィールド上書き（additional_conditions もリセット）
      await db.from("property_customers")
        .update({ ...parsedFields, customer_name: resolvedName })
        .eq("id", customerId);
    } else {
      // カジュアル更新 → 条件フィールドも更新 + additional_conditions に追記（元の条件は上書きしない空フィールドのみ更新）
      await db.from("property_customers")
        .update({ ...parsedFields, customer_name: resolvedName })
        .eq("id", customerId);
      await appendAdditionalConditions(customerId);
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
      // カジュアル更新 → 条件フィールドも更新
      await db.from("property_customers")
        .update({ ...parsedFields, line_user_id: userId, customer_name: resolvedName })
        .eq("id", customerId);
      await appendAdditionalConditions(customerId);
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

async function notifyHanbancyoGroup(db: ReturnType<typeof getDb>, customerName: string) {
  const { data } = await db
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "group_id")
    .maybeSingle();
  const groupId = data?.value as string | undefined;
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN;
  if (!groupId || !token) return;

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: groupId,
        messages: [{
          type: "text",
          text: `🔥 ${customerName}さんから返信きた！！\n今が熱いからとことん詰める！！`,
        }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("[notifyHanbancyoGroup] LINE push failed:", res.status, await res.text());
    }
  } catch (e) {
    console.warn("[notifyHanbancyoGroup] push failed:", e);
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
    .update({ last_message: "[画像]", last_sender: "customer", updated_at: now, is_flagged: true })
    .eq("id", convId);

  // 会話内の画像が100枚を超えたら古い画像の保存期限を即時終了
  void expireOldImagesIfOverLimit(db, convId);

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
      { headers: { Authorization: `Bearer ${account.token}` }, signal: AbortSignal.timeout(10_000) },
    );

    if (!contentRes.ok) {
      console.warn(`[line-webhook] Content API失敗 status=${contentRes.status} msgId=${lineMessageId}`);
      return;
    }

    const contentType = contentRes.headers.get("content-type") || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : contentType.includes("gif") ? "gif" : "jpg";

    const blob = new Blob([await contentRes.arrayBuffer()], { type: contentType });
    const storagePath = `${lineMessageId}.${ext}`;

    const { error: uploadErr } = await db.storage
      .from("line-images")
      .upload(storagePath, blob, { contentType, upsert: true });

    if (uploadErr) {
      console.error("[line-webhook] Storage upload失敗:", uploadErr.message, "msgId:", lineMessageId);
      return;
    }

    const { data: urlData } = db.storage
      .from("line-images")
      .getPublicUrl(storagePath);

    const { error: updateErr } = await db.from("messages")
      .update({ image_url: urlData.publicUrl })
      .eq("id", msgId);

    if (updateErr) {
      console.error("[line-webhook] image_url更新失敗:", updateErr.message);
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
    .eq("text", "[画像]")
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
          if (unsentText.trim() && unsentText !== "[画像]") {
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

  // 保存失敗時は500を返してLINEにリトライさせる（line_message_id UNIQUE制約で重複保存は防止済み）
  if (anyFailed) {
    return NextResponse.json({ error: "message save failed, will retry" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
