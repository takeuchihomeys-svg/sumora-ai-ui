import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { SMORA_COMMON_RULES, AIX_PROPERTY_RECOMMENDATION_RULES, AIX_PROPERTY_SEND_RULES, GENERATION_SYSTEM } from "@/app/lib/line-reply-prompts";
import { fetchPromptRules } from "@/app/lib/prompt-rules";

export const maxDuration = 60;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const MODEL = "claude-sonnet-4-6";

// 退去予定日が過去かどうか判定（「7月下旬」「2026年7月15日」等の日本語表記対応）
function isPastVacancyDate(dateStr: string): boolean {
  if (!dateStr) return false;
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const currentYear = jstNow.getUTCFullYear();
  const currentMonth = jstNow.getUTCMonth(); // 0-indexed
  const currentDay = jstNow.getUTCDate();
  const yearMatch = dateStr.match(/(\d{4})年/);
  const year = yearMatch ? parseInt(yearMatch[1]) : currentYear;
  const monthMatch = dateStr.match(/(\d+)月/);
  if (!monthMatch) return false;
  const month = parseInt(monthMatch[1]) - 1; // 0-indexed
  if (year < currentYear) return true;
  if (year > currentYear) return false;
  // 年跨ぎ補正: 年の記載がなく月差が-6以下（例: 12月に「1月末」）は翌年扱い → 過去とみなさない
  if (!yearMatch && month - currentMonth <= -6) return false;
  if (month < currentMonth) return true;
  if (month > currentMonth) return false;
  // 同月: 日付・旬で判定
  const dayMatch = dateStr.match(/(\d+)日/);
  if (dayMatch) return parseInt(dayMatch[1]) < currentDay;
  if (dateStr.includes("初旬") || dateStr.includes("上旬")) return currentDay > 10;
  if (dateStr.includes("中旬")) return currentDay > 20;
  return false; // 下旬・不明は過去とみなさない
}

// 挨拶時間ルール（全アクション共通ヘルパー・#19）
// ・21時以降 または 早朝5時以前にスタッフからプロアクティブに連絡する場合は「夜分遅くに失礼致します」
// ・お客様から連絡が来た返信場面（customerInitiated=true）では時間帯に関わらず通常挨拶
// ・初回（isFirstEverReply）→「ご連絡頂きありがとうございます😊！！」
// ・今日すでにスタッフが送信済み（staffMessagedToday）→「お待たせ致しました！！」
function buildGreeting(
  jstHour: number,
  isFirstEverReply: boolean,
  staffMessagedToday: boolean,
  customerInitiated: boolean
): string {
  if (isFirstEverReply) return "ご連絡頂きありがとうございます😊！！";
  if (!customerInitiated && (jstHour >= 21 || jstHour <= 5)) return "夜分遅くに失礼致します！！";
  if (staffMessagedToday) return "お待たせ致しました！！";
  return "お世話になっております！！";
}

function extractPreferredName(
  messages: Array<{ sender: string; text?: string | null }>,
  lineDisplayName: string
): string {
  const SKIP_RE = /^(お客様|皆|全|各|担当|スタッフ|こちら|弊社|管理|オーナー|業者|まずは|引き続き|何卒|改めて)/;
  for (const msg of [...messages].reverse()) {
    if (msg.sender !== "staff" || !msg.text) continue;
    const matches = [...msg.text.matchAll(/([^\s、。！？\n【】「」（）・]{2,8}?)さん/g)];
    for (const m of [...matches].reverse()) {
      const name = m[1];
      if (SKIP_RE.test(name)) continue;
      // 1文字はスキップ
      if (name.length <= 1) continue;
      // 日本語文字と英字が混在する場合はスキップ（「方でHitomi」等の誤マッチ防止）
      const hasJp = /[ぁ-んァ-ン一-鿿]/.test(name);
      const hasLatin = /[a-zA-Z]/.test(name);
      if (hasJp && hasLatin) continue;
      return name;
    }
  }
  // 1文字のみは頭文字の可能性があるのでスキップ（英字2文字以上はYUMAなど実名として使う）
  if (lineDisplayName.length <= 1) return "";
  return lineDisplayName;
}

async function getPhrases(category: string, customerName?: string): Promise<string> {
  const { data } = await supabase
    .from("phrase_dictionary")
    .select("phrase")
    .eq("category", category)
    .order("priority", { ascending: false })
    .limit(15);
  const fallback = customerName || "お客様";
  return (data || []).map((r: { phrase: string }) =>
    `- ${r.phrase.replace(/\{\{customer_name\}\}/g, fallback)}`
  ).join("\n");
}

// 物件オススメの実例（☆つき）を取得してAIの参考文として返す
async function getPropertyExamples(): Promise<string> {
  const { data } = await supabase
    .from("ai_reply_examples")
    .select("sent_reply")
    .in("conversation_state", ["property_recommendation", "proposing"])
    .eq("is_starred", true)
    .order("created_at", { ascending: false })
    .limit(20);
  if (!data || data.length === 0) return "";
  return (data as { sent_reply: string }[])
    .map((r, i) => `【実例${i + 1}】\n${r.sent_reply}`)
    .join("\n\n---\n\n");
}

// aix_settings からシステムプロンプトを取得（なければデフォルト）
async function getAixSystemPrompt(key: string, defaultValue: string): Promise<string> {
  const { data } = await supabase
    .from("aix_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? defaultValue;
}

// 物件オススメ関連のknowledgeを取得（差分学習ルール優先）
async function getPropertyKnowledge(): Promise<string> {
  const [{ data: diffLearned }, { data: stateKnowledge }] = await Promise.all([
    // ① 差分学習ルール（最優先）
    supabase.from("ai_reply_knowledge")
      .select("id, title, content")
      .ilike("title", "%差分学習%")
      .gte("importance", 7)
      .in("conversation_state", ["property_recommendation", "proposing"])
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(15),
    // ② フェーズ別ナレッジ
    supabase.from("ai_reply_knowledge")
      .select("id, category, title, content")
      .in("conversation_state", ["property_recommendation", "proposing"])
      .gte("importance", 7)
      .not("title", "ilike", "%差分学習%")
      .order("importance", { ascending: false })
      .limit(12),
  ]);
  // 使用追跡（fire-and-forget）
  const usedIds = [...(diffLearned ?? []), ...(stateKnowledge ?? [])].map(r => (r as { id: string }).id).filter(Boolean);
  if (usedIds.length) {
    supabase.rpc("increment_knowledge_used_count", { p_ids: usedIds }).then(() => {}, () => {});
  }
  const parts: string[] = [];
  if ((diffLearned?.length ?? 0) > 0)
    parts.push("【🔴 過去の修正パターン（必ず守る）】\n" + diffLearned!.map(r => `・${r.title}: ${r.content}`).join("\n"));
  if ((stateKnowledge?.length ?? 0) > 0)
    parts.push("【物件オススメのノウハウ】\n" + (stateKnowledge as { id: string; category: string; title: string; content: string }[]).map(r => `・${r.content}`).join("\n"));
  return parts.join("\n\n");
}

// アクション → 学習ルール検索対象の conversation_state マッピング
// AixModal.tsx の ACTION_TO_STATE（保存側）と対応させること（保存されたstateを検索できないとループが閉じない）
const AIX_ACTION_TO_STATES: Record<string, string[]> = {
  property_send: ["property_send", "proposing"],
  viewing_invite: ["viewing_invite", "viewing", "inspection", "viewing_schedule"],
  acknowledge_check: ["acknowledge_check", "hearing", "proposing"],
  followup_revive: ["followup_revive", "hearing", "proposing"],
  application_push: ["application_push", "applying", "application", "screening", "contract"],
  condition_hearing: ["condition_hearing", "hearing"],
  estimate_sheet: ["estimate_sheet", "estimate_request"],
  meeting_place: ["meeting_place", "viewing"],
  // AixModal保存側は property_check_result → "proposing" で保存するため proposing を必ず含める
  // MED-01修正: サブステート別学習ルールも検索対象に追加（generate-reply の STATE_SEARCH_ALIASES.proposing と対称化）
  property_check_result: [
    "property_check_result", "proposing",
    "property_check_result_available", "property_check_result_unavailable", "property_check_result_alternative",
  ],
  greeting_viewing: ["greeting_viewing", "viewing"],
  // ※ property_recommendation は getPropertyKnowledge() 内で同等の差分学習ルール取得済み（states: property_recommendation/proposing）
};

// 学習済みナレッジを対象stateから取得する汎用関数
// ① 差分学習ルール ② pattern/principle/phrase ③ スタッフがAIX生成文を編集した実例（リアルタイム）
// 「修正→学習→改善」ループの出口。各アクションのsystemプロンプト末尾に注入して使う
// F04: customerMsg を追加し、OPENAI_API_KEY がある場合は pgvector で顧客メッセージに関連するルールを文脈絞り込み
async function getKnowledgeForState(states: string[], actionType?: string, conversationId?: string, customerMsg?: string): Promise<string> {
  if (!states || states.length === 0) return "";
  try {
    const [{ data: diffLearned }, { data: otherKnowledge }, editResult, { data: adaptRules }] = await Promise.all([
      // ① 差分学習ルール（最優先: スタッフが修正したパターン）
      // HIGH-07: hypothesis_status を取得してconfirmed優先ソートに使う。limit+2で余分に取得
      supabase.from("ai_reply_knowledge")
        .select("id, title, content, hypothesis_status")
        .ilike("title", "%差分学習%")
        .gte("importance", 7)
        .in("conversation_state", states)
        .neq("hypothesis_status", "rejected")
        .order("importance", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(12),
      // ② その他のナレッジ（pattern/principle/phrase — 手動登録・analyze-diffsのパターン）
      supabase.from("ai_reply_knowledge")
        .select("id, title, content, hypothesis_status")
        .not("title", "ilike", "%差分学習%")
        .gte("importance", 7)
        .in("conversation_state", states)
        .neq("hypothesis_status", "rejected")
        .order("importance", { ascending: false })
        .limit(10),
      // ③ スタッフがAIX生成文を編集した実例（リアルタイム品質フィードバック）
      actionType
        ? supabase.from("ai_template_candidates")
            .select("template_text")
            .eq("source", "aix_edit")
            .eq("action_type", actionType)
            .order("created_at", { ascending: false })
            .limit(3)
        : Promise.resolve({ data: null, error: null }),
      // ④ テンプレート修正学習ルール（HIGH-05: テンプレ適用→スタッフ編集→送信のパターンから学習）
      supabase.from("adaptation_improvement_rules")
        .select("rule_text, confidence, category")
        .eq("is_active", true)
        .gte("confidence", 0.7)
        .order("confidence", { ascending: false })
        .limit(5),
    ]);

    // HIGH-07: confirmed を hypothesis より優先してソート
    type KRow = { id: string; title: string; content: string; hypothesis_status?: string };
    const sortConfirmedFirst = (arr: KRow[]): KRow[] =>
      [...arr].sort((a, b) => {
        if (a.hypothesis_status === "confirmed" && b.hypothesis_status !== "confirmed") return -1;
        if (b.hypothesis_status === "confirmed" && a.hypothesis_status !== "confirmed") return 1;
        return 0;
      });
    const sortedDiff = sortConfirmedFirst((diffLearned ?? []) as KRow[]).slice(0, 10);
    const sortedOther = sortConfirmedFirst((otherKnowledge ?? []) as KRow[]).slice(0, 8);

    // F04: pgvector 経路（customerMsg + OPENAI_API_KEY がある場合）
    // 顧客メッセージの embedding で類似ルールを追加取得し、DB query 結果に文脈優先でマージ
    let vectorExtras: KRow[] = [];
    if (customerMsg && process.env.OPENAI_API_KEY) {
      const searchQuery = `${states[0]}: ${customerMsg}`.slice(0, 2000);
      const embedding = await generateEmbedding(searchQuery);
      if (embedding) {
        const { data: vectorResults } = await supabase.rpc("match_reply_knowledge", {
          query_embedding: embedding, match_count: 20, min_importance: 7,
        }) as { data: Array<{ id: string; title: string; content: string; hypothesis_status?: string; importance: number; similarity: number }> | null };
        const filtered = (vectorResults ?? [])
          .filter(r => r.similarity >= 0.5)
          .sort((a, b) => (b.similarity * (b.importance / 10)) - (a.similarity * (a.importance / 10)));
        const existingIds = new Set([...sortedDiff, ...sortedOther].map(r => r.id));
        vectorExtras = filtered.filter(r => !existingIds.has(r.id)).slice(0, 5);
      }
    }

    // 使用追跡（fire-and-forget）
    const allIds = [...sortedDiff, ...sortedOther, ...vectorExtras].map(r => r.id).filter(Boolean);
    if (allIds.length) {
      supabase.rpc("increment_knowledge_used_count", { p_ids: allIds }).then(() => {}, () => {});
      if (conversationId) {
        // C05: source='aix_action' を付与して generate-reply 由来のログと区別する
        supabase.from("knowledge_apply_log").insert(
          allIds.map(id => ({ knowledge_id: id, conversation_id: conversationId, source: "aix_action" }))
        ).then(() => {}, () => {});
      }
    }
    const editExamples = editResult.data;
    const parts: string[] = [];
    if (sortedDiff.length > 0) {
      parts.push("【🔴 過去の修正パターン（必ず守る）】\n" +
        sortedDiff.map(r => `・${r.title}: ${r.content}`).join("\n"));
    }
    if (sortedOther.length > 0) {
      parts.push("【📚 ノウハウ・鉄則（言い回し・表現の参考にすること。ただし上記の【構成】ルールと矛盾する場合は【構成】ルールを最優先にすること）】\n" +
        sortedOther.map(r => `・${r.content}`).join("\n"));
    }
    if ((editExamples?.length ?? 0) > 0) {
      parts.push("【✏️ スタッフが実際に改善した送信例（この質感・表現を目指すこと。ただし上記の【構成】ルールを最優先にすること）】\n" +
        (editExamples as { template_text: string }[])
          .map((r, i) => `[改善例${i + 1}]\n${r.template_text.slice(0, 250)}`)
          .join("\n\n"));
    }
    // HIGH-05: テンプレート修正学習ルール注入
    if ((adaptRules?.length ?? 0) > 0) {
      parts.push("【📘 テンプレート修正学習ルール（テンプレ活用時の改善パターン — テンプレを使う場合は必ず参照）】\n" +
        (adaptRules as { rule_text: string; category: string }[]).map(r => `・[${r.category}] ${r.rule_text}`).join("\n"));
    }
    // F04: pgvector で追加取得した文脈関連ルール
    if (vectorExtras.length > 0) {
      parts.push("【🔍 この顧客メッセージへの関連ルール（文脈検索）】\n" +
        vectorExtras.map(r => `・${r.content}`).join("\n"));
    }
    return parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
  } catch {
    return ""; // ナレッジ取得失敗は生成自体を止めない
  }
}

// ☆つき成功返信パターンを類似検索してAIXプロンプトに注入する（LL-04）
// generate-reply の match_reply_examples RPC と同じ仕組み。顧客メッセージのembeddingで類似☆実例を引く
async function getStarredExamplesForAction(states: string[], customerMsg: string): Promise<string> {
  try {
    // customerMsg のembeddingを取得（OpenAIキーがある場合のみ）
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey || !customerMsg.trim() || !states || states.length === 0) return "";

    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: customerMsg.slice(0, 500) }),
    });
    if (!embRes.ok) return "";
    const embData = await embRes.json() as { data: Array<{ embedding: number[] }> };
    const embedding = embData.data[0]?.embedding;
    if (!embedding) return "";

    // match_reply_examples RPCで類似☆examplesを取得
    const { data } = await supabase.rpc("match_reply_examples", {
      query_embedding: embedding,
      match_count: 3,
      filter_states: states,
    });

    const examples = ((data ?? []) as Array<{ customer_message: string; sent_reply: string; is_starred: boolean; similarity: number }>)
      .filter(e => e.is_starred && e.similarity > 0.5);

    if (!examples.length) return "";

    return "\n\n【✅ 過去の成功返信パターン（☆スタッフ承認済み・参考にすること）】\n" +
      examples.map(e => `顧客:「${e.customer_message.slice(0, 80)}」\nスタッフ返信:「${e.sent_reply.slice(0, 200)}」`).join("\n---\n");
  } catch {
    return ""; // ☆実例取得失敗は生成自体を止めない
  }
}

// #30: max_tokens 尻切れ検知（ログのみ・エラーは投げない）
// ※ アクション名はモジュール変数ではなくリクエストスコープの引数で受け取る
//   （Next.js route handler は同一プロセスで並行実行されるため、モジュール変数だと別リクエストに汚染される）
function warnIfTruncated(data: { stop_reason?: string }, inputLength: number, action: string): void {
  if (data?.stop_reason === "max_tokens") {
    console.warn("[aix/action] max_tokens truncation:", { action, inputLength });
  }
}

// アクション別 max_tokens（一律4096から適正値に削減・トークンコスト削減）
// 尻切れは warnIfTruncated がログ検知するので、発生したらここの値を引き上げる
const ACTION_MAX_TOKENS: Record<string, number> = {
  property_send: 2000,          // 物件紹介文（最大5件×約200字＋前後文＝約1,500字。自動化運用の途中切れ防止で2000）
  property_recommendation: 2000, // 物件オススメ文（複数物件紹介あり得るため途中切れ防止で2000）
  estimate_sheet: 2000,          // 見積書テキスト（OCR＋整形で長め）
  property_check_result: 1500,   // 空き確認結果（見積OCR分岐を含むため多め）
  viewing_invite: 1000,          // 内覧お誘い
  application_push: 1000,        // 申込促進
  docs_request: 2000,            // 書類依頼（不足書類リストが長くなる場合があるため途中切れ防止で2000）
  greeting_viewing: 800,         // 内覧挨拶
  condition_hearing: 800,        // 条件ヒアリング
  meeting_place: 600,            // 待ち合わせ案内
  acknowledge_check: 400,        // 確認しますシンプル返信
  followup_revive: 600,          // 追客メッセージ
};

function maxTokensForAction(action: string): number {
  return ACTION_MAX_TOKENS[action] ?? 1500;
}

async function callClaude(system: string, user: string, action: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokensForAction(action),
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Claude error: ${await res.text()}`);
  const data = await res.json();
  warnIfTruncated(data, system.length + user.length, action);
  return data.content?.[0]?.text?.trim() || "";
}

async function callClaudeHaiku(system: string, user: string, action: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Claude Haiku error: ${await res.text()}`);
  const data = await res.json();
  warnIfTruncated(data, system.length + user.length, action);
  return data.content?.[0]?.text?.trim() || "";
}

async function callClaudeVision(system: string, content: unknown[], action: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokensForAction(action),
      system,
      messages: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Claude Vision error: ${await res.text()}`);
  const data = await res.json();
  warnIfTruncated(data, system.length + JSON.stringify(content).length, action);
  return data.content?.[0]?.text?.trim() || "";
}

// AIが内部メモを出力した場合、顧客向けメッセージと分離する
// 検出対象: 「名前さん＋挨拶キーワード」または「挨拶キーワード単体」の前にある前置き
// ※ 名前が本文中に出てくる物件オススメ等では誤検出しないよう、名前は挨拶との直接連接のみ対象
function extractNotice(text: string, customerName: string): { message: string; notice: string | null } {
  const trimmed = text.trim();
  const GREETING_KEYWORDS = ["お世話になっております", "お待たせ致しました", "お待たせいたしました", "かしこまりました", "夜分遅くに失礼", "ご連絡頂きありがとうございます"];

  // 「名前さん＋挨拶」の連接パターンを検索（名前＋さん＋空白ゼロ個以上＋挨拶）
  let nameGreetingIdx = -1;
  for (const kw of GREETING_KEYWORDS) {
    const pattern = new RegExp(customerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "さん\\s*" + kw);
    const m = trimmed.match(pattern);
    if (m && m.index !== undefined && (nameGreetingIdx < 0 || m.index < nameGreetingIdx)) {
      nameGreetingIdx = m.index;
    }
  }

  // 名前なし挨拶キーワード単体の最小位置
  const standaloneIdx = GREETING_KEYWORDS.reduce((min, kw) => {
    const idx = trimmed.indexOf(kw);
    return idx >= 0 && idx < min ? idx : min;
  }, Infinity as number);

  // 名前＋挨拶連接を優先、なければ挨拶単体
  const startIdx = nameGreetingIdx >= 0 ? nameGreetingIdx : (standaloneIdx < Infinity ? standaloneIdx : -1);

  if (startIdx > 0) {
    const notice = trimmed.slice(0, startIdx).trim();
    return { message: trimmed.slice(startIdx).trim(), notice: notice || null };
  }
  return { message: trimmed, notice: null };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, account, customer_name, image_url, image_urls, condition_image_url, customer_conditions, extra_input, parsed_estimate, recent_messages, check_pattern, vacating_note, calendar_info, vacancy_status, has_estimate, move_out_date, keyword, property_name, property_names, property_vacancy_dates, property_count, all_properties_available, prop_statuses, include_estimate_text, show_viewing_invite, app_push_type, appeal_points, conversation_id: conversationId } = body;

    // #30: max_tokens 尻切れ検知ログ・max_tokens決定用のアクション名（リクエストスコープ）
    const currentAction = String(action ?? "");

    // テンプレート構成ノート（テンプレートモーダルから渡された場合）
    const template_structure = Array.isArray(body.template_structure)
      ? (body.template_structure as Array<{ label: string; text: string }>)
      : null;
    const templateStructureNote = template_structure && template_structure.length > 0
      ? `\n\n【テンプレート構成（この順番・構成に従って生成すること）】\n${template_structure.map(b => `${b.label}：${b.text}`).join("\n")}`
      : "";
    const template_sample = typeof body.template_sample === "string" && body.template_sample.trim()
      ? body.template_sample.trim()
      : null;
    const templateSampleNote = template_sample
      ? `\n\n【テンプレート見本（このトーン・言い回し・絵文字の使い方を参考にすること）】\n${template_sample}`
      : "";

    // プロンプト管理UIのDB上書きを取得（なければコード定数をフォールバック）
    const { data: promptRows } = await supabase
      .from("ai_prompts")
      .select("key, content")
      .in("key", ["aix_property_recommendation_rules", "aix_property_send_rules"]);
    const promptMap: Record<string, string> = {};
    for (const row of (promptRows ?? []) as { key: string; content: string }[]) {
      promptMap[row.key] = row.content;
    }
    const aixPropertyRecommendationRules = promptMap["aix_property_recommendation_rules"] ?? AIX_PROPERTY_RECOMMENDATION_RULES;
    const aixPropertySendRules = promptMap["aix_property_send_rules"] ?? AIX_PROPERTY_SEND_RULES;

    // 今日（JST）スタッフがすでに挨拶メッセージを送っているか判定 → 挨拶を切り替える
    // お世話になっておりますは1日1回の挨拶（おはようございますと同じ）
    // こちら（スタッフ）の最後の送信が今日 → 今日すでに挨拶済み → お待たせ致しました
    // こちらの最後の送信が昨日以前（または送信なし） → 今日初めての挨拶 → お世話になっております
    const todayJST = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const toJSTDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const recentMsgArray = Array.isArray(recent_messages)
      ? (recent_messages as Array<{ sender: string; rawCreatedAt?: string }>)
      : [];
    const lastStaffMsg = [...recentMsgArray].reverse().find(m => m.sender === "staff" && !(m as { isAix?: boolean }).isAix && !(m as { is_aix_generated?: boolean }).is_aix_generated);
    const staffMessagedToday = !!lastStaffMsg &&
      !!lastStaffMsg.rawCreatedAt &&
      toJSTDate(lastStaffMsg.rawCreatedAt) === todayJST;
    // 真の初回判定: AIXメッセージ以外のスタッフ返信が一度もない = 初めてのスタッフ返信
    const isFirstEverReply = !(recentMsgArray as Array<{ sender?: string; isAix?: boolean; is_aix_generated?: boolean; text?: string }>).some(
      m => m.sender === "staff" && !m.isAix && !m.is_aix_generated && m.text && m.text !== "[画像]" && m.text !== "[動画]"
    );
    // お客様が最後に送ったメッセージ（= スタッフが返信する場面）かどうか
    // 向こうから連絡が来た場合は何時でも「お世話になっております」（「夜分遅くに」は使わない）
    const lastMsgSender = [...recentMsgArray].reverse().find(m => m.sender === "customer" || m.sender === "staff")?.sender ?? "staff";
    const customerInitiated = lastMsgSender === "customer";

    // 挨拶（全アクション共通・#19）: 時間帯・初回・当日挨拶済みから挨拶文を一元決定
    const jstHourNow = (new Date().getUTCHours() + 9) % 24;
    // todayJST は既に line 439 で "YYYY-MM-DD" 形式で定義済み → 日本語表記に変換
    const todayJSTFmt = todayJST.replace(/(\d{4})-(\d{2})-(\d{2})/, (_, y, m, d) => `${y}年${parseInt(m)}月${parseInt(d)}日`);
    const greetingPhrase = buildGreeting(jstHourNow, isFirstEverReply, staffMessagedToday, customerInitiated);
    // AI自由生成プロンプトに注入する挨拶時間ルール（挨拶を含みうるアクションで使用）
    const greetingTimeNote = `\n\n【挨拶の時間ルール（共通・必ず守る）】現在時刻はJST${jstHourNow}時台。メッセージに挨拶を入れる場合は必ず「${greetingPhrase}」を使うこと（21時以降・早朝5時以前にこちらからプロアクティブに連絡する場合は「夜分遅くに失礼致します！！」）。挨拶が不要な構成・固定フォーマットの場合は挨拶を追加しないこと。\n・名前と挨拶文は必ず同じ行につなげて書くこと（例：「〇〇さん${greetingPhrase}」）。名前だけを単独の行・単独の一文に置くのは絶対禁止。`;

    // 直近の会話履歴テキスト（viewing_invite・application_push で使用）
    const recentHistory = Array.isArray(recent_messages) && recent_messages.length > 0
      ? "\n\n【直近の会話履歴（この流れを踏まえて文を作ること）】\n" +
        (recent_messages as Array<{ sender: string; text: string }>)
          .filter((m) => m.text && m.text !== "[画像]" && m.text !== "[動画]")
          .slice(-20)
          .map((m) => `${m.sender === "customer" ? "お客様" : "スモラ"}: ${m.text}`)
          .join("\n")
      : "";

    // 最新の顧客メッセージ（☆成功返信パターンの類似検索クエリに使用・LL-04）
    const latestCustomerMsg = Array.isArray(recent_messages)
      ? ([...(recent_messages as Array<{ sender: string; text?: string | null }>)]
          .reverse()
          .find((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")?.text ?? "")
      : "";

    const rawName = customer_name ? String(customer_name).trim() : "";
    // スタッフが会話内で実際に使っていた呼び名を優先（LINE表示名より正確）
    const preferredRawName = extractPreferredName(
      Array.isArray(recent_messages) ? (recent_messages as Array<{ sender: string; text?: string | null }>) : [],
      rawName
    );
    const familyName = preferredRawName.includes(" ") || preferredRawName.includes("　")
      ? preferredRawName.split(/[ 　]/)[0]
      // スペースなし漢字フルネーム（4文字以上）は先頭2文字を姓とみなす（例: 他谷遥香→他谷）
      // ※ひらがな・カタカナのみの名前（例: ふりーだむ）は切り取らず全名を使う
      : preferredRawName.length >= 4 && /^[一-鿿々]+$/.test(preferredRawName)
        ? preferredRawName.slice(0, 2)
        : preferredRawName;
    const name = familyName ? `${familyName}さん` : "お客様";

    // phrase_dictionary 取得（物件オススメ・内覧・申込のみ）
    const phraseCategoryMap: Record<string, string> = {
      property_recommendation: "property_recommendation",
      viewing_invite: "viewing_invite",
      application_push: "application_push",
    };
    const phraseCategory = phraseCategoryMap[action];
    const phraseText = phraseCategory ? await getPhrases(phraseCategory, customer_name) : "";

    let message_text = "";
    let parsed_estimate_result = null;
    let estimate_text_result = "";
    let hearing_intro_result = ""; // condition_hearing のAI導入メッセージ（LL-09）
    let cover_letter = ""; // LL-07: 見積書に添えるAIカバーレター（学習ループ対象）
    let viewingInviteDraft = ""; // viewing_invite AIX生成ドラフト（差分学習ループ用）
    let aiComponents: Record<string, string> | null = null; // 各ピッカーのパーツ別生成結果（コンポーネント学習ループ用）

    // アカウント別表示名（全アクション共通）
    const ACCOUNT_NAMES: Record<string, string> = {
      sumora: "スモラ",
      ieyasu: "イエヤス",
      giga:   "ギガ賃貸",
    };
    const accountName = ACCOUNT_NAMES[String(account || "sumora")] ?? "スモラ";

    // ── 🏠 物件オススメ ───────────────────────────────────────────
    if (action === "property_recommendation") {
      if (!image_url) throw new Error("物件資料画像が必要です");

      // 実例・knowledge・DBプロンプトを並列取得
      const DEFAULT_PROP_SYSTEM = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件資料の画像を読み取り、訴求力のあるオススメ物件メッセージを作成してください。

【このメッセージの最重要目的】
お客様がひと目で物件の魅力を把握できるよう「（オススメポイント）」の箇条書きを伝えることが最優先。（オススメポイント）セクションは必ずメッセージの中心に置き、省略・削除は絶対禁止。

【出力フォーマット — 必ずこの構成で出力すること】

🌟[物件名]（部屋番号がある場合は半角スペースを空けて記載）

[物件の最大の強みを1〜2点・簡潔に。お客様の希望条件に最も響くポイントを選ぶ。例：「敷礼0円・家賃8万円台」「築浅・室内綺麗」など。★お客様が駅・エリアを希望していない場合は「〇〇駅徒歩〇分」をここに入れない]、[お客様名]にかなりオススメ出来るお部屋となります！！

（オススメポイント）
・家賃[金額]円（管理費別の場合は「家賃[金額]円・管理費[金額]円（合計[金額]円）」の形式）
・間取り：[間取り名]（[LDKの広さ]、[洋室1の広さ]・[洋室2の広さ]…の順で記載）
・[路線名]「[駅名]」徒歩[X]分（★お客様が希望エリア・希望駅・徒歩分数のいずれかを指定している場合のみ記載。何も指定がない場合はこの行を完全に省略する。記載する場合はお客様の希望徒歩分数以内のみ。駅名に「駅」の字は付けない（例：「堺筋本町駅」→「堺筋本町」）。複数路線で同じ駅名・徒歩分数なら1行のみ）
・[物件固有の強み1]
・[物件固有の強み2（築年・ペット可・敷金礼金0円・駐車場あり・バイク置場など。お客様の希望条件に合った特徴を優先して選ぶ。インターネット無料は設備欄へ）]
・[さらにあれば追加]

[物件の家賃・間取り・主な強みを1文でシンプルにまとめるサマリー文。築10年以内のみ「〇〇年築で築年数浅く」と書いてよい。築11年以上の物件はサマリー文に築年・築年数・「鉄筋コンクリート造」などを書かない。例：「家賃管理費込[金額]円の[間取り]、敷金礼金なしでかなりオススメ出来るお部屋となります！！」]

[オススメポイントを踏まえた肉付け文。以下を守ること:①間取りの広さ・使い勝手（「LDK〇帖のゆとりある〜」等）を具体的に描写 ②オススメポイントに書いた強みを繰り返さず別の言い方で展開 ③「〜で、〇〇さんにかなりオススメ出来るお部屋となります！！」で締める ④物件資料に記載のない情報（近くのスーパー・生活利便性・駅周辺の様子など）は一切書かない ⑤サマリー文（上の1文）と同じ内容を繰り返さない]

（設備）[物件資料の設備欄に記載の主要設備を「、」で区切って列挙する。例：「インターネット無料、オートロック、宅配ボックス、モニター付きインターホン、エアコン」など。設備記載がない場合はこの行ごと省略。バストイレ別・オートバイ駐輪場・バイク置場・自転車置き場・駐輪場は記載しない]

[締め文 — 以下の条件で使い分ける]
・「退去予定日:」としてユーザーメッセージに日付が明示されている場合：その日付をそのまま使い「[明示された日付]退去予定のため、[明示された日付]以降にご内覧可能です！！」（画像から読み直し絶対禁止）
・退去予定が画像から読み取れる場合（日付未明示）：「○月末退去予定のため、○月○日以降にご内覧可能です！！」
・「建築中」「新築未完成」「竣工予定」など内覧不可の物件の場合：「※こちらのお部屋は建築中のため、[竣工・入居予定時期]のご入居となります！！[お客様の希望入居時期と合わない場合は「〇月のご入居をご希望の場合はご入居時期が合わない形となりますが、新築物件でかなり条件の良いお部屋のためご検討頂けますと幸いです！！」を追加]」のみで締める。案内誘導文（「お気に召されましたら〜ご案内させて頂きます」）は絶対に付けない
・【🔴 絶対禁止】退去予定・建築中以外の通常の空室物件では「お気に召されましたら〜ご案内」「ご都合よろしいお日にちに〜」等の内覧誘導文を書くのは絶対禁止。内覧誘導は別途テンプレートで送るため、物件オススメ文には含めない。（設備）欄の後で必ず終わること

【フォーマットルール — 必ず全て守ること】
・物件名は先頭に必ず🌟をつける（🌟の後に半角スペースは入れない）
・[お客様名]は渡されたお客様名（${name}）をそのまま使うこと（すでに「さん」が付いているため「さん」を重ねて付けない）・呼び方は最初から最後まで一貫して変えない
・お客様名の前後に助詞（「にも」「からも」「ても」等）が来る場合でも、名前を省略・切断しない。例：「〜のお部屋となります！！もえかさんにかなりオススメ〜」のように名前全体を必ず使うこと
・「！！」（全角感嘆符2つ）を使用する（スモラスタイル）・「！」1つは使わない
・絵文字は 😊 のみ・最大1個まで・なくてもよい
・数字は具体的に（「63,000円」「徒歩7分」「6帖」など）
・（オススメポイント）は必須セクション。省略・削除・形式変更は絶対禁止
・（オススメポイント）は4〜6項目。お客様の希望条件に合った特徴を優先して選ぶ
・各「・」行には1種類の情報のみ。「3階のお部屋・2006年築・RC造」のように複数情報を「・」でつなぎ1行に詰め込むことは禁止。それぞれ独立した行にする
・間取りが1R（ワンルーム）の場合は「間取り：1R」と書かず「洋室〇帖」の形で広さだけをオススメポイントに記載する（例：「洋室9.8帖」）
・間取りの広さはLDK→洋室の順で書く（洋室から始めない）
・築年の記載形式は「2006年1月築（築20年）」のように「年月築（築〇年）」とする。新築・築浅（5年以内）は「2024年築で築年数浅く」の形でも可。「築浅」だけの記載は禁止
・「条件が良く」という表現は単独で使わず、必ず「〇〇ですのでかなり条件が良く〜」のように理由を先に述べる形にする
・お客様の条件より家賃・広さが劣る物件の場合は「〜より一回り狭くなってしまいますが、〜の点がかなりオススメ出来るお部屋となります！！」と正直に伝えながら強みを前面に出す
・「！！」（全角感嘆符2つ）を積極的に使う（スモラスタイル）

${aixPropertyRecommendationRules}
・敷金・礼金なしを説明する場合は「敷金・礼金なしのため初期費用をかなり抑えてご入居頂けます！！」の表現を使う（「〜抑える事ができ」等の言い回しは使わない）
・下の文で家賃・管理費に触れる場合は「家賃管理費込○○円と毎月の費用をしっかり抑えられ〜」のように必ず「毎月の費用」と入れる（「家賃管理費込○○円と費用を〜」のように「毎月の」を省くのは禁止）
・下の文（サマリー文・描写段落）でオススメポイントに書いた内容を省いたり矛盾させたりしない
・「築浅」という言葉だけで書くことは絶対禁止。新築・築浅物件は「2022年築で築年数浅く」の形で。古い物件は「2006年1月築（築20年）」の括弧形式で記載

{{examples}}

{{knowledge}}

{{phrases}}

${SMORA_COMMON_RULES}`;

      // フォーマット固定: DEFAULT_PROP_SYSTEM を直接使用（DBで上書きしない）
      const [examples, knowledge, recStarNote] = await Promise.all([
        getPropertyExamples(),
        getPropertyKnowledge(),
        getStarredExamplesForAction(["property_recommendation", "proposing"], latestCustomerMsg),
      ]);

      // {{examples}} {{knowledge}} {{phrases}} を実データに置換
      const system = DEFAULT_PROP_SYSTEM
        .replace("{{examples}}", examples ? `【スモラの実際の物件オススメ文（実例）】\n${examples}` : "")
        .replace("{{knowledge}}", knowledge ? `【物件オススメ時のノウハウ】\n${knowledge}` : "")
        .replace("{{phrases}}", phraseText ? `【よく使うフレーズ】\n${phraseText}` : "")
        + recStarNote; // greetingTimeNote は固定フォーマット（物件オススメ文）に注入しない

      const conditionsText = customer_conditions as string | undefined;
      const recCustomerSummary = body.customer_summary as string | undefined;
      const summaryNoteForRec = recCustomerSummary
        ? `\n\n【このお客さんのAI要約 — 人物像・今の状況・次の対応ヒントをオススメ訴求に反映すること】\n${recCustomerSummary}`
        : "";
      // move_out_date が渡された場合は明示注入（画像OCR誤読防止）
      const moveOutNote = move_out_date
        ? `\n\n【退去予定日（必ずこの日付をそのまま使うこと・画像から読み直し禁止）】\n${move_out_date}`
        : "";
      const simpleModeNote = body.simple_mode
        ? `\n\n【シンプルモード — 必ず守ること】\n出力フォーマットは以下の2要素のみ。それ以外は全て省略する。\n①🌟物件名（部屋番号）\n②（オススメポイント）の箇条書き\n\n絶対に出力しないもの：物件名直後の冒頭一行（「〜さんにかなりオススメ出来るお部屋となります！！」）・サマリー文・描写段落・（設備）欄・締め文（「〜さんお気に召されましたら〜」等の内覧誘導・申込誘導・下段文は全て不要）。（オススメポイント）の最後の行で終わること。`
        : "";
      const skipConfirmationNote = body.skip_confirmation
        ? `\n\n【確認スキップ — 必ず守ること】\n確認事項メッセージを出さず、そのまま通常の物件オススメ文を生成すること。礼金・ペット可否不明・階数など気になる点があっても確認を挟まない。礼金がある場合はオススメポイントに含めずに省略する。`
        : "";
      // extra_inputのうち【特に強調するポイント:...】プレフィックスを除いた手入力テキストを抽出
      const extraInputStr = extra_input ? String(extra_input) : "";
      const manualOpeningText = extraInputStr.replace(/^【特に強調するポイント:[^\n]*】\n?/, "").trim();
      const openingPointNote = manualOpeningText
        ? `\n\n【冒頭ポイント指定 — 最優先・必ず守ること】冒頭の「[ポイント]、${name}にかなりオススメ出来るお部屋となります！！」の[ポイント]部分は必ず「${manualOpeningText}」をそのまま使う。AIで独自のポイントを考えず、指定された文言をそのまま使うこと。`
        : "";
      const newArrivalNote = body.is_new_arrival
        ? `\n\n【🆕 新着物件 — 必ず守ること】この物件は新着物件です。物件名の直後の冒頭一文（「〜さんにかなりオススメ出来るお部屋となります！！」の前）に「新着でかなり条件のいいお部屋となります！！」を自然に盛り込むこと。`
        : "";
      const userText = `お客様名は「${name}」です。お客様名は「${name}」をそのまま使うこと（すでに「さん」付きのため「さん」を重ねない・助詞の後でも省略禁止）。\n${name}へのオススメ物件メッセージを作成してください。${conditionsText ? `\n\nお客様の希望条件:\n${conditionsText}` : ""}${summaryNoteForRec}${extra_input ? `\n追加情報: ${extra_input}` : ""}${templateSampleNote}${templateStructureNote}${openingPointNote}${moveOutNote}${simpleModeNote}${skipConfirmationNote}${newArrivalNote}`;

      const content = [
        { type: "text", text: userText },
        ...(condition_image_url ? [{ type: "image", source: { type: "url", url: condition_image_url } }] : []),
        { type: "image", source: { type: "url", url: image_url } },
      ];

      message_text = await callClaudeVision(system, content, currentAction);

    // ── 💰 見積書送る ─────────────────────────────────────────────
    // ※ 見積書本体はOCR（JSON抽出）＋テンプレート組み立て式（AI自由生成なし・金額を壊さない）。
    //   OCRプロンプトへの差分学習ルール注入はJSON出力を壊すリスクがあるため引き続き対象外。
    //   LL-07: 見積書に添えるカバーレター（coverLetter）のみAI自由生成し、
    //   getDiffKnowledgeForState / getStarredExamplesForAction を注入して学習ループ対象にする。
    } else if (action === "estimate_sheet") {

      // 複数件モード: 各見積書をOCRして①②③付きでまとめる（並列実行）
      if (body.multi_estimate && Array.isArray(image_urls) && image_urls.length > 0) {
        const multiEstSystem = `この見積書画像から初期費用情報を抽出してください。JSON形式のみ返答（説明文なし）：
{"property_name":"物件名","room_number":"号室","discount":"34,000円","initial_cost":"146,000円","savings":"102,200円"}
- property_name: マンション名のみ（号室なし）。不明は""
- room_number: 号室番号のみ（例: 502）。不明は""
- discount: 割引額（「〇〇,〇〇〇円」形式）。なければnull
- initial_cost: 初期費用合計（「〇〇〇,〇〇〇円」形式）。不明はnull
- savings: スモラ節約額（一般業者との差額）。不明はnull`;
        const multiEstBadges = ["①","②","③","④","⑤"];
        const multiEstResults = await Promise.all(
          (image_urls as string[]).map(async (url, pi) => {
            if (!url) return null;
            try {
              const estContent = [
                { type: "text", text: "この見積書から初期費用情報を抽出してください。" },
                { type: "image", source: { type: "url", url } },
              ];
              const estRaw = await callClaudeVision(multiEstSystem, estContent, currentAction);
              const jsonMatch = estRaw.match(/\{[\s\S]*\}/);
              if (!jsonMatch) return null;
              const estData = JSON.parse(jsonMatch[0]) as { property_name?: string | null; room_number?: string | null; discount?: string | null; initial_cost?: string | null; savings?: string | null };
              const pName = estData.property_name?.trim() || `物件${multiEstBadges[pi] ?? String(pi + 1)}`;
              const roomSuffix = estData.room_number?.trim() ? ` ${estData.room_number.trim()}号室` : "";
              const prefix = (image_urls as string[]).length > 1 ? `${multiEstBadges[pi] ?? (pi + 1) + "."}【${pName}${roomSuffix}】` : `【${pName}${roomSuffix}】`;
              const lines: string[] = [prefix, ""];
              if (estData.discount) {
                lines.push("初期費用さらに");
                lines.push(`🌟${estData.discount}割引させて頂き`);
              }
              if (estData.initial_cost) lines.push(`初期費用：${estData.initial_cost}`);
              if (estData.savings) {
                lines.push("");
                lines.push(`${accountName}なら一般的な不動産業者より${estData.savings}節約出来ます！！`);
              }
              return lines.join("\n");
            } catch { return null; }
          })
        );
        const estParts = multiEstResults.filter((r): r is string => r !== null);
        if (estParts.length === 0) {
          message_text = "最大限割引した初期費用の御見積書をお送りさせて頂きます！！\n\n※ご入居日によって日割家賃が発生致します。";
        } else {
          message_text = estParts.join("\n\n") + "\n\n※ご入居日によって日割家賃が発生致します。";
        }
      } else {

      let estimate = parsed_estimate;

      if (!estimate) {
        if (!image_url) throw new Error("見積書画像が必要です");

        const ocrSystem = `見積書画像から以下の項目をJSONで抽出してください。
数値は整数のみ（円・¥・カンマは除く）。不明な項目は0または空文字。
{
  "property_name": "物件名（マンション名のみ、号室は含めない）",
  "room_number": "号室番号のみ（例: 502）",
  "rent": 月額家賃（整数）,
  "total": 初期費用合計（割引後・整数）,
  "discount": 割引額（なければ0）,
  "commission": 仲介手数料税抜（なければ0）,
  "commission_tax": 仲介手数料消費税（なければ0）
}`;

        const raw = await callClaudeVision(ocrSystem, [
          { type: "text", text: "この見積書から指定の項目を抽出してください。" },
          { type: "image", source: { type: "url", url: image_url } },
        ], currentAction);

        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          try { estimate = JSON.parse(match[0]); } catch { estimate = {}; }
        } else {
          estimate = {};
        }
      }

      // アカウント名マッピング
      const est = estimate as Record<string, unknown>;
      const propertyName = String(est.property_name || "");
      const roomNumber   = String(est.room_number   || "");
      // 数値として正常に読み取れた値のみ使用（NaN・0は未取得扱い）
      const totalRaw    = Number(est.total    || 0);
      const discountRaw = Number(est.discount || 0);
      const rentRaw     = Number(est.rent     || 0);
      const commRaw     = Number(est.commission || 0);
      const commTaxRaw  = Number(est.commission_tax || 0);
      const total    = isNaN(totalRaw)    || totalRaw    < 0 ? 0 : totalRaw;
      const discount = isNaN(discountRaw) || discountRaw < 0 ? 0 : discountRaw;
      const rent     = isNaN(rentRaw)     || rentRaw     < 0 ? 0 : rentRaw;
      const commission   = isNaN(commRaw)    ? 0 : commRaw;
      const commTax      = isNaN(commTaxRaw) ? 0 : commTaxRaw;

      const standardCommission = Math.round(rent * 1.1);
      const actualCommission   = commission + commTax;
      // 仲介手数料がOCRで読み取れない/0円の場合、家賃×1.1がそのまま節約額に乗り過大表示になるため節約額表示をスキップ
      const savings = actualCommission === 0 ? 0 : Math.max(0, standardCommission - actualCommission + discount);

      const parts: string[] = [];

      if (propertyName || roomNumber) {
        const roomSuffix = roomNumber ? ` ${roomNumber}号室` : "";
        parts.push(`【${propertyName}${roomSuffix}】`);
        parts.push("");
      }

      if (discount > 0 && total > 0) {
        // 割引額・合計額が両方読み取れた場合のみ数字を出す
        parts.push("初期費用さらに");
        parts.push(`🌟${discount.toLocaleString()}円割引させて頂き`);
        parts.push(`初期費用：${total.toLocaleString()}円`);
        parts.push("");
        if (savings > 0) {
          parts.push(`${accountName}なら一般的な不動産業者より${savings.toLocaleString()}円節約出来ます！！`);
          parts.push("");
        }
      } else if (total > 0) {
        parts.push(`初期費用：${total.toLocaleString()}円`);
        parts.push("");
      } else {
        // 金額が読み取れない場合はシンプルな一文
        parts.push("最大限割引した初期費用の御見積書をお送りさせて頂きます！！");
        parts.push("");
      }

      parts.push("※ご入居日によって日割家賃が発生致します。");

      message_text = parts.join("\n");
      parsed_estimate_result = estimate;

      } // end single-mode

      // ── LL-07: カバーレター生成（見積書に添えるAIメッセージ・学習ループ対象）──
      // 見積書本体（message_text）は固定テンプレのまま維持。coverLetter だけAI自由生成し、
      // 差分学習ルール＋☆成功実例を注入して「修正→学習→改善」ループの対象にする。
      // 生成失敗しても見積書送信は正常に動く（coverLetterは空のまま）。
      try {
        const [coverDiffNote, coverStarNote] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.estimate_sheet, currentAction, conversationId, latestCustomerMsg),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.estimate_sheet, latestCustomerMsg),
        ]);

        const coverSystem = `あなたは賃貸仲介サービス「${accountName}」のLINE営業担当です。
お客様への見積書送付時の添付メッセージ（カバーレター）を1つだけ作成してください。

${SMORA_COMMON_RULES}

【スモラのLINEスタイル】
・絵文字は 😊 😌 ✨ のみ・1〜2個まで
・感嘆符は「！！」（スモラスタイル）・「頂きます」を使う
・お客様の名前（${name}）で始める
・30〜80文字程度のコンパクトなメッセージ
・「お手隙の際にご査収ください😌！！」または「ご確認よろしくお願いします！！」で締める
・LINEでそのまま送れる完成文のみ出力（解説・候補複数・見積書の金額の繰り返しは禁止）${greetingTimeNote}${coverDiffNote}${coverStarNote}`;

        const coverResult = await callClaude(
          coverSystem,
          `${name}への見積書送付メッセージを作成してください。${latestCustomerMsg ? `\nお客様の最新メッセージ: ${latestCustomerMsg}` : ""}${recentHistory}`,
          currentAction
        );
        cover_letter = coverResult.trim();
      } catch {
        // カバーレター生成失敗はサイレントに無視（見積書本体は送れる）
      }

    // ── 📤 物件ピックアップした ──────────────────────────────────────────────
    } else if (action === "property_send") {
      const calendarData = body.calendar_info ? String(body.calendar_info) : null;
      const vacatingInfo = vacating_note ? String(vacating_note) : null;
      const customerSummary = body.customer_summary as string | undefined;
      const sendMode: "viewing" | "application" | "new_arrival" | "simple" | "short" | "normal" | "widen" | "alternative" =
        body.send_mode === "application" ? "application"
        : body.send_mode === "viewing" ? "viewing"
        : body.send_mode === "new_arrival" ? "new_arrival"
        : body.send_mode === "short" ? "short"
        : body.send_mode === "normal" ? "normal"
        : body.send_mode === "widen" ? "widen"
        : body.send_mode === "alternative" ? "alternative"
        : "simple";

      const summaryNote = customerSummary
        ? `\n\n【このお客さんのAI要約 — 今の状況・次の必須対応を最優先で文案に反映すること。人物像・文体も合わせること】\n${customerSummary}`
        : "";

      // 物件ピックアップしたの実例を取得（property_send + proposing 両方から）
      const { data: sendExamples } = await supabase
        .from("ai_reply_examples")
        .select("sent_reply")
        .in("conversation_state", ["property_send", "proposing"])
        .eq("is_starred", true)
        .or("sent_reply.ilike.%ピックアップ%,sent_reply.ilike.%お待たせ致しました%")
        .order("created_at", { ascending: false })
        .limit(5);

      const sendExamplesText = (sendExamples || []).length > 0
        ? "\n\n【スモラの実際の物件送付メッセージ例 — 文体・言い回し・構成を必ずこれに合わせること】\n" +
          (sendExamples as { sent_reply: string }[])
            .map((r, i) => `[例${i + 1}]\n${r.sent_reply}`)
            .join("\n\n")
        : "";

      const sendKeyword = keyword ? String(keyword) : null;
      const keywordRule = sendKeyword
        ? `\n\n【キーワード（必ず冒頭の条件紹介部分に自然に組み込むこと）】: ${sendKeyword}\n例：「築浅・南向きの${sendKeyword}ピックアップさせて頂きました！！」のように条件と合わせて使う`
        : "";

      const EXPANDED_COND_SENTENCES: Record<string, string> = {
        "礼金": "物件に限り御座いましたので礼金がある物件を含めてピックアップさせて頂きました！！",
        "家賃": "物件に限り御座いましたので少し家賃を広げてピックアップさせて頂きました！！",
        "築年数": "物件に限り御座いましたので築年数を少し広げてピックアップさせて頂きました！！",
        "地域": "物件に限り御座いましたので少しエリアを広げてピックアップさせて頂きました！！",
        "初期費用": "物件に限り御座いましたので初期費用が少し高めになってしまう物件も含めてピックアップさせて頂きました！！",
      };
      const expandedConditions = Array.isArray(body.expanded_conditions) ? (body.expanded_conditions as string[]) : [];
      const expandedCondNote = expandedConditions.length > 0
        ? `\n\n【条件を広げた旨（②「ピックアップさせて頂きました」行の直後に改行して追加すること・必須）】\n` +
          expandedConditions.map(c => EXPANDED_COND_SENTENCES[c] ?? "").filter(Boolean).join("\n")
        : "";

      const conditionsInfo = customer_conditions ? String(customer_conditions) : null;
      const conditionsRule = conditionsInfo
        ? `・お客様の希望条件が渡されている場合は、冒頭の「ご希望のご条件に合ったお部屋」の部分を具体化する
  例：「九条周辺・家賃6万円以下・1Kのご条件に合ったお部屋ピックアップさせて頂きました😊！！」
  条件から主なポイント（エリア・家賃・間取り等）を自然に組み込む`
        : `・「ご希望のご条件に合ったお部屋ピックアップさせて頂きました😊！！」で冒頭を続ける`;

      // 挨拶判定: buildGreeting（共通ヘルパー・#19）で一元決定
      // 初回→ご連絡ありがとう / 夜間プロアクティブ→夜分遅くに / 今日挨拶済み→お待たせ / それ以外→お世話になっております
      const openingLine: string = `①「[お客様名]${greetingPhrase}」で始める`;
      // 例文・テンプレ用の挨拶文
      const greetingLine = `${name}${greetingPhrase}`;

      // 新着物件モード: 固定テンプレート（AI不要）
      if (sendMode === "new_arrival") {
        const imgCount = Array.isArray(image_urls) ? (image_urls as string[]).length : (image_url ? 1 : 0);
        const countStr = imgCount > 0 ? `${imgCount}件` : "複数件";
        const greeting = greetingLine;
        const vacatingSection = vacatingInfo
          ? `\n\n${vacatingInfo}`
          : "";
        const applyLine = body.new_arrival_apply ? "\nお気に召されましたらお申込みしお部屋抑えさせて頂きます！！" : "";
        message_text = `${greeting}\n\n新着で${name}ご希望のご条件に合ったお部屋が${countStr}募集にでました！！${vacatingSection}${applyLine}\n\nお手隙の際にご査収ください😌！！`;
        return NextResponse.json({ ok: true, message_text });
      }

      // 学習済み差分ルール（スタッフ修正から学習したパターン）＋☆成功返信パターンをプロンプト末尾に注入
      // + コンポーネント単位の学習ルール（normal/widen/viewingモードのみ: JSON出力でコンポーネント学習が機能するモード）
      const useCompKnowledge = sendMode === "normal" || sendMode === "widen" || sendMode === "viewing";
      const [sendDiffNote, sendStarNote, compPickupNote, compInviteNote, compCalendarNote] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.property_send, currentAction, conversationId, latestCustomerMsg),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.property_send, latestCustomerMsg),
        useCompKnowledge ? getKnowledgeForState(["property_send_pickup"], currentAction) : Promise.resolve(""),
        useCompKnowledge ? getKnowledgeForState(["property_send_invite"], currentAction) : Promise.resolve(""),
        useCompKnowledge ? getKnowledgeForState(["property_send_calendar"], currentAction) : Promise.resolve(""),
      ]);
      // normal/widenモード専用: パーツ別の過去改善ルールを構成ラベル付きで注入
      const componentKnowledgeNote = (sendMode === "normal" || sendMode === "widen" || sendMode === "viewing")
        ? [
            compPickupNote ? `\n\n【📌 ピックアップ行(pickup)の過去の改善ルール — pickupパーツに適用すること】${compPickupNote}` : "",
            compInviteNote ? `\n\n【📌 内覧誘導文(invite)の過去の改善ルール — inviteパーツに適用すること】${compInviteNote}` : "",
            compCalendarNote ? `\n\n【📌 内覧日時記載(calendar)の過去の改善ルール — calendarパーツに適用すること】${compCalendarNote}` : "",
          ].join("")
        : "";

      const nameNote = `\n\n【お客様名 — 最重要】お客様名は「${name}」です。文中では必ず「${name}」をそのまま使うこと（すでに「さん」付きのため「さん」を重ねて付けない）。「〇〇から${name}ご希望の」のように助詞の直後に名前が続く場合でも、名前を途中で切ったり省略したりしない（例：「梅田から」→「もえかさん」→ 「梅田から${name}」と正確につなぐ）。`;

      const sendSystem = sendMode === "short"
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件をピックアップしてお客さんに送る際の超シンプルな導入メッセージを1つだけ作成してください。
${nameNote}
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（厳守）】
${openingLine}
②エリア（条件から読み取り）+「から」+最もキャッチーな条件1つ（間取りより生活感のある特徴優先：カウンターキッチン・ペット可・駐車場付き等）+「のお部屋で${name}ご希望のご条件に近いお部屋ピックアップさせて頂きました！！」
③直後に改行して（空行なし）「お手隙の際にご査収ください😌！！」

【厳守ルール】
・②と③の間に空行を入れない（直接改行でつなぐ）
・「ご条件に合った」ではなく「ご条件に近い」を使う
・条件リストを箇条書きで並べない。エリア＋キーワード1つだけ
・内覧誘導・申込誘導・質問・補足は一切追加しない
・感嘆符は「！！」のみ・絵文字は 😌 のみ1個

【出力例】
${greetingLine}

大阪市内全域からカウンターキッチン付きのお部屋でRさんご希望のご条件に近いお部屋ピックアップさせて頂きました！！
お手隙の際にご査収ください😌！！${sendExamplesText}`
        : sendMode === "simple"
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件をピックアップしてお客さんに送る際の導入メッセージを1つだけ作成してください。
${nameNote}
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（この順番で必ず守ること）】
${openingLine}
②${conditionsRule.replace(/^・/, "")}
③退去予定物件がある場合：「◎〇〇マンション\n[退去日]退去予定となりますので[退去日の翌日]以降ご内覧可能です！」（退去日の翌日＝内覧解禁日。6月30日退去なら7月1日以降。複数あれば全て列挙）
④最終行：「お手隙の際にご査収ください😌！！」を単独で置く

【厳守ルール】
・①〜④の構成のみ出力。内覧誘導・申込誘導・日程・その他の質問や補足は一切追加しない
・②は「〇〇から${name}ご希望のご条件に合ったお部屋ピックアップさせて頂きました！！」の形で1行に完結させる
・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😊 😌 のみ・1〜2個まで

【出力例】
${greetingLine}

大阪駅・難波駅周辺全域からRさんご希望のご条件に合ったお部屋ピックアップさせて頂きました！！

お手隙の際にご査収ください😌！！${sendExamplesText}`
        : sendMode === "application"
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件をピックアップしてお客さんに送る際の導入メッセージを1つだけ作成してください。
このお客さんは内覧より先にお申込みで部屋を確保することを優先する流れです。
${nameNote}
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（この順番で必ず守ること）】
${openingLine}
②${conditionsRule.replace(/^・/, "")}
③退去予定物件がある場合：「◎〇〇マンション\n[退去日]退去予定となりますので[退去日の翌日]以降ご内覧可能です！」（退去日の翌日＝内覧解禁日。6月30日退去なら7月1日以降。複数あれば全て列挙）
④「お気に召されましたらそのままお申込みでお部屋を抑えることが可能です！！」
⑤最終行：「お手隙の際にご査収ください😌！！」を単独で置く

【厳守ルール】
・①〜⑤の構成のみ出力。入居時期・条件確認・その他の質問や補足は一切追加しない
・②は「〇〇から${name}ご希望のご条件に合ったお部屋ピックアップさせて頂きました！！」の形で1行に完結させる
・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😊 😌 のみ・1〜2個まで

【出力例（申込モード）】
${greetingLine}

梅田・難波周辺から${name}ご希望のご条件に合ったお部屋ピックアップさせて頂きました！！

お気に召されましたらそのままお申込みでお部屋を抑えることが可能です！！

お手隙の際にご査収ください😌！！${sendExamplesText}`
        : sendMode === "alternative"
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
お客様が希望されていた物件が空室でなかったため、代替物件をピックアップしてお送りする際の導入メッセージを1つだけ作成してください。
${nameNote}
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（この順番で必ず守ること）】
${openingLine}
②「先ほどの物件は空室がない状況でしたが、${name}ご希望のご条件に合った代替のお部屋をピックアップさせて頂きました！！」のように代替物件である旨を自然に伝える
③退去予定物件がある場合：「◎〇〇マンション\n[退去日]退去予定となりますので[退去日の翌日]以降ご内覧可能です！」
④内覧誘導：「${name}お気に召されましたらお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」
⑤最終行：「お手隙の際にご査収ください😌！！」を単独で置く

【厳守ルール】
・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😊 😌 のみ・1〜2個まで

【出力例（代替物件モード）】
${greetingLine}

先ほどの物件は空室がない状況でしたが、${name}ご希望のご条件に合った代替のお部屋をピックアップさせて頂きました！！

${name}お気に召されましたらお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

お手隙の際にご査収ください😌！！${sendExamplesText}`
        : `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件をピックアップしてお客さんに送る際の導入メッセージを1つだけ作成してください。
${nameNote}
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（この順番で必ず守ること）】
${openingLine}
②${conditionsRule.replace(/^・/, "")}
③退去予定物件がある場合：「◎〇〇マンション\n[退去日]退去予定となりますので[退去日の翌日]以降ご内覧可能です！」（退去日の翌日＝内覧解禁日。6月30日退去なら7月1日以降。複数あれば全て列挙）
④内覧誘導：「[お客様名]お気に召されましたらお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」
⑤内覧日時（calendarパーツ）：【デフォルト = 空文字（出力しない）】。過去の改善ルール（上記「内覧日時記載(calendar)の過去の改善ルール」）で「スタッフが日時を記載する」傾向が確認されている場合のみ、calendarデータを使って以下の形式で出力する。傾向が不明または「日時なし」ルールの場合は必ず空文字にする：
  「直近ですと
  M/D（曜日）HH:MM〜HH:MM
  M/D（曜日）HH:MM〜HH:MM
  ご案内可能です！！」（案内できる日のみ・3日間すべて不可なら「来週ご案内できる日程をご連絡させていただきます！！」）
⑥最終行：「お手隙の際にご査収ください😌！！」を単独で置く

【厳守ルール】
・①〜⑥の構成のみ出力。入居時期・条件確認・その他の質問や補足は一切追加しない
・②は「〇〇から${name}ご希望のご条件に合ったお部屋ピックアップさせて頂きました！！」の形で1行に完結させる
・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😊 😌 のみ・1〜2個まで

【出力例（カレンダーなし）】
${greetingLine}

大阪駅・難波駅周辺全域から${name}ご希望のご条件に合ったお部屋ピックアップさせて頂きました！！

${name}お気に召されましたらお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

お手隙の際にご査収ください😌！！

【出力例（カレンダーあり）】
${greetingLine}

大阪駅・難波駅周辺全域から${name}ご希望のご条件に合ったお部屋ピックアップさせて頂きました！！

${name}お気に召されましたらお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

直近ですと
6/19（木）15:00〜17:00
6/20（金）12:00〜14:00
ご案内可能です！！

お手隙の際にご査収ください😌！！${sendExamplesText}

【出力形式（必須）】
プレーンテキストではなく、以下のJSON形式のみで出力してください（説明・コードブロック不要）：
{"intro":"挨拶行（1行のみ）","pickup":"ピックアップ行（条件説明・1行）","vacating":"退去予定文（複数あれば改行で連結・なければ空文字）","invite":"内覧誘導文（なければ空文字）","calendar":"内覧日時（⑤ルールに従い通常は空文字・過去ルールで日時記載傾向あり時のみ「直近ですと〜ご案内可能です！！」）","closing":"お手隙の際にご査収ください😌！！"}`;

      const userParts: string[] = [`${name}への物件ピックアップ送付メッセージを作成してください。`];
      if (conditionsInfo) userParts.push(`\n\n【お客様の希望条件（冒頭に自然に組み込むこと）】\n${conditionsInfo}`);
      if (calendarData) userParts.push(`\n\n【直近3日の内覧可能時間帯（calendar_events+daily_tasks合算済み・この情報をそのまま使うこと）】\n${calendarData}`);
      if (vacatingInfo) userParts.push(`\n\n【退去予定・案内不可の物件情報（必ず全て伝えること）】\n${vacatingInfo}`);
      if (sendKeyword) userParts.push(`\n\n【キーワード（冒頭の条件紹介に自然に盛り込むこと）】\n${sendKeyword}`);
      if (expandedCondNote) userParts.push(expandedCondNote);
      if (templateSampleNote) userParts.push(templateSampleNote);
      if (templateStructureNote) userParts.push(templateStructureNote);
      if (recentHistory) userParts.push(recentHistory);
      if (summaryNote) userParts.push(summaryNote);

      const rawSendText = await callClaude(sendSystem + sendDiffNote + componentKnowledgeNote + sendStarNote, userParts.join(""), currentAction);
      // normal / widen モードはJSON構成パーツで返す（コンポーネント学習ループ用）
      if (sendMode === "normal" || sendMode === "widen" || sendMode === "viewing") {
        let propertySendComponents: Record<string, string> | null = null;
        try {
          const m = rawSendText.match(/\{[\s\S]*\}/);
          if (m) {
            propertySendComponents = JSON.parse(m[0]) as Record<string, string>;
            const c = propertySendComponents;
            message_text = ["intro", "pickup", "vacating", "invite", "calendar", "closing"]
              .map(k => c[k] ?? "")
              .filter(Boolean)
              .join("\n\n");
          } else {
            message_text = rawSendText;
          }
        } catch {
          message_text = rawSendText;
          propertySendComponents = null;
        }
        return NextResponse.json({
          ok: true,
          message_text,
          ...(propertySendComponents ? { ai_components: propertySendComponents } : {}),
        });
      }
      message_text = rawSendText;

    // ── 🔍 内覧へ！ ──────────────────────────────────────────────
    } else if (action === "viewing_invite") {
      const calendarNote = calendar_info ? String(calendar_info) : null;
      const rescheduleMode = body.reschedule_mode === true;

      // 日程変更モード → シンプルな固定フォーマット生成
      if (rescheduleMode) {
        const rescheduleDiffNote = await getKnowledgeForState(AIX_ACTION_TO_STATES.viewing_invite, currentAction, conversationId, latestCustomerMsg);
        const rescheduleSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
お客様に内覧の日程変更をお伝えするLINEメッセージを1つ生成してください。

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}

【日程変更メッセージのルール】
・${name}と呼びかけてから日程変更の旨を伝える
・新しい候補日時があれば含める（calendar_info参照）
・お詫びの言葉を自然に入れる（「ご迷惑をおかけし大変申し訳ございません」等）
・2〜4行程度・完成したLINEメッセージのみ出力${greetingTimeNote}${rescheduleDiffNote}`;
        const calendarPart = calendarNote ? `\n\n【変更後の内覧候補日時】\n${calendarNote}` : "";
        message_text = await callClaude(
          rescheduleSystem,
          `${name}への内覧日程変更メッセージを生成してください。${calendarPart}${recentHistory}`,
          currentAction
        );
        // 早期リターン（以降の通常viewing_invite生成をスキップ）
        message_text = message_text.replace(/(?<!\d)0+(\d+)号室/g, "$1号室");
        const { message: rescheduleClean, notice: rescheduleNotice } = extractNotice(message_text, familyName || rawName);
        return NextResponse.json({ ok: true, message_text: rescheduleClean, ...(rescheduleNotice ? { notice: rescheduleNotice } : {}) });
      }

      // conversation_match: 会話に合わせた自然文生成（generate-reply同等品質・早期 return）
      const conversationMatchVI = body.conversation_match as boolean | undefined;
      if (conversationMatchVI) {
        const calendarNoteForVI = calendarNote || "";
        const [viewingConvMatchDiffNote, viewingConvMatchStarNote] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.viewing_invite, currentAction, conversationId, latestCustomerMsg),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.viewing_invite, latestCustomerMsg),
        ]);

        const calendarBlock = calendarNoteForVI
          ? `【内覧可能日時（カレンダー自動取得・この時間で案内すること）】\n${calendarNoteForVI}`
          : "";

        const convMatchVISystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】「${name}」

${calendarBlock}

【内覧日程を案内する際のルール（最優先）】
・カレンダーに複数日がある場合は全日を自然な文章で案内する（1日だけ案内して他の日を省略するのは絶対禁止）
・フォーマット例：「明日7/9(木)ですと13:00〜16:00、明後日7/10(金)ですと13:00〜15:00にてご案内可能です！！」
・お客様が日程を指定してきた場合は「はい！！〇日ですと〜」でその日程に直接答える
・来店すれば内覧〜審査まで一気に進められることをさりげなく伝える
・カレンダー未取得または空の場合は「ご都合のよろしいお日にちをお知らせください😊！！」で締める

【重要：会話読解ルール（必ず守ること）】
・お客様の直近メッセージの意図・感情・urgencyを必ず読み取ってから返信を構成する
・お客様が「早く進めたい」「一気に手続きしたい」「今日行けますか」等と言っている → その意欲を真正面から受け止め、「もちろんです！！」「ぜひ！！」から始めて背中を押す
・お客様が不安・疑問を示している → その不安に直接答えてから日程案内に移る
・お客様が具体的な日付を指定している → 「はい！！〇日ですと〜」とその日程に直接答える
・お客様の語彙・テンションに合わせる（丁寧語 → 丁寧に、くだけた表現 → 少し柔らかく）
・テンプレ的な返信は絶対禁止。お客様のメッセージに直接応答する文から始める

【絶対禁止】
・🙏 絵文字は絶対に使わない（スモラ禁止絵文字）
・お客様のメッセージを読まずにテンプレを出力する
・複数の案内可能日があるのに1日だけ案内する

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;

        const rawVI = await callClaude(
          convMatchVISystem + greetingTimeNote + viewingConvMatchDiffNote + viewingConvMatchStarNote,
          `${recentHistory}\n\n上記の会話を深く読み取り、${name}への内覧案内返信を生成してください。`,
          currentAction
        );

        try {
          const mVI = rawVI.match(/\{[\s\S]*?\}/);
          if (mVI) {
            const dVI = JSON.parse(mVI[0]) as { message?: string };
            message_text = (dVI.message || rawVI).replace(/\\n/g, "\n");
          } else {
            message_text = rawVI;
          }
        } catch {
          message_text = rawVI;
        }

        return NextResponse.json({ ok: true, message_text });
      }

      // ☆つき内覧実例をDBから取得
      const { data: viewingExamples } = await supabase
        .from("ai_reply_examples")
        .select("customer_message, sent_reply")
        .in("conversation_state", ["viewing_invite", "viewing", "inspection", "viewing_schedule"])
        .eq("is_starred", true)
        .order("created_at", { ascending: false })
        .limit(5);
      const viewingExamplesText = (viewingExamples || []).length > 0
        ? "\n\n【⭐ スモラの実際の内覧誘導例（文体・テンポ・絵文字をこれに合わせる）】\n" +
          (viewingExamples as { customer_message: string; sent_reply: string }[])
            .map((r, i) => `[例${i + 1}]\nお客様:「${r.customer_message}」\nスモラ:「${r.sent_reply}」`)
            .join("\n\n")
        : "";

      // 学習済み差分ルール（スタッフ修正から学習したパターン）＋☆成功返信パターンをプロンプト末尾に注入
      // HIGH-02修正: viewing_invite の全コンポーネント（greeting/situation/invite/closing）を個別に取得
      const [viewingDiffNote, viewingStarNote, compViewingGreeting, compViewingInvite, compViewingClosing] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.viewing_invite, currentAction, conversationId, latestCustomerMsg),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.viewing_invite, latestCustomerMsg),
        getKnowledgeForState(["viewing_invite_greeting"], currentAction),
        getKnowledgeForState(["viewing_invite_invite"], currentAction),
        getKnowledgeForState(["viewing_invite_closing"], currentAction),
      ]);
      const viewingComponentNote = [
        compViewingGreeting ? `\n\n【📌 挨拶(greeting)の過去改善ルール — greetingパーツに適用すること】${compViewingGreeting}` : "",
        compViewingInvite ? `\n\n【📌 内覧誘導文(invite)の過去改善ルール — inviteパーツに適用すること】${compViewingInvite}` : "",
        compViewingClosing ? `\n\n【📌 締め文(closing)の過去改善ルール — closingパーツに適用すること】${compViewingClosing}` : "",
      ].join("");

      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
会話の前後の流れを深く読み取り、内覧日調整を核心としたLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【最重要原則 — 必ず守ること】
テンプレートではなく「今この会話に最も自然なメッセージ」を生成する。
返信の核心は「内覧の日程調整」。他の情報は最小限。

【お客様の呼び名 — 最重要ルール】
・会話履歴でスタッフが「〇〇さん」と呼んでいた名前を必ず使う
・LINE表示名が1文字・英字のみの場合は会話履歴の呼び名を優先
・文中の[お客様名]は会話履歴から読み取った実際の呼び名を入れること

【状況を読むポイント（生成前に必ず確認）】
① お客様はすでに「内覧したい」「見てみたい」という意思を示しているか
  → YES: 短く直接的に日程提案のみ（2〜3行）
  → NO（物件送付後の誘導など）: 簡単な共感1行+日程提案（3〜4行）
② カレンダー情報（calendar_info）があるか
  → YES: 日程を具体的に列挙（3日分以上ある場合は最低3日提示・1件に絞るのは禁止）
  → NO: 「ご都合よろしいお日にちに」で日程をお客様に委ねる
③ 物件名が特定できるか
  → YES: 物件名を入れると具体感が出る（「〇〇マンションご案内させて頂きます！！」）
  → NO: 「お部屋ご案内させて頂きます！！」で対応
④ 退去予定・空室・退去済みの情報があるか
  → 退去済み: 「〇〇退去しましたのでご内覧可能です😊！！」で先に状況を伝える
  → 退去予定日あり: 「〇月〇日退去予定のお部屋で〇月〇日以降ご内覧可能です！！」

【文の長さ基準】
・お客様が内覧意思を示している + calendar_info あり → 3〜5行（日程提示がメイン）
・お客様が内覧意思を示している + calendar_info なし → 2行（超シンプル）
・物件送付後・誘導シーン → 2〜4行（共感+提案。勧誘文を長々と書かない）
・退去/空室通知 → 2〜3行（状況報告+日程提案）

【日程提示の書き方（calendar_info がある場合）】
直近ですと
M/D（曜日）HH:MM〜HH:MM
M/D（曜日）HH:MM〜HH:MM
M/D（曜日）HH:MM〜HH:MM
ご案内出来ます！！

[お客様名]ご都合如何でしょうか！！

【実際に送られた内覧誘導メッセージの実例】
例1（内覧希望あり・日程提案）:
かしこまりました！！
お部屋ご案内させて頂きます！！

直近ですと
6/29（月）16:15〜17:15
6/30（火）14:00〜17:00
ご案内出来ます！！

ニアさんご都合如何でしょうか！！

例2（退去後に内覧可能になった）:
KTIレジデンス西中島Ⅱ
退去しましたのでお部屋ご内覧可能です😊！！
ほのかさんご都合よろしいお日にちにお部屋ご案内させて頂きます！！
お気軽にお申し付けください😌！！

例3（退去予定日あり・○日以降可能）:
フジパレス西加賀屋 305号室現在募集中となります！！
7/11日退去予定のお部屋で7/12日以降でお部屋ご案内可能です！！
かずやさん7/12日以降のご都合よろしいお日にちにご案内させて頂きます😊！！

例4（物件送付後・誘導・超シンプル版）:
Mさんお気に召されたお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます！！

例5（入居時期から逆算・日程提案あり）:
かしこまりました！！
8月ご入居に向けてプレジオ松屋町のご案内改めて手配させて頂きます😊！！

直近ですと
6/29（月）12:00〜13:00、17:00スタート
6/30（火）12:00〜16:00
ご案内出来ますがあにかさんご都合いかがでしょうか😌！！
${viewingExamplesText}

【スモラのよく使うフレーズ（参考）】
${phraseText || "なし"}

【絶対禁止】
・「いかがでしょうか？」など「？」で終わる → 必ず末尾は「！！」
・内覧誘導の文を2回書く（例：「ご案内します」を繰り返す）
・会話で一度も使っていない名前を突然使う（名前は会話履歴から必ず確認）
・「ぜひ」「是非」「より一層」などの過剰な勧誘ワード

【絵文字ルール】
使ってよい絵文字：😊 😌 🙇‍♀️ 🌟 ✨ のみ・1〜2個まで

【出力形式（必須）】
以下のJSON形式のみで出力してください（説明不要）：
{"greeting":"短い承認行（かしこまりました！！等・なければ空文字）","situation":"状況説明行（退去済み・空室・退去予定情報等・なければ空文字）","invite":"内覧誘導文（核心・必須）","dates":"日程候補全体（直近ですと〜ご案内出来ます！！まで・なければ空文字）","closing":"締め質問行（〇〇さんご都合如何でしょうか！！等・なければ空文字）"}`;

      const calendarPart = calendarNote
        ? `\n\n【直近の内覧可能日時（案内可能な日のみ・1行1日形式・3日分以上ある場合は最低3日分を候補として提示すること）】\n${calendarNote}`
        : extra_input ? `候補日時: ${extra_input}` : "";
      const vacancyPart = vacancy_status === "scheduled" && move_out_date
        ? `\n【物件状況】退去予定日：${move_out_date}（この日以降に内覧可能になる）`
        : vacancy_status === "vacant"
        ? `\n【物件状況】空室（今すぐ内覧可能）`
        : "";
      const propNamePart = property_name ? `\n【物件名】${property_name}` : "";
      const rawViewingText = await callClaude(system + greetingTimeNote + viewingDiffNote + viewingComponentNote + viewingStarNote, `${name}への内覧お誘いメッセージ。${propNamePart}${vacancyPart}${calendarPart}${templateStructureNote}${recentHistory}`, currentAction);
      // JSON構成パーツを解析してコンポーネント学習ループに渡す
      {
        let vComps: Record<string, string> | null = null;
        try {
          const m = rawViewingText.match(/\{[\s\S]*\}/);
          if (m) {
            vComps = JSON.parse(m[0]) as Record<string, string>;
            const c = vComps;
            message_text = ["greeting", "situation", "invite", "dates", "closing"]
              .map(k => c[k] ?? "")
              .filter(Boolean)
              .join("\n\n");
          } else {
            message_text = rawViewingText;
          }
        } catch {
          message_text = rawViewingText;
        }
        if (vComps) aiComponents = vComps;
      }
      // 差分学習ループ用にAIX生成ドラフトを記録（フロントが実際に送った文と比較して学習する）
      viewingInviteDraft = message_text;

    // ── ✋ 申込へ！ ──────────────────────────────────────────────
    } else if (action === "application_push") {
      // ☆つき申込実例を取得（application_pushステートを優先）
      const { data: applyExamples } = await supabase
        .from("ai_reply_examples")
        .select("customer_message, sent_reply")
        .in("conversation_state", ["application_push", "applying", "application", "screening", "contract"])
        .eq("is_starred", true)
        .order("conversation_state", { ascending: true })
        .order("created_at", { ascending: false })
        .limit(8);

      const examplesText = (applyExamples || []).length > 0
        ? "\n\n【⭐ スモラの実際の申込後押し例（文体・テンポ・感嘆符・絵文字をこれに合わせる）】\n" +
          (applyExamples as { customer_message: string; sent_reply: string }[])
            .map((r, i) => `[例${i + 1}]\nお客様:「${r.customer_message}」\nスモラ:「${r.sent_reply}」`)
            .join("\n\n")
        : "";

      // 学習済み差分ルール（スタッフ修正から学習したパターン）＋☆成功返信パターンをプロンプト末尾に注入
      // + コンポーネント単位の学習ルール（application_push_appeal 等）
      // + サブモード別ルール（application_push_push / application_push_confirm 等）
      const _appSubModeKey = body.app_sub_mode as string | undefined;
      const appKnowledgeStates = [...AIX_ACTION_TO_STATES.application_push];
      if (_appSubModeKey && _appSubModeKey !== "format") appKnowledgeStates.push(`application_push_${_appSubModeKey}`);
      // HIGH-02修正: application_push の全コンポーネントを取得（appeal/cta/reassurance/closing）
      const [appDiffNote, appStarNote, compAppealRaw, compCtaRaw, compReassuranceRaw] = await Promise.all([
        getKnowledgeForState(appKnowledgeStates, currentAction, conversationId, latestCustomerMsg),
        getStarredExamplesForAction(appKnowledgeStates, latestCustomerMsg),
        getKnowledgeForState(["application_push_appeal"], currentAction),
        getKnowledgeForState(["application_push_cta"], currentAction),
        getKnowledgeForState(["application_push_reassurance"], currentAction),
      ]);
      const compAppealNote = [
        compAppealRaw ? `\n\n【📌 物件アピール(appeal)の過去改善ルール — appealパーツに適用すること】${compAppealRaw}` : "",
        compCtaRaw ? `\n\n【📌 行動誘導(cta)の過去改善ルール — ctaパーツに適用すること】${compCtaRaw}` : "",
        compReassuranceRaw ? `\n\n【📌 不安解消(reassurance)の過去改善ルール — reassuranceパーツに適用すること】${compReassuranceRaw}` : "",
      ].join("");

      const appSubMode = body.app_sub_mode as string | undefined;

      // ai_prompt_rules からアクション別・条件別ルールを取得（プロンプト注入用）
      const appDbRules = await fetchPromptRules("application_push", {
        has_estimate: String(has_estimate === true),
        app_sub_mode: appSubMode || "push",
      });

      if (appSubMode === "confirm") {
        // ── 申込確定: 会話を読んでお申込み確定メッセージを生成
        const confirmSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
お客様の申込みを快く承諾する2行のLINEメッセージを1つ作成してください。

【メッセージ構成 — この2行のみ・厳守】
①「かしこまりました！！」（この文言で固定・変更禁止）
②「[物件名 号室]、お申込みさせて頂きます😊！！」
・②は日本語として自然につながるよう読点・助詞を軽く調整してよい（例:「マルシェ九条 402号室、お申込みさせて頂きます😊！！」「ASK-6でお申込みさせて頂きます😊！！」）
・②の絵文字は😊または😌を1個のみ。語尾は必ず「！！」
・お客様の決断を一緒に喜ぶ温かいトーンで。ただし行を増やさない

【物件名+号室の特定 — 会話全体を読んで以下の優先順で探す】
${property_name ? `物件名は「${property_name}」を使う（指定済み）。会話履歴から号室が分かる場合（スタッフメッセージの「【物件名 号室】」表記や見積書送付時の記載など）は「${property_name} ○号室」のように号室も付ける。号室が不明なら物件名のみでよい。` : `1. お客様自身の発言を最優先（「〇〇にします！」「〇〇で申し込みます」「〇〇に決めました」等で名指しされた物件名）
2. 会話履歴のスタッフメッセージ冒頭「【物件名 号室】」形式（例:「【ASK-6 201号室】」→「ASK-6 201号室」）
3. 上記がなければ、会話の中で最後に話題になっていた物件名
・号室が分かる場合は必ず「物件名 ○号室」の形で含める（例:「マルシェ九条 402号室」）。号室不明なら物件名のみ
・複数物件が出ている会話では、お客様が申込む意思を示した物件を直近の文脈から選ぶ
・確実に特定できない場合は「こちらのお部屋」とする。誤った物件名を推測で書くことは絶対禁止`}

【禁止】書類案内・審査案内・初期費用・次ステップ案内は一切書かない。この2行以外を追加しない。物件の感想・アピールも書かない。解説不要。
・LINEでそのまま送れる完成文のみ出力

【スモラLINE営業ルール（必ず守る・ただし上記の2行構成が最優先）】
${SMORA_COMMON_RULES}`;

        message_text = await callClaude(confirmSystem + appDbRules + appDiffNote + appStarNote, `${name}への申込確定メッセージ。${property_name ? `物件名:${property_name}。` : ""}${recentHistory}`, currentAction);

      } else if (appSubMode === "docs_request") {
        // ── 書類依頼: 申込フォーム返送後の会話から不足書類を特定して追加依頼メッセージを生成
        const docsRequestSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
お客様が申込フォームを記入・返送した後の会話履歴を読み取り、お申込みに必要な書類のうち「まだ届いていないもの」だけを特定して、追加提出をお願いするLINEメッセージを1つ作成してください。

【前提知識 — お申込みに必要なもの（優先度順）】
1. 本人確認書類 → 「運転免許証」または「マイナンバーカード」のどちらか一方（この2種類のみ・他の書類は不可。「等」を付けて曖昧にしない）→ 選んだ書類の表面・裏面の2枚の写真が必須
2. 収入証明書（直近の給与明細・源泉徴収票等）
3. 申込フォームの未記入・不完全項目の追記

【保険証について — 重要】
・保険証は申込時には一切不要。依頼リストに絶対に含めない
・保証会社や管理会社から請求された場合のみ、後から提出をお願いする
・お客様が保険証を先に送ってきても問題ないが、こちらから依頼はしない

【参考知識（申込時の書類判断には直接使わない）】
・個人事業主のお客様 → 国民健康保険（国保）に加入
・正社員・会社員のお客様 → 社会保険（健保）に加入

【不足書類の判断手順 — この順番で必ず会話履歴を分析すること】

手順1. 申込フォームの返送位置を特定する
・スタッフ（スモラ）が「【お申込者様記入欄】」「入居希望日」「氏名、フリガナ」等を含む長いフォーマットを送信している
・その後にお客様が同じ項目に記入して返送したメッセージ（「入居希望日：8月7日」のように値が埋まっているもの）が「フォーム返送」
・フォーム返送が見つからない場合は手順5のフォールバックへ

手順2. フォーム返送以降に届いた「[画像]」の数を数える
・会話履歴の「[画像]」は画像ファイル1枚の受信を意味する
・カウント対象は「お客様のフォーム返送メッセージ以降」にお客様から届いたものだけ（それ以前の物件画像・見積書画像は数えない）
・判断基準：
  - 0枚 → 本人確認書類が未着 → 「本人確認書類（表面・裏面）」を依頼
  - 1枚 → 表面のみ届いている可能性が高い → 「本人確認書類（裏面）」を依頼
  - 2枚以上 → 本人確認書類（表・裏）は揃っている可能性が高い → 本人確認書類は依頼しない。3枚目以降は収入証明書の可能性として手順3で考慮する

手順3. 収入証明書の送付状況を確認する
・お客様の発言に「免許証」「マイナンバー」「給与明細」「源泉徴収」等の言及があれば、その文脈で判断する
・言及も該当画像もなければ未着と判断して依頼リストに含める
・画像の枚数が本人確認2枚を超えている場合、超過分は収入証明書が届いている可能性があるため「揃っている」側に倒す（届いている書類を再依頼するのが最悪のミス）
・保険証は申込時不要のため、お客様が保険証に言及していてもこの手順の判断対象・依頼対象にしない

手順4. 申込フォームの未記入項目を確認する
・お客様が返送したフォーム内で「〇〇」「-」「未記入」「空欄」のままの項目、値が入っていない項目を抽出する
・未記入項目があれば「申込フォームの以下項目のご記入：（項目名）」として依頼リストに含める
・全項目埋まっていればこの依頼は不要

手順5. フォールバック（判断できない場合）
・フォーム返送が見つからない、[画像]の対応関係が判断できない等、不足物を確信を持って特定できない場合は、標準セットとして「本人確認書類（表面・裏面）」のみを依頼する（保険証は依頼しない）
・推測で断定は書かない

【メッセージ構成 — この3パーツ・この順番を厳守】
①お礼（1行）：「${name}さん申込書ご記入いただきありがとうございます！！」
②不足書類リスト（箇条書き）：冒頭に「以下のご提出をお願い致します」を置き、不足書類のみを「・」で列挙。各項目には必要に応じて「  ※〜」の補足行を付ける
　例：
　・本人確認書類（裏面）
　  ※運転免許証またはマイナンバーカードの裏面の写真をお送りください
　・収入証明書
　  ※直近の給与明細または源泉徴収票をお送りください
③完了への誘導（1行）：「お送りいただき次第お申込み完了させて頂きます😊！！」

【絶対禁止】
・既に届いている書類を依頼リストに入れること（最悪のミス）
・保険証を依頼リストに入れること（申込時は不要）
・本人確認書類の説明で「等」を使うこと（運転免許証・マイナンバーカードの2択のみを明記する）
・催促がましい表現・急かす表現（「早めに」「至急」等）
・書類リスト以外の話題（物件アピール・審査説明・初期費用等）
・LINEでそのまま送れる完成文の材料のみ出力（解説・候補複数は禁止）

【絵文字ルール】
▼ 使ってよい絵文字：😊 😌  のみ・メッセージ全体で1〜2個まで
▼ 語尾は「！！」で統一

【出力形式（必須）】
以下のJSON形式のみで出力してください（説明不要）：
{"thanks":"お礼の一文（①）","missing_items":"不足書類リスト（②・「以下のご提出をお願い致します」から始め、改行区切りの箇条書き・※補足行含む）","closing":"完了案内（③）"}

【スモラLINE営業ルール（必ず守る・ただし上記の3パーツ構成が最優先）】
${SMORA_COMMON_RULES}`;

        const rawDocsText = await callClaude(docsRequestSystem + appDbRules + appDiffNote + appStarNote, `${name}への書類依頼メッセージ。${recentHistory}`, "docs_request");
        // JSONパース → コンポーネント結合
        // ※ docs_request は aiComponents を返さない（conversation_state が application_push と同じため
        //   STATE_LEARNABLEが一致せず component_diff 学習がゼロになるのを防ぐ）。
        //   代わりに message_text = aiDraft として保存されるため全文 analyzeDiff が機能する。
        try {
          const m = rawDocsText.match(/\{[\s\S]*\}/);
          if (m) {
            const c = JSON.parse(m[0]) as Record<string, string>;
            const componentOrder = ["thanks", "missing_items", "closing"];
            message_text = componentOrder.map(k => c[k] ?? "").filter(Boolean).join("\n");
            // aiComponents は意図的にセットしない → フロントが ai_components を保存しない
            // → analyze-diffs が全文 analyzeDiff パスで処理 → 正常に学習される
          } else {
            message_text = rawDocsText;
          }
        } catch {
          message_text = rawDocsText;
        }

      } else {
      // 3パターン: simple / scheduled / hold_view（デフォルト・後方互換）
      const pushType = app_push_type as string | undefined;
      const isSimple = pushType === "simple";
      const isScheduled = vacancy_status === "scheduled";
      const hasEst = has_estimate === true;
      // move_out_date 未指定時に「●月●日退去」がそのまま顧客に出るのを防ぐ
      const moveOut = move_out_date ? String(move_out_date) : "";

      // 訴求ポイント（simple / hold_view のみ有効）
      const appealPts: string[] = Array.isArray(appeal_points)
        ? (appeal_points as unknown[]).filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        : [];
      const hasAppeal = appealPts.length > 0;
      const appealLabel = appealPts.join("・");

      // conversation_match: 会話に合わせた自然文生成（generate-reply同等品質・早期 return）
      const conversationMatch = body.conversation_match as boolean | undefined;
      if (conversationMatch) {
        const calendarNoteForApp = calendar_info
          ? String(calendar_info)
          : "";

        // カレンダー情報ブロック（全日程を提示・未取得時は空）
        // お客様指定日（参考）は conversation_match では AI が会話履歴から読む
        const specifiedDateStr = body.customer_requested_date ? String(body.customer_requested_date) : "";
        const calendarBlock = calendarNoteForApp
          ? `【内覧可能日時（スタッフのカレンダーから自動取得・この時間で案内すること）】\n${calendarNoteForApp}`
          : specifiedDateStr
          ? `【お客様指定日程（参考）】${specifiedDateStr}`
          : "";

        // generate-reply と同等の高品質システムプロンプト構造
        const convMatchSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】「${name}」

${calendarBlock}

【内覧日程を案内する際のルール（最優先）】
・カレンダーに複数日がある場合は全日を自然な文章で案内する（1日だけ案内して他の日を省略するのは絶対禁止）
・フォーマット例：「明日7/9(木)ですと13:00〜16:00、明後日7/10(金)ですと13:00〜15:00にてご案内可能です！！」
・お客様が日程を指定してきた場合は「はい！！〇日ですと〜」でその日程に直接答える
・来店すれば内覧〜審査まで一気に進められることをさりげなく伝える
・カレンダー未取得または空の場合は「ご都合のよろしいお日にちをお知らせください😊！！」で締める

【重要：会話読解ルール（必ず守ること）】
・お客様の直近メッセージの意図・感情・urgencyを必ず読み取ってから返信を構成する
・お客様が「早く進めたい」「一気に手続きしたい」「今日行けますか」等と言っている → その意欲を真正面から受け止め、「もちろんです！！」「ぜひ！！」から始めて背中を押す
・お客様が不安・疑問を示している → その不安に直接答えてから日程案内に移る
・お客様が具体的な日付を指定している → 「はい！！〇日ですと〜」とその日程に直接答える
・お客様の語彙・テンションに合わせる（丁寧語 → 丁寧に、くだけた表現 → 少し柔らかく）
・テンプレ的な返信は絶対禁止。お客様のメッセージに直接応答する文から始める

【絶対禁止】
・🙏 絵文字は絶対に使わない（スモラ禁止絵文字）
・お客様のメッセージを読まずにテンプレを出力する
・複数の案内可能日があるのに1日だけ案内する

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;

        const raw = await callClaude(
          convMatchSystem + appDiffNote + appStarNote,
          `${recentHistory}\n\n上記の会話を深く読み取り、${name}への内覧案内返信を生成してください。`,
          currentAction
        );

        try {
          const m = raw.match(/\{[\s\S]*?\}/);
          if (m) {
            const d = JSON.parse(m[0]) as { message?: string };
            message_text = (d.message || raw).replace(/\\n/g, "\n");
          } else {
            message_text = raw;
          }
        } catch {
          message_text = raw;
        }

        return NextResponse.json({ ok: true, message_text });
      }

      let system: string;
      let userMsg: string;

      if (isScheduled) {
        // ── 退去予定: 固定テンプレート方式（従来通り）
        const templateLines: string[] = [];
        if (hasEst) templateLines.push("[物件名]の最大限割引しました初期費用の御見積書となります！！");
        templateLines.push(moveOut
          ? `お部屋は${moveOut}退去の為ご内覧はまだ出来ないお部屋となります！！`
          : `お部屋は退去予定の物件の為ご内覧はまだ出来ないお部屋となります！！`);
        templateLines.push(`お気に召されましたらお申込しお部屋抑えさせて頂きます😌！！`);
        const template = templateLines.join("\n");
        system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
以下のテンプレートを使って、会話履歴から物件名を特定し、完成したLINEメッセージを1つだけ出力してください。

【テンプレート】
${template}

【穴埋めルール】
・「[物件名]」→ ${property_name ? `「${property_name}」を使う（指定済み）` : '会話履歴から特定（最新の物件名を使う）。見つからなければ「こちらのお部屋」に置換。'}
・テンプレートの文言・改行・絵文字は変えない
・例外（任意・最大1行）: お客様が会話で審査・キャンセル・「内覧できないのに申込は不安」等の不安を示している場合のみ、末尾に「保証会社の審査が通過するまでキャンセル料は一切かかりませんのでご安心ください😊！！」を1行追加してよい。不安が見えなければ追加しない
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）

【スモラの言葉・表現】
${phraseText || "なし"}${examplesText}`;
        userMsg = `物件名を会話から特定してテンプレートを完成させてください。${extra_input ? `補足: ${extra_input}` : ""}${templateStructureNote}${recentHistory}`;

      } else {
        // ── simple / hold_view: 会話を読んで申込を後押しするAI生成
        const appealFocus = hasAppeal
          ? `【重点訴求ポイント】${appealLabel}
これを中心に訴求すること。ただし${appealLabel}だけでなく、お客様の他の希望条件（家賃・間取り・エリア・設備等）にも合っていることを会話から確認し言及すること。初期費用が安くても部屋や家賃が条件に合っていないと申込にならないため、複数の条件が揃っていることを伝える。`
          : `お客様の希望条件（家賃・間取り・エリア・設備等）に合っている点を会話から読み取り、具体的に言及すること。`;

        const structureNote = isSimple
          ? `【メッセージ構成 — この順番を厳守】
①物件アピール（1〜2行）：物件名 + お客様の希望に合っている理由を具体的に${hasEst ? "（費用・見積書には触れない）" : ""}
②申込み後押し：${hasEst
    ? `「${name}初期費用面もお気に召されましたらお申込みしお部屋抑えさせていただきます😊！！\nお申込みいかがでしょうか！！」`
    : `「${name}お気に召されましたらお申込み是非ご検討ください😊！！」`}
③締め：「気になる点ございましたらお気軽にお申し付けください！！」`
          : `【メッセージ構成 — この順番を厳守】
①入居日安心（任意）：お客様が会話の中で入居希望日・入居時期を述べている場合のみ、メッセージの冒頭に置く。下記【入居希望日と30日入居ルール】で計算確認したうえで「8月7日〜10日のご入居で問題ございません！！」のように断言して安心させる。入居希望日の話が出ていない場合はこの行を書かない（空文字にする）
②内覧案内：空室につきご来店頂ければ内覧・申込・審査まで当日中に進められる旨を伝える。${calendar_info ? `カレンダー情報をもとに具体的な来店可能日時を提示すること。形式は「${name}空室ですのでご来店頂けますと内覧から審査まで当日中に進めることができます！！\n\n直近ですと\n[案内可能な日を1行ずつ: 明日(7/9木)なら「明日（7/9木）11:00〜14:00」のように]\nご案内可能です！！」。案内不可の日は一切含めない。` : `「空室ですので${name}ご都合よろしいお日にちにご案内させて頂きます！！」`}
③物件アピール（1行）：お客様の希望に合っている理由を具体的に + 「お申込みが入る可能性が高いお部屋となります！！」
④申込み推奨：「${name}お気に召されましたら一度お申込みし抑えさせてご内覧いただくのがオススメです😌！！」`;

        system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
会話履歴を読み取り、お客様に申込みを後押しするLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

${structureNote}

${!isSimple ? `【入居希望日と30日入居ルール — 最重要】
・不動産賃貸の一般的なルールとして「お申込み日から30日以内にご入居いただく形」となる。今日申込みした場合の入居期限は${todayJSTFmt}の30日後
・お客様が入居希望日を述べている場合は、必ず次の計算をする：「${todayJSTFmt} ＋ 30日 ＝ 入居期限」→ 入居希望日が入居期限と同じ頃またはそれ以前なら期間に間に合うので問題なし
　例：今日が7月9日・希望が8月7日〜10日 → 7月9日申込なら入居期限は8月8日 → ほぼぴったりなので問題なし
・問題なしの場合：構成①で「〇月〇日のご入居で問題ございません！！」と冒頭で断言して安心させ、そのまま②内覧案内へ自然に繋げる
・入居希望日が「${todayJSTFmt} ＋ 30日」より大きく先の場合のみ「〇月〇日頃にお申込み頂ければご希望日でご入居頂けます😊！！」と最適な申込時期を1行で案内する（急かさない）
・【絶対禁止】審査期間の話（「審査に3〜10日かかる」「逆算して早めのお申込みを」等）は一切書かない。入居日の話はすべて30日入居ルールだけで説明する` : ""}

【物件名の特定】
${property_name ? `「${property_name}」を使う（指定済み）` : '会話履歴の最新スタッフメッセージ冒頭「【物件名 号室】」から物件名のみを抽出（例:「【ASK-6 201号室】」→「ASK-6」）。見つからなければ会話全体から特定、それもなければ「こちらのお部屋」。'}

${appealFocus}

【物件アピールの書き方 — 最重要】
・「かなりご条件の良い」「ご条件がよく」のような曖昧な表現は禁止 → 必ず会話から具体的な根拠を入れる
・家賃/管理費 → 「家賃管理費込○○円とご予算内のかなりお得なお部屋となります！！」
・初期費用 → 「初期費用○○円とかなり初期費用を抑えられるお部屋となります！！」
・築年数・間取り → 「○○年築・○LDKで○○さんご希望の条件がかなり揃うお部屋となります！！」
・エリア・駅距離 → 「○○駅徒歩○分で○○さんご希望エリアのかなりオススメのお部屋となります！！」
・複数ポイントを組み合わせる場合は1〜2行に自然にまとめる
・会話に数字や特徴が見当たらない場合は「かなりオススメできるお部屋となります！！」でよい
${hasEst ? "・見積書はすでに送信済み。①の物件アピールで費用・見積書への再言及は厳禁（お客様はすでに見積書を持っている）。②のCTAで「初期費用面もお気に召されましたら」と一言触れるだけでよい" : ""}

【申込の流れ・不安解消（任意・最大1行）】
・まず会話履歴から申込経験の有無を判断する: 「審査」「申込完了」「1番手」「キャンセル」等の申込関連のやりとりが過去にあれば申込経験者 → 流れ・LINE完結の説明は一切書かない
・初めての申込のお客様で、会話に迷い・不安（「検討します」「悩んでいます」「審査が不安」「初めてで」等）が見える場合のみ、構成②の直後に次のうち最も文脈に合う1行だけを追加してよい:
　「お申込み手続きは全てLINEで完結しますのでご安心ください😊！！」
　「保証会社の審査が通過するまでキャンセル料は一切かかりませんのでご安心ください！！」
　「お申込から最短2週間程でご入居頂けます！！」
・不安が見えない場合は何も追加しない（構成の行のみで完結させる）

【絶対禁止】
・「？」のみで終わる文 → 必ず「！！」

【絵文字ルール】
▼ 使ってよい絵文字：😊 😌 のみ・1〜2個まで

【出力形式（必須）】
以下のJSON形式のみで出力してください（説明不要）：
${isSimple
  ? `{"appeal":"物件アピール（①・物件名+希望理由）","cta":"申込み後押し（②）","reassurance":"不安解消行（任意・なければ空文字）","closing":"締め（③）"}`
  : `{"movein_date":"入居日安心（①・任意・入居希望日の話が出ていなければ空文字）","invite":"内覧案内（②）カレンダーあり時は複数行で日程を含む全文、なければ1行","appeal":"物件アピール（③）","cta":"申込み推奨（④）","reassurance":"不安解消行（任意・なければ空文字）"}`}
${examplesText}${greetingTimeNote}`;
        const calendarNoteForApp = calendar_info ? `\n\n【直近の来店・内覧可能時間帯（カレンダー自動取得済み — この情報をそのまま②内覧案内に使うこと）】\n${calendar_info}` : "";
        userMsg = `${name}への申込後押しメッセージ。${property_name ? `物件名:${property_name}。` : ""}${extra_input ? `補足:${extra_input}。` : ""}${calendarNoteForApp}${templateStructureNote}${recentHistory}`;
      }

      const rawAppText = await callClaude(system + appDbRules + appDiffNote + compAppealNote + appStarNote, userMsg, currentAction);
      if (!isScheduled) {
        // simple/hold_view: JSONパーツを解析してコンポーネント学習ループに渡す
        let appComps: Record<string, string> | null = null;
        try {
          const m = rawAppText.match(/\{[\s\S]*\}/);
          if (m) {
            appComps = JSON.parse(m[0]) as Record<string, string>;
            const c = appComps;
            const componentOrder = isSimple
              ? ["appeal", "cta", "reassurance", "closing"]
              : ["movein_date", "invite", "appeal", "cta", "reassurance"];
            message_text = componentOrder.map(k => c[k] ?? "").filter(Boolean).join("\n");
          } else {
            message_text = rawAppText;
          }
        } catch {
          message_text = rawAppText;
        }
        if (appComps) aiComponents = appComps;
      } else {
        message_text = rawAppText;
      }
      } // end else (non-confirm)

    // ── ✅ 物件確認した ──────────────────────────────────────────────
    } else if (action === "property_check_result" && check_pattern === "move_in_date") {
      // ── 🏠 入居日確認した ──────────────────────────────────────────────
      if (!image_url) throw new Error("物件資料画像が必要です");

      const moveInSystem = `あなたは賃貸仲介担当者です。添付の物件資料画像から以下の情報を読み取り、指定フォーマットでメッセージを作成してください。

【読み取る情報】
1. マンション名（物件名）
2. 号室番号（先頭の0は省略: 0806→806）
3. 退去予定日（例: 6月30日）
4. 入居可能予定時期（退去日＋クリーニング1〜2週間で算出。「〇月上旬/中旬/下旬」で表現）
   ※ 上旬=1〜10日、中旬=11〜20日、下旬=21日〜

【出力フォーマット（このまま出力）】
[マンション名][号室]は
[入居可能月]月[上旬/中旬/下旬]頃ご入居日可能予定となります！！

[退去日]退去予定となり、
退去後クリーニングが入る形となります。室内の状況によってご入居日変動御座いますが遅くても[入居可能月]月[上旬/中旬/下旬]にご入居可能予定となります！！

【厳守ルール】
・フォーマット以外の文章・説明・挨拶は一切追加しない
・号室番号の先頭0は省略すること
・退去日が画像に記載されていない場合は「退去予定日不明」と記載
・完成したメッセージのみ出力

【スモラLINE営業ルール（必ず守る・ただし上記の出力フォーマットが最優先）】
${SMORA_COMMON_RULES}`;

      // 学習済み差分ルール（スタッフ修正から学習したパターン）をプロンプト末尾に注入
      const moveInDiffNote = await getKnowledgeForState(AIX_ACTION_TO_STATES.property_check_result, currentAction, conversationId, latestCustomerMsg);

      const content: Array<{ type: string; text?: string; source?: { type: string; url: string } }> = [
        { type: "text", text: `${name}へ送る入居日確認メッセージを作成してください。` },
        { type: "image", source: { type: "url", url: String(image_url) } },
      ];
      message_text = await callClaudeVision(moveInSystem + moveInDiffNote, content, currentAction);

    // ── 🔒 保証会社審査確認 ──────────────────────────────────────────────────
    } else if (action === "property_check_result" && check_pattern === "mgmt_guarantor") {
      const guarantorPushType = body.guarantor_push_type as string | undefined;
      const inputCompanyName = body.guarantor_company_name as string | undefined;
      const inputGuarantorType = body.guarantor_type as string | undefined;
      const inputPropertyName = property_name || "";
      let property_name_override = "";

      let companyName = inputCompanyName || "";
      let guarantorType = inputGuarantorType || "不明";

      // テキスト入力がない場合のみ画像OCRで保証会社名を抽出
      if (!companyName && image_url) {
        const GUARANTOR_COMPANY_LIST_OCR = `【保証会社タイプ一覧（独立系が最も審査緩い）】
信販系: エポスカード、オリコフォレントインシュア、アプラス、ジャックス、フォーレント
LICC系: 日本セーフティー、JID、全国保証、アート・プランニング、青山ライフデザイン、保証ベース
独立系（最も審査緩い）: ジェイリース、エルズサポート、Casa、フォーシーズンズ、ルームバンク、全保連、いえらぶ保証、スマートタカミ、イントラスト、レジデンシャルパートナーズ、日本トラストコーポレーション、株式会社日本トラストコーポレーション`;

        const extractSystem = `賃貸物件資料の画像から保証会社情報を抽出してください。
${GUARANTOR_COMPANY_LIST_OCR}

以下のJSON形式のみで返答（説明不要）：
{"property_name":"物件名（読み取れなければ空文字）","company_name":"保証会社名（正確に・読み取れなければ空文字）","guarantor_type":"独立系|LICC系|信販系|不明"}`;

        const extractRaw = await callClaudeVision(
          extractSystem,
          [
            { type: "text", text: "この物件資料から保証会社名とタイプを特定してください。" },
            { type: "image", source: { type: "url", url: String(image_url) } },
          ],
          currentAction
        );

        try {
          const m = extractRaw.match(/\{[\s\S]*\}/);
          if (m) {
            const d = JSON.parse(m[0]) as { property_name?: string; company_name?: string; guarantor_type?: string };
            if (d.property_name && !inputPropertyName) property_name_override = d.property_name;
            companyName = d.company_name || "";
            guarantorType = d.guarantor_type || "不明";
          }
        } catch { /* 解析失敗時はデフォルト値を使用 */ }
      }

      // タイプ別の詳細説明（スタッフ実例を参考に強化）
      const typeDesc =
        guarantorType === "独立系"
          ? `独立系保証会社の為審査基準緩く、審査通過する可能性十分に御座います！！`
          : guarantorType === "LICC系"
          ? `LICC系保証会社の為一般的な審査基準となります！！`
          : guarantorType === "信販系"
          ? `信販系保証会社の為クレジット情報が参照される物件となります！！`
          : `保証会社の詳細につきましては確認次第ご連絡させて頂きます！！`;

      // 誘導文（任意・pushType未選択なら省略）
      const pushLine = guarantorPushType === "apply"
        ? `${name}お気に召されましたらお申込みしお部屋抑えさせて頂きます！！`
        : guarantorPushType === "viewing"
        ? `${name}お気に召されましたらご都合よろしいお日にちにご案内させて頂きます😊！！`
        : "";

      // 物件名の解決（優先順位: テキスト入力 > 画像OCR > 会話履歴）
      const resolvedPropertyName = inputPropertyName || property_name_override;
      const propertyNameInstruction = resolvedPropertyName
        ? `物件名は「${resolvedPropertyName}」を使う（指定済み）`
        : `会話履歴の最新スタッフメッセージ「【物件名 号室】」から物件名のみ抽出（例:「【ASK-6 201号室】」→「ASK-6」）。見つからなければ「こちらのお部屋」`;

      // 報告ブロック（スタッフ実例の形式）
      const reportBlock = companyName
        ? `[物件名]の\n保証会社が${companyName}となり${guarantorType !== "不明" ? `${guarantorType}の保証` : "保証会社"}となります！！`
        : `[物件名]の保証会社について確認させて頂きました！！`;

      const guarantorDiffNote = await getKnowledgeForState(
        AIX_ACTION_TO_STATES.property_check_result,
        currentAction, conversationId
      );

      const guarantorSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
管理会社に確認した保証会社情報をお客様に報告するLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【お客様名】「${name}」
【${propertyNameInstruction}】

【確定情報（変更禁止）】
保証会社名: ${companyName || "資料より確認済み"}
保証タイプ: ${guarantorType}

【メッセージ構成（厳守）】
①挨拶: 「${greetingPhrase}」
②確認報告: 「${reportBlock}」（[物件名]を解決してから書く・②内の改行は\\nで出力）
③タイプ説明: 「${typeDesc}」（②の後に空行を1行入れてから書く）
${pushLine ? `④誘導: 「${pushLine}」` : "④誘導: なし（省略・ctaはnull）"}

【重要】
・②と③の間には必ず空行を1行入れること（報告→空行→タイプ説明）
・③は独立系の場合「審査基準緩く、審査通過する可能性十分に御座います！！」のような前向きな表現にすること
・誘導がない場合は③で締める（ctaはnull）

【出力形式（必須）】
JSONのみ: {"greeting":"①","report":"②（[物件名]解決済み・改行は\\nで）","type_desc":"③","cta":"④またはnull"}`;

      const rawGuarantorText = await callClaude(
        guarantorSystem + guarantorDiffNote,
        `${name}への保証会社確認報告メッセージ。${recentHistory}`,
        currentAction
      );

      try {
        const m = rawGuarantorText.match(/\{[\s\S]*\}/);
        if (m) {
          const c = JSON.parse(m[0]) as Record<string, string | null>;
          const parts: string[] = [];
          if (c.greeting) parts.push(c.greeting);
          if (c.report) parts.push(c.report.replace(/\\n/g, "\n"));
          parts.push(""); // 空行（タイプ説明の前）
          if (c.type_desc) parts.push(c.type_desc);
          if (c.cta && c.cta !== "null") parts.push(c.cta);
          message_text = parts.join("\n");
        } else {
          message_text = rawGuarantorText;
        }
      } catch {
        message_text = rawGuarantorText;
      }
      // 号室の先頭ゼロを除去（\b はASCII境界のみ機能するため (?<!\d) を使用）
      message_text = message_text.replace(/(?<!\d)0+(\d+)号室/g, "$1号室");
      // 画像URLをレスポンスに含める（フロントエンドで画像先送りに使用）
      if (image_url) {
        return NextResponse.json({ ok: true, message_text, doc_image_url: String(image_url) });
      }

    // ── 🏢 管理会社に確認した（退去予定日・入居可能日・初期費用・駐車場・ペット飼育）＋ 近隣月極駐車場確認 ──────────
    } else if (
      action === "property_check_result" &&
      (check_pattern === "vacate_date" || check_pattern === "mgmt_move_in" || check_pattern === "mgmt_initial_cost" || check_pattern === "mgmt_parking" || check_pattern === "mgmt_pet" || check_pattern === "nearby_parking")
    ) {
      let mgmtInfo = extra_input ? String(extra_input).trim() : "";
      // 駐車場・ペット飼育: 構造化入力（ピッカー選択+テキスト）からスタッフ入力情報を組み立てる
      if (check_pattern === "mgmt_parking") {
        const parkingAvailability = body.parking_availability as string | undefined;
        const parkingFee = body.parking_fee as string | undefined;
        const parkingVacancy = body.parking_vacancy as string | undefined;
        if (!parkingAvailability) throw new Error("駐車場の有無が必要です");
        const lines = [`駐車場の有無：${parkingAvailability}`];
        if (parkingFee) lines.push(`料金：${parkingFee}`);
        if (parkingVacancy) lines.push(`空き状況：${parkingVacancy}`);
        if (mgmtInfo) lines.push(`補足：${mgmtInfo}`);
        mgmtInfo = lines.join("\n");
      } else if (check_pattern === "mgmt_pet") {
        const petPolicy = body.pet_policy as string | undefined;
        const petCondition = body.pet_condition as string | undefined;
        if (!petPolicy) throw new Error("ペット飼育の可否が必要です");
        const lines = [`ペット飼育可否：${petPolicy}`];
        if (petCondition) lines.push(`条件：${petCondition}`);
        if (mgmtInfo) lines.push(`補足：${mgmtInfo}`);
        mgmtInfo = lines.join("\n");
      } else if (check_pattern === "nearby_parking") {
        const nearbyName = body.nearby_parking_name as string | undefined;
        const nearbyDistance = body.nearby_parking_distance as string | undefined;
        const nearbyFee = body.nearby_parking_fee as string | undefined;
        const nearbyVacancy = body.nearby_parking_vacancy as string | undefined;
        if (!nearbyVacancy) throw new Error("空き状況が必要です");
        const lines: string[] = [];
        if (nearbyName) lines.push(`駐車場名：${nearbyName}`);
        if (nearbyDistance) lines.push(`物件からの距離：${nearbyDistance}`);
        if (nearbyFee) lines.push(`月額料金：${nearbyFee}`);
        lines.push(`空き状況：${nearbyVacancy}`);
        if (mgmtInfo) lines.push(`補足：${mgmtInfo}`);
        mgmtInfo = lines.join("\n");
      }
      if (!mgmtInfo) throw new Error("確認結果のテキストが必要です");
      const mgmtGreeting = greetingPhrase; // 挨拶時間ルール共通化（#19）

      // パターン別のフォーマット・ルール（スモラ実データ由来）
      const MGMT_PATTERNS: Record<string, { label: string; format: string; rules: string }> = {
        vacate_date: {
          label: "退去予定日",
          format: `${mgmtGreeting}
[物件名]の退去予定日確認取れました！！
[退去予定日]退去予定の為[内覧解禁日]以降でご内覧可能予定となっております！！
${name}お気に召されましたら[内覧解禁日]以降でご案内させて頂きます😊！！`,
          rules: `・[退去予定日]はスタッフ入力情報から抽出する（例:「7月31日」）
・[内覧解禁日]＝退去日の翌日（例: 7月31日退去→8月1日。6月30日退去→7月1日）
・3行目・4行目両方に同じ[内覧解禁日]を使う
・スタッフ入力に「未定」「確認中」等とある場合は3行目を「退去予定日確定次第すぐにご連絡させて頂きます！！」に差し替え、4行目は削除する`,
        },
        mgmt_move_in: {
          label: "入居可能日",
          format: `${mgmtGreeting}
[物件名]の入居可能日管理会社へ確認させて頂いたところ
[入居可能時期]ご入居可能予定となっております！！`,
          rules: `・[入居可能時期]はスタッフ入力情報から抽出する（例:「8月上旬〜」「8月1日以降」「7月31日」など。そのまま使う）
・スタッフ入力に「即入居可」とある場合は3行目を「即ご入居可能なお部屋となっております！！」にする
・スタッフ入力に退去日・クリーニング等の補足があれば「[退去日]退去予定となり退去後クリーニングが入る形となります。」を3行目の後に追加してよい
・お客様が入居を急いでいる文脈なら末尾に「お気に召されましたらお申込みしお部屋抑えさせて頂きます😌！！」を追加してよい（任意・1行のみ）`,
        },
        mgmt_initial_cost: (() => {
          const mgmtCostType = body.mgmt_cost_type as string | undefined;
          if (mgmtCostType === "estimate") {
            return {
              label: "初期費用（見積書送る）",
              format: `${mgmtGreeting}
[物件名]の初期費用についてご確認させて頂きました！！
[確認内容]となっておりますのでかなり初期費用抑えてご入居頂けます！！
最大限割引しました御見積書お送りさせて頂きますのでお手隙の際にご査収ください😌！！`,
              rules: `・[確認内容]はスタッフ入力情報から抽出する。入力がない場合は「礼金なし・弊社割引」など一般的な表現を使う
・具体的な金額が入力されている場合はそのまま記載する（計算・変更禁止）`,
            };
          } else {
            return {
              label: "初期費用（管理会社交渉）",
              format: `${mgmtGreeting}
[物件名]の初期費用について管理会社へ交渉させて頂きました！！
[交渉結果]となりました！！`,
              rules: `・[交渉結果]はスタッフ入力情報から抽出する（例:「礼金1→0に交渉成功」「礼金の交渉は難しい状況」）
・交渉成功の場合は「かなりお得にご入居頂けます！！」を末尾に追加してよい
・交渉できなかった場合は「引き続き最大限サポートさせて頂きます！！」で締める`,
            };
          }
        })(),
        mgmt_parking: {
          label: "駐車場",
          format: `${mgmtGreeting}
[物件名]の駐車場について管理会社へ確認させて頂きました！！
[確認結果]`,
          rules: `・[確認結果]はスタッフ入力情報（駐車場の有無・料金・空き状況・補足）から作成する（1〜3行）
・駐車場ありの場合:「駐車場のご用意御座います！！」から始め、料金があれば「料金は[料金]となっております！！」、空き状況があれば「空きについても確認済みで[空き状況]となっております！！」を続ける
・料金・空き状況はスタッフ入力の値をそのまま記載する（計算・変更禁止）
・空き状況が「要確認」の場合は「空き状況につきましては確認取れ次第すぐにご連絡させて頂きます！！」とする
・駐車場なしの場合:「確認させて頂いたところ[物件名]には駐車場のご用意がないとのことでした！！」と正直に伝えつつ（謝罪表現は使用禁止）、「近隣の月極駐車場もお探し出来ますのでお気軽にお申し付けください😌！！」のように前向きに締める`,
        },
        mgmt_pet: {
          label: "ペット飼育",
          format: `${mgmtGreeting}
[物件名]のペット飼育について管理会社へ確認させて頂きました！！
[確認結果]`,
          rules: `・[確認結果]はスタッフ入力情報（可否・条件・補足）から作成する（1〜3行）
・ペット可の場合:「ペット飼育可能なお部屋となっております😊！！」から始め、条件があれば「[条件]となっております！！」を続ける（条件はスタッフ入力の値をそのまま記載・変更禁止）
・相談可の場合:「ペット飼育につきましてはご相談可能とのことでした！！」＋条件があれば続け、「ご希望のペットの種類お教え頂けましたら管理会社へ確認させて頂きます😌！！」で締める
・不可の場合:「残念ながらペット飼育不可のお部屋となっておりました！！」と正直に伝えつつ（謝罪表現は使用禁止）、「ペット飼育可能なお部屋を改めてピックアップさせて頂きます😊！！」のように前向きに締める`,
        },
        nearby_parking: {
          label: "近隣の月極駐車場",
          format: `${mgmtGreeting}
[物件名]の近隣の月極駐車場を確認させて頂きました！！
[確認結果]`,
          rules: `・[確認結果]はスタッフ入力情報（駐車場名・物件からの距離・月額料金・空き状況・補足）から作成する（1〜3行）
・空きありの場合:「[駐車場名]（物件から[距離]）が空きありとなっております😊！！」から始め、月額料金があれば「月額[料金]となっております！！」を続ける
・駐車場名の入力がない場合は「近隣の月極駐車場」とする。距離・料金はスタッフ入力の値をそのまま記載する（計算・変更・創作禁止）
・空きなしの場合:「[駐車場名]を確認したところ現在空きがない状況でした！！」と正直に伝えつつ（謝罪表現は使用禁止）、「引き続き近隣の月極駐車場お探しさせて頂きます😌！！」のように前向きに締める
・空き状況が「要確認」の場合:「[駐車場名]（物件から[距離]）が見つかりました！！」＋「空き状況につきましては確認取れ次第すぐにご連絡させて頂きます！！」とする
・これは管理会社への確認ではなく近隣の月極駐車場を自分で調べた結果の報告。「管理会社に確認」という表現は使用禁止`,
        },
      };
      const mgmtDef = MGMT_PATTERNS[String(check_pattern)];

      const mgmtCostType = body.mgmt_cost_type as string | undefined;
      const isNegotiation = mgmtCostType === "negotiation";

      const mgmtSystem = isNegotiation
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
管理会社への初期費用交渉結果をお客様に報告するLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【お客様の呼び方】必ず「${name}」で呼ぶこと

【メッセージ構成】
①挨拶：「${mgmtGreeting}」
②交渉結果報告：「[物件名]の初期費用について管理会社へ交渉させて頂きました！！」
③結果の詳細（1〜2行）：スタッフ入力の交渉結果＋会話履歴のお客様の状況を踏まえた内容
④締め（任意）：交渉成功なら喜びを共有、難しかった場合は前向きに締める

【③ 結果の詳細の書き方】
・スタッフ入力の交渉結果を具体的に書く（例:「礼金1ヶ月→0ヶ月に交渉成功致しました！！」）
・会話履歴からお客様が初期費用についてどんな懸念を持っていたか読み取り、それを解消する形で書く
・交渉成功の場合:「かなり初期費用抑えてご入居頂けます😊！！」を添える
・交渉が難しかった場合:「引き続き最大限サポートさせて頂きます！！」で締める

【物件名の特定】
会話履歴からお客様が確認依頼した物件を特定する（号室があれば「マンション名 806号室」形式・先頭0省略）。特定できない場合は「ご確認頂きましたお部屋」とする

【厳守ルール】
・感嘆符は「！！」（スモラスタイル）
・絵文字は 😊 😌 のみ・1〜2個まで
・完成したLINEメッセージのみ出力（候補複数・前置きは禁止）`
        : `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
${check_pattern === "nearby_parking" ? `物件近隣の月極駐車場を調べた結果` : `管理会社に${mgmtDef.label}を確認した結果`}をお客様に報告するLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【お客様の呼び方】必ず「${name}」で呼ぶこと（他の呼び方・〇〇さんの置き換えし忘れ禁止）

【出力フォーマット（この構成・行数を厳守。[ ]の部分のみ置き換える）】
${mgmtDef.format}

【置き換えルール】
・[物件名]は会話履歴からお客様が確認依頼した物件を特定する（号室があれば「マンション名 806号室」形式・号室の先頭0は省略: 0806→806）。特定できない場合は「ご確認頂きましたお部屋」とする
${mgmtDef.rules}

【厳守ルール】
・フォーマット外の挨拶・説明・解説は一切追加しない
・感嘆符は「！！」（スモラスタイル）
・絵文字は 😊 😌 のみ・1〜2個まで（他は全禁止）
・完成したLINEメッセージのみ出力（候補複数・前置きは禁止）`;

      // 学習済み差分ルール（スタッフ修正から学習したパターン）をプロンプト末尾に注入
      const mgmtDiffNote = await getKnowledgeForState(AIX_ACTION_TO_STATES.property_check_result, currentAction, conversationId, latestCustomerMsg);

      message_text = await callClaude(
        mgmtSystem + mgmtDiffNote,
        isNegotiation
          ? `${name}への初期費用交渉結果報告メッセージを作成してください。

【スタッフが管理会社と交渉した内容・結果（この情報を必ず使うこと）】
${mgmtInfo}${recentHistory}`
          : `${name}への${mgmtDef.label}確認報告メッセージを作成してください。

【スタッフが${check_pattern === "nearby_parking" ? "近隣の月極駐車場を調べた" : "管理会社に確認した"}内容（この情報を必ず使うこと）】
${mgmtInfo}${recentHistory}`,
        currentAction
      );
      // 号室の先頭ゼロを除去（例: 0806号室 → 806号室）（\b はASCII境界のみ機能するため (?<!\d) を使用）
      message_text = message_text.replace(/(?<!\d)0+(\d+)号室/g, "$1号室");

    } else if (action === "property_check_result") {
      // conversation_match: 会話に合わせた自然文生成（テンプレ固定なし・GENERATION_SYSTEM品質）
      if (body.conversation_match) {
        const calendarNoteForPCR = calendar_info ? String(calendar_info) : "";
        const pcrCalendarBlock = calendarNoteForPCR
          ? `【内覧可能日時（カレンダー自動取得・空室時はこの日程で案内すること）】\n${calendarNoteForPCR}`
          : "";
        const [pcrDiffNote, pcrStarNote] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.property_check_result, currentAction, conversationId, latestCustomerMsg),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.property_check_result, latestCustomerMsg),
        ]);

        const pcrSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】「${name}」

${pcrCalendarBlock}

【この返信の目的】
・お客様からリクエストされた物件の確認結果を伝える
・空室あり → 内覧誘導（カレンダー日程を提示）
・満室/募集終了 → 正直に伝えつつ「引き続き探します！！」で前向きに締める
・謝罪表現（「申し訳ございません」等）は使わない。「残念ながら」で自然に伝える

【重要：会話読解ルール（必ず守ること）】
・お客様の直近メッセージから「どの物件・号室」の確認を求めているか読み取る
・物件名・号室が会話に登場する場合は必ず含める（創作禁止）
・テンプレ的な返信は絶対禁止。会話に直接応答する文から始める

【絶対禁止】
・🙏 絵文字は絶対に使わない
・「申し訳ございません」等の謝罪表現
・物件名の創作

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;

        const rawPCR = await callClaude(
          pcrSystem + greetingTimeNote + pcrDiffNote + pcrStarNote,
          `${recentHistory}\n\n上記の会話を深く読み取り、${name}への物件確認結果の返信を生成してください。`,
          currentAction
        );
        try {
          const mPCR = rawPCR.match(/\{[\s\S]*?\}/);
          if (mPCR) {
            const dPCR = JSON.parse(mPCR[0]) as { message?: string };
            message_text = (dPCR.message || rawPCR).replace(/\\n/g, "\n");
          } else { message_text = rawPCR; }
        } catch { message_text = rawPCR; }
        return NextResponse.json({ ok: true, message_text });
      }

      const pattern = check_pattern as "available" | "alternative" | "unavailable" | "exclusive";

      // 「専任物件だった」は固定文専用フロー（AI不要・DB取得もスキップ）
      // ※ name は「◯◯さん」形式（さん付き）のため、テンプレは ${name}に とする
      if (pattern === "exclusive") {
        const exPropName = ((body.exclusive_prop_name as string | undefined) ?? "").trim();
        const exRoomNo = ((body.exclusive_room_no as string | undefined) ?? "").trim();
        const propText = `${exPropName}${exRoomNo}`;
        message_text = `お送りいただきました${propText}は専任のお部屋となっており、弊社ではご紹介ができないお部屋となります！！\n\nよろしければ私の方で${name}にオススメ出来るお部屋ピックアップさせていただきます😊！！`;
        return NextResponse.json({ ok: true, message_text });
      }

      const customerSummary = body.customer_summary as string | undefined;
      const ended_floor = body.ended_floor as number | undefined;
      const ended_unit = body.ended_unit as string | undefined;
      const floor_plan_match = body.floor_plan_match as "same" | "different" | undefined;
      const estimate_image_url = body.estimate_image_url as string | undefined;
      const endedRoomStr = ended_floor != null
        ? `${ended_floor}階${ended_unit ? `${ended_unit}号室` : "部分"}`
        : "のお部屋";

      // 各パターンの実データ由来お手本（DBに☆つき実例が少ないため直書き）
      const PATTERN_EXAMPLES: Record<string, string> = {
        available: `[パターン例: 空室あり・内覧誘導]
スモラ:「お待たせいたしました！！
〇〇（物件名）空室確認取れました😊！！
ぜひご内覧させていただきたいのですが
直近ですと
6/15（月）15:00〜17:00
6/16（火）12:00〜14:00
ご案内可能です！！
〇〇さんご都合いかがでしょうか😌！！」`,
        alternative: `[パターン例: 満室・代替案あり]
スモラ:「お待たせいたしました！！
確認させていただきました物件のお部屋残念ながら全て募集が終了しておりました🙇‍♀️！！
ただAPRILE南森町は一回り広い33.62㎡のお部屋が募集中です！！
こちらのお部屋〇〇さんお気に召されましたらご案内させていただきます！！
ご都合いかがでしょうか😊！！」`,
        unavailable: `[パターン例: 満室・空きなし]
スモラ:「お待たせいたしました！！
残念ながらご確認の物件は現在募集に出ていないお部屋となっております🙇‍♀️！！
引き続き〇〇さんのご希望に合うお部屋をピックアップさせていただきます！！
新着で出次第すぐにお送りさせていただきます😌！！」`,
      };

      const calendarNote = (pattern === "available" && calendar_info) ? String(calendar_info) : null;

      const PATTERN_INSTRUCTION: Record<string, string> = {
        available: calendarNote
          ? `物件を確認した結果「空室あり・入居可能」でした。お待たせしたお礼と空室報告をしたあと、提供された内覧可能日時を以下フォーマットで含めてください：
「直近ですと
M/D（曜日）HH:MM〜HH:MM
M/D（曜日）HH:MM〜HH:MM
ご案内可能です！！」
案内不可の日は除外。締めは「ご都合いかがでしょうか😌！！」`
          : "物件を確認した結果「空室あり・入居可能」でした。お待たせしたお礼と空室報告をして、内覧日程の調整へ自然に誘導してください。",
        alternative: floor_plan_match === "same"
          ? `以下の構成・文体で一字一句この通りに作成してください（[物件名]部分のみ会話履歴から特定して置き換える）：
「お待たせいたしました！！

お送り頂きました[物件名]${endedRoomStr}ですが確認しましたところ募集終了しておりました！！

別の階数となりますが、同じ間取りで
[物件名]で現在募集中のお部屋御座いましたので、最大限割引しました御見積書と併せてお送りさせて頂きました！！
お手隙の際にご査収ください！！」`
          : `物件を確認した結果「${endedRoomStr}は募集終了でしたが別の間取りのお部屋が募集中」でした。「残念ながら」等で正直に伝えつつ（「申し訳ございません」等の謝罪表現は使用禁止）、代替案への期待感を持たせて内覧誘導で締めてください。募集終了だったお部屋は${endedRoomStr}です。`,
        unavailable: "物件を確認した結果「満室・空きなし」でした。「残念ながら」等で正直に伝えつつ（「申し訳ございません」等の謝罪表現は使用禁止）、引き続き物件探しを続けることを伝え、前向きな雰囲気で締めてください。",
        exclusive: "専任物件のため紹介不可を伝える",
      };

      // knowledgeとDB実例（☆なしも含む）を並列取得
      const [{ data: checkExamples }, { data: checkKnowledge }] = await Promise.all([
        supabase
          .from("ai_reply_examples")
          .select("customer_message, sent_reply")
          .in("conversation_state", ["availability_check"])
          .order("is_starred", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(6),
        supabase
          .from("ai_reply_knowledge")
          .select("category, content")
          .in("conversation_state", ["proposing", "availability_check"])
          .gte("importance", 8)
          .order("importance", { ascending: false })
          .limit(6),
      ]);

      // 見積書・物件ピックアップ系はフィルタして結果報告に近いものだけ残す
      const relevantKeywords = ["空室", "募集終了", "満室", "お待たせ", "確認", "案内", "退去"];
      const filteredExamples = (checkExamples || []).filter((r) =>
        relevantKeywords.some((kw) => r.sent_reply?.includes(kw))
      );

      const examplesText = filteredExamples.length > 0
        ? "\n\n【スモラの実際の送信例（文体・感嘆符・絵文字をこれに合わせる）】\n" +
          filteredExamples
            .slice(0, 4)
            .map((r, i) => `[実例${i + 1}]\nスモラ:「${r.sent_reply}」`)
            .join("\n\n")
        : "";

      const knowledgeText = (checkKnowledge || []).length > 0
        ? "\n\n【スモラのノウハウ（必ず従うこと）】\n" +
          (checkKnowledge as { category: string; content: string }[])
            .map((r) => `・[${r.category}] ${r.content}`)
            .join("\n")
        : "";

      const summaryNote = customerSummary
        ? `\n\n【このお客さんのAI要約 — 今の状況・次の必須対応を最優先で文案に反映すること。人物像・文体も合わせること】\n${customerSummary}`
        : "";

      const patternExample = PATTERN_EXAMPLES[pattern] ?? PATTERN_EXAMPLES.unavailable;

      const checkSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件確認の結果をお客さんに報告するLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【お客様の呼び方】必ず「${name}」で呼ぶこと（他の呼び方・〇〇さんの置き換えし忘れ禁止）

【作成ルール】
・「お待たせいたしました！！」で始める
・画像（物件資料）が添付されている場合は物件名・間取りなどを読み取って言及する
・会話履歴がある場合はその流れを踏まえた自然な報告文にする
・感嘆符は「！！」（スモラスタイル）
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字：😊 😌 🙇‍♀️ 🌟 ✨ のみ（他は全禁止）
▼ 絵文字は1〜2個まで

【このパターンのお手本（スモラ実データ由来・文体・構成をこれに合わせる）】
${patternExample}${knowledgeText}${examplesText}${greetingTimeNote}`;

      const available_application = body.available_application as "yes" | "no" | undefined;
      const propNames = (property_names as string[] | undefined) ?? [];
      const propVacancyDates = (property_vacancy_dates as string[] | undefined) ?? [];
      const propCount = (property_count as number | undefined) ?? 1;

      const propStatusesArr = prop_statuses as string[] | undefined;

      // ※ 差分学習ルール注入について: 以下の per-property固定テンプレ・テキスト置換エンジン（availableFixedSystem /
      //   unavailableSystem / fixedSystem same・different）は「一字一句そのまま出力」が前提のため注入対象外
      //   （学習ルールを注入するとテンプレ厳守が壊れるリスクがある）。自由生成パス（最後のelse）のみ注入する。

      // 「物件あった」per-propertyステータス対応（①改善・④改善）
      if (pattern === "available" && propStatusesArr && (propCount > 1 || (propNames[0] as string | undefined)?.trim())) {
        const statuses = propStatusesArr;
        const propList = Array.from({ length: propCount }, (_, pi) => {
          const rawVacDate = (propVacancyDates[pi] as string | undefined)?.trim() ?? "";
          // 年号を除去（「2026年7月下旬」→「7月下旬」）
          const vacDateRaw = rawVacDate.replace(/^\d{4}年/, "");
          // 過去の退去予定日は表示しない
          const vacDate = isPastVacancyDate(rawVacDate) ? "" : vacDateRaw;
          const rawStatus = statuses[pi] ?? "available";
          // Vision読み取りで退去予定日があればボタン状態に関わらず退去予定扱い
          const resolvedStatus = vacDate && rawStatus === "available" ? "vacating" : rawStatus;
          return {
            name: (propNames[pi] as string | undefined)?.trim() ?? "",
            vacDate,
            status: resolvedStatus,
          };
        });
        const fallbackNames = ["①", "②", "③", "④", "⑤"];
        const hasAnyEstimate = ((body.estimate_image_urls as string[] | undefined)?.length ?? 0) > 0 || !!(estimate_image_url as string | undefined);

        if (propCount === 1) {
          // 1件モード: 物件名があれば直接テンプレ生成（④ 改善）
          const p = propList[0];
          const pName = p.name;
          const estimate1 = hasAnyEstimate ? "\n最大限割引しました御見積書同封させて頂きました！！" : "";
          const showVI1 = !!(show_viewing_invite as boolean | undefined);
          const showAppInvite1 = !!(body.check_application_invite as boolean | undefined);
          const greeting1 = greetingPhrase; // 挨拶時間ルール共通化（#19）
          if (p.status === "vacating") {
            const vacLine = p.vacDate ? `${p.vacDate}退去予定のお部屋となります！！` : "退去予定のお部屋となります！！";
            message_text = `${pName}現在募集中となります！！\n${vacLine}${estimate1}\n\nお気に召されましたらお申込みしお部屋を抑えさせていただきます！！`;
          } else if (showAppInvite1) {
            const estimateApp = hasAnyEstimate ? "\n\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！" : "";
            message_text = `${pName}募集中となります！！\n現在1番手でお申込みが入っている為、2番手以降でのお申込となります！！${estimateApp}\n\n※2番手お申込の場合1番手の方が審査否決となった場合1番手に繰り上がります。`;
          } else {
            const inviteText = showVI1 ? `\n\n${name}ご都合よろしいお日にちにご案内させて頂きます😊！！` : "";
            message_text = `${pName}現在募集中となります！！${estimate1}${inviteText}`;
          }
          // greeting1 を先頭に連結（1件モードで挨拶が抜けていたバグ修正）
          message_text = `${greeting1}\n${message_text}`;
        } else {
          // 複数物件モード: per-property ステータスで箇条書き + クロージング
          const recommendIdx = (body.recommend_prop_index as number | undefined) ?? -1;
          const bulletLines = propList.map((p, pi) => {
            const n = p.name || `物件${fallbackNames[pi] ?? ""}`;
            const prefix = pi === recommendIdx ? "🌟" : "・";
            if (p.status === "vacating") return p.vacDate ? `${prefix}${n}　※ ${p.vacDate}退去予定` : `${prefix}${n}`;
            if (p.status === "unavailable") return `${prefix}${n}　※ 申込あり`;
            if (p.status === "alternative") return `${prefix}${n}　※ 別のお部屋が募集中`;
            return `${prefix}${n}`;
          }).join("\n");
          const recommendNote = recommendIdx >= 0 && recommendIdx < propList.length
            ? `\n\n特に🌟の${propList[recommendIdx].name || fallbackNames[recommendIdx] || "こちら"}が${name}に特にオススメです！！`
            : "";
          const estimateSection = hasAnyEstimate
            ? "\n最大限割引しました初期費用御見積書同封させて頂きました。\nお手隙の際にご査収ください！！"
            : "";
          const toureableList = propList.map((p, pi) => ({ ...p, pi })).filter(p => p.status === "available" || p.status === "alternative");
          const showViewingInvite = !!(show_viewing_invite as boolean | undefined);
          const showAppInviteMulti = !!(body.check_application_invite as boolean | undefined);
          let vacancySection = "";
          if (toureableList.length === 0) {
            // 全て退去予定 or 申込あり → 申込訴求
            vacancySection = "\n\nお気に召されましたらお申込みしお部屋抑えさせていただきます！！\nお手隙の際にご査収ください！！";
          } else if (showAppInviteMulti) {
            // 申込誘導ON
            vacancySection = `\n\n${name}お気に召されましたらお申込みしお部屋抑えさせて頂きます！！\nお手隙の際にご査収ください😌！！`;
          } else if (showViewingInvite) {
            // 内覧誘導ON: 全て空室なら1行にまとめる
            const allVacant = toureableList.every(p => p.status === "available");
            if (allVacant) {
              vacancySection = `\n\n${name}ご都合よろしいお日にちにご案内させて頂きます😊！！`;
            } else {
              // alternative混じり → 個別表示
              vacancySection = "\n\n" + toureableList.map(p => {
                const n = p.name || `物件${fallbackNames[p.pi] ?? ""}`;
                return p.status === "alternative"
                  ? `${n}は別のお部屋ですがご案内出来ます！！\n${name}ご都合よろしいお日にちにご案内させて頂きます😊！！`
                  : `${n}は空室ですのでご案内出来ます！！\n${name}ご都合よろしいお日にちにご案内させて頂きます😊！！`;
              }).join("\n\n");
            }
          }
          // 内覧誘導OFF → vacancySection = "" (内覧テキストなし)
          const greeting = greetingPhrase; // 挨拶時間ルール共通化（#19）
          const header = (all_properties_available as boolean | undefined)
            ? `${name}お送り頂きました\n`
            : `${name}お送り頂きました物件の中で\n`;
          message_text = `${greeting}\n${header}${bulletLines}\nこちら${propCount}件現在募集中となります！！${recommendNote}${estimateSection}${vacancySection}`;
        }

      // 「物件あった」申込あり・申込なし・未選択 は固定テンプレ（1件）
      } else if (pattern === "available") {
        const estimateLine = estimate_image_url ? "\n最大限割引しました御見積書同封させて頂きました！！" : "";
        const availableTemplate = available_application === "yes"
          ? `[物件名と号室]募集中となります！！
現在1番手でお申込みが入っている為、2番手以降でのお申込となります！！${estimateLine}

※2番手お申込の場合1番手の方が審査否決となった場合1番手に繰り上がります。`
          : `[物件名と号室]現在募集中となります！！${estimateLine}

${name}ご都合よろしいお日にちにご案内させて頂きます😊！！`;

        const availableFixedSystem = `あなたはテキスト置換エンジンです。
以下のテンプレートを一字一句そのまま出力してください。
[物件名と号室]の部分のみ、画像または会話履歴から「マンション名 ○○○号室」の形式で置き換えること（例: アドバンス難波ラシュレ 806号室）。
号室番号は先頭の0を省略すること（0806 → 806、0102 → 102）。
号室が不明な場合はマンション名のみ記載する。
それ以外の文字・絵文字・改行は一切変更・追加・削除しないこと。

テンプレート:
${availableTemplate}`;

        if (image_url) {
          const content: Array<{ type: string; text?: string; source?: { type: string; url: string } }> = [
            { type: "text", text: `以下の会話と画像から物件名と号室を特定して[物件名と号室]を置き換えてください。${recentHistory}` },
            { type: "image", source: { type: "url", url: image_url } },
          ];
          message_text = await callClaudeVision(availableFixedSystem, content, currentAction);
        } else {
          message_text = await callClaude(
            availableFixedSystem,
            `以下の会話から物件名と号室を特定して[物件名と号室]を置き換えてください。${recentHistory}`,
            currentAction
          );
        }
        // 号室の先頭ゼロを除去（例: 0806号室 → 806号室）（\b はASCII境界のみ機能するため (?<!\d) を使用）
        message_text = message_text.replace(/(?<!\d)0+(\d+)号室/g, "$1号室");

      // 「物件なかった」は固定テンプレ専用フロー
      } else if (pattern === "unavailable") {
        const unavailableGreeting = greetingPhrase; // 挨拶時間ルール共通化（#19）
        const unavailableTemplate = `${name}${unavailableGreeting}
お送り頂きました[物件表現]募集終了しているお部屋となります。`;

        const unavailableSystem = `あなたはテキスト置換エンジンです。
【絶対ルール】説明文・メモ・思考プロセスは一切出力しないこと。置換後のテンプレートのみ出力すること。
以下のテンプレートを出力してください。[物件表現]を下記ルールで置き換えること。
・送られてきた物件が1件の場合: 「物件の募集状況確認させて頂きましたところ」
・2件の場合: 「2件の募集状況確認させて頂きましたところ2件とも」
・3件以上の場合: 「N件の募集状況確認させて頂きましたところN件とも」（Nは実際の件数）
・件数が不明な場合: 「物件の募集状況確認させて頂きましたところ」（件数についての説明は出力しない）
★1件のときは絶対に「1件とも」と書かない。
それ以外の文字・絵文字・改行は一切変更・追加・削除しないこと。

テンプレート:
${unavailableTemplate}`;

        message_text = await callClaude(
          unavailableSystem,
          `以下の会話から送られてきた物件の件数を特定して[物件表現]を置き換えてください。${recentHistory}`,
          currentAction
        );

      // 「同じ間取り」「違う間取り」は固定テンプレートを完全に守らせる専用フロー
      } else if (pattern === "alternative" && (floor_plan_match === "same" || floor_plan_match === "different")) {
        if (floor_plan_match === "same") {
          const templateText = `お待たせいたしました！！

お送り頂きました[物件名]${endedRoomStr}ですが確認しましたところ募集終了しておりました！！

別の階数となりますが、同じ間取りで
[物件名]で現在募集中のお部屋御座いましたので、最大限割引しました御見積書と併せてお送りさせて頂きました！！
お手隙の際にご査収ください！！`;

          const fixedSystem = `あなたはテキスト置換エンジンです。
以下のテンプレートを一字一句そのまま出力してください。
[物件名]の部分のみ、会話履歴から特定した物件名に置き換えること。
それ以外の文字・絵文字・改行は一切変更・追加・削除しないこと。

テンプレート:
${templateText}`;

          message_text = await callClaude(fixedSystem, `以下の会話から物件名を特定して[物件名]を置き換えてください。${recentHistory}`, currentAction);

        } else {
          // 違う間取り: 物件画像から広さ（㎡）を読み取って文に反映
          const templateText = `お待たせいたしました！！

お送り頂きました[物件名]${endedRoomStr}ですが確認しましたところ募集終了しておりました！！

別の間取り（[㎡]）となりますが
[物件名]で現在募集中のお部屋が御座いますので、最大限割引しました御見積書と併せてお送りさせて頂きました！！
お手隙の際にご査収ください！！`;

          const fixedSystem = `あなたはテキスト置換エンジンです。
以下のテンプレートを一字一句そのまま出力してください。
[物件名]の部分のみ、会話履歴から特定した物件名に置き換えること。
[㎡]の部分のみ、添付画像から読み取った部屋の広さ（例: 46.2㎡）に置き換えること（画像がない・読み取れない場合は[㎡]ごと削除すること）。
それ以外の文字・絵文字・改行は一切変更・追加・削除しないこと。

テンプレート:
${templateText}`;

          if (image_url) {
            const content: Array<{ type: string; text?: string; source?: { type: string; url: string } }> = [
              { type: "text", text: `以下の会話から物件名を特定して[物件名]を置き換え、添付画像から部屋の広さを読み取って[㎡]を置き換えてください。${recentHistory}` },
              { type: "image", source: { type: "url", url: image_url } },
            ];
            message_text = await callClaudeVision(fixedSystem, content, currentAction);
          } else {
            message_text = await callClaude(fixedSystem, `以下の会話から物件名を特定して[物件名]を置き換えてください。[㎡]は削除してください。${recentHistory}`, currentAction);
          }
        }
      } else {
        // 学習済みナレッジ＋☆実例をプロンプト末尾に注入（自由生成パスのみ）
        // サブパターン別ナレッジも追加（property_check_result_available 等）
        const checkResultStates = [...AIX_ACTION_TO_STATES.property_check_result];
        const patternStr = pattern as string;
        if (patternStr && patternStr !== "interior_photo" && patternStr !== "move_in_date") {
          checkResultStates.push(`property_check_result_${patternStr}`);
        }
        const [checkDiffNote, checkStarNote] = await Promise.all([
          getKnowledgeForState(checkResultStates, currentAction, conversationId, latestCustomerMsg),
          getStarredExamplesForAction(checkResultStates, latestCustomerMsg),
        ]);

        const instruction = PATTERN_INSTRUCTION[pattern] ?? PATTERN_INSTRUCTION.unavailable;
        const calendarPart = calendarNote
          ? `\n\n【内覧可能日時（1日1行で含めること・案内不可の日は除外）】\n${calendarNote}`
          : "";
        const userText = `${name}への物件確認報告メッセージを作成してください。\n\n${instruction}${templateSampleNote}${templateStructureNote}${calendarPart}${summaryNote}${recentHistory}`;

        if (image_url || estimate_image_url) {
          const content: Array<{ type: string; text?: string; source?: { type: string; url: string } }> = [
            { type: "text", text: userText },
          ];
          if (image_url) content.push({ type: "image", source: { type: "url", url: image_url } });
          if (estimate_image_url) content.push({ type: "image", source: { type: "url", url: estimate_image_url } });
          message_text = await callClaudeVision(checkSystem + checkDiffNote + checkStarNote, content, currentAction);
        } else {
          message_text = await callClaude(checkSystem + checkDiffNote + checkStarNote, userText, currentAction);
        }
      }

      // 見積書テキスト同封: available パターンかつフラグON時、見積書画像から費用テキストを生成・末尾に追加（並列実行）
      if (pattern === "available" && (include_estimate_text as boolean | undefined) && message_text) {
        const estUrls = (body.estimate_image_urls as string[] | undefined) ?? [];
        if (estUrls.length > 0) {
          const checkEstSystem = `この見積書画像から初期費用情報を抽出してください。JSON形式のみ返答（説明文なし）：
{"discount":"34,000円","initial_cost":"146,000円","savings":"102,200円"}
- discount: 割引額（「〇〇,〇〇〇円」形式）
- initial_cost: 初期費用合計（「〇〇〇,〇〇〇円」形式）
- savings: スモラ節約額（一般業者との差額）
不明はnull。`;
          const checkEstBadges = ["①","②","③","④","⑤"];
          const checkEstResults = await Promise.all(
            estUrls.map(async (url, pi) => {
              if (!url) return null;
              const pName = (propNames[pi] as string | undefined)?.trim() || `物件${checkEstBadges[pi] ?? String(pi + 1)}`;
              try {
                const estContent = [
                  { type: "text", text: "この見積書から初期費用情報を抽出してください。" },
                  { type: "image", source: { type: "url", url } },
                ];
                const estRaw = await callClaudeVision(checkEstSystem, estContent, currentAction);
                const jsonMatch = estRaw.match(/\{[\s\S]*\}/);
                if (!jsonMatch) return null;
                const estData = JSON.parse(jsonMatch[0]) as { discount?: string | null; initial_cost?: string | null; savings?: string | null };
                const prefix = estUrls.length > 1 ? `${checkEstBadges[pi] ?? (pi + 1) + "."}【${pName}】` : `【${pName}】`;
                const lines: string[] = [prefix, ""];
                if (estData.discount) {
                  lines.push("初期費用さらに");
                  lines.push(`🌟${estData.discount}割引させて頂き`);
                }
                if (estData.initial_cost) lines.push(`初期費用：${estData.initial_cost}`);
                if (estData.savings) {
                  lines.push("");
                  lines.push(`${accountName}なら一般的な不動産業者より${estData.savings}節約出来ます！！`);
                }
                return lines.join("\n");
              } catch { return null; }
            })
          );
          const checkEstParts = checkEstResults.filter((r): r is string => r !== null);
          if (checkEstParts.length > 0) {
            estimate_text_result = checkEstParts.join("\n\n") + "\n\n※ご入居日によって日割家賃が発生致します。";
          }
        }
      }

    // ── 📋 条件ヒアリング（フォームをテンプレ生成 + AI導入メッセージ） ───
    } else if (action === "condition_hearing") {
      // conversation_match: 会話に合わせた自然な挨拶＋ヒアリング導入メッセージを生成（固定フォームなし）
      if (body.conversation_match) {
        const [hearingCMDiffNote, hearingCMStarNote] = await Promise.all([
          getKnowledgeForState([...AIX_ACTION_TO_STATES.condition_hearing, "first_reply"], currentAction, conversationId, latestCustomerMsg),
          getStarredExamplesForAction([...AIX_ACTION_TO_STATES.condition_hearing, "first_reply"], latestCustomerMsg),
        ]);

        const hearingCMSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】「${name}」

【この返信の目的】
・お客様への最初の挨拶と、お部屋探しのお手伝い宣言をする
・次のメッセージでヒアリングフォームを送る予告をする
・「ご希望条件を教えてください」という流れに自然につなぐ
・条件項目の箇条書き（①②③…）は含めない（フォームは別送するため）

【重要：会話読解ルール（必ず守ること）】
・お客様の最初のメッセージ（問い合わせ内容・雰囲気）を必ず読み取ってから書く
・お客様がすでに何か条件を話している場合はそれに言及する
・テンプレ的な「お世話になっております」で始めない
・50〜100文字程度・2〜3行まで

【絶対禁止】
・🙏 絵文字は絶対に使わない
・条件項目の箇条書き（①②③…）を含める

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;

        const rawHCM = await callClaude(
          hearingCMSystem + greetingTimeNote + hearingCMDiffNote + hearingCMStarNote,
          `${recentHistory}\n\n上記の会話を読み取り、${name}への挨拶＋ヒアリング導入メッセージを生成してください。`,
          currentAction
        );
        try {
          const mHCM = rawHCM.match(/\{[\s\S]*?\}/);
          if (mHCM) {
            const dHCM = JSON.parse(mHCM[0]) as { message?: string };
            message_text = (dHCM.message || rawHCM).replace(/\\n/g, "\n");
          } else { message_text = rawHCM; }
        } catch { message_text = rawHCM; }
        return NextResponse.json({ ok: true, message_text });
      }
      // ─── ヒアリング: 条件フォームはテンプレで直接生成（従来通り）＋ AI導入メッセージ（LL-09）────────────
      // フォーム本体は固定テンプレのまま。フォームに添える「導入メッセージ」のみAI生成し、
      // getDiffKnowledgeForState / getStarredExamplesForAction を注入して学習ループの対象にする。
      // 導入メッセージの生成に失敗してもフォームはそのまま送れる（hearingIntro は空になるだけ）。
      // 既知の条件を解析して、まだ聞けていない項目だけを番号詰めで表示する
      const condText = (customer_conditions as string | undefined) ?? "";
      const CIRCLE_NUMS = ["①","②","③","④","⑤","⑥","⑦","⑧"];
      const ALL_ITEMS = [
        { label: "ご入居時期",                                key: "入居:" },
        { label: "ご希望家賃（管理費込み）",                    key: "家賃:" },
        { label: "ご希望間取り",                               key: "間取り:" },
        { label: "ご希望築年数",                               key: "築年数:" },
        { label: "ご希望エリア・最寄り駅",                      key: "エリア:" },
        { label: "駅からの徒歩分数",                           key: "駅徒歩:" },
        { label: "初期費用ご予算",                             key: "初期費用" },
        { label: "その他こだわり条件（ペット・保証人・駐車場等）", key: "その他:" },
      ];
      // 条件テキストに key が含まれていれば「既知」→ 除外
      const missing = condText
        ? ALL_ITEMS.filter(item => !condText.includes(item.key))
        : ALL_ITEMS;
      // 全部埋まっていた場合は全項目を聞く（フォールバック）
      const showItems = missing.length > 0 ? missing : ALL_ITEMS;
      // 番号を①②③…と詰めて振り直す
      const formItems = showItems
        .map((item, i) => `${CIRCLE_NUMS[i]}${item.label}`)
        .join("\n");

      // name は「あさみさん」形式（さん付き）なのでそのまま使う
      message_text = `（${name}ご希望のお部屋探しご条件）
${formItems}`;

      // LL-09: フォームに添える導入メッセージをAI生成（学習ループ対象化）
      try {
        const [hearingDiffNote, hearingStarNote] = await Promise.all([
          getKnowledgeForState([...AIX_ACTION_TO_STATES.condition_hearing, "first_reply"], currentAction, conversationId, latestCustomerMsg),
          getStarredExamplesForAction([...AIX_ACTION_TO_STATES.condition_hearing, "first_reply"], latestCustomerMsg || ""),
        ]);

        const hearingSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
お客様への条件ヒアリングの導入メッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【このメッセージの目的】
・次のメッセージで条件ヒアリングフォーム（①ご入居時期②ご希望家賃…の箇条書き）を送る予告をする
・「お部屋探しのご条件を教えてもらえますか」的な内容を自然に伝える

【スモラのLINEスタイル — 厳守】
・「！！」（全角感嘆符2つ）を使う
・お客様名（${name}）で呼びかける
・絵文字は 😊 😌 のみ・1〜2個まで
・50〜100文字程度・2〜3行まで
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）
・条件項目の箇条書き自体はこのメッセージに含めない（フォームは別送するため）${greetingTimeNote}${hearingDiffNote}${hearingStarNote}`;

        const hearingResult = await callClaude(
          hearingSystem,
          `${name}へのヒアリング導入メッセージを作成してください。${latestCustomerMsg ? `\nお客様の最新メッセージ: ${latestCustomerMsg}` : ""}${recentHistory}`,
          currentAction
        );
        hearing_intro_result = hearingResult.trim();
      } catch {
        // 導入メッセージ生成失敗でも固定フォームはそのまま送れる
      }

    } else if (action === "extract_datetime") {
      // 会話履歴から内覧日時をAIで抽出（待ち合わせ場所の日程・時間フィールド自動補完用）
      const msgs = (Array.isArray(recent_messages) ? (recent_messages as Array<{ sender?: string; text?: string }>) : [])
        .filter(m => m.text && m.text !== "[画像]" && m.text !== "[動画]")
        .slice(-20)
        .map(m => `${m.sender === "customer" ? "お客様" : "スモラ"}: ${m.text}`)
        .join("\n");

      if (!msgs) return NextResponse.json({ ok: true, date: "", time: "" });

      // 本日のJST日付（相対日付「明日」「来週」等の解決用）
      const jstToday = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const jstWeekday = ["日", "月", "火", "水", "木", "金", "土"][jstToday.getUTCDay()];
      const jstTodayStr = `${jstToday.getUTCFullYear()}/${jstToday.getUTCMonth() + 1}/${jstToday.getUTCDate()}(${jstWeekday})`;

      const system = `あなたは会話テキストから内覧の日程と時間を抽出するアシスタントです。
以下の会話から、内覧・案内の日程と時間を抽出してください。

【本日の日付（JST）】
${jstTodayStr}
・「明日」「明後日」「来週」「今週土曜」などの相対的な日付表現は、本日の日付を基準に実際の日付へ変換すること

【出力ルール（JSON1行のみ）】
{"date":"7/3（金）","time":"10:00"}

・dateは「月/日（曜日）」形式（例: 7/3（金）、7/3）
・timeは「HH:MM」の24時間表記（例: 10:00、14:30）
・お客様が確定・承諾した日時を最優先で抽出する
・日程は見つかるが時間が不明な場合はtimeを空文字に
・どちらも不明な場合は両方空文字に
・JSONのみ返す（説明文・コメント不要）`;

      try {
        const raw = await callClaudeHaiku(system, msgs, currentAction);
        const jsonMatch = raw.match(/\{[^}]+\}/);
        if (!jsonMatch) return NextResponse.json({ ok: true, date: "", time: "" });
        const parsed = JSON.parse(jsonMatch[0]) as { date?: string; time?: string };
        return NextResponse.json({ ok: true, date: parsed.date || "", time: parsed.time || "" });
      } catch {
        return NextResponse.json({ ok: true, date: "", time: "" });
      }

    } else if (action === "greeting_viewing") {
      const sub_mode = body.sub_mode as "before" | "after";
      const viewing_date = body.viewing_date ? String(body.viewing_date) : "";
      const viewing_time = body.viewing_time ? String(body.viewing_time) : "";

      if (sub_mode === "before") {
        const dateInfo = viewing_date
          ? `・内覧日: ${viewing_date}${viewing_time ? ` ${viewing_time}` : ""}`
          : "";

        const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
内覧当日に送る「内覧前挨拶」LINEメッセージを生成してください。

【出力構成（この3行構成を厳守・一字一句このフォーマット）】
①「${name}${greetingPhrase}」
②「本日〇〇時お部屋ご案内させて頂きます！」（〇〇を時刻に置き換え。時刻がなければ「本日お部屋ご案内させて頂きます！」）
③「本日は何卒よろしくお願い致します！！」

【時刻フォーマット】
・「14:00」→「14時」、「14:30」→「14時半」のように自然な日本語に変換する
・「！！」は①③のみ。②は「！」1つ

【禁止】
・3行以外の追加は一切しない。解説・絵文字・補足は不要`;

        // 学習済み差分ルール（スタッフ修正から学習したパターン）をプロンプト末尾に注入
        const beforeDiffNote = await getKnowledgeForState(AIX_ACTION_TO_STATES.greeting_viewing, currentAction, conversationId, latestCustomerMsg);

        message_text = await callClaude(
          system + beforeDiffNote + greetingTimeNote,
          `${name}への内覧前挨拶を生成してください。${dateInfo}${recentHistory}`,
          currentAction
        );

      } else {
        // 内覧後 4択フロー
        const after_type = body.after_type as string | undefined;
        const property_label = body.property_label ? String(body.property_label).trim() : "";
        const freeword = body.freeword ? String(body.freeword).trim() : "";
        const thankLine = `${name}本日お時間頂きありがとうございました！！`;

        // 学習済み差分ルール: AI生成サブパス（confirm_freeword / search_expand / search_change / フォールバック）のみ取得。
        // 固定テンプレサブパス（apply / apply_guide / confirm_estimate / search_new）はAIを呼ばないため対象外
        const AFTER_FIXED_TYPES = ["apply", "apply_guide", "confirm_estimate", "search_new"];
        const afterDiffNote = AFTER_FIXED_TYPES.includes(after_type ?? "")
          ? ""
          : await getKnowledgeForState(AIX_ACTION_TO_STATES.greeting_viewing, currentAction, conversationId, latestCustomerMsg);

        if (after_type === "apply") {
          // 申込
          const propLine = property_label ? `${property_label}お申込しお部屋抑えさせて頂きます！` : "お申込しお部屋抑えさせて頂きます！";
          message_text = `${thankLine}\n${propLine}`;

        } else if (after_type === "apply_guide") {
          // 申込誘導
          const propLine = property_label
            ? `${property_label}お気に召されましたらお申込しお部屋抑えさせて頂きます！気になる点出てきましたらお気軽にご連絡ください！`
            : "お気に召されましたらお申込しお部屋抑えさせて頂きます！気になる点出てきましたらお気軽にご連絡ください！";
          message_text = `${thankLine}\n${propLine}`;

        } else if (after_type === "confirm_estimate") {
          // 確認事項 / 見積書 → 2通目テキスト生成
          const propLine = property_label
            ? `${property_label}の御見積書となります。${name}お気に召されましたらお申込しお部屋抑えさせて頂きます！！お手隙の際にご査収ください！！`
            : `御見積書となります。${name}お気に召されましたらお申込しお部屋抑えさせて頂きます！！お手隙の際にご査収ください！！`;
          message_text = `本日ご内覧頂きありがとうございました！！\n${propLine}`;

        } else if (after_type === "confirm_freeword") {
          // 確認事項 / フリーワード → AI生成
          const sys = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
内覧後に送るメッセージを1つ生成してください。
1行目: 「${name}本日お時間頂きありがとうございました！！」（固定）
2行目以降: 以下の確認事項を踏まえた自然なメッセージ（2〜3行まで）
・感嘆符は「！！」スモラ文体で。補足・解説は不要

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}`;
          message_text = await callClaude(sys + afterDiffNote, `確認事項: ${freeword}${recentHistory}`, currentAction);

        } else if (after_type === "search_new") {
          // 引き続き物件探す / 新着探す
          message_text = `${thankLine}\n引き続き新着でおすすめできる物件が出次第ご連絡させて頂きます！`;

        } else if (after_type === "search_expand") {
          // 引き続き物件探す / 条件広げる → AI生成
          const sys = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
内覧後に送るメッセージを生成してください。
1行目: 「${name}本日お時間頂きありがとうございました！！」（固定）
2行目: 「{条件情報}でご条件に合ったお部屋ピックアップしご連絡させて頂きます！」の形で条件を自然に組み込む
・スモラ文体・感嘆符「！！」・補足不要

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}`;
          message_text = await callClaude(sys + afterDiffNote, `条件: ${freeword}${recentHistory}`, currentAction);

        } else if (after_type === "search_change") {
          // 引き続き物件探す / 条件変更 → AI生成
          const sys = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
内覧後に送るメッセージを生成してください。
1行目: 「${name}本日お時間頂きありがとうございました！！」（固定）
2行目: 「{変更後条件}で物件ピックアップしお送りさせて頂きます！」の形で条件を自然に組み込む
・スモラ文体・感嘆符「！！」・補足不要

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}`;
          message_text = await callClaude(sys + afterDiffNote, `変更条件: ${freeword}${recentHistory}`, currentAction);

        } else {
          // フォールバック（after_type未指定 = 旧フロー）
          const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
内覧後に送る「内覧後挨拶」LINEメッセージを3行で生成してください。
①「本日はお忙しいところご内覧頂きありがとうございます！！」
②「いかがでしたでしょうか？！」
③「気になる点ございましたらお気軽にお申し付けください！！」
・「！！」を文末に使う・3行のみ出力`;
          message_text = await callClaude(system + afterDiffNote, `${name}への内覧後挨拶を生成してください。${recentHistory}`, currentAction);
        }
      }

    } else if (action === "meeting_place") {
      // conversation_match: テンプレ固定なし・会話から日時・物件を読んで自然な待ち合わせ文を生成
      if (body.conversation_match) {
        const [mpDiffNote, mpStarNote] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.meeting_place, currentAction, conversationId, latestCustomerMsg),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.meeting_place, latestCustomerMsg),
        ]);
        const mpPropertyName = body.meeting_property_name ? String(body.meeting_property_name) : "";
        const mpAddress = body.meeting_property_address ? String(body.meeting_property_address) : "";
        const mpDate = body.meeting_date ? String(body.meeting_date) : "";

        const mpSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】「${name}」
${mpPropertyName ? `【物件名】${mpPropertyName}` : ""}
${mpAddress ? `【住所】${mpAddress}` : ""}
${mpDate ? `【内覧日】${mpDate}` : ""}

【この返信の目的】
・内覧の日程・時間が確定したので「かしこまりました！！」で承認し、待ち合わせ場所を確定する
・現地エントランスが待ち合わせ場所（物件名＋住所があれば含める）
・会話から時間を読み取って「〇時に〇〇物件 現地エントランスお待ち合わせ」の形で締める

【重要：会話読解ルール（必ず守ること）】
・会話から内覧の確定日時を読み取り、そのまま確定メッセージに使う
・時間が会話に出ていない場合は「[お時間]」としてプレースホルダーを残す
・テンプレ的な返信は絶対禁止

【絶対禁止】
・🙏 絵文字は絶対に使わない

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;

        const rawMP = await callClaude(
          mpSystem + greetingTimeNote + mpDiffNote + mpStarNote,
          `${recentHistory}\n\n上記の会話を読み取り、${name}への待ち合わせ確定メッセージを生成してください。`,
          currentAction
        );
        try {
          const mMP = rawMP.match(/\{[\s\S]*?\}/);
          if (mMP) {
            const dMP = JSON.parse(mMP[0]) as { message?: string };
            message_text = (dMP.message || rawMP).replace(/\\n/g, "\n");
          } else { message_text = rawMP; }
        } catch { message_text = rawMP; }
        return NextResponse.json({ ok: true, message_text });
      }

      const mDate = body.meeting_date ? String(body.meeting_date) : "";
      const mName = body.meeting_property_name ? String(body.meeting_property_name) : "";
      const mAddr = body.meeting_property_address ? String(body.meeting_property_address) : "";

      // 学習済み差分ルール（スタッフ修正から学習したパターン）＋☆成功返信パターンをプロンプト末尾に注入
      const [meetingDiffNote, meetingStarNote] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.meeting_place, currentAction, conversationId, latestCustomerMsg),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.meeting_place, latestCustomerMsg),
      ]);

      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
会話履歴を読み取り、待ち合わせ確認メッセージを生成してください。

【出力形式（一字一句この構成で）】
かしこまりました！！
${mDate}ご案内させて頂きます！！

${mDate}[時間]に${mName}
現地エントランスお待ち合わせで何卒よろしくお願い致します！！${mAddr ? `\n住所: ${mAddr}` : ""}

【時間の読み取りルール】
・会話履歴から待ち合わせの時間（例：11時、14:00、午後2時など）を読み取り [時間] に当てはめること
・「11時」→「11:00」、「14時30分」→「14:30」のように整形すること
・時間が会話に見当たらない場合は [時間] をそのまま残すこと
・構成・文言は一切変えず [時間] だけを置き換えること

【スモラLINE営業ルール（必ず守る・ただし上記の出力形式が最優先）】
${SMORA_COMMON_RULES}`;

      message_text = await callClaude(system + greetingTimeNote + meetingDiffNote + meetingStarNote, `会話履歴から待ち合わせ時間を読み取り、メッセージを生成してください。${recentHistory}`, currentAction);

    // ── ✅ 確認します ──────────────────────────────────────────────
    } else if (action === "acknowledge_check") {
      // conversation_match: 会話から確認内容を正確に読み取って自然な管理会社向けメッセージを生成
      if (body.conversation_match) {
        const ackCMDiffNote = await getKnowledgeForState(AIX_ACTION_TO_STATES.acknowledge_check, currentAction, conversationId, latestCustomerMsg);
        const ackCMLabel = familyName ? `${familyName}さん` : "お客様";

        const ackCMSystem = `あなたは賃貸仲介サービス「スモラ」のLINE担当スタッフです。
管理会社・オーナーへの物件確認メッセージ（LINE）を生成してください。

${SMORA_COMMON_RULES}

【メッセージの宛先】管理会社またはオーナー（お客様宛てではない）
【案内しているお客様名】「${ackCMLabel}」

【重要：会話読解ルール（必ず守ること）】
・会話から「どの物件・号室・何を確認したいのか」を正確に読み取る
・物件名・号室が会話に出ていれば必ず含める（創作禁止）
・お客様の具体的な疑問・状況に合わせた確認内容を1〜2行で書く

【構成ルール（この順番で・必ず守ること）】
① 書き出し: 「${ackCMLabel}のご案内をしております！！」
② 確認内容: 会話から読み取った物件名・号室・確認事項を正確に1〜2行
③ 初期費用（必須）: 「あわせて最大限割引した初期費用の御見積もりもお願いできますでしょうか！！」
④ 締め: 「ご確認頂けますと幸いです！！よろしくお願い致します！！」

【禁止事項】
・「お世話になっております」は使わない
・「様」を使わない（「さん」で統一）
・物件名・号室を創作しない
・🙏絵文字は絶対禁止
・絵文字は😊のみ1個まで

【文字数】4〜6行のコンパクトなメッセージ${greetingTimeNote}${ackCMDiffNote}`;

        const rawACM = await callClaude(
          ackCMSystem,
          `${ackCMLabel}のご案内について、物件の管理会社へ送る確認メッセージを生成してください。${extra_input ? `\n補足: ${extra_input}` : ""}${recentHistory}`,
          currentAction
        );
        message_text = rawACM;
        return NextResponse.json({ ok: true, message_text });
      }

      const ackDiffNote = await getKnowledgeForState(AIX_ACTION_TO_STATES.acknowledge_check, currentAction, conversationId, latestCustomerMsg);
      // ★宛先はお客様ではなく物件の管理会社・オーナー。スモラは全LINEで「さん」表記のため familyName＋さん で組み立てる
      const ackCustomerLabel = familyName ? `${familyName}さん` : "お客様";
      const ackSystem = `あなたは賃貸仲介サービス「スモラ」のLINE担当スタッフです。
管理会社・オーナーへの物件確認メッセージ（LINE）を生成してください。

${SMORA_COMMON_RULES}

【メッセージの宛先】管理会社またはオーナー（お客様宛てではない）

【お客様名】「${ackCustomerLabel}」のご案内をしております

【構成ルール（この順番で・必ず守ること）】
① 書き出し: 「${ackCustomerLabel}のご案内をしております！！」
② 確認内容: 会話から読み取った物件名・号室・確認事項を正確に1〜2行
  例: 「○○マンション○号室の募集状況を確認させていただきます！！」
  ※物件名・号室が会話から取れない場合は「ご提案物件」を使う（創作禁止）
③ 初期費用（必須）: 「あわせて最大限割引した初期費用の御見積もりもお願いできますでしょうか！！」
④ 締め: 「ご確認頂けますと幸いです！！よろしくお願い致します！！」

【禁止事項】
・「お世話になっております」は使わない
・「様」を使わない（「さん」で統一）
・物件名・号室を創作しない（会話から取れない場合は「ご提案物件」を使う）
・🙏絵文字は絶対禁止
・「承りました」「少々お待ちください」「確認中です」禁止
・絵文字は😊のみ1個まで（なくても可）

【文字数】4〜6行のコンパクトなメッセージ${greetingTimeNote}${ackDiffNote}`;

      message_text = await callClaude(
        ackSystem,
        `${ackCustomerLabel}のご案内について、物件の管理会社へ送る「募集状況確認 ＋ 最大限割引した初期費用の御見積もり依頼」メッセージを生成してください。${extra_input ? `\n補足: ${extra_input}` : ""}${recentHistory}`,
        currentAction
      );

    // ── 📣 追客する ──────────────────────────────────────────────
    } else if (action === "followup_revive") {
      const followSubMode = body.follow_sub_mode as string | undefined;
      const followPropertyName = (body.property_name as string | undefined) || "";

      // ── 申込補足情報催促 ────────────────────────────────────────────────────
      if (followSubMode === "apply_supplement") {
        const [supDiffNote, supStarNote] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.followup_revive, currentAction, conversationId, latestCustomerMsg),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.followup_revive, latestCustomerMsg),
        ]);

        const supSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
お申込み手続き中のお客様へ、まだ頂けていない申込書類・情報のご提出をお願いするLINEメッセージを1つ生成してください。

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}

【構成ルール（この順番で・必ず守ること）】
① 書き出し: 「${name}お世話になっております！！」
② 依頼の導入: 「お申込みに際しまして以下のものをご準備いただく必要がございます！！」
③ 必要書類・情報を「・」の箇条書きで列挙する
  ※補足情報に「まだ頂けていない書類」の指定がある場合は、それだけを列挙する（最優先・勝手に追加しない）
  ※補足情報がない場合は以下の一般的な申込書類を列挙する:
  ・身分証明書（免許証・マイナンバーカード等）
  ・収入証明書（源泉徴収票等）
  ・緊急連絡先のご情報（氏名・続柄・携帯番号）
  ※連帯保証人を立てるお申込みと会話・補足から読み取れる場合のみ「・連帯保証人の印鑑証明書」を追加する
④ 締め: 「上記お送り頂き次第お申込み完了致します！！」（書類が1点だけの場合はその書類名を入れる。例:「収入証明書頂き次第お申込み完了致します！！」）
⑤ 最終行: 「どうぞよろしくお願いいたします！！」

【禁止事項】
・会話履歴で既にご提出済みの書類・情報を再度求めない
・同じ書類を重複して列挙しない
・補足情報に指定がある場合、指定にない書類を勝手に追加しない
・「様」を使わない（「さん」で統一）
・🙏絵文字は絶対禁止
・「承りました」「少々お待ちください」「確認中です」禁止

【文字数】箇条書きを含めて2〜5行程度・完成したLINEメッセージのみを出力（JSONや説明文は不要）`;

        const supUser = `${name}への「お申込みに必要な書類・情報のご提出をお願いする」催促メッセージを生成してください。${extra_input ? `\n【まだ頂けていない書類・補足情報（最優先で使うこと）】${extra_input}` : ""}${recentHistory}`;
        message_text = await callClaude(supSystem + greetingTimeNote + supDiffNote + supStarNote, supUser, currentAction);

      // ── 物件探し継続確認 ──────────────────────────────────────────────────
      } else if (followSubMode === "search_continue") {
        const [scDiffNote, scStarNote] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.followup_revive, currentAction, conversationId, latestCustomerMsg),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.followup_revive, latestCustomerMsg),
        ]);

        const scSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
しばらく連絡が取れていないお客様へ、新着物件をきっかけにお部屋探しを継続されているか軽く確認するLINEメッセージを1つ生成してください。

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}

【構成ルール（この順番で・必ず守ること）】
① 書き出し: 「${name}お世話になっております！！」
② 新着のご連絡: ${followPropertyName ? `「新しく${followPropertyName}が募集にでましたのでご連絡させていただきました！！」` : `「新しくオススメ出来る物件が募集にでましたのでご連絡させていただきました！！」`}
  ※補足情報に物件の特徴（駅近・築浅・家賃など）があれば、②に一言だけ自然に添えてよい
③ 締め: 「お部屋お探し継続されていますでしょうか！！」

【トーン】
・押しつけがましくない・軽いタッチ
・返信を強要する表現（「ご返信ください」「お早めに」等）は使わない・③の一文で終える

【禁止事項】
・補足情報にない物件の設備・家賃・条件を創作しない
・物件名を創作しない（${followPropertyName ? `「${followPropertyName}」以外の物件名を出さない` : "物件名が不明な場合は「オススメ出来る物件」のままにする"}）
・「様」を使わない（「さん」で統一）
・🙏絵文字は絶対禁止

【文字数】2〜3行程度・完成したLINEメッセージのみを出力（JSONや説明文は不要）`;

        const scUser = `${name}への物件探し継続確認メッセージを生成してください。${followPropertyName ? `\n物件名: ${followPropertyName}` : ""}${extra_input ? `\n補足（物件の特徴など）: ${extra_input}` : ""}${recentHistory}`;
        message_text = await callClaude(scSystem + greetingTimeNote + scDiffNote + scStarNote, scUser, currentAction);

      // conversation_match: 過去の会話文脈を最大活用した自然な追客メッセージを生成
      } else if (body.conversation_match) {
        const [followupCMDiffNote, followupCMStarNote] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.followup_revive, currentAction, conversationId, latestCustomerMsg),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.followup_revive, latestCustomerMsg),
        ]);

        const followupCMSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】「${name}」

【この返信の目的】
・しばらく連絡が取れていないお客様への追客メッセージ
・お客様の直近の会話内容（条件・物件・懸念点）を引き合いに出して、具体的に再接触する
・「その後いかがでしょうか！！」から始めつつ、過去の会話から1つ具体的な話題を引き出す
・補足情報（新着物件・条件変更提案等）があれば自然に盛り込む
・2〜4行程度・押しつけがましくないトーン

【重要：会話読解ルール（必ず守ること）】
・過去の会話で話題になっていた物件名・条件・懸念点を必ず1つ以上引き出す
・「前回お送りした〇〇の件ですが」等、具体的な言及で再接触の必然性を作る
・テンプレ的な返信は絶対禁止

【絶対禁止】
・🙏 絵文字は絶対に使わない
・会話を読まずに汎用的な「その後いかがでしょうか」だけで終わる

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;

        const rawFCM = await callClaude(
          followupCMSystem + greetingTimeNote + followupCMDiffNote + followupCMStarNote,
          `${recentHistory}\n\n上記の会話を深く読み取り、${name}への追客メッセージを生成してください。${extra_input ? `\n補足情報: ${extra_input}` : ""}`,
          currentAction
        );
        try {
          const mFCM = rawFCM.match(/\{[\s\S]*?\}/);
          if (mFCM) {
            const dFCM = JSON.parse(mFCM[0]) as { message?: string };
            message_text = (dFCM.message || rawFCM).replace(/\\n/g, "\n");
          } else { message_text = rawFCM; }
        } catch { message_text = rawFCM; }
        return NextResponse.json({ ok: true, message_text });
      } else {

      const [followupDiffNote, followupStarNote] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.followup_revive, currentAction, conversationId, latestCustomerMsg),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.followup_revive, latestCustomerMsg),
      ]);
      const followupSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
しばらく連絡が取れていないお客様への追客LINEメッセージを1つ生成してください。

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}

【追客メッセージのルール】
・${name}と呼びかけ、現在もお部屋探しをサポートする意思を伝える
・「その後いかがでしょうか！！」などの近況確認から入ると自然
・補足情報（extra_input）がある場合は活用する（例: 新着物件あり、条件変更の提案など）
・押しつけがましくならず、お客様のペースを尊重した文体
・2〜4行程度・完成したLINEメッセージのみ出力${greetingTimeNote}${followupDiffNote}${followupStarNote}`;

      message_text = await callClaude(
        followupSystem,
        `${name}への追客メッセージを生成してください。${extra_input ? `\n補足: ${extra_input}` : ""}${recentHistory}`,
        currentAction
      );
      }

    } else {
      return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }

    // 号室の先頭ゼロを除去（日本の号室は0始まりにならない: 0906→906）
    message_text = message_text.replace(/(?<!\d)0+(\d+)号室/g, "$1号室");

    // AIが内部メモを出力した場合、顧客向けメッセージと分離してnoticeとして返す
    const { message: cleanedMessage, notice } = extractNotice(message_text, familyName || rawName);

    return NextResponse.json({
      ok: true,
      message_text: cleanedMessage,
      ...(notice ? { notice } : {}),
      ...(parsed_estimate_result ? { parsed_estimate: parsed_estimate_result } : {}),
      ...(estimate_text_result ? { estimate_text: estimate_text_result } : {}),
      // 各ピッカーのパーツ別生成結果（コンポーネント学習ループ用）
      ...(aiComponents ? { ai_components: aiComponents } : {}),
      // viewing_invite AIX生成ドラフト（差分学習ループ用: スタッフが編集して送った場合に差分を記録）
      ...(viewingInviteDraft ? { aiDraft: viewingInviteDraft } : {}),
      // estimate_sheet のAIカバーレター（LL-07）: フロントのプレビュー表示用 + 学習ループ用ドラフト
      ...(cover_letter ? { coverLetter: cover_letter, aiDraft: cover_letter } : {}),
      // condition_hearing のAI導入メッセージ（LL-09）: フロントのプレビュー表示用 + 学習ループ用ドラフト
      ...(hearing_intro_result ? { hearingIntro: hearing_intro_result, aiDraft: hearing_intro_result } : {}),
    });
  } catch (err) {
    console.error("[aix/action]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
