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
      status: "hearing",
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

  // LINEフォーマット自動検知・解析 → ステータスを物件提案中に自動昇格
  if (isFormatMessage(text)) {
    void (async () => {
      try { await autoParseFormat(db, userId, text, account); } catch {}
    })();
    // hearing/first_reply 状態なら proposing に自動昇格
    await db
      .from("conversations")
      .update({ status: "proposing" })
      .eq("id", convId)
      .in("status", ["hearing", "first_reply"]);
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
  if (condMatches >= 2) return true;
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

  // ── AI でフォーマット解析 ──────────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
  // 正式フォーマット時のみ全フィールドを上書き対象にする
  if (isFormalFormat) {
    for (const f of ["move_in_time", "rent_min", "rent_max", "desired_area", "walk_minutes", "floor_plan", "initial_cost_limit", "building_age", "floor_area_min", "preferences", "ng_points", "other_requests"]) {
      if (parsed[f] !== null && parsed[f] !== undefined) parsedFields[f] = parsed[f];
    }
    parsedFields.additional_conditions = null; // 正式フォーマット受信で新着要望をリセット
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
    .single();

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
    .single();

  let customerId: string;
  let isNewCustomer = false;

  // カジュアル更新時に additional_conditions へ追記するヘルパー
  const appendAdditionalConditions = async (pcId: string) => {
    const note = buildConditionNote(parsed);
    if (!note) return;
    const { data: cur } = await db.from("property_customers")
      .select("additional_conditions").eq("id", pcId).single();
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
      // カジュアル更新 → additional_conditions に追記のみ（元の条件は保持）
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
      await db.from("property_customers").update({ line_user_id: userId }).eq("id", customerId);
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
        .single();
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
    void notifyFormatReceived(db, resolvedName, parsedFields);
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
    .single();
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
  });

  if (!res.ok) {
    console.error("[notify] LINE push failed:", res.status, await res.text());
  }
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
  }).select("id").single();

  if (msgErr) {
    console.error("[line-webhook] image message保存失敗:", msgErr.message);
    return null;
  }

  await db
    .from("conversations")
    .update({ last_message: "[画像]", last_sender: "customer", updated_at: now })
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
      { headers: { Authorization: `Bearer ${account.token}` } },
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
    } else {
      console.log("[line-webhook] 画像保存完了:", lineMessageId);
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
  console.log(`[line-webhook] 画像上限超過: ${overflowIds.length}件を期限切れにしました`);
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
