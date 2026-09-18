import { NextRequest, NextResponse, after } from "next/server";
import { AsyncLocalStorage } from "node:async_hooks";
import { logLlmUsage } from "@/app/lib/llm-usage-log";
// 2026-09-17 竹内（AIX キャッシュ点検）: system を「共通 prefix（1h）→ 準静的（1h）→ 経路固有（5m）→ 動的（なし）」のブロックに分ける
import { buildSystemBlocks, systemStaticLength, splitSharedPrefix, llmMetaHeaderValue, LLM_META_HEADER_ACTION, LLM_META_HEADER_CONVERSATION, type SystemSpec, type SystemSpecBlocks, type SystemTtl } from "@/app/lib/aix-system-blocks";
import { supabase } from "@/app/lib/supabase";
import { resolveBrainMetaForGeneration, BRAIN_META_RESTORE_COLUMNS, type BrainMetaRow } from "@/app/lib/brain-meta-load";
import { safeSlice } from "@/app/lib/safe-slice";
import { fixDateWeekdays, weekdayTable, jstDayStartMs } from "@/app/lib/jst-date";
import { stripMetaNarration } from "@/app/lib/meta-narration";
import { normalizeBannedPhrasing, stripHeadGreeting } from "@/app/lib/banned-phrasing";
// 2026-09-16 竹内（カイナ事例）: 申込のお部屋が決まっていない時の候補の号室
import { parseRoomChoices, shouldAskRoomChoice, roomChoiceNote, stripUngroundedRoomNo } from "@/app/lib/room-choices";
import { PHONE_FOLLOWUP_STAFF_EXAMPLES, maskNumbersNotInNotes } from "@/app/lib/phone-call";
import { resolveLatestQuotedContext, formatQuotedContextBlock, propertyLabelsForImages } from "@/app/lib/quoted-context";
import { avoidTopicsForAix } from "@/app/lib/aix-staff-first";
import { viewingReportNoteForReply } from "@/app/lib/viewing-report";
import { loadViewingReports } from "@/app/lib/viewing-report-store";
import { generateEmbedding, extractPropertyDetailsFromImage } from "@/app/lib/knowledge-utils";
import { SMORA_COMMON_RULES, AIX_PROPERTY_RECOMMENDATION_RULES, AIX_PROPERTY_SEND_RULES, GENERATION_SYSTEM, CURATED_REPLY_RULES, CRITICAL_RULES_COMPACT, REAL_ESTATE_RULES } from "@/app/lib/line-reply-prompts";
import { fetchPromptRules, fetchPromptRulesSplit } from "@/app/lib/prompt-rules";
import { isPlausiblePersonName } from "@/app/lib/validate-reply";
import { aixStream, budgetSignal, remainingMs, type AixEvent, type AixStreamCtx } from "@/app/lib/aix-stream";
import { COST_BREAKDOWN_OCR_SYSTEM, COST_BREAKDOWN_STAFF_EXAMPLES, parseCostBreakdownJson, formatCostBreakdownFacts, checkAmountsAgainstBreakdown, type CostBreakdown } from "@/app/lib/cost-breakdown";
import { stripReplyOnlyPhrases } from "@/app/lib/aix-send-phrasing";
import { ensureVacatingNotice, buildVacatingPromptNote, viewableFromVacancyDate, viewableFromVacancyYmd, vacancyDateLabel, vacatingViewableSentence } from "@/app/lib/vacating-notice";
// 2026-09-19 竹内（内覧調整の会話を合わせる）: 退去前の候補の行を出口で落とす
import { stripSlotLinesBeforeViewable } from "@/app/lib/viewing-window";
// 2026-09-19 竹内（初期費用を説明の会話を合わせる）: 材料と出口（金額の照合・仲介手数料の言い方）
import { buildCostExplainFactsNote, checkCostFacts, fixBrokerFeeWording, ensureCostDetail } from "@/app/lib/cost-explain-text";
// 2026-09-17 竹内（物件オススメ・現状伝えて1件）: 探した現状を🌟の前に1文で伝える
import { isSituationKind, situationOpeningLine, buildSituationPromptNote, ensureSituationOpening } from "@/app/lib/recommendation-situation";
// 2026-09-17 竹内（✩ さん事例）: ピックアップ行に物件名を入れない
import { stripPropertyNameFromPickupLine, PICKUP_LINE_NOTE } from "@/app/lib/pickup-line";
import { extractPropertyLabels } from "@/app/lib/action-ledger";
// 2026-09-18 竹内（𝒮 さん事例）: 1件しか送っていないなら比較の言い方を書かない／まだ内覧できない部屋は申込誘導
import { fixRecommendClosing } from "@/app/lib/recommend-closing";
// 2026-09-18 物件の状況（送った件数・退去予定・内覧可否）はブレインの判断を1つの関数から読む（AIX / テンプレート共通）
import { resolvePropertySendState, describePropertySendState } from "@/app/lib/property-send-state";
// 2026-09-18 竹内: 見積書に添えるキャンペーンの1文（スタッフの入力をそのまま・骨組みは実送信の形）
import { buildCampaignNote, ensureCampaignLine } from "@/app/lib/estimate-campaign";
import { buildGuarantorInfoText, formatGuarantorFacts, checkGuarantorFacts, resolveGuarantor, buildGuarantorCheckNote, GUARANTOR_INFO_STAFF_EXAMPLES, isGuarantorType, type GuarantorProperty, type GuarantorType } from "@/app/lib/guarantor-companies";
import { PROPERTY_SEND_MATCH_STAFF_EXAMPLES, extractPropertySendThreads, buildPropertySendThreadsBlock, stripViewingInviteLines, stripRepeatedThanksLines, fixPickupTense, ensureRequirementLine, ensureDeadlineSupportLine, stripUnanchoredThanksLines, freshCustomerTexts, stripUngroundedClaims } from "@/app/lib/property-send-match";
// 2026-09-16 竹内（𝒮 さん事例）: 会話の時刻（履歴の行に時刻が無い）・「先程」の直し
import { buildConversationClockNote, fixStaleRecentReference, absolutizeRelativeDays, jstDayLabel } from "@/app/lib/relative-date";
// 2026-09-16 竹内（𝒮 さん事例）: 1日に出す内覧の時間は1つ（お客様が日にちを指定した日だけ空き時間を全部）
import { limitViewingSlotsInReply } from "@/app/lib/viewing-slots";
// 2026-09-16 竹内（💜 さん事例）: 申込の情報を受け取った時の開口語・管理会社の営業時間外の「明日確認してご連絡」
import { isMgmtAfterHours, ensureAfterHoursApplyLine, stripLeadingBareAck, APPLY_INFO_SENT_RE } from "@/app/lib/after-hours";
// 2026-09-16 竹内（カイナ事例）: 物件確認した×会話を合わせる — 内覧の流れの判定・部屋数・出口の決定論
import { resolveViewingThread, buildViewingThreadBlock, stripEstimatePromiseLines, stripNewSlotLines, ensureViewingContinuationLine, resolveEnclosedRooms, buildEnclosedCountLines, ensureRoomCountPhrase, ESTIMATE_PROMISE_LINE_RE, NEW_SLOT_LINE_RE, VIEWING_CONTINUATION_LINE } from "@/app/lib/viewing-thread";

export const maxDuration = 300;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const MODEL = "claude-sonnet-5";

// ── OCR result cache (session-level, FIFO, max 50 entries) ──────────────────
// Key: image URL or composite "primaryUrl|secondaryUrl"  Value: Claude OCR text
// Scope: module-level → survives multiple requests on the same Vercel instance.
// FIFO eviction: when size reaches 50, delete the oldest key (Map insertion order).
const _ocrCache = new Map<string, string>();
const OCR_CACHE_MAX = 50;

function ocrCacheGet(key: string): string | undefined {
  return _ocrCache.get(key);
}

function ocrCacheSet(key: string, result: string): void {
  if (_ocrCache.size >= OCR_CACHE_MAX) {
    const firstKey = _ocrCache.keys().next().value;
    if (firstKey !== undefined) _ocrCache.delete(firstKey);
  }
  _ocrCache.set(key, result);
}

// ── Brain template cache (5-min TTL = Anthropic ephemeral cache TTL) ──────────
// weekly-learning が aix_brain_templates.addendum_text を更新したとき、
// 最大5分以内にロールアウトされる。Anthropic側のキャッシュ更新タイミングと一致。
const _templateCache = new Map<string, { text: string; exp: number }>();
const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadBrainTemplate(actionType: string): Promise<string> {
  const now = Date.now();
  const cached = _templateCache.get(actionType);
  if (cached && now < cached.exp) return cached.text;
  const { data } = await supabase
    .from("aix_brain_templates")
    .select("addendum_text")
    .eq("action_type", actionType)
    .maybeSingle();
  const text = data?.addendum_text ?? "";
  _templateCache.set(actionType, { text, exp: now + TEMPLATE_CACHE_TTL_MS });
  return text;
}

// 全AIXアクション共通で末尾に注入するルールセット:
// ① CURATED_REPLY_RULES … 確認済み返信ルール（「ご案内可能です」禁止・18時以降の管理会社確認・30日前ルール等）
// ② CRITICAL_RULES_COMPACT … でっち上げ禁止・数字変形禁止・マークダウン太字禁止 等のクリティカル禁止ルール
const AIX_CURATED_AND_CRITICAL_RULES = `\n\n${CURATED_REPLY_RULES}\n\n${CRITICAL_RULES_COMPACT}`;

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

// 設備情報テキストを生成するヘルパー（property_check_result available パスで使用）
type PropFacilityData = {
  parkingAvail: string | null;
  parkingFee: string | null;
  parkingVacancy: string | null;
  bikeParking: string | null;
  bikeParkingFee: string | null;
  bikeParkingNote: string | null;
  petPolicy: string | null;
  petCondition: string | null;
  internet: string | null;
  internetDetail: string | null;
  // 2026-09-17 竹内（YUYA 事例）: 保証会社は「名前＋種類」で1つの材料（画面では見積書の下の欄）。
  //   種類は GuarantorType（independent/licc/credit/unknown）。旧クライアントの日本語（独立系・信用系）も読む
  guarantorName?: string | null;
  guarantorType: string | null;
};
/** 物件ごとの保証会社（名前＋種類）を取り出す。種類が無ければ会社名から決める（画面と同じ resolveGuarantor） */
function guarantorPropertyOf(name: string, f: PropFacilityData | undefined | null): GuarantorProperty | null {
  const company = (f?.guarantorName ?? "").trim();
  if (!company) return null;
  const raw = (f?.guarantorType ?? "").trim();
  // 旧クライアント（設備情報の「独立系／信用系」チップ）の日本語も受ける
  const legacy: Record<string, GuarantorType> = { "独立系": "independent", "信用系": "licc", "LICC系": "licc", "信販系": "credit", "不明": "unknown" };
  const type: GuarantorType = isGuarantorType(raw) ? raw : (legacy[raw] ?? resolveGuarantor(company).type);
  return { name: (name ?? "").trim(), company, type };
}
function buildFacilityLines(f: PropFacilityData): string[] {
  const lines: string[] = [];
  if (f.parkingAvail === 'あり') {
    let t = '駐車場：あり';
    if (f.parkingFee) t += `（${f.parkingFee}）`;
    if (f.parkingVacancy) t += ` / ${f.parkingVacancy}`;
    lines.push(t);
  } else if (f.parkingAvail === 'なし') {
    lines.push('駐車場：なし');
  }
  if (f.bikeParking === 'あり') {
    let t = 'バイク置き場：あり';
    if (f.bikeParkingFee) t += `（${f.bikeParkingFee}）`;
    if (f.bikeParkingNote) t += ` / ${f.bikeParkingNote}`;
    lines.push(t);
  } else if (f.bikeParking === 'なし') {
    lines.push('バイク置き場：なし');
  }
  if (f.petPolicy) {
    let t = `ペット：${f.petPolicy}`;
    if (f.petCondition && f.petPolicy !== '不可') t += `（${f.petCondition}）`;
    lines.push(t);
  }
  if (f.internet === 'あり') {
    let t = 'インターネット：あり';
    if (f.internetDetail) t += `（${f.internetDetail}）`;
    lines.push(t);
  } else if (f.internet === 'なし') {
    lines.push('インターネット：なし');
  }
  // 2026-09-17 竹内（YUYA 事例）: 保証会社は設備の1行ではなく、御見積書の直後の説明文（buildGuarantorCheckNote）で出す。
  //   同じ事を2か所に書かない（旧: ここに「保証会社：独立系（審査が通りやすいです！！）」の行があった）
  return lines;
}

// 挨拶時間ルール（全アクション共通ヘルパー・#19）
// ・初回（isFirstEverReply）→「ご連絡頂きありがとうございます😊！！」
// ・今日すでにスタッフが送信済み（staffMessagedToday）→ 挨拶行なし（名前行のみ「〇〇さん」で開始＝正解 挨拶なし 412 件内の名前行パターン）
//   G32（2026-09-09 Fable5 じゅにあ事例・竹内方針）: 「お待たせ致しました」は返信から全廃（final-check BANNED_WORD で block されるため生成側からも除去）
// ・夜 21:00〜4:59 に、こちらから届ける連絡（お客様の最後の発言から90分以上）→「夜分遅くに失礼致します！！」（お世話になっておりますの代わり・重ねない）
//   2026-09-15 竹内（慶次事例）: スタッフ実送信「慶次さん夜分遅くに失礼致します！！」（お客様の発言から8.7時間後の物件送付）。90日の夜の送信で
//   こちらからの連絡（その日初めて）は 夜分 6／お世話 2、お客様への返信（90分以内）は 夜分 1／お世話 13。
//   返信に入れない（Aoi 事例 9/12「お客さんへの返信で入れない・重ねていれない」）は変えない＝90分以内の応答はお世話になっております
const NIGHT_OUTBOUND_GAP_MIN = 90;
function isNightOutbound(jstHour: number, minutesSinceLastCustomer: number | null): boolean {
  const night = jstHour >= 21 || jstHour < 5;
  // お客様の発言の時刻が分からない時は返信扱い（夜分にしない）
  return night && minutesSinceLastCustomer !== null && minutesSinceLastCustomer >= NIGHT_OUTBOUND_GAP_MIN;
}
function buildGreeting(
  jstHour: number,
  isFirstEverReply: boolean,
  staffMessagedToday: boolean,
  minutesSinceLastCustomer: number | null,
): string {
  if (isFirstEverReply) return "ご連絡頂きありがとうございます😊！！";
  if (staffMessagedToday) return "";
  if (isNightOutbound(jstHour, minutesSinceLastCustomer)) return "夜分遅くに失礼致します！！";
  return "お世話になっております！！";
}

function extractPreferredName(
  messages: Array<{ sender: string; text?: string | null }>,
  lineDisplayName: string
): string {
  // 部分一致で除外（^先頭一致だと「通過後にオーナー」等が素通りするため含有一致に変更）
  // 「よろし」等の接続表現も除外（「よろしければサさん…」→「よろしければサ」誤抽出防止）
  const NON_NAME_RE = /(お客様|オーナー|大家|管理|業者|保証|担当|スタッフ|弊社|不動産|審査|通過|契約|入居|退去|申込|内覧|皆|各位|こちら|まずは|引き続き|何卒|改めて|よろし|宜し|もしよ|できれば|出来れば|ぜひ|是非)/;
  // 名前の形のみ許可: ひらがな2〜6字 / カタカナ2〜6字 / 漢字1〜4字（スクリプト混在=「頂きサ」等の文断片を排除）
  const NAME_SHAPE_RE = /^[ぁ-ん]{2,6}$|^[ァ-ン]{2,6}$|^[一-鿿々]{1,4}$/;
  // 動詞・助詞に使われる文字が中間に混ざる候補は文断片（例:「割引させて頂き」「むらかみ」等の切れ端）
  const FRAGMENT_CHAR_RE = /[てでにをはがもやかなきしれめとのどこそあいう]/;
  for (const msg of [...messages].reverse()) {
    if (msg.sender !== "staff" || !msg.text) continue;
    // 冒頭の呼びかけのみ対象（文中の「オーナーさん」等の第三者言及は拾わない）
    // {1,8}: 「関さん」等の1文字漢字名も許可（形の妥当性はNAME_SHAPE_REが判定）
    const m = msg.text.match(/^[\s「]*([^\s、。！？\n【】「」（）・]{1,8}?)さん/);
    if (!m) continue;
    const name = m[1];
    if (NON_NAME_RE.test(name)) continue;
    if (name.length > 8) continue;
    // 名前の形（ひらがな/カタカナ/漢字のみ）に一致しない候補は名前ではない
    if (!NAME_SHAPE_RE.test(name)) continue;
    // 中間に動詞・助詞文字が混ざる候補は文断片とみなして拒否（先頭・末尾は名前でも使われるため対象外）
    if (name.length >= 3 && FRAGMENT_CHAR_RE.test(name.slice(1, -1))) continue;
    return name;
  }
  // フォールバック: クライアント渡し名にも「よろしければサ」等の汚染が乗り得るためサニタイズ
  const fallbackName = lineDisplayName
    .replace(/^(もし)?(よろしければ|宜しければ|よければ|できれば|出来れば|ぜひ|是非)/, "")
    .replace(/さん$/, "")
    .trim();
  // 1文字のみは頭文字の可能性があるのでスキップ（英字2文字以上はYUMAなど実名として使う）
  if (fallbackName.length <= 1) return "";
  // 絵文字・記号のみのLINE表示名（「⭐️」「♡」等）を実名として使わない（「⭐さん」生成バグの根本原因）。
  // generate-reply と同じ isPlausiblePersonName ゲートに一元化 → 不合格なら "" を返し「お客様」呼びにフォールバック
  if (!isPlausiblePersonName(fallbackName)) return "";
  return fallbackName;
}

async function getPhrases(category: string, customerName?: string): Promise<string> {
  const { data } = await supabase
    .from("phrase_dictionary")
    .select("phrase")
    .eq("category", category)
    .eq("is_active", true)
    .gte("priority", 10)
    .order("priority", { ascending: false })
    .order("id", { ascending: true })
    .limit(15);
  const fallback = customerName || "お客様";
  return (data || []).map((r: { phrase: string }) =>
    // M-8: フレーズ側に「{{customer_name}}さん」と書かれている場合、さん付き名を渡すと
    // 「〇〇さんさん」になるため、置換後の「さんさん」を1つに畳む
    `- ${r.phrase.replace(/\{\{customer_name\}\}/g, fallback).replace(/さんさん/g, "さん")}`
  ).join("\n");
}

// 物件オススメの実例（☆つき）を取得してAIの参考文として返す
async function getPropertyExamples(): Promise<string> {
  const { data } = await supabase
    .from("ai_reply_examples")
    .select("sent_reply")
    .in("conversation_state", ["property_recommendation", "proposing"])
    .eq("is_starred", true)
    .limit(8)
    .order("created_at", { ascending: false });
  if (!data || data.length === 0) return "";
  return (data as { sent_reply: string }[])
    .map((r, i) => `【実例${i + 1}】\n${r.sent_reply}`)
    .join("\n\n---\n\n");
}

// ※ aix_settings からシステムプロンプトを取得する getAixSystemPrompt は削除済み（呼び出し箇所ゼロのデッドコード）。
//   物件オススメのフォーマットはコード内固定（DEFAULT_PROP_SYSTEM）を使用しており、DBでは上書きしない。

// 物件オススメ関連のknowledgeを取得（差分学習ルール優先 + 顧客文脈embeddingRAG）
// customerContext: 顧客条件テキスト + AIX-META（brainContext）を結合したもの。渡すとRAGが有効になる
async function getPropertyKnowledge(conversationId?: string, customerContext?: string): Promise<string> {
  type KRow = { id: string; title: string; content: string; hypothesis_status?: string };
  const [{ data: diffLearned }, { data: stateKnowledge }] = await Promise.all([
    // ① 差分学習ルール（最優先）
    supabase.from("ai_reply_knowledge")
      .select("id, title, content, hypothesis_status")
      .ilike("title", "%差分学習%")
      .gte("importance", 7)
      .in("conversation_state", ["property_recommendation", "proposing"])
      .eq("hypothesis_status", "confirmed")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(12),
    // ② フェーズ別ナレッジ
    supabase.from("ai_reply_knowledge")
      .select("id, title, content, hypothesis_status")
      .in("conversation_state", ["property_recommendation", "proposing"])
      .gte("importance", 7)
      .not("title", "ilike", "%差分学習%")
      .eq("hypothesis_status", "confirmed")
      .order("importance", { ascending: false })
      .limit(10),
  ]);

  // RAG: 顧客条件 + AIX-META の embedding で「この顧客に刺さるknowledge」を追加取得
  // フォーマットは固定でも、オススメポイントの選び方・訴求軸は顧客ごとに異なるため文脈絞り込みが効く
  let vectorExtras: KRow[] = [];
  if (customerContext && process.env.OPENAI_API_KEY) {
    try {
      const searchQuery = safeSlice(`property_recommendation: ${customerContext}`.trim(), 2000);
      const embedding = await generateEmbedding(searchQuery);
      if (embedding) {
        const { data: vectorResults } = await supabase.rpc("match_reply_knowledge", {
          query_embedding: embedding, match_count: 40, min_importance: 7,
        }) as { data: Array<{ id: string; title: string; content: string; hypothesis_status?: string; importance: number; similarity: number }> | null };
        const existingIds = new Set([...(diffLearned ?? []), ...(stateKnowledge ?? [])].map(r => (r as KRow).id));
        vectorExtras = (vectorResults ?? [])
          .filter(r => r.similarity >= 0.5 && r.hypothesis_status === "confirmed" && !existingIds.has(r.id))
          .sort((a, b) => (b.similarity * (b.importance / 10)) - (a.similarity * (a.importance / 10)))
          .slice(0, 5);
      }
    } catch { /* RAGエラーは無視してSQL結果のみ返す */ }
  }

  // 使用追跡（after()でレスポンス返却後も実行保証）
  const usedIds = [...(diffLearned ?? []), ...(stateKnowledge ?? []), ...vectorExtras]
    .map(r => (r as KRow).id).filter(Boolean);
  if (usedIds.length) {
    after(async () => {
      try {
        await supabase.rpc("increment_knowledge_used_count", { p_ids: usedIds });
      } catch (e) {
        console.error("[aix/action] increment_knowledge_used_count RPC失敗:", e);
      }
      if (conversationId) {
        try {
          await supabase.from("knowledge_apply_log").insert(
            usedIds.map(id => ({ knowledge_id: id, conversation_id: conversationId, source: "aix_action" }))
          );
        } catch (e) {
          console.error("[aix/action] knowledge_apply_log insert失敗:", e);
        }
      }
    });
  }
  const parts: string[] = [];
  if ((diffLearned?.length ?? 0) > 0)
    parts.push("【🔴 過去の修正パターン（必ず守る）】\n" + (diffLearned as KRow[]).map(r => `・${r.title}: ${r.content}`).join("\n"));
  if ((stateKnowledge?.length ?? 0) > 0)
    parts.push("【物件オススメのノウハウ】\n" + (stateKnowledge as KRow[]).map(r => `・${r.content}`).join("\n"));
  if (vectorExtras.length > 0)
    parts.push("【📍 このお客様の状況に関連するノウハウ（RAG）】\n" + vectorExtras.map(r => `・${r.content}`).join("\n"));
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
  // 2026-09-12 竹内（あや事例）: 初期費用を説明はクライアント側テンプレ（AI不使用）。保存 state を揃えるためだけに登録
  cost_explain: ["cost_explain"],
  // 2026-09-15 竹内（ゆうこ事例）: 初期費用について（見積書の内訳で費用の中身の質問に答える）。見積書の学習も引く
  cost_breakdown: ["cost_breakdown", "estimate_sheet", "estimate_request"],
  // 2026-09-15 竹内（H 事例）: 電話をかける（クライアント側テンプレ・保存 state を揃えるためだけ）／電話終了後（メモから電話後のまとめ）
  phone_call: ["phone_call"],
  phone_followup: ["phone_followup"],
  // 2026-09-15 竹内（YUYA 事例）: 保証会社について。確認した→保証会社（mgmt_guarantor）の学習も引く
  // 2026-09-15: 保証会社の案内に物件確認した（募集状況・御見積書同封）の差分ルール・⭐実例が混じらないよう単独（学習が溜まるまではスタッフ実文の手本で足りる）
  guarantor_info: ["guarantor_info"],
  // ※ property_recommendation は getPropertyKnowledge() 内で同等の差分学習ルール取得済み（states: property_recommendation/proposing）
};

// 学習済みナレッジを対象stateから取得する汎用関数
// ① 差分学習ルール ② pattern/principle/phrase ③ スタッフがAIX生成文を編集した実例（リアルタイム）
// 「修正→学習→改善」ループの出口。各アクションのsystemプロンプト末尾に注入して使う
// F04: customerMsg を追加し、OPENAI_API_KEY がある場合は pgvector で顧客メッセージに関連するルールを文脈絞り込み
async function getKnowledgeForState(states: string[], actionType?: string, conversationId?: string, customerMsg?: string, brainContext?: string): Promise<string> {
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
        .eq("hypothesis_status", "confirmed") // AIX生成変化ゲート: AI提案→confirmed 経由のみ注入
        .order("importance", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(12),
      // ② その他のナレッジ（pattern/principle/phrase — 手動登録・analyze-diffsのパターン）
      supabase.from("ai_reply_knowledge")
        .select("id, title, content, hypothesis_status")
        .not("title", "ilike", "%差分学習%")
        .gte("importance", 7)
        .in("conversation_state", states)
        .eq("hypothesis_status", "confirmed") // AIX生成変化ゲート: AI提案→confirmed 経由のみ注入
        .order("importance", { ascending: false })
        .order("id", { ascending: true })
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
        .select("id, rule_text, confidence, category")
        .eq("is_active", true)
        .gte("confidence", 0.7)
        .order("confidence", { ascending: false })
        .order("id", { ascending: true })
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
    if ((customerMsg || brainContext) && process.env.OPENAI_API_KEY) {
      // 2026-09-13 AIX-META × RAG 監査: 問いは文書（ナレッジ＝本文＋state）と同じ構成に。AIX-META（戦略語）は問いに混ぜると精度が下がる
      //   （本番の問い40件でナレッジの近さ 0.485 → 0.525）。顧客発言が無い時だけ AIX-META で引く
      const searchQuery = safeSlice(`${states[0]}: ${customerMsg || brainContext}`.trim(), 2000);
      const embedding = await generateEmbedding(searchQuery);
      if (embedding) {
        const { data: vectorResults } = await supabase.rpc("match_reply_knowledge", {
          query_embedding: embedding, match_count: 40, min_importance: 7,
        }) as { data: Array<{ id: string; title: string; content: string; hypothesis_status?: string; importance: number; similarity: number }> | null };
        const filtered = (vectorResults ?? [])
          .filter(r => r.similarity >= 0.5 && r.hypothesis_status === "confirmed")
          .sort((a, b) => (b.similarity * (b.importance / 10)) - (a.similarity * (a.importance / 10)));
        const existingIds = new Set([...sortedDiff, ...sortedOther].map(r => r.id));
        vectorExtras = filtered.filter(r => !existingIds.has(r.id)).slice(0, 5);
      }
    }

    // 使用追跡（after()でレスポンス返却後も実行保証）
    const allIds = [...sortedDiff, ...sortedOther, ...vectorExtras].map(r => r.id).filter(Boolean);
    if (allIds.length) {
      after(async () => {
        try {
          await supabase.rpc("increment_knowledge_used_count", { p_ids: allIds });
        } catch (e) {
          console.error("[aix/action] increment_knowledge_used_count RPC失敗:", e);
        }
        if (conversationId) {
          // C05: source='aix_action' を付与して generate-reply 由来のログと区別する
          try {
            await supabase.from("knowledge_apply_log").insert(
              allIds.map(id => ({ knowledge_id: id, conversation_id: conversationId, source: "aix_action" }))
            );
          } catch (e) {
            console.error("[aix/action] knowledge_apply_log insert失敗:", e);
          }
        }
      });
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
          .map((r, i) => `[改善例${i + 1}]\n${safeSlice(r.template_text, 250)}`)
          .join("\n\n"));
    }
    // HIGH-05: テンプレート修正学習ルール注入
    if ((adaptRules?.length ?? 0) > 0) {
      parts.push("【📘 テンプレート修正学習ルール（テンプレ活用時の改善パターン — テンプレを使う場合は必ず参照）】\n" +
        (adaptRules as { rule_text: string; category: string }[]).map(r => `・[${r.category}] ${r.rule_text}`).join("\n"));
    }
    // adaptation_improvement_rules の使用記録（after()でレスポンス返却後も実行保証）
    // used_count 専用 RPC がない場合は updated_at をタッチして「最後に使われた日時」を記録する
    const adaptIds = (adaptRules ?? []).map((r: { id: string }) => r.id).filter(Boolean);
    if (adaptIds.length > 0) {
      after(async () => {
        try {
          await supabase
            .from("adaptation_improvement_rules")
            .update({ updated_at: new Date().toISOString() })
            .in("id", adaptIds);
        } catch (e) {
          console.warn("[aix/action] adaptation_improvement_rules updated_at update failed:", e instanceof Error ? e.message : e);
        }
      });
    }
    // F04: pgvector で追加取得した文脈関連ルール
    if (vectorExtras.length > 0) {
      parts.push("【🔍 この顧客メッセージへの関連ルール（文脈検索）】\n" +
        vectorExtras.map(r => `・${r.content}`).join("\n"));
    }
    return parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
  } catch (e) {
    console.error("[aix/action] getKnowledgeForState失敗:", e);
    return ""; // ナレッジ取得失敗は生成自体を止めない
  }
}

// ☆つき成功返信パターンを類似検索してAIXプロンプトに注入する（LL-04）
// generate-reply の match_reply_examples RPC と同じ仕組み。顧客メッセージ＋brain文脈のembeddingで類似☆実例を引く
type StarredExamplesBrainHint = {
  action?: string | null;
  closing_strategy?: string | null;
  customer_intent?: string | null;
  recommended_tone?: string | null;
  checkpoint_stage?: string | null;
};

async function getStarredExamplesForAction(
  states: string[],
  customerMsg: string,
  brainMeta?: StarredExamplesBrainHint | null,
): Promise<string> {
  try {
    if (!customerMsg.trim() || !states || states.length === 0) return "";

    // 2026-09-13 AIX-META × RAG 監査: 問いは実例の埋め込みと同じ構成（`${state}: ${顧客発言}`）にする。
    //   旧: brain 文脈（action・closing_strategy・customer_intent・tone・stage）を先頭に足していた → 問いが実例から離れ、
    //   本番の問い38件で「実際にスタッフが送った返信」への近さが下がっていた（最も近い1件 cos 0.636 → 0.666）
    void brainMeta;
    const queryText = safeSlice(`${states[0]}: ${customerMsg}`, 600);

    // generateEmbedding経由でembeddingを取得（embedding_cache DBキャッシュ＋メモリFIFO 2層キャッシュを活用）
    const embedding = await generateEmbedding(queryText);
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
      examples.map(e => `顧客:「${safeSlice(e.customer_message, 80)}」\nスタッフ返信:「${safeSlice(e.sent_reply, 200)}」`).join("\n---\n");
  } catch {
    return ""; // ☆実例取得失敗は生成自体を止めない
  }
}

// ── 物件提案系（property_send / property_recommendation）専用の品質スタック ──────────

// 過去の成約パターン（winning_patterns）RAG + AIX-METAメタデータ再ランキング
// aix-template-generate の H2 実装と同方式: similarity≥0.5 でフィルタ後、
// checkpoint_stage一致 +0.12 / customer_intent一致 +0.15 / win_rate×0.1 の複合スコアで再ランキング
async function getWinningPatternsForProperty(
  queryText: string,
  brainHint?: { checkpoint_stage?: string | null; customer_intent?: string | null } | null,
): Promise<string> {
  try {
    if (!queryText.trim() || !process.env.OPENAI_API_KEY) return "";
    const embedding = await generateEmbedding(safeSlice(queryText, 2000));
    if (!embedding) return "";
    const { data } = await supabase.rpc("match_winning_patterns", {
      query_embedding: embedding,
      match_count: 8,
      min_importance: 8,
    });
    type WpRow = {
      situation: string | null;
      pattern: string;
      closing_action: string | null;
      notes: string | null;
      checkpoint_stage?: string | null;
      customer_intent?: string | null;
      win_rate?: number | null;
      human_type_label?: string | null;
      similarity: number;
    };
    const rows = ((data ?? []) as WpRow[])
      .filter(w => w.similarity >= 0.5)
      .map(w => ({
        ...w,
        score: (w.similarity ?? 0)
          + (brainHint?.checkpoint_stage && w.checkpoint_stage === brainHint.checkpoint_stage ? 0.12 : 0)
          + (brainHint?.customer_intent && w.customer_intent === brainHint.customer_intent ? 0.15 : 0)
          + (w.win_rate ?? 0) * 0.1,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    if (rows.length === 0) return "";
    return "\n\n【🏆 過去の成約パターン（似た状況で効いた訴求 — オススメポイントの選択・訴求角度の参考にすること。文の構成・フォーマットは変えない）】\n" +
      rows.map(w => {
        const parts = [
          w.situation ? `状況: ${safeSlice(w.situation, 80)}` : "",
          w.human_type_label ? `顧客タイプ: ${w.human_type_label}` : "",
          `パターン: ${safeSlice(w.pattern, 150)}`,
          w.closing_action ? `クロージング: ${safeSlice(w.closing_action, 60)}` : "",
        ].filter(Boolean).join(" / ");
        return `・${parts}`;
      }).join("\n");
  } catch {
    return ""; // 成約パターン取得失敗は生成自体を止めない
  }
}

// 過去に実際に送信されたAIX物件本文の実例（entry_source='aix_property'）を取得する。
// queryText がある場合は pgvector 主経路（キーワード・会話文脈で実例が変わる）、
// なければ従来の固定直クエリにフォールバック。
async function getAixPropertyExamples(
  actionType: "property_send" | "property_recommendation",
  queryText?: string,
): Promise<string> {
  type Row = { customer_message: string; sent_reply: string; is_starred: boolean };
  let rows: Row[] = [];

  // pgvector主経路: キーワード先頭の検索クエリで「この状況に合う実例」を引く
  if (queryText?.trim() && process.env.OPENAI_API_KEY) {
    try {
      const emb = await generateEmbedding(safeSlice(queryText, 2000));
      if (emb) {
        const { data } = await supabase.rpc("match_aix_reply_examples", {
          query_embedding: emb,
          match_count: 15,
          filter_action: actionType,
        });
        rows = ((data ?? []) as Array<Row & { similarity: number }>)
          .filter(r => (r.similarity ?? 0) >= 0.45 && (r.sent_reply ?? "").trim())
          .sort((a, b) => (b.similarity + (b.is_starred ? 0.15 : 0)) - (a.similarity + (a.is_starred ? 0.15 : 0)))
          .slice(0, 4);
      }
    } catch {
      rows = [];
    }
  }

  // フォールバック: pgvectorが空のとき従来の固定直クエリ（⭐降順）
  if (rows.length === 0) {
    try {
      const { data } = await supabase
        .from("ai_reply_examples")
        .select("customer_message, sent_reply, is_starred")
        .eq("entry_source", "aix_property")
        .eq("aix_action", actionType)
        .order("is_starred", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(5);
      rows = (data ?? []) as Row[];
    } catch {
      return "";
    }
  }

  if (rows.length === 0) return "";
  const label = actionType === "property_send" ? "物件ピックアップ送付文" : "物件オススメ文";
  return `\n\n【📤 過去に実際に送信した${label}の実例（⭐=お客様が反応した実例。訴求の質・言い回し・条件の織り込み方の参考にすること。物件名・金額・条件は今回の物件のものを使い、実例の数値は絶対に流用しない）】\n` +
    rows.map((r, i) => {
      const ctx = (r.customer_message ?? "").split("\n")[0];
      const ctxLine = ctx && ctx !== "（初回連絡）" ? `状況:「${safeSlice(ctx, 60)}」\n` : "";
      return `[実例${i + 1}${r.is_starred ? "⭐" : ""}]\n${ctxLine}${safeSlice(r.sent_reply, 400)}`;
    }).join("\n\n");
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
  viewing_invite: 1500,          // 内覧お誘い（1000だとJSON途中切断リスクがあるため1500に引き上げ）
  application_push: 1500,        // 申込促進（1000だとJSON途中切断リスクがあるため1500に引き上げ）
  docs_request: 2000,            // 書類依頼（不足書類リストが長くなる場合があるため途中切れ防止で2000）
  greeting_viewing: 800,         // 内覧挨拶
  condition_hearing: 800,        // 条件ヒアリング
  meeting_place: 600,            // 待ち合わせ案内
  acknowledge_check: 400,        // 確認しますシンプル返信
  followup_revive: 600,          // 追客メッセージ
  zenryoku_support: 600,         // 2〜5行の短文生成
  cost_breakdown: 1500,          // 初期費用について（見積書の内訳の読み取り JSON・説明文）
  phone_followup: 1200,          // 電話終了後（電話でお話しした内容のまとめ・3〜8行）
  guarantor_info: 4000,          // 保証会社について（物件ごとの一覧＋審査の緩さ＋並行審査の勧め）。1物件≈180トークン・最大20件でも JSON が尻切れしない余裕（上限なので未使用分は費用にならない）
};

function maxTokensForAction(action: string): number {
  return ACTION_MAX_TOKENS[action] ?? 1500;
}

// ── 「即入居可能」記載可否の統一定義（唯一の定義箇所・他所に条件を複製しないこと） ──
// 「即入居可能」と書いてよいのは以下2条件を【両方】満たす場合のみ：
//   ①空室確認済み（物件資料に空室記載あり）
//   ②入居時期制限なし（お客様が入居を急いでいる＝即入居・今月中など。先の月指定がない）
// どちらか一方でも欠ける場合は「即入居可能」等の入居時期の記載は禁止。
const MOVE_IN_TIMING_RULE = `【入居時期の記載ルール — 必ず守ること】
お客様の希望条件の「入居:」行や会話の流れから、入居を急いでいるか（即入居・今月中など）／先の入居希望か（〇月入居希望・数ヶ月先など）を判断して以下を使い分ける。明示的な急ぎ情報がない場合は会話の文脈・AI要約から推測すること。
・「空室のため即入居可能」と記載してよいのは【①物件資料に空室記載あり（空室確認済み） かつ ②お客様が入居を急いでいる（入居時期制限なし）】の両方を満たす場合のみ
・お客様の入居時期が先（急いでいない）場合 → 「ご希望の〇月入居に対応可能」と記載する（〇月はお客様の希望入居時期）
・空室記載があっても お客様が急いでいない場合 → 「即入居可能」等の入居時期の記載はしない
・【🔴 絶対禁止】「〇ヶ月後のご入居にもしっかり対応頂けるお部屋となります」という表現は絶対に使わない
・入居希望日に「間に合う／対応可能」と断言してよいかは、下記【入居希望日の妥当性チェック】の判定に必ず従うこと（判定がない場合は断言しない）`;

// ── 入居希望日の妥当性チェック（今日の日付と比較して「〜までのご入居に対応可能」と書いてよいか判定） ──
// 申込から入居までは最短2週間（審査3〜10日＋契約書類＋入金）かかるため、
// 残り14日未満（＝過去日・当日含む）は「ご希望日までのご入居に対応可能」と断言させない。
const MOVE_IN_LEAD_DAYS = 14;

// 顧客条件テキストから「入居: 〇〇」の希望入居時期を抜き出す
function extractMoveInWish(text: string): string {
  const m = text.match(/入居(?:希望日?|時期)?\s*[:：]\s*([^\n]+)/);
  return m ? m[1].trim() : "";
}

// 希望入居時期の自由テキスト（例「8月末」「9/1」「来月中旬」）を締切日（YYYY-MM-DD）と残日数に変換
function resolveMoveInDeadline(
  wish: string,
  todayISO: string
): { deadlineISO: string; daysLeft: number } | null {
  if (!wish) return null;
  const s = wish.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const [ty, tm, td] = todayISO.split("-").map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const lastDayOf = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const make = (month: number, day: number | null, kind: "early" | "mid" | "late") => {
    if (!month || month < 1 || month > 12) return null;
    // 年の推定: 今月より前の月なら翌年、今月以降なら今年
    const year = month < tm ? ty + 1 : ty;
    const base = day ?? (kind === "early" ? 10 : kind === "mid" ? 20 : lastDayOf(year, month));
    const dd = Math.max(1, Math.min(base, lastDayOf(year, month)));
    return {
      deadlineISO: `${year}-${String(month).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
      daysLeft: Math.round((Date.UTC(year, month - 1, dd) - todayMs) / 86_400_000),
    };
  };
  let m: RegExpMatchArray | null;
  if ((m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) return make(+m[1], +m[2], "late");
  if ((m = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})/)))       return make(+m[1], +m[2], "late");
  if ((m = s.match(/(\d{1,2})\s*月\s*(?:上旬|初旬|頭)/))) return make(+m[1], null, "early");
  if ((m = s.match(/(\d{1,2})\s*月\s*中旬/)))            return make(+m[1], null, "mid");
  if ((m = s.match(/(\d{1,2})\s*月/)))                   return make(+m[1], null, "late");
  if (/今月/.test(s))  return make(tm, null, "late");
  if (/来月/.test(s))  return make(tm === 12 ? 1 : tm + 1, null, "late");
  return null;
}

// property_recommendation の動的systemブロックに注入する入居日ガードノート
function buildMoveInDeadlineNote(sourceText: string, todayISO: string, todayFmt: string): string {
  const head = `\n\n【本日の日付】${todayFmt}\n【入居希望日の妥当性チェック — 最優先・上記「入居時期の記載ルール」より優先】`;
  const forbid = `\n・【🔴 絶対禁止】「ご希望の〇月末までのご入居にもしっかり対応可能です」「ご希望の〇月入居に対応可能」等、入居希望日・入居期限に間に合う旨を断言する文を一切書かないこと。入居期限そのものへの言及も禁止。\n・入居時期に触れず、物件の強み（家賃・間取り・設備・立地）だけで訴求すること。物件が空室の場合に「空室のため即入居可能」と書くことのみ許可する。`;
  const wish = extractMoveInWish(sourceText);
  if (!wish) return `${head}\n・お客様の入居希望日は特定できていない。${forbid}`;
  const r = resolveMoveInDeadline(wish, todayISO);
  if (!r) return `${head}\n・お客様の入居希望時期は「${wish}」で、具体的な期日として確定できない。${forbid}`;
  if (r.daysLeft < MOVE_IN_LEAD_DAYS) {
    const reason = r.daysLeft <= 0
      ? `本日（${todayFmt}）時点で既に過ぎている、または本日が最終日`
      : `本日から残り${r.daysLeft}日しかなく、お申込みから入居まで最短2週間かかるため間に合わない`;
    return `${head}\n・お客様の入居希望時期「${wish}」＝${r.deadlineISO} は${reason}。${forbid}`;
  }
  const margin = r.daysLeft - MOVE_IN_LEAD_DAYS; // 審査期間（14日）を引いた余裕日数
  return `${head}\n・お客様の入居希望時期「${wish}」＝${r.deadlineISO}（本日${todayFmt}から${r.daysLeft}日後）。\n・審査・契約・入金の最短期間は2週間。差し引き${margin}日の余裕があるため入居時期に言及してよい。\n・言及するときは「お申込みから審査・ご契約・入居まで通常2週間程度で対応できますので、${wish}のご入居にもしっかり対応可能です！！」のように審査期間を根拠として自然に添えること。\n・言及する場合の日付は「${wish}」の表現に沿わせ、勝手に別の日付へ書き換えないこと。`;
}

// ── 2026-09-17 竹内（AIX キャッシュ点検）: 計測用ヘッダ・会話 ID ──────────────────────────
// llm_usage_logs（app/lib/llm-usage-recorder.ts・fetch の出口）が「どの AIX か・どの会話か」を読めるように、
// Anthropic への fetch に x-sumora-llm-action / x-sumora-llm-conversation を付ける（recorder が読んで Anthropic に送る前に取り除く）。
// 会話 ID は handleAction の body 解析後にしか分からず、callClaude 系は深い呼び出しの中にいるので AsyncLocalStorage で持つ
// （並行リクエストで混ざらない。aixStream と同じ仕組み）。
// ヘッダ名・値の整形は app/lib/aix-system-blocks.ts（LLM_META_HEADER_ACTION / LLM_META_HEADER_CONVERSATION / llmMetaHeaderValue）
const aixRequestCtx = new AsyncLocalStorage<{ conversationId: string | null }>();

function llmMetaHeaders(action: string): Record<string, string> {
  const h: Record<string, string> = { [LLM_META_HEADER_ACTION]: llmMetaHeaderValue(action) };
  const cid = aixRequestCtx.getStore()?.conversationId;
  if (cid) h[LLM_META_HEADER_CONVERSATION] = llmMetaHeaderValue(cid);
  return h;
}

// dynamicSystemSuffix: brainGuidanceNote など顧客別の動的コンテンツ。静的ブロックと分離してキャッシュHIT率を上げる
// 2026-09-17 竹内（AIX キャッシュ点検）: system は文字列（従来）でもブロック指定（SystemSpec）でも受ける。
//   文字列なら共通 prefix（GENERATION_SYSTEM + SMORA_COMMON_RULES）を自動で shared（1h）に分け、残りを routeStatic（既定 5m）にする。
//   LLM に届く文字列は変わらない（app/lib/aix-system-blocks.ts）。opts.ttl は routeStatic の ttl（"none" で cache なし）。
async function callClaude(system: SystemSpec, user: string, action: string, dynamicSystemSuffix?: string, opts: { ttl?: SystemTtl } = {}): Promise<string> {
  // 1回あたり25秒タイムアウト＋タイムアウト時のみ1回リトライ（最大約50秒 < クライアント60秒abort）
  // 旧45秒×リトライ無しだと、一過性のAPI遅延・ネットワークハングで即エラーになっていた
  const attempt = async (timeoutMs: number): Promise<string> => {
    const systemBlocks = buildSystemBlocks(system, { defaultTtl: opts.ttl ?? "5m", dynamicSuffix: dynamicSystemSuffix });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        ...llmMetaHeaders(action),
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokensForAction(action),
        thinking: { type: "disabled" },
        system: systemBlocks,
        messages: [{ role: "user", content: user }],
      }),
      signal: budgetSignal(timeoutMs),
    });
    if (!res.ok) throw new Error(`Claude error: ${await res.text()}`);
    const data = await res.json();
    logLlmUsage("aix", data.usage, { action, model: MODEL });
    warnIfTruncated(data, systemStaticLength(system) + user.length, action);
    return data.content?.find((b: any) => b.type === "text")?.text?.trim() || "";
  };
  try {
    return await attempt(25_000);
  } catch (e) {
    const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    if (!isTimeout) throw e;
    const left = remainingMs(25_000);
    if (left < 10_000) throw new Error("AI生成がタイムアウトしました。もう一度お試しください");
    console.warn("[aix/action] callClaude timeout → リトライ:", { action, left });
    return await attempt(Math.min(25_000, left));
  }
}

// dynamicSystemSuffix: 呼び出しごとに変わる動的コンテンツ。静的ブロックと分離してキャッシュHIT率を上げる
// 2026-09-17 竹内（AIX キャッシュ点検）: Haiku の既定は cache なし（ttl "none"）。カバーレター・内覧前挨拶・待ち合わせ・日時抽出は
//   3日で数回しか呼ばれず 1h の書き込みが純損。Haiku 4.5 の最小キャッシュは 4,096 tokens で、これらの system は届かない。
//   共通 prefix（shared）があれば従来どおり 1h（全経路共有の鍵）。必要なら opts.ttl で個別に付けられる
async function callClaudeHaiku(system: SystemSpec, user: string, action: string, dynamicSystemSuffix?: string, opts: { ttl?: SystemTtl } = {}): Promise<string> {
  const systemBlocks = buildSystemBlocks(system, { defaultTtl: opts.ttl ?? "none", dynamicSuffix: dynamicSystemSuffix });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      ...llmMetaHeaders(action),
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: systemBlocks,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Claude Haiku error: ${await res.text()}`);
  const data = await res.json();
  logLlmUsage("aix", data.usage, { action, model: "haiku" });
  warnIfTruncated(data, systemStaticLength(system) + user.length, action);
  return data.content?.find((b: any) => b.type === "text")?.text?.trim() || "";
}

// ※ Sonnet5はtemperature等のサンプリングパラメータ非対応（400エラー）のため渡さない
// dynamicSystemSuffix: 顧客固有/呼び出し固有の動的コンテンツ。静的ブロックと分離してキャッシュHIT率を上げる
// 2026-09-17 竹内（AIX キャッシュ点検）: 短い OCR の system（見積書 OCR 5種 ≈300〜500 tokens・1,500字未満）には自動で cache_control が付かない
//   （buildSystemBlocks の閾値 AIX_CACHE_MIN_CHARS）。長い物件オススメ等の system は従来どおり共通 prefix 1h＋固有文 5m
async function callClaudeVision(system: SystemSpec, content: unknown[], action: string, dynamicSystemSuffix?: string, opts: { ttl?: SystemTtl } = {}): Promise<string> {
  const systemBlocks = buildSystemBlocks(system, { defaultTtl: opts.ttl ?? "5m", dynamicSuffix: dynamicSystemSuffix });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      ...llmMetaHeaders(action),
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokensForAction(action),
      // Sonnet5はthinkingフィールド省略時にadaptive thinkingがONになる（Sonnet4.6からの破壊的変更）。
      // max_tokens:2000でthinkingトークンが全消費されると text ブロックが空になりサイレント失敗する。
      // property_recommendationはthinking不要かつmax_tokensが低いため明示的に無効化する。
      thinking: { type: "disabled" },
      system: systemBlocks,
      messages: [{ role: "user", content }],
    }),
    // Sonnet5は画像+長文システムプロンプトで45秒を超えることがある → 60秒に延長
    signal: budgetSignal(38_000),
  });
  if (!res.ok) throw new Error(`Claude Vision error: ${await res.text()}`);
  const data = await res.json();
  logLlmUsage("aix:vision", data.usage, { action, model: MODEL });
  warnIfTruncated(data, systemStaticLength(system) + JSON.stringify(content).length, action);
  // Sonnet5はthinkingブロックが content[0] に入るため find() で最初のtextブロックを取得する
  const visionText = data.content?.find((b: any) => b.type === "text")?.text?.trim() || "";
  if (!visionText) throw new Error(`callClaudeVision: empty response for action=${action} (stop_reason=${data.stop_reason})`);
  return visionText;
}

// AIが内部メモを出力した場合、顧客向けメッセージと分離する
// 検出対象: 「名前さん＋挨拶キーワード」または「挨拶キーワード単体」の前にある前置き
// ※ 名前が本文中に出てくる物件オススメ等では誤検出しないよう、名前は挨拶との直接連接のみ対象
function extractNotice(text: string, customerName: string): { message: string; notice: string | null } {
  let trimmed = text.trim();
  // AIが返信全体を「」で囲んで出力することがある → 先頭「末尾」のペアのみ除去
  if (trimmed.startsWith("「") && trimmed.endsWith("」")) trimmed = trimmed.slice(1, -1).trim();
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

// 「会話を合わせる」改善ルール取得（adaptMessageToConversation 専用）
// adapt-feedback（👍/👎）で蓄積された adaptation_improvement_rules から
// アクション別（category=actionType）＋共通（category='common'）の高confidenceルールを取得してフォーマットする。
// ※ 旧データは全て category='greeting_viewing' に蓄積されていた（viewing-guide の内覧誘導挨拶フィードバック由来）ため、
//   greeting_viewing 以外のアクションには legacy カテゴリを混入させない。
async function getAdaptImprovementRules(actionType: string): Promise<string> {
  try {
    const categories = Array.from(new Set([actionType, "common"]));
    const { data } = await supabase
      .from("adaptation_improvement_rules")
      .select("id, rule_text, confidence, category")
      .in("category", categories)
      .eq("is_active", true)
      .gte("confidence", 0.7)
      .order("confidence", { ascending: false })
      .order("id", { ascending: true })
      .limit(5);
    const rules = (data ?? []) as { id: string; rule_text: string; category: string }[];
    if (rules.length === 0) return "";
    // 使用記録（after()でレスポンス返却後も実行保証・getKnowledgeForState の adaptRules と同方式）
    const ids = rules.map((r) => r.id).filter(Boolean);
    if (ids.length > 0) {
      after(async () => {
        try {
          await supabase
            .from("adaptation_improvement_rules")
            .update({ last_triggered_at: new Date().toISOString() })
            .in("id", ids);
        } catch (e) {
          console.warn("[aix/action] adaptation_improvement_rules last_triggered_at update failed:", e instanceof Error ? e.message : e);
        }
      });
    }
    return rules.map((r) => `・${r.rule_text}`).join("\n");
  } catch (e) {
    console.error("[aix/action] getAdaptImprovementRules失敗:", e);
    return ""; // ルール取得失敗は生成自体を止めない
  }
}

// base_message適応モード: AIX生成済みメッセージをベースに、会話文脈に合わせた最小限の調整のみを行う
// （conversation_match + base_message で使用。ゼロから書き直さず、既存ドラフトの品質を維持する）
// 返り値は生テキスト。呼び出し側で必ず finalizeResponse() を通すこと（号室ゼロ除去・内部メモ分離）
// improvementRules: getAdaptImprovementRules() で取得したアクション別改善ルール（過去の👍/👎フィードバック学習）
// brainMeta: AIX-META（suggested_aix_meta）の customer_intent / winning_pattern を言い方の最適化に使う
const RECOMMENDED_TONE_GUIDE: Record<string, string> = {
  "共感的": "冒頭1文で顧客の気持ちを受け止めてから本題に入る（「〜ですよね」等）。急かさない",
  "テキパキ": "前置きを省き結論から書く。1文を短く、要点を先に",
  "慎重": "断定・楽観表現を避け、会話・DBで確認済みの事実のみ正確に伝える",
  "明るく前向き": "ポジティブな言葉で次の一歩を気持ちよく示す（絵文字の扱いは既存ルールに従う）",
  "普通": "通常のスモラトーン",
};

async function adaptMessageToConversation(
  baseMessage: string,
  conversationHistory: string,
  customerName: string,
  actionLabel: string,
  diffNote: string,
  improvementRules?: string,
  brainMeta?: { customer_intent?: string | null; winning_pattern?: string | null; closing_strategy?: string | null; recommended_tone?: string | null } | null
): Promise<string> {
  const improvementBlock = improvementRules && improvementRules.trim()
    ? `\n【会話を合わせる改善ルール（過去フィードバックから学習・必ず守る）】\n${improvementRules.trim()}\n`
    : "";
  const metaLines = [
    brainMeta?.customer_intent ? `意図: ${brainMeta.customer_intent}` : null,
    brainMeta?.winning_pattern ? `勝ちパターン: ${brainMeta.winning_pattern}` : null,
    brainMeta?.closing_strategy ? `成約戦略: ${brainMeta.closing_strategy}（ベースメッセージが既にこの方向のアクションを含む場合は言い回しをこの戦略に寄せるだけに留め、新しいアクションを足さないこと）` : null,
    brainMeta?.recommended_tone
      ? `推奨トーン: ${brainMeta.recommended_tone}${RECOMMENDED_TONE_GUIDE[brainMeta.recommended_tone] ? `（${RECOMMENDED_TONE_GUIDE[brainMeta.recommended_tone]}）` : ""}`
      : null,
  ].filter(Boolean);
  const brainMetaBlock = metaLines.length > 0
    ? `\n【お客様意図・最適アプローチ（AIX-META）】\n${metaLines.join("\n")}\n※ ベースメッセージの内容・結果は変えず、「言い方」をこの意図・パターンに寄せること\n`
    : "";
  const adaptStaticSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【重要】ベースメッセージは既にスタッフが選択した送信内容です。結果・決定・アクションは全て確定済みです。

【あなたのタスク：確定済みメッセージの「言い方」だけを会話に馴染ませる】
以下の「ベースメッセージ」は、スタッフが状況を確認した上で「これを送る」と決定した確定メッセージです。
ここに書かれている結果（満室だった/空いていた/確認できた/できなかった 等）・アクション（内覧のお誘い・書類のご案内 等）・申し出は、すべて最新の確定事実です。
会話履歴がこの結果より古い状態（例: お客様が物件を送ってきたばかりで、まだ確認前に見える）であっても、それは正常です。ベースメッセージの方が新しい事実です。

あなたの仕事は「会話の流れを読んで何のメッセージを送るか判断する」ことではありません。
「既に決まったメッセージを、お客様の会話に合わせた言い方に微調整する」ことだけです。
内容・結果・決定を変えることは一切許されていません。変えてよいのは言葉遣い・つなぎ方・共感の一文だけです。

【絶対禁止の書き換え（これをやったら失敗）】
・ベースメッセージが「物件がなかった/満室だった」と伝えているのに、「募集状況確認させていただきます」「かしこまりました！！確認いたします」等の確認前メッセージに変えること → 絶対禁止
・ベースメッセージが「物件があった/空いていた」と伝えているのに、「確認します」等の確認前メッセージに変えること → 絶対禁止
・内覧のお誘い・日程提案・書類案内など、ベースメッセージの核心となるアクションを別の内容に差し替えること → 絶対禁止
・ベースメッセージの結果・結論（満室/空きあり/可/不可/確認済み 等）を削除・変更・弱めること → 絶対禁止
会話を読んで「今はまだ確認前のはずだ」と判断してメッセージの種類を変えること自体が禁止です。判断はスタッフが既に済ませています。

【やってよい微調整（これだけ）】
・冒頭に、お客様の直近の言葉への短い共感・呼応を1文だけ追加する（例:「収納が多めがご希望でしたね！！」「お送りいただいた物件、拝見しました！！」）
  ※追加はしてよいが、ベースメッセージの結果を伝える文を削除・置換してはいけない
・お客様が会話で出していた要望・懸念・条件（日程・物件名・質問など）への言及を、結果を変えない範囲で自然に織り込む
・ベースメッセージがカバーしていないお客様の追加要望がある場合は、末尾に1〜2文で自然に追加する
  例: 満室のご報告の後に「引き続き条件に合うお部屋をピックアップさせて頂きます！！」を追加するなど

【絶対に守ること】
・ベースメッセージが伝えている結果・結論・アクションは絶対に変えない（上記の絶対禁止リスト参照）
・ベースメッセージにある物件名・金額・日時・部屋のスペック（間取り・階数・号室等）は変えない
・会話に出ていない物件名・日時・金額を創作しない
・ベースメッセージの「！！」パターン・絵文字の使い方・スモラスタイルを維持する
・🙏 絵文字は絶対に使わない（スモラ禁止絵文字）
・迷ったらベースメッセージをほぼそのまま出力する（微調整できない場合、ベースメッセージそのままでも正解）

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（調整後のLINEメッセージ全文・改行は\\nで）"}`;

  const adaptDynamic = [
    `【お客様名】「${customerName}」`,
    improvementBlock.trim(),
    brainMetaBlock.trim(),
    `【ベースメッセージ（内容・結果・構成・トーンをそのまま維持すること）】\n${baseMessage}`,
    (diffNote ?? "").trim(),
  ].filter(Boolean).join("\n\n");

  // 2026-09-17 竹内（AIX キャッシュ点検）: 文字列のまま渡して自動分割 → [shared（GENERATION_SYSTEM+SMORA_COMMON_RULES）1h][固有文 5m][adaptDynamic なし]。
  //   固有文は全アクション共通なので鍵を共有する。改善ルール（adaptation_improvement_rules・actionType 別）と AIX-META は動的のまま
  //   （固有文に混ぜるとアクションごとに鍵が割れる）
  const raw = await callClaude(
    adaptStaticSystem,
    `${conversationHistory}\n\n上記の会話を読み、確定済みのベースメッセージの内容・結果・アクションは一切変えずに、言い方だけを会話に馴染ませた最終メッセージを出力してください。`,
    actionLabel,
    adaptDynamic || undefined
  );
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const d = JSON.parse(m[0]) as { message?: string };
      return (d.message || raw).replace(/\\n/g, "\n");
    }
    return raw;
  } catch {
    return raw;
  }
}

// ─── M2: 見積書OCR → 費用の確定事実ブロック生成 ──────────────────────────
// 「物件確認した・物件あった」で見積書を同封する場合、割引額・クリーニング費用・初期費用総額が
// AIに一切渡っておらず「〇〇号室は募集中です」だけの薄い返信になっていた。
// 実際のスタッフ文は「割引出来る金額が少ないお部屋となり、クリーニング費用が契約の際に必要となりますので、
// 初期費用はかなりかかってしまうお部屋となります！御見積書同封させて頂きました！」まで踏み込む。
// → 見積書画像をVisionでOCRし、金額＋そこから導いた説明ヒントを確定事実としてプロンプトに注入する。
const ESTIMATE_FACT_SYSTEM = `この見積書画像から初期費用の内訳を抽出してください。JSON形式のみ返答（説明文・前置き禁止）：
{"initial_cost":"146,000円","discount":"5,000円","savings":"20,000円","cleaning_fee":"33,000円","rent":"58,000円","other_notes":"鍵交換費用22,000円"}
- initial_cost: 初期費用の請求合計額（割引適用後の総額）
- discount: 当社の割引額（「割引」「値引」「サービス」欄の合計。無ければ null）
- savings: 一般的な不動産業者と比べた節約額（記載が無ければ null）
- cleaning_fee: 室内クリーニング費用・ハウスクリーニング代など契約時に支払うクリーニング関連費用（無ければ null）
- rent: 月額家賃（管理費・共益費込みの記載があればその額）
- other_notes: 初期費用が高くなっている主因の項目があれば「項目名+金額」を1つだけ（無ければ null）
金額は必ず「〇〇,〇〇〇円」形式。読み取れない項目は null。推測で金額を作らないこと。`;

type EstimateCostFacts = { block: string; notes: string[] };

function parseYenAmount(v: string | null | undefined): number | null {
  if (!v) return null;
  const digits = String(v).replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 割引が「少ない」と言い切る閾値（スモラの実運用: 3万円未満は訴求ポイントにならない）
const SMALL_DISCOUNT_THRESHOLD = 30000;
// 見積書OCRは本文生成の「前」に走る補助処理。SERVER_BUDGET_MS(55s)を本文生成のために残す必要があるため、
// OCRが遅い場合は打ち切って「見積書同封の事実だけ伝える」ブロックにフォールバックする
const ESTIMATE_OCR_SOFT_TIMEOUT_MS = 20_000;

async function buildEstimateCostFacts(
  estimateUrls: (string | null | undefined)[],
  propertyNames: string[],
  action: string
): Promise<EstimateCostFacts> {
  // index は物件と対応している（null = その物件には見積書なし）
  const targets = estimateUrls.slice(0, 3);
  if (!targets.some((u) => !!u)) return { block: "", notes: [] };
  const badges = ["①", "②", "③"];
  // OCRが先に終わったらタイマーを破棄する（サーバーレスで空タイマーがイベントループに残らないように）
  let softTimer: ReturnType<typeof setTimeout> | undefined;
  const softTimeout = new Promise<({ line: string; note: string } | null)[]>((resolve) => {
    softTimer = setTimeout(() => resolve(targets.map(() => null)), ESTIMATE_OCR_SOFT_TIMEOUT_MS);
  });
  const ocrAll = Promise.all(
    targets.map(async (url, pi) => {
      if (!url) return null;
      const pName = (propertyNames[pi] ?? "").trim() || `物件${badges[pi] ?? String(pi + 1)}`;
      try {
        const raw = await callClaudeVision(
          ESTIMATE_FACT_SYSTEM,
          [
            { type: "text", text: "この見積書から初期費用情報を抽出してください。" },
            { type: "image", source: { type: "url", url } },
          ],
          action
        );
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) return null;
        const d = JSON.parse(m[0]) as {
          initial_cost?: string | null; discount?: string | null; savings?: string | null;
          cleaning_fee?: string | null; rent?: string | null; other_notes?: string | null;
        };
        const initialCost = parseYenAmount(d.initial_cost);
        const discount = parseYenAmount(d.discount);
        const cleaning = parseYenAmount(d.cleaning_fee);
        const rent = parseYenAmount(d.rent);
        const facts: string[] = [];
        if (d.initial_cost) facts.push(`初期費用合計: ${d.initial_cost}`);
        if (d.discount) facts.push(`割引額: ${d.discount}`);
        if (d.savings) facts.push(`一般業者との差額（節約額）: ${d.savings}`);
        if (d.cleaning_fee) facts.push(`クリーニング費用: ${d.cleaning_fee}（契約時に必要）`);
        if (d.rent) facts.push(`家賃: ${d.rent}`);
        if (d.other_notes) facts.push(`高額項目: ${d.other_notes}`);
        // 金額から導いた「伝え方ヒント」— スタッフの実際の言い回しに寄せる材料
        const hints: string[] = [];
        if (discount !== null && discount < SMALL_DISCOUNT_THRESHOLD) {
          hints.push("割引できる金額が少ないお部屋（割引額を売りにせず「割引出来る金額が少ないお部屋」と正直に伝える）");
        } else if (discount === null && (d.discount ?? null) === null) {
          hints.push("割引の記載なし（割引額には触れない）");
        }
        if (cleaning !== null) {
          hints.push("クリーニング費用が契約の際に必要（初期費用が上がる要因として必ず触れる）");
        }
        const isHighInitial = initialCost !== null && (rent !== null ? initialCost >= rent * 5 : initialCost >= 300000);
        if (isHighInitial) {
          hints.push("初期費用はかなりかかってしまうお部屋（正直に伝えたうえで内覧・申込に繋げる）");
        }
        if (facts.length === 0 && hints.length === 0) return null;
        const lines = [
          `- ${pName}`,
          ...facts.map((f) => `  ・${f}`),
          ...hints.map((h) => `  ※${h}`),
        ];
        // notes は aix_usage_logs.prop_cost_notes に永続化して以降の generate-reply でも参照する
        const note = [pName, ...facts].join(" / ");
        return { line: lines.join("\n"), note };
      } catch (e) {
        console.error("[aix/action] estimate OCR failed:", e);
        return null;
      }
    })
  );
  const results = await Promise.race([ocrAll, softTimeout]);
  if (softTimer) clearTimeout(softTimer);
  const ok = results.filter((r): r is { line: string; note: string } => r !== null);
  if (ok.length === 0) {
    // OCRに失敗しても「見積書を同封する」事実だけは必ず伝える
    return {
      block: "【御見積書について（確定事実）】\n・このメッセージと同時に御見積書をお客様へお送りします。「御見積書同封させて頂きました！！」と必ず伝えること。\n・金額の創作は絶対禁止（見積書の中身を読み取れていないため具体的な金額には触れない）。",
      notes: [],
    };
  }
  const block = `【同封する御見積書の費用情報（OCR結果・確定事実）】
${ok.map((r) => r.line).join("\n")}
・このメッセージと同時に御見積書をお客様へお送りします。「御見積書同封させて頂きました！！」に相当する一文を必ず入れること。
・上記の「※」は費用の伝え方の指示です。該当する内容は必ず本文に自然な日本語で盛り込むこと（例:「こちら割引出来る金額が少ないお部屋となり、クリーニング費用が契約の際に必要となりますので、初期費用はかなりかかってしまうお部屋となります！！」）。
・上記に無い金額・費用項目を創作することは絶対禁止。`;
  return { block, notes: ok.map((r) => r.note) };
}

// AIX完了後のテンプレ誘導: アクション種別 → テンプレートモーダルのカテゴリ名（templates.category の実値）
// ※page.tsx の AIX_ACTION_META[action].templateCategory と必ず一致させること（フロントはこの値で TemplateModal の initialCategory を開く）
const AIX_SUGGEST_TEMPLATE_CATEGORY: Record<string, string> = {
  condition_hearing: "ヒアリング【AIX】",
  greeting_viewing: "挨拶【AIX】",
  property_recommendation: "物件オススメ【AIX】",
  property_send: "物件ピックアップした【AIX】",
  property_check_result: "物件確認した【AIX】",
  estimate_sheet: "見積書送る【AIX】",
  viewing_invite: "内覧へ！【AIX】",
  application_push: "申込へ！【AIX】",
  meeting_place: "内覧【AIX】",
  acknowledge_check: "確認します【AIX】",
  followup_revive: "追客する【AIX】",
};

async function handleAction(request: NextRequest): Promise<Response> {
  try {
    const body = await request.json();
    const { action, account, customer_name, image_url, image_urls, condition_image_url, property_image_url, customer_conditions, extra_input, parsed_estimate, recent_messages, check_pattern, vacating_note, calendar_info, vacancy_status, has_estimate, move_out_date, keyword, property_name, property_names, property_vacancy_dates, property_count, all_properties_available, prop_statuses, include_estimate_text, show_viewing_invite, app_push_type, appeal_points, other_room_status, conversation_id: conversationId } = body;
    // 2026-09-18 竹内: 見積書送る【AIX】の「🎁 キャンペーン」欄（任意）。入れると2通目（カバーレター）に1文が入る
    const estimateCampaign = typeof body.estimate_campaign === "string" ? body.estimate_campaign : "";
    // 2026-09-17 竹内（AIX キャッシュ点検）: 会話 ID を計測用ヘッダ（x-sumora-llm-conversation）へ。POST で run() した箱に入れる
    const reqCtx = aixRequestCtx.getStore();
    if (reqCtx) reqCtx.conversationId = typeof conversationId === "string" && conversationId ? conversationId : null;

    // #30: max_tokens 尻切れ検知ログ・max_tokens決定用のアクション名（リクエストスコープ）
    const currentAction = String(action ?? "");

    // AIX完了後テンプレ誘導: レスポンスに suggest_template_category を付与（マッピングのあるアクションのみ）
    const suggestTemplateCategory = AIX_SUGGEST_TEMPLATE_CATEGORY[currentAction] ?? null;

    // base_message: AIX生成済みドラフト。conversation_match と併用時は「書き直し」ではなく「会話適応」モードになる
    const baseMessage = typeof body.base_message === "string" && body.base_message.trim() ? body.base_message.trim() : null;

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
    // こちら（スタッフ）の最後の送信が今日 → 今日すでに挨拶済み → 挨拶行なし（G32: お待たせ致しました は禁止語）
    // こちらの最後の送信が昨日以前（または送信なし） → 今日初めての挨拶 → お世話になっております
    const todayJST = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const toJSTDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const recentMsgArray = Array.isArray(recent_messages)
      ? (recent_messages as Array<{ sender: string; rawCreatedAt?: string }>)
      : [];
    // ④修正: AIXで返信する運用ではAIX送信もスタッフ送信として扱う（is_aix_generated の除外を削除）。
    //   除外すると「今日AIXで挨拶済みなのに再度お世話になっております」「AIX返信済みなのに初回挨拶」になるため
    const lastStaffMsg = [...recentMsgArray].reverse().find(m => m.sender === "staff");
    const staffMessagedToday = !!lastStaffMsg &&
      !!lastStaffMsg.rawCreatedAt &&
      toJSTDate(lastStaffMsg.rawCreatedAt) === todayJST;
    // 真の初回判定: スタッフ返信（AIX送信含む）が一度もない = 初めてのスタッフ返信
    const isFirstEverReply = !(recentMsgArray as Array<{ sender?: string; text?: string }>).some(
      m => m.sender === "staff" && m.text && m.text !== "[画像]" && m.text !== "[動画]"
    );
    // お客様が最後に送ったメッセージ（= スタッフが返信する場面）かどうか
    // 向こうから連絡が来てすぐ（90分以内）は何時でも「お世話になっております」（「夜分遅くに」は使わない）
    const lastMsgSender = [...recentMsgArray].reverse().find(m => m.sender === "customer" || m.sender === "staff")?.sender ?? "staff";
    const customerInitiated = lastMsgSender === "customer";
    // お客様の最後の発言から何分か（夜の挨拶を「こちらからの連絡」か「返信」かで分ける。発言が無ければ こちらからの連絡）
    const lastCustomerMsg = [...recentMsgArray].reverse().find(m => m.sender === "customer");
    const minutesSinceLastCustomer: number | null = !lastCustomerMsg
      ? Number.POSITIVE_INFINITY
      : lastCustomerMsg.rawCreatedAt && !Number.isNaN(Date.parse(lastCustomerMsg.rawCreatedAt))
        ? (Date.now() - Date.parse(lastCustomerMsg.rawCreatedAt)) / 60000
        : null;

    // 挨拶（全アクション共通・#19）: 時間帯・初回・当日挨拶済み・お客様の最後の発言からの時間で挨拶文を一元決定
    const jstHourNow = (new Date().getUTCHours() + 9) % 24;
    // todayJST は既に line 439 で "YYYY-MM-DD" 形式で定義済み → 日本語表記に変換
    const todayJSTFmt = todayJST.replace(/(\d{4})-(\d{2})-(\d{2})/, (_, y, m, d) => `${y}年${parseInt(m)}月${parseInt(d)}日`);
    const greetingPhrase = buildGreeting(jstHourNow, isFirstEverReply, staffMessagedToday, minutesSinceLastCustomer);
    const nightGreeting = greetingPhrase.startsWith("夜分遅くに");
    // AI自由生成プロンプトに注入する挨拶時間ルール（挨拶を含みうるアクションで使用）
    // G32: 当日送信済み（greetingPhrase=""）は挨拶行なし。「お待たせ致しました」は禁止語
    const greetingTimeNote = greetingPhrase
      ? `\n\n【挨拶の時間ルール（共通・必ず守る）】現在時刻はJST${jstHourNow}時台。メッセージに挨拶を入れる場合は必ず「${greetingPhrase}」を使うこと（${nightGreeting ? "夜にこちらから届ける連絡のため。「お世話になっております」と重ねない" : "「夜分遅くに失礼致します」「夜遅くに失礼します」は書かない"}）。挨拶が不要な構成・固定フォーマットの場合は挨拶を追加しないこと。「お待たせ致しました」「お待たせいたしました」は禁止語。\n・名前と挨拶文は必ず同じ行につなげて書くこと（例：「〇〇さん${greetingPhrase}」）。名前だけを単独の行・単独の一文に置くのは絶対禁止。`
      : `\n\n【挨拶の時間ルール（共通・必ず守る）】現在時刻はJST${jstHourNow}時台。本日すでにこちらから送信済みのため挨拶行は書かない（「お世話になっております」「お待たせ致しました」「お待たせいたしました」は禁止）。名前行「〇〇さん」または本題から始めること。`;

    // 直近の会話履歴テキスト（viewing_invite・application_push で使用）
    // 2026-09-15 竹内（みく事例）: スタッフが送った画像（物件資料・御見積書）は履歴から丸ごと消えていて、どの物件の資料を送ったか見えなかった。
    //   送った時の Vision 読み取り（sent_properties）で物件名が分かる画像は「[画像: 〇〇 101号室の資料・御見積書]」として残す（分からない画像は従来どおり落とす）
    const recentMsgsForHistory = Array.isArray(recent_messages) ? (recent_messages as Array<{ sender: string; text: string; imageUrl?: string | null }>) : [];
    const staffImageLabels = conversationId
      ? await propertyLabelsForImages(conversationId, recentMsgsForHistory.filter((m) => m.sender === "staff" && m.imageUrl && (!m.text || m.text === "[画像]")).map((m) => m.imageUrl as string)).catch(() => new Map<string, string>())
      : new Map<string, string>();
    // 2026-09-16 竹内（𝒮 さん事例）: 履歴の行に時刻が無いと8日前の自分の発言を「先程」と書いてしまう → 時刻を別ブロックで渡す
    const aixLastStaffAt = [...recentMsgsForHistory].reverse()
      .find((m) => m.sender === "staff" && !!m.text && !/^\s*\[(?:画像|動画|スタンプ|ファイル)\]\s*$/.test(m.text) && (m as { rawCreatedAt?: string }).rawCreatedAt)
      ?.["rawCreatedAt" as keyof typeof recentMsgsForHistory[number]] as string | undefined;
    const aixLastCustomerAt = [...recentMsgsForHistory].reverse()
      .find((m) => m.sender === "customer" && (m as { rawCreatedAt?: string }).rawCreatedAt)
      ?.["rawCreatedAt" as keyof typeof recentMsgsForHistory[number]] as string | undefined;
    const aixClockNote = buildConversationClockNote(
      aixLastStaffAt && !Number.isNaN(Date.parse(aixLastStaffAt)) ? Date.parse(aixLastStaffAt) : null,
      aixLastCustomerAt && !Number.isNaN(Date.parse(aixLastCustomerAt)) ? Date.parse(aixLastCustomerAt) : null,
      Date.now(),
    );
    const recentHistory = recentMsgsForHistory.length > 0
      ? aixClockNote + "\n\n【直近の会話履歴（この流れを踏まえて文を作ること）】\n" +
        recentMsgsForHistory
          .map((m) => {
            const label = m.sender === "staff" && m.imageUrl ? staffImageLabels.get(m.imageUrl) : undefined;
            return label ? { ...m, text: `[画像: ${label}の資料・御見積書]` } : m;
          })
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

    // brainMeta（suggested_aix_meta）を1回フェッチしてRAGクエリ精度向上・プロンプト注入に使う
    type AixLocalBrainMeta = {
      action?: string | null;
      closing_strategy?: string | null;
      reply_direction?: string | null;
      key_topics?: string[] | null;
      avoid_topics?: string[] | null;
      urgency_appropriate?: boolean | null;
      property_search_params?: {
        // 2026-09-13 監査: brain-core は {property_name, room_no}[] で書く（旧型 string[] のまま join して「[object Object]」が入っていた）
        ng_properties?: Array<string | { property_name?: string | null; room_no?: string | null }> | null;
        preferences?: string | null;
        ng_points?: string | null;
        search_urgency?: string | null;
      } | null;
      hesitancy_pattern?: string | null;
      future_timeline?: string | null;
      customer_questions?: string[] | null;
      recommended_tone?: string | null;
      checkpoint_stage?: string | null;
      current_property?: string | null;
      template_hint?: string | null;
      // 訴求品質向上用（brain-core SuggestedAixMeta と同期・型ドリフト注意: customer_intentはbrain-core側でunion型）
      customer_intent?: string | null;
      winning_pattern?: string | null;
      // 2026-09-18 竹内（𝒮 さん事例）「今の状況はブレインが分かっているんやから、それと AIX のところリンクさせて」:
      //   ブレインの行動台帳（この会話で何件送ったか）。1件オススメの比較の言い方の可否に使う
      action_ledger?: {
        summary?: string | null;
        facts?: { propertiesSentCount?: number | null } | null;
      } | null;
      // ブレインが判断した物件の状況（退去予定・今ご内覧頂けるか）。締めを内覧誘導／申込誘導に決める
      property_state?: { notViewable?: boolean; vacancyDate?: string | null; viewableFrom?: string | null } | null;
      repeated_concern?: string | null;
      human_type_label?: string | null;
      engagement_stance?: "push" | "wait" | null;
      purchase_signal_level?: string | null;
      latent_intent?: string | null;
      customer_emotion?: string | null;
      condition_change_type?: string | null;
      last_aix_history?: string | null;
    };
    const { brainContext, brainMeta: aixBrainMeta, propertyCustomerId: resolvedPCID } = await (async (): Promise<{ brainContext: string; brainMeta: AixLocalBrainMeta | null; propertyCustomerId: string | null }> => {
      if (!conversationId) return { brainContext: "", brainMeta: null, propertyCustomerId: null };
      try {
        const { data } = await supabase
          .from("conversations")
          .select(`${BRAIN_META_RESTORE_COLUMNS}, property_customer_id`)
          .eq("id", conversationId)
          .single();
        const row = data as (BrainMetaRow & { property_customer_id?: string | null }) | null;
        // 2026-09-13 監査 抜け1: 下書きを表示すると suggested_aix_meta が消えるため、AIX を押す時点ではほぼ常にブレインの判断なしだった。
        //   表示で消えただけ（控えが最新のお客様発言を見た本分析）なら last_brain_meta から戻す
        const meta = (await resolveBrainMetaForGeneration(conversationId, row, "aix-action")).meta as AixLocalBrainMeta | null;
        const pcid = row?.property_customer_id ?? null;
        if (!meta) return { brainContext: "", brainMeta: null, propertyCustomerId: pcid };
        // AIX-META全フィールドをRAGクエリ文脈に注入（P0-2: meta.action追加で4経路を対称化。
        // purchase_signal_level/engagement_stanceをembeddingに乗せることで申込打診・内覧誘導の実例精度向上）
        const context = [
          meta.action ? `推奨アクション: ${meta.action}` : null,
          meta.closing_strategy,
          meta.reply_direction,
          meta.customer_intent ? `顧客インテント: ${meta.customer_intent}` : null,
          meta.checkpoint_stage ? `フェーズ: ${meta.checkpoint_stage}` : null,
          meta.winning_pattern ? `成功パターン: ${meta.winning_pattern}` : null,
          meta.repeated_concern ? `繰り返し懸念: ${meta.repeated_concern}` : null,
          meta.human_type_label ? `顧客タイプ: ${meta.human_type_label}` : null,
          meta.purchase_signal_level ? `温度感: ${meta.purchase_signal_level}` : null,
          meta.engagement_stance ? `押し引き: ${meta.engagement_stance}` : null,
          ...(meta.key_topics ?? []),
        ].filter(Boolean).join(" ");
        return { brainContext: context, brainMeta: meta, propertyCustomerId: pcid };
      } catch { return { brainContext: "", brainMeta: null, propertyCustomerId: null }; }
    })();

    // 2026-09-15 竹内（yasuki 事例）: 内覧に行ったスタッフが分かったこと（誰が契約するか・誰と相談しているか等・会話に書かれない事情）は
    //   全 AIX の前提。ブレインの判断の有無に関係なく、各 AIX に渡る brainGuidanceNote の末尾に付ける
    const aixViewingReportNote = conversationId ? viewingReportNoteForReply(await loadViewingReports(conversationId)) : "";
    // ブレインノートをプロンプトに注入（戦略系→制約系の順）
    const brainGuidanceNote = (() => {
      if (!aixBrainMeta) return "";
      const lines: string[] = [];
      // M4: engagement_stance=wait 時は押しを完全ゲート
      // generate-reply の closingGatedByStance と同等実装
      const closingGatedByStance = aixBrainMeta.engagement_stance === "wait";
      if (closingGatedByStance) {
        lines.push(
          `- ⏸️ 押し引きスタンス: WAIT（待ちの局面）— 強推し直後の了承、またはネガ文脈（断り・キャンセル・否決・募集終了）の直後です。希少性訴求・申込期限の明示・CTA・新規物件提案は今回の返信に一切入れないこと。受け止めと見守りの姿勢で締めること`
        );
      }
      // ── 戦略系（どう攻めるか）──────────────────────────
      // 2026-09-15 竹内（みく事例）: 成約戦略・今の物件は会話全体の方針（ブレインの推定）。スタッフが AIX で入れた物件・結果と食い違う時は使わない
      if (aixBrainMeta.closing_strategy && !closingGatedByStance) {
        lines.push(`【🎯 成約戦略（会話全体の方針・参考。今回スタッフが入れた物件・確認結果と食い違う時は使わない）】${aixBrainMeta.closing_strategy}`);
      }
      if (aixBrainMeta.checkpoint_stage) {
        lines.push(`【📍 会話フェーズ】${aixBrainMeta.checkpoint_stage}`);
      }
      if (aixBrainMeta.customer_intent) {
        const intentGuide: Record<string, string> = {
          question: "質問への回答を最優先。訴求は簡潔に",
          consultation: "相談に寄り添う姿勢を示してから提案する",
          desire: "希望の実現イメージが湧く訴求を前面に",
          decision: "決断の後押しになる確定情報・強みを明確に",
          positive: "前向きな流れを活かして次の一歩を示す",
          negative: "懸念に配慮し押し売り感のない訴求にする",
          chat: "軽いトーンを保ち売り込みすぎない",
        };
        const guide = intentGuide[aixBrainMeta.customer_intent];
        lines.push(`【🧭 顧客インテント】${aixBrainMeta.customer_intent}${guide ? `（${guide}）` : ""}`);
      }
      if (aixBrainMeta.repeated_concern) {
        lines.push(`【🔁 繰り返し懸念】お客様が繰り返し気にしているテーマ:「${aixBrainMeta.repeated_concern}」。訴求ポイントの選択でこの懸念に応える点を優先すること`);
      }
      if (aixBrainMeta.winning_pattern && !closingGatedByStance) {
        lines.push(`【🏅 この顧客に効く成功パターン】${aixBrainMeta.winning_pattern}`);
      }
      if (aixBrainMeta.current_property) {
        lines.push(`【🏠 現在話している物件（ブレインの推定。スタッフが入れた物件名・引用返信の物件と食い違う時はそちらが正）】${aixBrainMeta.current_property}`);
      }
      if (aixBrainMeta.recommended_tone) {
        const toneGuide: Record<string, string> = {
          "共感的": "冒頭1文で顧客の気持ちを受け止めてから本題に入る。急かさない",
          "テキパキ": "前置きを省き結論から書く。1文を短く、要点を先に",
          "慎重": "断定・楽観表現を避け確認済みの事実のみ伝える",
          "明るく前向き": "ポジティブな言葉で次の一歩を気持ちよく示す",
          "普通": "通常のスモラトーン",
        };
        const guide = toneGuide[aixBrainMeta.recommended_tone];
        lines.push(`【文体】${aixBrainMeta.recommended_tone}${guide ? `（${guide}）` : ""}`);
      }
      if (aixBrainMeta.template_hint) {
        lines.push(`【📋 テンプレートヒント】「${aixBrainMeta.template_hint}」スタイルが最も効果的`);
      }
      // ── 制約系（外してはいけないガードレール）────────────
      // 2026-09-15 竹内（みく事例）: この AIX が送る事柄・スタッフが入れた事柄（御見積書の同封・内覧／申込誘導）は避ける話題から外す
      //   （旧: 物件確認した＋御見積書同封に「見積書」「初期費用」を絶対に言及しない、で入れていた）
      const aixAvoid = avoidTopicsForAix(action, aixBrainMeta.avoid_topics, {
        estimateEnclosed: !!(body.estimate_image_url || (Array.isArray(body.estimate_image_urls) && (body.estimate_image_urls as unknown[]).some(Boolean))),
        viewingInvite: body.show_viewing_invite === true,
        applicationInvite: body.check_application_invite === true,
      });
      if (aixAvoid.length) {
        lines.push(`【🚫 絶対に言及しない語・話題（言い換え・同義語も禁止）】${aixAvoid.join("・")}`);
      }
      if (aixBrainMeta.urgency_appropriate === false) {
        lines.push("【⛔ 緊急表現禁止】直近で緊急表現を多用済みのため「今なら」「残り〇室」「お早めに」「先着」等の緊急を煽る表現は使わないこと");
      }
      if (aixBrainMeta.hesitancy_pattern) {
        const hesitancyGuide: Record<string, string> = {
          thinking: "「少し考えたい」パターン→ 押し過ぎず背中を押す1点に絞って伝える",
          callback: "「後で連絡する」パターン→ 次アクションを1つだけ提案し待つ姿勢を示す",
          waiting: "「少し待って」パターン→ 急かさず安心感を与える内容にする",
          undecided: "物件迷いパターン→ 迷いの原因に寄り添い比較軸を整理する",
          timeline: aixBrainMeta.future_timeline
            ? `タイムライン確定（${aixBrainMeta.future_timeline}）→ そのタイムラインを尊重し前倒しを急かさない`
            : "タイムライン調整中→ 顧客ペースを尊重する",
        };
        const guide = hesitancyGuide[aixBrainMeta.hesitancy_pattern];
        if (guide) lines.push(`【💭 決断保留パターン】${guide}`);
      } else if (aixBrainMeta.future_timeline) {
        lines.push(`【📅 顧客の決断タイムライン】${aixBrainMeta.future_timeline}（前倒し・急かし禁止）`);
      }
      if (aixBrainMeta.customer_questions?.length) {
        lines.push(`【⚠️ 顧客の質問（全て回答すること）】${aixBrainMeta.customer_questions.join("・")}`);
      }
      return lines.length > 0 ? "\n\n" + lines.join("\n") : "";
    })() + aixViewingReportNote;

    // 物件提案系（property_send / property_recommendation）専用: PSP注入ノート
    const pspGuidanceNote = (() => {
      const psp = aixBrainMeta?.property_search_params;
      if (!psp) return "";
      const lines: string[] = [];
      const ngNames = (psp.ng_properties ?? [])
        .map((p) => typeof p === "string" ? p : [p?.property_name, p?.room_no].filter(Boolean).join(" "))
        .map((s) => s.trim()).filter(Boolean);
      if (ngNames.length) {
        lines.push(`【🚫 提案禁止物件（既送付・拒否済み・絶対に含めない）】${ngNames.join("、")}`);
      }
      if (psp.preferences) lines.push(`【👍 お客様が刺さるポイント（積極的に訴求すること）】${psp.preferences}`);
      if (psp.ng_points) lines.push(`【⚠️ 地雷・NGポイント（言及禁止）】${psp.ng_points}`);
      if (psp.search_urgency) lines.push(`【⚡ 物件提案緊急度】${psp.search_urgency}`);
      return lines.length > 0 ? "\n\n" + lines.join("\n") : "";
    })();

    // 全AIXアクション共通ルール（静的ルール + 動的ブレイン制約）
    const aixBrainRules = AIX_CURATED_AND_CRITICAL_RULES + brainGuidanceNote;

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

    // ⑦修正: 生成文の共通後処理（号室の先頭ゼロ除去 + 内部メモ分離）を一元化するヘルパー。
    //   メインパス末尾だけでなく conversation_match 系の早期returnパスでも必ず通すこと
    const finalize = (text: string): { message: string; notice: string | null } => {
      // 号室の先頭ゼロを除去（日本の号室は0始まりにならない: 0806→806。\b はASCII境界のみ機能するため (?<!\d) を使用）
      const zeroStripped = text.replace(/(?<!\d)0+(\d+)号室/g, "$1号室");
      // 2026-09-15 竹内（隼斗事例）「曜日は日本基準に、18日は金曜日」: 「9/18(木)」のような曜日の食い違いを日付を正として直す（日本時間の暦・jst-date）
      const { text: stripped, applied: weekdayFixed } = fixDateWeekdays(zeroStripped);
      if (weekdayFixed.length > 0) console.log(JSON.stringify({ tag: "aix:weekday-fixed", action: currentAction, conversationId, applied: weekdayFixed }));
      // 2026-09-15 竹内「こんなの絶対にいれない」: AI の作業メモ（「物件資料を確認します。」「〜のパターンで返信します。」）を落とす（返信生成と同じ関数）
      const meta = stripMetaNarration(stripped);
      if (meta.removed.length > 0) console.log(JSON.stringify({ tag: "aix:meta-narration-removed", action: currentAction, conversationId, removed: meta.removed.map((r) => r.slice(0, 60)) }));
      // 2026-09-15 竹内（YUYA 事例の本番確認で AIX 保証会社についてに「夜分遅くに失礼致します」が入った）: 返信生成・修正版・補助ボタンと同じ決定論置換を
      //   AIX の仕上げにも通す（夜間挨拶の除去・承知→かしこまりました・約束の「すぐに」除去・単独の承りました・挨拶の重複。方針4・5・Aoi 事例）
      //   2026-09-15 竹内（慶次事例）: 夜にこちらから届ける連絡（挨拶の決定が夜分）は夜間挨拶を1つ残し、お世話になっておりますを重ねない
      const banned = normalizeBannedPhrasing(meta.text, { keepNightGreeting: nightGreeting });
      // 2026-09-16 竹内（𝒮 さん事例）: こちらの前の発言が3時間より前なら「先程」を落とす（会話を合わせるでも同じ穴）
      const recentRef = fixStaleRecentReference(banned.text, aixLastStaffAt && !Number.isNaN(Date.parse(aixLastStaffAt)) ? Date.parse(aixLastStaffAt) : null, Date.now());
      if (recentRef.applied.length > 0) {
        console.log(JSON.stringify({ tag: "aix:stale-recent-ref", action: currentAction, conversationId, applied: recentRef.applied }));
        banned.text = recentRef.text;
      }
      if (banned.night || banned.shochi || banned.hasty || banned.uketamawari || banned.greetDup) {
        console.log(JSON.stringify({ tag: "aix:banned-phrasing-fixed", action: currentAction, conversationId, night: banned.night, shochi: banned.shochi, hasty: banned.hasty, uketamawari: banned.uketamawari, greetDup: banned.greetDup }));
      }
      // 2026-09-17 竹内（まりあ事例）「かしこまりました！って生成された文に入っているけど、文の構成としておかしいし、
      //   全力でサポートさせて頂きます。もこれ返信の部分で使う部分なので、AIXの物件ピックアップや、物件オススメに入らない文となる」:
      //   物件を送る通は「送りました」の報告なので、依頼の受諾（かしこまりました）と見つかるまでの宣言（全力サポート）を落とす。
      //   実データ180日: ピックアップの実送信362件のうち「かしこまりました」1件・「全力でサポート」0件（どちらも返信で使う言葉）。
      //   締めを足すのは物件ピックアップだけ（物件オススメは「お手隙の際にご査収ください」を使わない決まり）
      let sendCleaned = banned.text;
      if (currentAction === "property_send" || currentAction === "property_recommendation") {
        const fixed = stripReplyOnlyPhrases(sendCleaned, { addCloser: currentAction === "property_send" });
        if (fixed !== sendCleaned) {
          console.log(JSON.stringify({ tag: "aix:reply-only-phrase-stripped", action: currentAction, conversationId }));
          sendCleaned = fixed;
        }
      }
      // 2026-09-17 竹内（✩ さん事例）「生成された文で何故かへんな物件名が入ってしまった」:
      //   ピックアップ行に入れてよいのはエリア・お客様名・条件だけ（実送信363件で号室0件・英大文字2語の物件名0件）。
      //   条件の材料が空の時に LLM が会話の物件名（見積書を送った物件）を拾ってエリアの列挙に混ぜていた
      if (currentAction === "property_send") {
        const convNames = extractPropertyLabels(
          (Array.isArray(body.recent_messages) ? body.recent_messages as Array<{ text?: string | null }> : [])
            .map((m) => m.text ?? "").join("\n"),
        );
        const picked = stripPropertyNameFromPickupLine(sendCleaned, convNames);
        if (picked.removed.length > 0) {
          console.log(JSON.stringify({ tag: "aix:pickup-line-property-name", action: currentAction, conversationId, removed: picked.removed }));
          sendCleaned = picked.text;
        }
      }
      // 2026-09-17 竹内（AIX 物件確認した）「変に割引できる金額少ないや、費用かかる等いれないし、退去予定ともっと
      //   分かりやすくいれて、入居ちゃんと出来るようにする」: 退去予定のお部屋の通は「いつから見られるか」を伝える通。
      //   実データ365日・退去予定を含む実送信277件のうち、費用のマイナスの説明（割引出来る金額が少ない・初期費用は
      //   かなりかかってしまう・敷金もかかります）は0件。日付が具体的な通は例外なく「退去日の翌日以降ご内覧可能」。
      //   複数物件は実送信が箇条書きの「※ 9月30日退去予定」なので、行を足すのは退去予定が1件の時だけ（掃除は常に行う）
      if (currentAction === "property_check_result") {
        const vacDatesForNotice = ((property_vacancy_dates as (string | null)[] | undefined) ?? [])
          .map((d) => (d ?? "").trim())
          .filter((d) => !!d && !isPastVacancyDate(d) && !!viewableFromVacancyDate(d));
        const uniqueVacDates = Array.from(new Set(vacDatesForNotice));
        const fixedVac = ensureVacatingNotice(sendCleaned, uniqueVacDates, { insertWhenMissing: uniqueVacDates.length === 1 });
        if (fixedVac.applied.length > 0) {
          console.log(JSON.stringify({ tag: "aix:vacating-notice", action: currentAction, conversationId, applied: fixedVac.applied }));
          sendCleaned = fixedVac.text;
        }
      }
      // AIが内部メモを出力した場合、顧客向けメッセージと分離
      return extractNotice(sendCleaned, familyName || rawName);
    };
    // 線引き学習用: property_check_result の check_pattern を aix_generate_log に残す
    // （aix-weekly-learning が discarded を check_pattern 粒度で集計し、境界質問を分割起票するため）
    const generateLogCheckPattern =
      currentAction === "property_check_result" && typeof check_pattern === "string" && check_pattern
        ? check_pattern
        : null;
    // 条件違反の事後検証用: 生成時に使った顧客条件＋PSPのスナップショット（aix_generate_log.conditions_snapshot）
    // 2026-09-16 カイナ事例: 物件確認した×会話を合わせる は判定（内覧の流れ・部屋数・出口の直し）もここに足す（JSONB・新カラム無し）
    const conditionsSnapshot: Record<string, unknown> = {
      customer_conditions: customer_conditions ? String(customer_conditions).slice(0, 1000) : null,
      psp: aixBrainMeta?.property_search_params ?? null,
    };
    /**
     * AIX【申込へ】の返信の仕上げ（2026-09-16 竹内・💜 さん事例）。
     *   ①お客様が申込の情報（緊急連絡先・勤務先 等）を送ってきた返信の先頭の「はい😊！！」を落とす
     *     （実データ 120日・この場面の返信92件のうち「はい」始まりは2件）
     *   ②管理会社の営業時間外（18:00〜翌9:00）に申込を進めた時は「管理会社営業時間外となりますので、明日〜確認出来次第ご連絡」を入れる
     *     （実データ 180日「営業時間外」14件。生成は「審査結果分かり次第ご連絡」で、申込完了の確認より先に審査の話をしていた）
     */
    const applyReplyFinish = (text: string): string => {
      const custText = (Array.isArray(body.recent_messages) ? body.recent_messages as Array<{ sender?: string | null; text?: string | null }> : [])
        .filter((m) => m.sender === "customer").slice(-3).map((m) => m.text ?? "").join("\n");
      let out = text ?? "";
      if (APPLY_INFO_SENT_RE.test(custText)) {
        const stripped = stripLeadingBareAck(out);
        if (stripped !== out) console.log(JSON.stringify({ tag: "aix:apply-leading-ack-stripped", conversationId }));
        out = stripped;
      }
      const afterHours = isMgmtAfterHours(new Date().toISOString());
      const withLine = ensureAfterHoursApplyLine(out, afterHours);
      if (withLine !== out) console.log(JSON.stringify({ tag: "aix:apply-after-hours-line", conversationId }));
      return withLine;
    };
    // 早期return用: finalize結果をそのままレスポンスJSONにするショートハンド
    const finalizeResponse = (text: string, extra?: Record<string, unknown>) => {
      const { message, notice } = finalize(text);
      if (conversationId) {
        after(async () => {
          try {
            await supabase.from("aix_generate_log").insert({
              action_type: currentAction,
              conversation_id: conversationId,
              check_pattern: generateLogCheckPattern,
              generated_text: safeSlice(message, 2000),
              conditions_snapshot: conditionsSnapshot,
            });
          } catch (e) {
            console.error("[aix/action] aix_generate_log insert failed (after callback):", e);
          }
        });
      }
      return NextResponse.json({ ok: true, message_text: message, ...(notice ? { notice } : {}), ...(suggestTemplateCategory ? { suggest_template_category: suggestTemplateCategory } : {}), ...(extra ?? {}) });
    };

    // phrase_dictionary 取得（固定フォーマット出力でないアクションにのみフレーズ注入する）
    const phraseCategoryMap: Record<string, string> = {
      property_recommendation: "property_recommendation",
      property_send: "property_recommendation",
      property_check_result: "hearing_followup",
      viewing_invite: "viewing_invite",
      application_push: "application_push",
      meeting_place: "viewing_invite",
      condition_hearing: "hearing_followup",
      followup_revive: "urgency_push",
      acknowledge_check: "hearing_followup",
    };
    const phraseCategory = phraseCategoryMap[action];
    // M-8: {{customer_name}} 置換には生の customer_name（LINE表示名フルネーム等）ではなく、
    // さん付き整形済みの name（「〇〇さん」/「お客様」）を渡す。
    // 生の名前を渡すとフレーズ側の「さん」と二重になり「〇〇さんさん」が生成されるバグがあった
    const phraseText = phraseCategory ? await getPhrases(phraseCategory, name) : "";

    let message_text = "";
    let parsed_estimate_result = null;
    let estimate_text_result = "";
    // M2: このAIX送信で御見積書を同封したか（レスポンス経由で aix_usage_logs.estimate_sent に永続化する）
    let estimate_sent_result = false;
    let hearing_intro_result = ""; // condition_hearing のAI導入メッセージ（LL-09）
    let hearing_form_content = ""; // condition_hearing のフォーム本体（別送用・message_textには入れない）
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

【このメッセージの目的】
お客様がひと目で物件の魅力を把握し、「見てみたい」「どうですか？」とシンプルに返信しやすい短いメッセージを作る。長い説明・箇条書きは不要。

【出力フォーマット — 必ずこの構成で出力すること】

🌟[物件名]（部屋番号がある場合は半角スペースを空けて記載）

[物件の最大の強みを1〜2点・簡潔に。お客様の希望条件に最も響くポイントを選ぶ。例：「家賃8万円台・敷金礼金なし」「築浅・ペット可」など。★「敷礼0円」「敷金礼金なし」は敷金が0円かつ礼金が0円の場合のみ書いてよい（どちらか一方でも金額がある場合は絶対に書かない）★お客様が駅・エリアを希望していない場合は「〇〇駅徒歩〇分」をここに入れない]、[お客様名]にかなりオススメ出来るお部屋となります！！

[物件のオススメポイントを2〜4文・シンプルな文章でまとめる。箇条書き禁止。家賃・間取り・設備の中からお客様の希望条件に合った特徴を優先して自然な文章にまとめる。長い説明や肉付けは不要]

[締め文 — 以下の条件で使い分ける]
・退去予定が明示または画像から読み取れる場合：「[退去予定日]退去予定のため、[退去翌日]以降にご内覧可能です！！」
  【🔴 退去日の読み取りルール（必ず守ること）】
  ① 備考欄（remarks欄）に「解約予定」「退去予定」「解約日」と書かれた日付がある場合 → その日付を退去予定日として使う
  ② 現況/入居時期の欄は「退去後に入居可能になる日」であり退去予定日ではない → 絶対に退去予定日として使わない
  【🔴 日付フォーマット（必ず守ること）】
  ・西暦（年）を含めない。「○月○日」の形式のみ
  ・内覧可能日は退去予定日の翌日（8月31日退去なら9月1日以降）
・「建築中」「新築未完成」「竣工予定」など内覧不可の物件の場合：「※こちらのお部屋は建築中のため、[竣工・入居予定時期]のご入居となります！！」のみで締める
  【🔴 建築中物件の日付フォーマット】西暦を含めない。「○月」または「○月○日」のみ
・通常の空室物件：「お手隙の際にご査収ください😊！！」で締める

${MOVE_IN_TIMING_RULE}

【フォーマットルール — 必ず全て守ること】
・物件名は先頭に必ず🌟をつける（🌟の後に半角スペースは入れない）
・[お客様名]はユーザーメッセージで渡されたお客様名をそのまま使うこと（すでに「さん」が付いているため「さん」を重ねて付けない）・呼び方は最初から最後まで一貫して変えない
・お客様名の前後に助詞（「にも」「からも」「ても」等）が来る場合でも、名前を省略・切断しない。例：「〜のお部屋となります！！もえかさんにかなりオススメ〜」のように名前全体を必ず使うこと
・「！！」（全角感嘆符2つ）を使用する（スモラスタイル）・「！」1つは使わない
・絵文字は 😊 のみ・最大1個まで・なくてもよい
・数字は具体的に（「63,000円」「徒歩7分」「6帖」など）
・箇条書き（「・」始まりの行）は使わない。自然な文章で書く
・間取りが1R（ワンルーム）の場合は「洋室〇帖」の形で広さを文章中に自然に入れる
・間取りの広さはLDK→洋室の順で書く（洋室から始めない）
・築年の記載形式は「2006年1月築（築20年）」のように「年月築（築〇年）」とする。築浅（築1〜5年程度・入居実績あり）は「2024年築で築年数浅く」の形でも可。「築浅」だけの記載は禁止
・【🔴 新築と築浅を混同しない】物件が「新築」（当年築・未入居・建築中/竣工予定含む）の場合は「新築」の1語のみで表現し、「築年数浅く」「築年数が浅い」「築浅」等を併記することは絶対禁止。「築年数浅く」を使うのは新築でない築浅物件のときだけ
・「条件が良く」という表現は単独で使わず、必ず「〇〇ですのでかなり条件が良く〜」のように理由を先に述べる形にする
・お客様の条件より家賃・広さが劣る物件の場合は「〜より一回り狭くなってしまいますが、〜の点がかなりオススメ出来るお部屋となります！！」と正直に伝えながら強みを前面に出す
・「！！」（全角感嘆符2つ）を積極的に使う（スモラスタイル）
・全体の文量は短く。お客様が読んで即座に「見てみたい」「いいですか？」と返信できる長さにする

【絶対ルール — スタッフの判断を信頼する】
・スタッフがこのボタンを押して物件画像を入れた時点で「この物件をオススメする」という判断は確定している
・「条件に合わない」「送付非推奨」「チェックリスト」「確認してください」等の内部判断・拒否・アセスメント文を出力することは絶対禁止
・希望条件と完全に合わなくても必ず上記フォーマットの物件オススメ文を生成する
・条件と合わない点がある場合は「〜より一回り狭くなってしまいますが、〜の点がかなりオススメ出来るお部屋となります！！」のように正直に伝えながら強みを前面に出す（既存ルール通り）
・【🔴 絶対禁止】「〇ヶ月後のご入居にもしっかり対応頂けるお部屋となります」（「◯ヶ月後のご入居にも〜対応」系の言い回し全般）は絶対に使わない

【出力形式の絶対ルール】
・出力の最初の文字は必ず🌟であること。🌟より前に一切の文字を出力してはいけない
・「礼金がある点について確認しました」「〜のため〜は使わず作成します」などのシステム注記・確認メモ・前置き文は絶対に含めないこと
・出力は純粋な物件オススメ文のみ。内部判断・AIの思考過程・注意書きは一切出力禁止

【家賃相場・価格比較の絶対禁止】
・「〇〇駅周辺の家賃相場」「相場と比べて」「市場相場」「価格帯として」などの家賃相場・市場相場の記述は絶対禁止
・お客様の価格懸念・コスト感への直接的な返答（「ご予算に対して〜」「家賃が高めですが〜」等の会話的応答）は禁止
・出力は物件の特徴・設備・立地・条件を紹介する純粋な物件オススメ文であること。会話形式の文は禁止

${aixPropertyRecommendationRules}
・敷金・礼金なしを説明する場合は「敷金・礼金なしのため初期費用をかなり抑えてご入居頂けます！！」の表現を使う（「〜抑える事ができ」等の言い回しは使わない）
・【🔴🔴 最優先・絶対禁止】物件資料の「礼金」欄に1円でも金額がある場合（例：礼金110,000円・礼金1ヶ月等）は「敷金礼金なし」「敷礼0円」「初期費用をかなり抑えて」「初期費用を抑えられる」等の表現を本文のどこにも絶対に使わない。画像で「敷金: なし」と見えても「礼金: 〇〇円」があれば使用禁止。この禁止は他のどのルール・例文より優先する。
・「敷金・礼金なし」「初期費用を抑えられる」系の文言は【敷金が0円かつ礼金が0円の場合のみ】使う。敷金のみ0・礼金のみ0の場合は使わない
・【🔴 絶対禁止】礼金に金額がある場合（礼金1ヶ月・礼金〇〇円等）は、本文中に礼金・敷金関連の記述を一切入れない。「礼金1ヶ月のみ」「敷金なし」「礼金低め」「（敷金なし）」等の部分的アピールも禁止
・「築浅」という言葉だけで書くことは絶対禁止。築浅物件（新築を除く）は「2022年築で築年数浅く」の形で。新築物件は「新築」の1語のみとし「築年数浅く」「築浅」を併記しない（重複表現になるため絶対禁止）。古い物件は「2006年1月築（築20年）」の括弧形式で記載

【設備オススメルール — 最優先・上の禁止ルールより優先】
※ここに書かれた設備は「物件資料に実際に記載がある場合のみ」書くこと。資料にない設備を推測で書くのは絶対禁止。
・インターネット無料（ネット無料／Wi-Fi無料／無料インターネット／光回線無料）がある場合 → 本文中に自然に盛り込む。表現例「インターネット無料で毎月の通信費も節約出来ます！！」「Wi-Fi無料で月々のお支払いコストも抑えられます！！」。※「月額〇〇円お得」「年間〇〇円節約」等の金額換算は引き続き絶対禁止
・独立洗面台がある場合 → 本文中に盛り込む。お客様が女性と判断できる場合は朝の身支度がしやすい点を1文だけ自然に添える。お客様の希望条件に「独立洗面台」が明記されている場合は必ず触れる
・下の文で家賃・管理費に触れる場合は「家賃管理費込○○円と毎月の費用をしっかり抑えられ〜」のように必ず「毎月の費用」と入れる

{{examples}}

{{knowledge}}

{{phrases}}

${SMORA_COMMON_RULES}`;

      // フォーマット固定: DEFAULT_PROP_SYSTEM を直接使用（DBで上書きしない）
      // RAG用顧客文脈: キーワード + 顧客条件 + AIX-META（brainContext）+ 最新メッセージ
      // P1-1: property_sendと同様にkeyword・latestCustomerMsgを追加して会話ごとに実例が散るようにする
      const recKwPrefix = keyword ? `【伝えたいこと】${String(keyword)} ` : "";
      // 2026-09-13 AIX-META × RAG 監査: 実例・ナレッジを引く問いには AIX-META（戦略語）を混ぜない（文書側に無い語で問いが離れる）。
      //   成功パターン（人物像＋パターンで埋め込み）を引く問いにだけ AIX-META を足す
      const recRagContext = [
        recKwPrefix,
        customer_conditions ? String(customer_conditions) : "",
        latestCustomerMsg,
      ].filter(Boolean).join(" ").trim() || undefined;
      const recStrategyContext = [recRagContext ?? "", brainContext].filter(Boolean).join(" ");

      const [examples, knowledge, recStarNote, propRules, recBrainAddendum, recWinningNote, recPropertyExamples, recPatternHints] = await Promise.all([
        getPropertyExamples(),
        getPropertyKnowledge(conversationId, recRagContext),
        getStarredExamplesForAction(["property_recommendation", "proposing"], latestCustomerMsg, aixBrainMeta),
        // 2026-09-17 竹内（AIX キャッシュ点検）: global（準静的）と action 別（経路固有）に分けて受ける
        fetchPromptRulesSplit("property_recommendation", {}).catch(() => ({ global: "", action: "" })),
        loadBrainTemplate("property_recommendation"),
        // 成約パターンRAG（AIX-META再ランキング）: 顧客条件+META+最新メッセージで「この顧客に効いた訴求」を引く
        getWinningPatternsForProperty(recStrategyContext, aixBrainMeta),
        // 過去に実送信した物件オススメ文の実例（entry_source='aix_property'・⭐=顧客反応あり優先）
        // P0-1: queryTextを渡してpgvector主経路を有効化（未渡し時は全顧客が同じ固定5件になる）
        getAixPropertyExamples("property_recommendation", recRagContext),
        // 類似条件顧客の勝ちパターン（property_selection_patterns）を並列取得
        (async (): Promise<string[]> => {
          if (!resolvedPCID) return [];
          try {
            const { data: pcRow } = await supabase
              .from("property_customers")
              .select("rent_max, max_rent, floor_plan, layout")
              .eq("id", resolvedPCID)
              .maybeSingle();
            const rentMax = ((pcRow as { rent_max?: number; max_rent?: number } | null)?.rent_max ?? (pcRow as { rent_max?: number; max_rent?: number } | null)?.max_rent) ?? null;
            const floorPlan = ((pcRow as { floor_plan?: string; layout?: string } | null)?.floor_plan ?? (pcRow as { floor_plan?: string; layout?: string } | null)?.layout) ?? null;
            if (!rentMax || rentMax <= 0) return [];
            let q = supabase
              .from("property_selection_patterns")
              .select("selling_points, property_customer_id")
              // 正解は「スタッフが選んで送った物件」。顧客の返信有無では判定しない
              .eq("selection_label", "selected")
              .gte("customer_rent_max", Math.round(rentMax * 0.85))
              .lte("customer_rent_max", Math.round(rentMax * 1.15))
              .limit(200);
            if (floorPlan) q = q.eq("customer_floor_plan", floorPlan);
            const { data: pspRows } = await q;
            if (!pspRows || pspRows.length === 0) return [];
            const counts: Record<string, number> = {};
            const seenPerCustomer: Record<string, number> = {};
            for (const row of pspRows) {
              const cid = (row.property_customer_id as string) ?? "__unknown__";
              if ((seenPerCustomer[cid] ?? 0) >= 5) continue;
              seenPerCustomer[cid] = (seenPerCustomer[cid] ?? 0) + 1;
              for (const pt of ((row.selling_points as string[]) ?? [])) {
                counts[pt] = (counts[pt] ?? 0) + 1;
              }
            }
            return Object.entries(counts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([pt]) => pt);
          } catch { return []; }
        })(),
      ]);

      // {{examples}} {{knowledge}} {{phrases}} プレースホルダーを除去（実データはuserメッセージ側へ移動してキャッシュHIT率を向上）
      const system = DEFAULT_PROP_SYSTEM
        .replace("{{examples}}", "")
        .replace("{{knowledge}}", "")
        .replace("{{phrases}}", "");
      // greetingTimeNote は固定フォーマット（物件オススメ文）に注入しない
      // recStarNote は user 側に移動（system に入れると固定フォーマットと干渉するため）
      // キャッシュ分離: system+DB ルール+共通ルール（全顧客共通・キャッシュHIT率HIGH）を静的ブロックに、
      // 顧客固有の brainGuidanceNote + recBrainAddendum を動的ブロックに分ける
      // 2026-09-17 竹内（AIX キャッシュ点検）: 静的部分を2ブロックに分ける。この system は共通 prefix（GENERATION_SYSTEM）で始まらず
      //   （役割文で始まり末尾に SMORA_COMMON_RULES）、global を先頭に出しても他経路と鍵を共有できないので、従来の並び
      //   （system → DB ルール → 共通ルール）を保つ。semiStatic＝system＋global（ai_prompts の上書き込み・全顧客同じ・従来どおり 1h）、
      //   routeStatic＝action 別ルール＋AIX_CURATED_AND_CRITICAL_RULES（5m）。global と action の混在順だけ従来（priority 順に混ぜる）と変わる。
      //   AIX_CURATED_AND_CRITICAL_RULES・action は "\n\n" 始まりなので、ブロック結合の "\n\n" と二重にならないよう先頭を落とす
      //   ttl は 1h のまま（点検: 物件オススメは miss が全て >1h 間隔・5〜60分の read が 8/19 回で、5m にすると write が 13/19 に増えて損）
      const recSystemSpec: SystemSpec = {
        semiStatic: system + propRules.global,
        routeStatic: (propRules.action + AIX_CURATED_AND_CRITICAL_RULES).replace(/^\n\n/, ""),
        ttl: "1h",
      };

      const conditionsText = customer_conditions as string | undefined;
      const recCustomerSummary = body.customer_summary as string | undefined;
      // 入居希望日ガード: 今日（JST）と比較して「ご希望日までのご入居に対応可能」と書いてよいか判定
      // 動的systemブロック側に入れる（日付は毎日変わるため静的ブロックのキャッシュを壊さない）
      const moveInDeadlineNote = buildMoveInDeadlineNote(
        [conditionsText ?? "", recCustomerSummary ?? "", extra_input ? String(extra_input) : ""].join("\n"),
        todayJST,
        todayJSTFmt
      );
      // 2026-09-17 竹内（現状伝えて・1件訴求）: この型だけ「出力の最初の文字は必ず🌟」を外す。
      //   キャッシュされる静的ブロック（全顧客共通）は触らず、動的ブロックで上書きする（鍵を割らない）
      const situationSystemOverride = isSituationKind(body.situation_kind)
        ? `\n\n【🔴 この通だけの上書き — 上の「出力の最初の文字は必ず🌟」より優先】\nこの通は「探した現状」を1文書いてから🌟の物件カードを出す。順序は 現状の1文 → 空行 → 🌟物件名 … 。\n現状の1文以外は🌟より前に書かない（システム注記・前置き・挨拶は従来どおり禁止）。`
        : "";
      const recSystemDynamic = brainGuidanceNote + (recBrainAddendum ? "\n\n【ブレイン改善ルール】\n" + recBrainAddendum : "") + moveInDeadlineNote + situationSystemOverride;

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
      // 類似条件顧客の実績から「刺さりやすいポイント」をプロンプトに注入
      // データが溜まるほど精度UP。データなし（初期）は空文字でスキップ。
      const patternHintsNote = recPatternHints.length > 0
        ? `\n\n【📊 類似条件のお客様にスタッフが選んで送った物件の特徴（実績データ由来）】\n同じ家賃帯・間取り希望のお客様に、スタッフが実際に選んで送った物件に多い特徴です。（オススメポイント）の選択時に優先的に訴求してください。\n${recPatternHints.join("・")}`
        : "";
      // 2026-09-17 竹内（現状伝えて・1件訴求）: 探した現状を🌟の前に1文で伝える型。
      //   実送信「大国町・本町・堺筋本町周辺全域からご条件に合った物件すべて探させて頂きましたところ空室のお部屋で
      //   募集御座いませんでしたが、1件退去予定のお部屋でMさんご希望のご条件にピッタリなお部屋が募集に出ております😊！！」
      const situationKind = isSituationKind(body.situation_kind) ? body.situation_kind : null;
      const situationOpts = {
        area: typeof body.situation_area === "string" ? body.situation_area : "",
        customerName: name,
        note: typeof body.situation_note === "string" ? body.situation_note : "",
      };
      const situationNote = situationKind ? `\n\n${buildSituationPromptNote(situationKind, situationOpts)}` : "";
      const userText = `お客様名は「${name}」です。お客様名は「${name}」をそのまま使うこと（すでに「さん」付きのため「さん」を重ねない・助詞の後でも省略禁止）。\n${name}へのオススメ物件メッセージを作成してください。${conditionsText ? `\n\nお客様の希望条件:\n${conditionsText}` : ""}${summaryNoteForRec}${pspGuidanceNote}${patternHintsNote}${extra_input ? `\n追加情報: ${extra_input}` : ""}${templateSampleNote}${templateStructureNote}${openingPointNote}${moveOutNote}${simpleModeNote}${skipConfirmationNote}${newArrivalNote}${situationNote}`;

      const knowledgeSection = knowledge ? `\n\n【物件オススメ時のノウハウ】\n${knowledge}` : "";
      // aix_property実例（実送信文・⭐顧客反応あり優先）があれば☆手動実例より優先。両方ある場合は実送信文を先に置く
      const examplesSection = (recPropertyExamples ? recPropertyExamples : "") + (examples ? `\n\n【スモラの実際の物件オススメ文（実例）】\n${examples}` : "");
      const phrasesSection = phraseText ? `\n\n【よく使うフレーズ】\n${phraseText}` : "";
      const recUserTextFinal = userText + recWinningNote + knowledgeSection + examplesSection + phrasesSection + (recStarNote
        ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + recStarNote
        : "");

      const content = [
        { type: "text", text: recUserTextFinal },
        ...(condition_image_url ? [{ type: "image", source: { type: "url", url: condition_image_url } }] : []),
        { type: "image", source: { type: "url", url: image_url } },
      ];

      message_text = await callClaudeVision(recSystemSpec, content, currentAction, recSystemDynamic || undefined);
      // 🌟より前に出力されたシステム注記・確認メモを除去（物件オススメは必ず🌟始まり）
      // 2026-09-17 竹内（現状伝えて・1件訴求）: この型だけ🌟より前に「探した現状」の1文が入るので切らない。
      //   指示だけでは落ちる（設計知見）ので、無ければ実送信の骨組みの1文を出口で足す
      if (!situationKind) {
        const _starIdx = message_text.indexOf("🌟");
        if (_starIdx > 0) {
          message_text = message_text.slice(_starIdx);
        }
      } else {
        const fixed = ensureSituationOpening(message_text, situationOpeningLine(situationKind, situationOpts));
        if (fixed.added) console.log(JSON.stringify({ tag: "aix:situation-opening-added", action: currentAction, conversationId, kind: situationKind }));
        message_text = fixed.text;
      }
      // 2026-09-18 竹内（𝒮 さん事例）「状況に合わせて、物件申込誘導するのと、物件1件しか送っていない場合は
      //   お送りさせて頂いたお部屋の中でもの部分はいれない」:
      //   ①送った物件が1件以下なら比較の言い方を落とす（実データ179件すべて2件以上送っている時だけ）
      //   ②まだ内覧できないお部屋（退去予定・解禁日が明日以降）は内覧誘導ではなく申込誘導（実データ 34 vs 9）
      {
        // 状況（何件送ったか・今ご内覧頂けるか）は property-send-state の1つの関数から取る＝
        //   竹内さん「今の状況はブレインが分かっているんやから、それと AIX のところリンクさせて」。
        //   ブレインの判断が無い時だけ会話・本文から読む（0 に倒すと比較の言い方が常に落ちてしまうため）
        const sendState = resolvePropertySendState({
          brainMeta: aixBrainMeta,
          recentMessages: Array.isArray(body.recent_messages) ? body.recent_messages as Array<{ sender?: string; text?: string | null }> : [],
          extraText: message_text,
        });
        const closing = fixRecommendClosing(message_text, {
          sentPropertyCount: sendState.sentPropertyCount,
          notViewable: sendState.notViewable,
        });
        if (closing.applied.length > 0) {
          console.log(JSON.stringify({ tag: "aix:recommend-closing", action: currentAction, conversationId, applied: closing.applied, state: describePropertySendState(sendState) }));
          message_text = closing.text;
        }
      }
      // 見積書同封時は締め文を追加
      if (has_estimate) {
        message_text += "\n\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！";
      }

      // Fire-and-forget: extract property info from property recommendation image
      if (conversationId && image_url) {
        const _extractBaseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "https://sumora-ai-ui.vercel.app";
        (async () => {
          let resolvedPropertyCustomerId: string | null = null;
          const { data: convRow } = await supabase
            .from("conversations")
            .select("property_customer_id")
            .eq("id", conversationId)
            .maybeSingle();
          resolvedPropertyCustomerId = convRow?.property_customer_id ?? null;
          await fetch(`${_extractBaseUrl}/api/extract-property-info`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image_url: String(image_url),
              conversation_id: conversationId,
              property_customer_id: resolvedPropertyCustomerId,
            }),
          });
        })().catch(() => {}); // fire-and-forget
      }

    // ── 💰 見積書送る ─────────────────────────────────────────────
    // ※ 見積書本体はOCR（JSON抽出）＋テンプレート組み立て式（AI自由生成なし・金額を壊さない）。
    //   OCRプロンプトへの差分学習ルール注入はJSON出力を壊すリスクがあるため引き続き対象外。
    //   LL-07: 見積書に添えるカバーレター（coverLetter）のみAI自由生成し、
    //   getDiffKnowledgeForState / getStarredExamplesForAction を注入して学習ループ対象にする。
    } else if (action === "estimate_sheet") {

      // 複数件モード: 各見積書をOCRして①②③付きでまとめる（並列実行）
      // 2026-09-17 竹内（AIX キャッシュ点検）: この OCR の system は ≈350字（1,500字未満）なので buildSystemBlocks が cache_control を付けない。
      //   accountName（savings の説明）が入っているが cache 対象外なので鍵は割れない（文面は変えない）
      if (body.multi_estimate && Array.isArray(image_urls) && image_urls.length > 0) {
        const multiEstSystem = `この見積書画像から初期費用情報を抽出してください。JSON形式のみ返答（説明文なし）：
{"property_name":"物件名","room_number":"号室","discount":"34,000円","initial_cost":"146,000円","savings":"102,200円"}
- property_name: マンション名のみ（号室なし）。不明は""
- room_number: 号室番号のみ（例: 502）。不明は""
- discount: 割引額（「〇〇,〇〇〇円」形式）。なければnull
- initial_cost: 初期費用合計（「〇〇〇,〇〇〇円」形式）。不明はnull
- savings: ${accountName}節約額（一般業者との差額）。不明はnull`;
        const multiEstBadges = ["①","②","③","④","⑤"];
        const multiEstResults = await Promise.all(
          (image_urls as string[]).map(async (url, pi) => {
            if (!url) return null;
            try {
              const _estCached = ocrCacheGet(url);
              let estRaw: string;
              if (_estCached !== undefined) {
                estRaw = _estCached;
              } else {
                const estContent = [
                  { type: "text", text: "この見積書から初期費用情報を抽出してください。" },
                  { type: "image", source: { type: "url", url } },
                ];
                estRaw = await callClaudeVision(multiEstSystem, estContent, currentAction);
                ocrCacheSet(url, estRaw);
              }
              // コードブロック（```json...```）を優先して解析し、なければ裸の{}を使用
              const codeBlockM = estRaw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
              const estJsonStr = codeBlockM ? codeBlockM[1] : estRaw.match(/\{[\s\S]*\}/)?.[0];
              if (!estJsonStr) return null;
              const estData = JSON.parse(estJsonStr) as { property_name?: string | null; room_number?: string | null; discount?: string | null; initial_cost?: string | null; savings?: string | null };
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

        const propImgUrl = property_image_url as string | undefined;
        // Sonnet5対応: JSON形式のみ返答を明示（前置き文・コードブロック出力を防止）
        // 「見積書」に限定せず「以下の画像から」と汎用表現にすることでマイソク等でも対応可
        // 2026-09-17 竹内（AIX キャッシュ点検）: ≈600字（1,500字未満）なので cache_control は付かない（propImgUrl で1行変わるが cache 対象外）
        const ocrSystem = `以下の画像から初期費用情報を抽出してください。JSON形式のみ返答（説明文・コードブロック・前置き・後置き一切不要）：
{"property_name":"","room_number":"","rent":0,"management_fee":0,"total":0,"discount":0,"commission":0,"commission_tax":0}

- property_name: マンション名のみ（号室は含めない）。読み取れなければ""
- room_number: 号室番号のみ（例: 502）。読み取れなければ""
- rent: 月額家賃（整数。円・¥・カンマ除く。共益費・管理費は含めない）。なければ0
- management_fee: 共益費または管理費（月額・整数）。なければ0${propImgUrl ? "\n  ※見積書に物件名・家賃・共益費の記載がない場合は物件資料画像から補完すること" : ""}
- total: 初期費用合計（割引後・整数）。なければ0
- discount: 割引額（整数）。なければ0
- commission: 仲介手数料税抜（整数）。なければ0
- commission_tax: 仲介手数料消費税（整数）。なければ0`;

        const _ocrKey = `${image_url}|${propImgUrl ?? ""}`;
        const _ocrCached = ocrCacheGet(_ocrKey);
        let raw: string;
        if (_ocrCached !== undefined) {
          raw = _ocrCached;
        } else {
          const ocrContent: Array<{ type: string; text?: string; source?: { type: string; url: string } }> = [
            { type: "text", text: "画像から指定の項目を抽出し、JSONのみ返答してください。" },
            { type: "image", source: { type: "url", url: image_url } },
          ];
          if (propImgUrl) {
            ocrContent.push({ type: "text", text: "物件資料画像（見積書に物件名・家賃・共益費の記載がない場合はこちらから補完）：" });
            ocrContent.push({ type: "image", source: { type: "url", url: propImgUrl } });
          }
          raw = await callClaudeVision(ocrSystem, ocrContent, currentAction);
          ocrCacheSet(_ocrKey, raw);
        }

        // コードブロック（```json...```）を優先して解析し、なければ裸の{}を使用
        const codeBlockMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        const rawJson = codeBlockMatch ? codeBlockMatch[1] : raw.match(/\{[\s\S]*\}/)?.[0];
        if (rawJson) {
          try { estimate = JSON.parse(rawJson); } catch { estimate = {}; }
        } else {
          estimate = {};
        }
      }

      // アカウント名マッピング
      const est = estimate as Record<string, unknown>;
      const propertyName = String(est.property_name || "");
      const roomNumber   = String(est.room_number   || "");
      // 数値として正常に読み取れた値のみ使用（NaN・0は未取得扱い）
      const totalRaw     = Number(est.total    || 0);
      const discountRaw  = Number(est.discount || 0);
      const rentRaw      = Number(est.rent     || 0);
      const mgmtFeeRaw   = Number(est.management_fee || 0);
      const commRaw      = Number(est.commission || 0);
      const commTaxRaw   = Number(est.commission_tax || 0);
      const total         = isNaN(totalRaw)    || totalRaw    < 0 ? 0 : totalRaw;
      const discount      = isNaN(discountRaw) || discountRaw < 0 ? 0 : discountRaw;
      const rent          = isNaN(rentRaw)     || rentRaw     < 0 ? 0 : rentRaw;
      const managementFee = isNaN(mgmtFeeRaw)  || mgmtFeeRaw  < 0 ? 0 : mgmtFeeRaw;
      const commission    = isNaN(commRaw)    ? 0 : commRaw;
      const commTax       = isNaN(commTaxRaw) ? 0 : commTaxRaw;

      const standardCommission = Math.round(rent * 1.1);
      const actualCommission   = commission + commTax;
      // イエヤスのように仲介手数料0円が正当なアカウントでも節約額を正しく表示するため、
      // page.tsx と同じロジック（ガードなし）に統一する
      const savings = Math.max(0, standardCommission - actualCommission + discount);

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
        const [coverDiffNote, coverStarNote, coverRules, coverBrainAddendum] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.estimate_sheet, currentAction, conversationId, latestCustomerMsg, brainContext),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.estimate_sheet, latestCustomerMsg, aixBrainMeta),
          // 2026-09-17 竹内（AIX キャッシュ点検）: global（準静的）と action 別（経路固有）に分けて受ける
          fetchPromptRulesSplit("estimate_sheet", {}).catch(() => ({ global: "", action: "" })),
          loadBrainTemplate("estimate_sheet"),
        ]);

        // 2026-09-17 竹内（AIX キャッシュ点検）: accountName（スモラ／イエヤス／ギガ賃貸）が system の先頭に入っていてアカウントごとに
        //   別キャッシュになっていた → system は「当社」の固定文にし、サービス名は動的ブロック【当社のサービス名】で渡す
        //   （出力の他ブランド名は下の後処理で現アカウント名に置換される・従来どおり）
        const coverSystem = `あなたは賃貸仲介サービスのLINE営業担当です。
お客様への見積書送付時の添付メッセージ（カバーレター）を1つだけ作成してください。

${SMORA_COMMON_RULES}

【当社のLINEスタイル】
・絵文字は 😊 😌 ✨ のみ・1〜2個まで
・感嘆符は「！！」・「頂きます」を使う
・お客様の名前（ユーザーメッセージに記載）で始める
・30〜80文字程度のコンパクトなメッセージ
・「お手隙の際にご査収ください😌！！」または「ご確認よろしくお願いします！！」で締める
・LINEでそのまま送れる完成文のみ出力（解説・候補複数・見積書の金額の繰り返しは禁止）

【ブランド名ルール（絶対厳守）】
・サービス名に言及する場合は【当社のサービス名】で渡す名称のみ使用すること。それ以外のサービス名（他ブランド・他社名）は絶対に出力しないこと。

【重複禁止ルール（絶対厳守）】
・節約金額・費用比較の文言（「〇〇円節約出来ます」「一般的な不動産業者より〜」等）はすでに見積書本文に別途表示済みのため、カバーレターには絶対に含めないこと。`;

        // ブロック: [routeStatic＝global DB ルール＋固定文＋estimate_sheet 別ルール（Haiku 既定 cache なし）][dynamic＝サービス名＋ブレイン改善ルール]
        //   従来は global＋action を priority 順に混ぜて固定文の後ろに置いていた → global が固定文の前に来る（順序変更）
        //   2026-09-17 検査: global を semiStatic（1h）に置くと Haiku でも ≈12k tokens の 1h 書き込みが起きるが、llm_usage_logs（9/15〜17）では
        //   カバーレターは 3日で 8 回・読めたのは 3 回（間隔 1・11・23 分・hit 率 37% < 1h の損益分岐 53%・5m でも 1/8 < 20%）で純損 →
        //   他の Haiku 経路（内覧前挨拶・待ち合わせ）と同じく cache なしに揃える（global は routeStatic の先頭・文面と並びは同じ）
        const coverSystemSpec: SystemSpec = {
          routeStatic: [coverRules.global.replace(/^\n\n/, ""), coverSystem + coverRules.action].filter(Boolean).join("\n\n"),
          dynamic: [
            `【当社のサービス名】${accountName}`,
            coverBrainAddendum ? "【ブレイン改善ルール】\n" + coverBrainAddendum : "",
          ].filter(Boolean).join("\n\n"),
        };
        // 2026-09-18 竹内「見積書のところにキャンペーン内容の枠をいれる。キャンペーン内容入れると
        //   2通目にキャンペーンの内容が入った文が送られるようにする」:
        //   スタッフが入力した内容だけを使う（こちらで特典・期限・金額を作らない）
        const campaignNote = buildCampaignNote(estimateCampaign);
        const coverUserFinal = greetingTimeNote + `${name}への見積書送付メッセージを作成してください。${latestCustomerMsg ? `\nお客様の最新メッセージ: ${latestCustomerMsg}` : ""}${recentHistory}`
          + (campaignNote ? `\n\n${campaignNote}` : "")
          + (coverDiffNote ? `\n\n${coverDiffNote}` : "") + (coverStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + coverStarNote : "");
        const coverResult = await callClaudeHaiku(
          coverSystemSpec,
          coverUserFinal,
          currentAction
        );
        cover_letter = coverResult.trim();
        // 2026-09-18 本番検証: Haiku が Markdown の見出し（「# YUMAさんへの見積書送付メッセージ」）を付けて返した。
        //   作業メモ・見出しを落とす既存の決定論（meta-narration）をここにも通す（下書き欄に入れないのと同じ扱い）
        {
          const meta = stripMetaNarration(cover_letter);
          if (meta.removed.length > 0) {
            console.log(JSON.stringify({ tag: "aix:cover-meta-stripped", removed: meta.removed.slice(0, 3) }));
            cover_letter = meta.text;
          }
        }
        // ブランド名混入防止（後処理）: 現在アカウント以外のブランド名がAI出力に混ざった場合は現アカウント名に置換
        for (const otherBrand of Object.values(ACCOUNT_NAMES)) {
          if (otherBrand !== accountName && cover_letter.includes(otherBrand)) {
            cover_letter = cover_letter.split(otherBrand).join(accountName);
          }
        }
        // 重複段落防止（後処理）: 見積書本文にすでに表示済みの節約・費用比較の行がカバーレターに混ざった場合は除去
        cover_letter = cover_letter
          .split("\n")
          .filter(line => !(line.includes("一般的な不動産業者") || (line.includes("節約") && line.includes("円"))))
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        // 2026-09-18 出口の保証: 指示だけでは落ちるので、キャンペーンの1文が無ければ締めの直前に足す
        //   （設計知見「決定論で足した文は出口でも保証する」・実送信の並び＝御見積書の案内→キャンペーン→締め）
        const campaignFix = ensureCampaignLine(cover_letter, estimateCampaign);
        if (campaignFix.added) {
          console.log(JSON.stringify({ tag: "aix:estimate-campaign", added: true, conversationId }));
          cover_letter = campaignFix.text;
        }
      } catch {
        // カバーレター生成失敗はサイレントに無視（見積書本体は送れる）
      }
      // 生成そのものが落ちた時でも、スタッフが入れたキャンペーンは伝える（カバーレターが空なら1文だけ送る）
      if (!cover_letter.trim() && estimateCampaign.trim()) {
        const only = ensureCampaignLine("こちら初期費用の御見積書となります！！", estimateCampaign);
        if (only.added) cover_letter = only.text;
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

      // 内覧提案トグル: 明示的に true が届いた場合のみ内覧誘導を含める（デフォルト＝省略）
      // 内覧誘導・内覧日時は「内覧へ」ボタン（viewing_invite）で別途送る運用のため、物件送付には原則含めない
      const skipViewingInvite = body.include_viewing_invite !== true;
      const skipViewingInviteNote = skipViewingInvite
        ? `\n\n【最重要・内覧提案の省略】今回は内覧提案ブロック（「お気に召されましたらご案内〜」等の内覧誘導文・内覧日時の記載）は一切含めないこと。JSON出力の場合は "invite" と "calendar" を必ず空文字にする。物件紹介のみで締めること。`
        : "";

      // property_send 専用: 決まるパターン・人物像を訴求軸決定に使う（next_action系は除外）
      const summaryNote = customerSummary
        ? `\n\n【このお客さんのAI要約（決まるパターン・人物像）】\n${customerSummary}\n→ この要約から「このお客様に刺さる訴求軸」（審査の通りやすさ／費用の安さ／設備／立地等）を読み取り、物件の具体的特徴と結びつけた訴求に必ず使うこと。ただし「next_action」に見積書・御見積書等の記述があっても今回の物件ピックアップ文には一切含めないこと。`
        : "";

      // 顧客状況シグナル: 会話履歴からルールベースで検出し訴求軸として明示（LLM推論任せにしない）
      const SITUATION_SIGNALS: Array<{ re: RegExp; label: string; guide: string }> = [
        { re: /審査.{0,8}(落ち|通らな|ダメ|否決|NG)|落ちて(しま|た)|否決/, label: "審査に落ちた経験がある", guide: "「審査が通りやすいお部屋」「保証会社が比較的緩い物件」を選んでお探しした旨を訴求に入れる。ただし「通ります」と断定せず「可能性が高い」等に留める。事実の創作禁止。" },
        { re: /初期費用.{0,10}(高|厳し|抑え|安く)|予算.{0,6}(オーバー|厳し)/, label: "初期費用に強い不安がある", guide: "礼金0・フリーレント等の初期費用を抑えられる根拠を具体データで示す" },
        { re: /早く|急ぎ|今月中|すぐに.{0,4}(入居|住)/, label: "入居を急いでいる", guide: "スピード感（すぐ動ける旨・即入居可能等）を訴求に含める" },
        { re: /なかなか|見つから|決まらな|他社|他の不動産/, label: "他社・他物件で決まらず長期化している", guide: "「今回は条件を変えてお探しした」等、前と違う手を打った点を明示する" },
      ];
      const historyForSignal = (Array.isArray(recent_messages) ? recent_messages as Array<{ sender?: string; text?: string }> : [])
        .filter(m => m.sender === "customer").map(m => m.text ?? "").join("\n");
      const hitSignals = SITUATION_SIGNALS.filter(s => s.re.test(historyForSignal));
      const situationNote = hitSignals.length > 0
        ? `\n\n【🔍 会話履歴から検出したお客様の状況（訴求の軸として必ず1つ以上を本文に反映すること）】\n` +
          hitSignals.map(s => `・${s.label} → ${s.guide}`).join("\n")
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

      // 設計知見「TPOラベルはRAGクエリ先頭に置く」: キーワード・送付文脈を先頭に付与して類似実例を精度よく引く
      const sendKeyword = keyword ? String(keyword) : null;

      // keywordRule: スタッフが入力したキーワードを「訴求の主軸」として最優先ブロックに格上げ
      // 設計知見「禁止制約のみプロンプト・肯定フレーズはRAG実例から学ぶ」に従い、固定例文なし
      const keywordRule = sendKeyword
        ? `\n\n━━━━━━━━━━━━━━━━━━━━\n【🎯 このメッセージで伝えたいこと（スタッフ指定・アクション別の構成ルールより優先）】\n━━━━━━━━━━━━━━━━━━━━\n「${sendKeyword}」\n・これは単なる条件ワードではなく、今回のメッセージの訴求の主軸である\n・ピックアップ行に形容詞として1語埋め込むだけで終わらせず、この主軸が伝わる訴求を本文に必ず含めること\n・上記【会話履歴】【お客様の状況】に、この主軸に関係するお客様の悩み・経緯があれば、そこに応える形で書くこと\n・言い回しは⭐実例の文体から学び、毎回同じ固定フレーズにしないこと\n・🚫 事実の創作は禁止（「審査通過する可能性がある」の場合は「通ります」と断定せず「可能性が高い」等に留める）`
        : "";

      // 条件チップ → 具体的説明文の生成指示（AI生成・上記の希望条件・会話履歴を参照させる）
      const EXPANDED_COND_GUIDANCE: Record<string, string> = {
        "家賃": "家賃：ご希望家賃より少し上の物件も含めてピックアップした旨。希望条件データや会話から具体的な上限金額・広げた金額が読み取れれば「7万円から7.5万円まで広げて」のように数字を使う。不明なら「少し家賃を広げて」で留める。",
        "礼金": "礼金：礼金なし希望だったが礼金ありも含めてピックアップした旨。会話から礼金の金額が読み取れれば使う。",
        "築年数": "築年数：ご希望築年数より古い物件も含めてピックアップした旨。希望条件データや会話から具体的な築年数が読み取れれば「築10年以内から築20年以内まで広げて」のように数字を使う。不明なら「築年数を少し広げて」で留める。",
        "地域": "エリア：ご希望エリアより少し広いエリアも含めてピックアップした旨。会話・条件データから具体的なエリア名が読み取れれば使う。",
        "初期費用": "初期費用：ご希望より初期費用が少し高めの物件も含めてピックアップした旨。会話・条件データから具体的な金額が読み取れれば使う。",
      };
      const expandedConditions = Array.isArray(body.expanded_conditions) ? (body.expanded_conditions as string[]) : [];
      const expandedCondGuidanceLines = expandedConditions.map(c => EXPANDED_COND_GUIDANCE[c] ?? "").filter(Boolean);
      const expandedCondNote = expandedCondGuidanceLines.length > 0
        ? `\n\n【広げた条件の説明文生成指示（必須・expanded フィールドに出力）】\n` +
          `以下の広げた条件ごとに、上記のお客様の希望条件データと会話履歴から実際の数値・エリア名を読み取り、具体的な1文を書くこと。数値が読み取れない場合は「少し」等の表現で留める。スモラスタイル（！！）で締める。\n` +
          expandedCondGuidanceLines.map(g => `・${g}`).join("\n") +
          `\n※JSON出力の場合は "expanded" フィールドに各条件の説明文を改行で連結して入れる。`
        : "";

      const conditionsInfo = customer_conditions ? String(customer_conditions) : null;
      const conditionsRule = conditionsInfo
        ? `・【最重要】「ご希望のご条件に合ったお部屋」「ご希望の条件に合うお部屋」などの抽象的な表現は絶対に使わない。お客様の具体的な希望条件を文中に自然に織り込むこと
  条件の入れ方（厳守）：
  ・エリアは必ず入れる
  ・入居日はお客様から必須指定がある場合のみ入れる（指定がなければ入れない）
  ・設備・その他はお客様が気にしていた条件（希望条件データにあるもの）から選ぶ
  ・入れる条件は最大4個まで。箇条書きにせず文中に自然に埋め込む
  ・条件のでっち上げ禁止。希望条件データにない条件は絶対に書かない
  例：「梅田まで30分圏内のエリアから[お客様名]にオススメできる2口ガスコンロの初期費用抑えられる9/1入居可能なお部屋ピックアップさせて頂きました😊！！」
  ※下の【出力例】に「ご希望のご条件に合ったお部屋」とある部分は、必ず上記ルールで具体条件に置き換えて出力すること`
        : `・「ご希望のご条件に合ったお部屋ピックアップさせて頂きました😊！！」で冒頭を続ける`;

      // 挨拶判定: buildGreeting（共通ヘルパー・#19）で一元決定
      // 初回→ご連絡ありがとう / 今日挨拶済み→挨拶行なし（G32） / 夜にこちらから届ける→夜分遅くに失礼致します（慶次事例） / それ以外→お世話になっております
      // ★条件受領直後の例外: 直近のお客様メッセージが希望条件の送付（エリア・家賃・間取り等が並ぶ）なら、
      //   スタッフの実運用に合わせて定型挨拶ではなく条件送付への感謝から始める
      const CONDITION_SIGNAL_RE = /家賃|万円|万以内|万まで|間取り|1R|1K|1DK|1LDK|2K|2DK|2LDK|3LDK|ワンルーム|エリア|沿線|徒歩|駅|入居|オートロック|バス.?トイレ|セパレート|独立洗面|宅配ボックス|階以上|築/g;
      const conditionSignalHits = (latestCustomerMsg.match(CONDITION_SIGNAL_RE) ?? []).length;
      const conditionsJustReceived = customerInitiated && conditionSignalHits >= 3;
      const psGreetingPhrase = conditionsJustReceived ? "ご条件お送り頂きありがとう御座います😊！！" : greetingPhrase;
      const openingLine: string = `①「[お客様名]${psGreetingPhrase}」で始める`;
      // 例文・テンプレ用の挨拶文
      const greetingLine = `${name}${psGreetingPhrase}`;
      // エリア表現ルール: 会話で使われた呼び方をそのまま使い、「全域」等の修飾語を勝手に付け足さない
      // （スタッフが「日本橋周辺エリア」と書いているのにAIが「日本橋周辺全域」に変える品質問題の恒久対策）
      const areaWordingNote = `\n\n【エリア表現ルール（厳守・過去実例より優先）】エリア名の呼び方は、直近の会話履歴・希望条件データでお客様やスタッフが実際に使った表現をそのまま使うこと（例：スタッフが「日本橋周辺エリア」と書いていたら「日本橋周辺エリア」のまま）。会話・条件データで使われていない「全域」「一帯」等の修飾語を勝手に付け足すことは絶対禁止。過去の実例・成功例・出力例の中に「全域」が含まれていても、今回の会話で使われていなければ真似しないこと。`;

      // 新着物件モード用の件数表記（固定テンプレ・AIプロンプト両方で使用）
      const newArrivalImgCount = Array.isArray(image_urls) ? (image_urls as string[]).length : (image_url ? 1 : 0);
      const newArrivalCountStr = newArrivalImgCount > 0 ? `${newArrivalImgCount}件` : "複数件";

      // 新着物件モード: 希望条件がない場合のみ固定テンプレート（AI不要）
      // 希望条件がある場合は下のAI生成（sendMode === "new_arrival" 分岐）で具体条件を文中に織り込む
      // 2026-09-15 竹内（慶次事例）: 「会話を合わせる」を押した時は固定テンプレに落とさない（新着＋希望条件なしで押しても「新着で…募集にでました」のままだった）
      if (sendMode === "new_arrival" && !conditionsInfo && body.conversation_match !== true) {
        const greeting = greetingLine;
        const vacatingSection = vacatingInfo
          ? `\n\n${vacatingInfo}`
          : "";
        const applyLine = body.new_arrival_apply ? "\nお気に召されましたらお申込みしお部屋抑えさせて頂きます！！" : "";
        message_text = `${greeting}\n\n新着で${name}にオススメできるお部屋が${newArrivalCountStr}募集にでました！！${vacatingSection}${applyLine}\n\nお手隙の際にご査収ください😌！！`;
        // ⑦修正: 早期returnでも共通後処理（号室ゼロ除去等）を通す（vacatingInfo に 0806号室 等が含まれうる）
        return finalizeResponse(message_text);
      }

      // 学習済み差分ルール（スタッフ修正から学習したパターン）＋☆成功返信パターンをプロンプト末尾に注入
      // + コンポーネント単位の学習ルール（normal/widen/viewingモードのみ: JSON出力でコンポーネント学習が機能するモード）
      const useCompKnowledge = sendMode === "normal" || sendMode === "widen" || sendMode === "viewing";
      // sendKeyword は L2039 で宣言済み（keywordRule で先に使うため移動）
      const kwPrefix = sendKeyword ? `【伝えたいこと】${sendKeyword} ` : "";
      const sendModeLabel = sendMode === "widen" ? "条件を広げてお探しした物件送付 " : sendMode === "new_arrival" ? "新着物件の即案内 " : "";
      // 2026-09-13 AIX-META × RAG 監査: 実例を引く問いには AIX-META を混ぜない。成功パターンを引く問いにだけ足す
      const enrichedRagQuery = [kwPrefix, sendModeLabel, conditionsInfo ?? "", latestCustomerMsg].filter(Boolean).join(" ");
      const enrichedStrategyQuery = [enrichedRagQuery, brainContext].filter(Boolean).join(" ");
      const [sendDiffNote, sendStarNote, compPickupNote, compInviteNote, compCalendarNote, sendRules, sendBrainAddendum, sendWinningNote, sendPropertyExamples] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.property_send, currentAction, conversationId, kwPrefix + latestCustomerMsg || latestCustomerMsg, brainContext),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.property_send, kwPrefix + latestCustomerMsg || latestCustomerMsg, aixBrainMeta),
        useCompKnowledge ? getKnowledgeForState(["property_send_pickup"], currentAction) : Promise.resolve(""),
        useCompKnowledge && !skipViewingInvite ? getKnowledgeForState(["property_send_invite"], currentAction) : Promise.resolve(""),
        useCompKnowledge && !skipViewingInvite ? getKnowledgeForState(["property_send_calendar"], currentAction) : Promise.resolve(""),
        // 2026-09-17 竹内（AIX キャッシュ点検）: global（準静的ブロック 1h）と action 別（経路固有ブロックの末尾）に分けて受ける。
        //   send_mode の条件は action 側だけに効く（global に condition_key 付きの行は無い）
        fetchPromptRulesSplit("property_send", { send_mode: sendMode }).catch(() => ({ global: "", action: "" })),
        loadBrainTemplate("property_send"),
        // 成約パターンRAG: キーワード先頭クエリで「この顧客・このキーワードに効いた訴求」を引く
        getWinningPatternsForProperty(enrichedStrategyQuery, aixBrainMeta),
        // 過去実例: pgvector主経路（キーワード・送付文脈で実例が変わる）→固定直クエリフォールバック
        getAixPropertyExamples("property_send", enrichedRagQuery),
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

      // ── 2026-09-15 竹内（カイナ事例）「物件ピックアップに会話を合わせるボタンをつける。会話を合わせた状態で生成」──
      //   固定の型（下の sendSystem）はそのまま残し、会話を合わせるは「②ピックアップ行を会話の言い方で短く」＋「③この会話で約束したこと・経緯・
      //   お客様が気にしていることへの1〜2文」を、決定論で拾った糸口（property-send-match）だけから書く。
      //   実データ（60日）: 物件ピックアップの AIX 送信 261通中 237通（91%）をスタッフが直していて、直し方がこの2点だった
      //   （「お気に召されたお部屋代理契約可能か全て交渉させて頂きます」「無事ご入居間に合いますようにサポートさせて頂きます」「募集ございませんでしたので条件広げて」）。
      //   内覧誘導・日時は内覧提案 OFF なら決定論で落とし、数字は入力（条件・会話・退去予定・キーワード）に無ければ〇〇（送信前チェックで止まる）
      if (body.conversation_match === true) {
        // 続いている事情（代理契約・審査・ペット 等）は会話の最初からの物なので、画面の直近の発言（御見積書・内覧の往復で埋まる）より長くお客様の発言を読む
        let psmReqSources: Array<{ sender: string; text: string }> | undefined;
        if (conversationId) {
          try {
            // 画面に出ている最後の発言より後は読まない（スタッフが見ている会話と同じ範囲。過去の場面の再現確認でも後の発言が混ざらない）
            const psmUpper = [...recentMsgArray].reverse().find((m) => m.rawCreatedAt && !Number.isNaN(Date.parse(m.rawCreatedAt)))?.rawCreatedAt;
            let q = supabase.from("messages").select("text, created_at").eq("conversation_id", conversationId).eq("sender", "customer");
            if (psmUpper) q = q.lte("created_at", psmUpper);
            const { data: older } = await q.order("created_at", { ascending: false }).limit(80);
            psmReqSources = ((older ?? []) as Array<{ text: string | null }>).reverse().map((r) => ({ sender: "customer", text: r.text ?? "" }));
          } catch { /* 読めなければ画面の分だけ */ }
        }
        const psmThreadMsgs = (Array.isArray(recent_messages) ? (recent_messages as Array<{ sender: string; text?: string | null }>) : []).map((m) => ({ sender: m.sender, text: m.text ?? "" }));
        const threads = extractPropertySendThreads(psmThreadMsgs, { requirementSources: psmReqSources });
        const threadsBlock = buildPropertySendThreadsBlock(threads);
        const psmStaticSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

${aixPropertySendRules}

【この返信の目的】
物件をピックアップしてお送りする時の導入文を、この会話の流れに合わせて1通作る（スタッフが「会話を合わせる」を押した）。
固定の型ではなく、この会話でこちらが約束したこと・今回のピックアップの経緯・お客様が気にしていることに応える1〜2文を入れる。

【構成（この順・空行で区切る）】
①挨拶行（動的に渡す実値をそのまま。挨拶行なしの指示ならお客様名の行から）
①'【会話の糸口】に＜お客様の期限・困りごと＞がある時だけ:「無事ご入居間に合いますようにサポートさせて頂きます！！」（スタッフ実送信の文そのまま。先に受け止めてから物件の行へ）
②ピックアップ行（1行）:「〇〇（エリア）から…お部屋ピックアップさせて頂きました！！」（物件と一緒に送る文なので必ず過去形「しました」。直前のこちらの「お送りさせていただきます」を写さない）。エリア・特徴の呼び方は会話でスタッフ・お客様が使った言葉をそのまま（例:「広めのお部屋」「大きめのお部屋」「審査通過しやすい」）。希望条件を全部並べない（入れるのは最大2つ）
③会話に合わせた1〜2文:【会話の糸口（候補）】にある事柄だけから、今のお客様に一番効く物を選んで書く（例:「お気に召されたお部屋代理契約可能か全て交渉させて頂きます！！」「無事ご入居間に合いますようにサポートさせて頂きます！！」「ご希望の家賃ですと募集ございませんでしたので条件広げてお送りしております！！」「こちら2部屋となります！」）。候補が無ければ③は書かない
④退去予定の物件があれば「◎〇〇\n[退去日]退去予定となりますので[退去日の翌日]以降ご内覧可能です！」（渡された情報だけ）
⑤最終行「お手隙の際にご査収ください😌！！」

【絶対禁止】
・会話・希望条件・渡された情報に無い物件名・金額・数字・日付・条件・約束を書くこと（糸口の候補に無い事柄は書かない）
・物件の事実やこちらの新しい提案を足すこと（「独立系の保証会社のお部屋を中心に」「審査通過しやすい」「並行してお申込み・審査を進められます」等。今回送る物件の保証会社・審査は分かっていない。糸口・希望条件・キーワードにある時だけ）
・お客様の前の発言（書類・申込・内覧）へのお礼やその話（「給与明細のご準備ありがとうございます」等）。物件ピックアップの文は今回の物件の話だけ
・希望条件・会話にエリアや特徴があるのに「ご希望のご条件に合ったお部屋」だけで済ませるピックアップ行（エリア等が分からない時は「〇〇さんのご条件に近いお部屋」で可）
・手本の中身（別のお客様の物件・事情）を写すこと。手本は言い回しだけ
・謝罪・🙏・「お待たせ致しました」・見積書の話（見積書は別の AIX）
・「引き続き全力でサポート」等の大きな締め（⑤で締める）
・こちらの前の発言にある挨拶・お礼を繰り返すこと（「本日お時間頂きありがとうございました」は内覧後の挨拶で送信済み。①の挨拶行だけ）

【③の選び方】お客様の続いている事情（代理契約・審査・ペット 等）が候補にあれば最優先で「今回の物件でこちらがどうするか」を1文（例:「お気に召されたお部屋代理契約可能か全て交渉させて頂きます！！」）。次に今回のピックアップの経緯（条件を広げた・募集が無かった）。合計1〜2文。①'を書いた時は③を足さなくてよい（スタッフ実送信は ①→①'→②→⑤ の4行）

【スタッフが会話に合わせて送った実文（言い回しの手本）】
${PROPERTY_SEND_MATCH_STAFF_EXAMPLES.map((t, i) => `例${i + 1}:\n${t}`).join("\n\n")}

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\n で）"}`;
        const inviteRule = skipViewingInvite
          ? "【内覧誘導】今回は内覧の誘い（「お気に召されましたらご案内」「ご都合よろしいお日にち」）・内覧日時を一切書かない（内覧は AIX【内覧日調整】で送る）"
          : `【内覧誘導】④の後に「${name}お気に召されましたらお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」を1文${calendarData ? `、続けて「直近ですと\n${calendarData}\nご案内可能です！！」` : ""}`;
        // 送り方（モード）ごとの②の言い方。新着は「新着で…」か会話に合わせて「現在募集が出ているお部屋で…」（慶次の実送信）
        const psmModeNote = sendMode === "new_arrival"
          ? `【今回の送り方】新着（最近募集に出たお部屋${newArrivalImgCount > 0 ? `・${newArrivalCountStr}` : ""}）。②は「新着で${name}にオススメできるお部屋募集に出ましたのでピックアップさせて頂きました！！」か、会話に合わせて「現在募集が出ているお部屋で${name}のご条件に近いお部屋全てピックアップさせて頂きました！！」の言い方`
          : sendMode === "widen"
            ? "【今回の送り方】条件を広げてお探しした（広げた条件は下の説明の事柄だけ）"
            : sendMode === "alternative"
              ? "【今回の送り方】お客様が気にされた物件の代わりになるお部屋"
              : "【今回の送り方】ご条件からピックアップしたお部屋";
        const psmDynamic = [
          greetingLine ? `【①挨拶行の実値】\n${greetingLine}` : "【①挨拶行】本日すでに送信済みのため挨拶行なし。お客様名の行から始める",
          psmModeNote,
          nameNote.trim(),
          conditionsInfo ? `【お客様の希望条件（②で使うのは最大2つ・会話で使った言い方を優先）】\n${conditionsInfo}` : "",
          keywordRule.trim(),
          threadsBlock,
          inviteRule,
          sendBrainAddendum ? "【ブレイン改善ルール】\n" + sendBrainAddendum : "",
          (brainGuidanceNote ?? "").trim(),
        ].filter(Boolean).join("\n\n");
        // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは動的ブロック（cache なし・内覧誘導の後）から静的側へ。
        //   [shared＝GENERATION_SYSTEM+SMORA_COMMON_RULES 1h][semiStatic＝global 1h][routeStatic＝aixPropertySendRules＋固有文＋property_send 別ルール（send_mode 条件付き）5m][psmDynamic]
        //   psmStaticSystem は文字列のまま残し（共通 prefix で始まることをテストが固定）、splitSharedPrefix で分ける
        const psmSplit = splitSharedPrefix(psmStaticSystem);
        const psmSystemSpec: SystemSpec = {
          shared: psmSplit.shared,
          semiStatic: sendRules.global.replace(/^\n\n/, ""),
          routeStatic: psmSplit.routeStatic + sendRules.action,
        };
        // 固定の型（下）の userParts と同じ材料（userParts はこの後で組み立てるのでここで同じ物を並べる）
        const psmUser = [
          `${name}への物件ピックアップ送付メッセージを作成してください。`,
          conditionsInfo ? `\n\n【お客様の希望条件】\n${conditionsInfo}` : "",
          calendarData && !skipViewingInvite ? `\n\n【直近3日の内覧可能時間帯（この情報をそのまま使うこと）】\n${calendarData}` : "",
          vacatingInfo ? `\n\n【退去予定・案内不可の物件情報（必ず全て伝えること）】\n${vacatingInfo}` : "",
          expandedCondNote,
          recentHistory,
          // situationNote・summaryNote（「訴求の軸として必ず反映」）は渡さない: 慶次事例で「独立系の保証会社のお部屋を中心に」「並行してお申込み・審査を」を
          //   作らせた（今回の物件の保証会社は分かっていない）。会話を合わせるは糸口の事柄だけ＝固定の型の方には残す
          pspGuidanceNote,
        ].join("")
          + `\n\n上記の会話の流れに合わせて、${name}への物件ピックアップ送付メッセージを1通生成してください（③は【会話の糸口（候補）】の事柄だけ）。`
          + (sendDiffNote ? `\n\n${sendDiffNote}` : "")
          + (sendStarNote ? "\n\n【参考にすべき成功返信例（返信スタイルを合わせる）】\n" + sendStarNote : "");
        console.log(JSON.stringify({ tag: "aix:property-send-match", conversationId, threads: { customer: threads.customer.length, staff: threads.staff.length, requirements: threads.requirements.length, deadline: (threads.deadline ?? []).length }, sendMode, skipViewingInvite, greeting: nightGreeting ? "night" : greetingPhrase ? "standard" : "none" }));
        const psmRaw = await callClaude(psmSystemSpec, psmUser, currentAction, psmDynamic);
        let psmText = psmRaw;
        try {
          const m = psmRaw.match(/\{[\s\S]*\}/);
          if (m) psmText = ((JSON.parse(m[0]) as { message?: string }).message || psmRaw).replace(/\\n/g, "\n");
        } catch { /* JSON で無ければ本文そのもの */ }
        const notices: string[] = [];
        // 入力に無い保証会社・審査の話・手本から写した事情の一文を落とす（慶次事例: 「独立系保証会社でご案内可能なお部屋を中心に」・事情が無いのに代理契約の交渉）
        const psmGrounding = [sendKeyword ?? "", conditionsInfo ?? "", threads.requirements.join("\n"), threads.customer.join("\n"), expandedCondGuidanceLines.join("\n")].join("\n");
        const claims = stripUngroundedClaims(psmText, psmGrounding);
        if (claims.removed.length > 0) { psmText = claims.text; console.log(JSON.stringify({ tag: "aix:property-send-match", conversationId, ungroundedRemoved: claims.removed.map((r) => r.slice(0, 40)) })); }
        if (claims.unresolved) notices.push("今回の物件の保証会社・審査の話は入力に無いため確認して書き換えてから送信してください");
        // 続いている事情（代理契約 等）の一文が無ければ決定論で差し込む（本番確認: 候補にあっても LLM は 6回中0回しか書かなかった）
        const req = ensureRequirementLine(psmText, threads.requirements);
        if (req.added) { psmText = req.text; console.log(JSON.stringify({ tag: "aix:property-send-match", conversationId, requirementLineAdded: req.added })); }
        // お客様の期限・困りごと（退去を伝えてしまった 等）→ 挨拶の次に「無事ご入居間に合いますようにサポートさせて頂きます！！」（慶次のスタッフ実送信）
        const dl = ensureDeadlineSupportLine(psmText, threads.deadline ?? []);
        if (dl.added) { psmText = dl.text; console.log(JSON.stringify({ tag: "aix:property-send-match", conversationId, deadlineLineAdded: true })); }
        // ピックアップ行は過去形（直前のこちらの「ピックアップしお送りさせていただきます」を写して未来形になる回があった）
        const tense = fixPickupTense(psmText);
        if (tense.fixed > 0) { psmText = tense.text; console.log(JSON.stringify({ tag: "aix:property-send-match", conversationId, tenseFixed: tense.fixed })); }
        // こちらの前の発言のお礼（本日お時間頂きありがとうございました）の繰り返しは決定論で落とす（本番確認で3回中3回入った）
        const thanks = stripRepeatedThanksLines(psmText);
        if (thanks.removed > 0) { psmText = thanks.text; console.log(JSON.stringify({ tag: "aix:property-send-match", conversationId, repeatedThanksRemoved: thanks.removed })); }
        // 古い話へのお礼（「給与明細のご準備ありがとうございます」＝5日前の書類）を落とす。お礼の対象がまだ応えていないお客様の発言に無ければ古い話
        const stale = stripUnanchoredThanksLines(psmText, freshCustomerTexts(psmThreadMsgs));
        if (stale.removed.length > 0) { psmText = stale.text; console.log(JSON.stringify({ tag: "aix:property-send-match", conversationId, staleThanksRemoved: stale.removed.map((r) => r.slice(0, 40)) })); }
        if (skipViewingInvite) {
          const s = stripViewingInviteLines(psmText);
          if (s.removed > 0) { psmText = s.text; console.log(JSON.stringify({ tag: "aix:property-send-match", conversationId, inviteLinesRemoved: s.removed })); }
        }
        // 2026-09-17 竹内（✩ さん事例）: ピックアップ行に物件名を入れない（会話を合わせる経路も同じ出口を通す）
        const psmPicked = stripPropertyNameFromPickupLine(psmText, extractPropertyLabels(recentHistory));
        if (psmPicked.removed.length > 0) {
          psmText = psmPicked.text;
          console.log(JSON.stringify({ tag: "aix:property-send-match", conversationId, pickupPropertyNameRemoved: psmPicked.removed }));
        }
        // 数字の照合: 条件・会話・退去予定・キーワードに無い金額・帖・年・件数は〇〇（送信前チェックで止まる）
        const psmNotes = [conditionsInfo ?? "", recentHistory, vacatingInfo ?? "", sendKeyword ?? "", calendarData ?? "", expandedCondGuidanceLines.join("\n"), newArrivalCountStr].join("\n");
        const masked = maskNumbersNotInNotes(psmText, psmNotes);
        if (masked.unmatched.length > 0) {
          psmText = masked.text;
          notices.push(`会話・条件に無い数字（${masked.unmatched.join("・")}）を〇〇にしました。確認して書き換えてから送信してください`);
          console.warn("[aix/action] property_send match: 入力に無い数字を伏せ字:", masked.unmatched);
        }
        return finalizeResponse(psmText, { conversation_match: true, ...(notices.length ? { notice: notices.join("\n") } : {}) });
      }

      const sendSystem = sendMode === "short"
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件をピックアップしてお客さんに送る際の超シンプルな導入メッセージを1つだけ作成してください。
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（厳守）】
①[挨拶行]（動的に渡す実際の挨拶文を使うこと）
②エリア（条件から読み取り）+「から」+最もキャッチーな条件1つ（間取りより生活感のある特徴優先：カウンターキッチン・ペット可・駐車場付き等）+「のお部屋で[お客様名]ご希望のご条件に近いお部屋ピックアップさせて頂きました！！」
③直後に改行して（空行なし）「お手隙の際にご査収ください😌！！」

【厳守ルール】
・②と③の間に空行を入れない（直接改行でつなぐ）
・「ご条件に合った」ではなく「ご条件に近い」を使う
・条件リストを箇条書きで並べない。エリア＋キーワード1つだけ
・内覧誘導・申込誘導・質問・補足は一切追加しない
・感嘆符は「！！」のみ・絵文字は 😌 のみ1個

【出力例】
[お客様への挨拶]

大阪市内からカウンターキッチン付きのお部屋でRさんご希望のご条件に近いお部屋ピックアップさせて頂きました！！
お手隙の際にご査収ください😌！！`
        : sendMode === "simple"
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件をピックアップしてお客さんに送る際の導入メッセージを1つだけ作成してください。
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（この順番で必ず守ること）】
①[挨拶行]（動的に渡す実際の挨拶文を使うこと）
②[条件ルール]（動的に渡す条件に従うこと）
③退去予定物件がある場合：「◎〇〇マンション\n[退去日]退去予定となりますので[退去日の翌日]以降ご内覧可能です！」（退去日の翌日＝内覧解禁日。6月30日退去なら7月1日以降。複数あれば全て列挙）
④最終行：「お手隙の際にご査収ください😌！！」を単独で置く

【厳守ルール】
・①〜④の構成のみ出力。内覧誘導・申込誘導・日程・その他の質問や補足は一切追加しない
・②は「〇〇から[お客様名]ご希望の〜なお部屋ピックアップさせて頂きました！！」の形で1行に完結させる。希望条件が渡されている場合は「ご条件に合った」という抽象表現ではなく具体条件（エリア必須・最大4個）を文中に織り込むこと
・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😊 😌 のみ・1〜2個まで

【出力例】
[お客様への挨拶]

大阪駅・難波駅周辺からRさんご希望のご条件に合ったお部屋ピックアップさせて頂きました！！

お手隙の際にご査収ください😌！！`
        : sendMode === "application"
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件をピックアップしてお客さんに送る際の導入メッセージを1つだけ作成してください。
このお客さんは内覧より先にお申込みで部屋を確保することを優先する流れです。
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（この順番で必ず守ること）】
①[挨拶行]（動的に渡す実際の挨拶文を使うこと）
②[条件ルール]（動的に渡す条件に従うこと）
③退去予定物件がある場合：「◎〇〇マンション\n[退去日]退去予定となりますので[退去日の翌日]以降ご内覧可能です！」（退去日の翌日＝内覧解禁日。6月30日退去なら7月1日以降。複数あれば全て列挙）
④「お気に召されましたらそのままお申込みでお部屋を抑えることが可能です！！」
⑤最終行：「お手隙の際にご査収ください😌！！」を単独で置く

【厳守ルール】
・①〜⑤の構成のみ出力。入居時期・条件確認・その他の質問や補足は一切追加しない
・②は「〇〇から[お客様名]ご希望の〜なお部屋ピックアップさせて頂きました！！」の形で1行に完結させる。希望条件が渡されている場合は「ご条件に合った」という抽象表現ではなく具体条件（エリア必須・最大4個）を文中に織り込むこと
・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😊 😌 のみ・1〜2個まで

【出力例（申込モード）】
[お客様への挨拶]

梅田・難波周辺から[お客様名]ご希望のご条件に合ったお部屋ピックアップさせて頂きました！！

お気に召されましたらそのままお申込みでお部屋を抑えることが可能です！！

お手隙の際にご査収ください😌！！`
        : sendMode === "alternative"
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
お客様が希望されていた物件が空室でなかったため、代替物件をピックアップしてお送りする際の導入メッセージを1つだけ作成してください。
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（この順番で必ず守ること）】
①[挨拶行]（動的に渡す実際の挨拶文を使うこと）
②「先ほどの物件は空室がない状況でしたが、[お客様名]ご希望のご条件に合った代替のお部屋をピックアップさせて頂きました！！」のように代替物件である旨を自然に伝える
③退去予定物件がある場合：「◎〇〇マンション\n[退去日]退去予定となりますので[退去日の翌日]以降ご内覧可能です！」
④内覧誘導：「[お客様名]お気に召されましたらお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」
⑤最終行：「お手隙の際にご査収ください😌！！」を単独で置く

【厳守ルール】
・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😊 😌 のみ・1〜2個まで

【出力例（代替物件モード）】
[お客様への挨拶]

先ほどの物件は空室がない状況でしたが、[お客様名]ご希望のご条件に合った代替のお部屋をピックアップさせて頂きました！！

[お客様名]お気に召されましたらお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

お手隙の際にご査収ください😌！！`
        : sendMode === "widen"
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
お客様のご希望条件に完全に合う物件が少なかったため、条件を少し広げて物件をピックアップした際の導入メッセージを1つだけ作成してください。
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（この順番で必ず守ること）】
①[挨拶行]（動的に渡す実際の挨拶文を使うこと）
②[条件ルール]（動的に渡す条件に従うこと）
③条件を広げた旨の説明：userメッセージの【広げた条件の説明文生成指示】の各条件について、お客様の希望条件と会話から実際の数値・エリア名を読み取り具体的な1文を書く（複数条件あれば改行で並べる）
④退去予定物件がある場合：「◎〇〇マンション\n[退去日]退去予定となりますので[退去日の翌日]以降ご内覧可能です！」（退去日の翌日＝内覧解禁日。6月30日退去なら7月1日以降。複数あれば全て列挙）
⑤最終行：「お手隙の際にご査収ください😌！！」を単独で置く

【厳守ルール】
・①〜⑤の構成のみ出力。内覧誘導・内覧日時・申込誘導・入居時期・条件確認・その他の質問や補足は一切追加しない
　※例外: userメッセージに【🎯 このメッセージで伝えたいこと】がある場合のみ、その主軸を②または③の文中に自然に織り込むこと（新しい段落は増やさず、既存の構成の中で表現する）
・②は「〇〇から[お客様名]ご希望の〜なお部屋ピックアップさせて頂きました！！」の形で1行に完結させる。希望条件が渡されている場合は「ご条件に合った」という抽象表現ではなく具体条件（エリア必須・最大4個）を文中に織り込むこと
・③の説明文は広げた条件ごとに具体的な数値・エリア名を使って1文ずつ書く。数値が読み取れない場合は「少し」等の表現を使う。③以外の補足・追加説明は一切書かない
・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😊 😌 のみ・1〜2個まで

【出力例（条件を広げたモード）】
[お客様への挨拶]

大阪駅・難波駅周辺から[お客様名]ご希望のご条件に合ったお部屋ピックアップさせて頂きました！！

ご希望の家賃ですと合うお部屋が少ない状況でしたので、少し家賃を広げてピックアップさせて頂きました！！

お手隙の際にご査収ください😌！！

【出力形式（必須）】
プレーンテキストではなく、以下のJSON形式のみで出力してください（説明・コードブロック不要）：
{"intro":"挨拶行（1行のみ）","pickup":"ピックアップ行（条件説明・1行）","expanded":"広げた条件の説明文（希望条件・会話から具体値を読み取り生成・複数あれば改行で連結）","vacating":"退去予定文（複数あれば改行で連結・なければ空文字）","invite":"","calendar":"","closing":"お手隙の際にご査収ください😌！！"}`
        : sendMode === "new_arrival"
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
新着物件が募集に出たことをお客さんに知らせる導入メッセージを1つだけ作成してください。
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（この順番で必ず守ること）】
①[挨拶行]（動的に渡す実際の挨拶文を使うこと）
②「新着で〜お部屋が[新着件数]募集にでました！！」の形で1行に完結させる（[新着件数]は動的に渡す実際の件数に置き換える）。「〜」の部分にはお客様の具体的な希望条件を文中に自然に織り込む
③退去予定物件がある場合：userメッセージの【退去予定・案内不可の物件情報】をそのまま記載する
${body.new_arrival_apply ? `④「お気に召されましたらお申込みしお部屋抑えさせて頂きます！！」を1行で入れる
⑤最終行：「お手隙の際にご査収ください😌！！」を単独で置く` : `④最終行：「お手隙の際にご査収ください😌！！」を単独で置く`}

【②の条件の入れ方（最重要・厳守）】
・「ご希望のご条件に合ったお部屋」「ご希望の条件に合うお部屋」などの抽象的な表現は絶対に使わない
・userメッセージの【お客様の希望条件】から具体的な条件を選び、文中に自然に混ぜること
・エリアと間取りは必ず入れる（両方必須・省略不可）
・入居日はお客様から必須指定がある場合のみ入れる（指定がなければ入れない）
・設備・その他はお客様が気にしていた条件（希望条件データにあるもの）から選ぶ
・入れる条件は最大4個まで（エリア・間取りの2つは必ず含む）。箇条書きにせず文中に自然に埋め込む
・条件のでっち上げ禁止。希望条件データにない条件は絶対に書かない
例：「新着で梅田まで30分圏内のエリアから[お客様名]にオススメできる2LDK・2口ガスコンロ付きの9/1入居可能なお部屋が3件募集にでました！！」

【厳守ルール】
・上記構成のみ出力。内覧誘導・内覧日時・条件確認・その他の質問や補足は一切追加しない
・「空室のため」「空室ですので」「ご案内可能です」「空室確認」など、空室状況・内覧可否に関する表現は一切含めない（新着告知文のみを生成する）
・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😌 のみ1個

【出力例（新着物件モード）】
[お客様への挨拶]

新着で梅田まで30分圏内のエリアから[お客様名]にオススメできる2LDK・2口ガスコンロ付きのお部屋が[新着件数]募集にでました！！

お手隙の際にご査収ください😌！！`
        : `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件をピックアップしてお客さんに送る際の導入メッセージを1つだけ作成してください。
${SMORA_COMMON_RULES}

${aixPropertySendRules}

【構成（この順番で必ず守ること）】
①[挨拶行]（動的に渡す実際の挨拶文を使うこと）
②[条件ルール]（動的に渡す条件に従うこと）
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
・②は「〇〇から[お客様名]ご希望の〜なお部屋ピックアップさせて頂きました！！」の形で1行に完結させる。希望条件が渡されている場合は「ご条件に合った」という抽象表現ではなく具体条件（エリア必須・最大4個）を文中に織り込むこと
・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😊 😌 のみ・1〜2個まで

【出力例（カレンダーなし）】
[お客様への挨拶]

大阪駅・難波駅周辺から[お客様名]ご希望のご条件に合ったお部屋ピックアップさせて頂きました！！

[お客様名]お気に召されましたらお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

お手隙の際にご査収ください😌！！

【出力例（カレンダーあり）】
[お客様への挨拶]

大阪駅・難波駅周辺から[お客様名]ご希望のご条件に合ったお部屋ピックアップさせて頂きました！！

[お客様名]お気に召されましたらお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

直近ですと
6/19（木）15:00〜17:00
6/20（金）12:00〜14:00
ご案内可能です！！

お手隙の際にご査収ください😌！！

【出力形式（必須）】
プレーンテキストではなく、以下のJSON形式のみで出力してください（説明・コードブロック不要）：
{"intro":"挨拶行（1行のみ）","pickup":"ピックアップ行（条件説明・1行）","vacating":"退去予定文（複数あれば改行で連結・なければ空文字）","invite":"内覧誘導文（なければ空文字）","calendar":"内覧日時（⑤ルールに従い通常は空文字・過去ルールで日時記載傾向あり時のみ「直近ですと〜ご案内可能です！！」）","closing":"お手隙の際にご査収ください😌！！"}`;

      const userParts: string[] = [`${name}への物件ピックアップ送付メッセージを作成してください。`];
      // 2026-09-17 竹内（✩ さん事例）: ピックアップ行に物件名を入れない。
      //   条件の材料が空の時ほど LLM が会話の物件名で埋めるので、条件の前に置く
      userParts.push(`\n\n${PICKUP_LINE_NOTE}`);
      if (keywordRule) userParts.push(keywordRule); // 最優先ブロック（conditionsInfoより前）
      if (conditionsInfo) userParts.push(`\n\n【お客様の希望条件（冒頭に自然に組み込むこと）】\n${conditionsInfo}`);
      else userParts.push("\n\n【お客様の希望条件】材料が無い（会話から読み取れるエリアだけを書き、条件・物件名は作らない）");
      if (calendarData) userParts.push(`\n\n【直近3日の内覧可能時間帯（calendar_events+daily_tasks合算済み・この情報をそのまま使うこと）】\n${calendarData}`);
      if (vacatingInfo) userParts.push(`\n\n【退去予定・案内不可の物件情報（必ず全て伝えること）】\n${vacatingInfo}`);
      if (expandedCondNote) userParts.push(expandedCondNote);
      if (templateSampleNote) userParts.push(templateSampleNote);
      if (templateStructureNote) userParts.push(templateStructureNote);
      if (recentHistory) userParts.push(recentHistory);
      if (situationNote) userParts.push(situationNote); // 会話履歴から検出した状況シグナル
      if (summaryNote) userParts.push(summaryNote);
      if (pspGuidanceNote) userParts.push(pspGuidanceNote);

      // 2026-09-17 竹内（AIX キャッシュ点検）: 固定の型は hit 42% で 1h は損。global ルール（全 AIX 共通・不変）は準静的ブロック（1h）、
      //   経路固有文＋☆実例＋action 別ルールは経路固有ブロック（5m）、挨拶・条件ルール・お客様名・ブレインは動的（cache なし）に分ける。
      //   DB ルールは上の Promise.all の sendRules（fetchPromptRulesSplit・会話を合わせると同じ物）をそのまま使う
      //   （2026-09-17 検査: 以前はここで同じ引数の fetchPromptRulesSplit をもう1回 await していた＝action 別クエリが1回多く直列で 100〜200ms 損）
      const sendStaticSystem = sendSystem + areaWordingNote + skipViewingInviteNote;
      // キャッシュ対象の sendSystem からプレースホルダ化した動的値をここで実値として渡す
      // （[お客様への挨拶] / ①[挨拶行] / ②[条件ルール] / [新着件数] の実体）
      const sendContextBlock = [
        greetingLine ? `【挨拶文（出力例中の「[お客様への挨拶]」は必ずこの形式に置き換えること）】\n${greetingLine}` : "",
        openingLine ? `【①挨拶行の実値（構成①「[挨拶行]」に使うこと）】\n${openingLine}` : "",
        conditionsRule ? `【条件ルール（構成②「[条件ルール]」に使うこと）】\n${conditionsRule.replace(/^・/, "")}` : "",
        newArrivalCountStr ? `【新着件数（「[新着件数]」に使うこと）】${newArrivalCountStr}` : "",
      ].filter(Boolean).join("\n\n");
      const sendDynamic = [
        sendContextBlock,
        nameNote.trim(),
        sendBrainAddendum ? "【ブレイン改善ルール】\n" + sendBrainAddendum : "",
        (brainGuidanceNote ?? "").trim(),
      ].filter(Boolean).join("\n\n");
      const sendSystemSpec: SystemSpecBlocks = {
        semiStatic: sendRules.global.replace(/^\n\n/, ""),
        // ☆実例と action 別ルールは従来どおり "\n\n" 結合（旧 sendDynamic と同じ trim → join）
        routeStatic: [sendStaticSystem, sendExamplesText.trim(), sendRules.action.trim()].filter(Boolean).join("\n\n"),
        dynamic: sendDynamic,
      };
      const sendUserFinal = userParts.join("")
        + sendWinningNote
        + sendPropertyExamples
        + (sendDiffNote ? `\n\n${sendDiffNote}` : "")
        + (componentKnowledgeNote ? `\n\n${componentKnowledgeNote}` : "")
        + (sendStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + sendStarNote : "");
      const rawSendText = await callClaude(sendSystemSpec, sendUserFinal, currentAction);
      // normal / widen モードはJSON構成パーツで返す（コンポーネント学習ループ用）
      if (sendMode === "normal" || sendMode === "widen" || sendMode === "viewing") {
        let propertySendComponents: Record<string, string> | null = null;
        try {
          const m = rawSendText.match(/\{[\s\S]*\}/);
          if (m) {
            propertySendComponents = JSON.parse(m[0]) as Record<string, string>;
            const c = propertySendComponents;
            message_text = ["intro", "pickup", "expanded", "vacating", "invite", "calendar", "closing"]
              .filter(k => !(skipViewingInvite && (k === "invite" || k === "calendar")))
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
        // ⑦修正: 早期returnでも共通後処理（号室ゼロ除去・内部メモ分離）を通す
        return finalizeResponse(message_text, propertySendComponents ? { ai_components: propertySendComponents } : undefined);
      }
      message_text = rawSendText;

    // ── 💰 初期費用を説明（会話を合わせる）──────────────────────────
    // 2026-09-19 竹内「初期費用を説明のところ会話を合わせるボタンをつける文もちゃんと会話合わせて生成されるように」
    //   固定テンプレは今までどおり画面で作る（AI不使用）。ここに来るのは「会話を合わせる」だけ。
    //   金額はスタッフの入力値だけを使い、入力に無い金額は〇〇円に伏せる（見積書・保証会社と同じ型）。
    } else if (action === "cost_explain") {
      const ceMode = (body.cost_mode === "no_fee" ? "no_fee" : body.cost_mode === "mechanism" ? "mechanism" : "fee") as "fee" | "no_fee" | "mechanism";
      const ceAccount = typeof body.account_key === "string" ? body.account_key : (account ?? null);
      const ceFeeYen = typeof body.landlord_fee_yen === "number" ? body.landlord_fee_yen : null;
      const ceRefundYen = typeof body.refund_yen === "number" ? body.refund_yen : null;
      const ceSavingYen = typeof body.saving_yen === "number" ? body.saving_yen : null;
      const ceFeeLabel = typeof body.landlord_fee_label === "string" ? body.landlord_fee_label : null;
      const ceFacts = buildCostExplainFactsNote({
        account: ceAccount, mode: ceMode,
        landlordFeeYen: ceFeeYen, landlordFeeLabel: ceFeeLabel, refundYen: ceRefundYen, savingYen: ceSavingYen,
      });
      const [ceDiffNote, ceStarNote, ceBrainAddendum] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.cost_explain, currentAction, conversationId, latestCustomerMsg, brainContext),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.cost_explain, latestCustomerMsg, aixBrainMeta),
        loadBrainTemplate("cost_explain"),
      ]);

      const ceSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【この返信の目的】
お客様が「費用の安さ」を不審に思っている・安い理由を聞いています。仕組みと（入力があれば）このお部屋の具体額で1通で答え、**安心して頂く**。

【必ず守ること】
・金額は【確定事実】に書かれた数字だけを使う。他の金額（家賃・初期費用の総額・他社の金額など）は**1円も書かない**
・【確定事実】に「貸主から◯◯円」「◯◯円を還元」がある時は、**その2つの金額を必ず本文に入れる**
  （スタッフが入力した具体額。仕組みの説明だけで終わらせない）
・仲介手数料の書き方は【確定事実】のとおり（スモラは一律2,980円・0円とは書かない／イエヤスとギガは0円）
・「仲介手数料を割引」とは書かない（割引するのは初期費用）
・お客様が挙げた他社の金額を否定しない。金額差は「還元の有無」で説明する
・値引きの約束・交渉の宣言はしない（それは別の場面）
・2〜6行程度。お客様の言葉（不安・他社の金額・仲介手数料）に**直接**答えてから仕組みを説明する

【スタッフの実文（言い回しの手本。中身の金額は写さない）】
[例1・いちばんの手本 2026-09-19]「はい😊！！／／初期費用を抑えられる点についてですが／お部屋によっては貸主様から手数料（家賃1〜2ヶ月分）を頂いており、ここから〇〇さんの初期費用に還元させて頂くことで費用を抑えられる形となっております！！／／仲介手数料2,980円のみとさせて頂いておりますので、最大限費用を抑えさせて頂く形となります！！／無事ご満足頂くお部屋が見つかるまでサポートさせて頂きます！！／何卒よろしくお願い致します😌！」
[例2]「〇〇さんご質問ありがとうございます😊！！／お部屋によっては貸主（オーナー）様から広告費を頂いております！！／一般的な不動産会社はオーナー様から広告費を頂きながら、借主様からも仲介手数料として家賃1ヶ月分を頂く二重の収益構造となっておりますが、／スモラでは仲介手数料を2,980円に抑え、頂いた広告費を〇〇さんの初期費用削減に還元させて頂いております！！」
[例3]「仲介手数料は0円で大丈夫です！！オーナー様からの広告料をお客様に還元させて頂いている仕組みのため、初期費用を一般的な不動産業者様よりお安くご提案出来ております！！／他社様との金額差はこの還元の有無によるものですので、ご安心ください😊！！」（イエヤス・ギガ向け）

【具体的に書く（2026-09-19 竹内「説明このように、具体的に入れるようにする」）】
・「広告料を還元しております」だけで終わらせない。**貸主様から頂く手数料（家賃1〜2ヶ月分）→ お客様の初期費用へ還元**の流れを書く
・スモラは「仲介手数料2,980円のみ」まで書いて、最大限費用を抑えている形だと伝える

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;

      const ceStatic = ceSystem + AIX_CURATED_AND_CRITICAL_RULES;
      const ceDynamic = [
        ceFacts,
        ceBrainAddendum ? `【ブレイン改善ルール】\n${ceBrainAddendum}` : "",
        brainGuidanceNote || "",
      ].filter(Boolean).join("\n\n");
      const ceUser = greetingTimeNote + `${recentHistory}\n\n上記の会話を読み、${name}の不安に直接答える「初期費用の説明」を1通で生成してください。`
        + (ceDiffNote ? `\n\n${ceDiffNote}` : "")
        + (ceStarNote ? `\n\n【参考にすべき成功返信例】\n${ceStarNote}` : "");
      const ceRaw = await callClaude(ceStatic, ceUser, currentAction, ceDynamic || undefined);
      try {
        const mCe = ceRaw.match(/\{[\s\S]*\}/);
        message_text = mCe ? String((JSON.parse(mCe[0]) as { message?: string }).message ?? ceRaw).replace(/\\n/g, "\n") : ceRaw;
      } catch { message_text = ceRaw; }

      // 出口の決定論: ①スモラで「仲介手数料0円」と書いたら直す ②入力した金額が抜けていたら足す
      //   ③入力に無い金額は〇〇円（送信前チェックで止まる）
      {
        const fixed = fixBrokerFeeWording(message_text, ceAccount);
        if (fixed.fixed > 0) console.log("aix:cost-explain-broker-fee-fixed", fixed.fixed);
        const detailed = ensureCostDetail(fixed.text, {
          customerName: name, mode: ceMode,
          landlordFeeYen: ceFeeYen, landlordFeeLabel: ceFeeLabel, refundYen: ceRefundYen, savingYen: ceSavingYen,
        });
        if (detailed.added) console.log("aix:cost-explain-detail-added");
        const checked = checkCostFacts(detailed.text, [ceFeeYen, ceRefundYen, ceSavingYen]);
        if (checked.unmatched.length > 0) console.log("aix:cost-explain-unmatched-yen", JSON.stringify(checked.unmatched));
        message_text = checked.cleaned;
      }
      return finalizeResponse(message_text);

    // ── 🔍 内覧へ！ ──────────────────────────────────────────────
    } else if (action === "viewing_invite") {
      const calendarNote = calendar_info ? String(calendar_info) : null;
      const rescheduleMode = body.reschedule_mode === true;

      // 日程変更モード → シンプルな固定フォーマット生成
      if (rescheduleMode) {
        const rescheduleDiffNote = await getKnowledgeForState(AIX_ACTION_TO_STATES.viewing_invite, currentAction, conversationId, latestCustomerMsg, brainContext);
        const rescheduleSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
お客様に内覧の日程変更をお伝えするLINEメッセージを1つ生成してください。

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}

【日程変更メッセージのルール】
・[お客様名]と呼びかけてから日程変更の旨を伝える
・新しい候補日時があれば含める（calendar_info参照）
・お詫びの言葉を自然に入れる（「ご迷惑をおかけし大変申し訳ございません」等）
・2〜4行程度・完成したLINEメッセージのみ出力`;
        const brainAddendumViReschedule = await loadBrainTemplate("viewing_invite");
        const calendarPart = calendarNote ? `\n\n【変更後の内覧候補日時】\n${calendarNote}` : "";
        // 2026-09-17 竹内（AIX キャッシュ点検）: ブレイン改善ルール（呼び出しごとに変わり得る）は静的ブロックから出して動的へ
        const rescheduleSystemFinal = rescheduleSystem + AIX_CURATED_AND_CRITICAL_RULES;
        const rescheduleUserFinal = greetingTimeNote + `${name}への内覧日程変更メッセージを生成してください。${calendarPart}${recentHistory}` + (rescheduleDiffNote ? `\n\n${rescheduleDiffNote}` : "");
        message_text = await callClaude(
          rescheduleSystemFinal,
          rescheduleUserFinal,
          currentAction,
          [brainAddendumViReschedule ? "【ブレイン改善ルール】\n" + brainAddendumViReschedule : "", brainGuidanceNote || ""].filter(Boolean).join("\n\n") || undefined
        );
        // 早期リターン（以降の通常viewing_invite生成をスキップ）: 共通後処理は finalize() に統一（⑦）
        return finalizeResponse(message_text);
      }

      // conversation_match: 会話に合わせた自然文生成（generate-reply同等品質・早期 return）
      const conversationMatchVI = body.conversation_match as boolean | undefined;
      if (conversationMatchVI) {
        // base_message適応モード: 既存のAIX生成文を会話に合わせて補正
        if (baseMessage) {
          const adaptRulesNoteVI = await getAdaptImprovementRules(currentAction);
          message_text = await adaptMessageToConversation(baseMessage, recentHistory, name, currentAction, "", adaptRulesNoteVI, aixBrainMeta);
          return finalizeResponse(message_text);
        }
        const calendarNoteForVI = calendarNote || "";
        const [viewingConvMatchDiffNote, viewingConvMatchStarNote, brainAddendumViConv] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.viewing_invite, currentAction, conversationId, latestCustomerMsg, brainContext),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.viewing_invite, latestCustomerMsg, aixBrainMeta),
          loadBrainTemplate("viewing_invite"),
        ]);

        // 2026-09-15 隼斗事例: 内覧日指定あり（お客様の希望日）の時は、その日と空き時間だけを渡す（AixModal が viewing_requested_dates・calendar_info を作る）
        const requestedDatesVI = typeof body.viewing_requested_dates === "string" ? body.viewing_requested_dates.trim() : "";
        // 2026-09-19 竹内「AIXの内覧調整のところ会話を合わせるボタンつくる。複雑な場合に対応するために」:
        //   退去予定物件の材料（物件名・退去予定日・内覧解禁日）。日付は vacating-notice の1つの関数で出す（画面・生成文が同じ日を指す）
        const vacancyNameVI = typeof body.vacancy_property_name === "string" ? body.vacancy_property_name.trim() : "";
        const vacancyMoveOutVI = typeof body.vacancy_move_out === "string" ? body.vacancy_move_out.trim() : "";
        const vacancyFromVI = vacancyMoveOutVI ? viewableFromVacancyDate(vacancyMoveOutVI) : null;
        const vacancyBlockVI = vacancyFromVI
          ? [
              buildVacatingPromptNote([{ name: vacancyNameVI, vacDate: vacancyMoveOutVI }]),
              "【この返信で必ず伝える2つ（実データ365日・退去予定のお部屋の内覧案内21通で例外なし）】",
              `・${vacancyDateLabel(vacancyMoveOutVI)}退去予定であること`,
              `・ご案内できるのは ${vacancyFromVI} 以降であること`,
              `・${vacancyFromVI} より前の日付は候補に出さない（まだ見られないお部屋）`,
              "【形は場面に合わせる（型に流し込まない）】",
              "・実送信21通のうち「◯◯現在募集中となります！！」で始まる形は1通だけ。お客様が内覧を依頼した時は「かしこまりました！！」、",
              "  質問に答える時は「はい！！」、御見積書と一緒なら「お手隙の際にご査収ください」で締める等、その場面の形にする",
              "・候補の日時は【内覧可能日時】に入っている物だけを使う（他の日を作らない）",
            ].filter(Boolean).join("\n")
          : "";
        const calendarBlock = requestedDatesVI
          ? `【お客様が希望した日付（内覧日指定あり）】${requestedDatesVI}\n・この日の空き時間だけを伝える（他の日を足さない・「直近ですと」は使わない）\n・形式は「日にちを指定した場合」の形（かしこまりました！！／M/Dお部屋ご案内させて頂きます！！／M/D(曜) 時間／ご案内可能です😊！！／〇〇さんご都合よろしいお時間御座いますでしょうか！！）\n【その日の空き時間（カレンダー・この時間で案内すること）】\n${calendarNoteForVI || "（未入力: 時間は書かず「ご都合よろしいお時間」を伺う）"}`
          : calendarNoteForVI
          ? `【内覧可能日時（カレンダー自動取得・この時間で案内すること）】\n${calendarNoteForVI}`
          : "";

        // キャッシュ最適化: 静的（固定指示）と動的（カレンダー・ブレイン・顧客ガイダンス）を分離
        const convMatchVISystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】ユーザーメッセージに記載のお客様名を使うこと

【内覧日程を案内する際のルール（最優先）】
・カレンダーに複数日がある場合は全日を「直近ですと」ブロック形式で案内する（1日だけ案内して省略するのは絶対禁止）
・日程の書き方フォーマット（必ず守る）:
  かしこまりました！！
  お部屋ご案内させて頂きます！！

  直近ですと
  M/D(曜) HH:MM〜HH:MM
  M/D(曜) HH:MM〜HH:MM
  M/D(曜) HH:MM〜HH:MMにてご案内可能です😊！！

  〇〇さんご都合よろしいお日にち御座いますでしょうか😊！！
・最後の日付行にだけ「にてご案内可能です😊！！」を付ける（途中の行には付けない）
・こちらから日にちを出す時は1日につき時間は1つだけ（「M/D(曜) 12:00〜14:00 16:00〜18:00」のように1日に2つ並べない）
・お客様が日にちを指定した（「18日はどうでしょうか？」）場合は、その日の空き時間だけを次の形で答える（他の日を足さない・「直近ですと」は使わない）:
  かしこまりました！！
  M/Dお部屋ご案内させて頂きます！！

  M/D(曜) HH:MM〜HH:MM HH:MM〜HH:MM
  ご案内可能です😊！！
  〇〇さんご都合よろしいお時間御座いますでしょうか！！
・曜日はユーザーメッセージの曜日表（日本時間）を見て書く（自分で計算しない）
・お客様が「早く進めたい」「審査まで進めたい」と自ら言っている場合のみ、内覧〜審査まで一気に進められることを伝える
・カレンダー未取得または空の場合は「〇〇さんご都合よろしいお日にち御座いますでしょうか😊！！」で締める

【重要：会話読解ルール（必ず守ること）】
・お客様の直近メッセージの意図・感情・urgencyを必ず読み取ってから返信を構成する
・お客様が「早く進めたい」「一気に手続きしたい」「今日行けますか」等と言っている → その意欲を真正面から受け止め、「もちろんです！！」「ぜひ！！」から始めて背中を押す
・お客様が不安・疑問を示している → その不安に直接答えてから日程案内に移る
・お客様が具体的な日付を指定している → その日の空き時間を上の「日にちを指定した場合」の形で直接答える（他の日を足さない）
・お客様の語彙・テンションに合わせる（丁寧語 → 丁寧に、くだけた表現 → 少し柔らかく）
・テンプレ的な返信は絶対禁止。お客様のメッセージに直接応答する文から始める

【絶対禁止】
・🙏 絵文字は絶対に使わない（スモラ禁止絵文字）
・お客様のメッセージを読まずにテンプレを出力する
・複数の案内可能日があるのに1日だけ案内する
・「ご案内出来ます！！」「ご都合如何でしょうか！！」等の旧フレーズ（上記フォーマットに統一）

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;

        const convMatchVIStaticSystem = convMatchVISystem + AIX_CURATED_AND_CRITICAL_RULES;
        const convMatchVIDynamicSuffix = [
          vacancyBlockVI,
          calendarBlock,
          `【曜日表（日本時間）】${weekdayTable(Date.now(), 21)}`,
          brainAddendumViConv ? `【ブレイン改善ルール】\n${brainAddendumViConv}` : "",
          brainGuidanceNote || "",
        ].filter(Boolean).join("\n\n");
        const convMatchVIUserFinal = greetingTimeNote + `${recentHistory}\n\n上記の会話を深く読み取り、${name}への内覧案内返信を生成してください。` + (viewingConvMatchDiffNote ? `\n\n${viewingConvMatchDiffNote}` : "") + (viewingConvMatchStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + viewingConvMatchStarNote : "");
        const rawVI = await callClaude(
          convMatchVIStaticSystem,
          convMatchVIUserFinal,
          currentAction,
          convMatchVIDynamicSuffix || undefined
        );

        try {
          const mVI = rawVI.match(/\{[\s\S]*\}/);
          if (mVI) {
            const dVI = JSON.parse(mVI[0]) as { message?: string };
            message_text = (dVI.message || rawVI).replace(/\\n/g, "\n");
          } else {
            message_text = rawVI;
          }
        } catch {
          message_text = rawVI;
        }

        // 2026-09-16 竹内（𝒮 さん事例）: 1日に時間を2つ出すのはお客様が日にちを指定した時だけ（指示だけでは落ちるので出口でも落とす）
        {
          const limited = limitViewingSlotsInReply(message_text, {
            requestedDatesText: requestedDatesVI,
            messages: Array.isArray(body.recent_messages) ? body.recent_messages as Array<{ sender?: string | null; text?: string | null }> : [],
          });
          if (limited !== message_text) console.log("aix:viewing-slots-limited (conversation_match)");
          message_text = limited;
        }

        // 2026-09-19 竹内: 退去予定物件は「見られない日を出さない」「退去予定と解禁日を必ず伝える」を出口でも効かせる
        //   （材料・指示だけでは落ちるので、無ければ足す・あれば消す。画面／材料／出口の三層）
        if (vacancyFromVI) {
          const cut = stripSlotLinesBeforeViewable(message_text, viewableFromVacancyYmd(vacancyMoveOutVI));
          if (cut.removed.length > 0) console.log("aix:vacancy-slot-before-viewable-removed", JSON.stringify(cut.removed));
          const ensured = ensureVacatingNotice(cut.text, [vacancyMoveOutVI]);
          if (ensured.applied.length > 0) console.log("aix:vacancy-notice", JSON.stringify(ensured.applied));
          message_text = ensured.text;
        }

        // ⑦修正: conversation_match 早期returnでも共通後処理（号室ゼロ除去・内部メモ分離）を通す
        return finalizeResponse(message_text);
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
      // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的 1h）と action 別（経路固有 5m）に分けて取る（fetchPromptRulesSplit は投げない）
      const [viewingDiffNote, viewingStarNote, compViewingGreeting, compViewingInvite, compViewingClosing, viewingRules, viewingBrainAddendum] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.viewing_invite, currentAction, conversationId, latestCustomerMsg, brainContext),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.viewing_invite, latestCustomerMsg, aixBrainMeta),
        getKnowledgeForState(["viewing_invite_greeting"], currentAction),
        getKnowledgeForState(["viewing_invite_invite"], currentAction),
        getKnowledgeForState(["viewing_invite_closing"], currentAction),
        fetchPromptRulesSplit("viewing_invite", {}),
        loadBrainTemplate("viewing_invite"),
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

【日程提示の書き方（calendar_info がある場合・必ず守る）】
かしこまりました！！
お部屋ご案内させて頂きます！！

直近ですと
M/D（曜日）HH:MM〜HH:MM
M/D（曜日）HH:MM〜HH:MM
M/D（曜日）HH:MM〜HH:MMにてご案内可能です😊！！

[お客様名]ご都合よろしいお日にち御座いますでしょうか😊！！

・最後の日付行にだけ「にてご案内可能です😊！！」を付ける（途中の行には付けない）
・1日につき時間は1つだけ（「M/D（曜日）12:00〜14:00 16:00〜18:00」のように1日に2つ並べない）

【実際に送られた内覧誘導メッセージの実例】
例1（内覧希望あり・日程提案）:
かしこまりました！！
お部屋ご案内させて頂きます！！

直近ですと
6/29（月）16:15〜17:15
6/30（火）14:00〜17:00
7/1（水）14:00〜17:00にてご案内可能です😊！！

ニアさんご都合よろしいお日にち御座いますでしょうか😊！！

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
6/29（月）12:00〜13:00
6/30（火）12:00〜16:00
7/1（水）12:00〜16:00にてご案内可能です😊！！

あにかさんご都合よろしいお日にち御座いますでしょうか😊！！

【絶対禁止】
・「いかがでしょうか？」など「？」で終わる → 必ず末尾は「！！」
・内覧誘導の文を2回書く（例：「ご案内します」を繰り返す）
・会話で一度も使っていない名前を突然使う（名前は会話履歴から必ず確認）
・「ぜひ」「是非」「より一層」などの過剰な勧誘ワード

【絵文字ルール】
使ってよい絵文字：😊 😌 🙇‍♀️ 🌟 ✨ のみ・1〜2個まで

【出力形式（必須）】
以下のJSON形式のみで出力してください（説明不要）：
{"greeting":"短い承認行（かしこまりました！！等・なければ空文字）","situation":"状況説明行（退去済み・空室・退去予定情報等・なければ空文字）","invite":"内覧誘導文（核心・必須）","dates":"日程候補全体（直近ですと〜最終日時にてご案内可能です😊！！まで・なければ空文字）","closing":"締め質問行（〇〇さんご都合よろしいお日にち御座いますでしょうか😊！！等・なければ空文字）"}`;

      const calendarPart = calendarNote
        ? `\n\n【直近の内覧可能日時（案内可能な日のみ・1行1日形式・3日分以上ある場合は最低3日分を候補として提示すること）】\n${calendarNote}`
        : extra_input ? `候補日時: ${extra_input}` : "";
      const vacancyPart = vacancy_status === "scheduled" && move_out_date
        ? `\n【物件状況】退去予定日：${move_out_date}（この日以降に内覧可能になる）`
        : vacancy_status === "vacant"
        ? `\n【物件状況】空室（今すぐ内覧可能）`
        : "";
      const propNamePart = property_name ? `\n【物件名】${property_name}` : "";
      // 2026-09-17 竹内（AIX キャッシュ点検）: [global 1h] → [固有文＋action 別ルール＋確認済みルール 5m] → [ブレイン改善ルール・顧客ガイダンス cache なし]
      //   （ブレイン改善ルールは従来 static 内にあったが呼び出しごとに変わり得るので動的へ）
      const viewingSystemSpec: SystemSpecBlocks = {
        semiStatic: viewingRules.global.replace(/^\n\n/, ""),
        routeStatic: system + viewingRules.action + AIX_CURATED_AND_CRITICAL_RULES,
        dynamic: [viewingBrainAddendum ? "【ブレイン改善ルール】\n" + viewingBrainAddendum : "", brainGuidanceNote || ""].filter(Boolean).join("\n\n"),
      };
      const viewingUserBase = `${name}への内覧お誘いメッセージ。${propNamePart}${vacancyPart}${calendarPart}${templateStructureNote}${recentHistory}`;
      const viewingUserFinal = greetingTimeNote + viewingUserBase + (viewingDiffNote ? `\n\n${viewingDiffNote}` : "") + (viewingComponentNote ? `\n\n${viewingComponentNote}` : "") + (viewingStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + viewingStarNote : "") + (phraseText ? `\n\n【スモラのよく使うフレーズ（参考）】\n${phraseText}` : "") + (viewingExamplesText ? viewingExamplesText : "");
      const rawViewingText = await callClaude(viewingSystemSpec, viewingUserFinal, currentAction);
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
      // 2026-09-16 竹内（𝒮 さん事例）: こちらから日にちを出す時は1日1つ（お客様が1日だけ指定した時はその日の時間をそのまま）
      {
        const limited = limitViewingSlotsInReply(message_text, {
          requestedDatesText: typeof body.viewing_requested_dates === "string" ? body.viewing_requested_dates : "",
          messages: Array.isArray(body.recent_messages) ? body.recent_messages as Array<{ sender?: string | null; text?: string | null }> : [],
        });
        if (limited !== message_text) console.log("aix:viewing-slots-limited");
        message_text = limited;
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
        getKnowledgeForState(appKnowledgeStates, currentAction, conversationId, latestCustomerMsg, brainContext),
        getStarredExamplesForAction(appKnowledgeStates, latestCustomerMsg, aixBrainMeta),
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
      // 2026-09-17 竹内（AIX キャッシュ点検）: global（全 AIX 共通・不変）は準静的ブロック（1h）、action 別（条件付き）は経路固有ブロックの末尾（5m）に置く
      const appRules = await fetchPromptRulesSplit("application_push", {
        has_estimate: String(has_estimate === true),
        app_sub_mode: appSubMode || "push",
      });
      const appGlobalRules = appRules.global.replace(/^\n\n/, "");

      if (appSubMode === "confirm") {
        // 2026-09-16 竹内（カイナ事例）「AIX の申込誘導の文で部屋が決まっていなければ3部屋の中でどれが良いか」:
        //   実送信 11:53「かしこまりました！！／代理契約でお申込みさせて頂きます！！／現在募集の3部屋の中で(1303号室・906号室・506号室)／
        //   お部屋は何号室で審査かけさせていただきましょうか！！」。号室はスタッフが入れた物だけを使う（会話に無いので作らせない）
        const roomList = parseRoomChoices(typeof body.room_choices === "string" ? body.room_choices : "");
        const askRoom = shouldAskRoomChoice(roomList);
        // ── 申込確定: 会話を読んでお申込み確定メッセージを生成
        const confirmSystem = askRoom
          ? `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
お客様が「お申込みを進めてほしい」と言ったが、**どのお部屋にするかがまだ決まっていない**場面です。
お申込みを承諾しつつ、募集中のお部屋のうちどれで審査をかけるかを尋ねる LINE メッセージを1つ作成してください。

【メッセージ構成 — この4行のみ・厳守】
①「かしこまりました！！」（この文言で固定・変更禁止）
②「[この会話の申込の形]お申込みさせて頂きます！！」
・会話で決まっている申込の形があればそれを付ける（例: 代理契約の話が続いていれば「代理契約でお申込みさせて頂きます！！」）。無ければ「お申込みさせて頂きます！！」だけ
③「現在募集の[件数]部屋の中で([号室を「・」で並べる])」
④「お部屋は何号室で審査かけさせていただきましょうか！！」（この文言で固定）
・③の件数・号室は下の【スタッフが入れた候補の号室】をそのまま使う（1つも足さない・減らさない・並び順も変えない）
・絵文字は使わないか😊を1個まで。語尾は「！！」

【禁止】書類案内・審査の説明・初期費用・内覧の案内・物件のアピールは一切書かない。この4行以外を追加しない。
・スタッフが入れた号室以外の号室・物件名・部屋数を書くことは絶対禁止
・LINEでそのまま送れる完成文のみ出力

【スモラLINE営業ルール（必ず守る・ただし上記の4行構成が最優先）】
${SMORA_COMMON_RULES}`
          : `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
お客様の申込みを快く承諾する2行のLINEメッセージを1つ作成してください。

【メッセージ構成 — この2行のみ・厳守】
①「かしこまりました！！」（この文言で固定・変更禁止）
②「[物件名 号室]、お申込みさせて頂きます😊！！」
・②は日本語として自然につながるよう読点・助詞を軽く調整してよい（例:「マルシェ九条 402号室、お申込みさせて頂きます😊！！」「ASK-6でお申込みさせて頂きます😊！！」）
・②の絵文字は😊または😌を1個のみ。語尾は必ず「！！」
・お客様の決断を一緒に喜ぶ温かいトーンで。ただし行を増やさない

【禁止】書類案内・審査案内・初期費用・次ステップ案内は一切書かない。この2行以外を追加しない。物件の感想・アピールも書かない。解説不要。
・LINEでそのまま送れる完成文のみ出力

【スモラLINE営業ルール（必ず守る・ただし上記の2行構成が最優先）】
${SMORA_COMMON_RULES}`;

        // 動的（顧客/物件ごとに変わる）ブロックはキャッシュ対象の system から分離する
        const confirmPropertyNameNote = askRoom
          ? `【スタッフが入れた候補の号室（この通りに書く・増やさない）】
${roomChoiceNote(roomList)}
${property_name ? `物件名: ${property_name}（③で物件名を書く必要はない。号室だけでよい）` : ""}
【申込の形】会話に代理契約の話が続いていれば②を「代理契約でお申込みさせて頂きます！！」にする。会話に無ければ形は付けない（推測で書かない）`
          : `【物件名+号室の特定 — 会話全体を読んで以下の優先順で探す】
${property_name ? `物件名は「${property_name}」を使う（指定済み）。会話履歴から号室が分かる場合（スタッフメッセージの「【物件名 号室】」表記や見積書送付時の記載など）は「${property_name} ○号室」のように号室も付ける。号室が不明なら物件名のみでよい。` : `1. お客様自身の発言を最優先（「〇〇にします！」「〇〇で申し込みます」「〇〇に決めました」等で名指しされた物件名）
2. 会話履歴のスタッフメッセージ冒頭「【物件名 号室】」形式（例:「【ASK-6 201号室】」→「ASK-6 201号室」）
3. 上記がなければ、会話の中で最後に話題になっていた物件名
・号室が分かる場合は必ず「物件名 ○号室」の形で含める（例:「マルシェ九条 402号室」）。号室不明なら物件名のみ
・複数物件が出ている会話では、お客様が申込む意思を示した物件を直近の文脈から選ぶ
・確実に特定できない場合は「こちらのお部屋」とする。誤った物件名を推測で書くことは絶対禁止`}`;

        const brainAddendumAppConfirm = await loadBrainTemplate("application_push");
        // 2026-09-17 竹内（AIX キャッシュ点検）: ブレイン改善ルールは静的ブロックから出して動的へ（号室・物件名の注記の前）
        const confirmSystemSpec: SystemSpecBlocks = {
          semiStatic: appGlobalRules,
          routeStatic: confirmSystem + appRules.action + AIX_CURATED_AND_CRITICAL_RULES,
          dynamic: [brainAddendumAppConfirm ? "【ブレイン改善ルール】\n" + brainAddendumAppConfirm : "", confirmPropertyNameNote, brainGuidanceNote].filter(Boolean).join("\n\n"),
        };
        const confirmUserFinal = `${name}への申込確定メッセージ。${property_name ? `物件名:${property_name}。` : ""}${recentHistory}` + (appDiffNote ? `\n\n${appDiffNote}` : "") + (appStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + appStarNote : "");
        message_text = await callClaude(confirmSystemSpec, confirmUserFinal, currentAction);
        // 2026-09-16 本番確認（カイナ）: 会話に一度も出ていない「1303号室」を2回とも書いた（プロンプトが号室を促すため埋める）。
        //   号室を間違えると別の部屋に審査がかかるので、根拠（会話＋スタッフ入力）に無い号室は落とす
        {
          const grounded = [property_name ?? "", roomList.join("・"), recentHistory].join("\n");
          const sr = stripUngroundedRoomNo(message_text, grounded);
          if (sr.removed.length) {
            message_text = sr.text;
            console.log(JSON.stringify({ tag: "aix:apply-ungrounded-room", conversationId, removed: sr.removed }));
          }
        }

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
①お礼（1行）：「[お客様名]申込書ご記入いただきありがとうございます！！」（※[お客様名]は既に「さん」付きのため「さん」を重ねない）
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

        // docs_request には不動産ルール（連帯保証人=実印+印鑑証明書・支払い義務あり vs 緊急連絡先=電話のみ・支払い義務なし 等）も注入
        const brainAddendumAppDocs = await loadBrainTemplate("application_push");
        // 2026-09-17 竹内（AIX キャッシュ点検）: ブレイン改善ルールは静的ブロック（不動産ルールの前にあった）から出して動的へ
        const docsSystemSpec: SystemSpecBlocks = {
          semiStatic: appGlobalRules,
          routeStatic: docsRequestSystem + appRules.action + "\n\n" + REAL_ESTATE_RULES + AIX_CURATED_AND_CRITICAL_RULES,
          dynamic: [brainAddendumAppDocs ? "【ブレイン改善ルール】\n" + brainAddendumAppDocs : "", brainGuidanceNote || ""].filter(Boolean).join("\n\n"),
        };
        const docsUserFinal = `${name}への書類依頼メッセージ。${recentHistory}` + (appDiffNote ? `\n\n${appDiffNote}` : "") + (appStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + appStarNote : "");
        const rawDocsText = await callClaude(docsSystemSpec, docsUserFinal, "docs_request");
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
        // base_message適応モード: 既存のAIX生成文を会話に合わせて補正
        if (baseMessage) {
          const adaptRulesNoteApp = await getAdaptImprovementRules(currentAction);
          message_text = await adaptMessageToConversation(baseMessage, recentHistory, name, currentAction, "", adaptRulesNoteApp, aixBrainMeta);
          return finalizeResponse(applyReplyFinish(message_text));
        }
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
        // キャッシュ最適化: 静的（固定指示）と動的（カレンダー・DBルール・ブレイン）を分離
        const convMatchSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】ユーザーメッセージに記載のお客様名を使うこと

【内覧日程を案内する際のルール（最優先）】
・カレンダーに複数日がある場合は全日を自然な文章で案内する（1日だけ案内して他の日を省略するのは絶対禁止）
・フォーマット例：「明日7/9(木)ですと13:00〜16:00、明後日7/10(金)ですと13:00〜15:00にてご案内可能です！！」
・お客様が日程を指定してきた場合は「はい！！〇日ですと〜」でその日程に直接答える
・お客様が「早く進めたい」「審査まで進めたい」「一気に手続きしたい」と自ら言っている場合のみ、内覧〜審査まで一気に進められることを伝える（単なる内覧希望には審査・申込の話をしない）
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

        const brainAddendumAppConv = await loadBrainTemplate("application_push");
        // 2026-09-17 竹内（AIX キャッシュ点検）: [共通 prefix 1h] → [global 1h] → [固有文＋action 別ルール 5m] → [カレンダー・ブレイン cache なし]
        //   （DB ルールは従来キャッシュ外の動的接尾にあった。共通 prefix の分割は splitSharedPrefix・文面は不変）
        const { shared: convMatchAppShared, routeStatic: convMatchAppBody } = splitSharedPrefix(convMatchSystem);
        const convMatchAppSpec: SystemSpecBlocks = {
          shared: convMatchAppShared,
          semiStatic: appGlobalRules,
          routeStatic: convMatchAppBody + appRules.action,
          dynamic: [
            calendarBlock,
            brainAddendumAppConv ? `【ブレイン改善ルール】\n${brainAddendumAppConv}` : "",
          ].filter(Boolean).join("\n\n"),
        };
        const convMatchAppUserFinal = `${recentHistory}\n\n上記の会話を深く読み取り、${name}への内覧案内返信を生成してください。` + (appDiffNote ? `\n\n${appDiffNote}` : "") + (appStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + appStarNote : "");
        const raw = await callClaude(
          convMatchAppSpec,
          convMatchAppUserFinal,
          currentAction
        );

        try {
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) {
            const d = JSON.parse(m[0]) as { message?: string };
            message_text = (d.message || raw).replace(/\\n/g, "\n");
          } else {
            message_text = raw;
          }
        } catch {
          message_text = raw;
        }

        // ⑦修正: conversation_match 早期returnでも共通後処理（号室ゼロ除去・内部メモ分離）を通す
        return finalizeResponse(applyReplyFinish(message_text));
      }

      let system: string;
      let userMsg: string;
      let appGreetingForUser = "";
      // 動的（顧客/物件/日付ごとに変わる）ブロック。キャッシュ対象の system から分離して渡す
      let appDynamicSuffix = "";
      // 2026-09-17 竹内（AIX キャッシュ点検）: system の中で呼び出しごとに変わる部分（構成＝isSimple・hasEst・calendar_info の有無で変わる／
      //   30日入居ルール／見積書済みの注記／出力形式）。静的ブロックの鍵が変種で割れないよう動的ブロックの先頭に置く（文面は同じ・並びだけ後ろ）
      let appSystemDynamic = "";

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

【スモラの言葉・表現】
${examplesText}`;
        appDynamicSuffix = `【テンプレート】
${template}

【穴埋めルール】
・「[物件名]」→ ${property_name ? `「${property_name}」を使う（指定済み）` : '会話履歴から特定（最新の物件名を使う）。見つからなければ「こちらのお部屋」に置換。'}
・テンプレートの文言・改行・絵文字は変えない
・例外（任意・最大1行）: お客様が会話で審査・キャンセル・「内覧できないのに申込は不安」等の不安を示している場合のみ、末尾に「保証会社の審査が通過するまでキャンセル料は一切かかりませんのでご安心ください😊！！」を1行追加してよい。不安が見えなければ追加しない
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）`;
        userMsg = `物件名を会話から特定してテンプレートを完成させてください。${extra_input ? `補足: ${extra_input}` : ""}${templateStructureNote}${recentHistory}` + (phraseText ? `\n\n【スモラのよく使うフレーズ（参考）】\n${phraseText}` : "");

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
    ? `「[お客様名]初期費用面もお気に召されましたらお申込みしお部屋抑えさせていただきます😊！！\nお申込みいかがでしょうか！！」`
    : `「[お客様名]お気に召されましたらお申込み是非ご検討ください😊！！」`}
③締め：「気になる点ございましたらお気軽にお申し付けください！！」`
          : `【メッセージ構成 — この順番を厳守】
①入居日安心（任意）：お客様が会話の中で入居希望日・入居時期を述べている場合のみ、メッセージの冒頭に置く。下記【入居希望日と30日入居ルール】で計算確認したうえで「8月7日〜10日のご入居で問題ございません！！」のように断言して安心させる。入居希望日の話が出ていない場合はこの行を書かない（空文字にする）
②内覧案内：空室につきご来店頂ければ内覧・申込・審査まで当日中に進められる旨を伝える。${calendar_info ? `カレンダー情報をもとに具体的な来店可能日時を提示すること。形式は「[お客様名]空室ですのでご来店頂けますと内覧から審査まで当日中に進めることができます！！\n\n直近ですと\n[案内可能な日を1行ずつ: 明日(7/9木)なら「明日（7/9木）11:00〜14:00」のように]\nご案内可能です！！」。案内不可の日は一切含めない。` : `「空室ですので[お客様名]ご都合よろしいお日にちにご案内させて頂きます！！」`}
③物件アピール（1行）：お客様の希望に合っている理由を具体的に + 「お申込みが入る可能性が高いお部屋となります！！」
④申込み推奨：「[お客様名]お気に召されましたら一度お申込みし抑えさせてご内覧いただくのがオススメです😌！！」`;

        // 2026-09-17 竹内（AIX キャッシュ点検）: 静的部分（役割・共通ルール・アピールの書き方・不安解消・禁止・絵文字・☆実例）だけを system に残し、
        //   isSimple・hasEst・calendar_info で変わる部分（構成・30日入居ルール・見積書済みの注記・出力形式）は appSystemDynamic（動的ブロックの先頭）へ
        system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
会話履歴を読み取り、お客様に申込みを後押しするLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【物件アピールの書き方 — 最重要】
・「かなりご条件の良い」「ご条件がよく」のような曖昧な表現は禁止 → 必ず会話から具体的な根拠を入れる
・家賃/管理費 → 「家賃管理費込○○円とご予算内のかなりお得なお部屋となります！！」
・初期費用 → 「初期費用○○円とかなり初期費用を抑えられるお部屋となります！！」
・築年数・間取り → 「○○年築・○LDKで○○さんご希望の条件がかなり揃うお部屋となります！！」
・エリア・駅距離 → 「○○駅徒歩○分で○○さんご希望エリアのかなりオススメのお部屋となります！！」
・複数ポイントを組み合わせる場合は1〜2行に自然にまとめる
・会話に数字や特徴が見当たらない場合は「かなりオススメできるお部屋となります！！」でよい

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
${examplesText}`;
        appSystemDynamic = [
          structureNote,
          !isSimple ? `【入居希望日と30日入居ルール — 最重要】
・不動産賃貸の一般的なルールとして「お申込み日から30日以内にご入居いただく形」となる。今日の日付（ユーザーメッセージ末尾に記載）の30日後が入居期限
・お客様が入居希望日を述べている場合は、必ず次の計算をする：「今日の日付 ＋ 30日 ＝ 入居期限」→ 入居希望日が入居期限と同じ頃またはそれ以前なら期間に間に合うので問題なし
　例：今日が7月9日・希望が8月7日〜10日 → 7月9日申込なら入居期限は8月8日 → ほぼぴったりなので問題なし
・問題なしの場合：構成①で「〇月〇日のご入居で問題ございません！！」と冒頭で断言して安心させ、そのまま②内覧案内へ自然に繋げる
・入居希望日が今日の日付＋30日より大きく先の場合のみ「〇月〇日頃にお申込み頂ければご希望日でご入居頂けます😊！！」と最適な申込時期を1行で案内する（急かさない）
・【絶対禁止】審査期間の話（「審査に3〜10日かかる」「逆算して早めのお申込みを」等）は一切書かない。入居日の話はすべて30日入居ルールだけで説明する` : "",
          hasEst ? "・見積書はすでに送信済み。①の物件アピールで費用・見積書への再言及は厳禁（お客様はすでに見積書を持っている）。②のCTAで「初期費用面もお気に召されましたら」と一言触れるだけでよい" : "",
          `【出力形式（必須）】
以下のJSON形式のみで出力してください（説明不要）：
${isSimple
  ? `{"appeal":"物件アピール（①・物件名+希望理由）","cta":"申込み後押し（②）","reassurance":"不安解消行（任意・なければ空文字）","closing":"締め（③）"}`
  : `{"movein_date":"入居日安心（①・任意・入居希望日の話が出ていなければ空文字）","invite":"内覧案内（②）カレンダーあり時は複数行で日程を含む全文、なければ1行","appeal":"物件アピール（③）","cta":"申込み推奨（④）","reassurance":"不安解消行（任意・なければ空文字）"}`}`,
        ].filter(Boolean).join("\n\n");
        appDynamicSuffix = `【物件名の特定】
${property_name ? `「${property_name}」を使う（指定済み）` : '会話履歴の最新スタッフメッセージ冒頭「【物件名 号室】」から物件名のみを抽出（例:「【ASK-6 201号室】」→「ASK-6」）。見つからなければ会話全体から特定、それもなければ「こちらのお部屋」。'}

${appealFocus}`;
        const calendarNoteForApp = calendar_info ? `\n\n【直近の来店・内覧可能時間帯（カレンダー自動取得済み — この情報をそのまま②内覧案内に使うこと）】\n${calendar_info}` : "";
        // 30日入居ルール計算用の今日の日付をuserメッセージ側に注入（systemブロックのキャッシュを壊さないよう動的データはここに置く）
        userMsg = `${name}への申込後押しメッセージ。${property_name ? `物件名:${property_name}。` : ""}${extra_input ? `補足:${extra_input}。` : ""}${calendarNoteForApp}${templateStructureNote}${recentHistory}${!isSimple ? `\n【本日の日付】${todayJSTFmt}` : ""}`;
        appGreetingForUser = greetingTimeNote;
      }

      const brainAddendumApp = await loadBrainTemplate("application_push");
      // 2026-09-17 竹内（AIX キャッシュ点検）: [global 1h] → [固有文（静的部分）＋action 別ルール＋確認済みルール 5m] →
      //   [構成・30日ルール・出力形式（appSystemDynamic）→ ブレイン改善ルール → 物件名・訴求 → 顧客ガイダンス cache なし]
      const appSystemSpec: SystemSpecBlocks = {
        semiStatic: appGlobalRules,
        routeStatic: system + appRules.action + AIX_CURATED_AND_CRITICAL_RULES,
        dynamic: [appSystemDynamic, brainAddendumApp ? "【ブレイン改善ルール】\n" + brainAddendumApp : "", appDynamicSuffix, brainGuidanceNote].filter(Boolean).join("\n\n"),
      };
      const appUserFinal = appGreetingForUser + userMsg
        + (appDiffNote ? `\n\n${appDiffNote}` : "")
        + (compAppealNote ? `\n\n${compAppealNote}` : "")
        + (appStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + appStarNote : "");
      const rawAppText = await callClaude(appSystemSpec, appUserFinal, currentAction);
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
      // 2026-09-16 竹内（💜 さん事例）: 申込の情報を受け取った時の「はい😊！！」を落とし、営業時間外なら「明日確認してご連絡」を入れる
      message_text = applyReplyFinish(message_text);

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

      // 学習済み差分ルール（スタッフ修正から学習したパターン）＋DBルールをプロンプト末尾に注入
      // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的 1h）と action 別（経路固有の末尾）に分けて静的ブロックへ（従来はキャッシュ外の動的接尾）
      const [moveInDiffNote, moveInRules] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.property_check_result, currentAction, conversationId, latestCustomerMsg, brainContext),
        fetchPromptRulesSplit("property_check_result", { check_pattern: "move_in_date" }),
      ]);

      const content: Array<{ type: string; text?: string; source?: { type: string; url: string } }> = [
        { type: "text", text: `${name}へ送る入居日確認メッセージを作成してください。` + (moveInDiffNote ? `\n\n${moveInDiffNote}` : "") },
        { type: "image", source: { type: "url", url: String(image_url) } },
      ];
      message_text = await callClaudeVision(
        { semiStatic: moveInRules.global.replace(/^\n\n/, ""), routeStatic: moveInSystem + moveInRules.action },
        content,
        currentAction
      );

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
LICC系: ジェイリース、全保連、JID、全国保証、アート・プランニング、青山ライフデザイン、保証ベース
独立系（最も審査緩い）: 日本セーフティー、エルズサポート、Casa、フォーシーズンズ、ルームバンク、いえらぶ保証、スマートタカミ、イントラスト、レジデンシャルパートナーズ、日本トラストコーポレーション、株式会社日本トラストコーポレーション`;

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
        ? `[お客様名]お気に召されましたらお申込みしお部屋抑えさせて頂きます！！`
        : guarantorPushType === "viewing"
        ? `[お客様名]お気に召されましたらご都合よろしいお日にちにご案内させて頂きます😊！！`
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

      // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的 1h）と action 別（経路固有の末尾 5m）に分けて取る
      const [guarantorDiffNote, guarantorRules] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.property_check_result, currentAction, conversationId, latestCustomerMsg, brainContext),
        fetchPromptRulesSplit("property_check_result", { check_pattern: "mgmt_guarantor" }),
      ]);

      const guarantorSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
管理会社に確認した保証会社情報をお客様に報告するLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【お客様名】ユーザーメッセージに記載のお客様名を使うこと

【重要】
・②と③の間には必ず空行を1行入れること（報告→空行→タイプ説明）
・③は独立系の場合「審査基準緩く、審査通過する可能性十分に御座います！！」のような前向きな表現にすること
・誘導がない場合は③で締める（ctaはnull）

【出力形式（必須）】
JSONのみ: {"greeting":"①","report":"②（[物件名]解決済み・改行は\\nで）","type_desc":"③","cta":"④またはnull"}`;

      // 動的（保証会社名・物件名・誘導文など呼び出しごとに変わる）ブロックは system から分離する
      const guarantorDynamicNote = `【${propertyNameInstruction}】

【確定情報（変更禁止）】
保証会社名: ${companyName || "資料より確認済み"}
保証タイプ: ${guarantorType}

【メッセージ構成（厳守）】
①挨拶: 「（時候の挨拶）」
②確認報告: 「${reportBlock}」（[物件名]を解決してから書く・②内の改行は\\nで出力）
③タイプ説明: 「${typeDesc}」（②の後に空行を1行入れてから書く）
${pushLine ? `④誘導: 「${pushLine}」` : "④誘導: なし（省略・ctaはnull）"}`;

      // 2026-09-17 竹内（AIX キャッシュ点検）: [global 1h] → [固有文＋action 別ルール＋確認済みルール 5m] → [保証会社名・物件名・誘導・挨拶・顧客ガイダンス cache なし]
      const rawGuarantorText = await callClaude(
        {
          semiStatic: guarantorRules.global.replace(/^\n\n/, ""),
          routeStatic: guarantorSystem + guarantorRules.action + AIX_CURATED_AND_CRITICAL_RULES,
          dynamic: guarantorDynamicNote + "\n\n" + (greetingPhrase ? `【挨拶フレーズ】${greetingPhrase}\n` : "") + (brainGuidanceNote || ""),
        },
        `${name}への保証会社確認報告メッセージ。${recentHistory}` + (guarantorDiffNote ? `\n\n${guarantorDiffNote}` : ""),
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
      // 画像URLをレスポンスに含める（フロントエンドで画像先送りに使用）
      // ⑦修正: 早期returnでも finalize()（号室ゼロ除去・内部メモ分離）を通す。
      //   画像なしの場合はフォールスルーしメインパス末尾の finalize() で後処理される
      if (image_url) {
        return finalizeResponse(message_text, { doc_image_url: String(image_url) });
      }

    // ── 🏢 管理会社に確認した（退去予定日・入居可能日・初期費用・駐車場・ペット飼育・設備・募集状況）＋ 近隣月極駐車場確認 ──────────
    } else if (
      action === "property_check_result" &&
      (check_pattern === "vacate_date" || check_pattern === "mgmt_move_in" || check_pattern === "mgmt_initial_cost" || check_pattern === "mgmt_proxy" || check_pattern === "mgmt_parking" || check_pattern === "mgmt_pet" || check_pattern === "mgmt_equipment" || check_pattern === "mgmt_availability" || check_pattern === "nearby_parking" || check_pattern === "owner_other")
    ) {
      let mgmtInfo = extra_input ? String(extra_input).trim() : "";
      // 2026-09-16 竹内（カイナ事例）: 代理契約の可否。入れるのは物件名と可能／不可だけで、あとは会話に合わせる
      const proxyResult = body.proxy_result as string | undefined;
      if (check_pattern === "mgmt_proxy") {
        if (proxyResult !== "可能" && proxyResult !== "不可") throw new Error("代理契約が可能か不可かが必要です");
        mgmtInfo = [`代理契約：${proxyResult}`, property_name ? `物件名：${property_name}` : "物件名：入力なし（物件名に触れない）"].join("\n");
      }
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
      } else if (check_pattern === "mgmt_move_in") {
        const moveInPropName = body.move_in_prop_name as string | undefined;
        const moveInRoomNo = body.move_in_room_no as string | undefined;
        const moveInVacateDate = body.move_in_vacate_date as string | undefined;
        const moveInMonth = body.move_in_month as string | undefined;
        const moveInPeriod = body.move_in_period as string | undefined;
        const moveInGuidanceType = body.move_in_guidance_type as string | undefined;
        if (!moveInPropName || !moveInVacateDate || !moveInMonth || !moveInPeriod) throw new Error("入居可能日の入力情報が不足しています");
        const roomSuffix = moveInRoomNo ? `${moveInRoomNo}号室` : "";
        const guidanceLabel = moveInGuidanceType === "申込" ? "申込誘導" : "内覧誘導";
        mgmtInfo = `物件名: ${moveInPropName}${roomSuffix}\n退去予定日: ${moveInVacateDate}\n最短入居可能時期: ${moveInMonth}${moveInPeriod}\n誘導タイプ: ${guidanceLabel}`;
      } else if (check_pattern === "mgmt_availability") {
        const availabilityStatus = body.mgmt_availability_status as string | undefined;
        if (availabilityStatus !== "available" && availabilityStatus !== "ended") throw new Error("募集状況が必要です");
        const lines = [`募集状況：${availabilityStatus === "available" ? "現在まだ募集している（募集中）" : "募集が終了した"}`];
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
      const mgmtGreeting = "（時候の挨拶）"; // greetingPhraseはdynamicSystemSuffixへ移動（P1-1）

      // 共通誘導文（申込/内覧ボタン選択時のクロージング）
      const guidanceType = body.guidance_type as string | undefined;
      const guidanceClose = guidanceType === "申込"
        ? `[お客様名]良ければ先にお申込みでお部屋を抑えて内覧もできます😊！！良ければお申込みはいかがでしょうか！！`
        : guidanceType === "内覧"
        ? `[お客様名]ご都合よろしいお日にちにご内覧のご案内させて頂きます😊！！`
        : null;
      const guidanceRule = guidanceClose
        ? `・最終行のクロージング文は必ず「${guidanceClose}」をそのまま使用すること（変更禁止）`
        : "";

      // パターン別のフォーマット・ルール（スモラ実データ由来）
      const MGMT_PATTERNS: Record<string, { label: string; format: string; rules: string }> = {
        vacate_date: {
          label: "退去予定日",
          format: `${mgmtGreeting}
[物件名]の退去予定日確認取れました！！
[退去予定日]退去予定の為[内覧解禁日]以降でご内覧可能予定となっております！！
${guidanceClose ?? `[お客様名]お気に召されましたら[内覧解禁日]以降でご案内させて頂きます😊！！`}`,
          rules: `・[退去予定日]はスタッフ入力情報から抽出する（例:「7月31日」）
・[内覧解禁日]＝退去日の翌日（例: 7月31日退去→8月1日。6月30日退去→7月1日）
・3行目・4行目両方に同じ[内覧解禁日]を使う
・スタッフ入力に「未定」「確認中」等とある場合は3行目を「退去予定日確定次第すぐにご連絡させて頂きます！！」に差し替え、4行目は削除する
${guidanceRule}`,
        },
        // 2026-09-16 竹内（カイナ事例）「管理会社に確認したに代理契約についてのピッカーを作る。この場合 確認した（条件・交渉）から返信する形とする」
        //   実送信の型: 可能「アーバンフラッツ心斎橋に代理契約可能か確認させて頂きましたところ／代理契約可能となります😊！！」（9/16 11:48）・
        //   「管理会社に確認させていただき、息子様での代理契約可能とのご返事いただけました😊！！」（9/15 yasuki）・
        //   不可「代理契約での審査が出来ないお部屋となります。」（9/11 タクミ）・
        //   交渉中「代理契約につきまして交渉させて頂き、現在管理会社からの連絡待ちの状況となっております。進捗あり次第ご連絡させて頂きます！！」（9/11）
        mgmt_proxy: {
          label: "代理契約の可否",
          format: proxyResult === "不可"
            ? `[物件名]に代理契約可能か管理会社に確認させて頂きましたところ
代理契約での審査が出来ないお部屋となります。`
            : `[物件名]に代理契約可能か管理会社に確認させて頂きましたところ
代理契約可能となります😊！！`,
          // 実送信（カイナ 9/16 11:48）は挨拶なしの2行で終えている（直前 08:58 で既に「よろしければご案内させて頂きます」と案内済みのため）
          rules: `・**この2行だけで終えるのが基本**（実際にスタッフが送っている形）。挨拶（お世話になっております等）・時候の挨拶は書かない＝1行目から始める
・スタッフが入れたのは「代理契約：可能／不可」と「物件名」の2つだけ。これ以外の事実は絶対に書かない:
  - 年収・家賃帯・審査の見通し・保証会社・条件
  - **他の物件名・他のお部屋の可否**（スタッフが入れた物件名以外は一切出さない）
・[物件名]はスタッフ入力の物件名をそのまま使う（複数は「〇〇・〇〇ともに」）。物件名が「入力なし」なら1行目は「代理契約可能か管理会社に確認させて頂きましたところ」から始める
・3行目（次の一手）を足してよいのは、**この会話で内覧のご案内も申込のご案内も一度もしていない時だけ**。会話に「ご案内させて頂きます」「ご内覧」「お申込み」が既にあれば足さない（同じ案内の繰り返しになる）:
  - 足す場合（可能）: 内覧の話が出ていなければ「よろしければ一度お部屋ご内覧如何でしょうか😊！！」
  - 不可の時は足さない（代わりの提案はスタッフが別の AIX で送る）
・「審査に通る」「大丈夫です」など確認していない断定はしない`,
        },
        mgmt_move_in: {
          label: "入居可能日",
          format: `${mgmtGreeting}
[物件名][号室]管理会社に確認しましたところ
[退去予定日]退去予定の為
最短で[入居可能時期]にご入居出来る予定となります！！
[誘導文]`,
          rules: `・[物件名]はスタッフ入力の「物件名」をそのまま使う
・[号室]はスタッフ入力に号室がある場合のみ「○○号室」形式で付ける（ない場合は省略）
・[退去予定日]はスタッフ入力の「退去予定日」をそのまま使う（例: 「7月20日」）
・[入居可能時期]はスタッフ入力の「最短入居可能時期」をそのまま使う（例: 「8月下旬」）
・誘導タイプ「申込誘導」の場合: [誘導文]＝「[お客様名]良ければ先にお申込みでお部屋を抑えてから内覧もできます！！😊良ければお申込みはいかがでしょうか！！」
・誘導タイプ「内覧誘導」の場合: [誘導文]＝「退去後のご内覧となりますが、[お客様名]ご都合よろしいお日にちにご案内させて頂きます😊！！」
・[誘導文]は必ず改行して最後の行に付ける`,
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
              rules: `・[確認内容]はスタッフ入力情報から抽出する。入力がない場合は具体的な費目（礼金なし等）を書かず「最大限割引できることを確認いたしました」とする（礼金・敷金等の具体的条件の推測記載は絶対禁止）
・具体的な金額が入力されている場合はそのまま記載する（計算・変更禁止）
・【物件固有の金額・数値はAIが画像を見れないため生成禁止】AIは物件資料・見積書等の画像を読み取ることができない。そのため、家賃・管理費・敷金礼金・初期費用内訳・合計金額・割引額など、物件固有の具体的な数値に関する質問には、AIが推測・生成して回答することを絶対禁止とする。これらの数値は必ずスタッフが画像を確認した上で、AIX（見積書送る／物件確認した等）から送付する。`,
            };
          } else {
            return {
              label: "初期費用（管理会社交渉）",
              format: `${mgmtGreeting}
[物件名]の初期費用について管理会社へ交渉させて頂きました！！
[交渉結果]となりました！！
${guidanceClose ?? ""}`,
              rules: `・[交渉結果]はスタッフ入力情報から抽出する（例:「礼金1→0に交渉成功」「礼金の交渉は難しい状況」）
・交渉成功の場合は「かなりお得にご入居頂けます！！」を末尾に追加してよい（誘導文がある場合は誘導文を優先）
・交渉できなかった場合は「引き続き最大限サポートさせて頂きます！！」で締める（誘導文がある場合は誘導文を優先）
${guidanceRule}`,
            };
          }
        })(),
        mgmt_parking: {
          label: "駐車場",
          format: `${mgmtGreeting}
[物件名]の駐車場について管理会社へ確認させて頂きました！！
[確認結果]${guidanceClose ? `\n${guidanceClose}` : ""}`,
          rules: `・[確認結果]はスタッフ入力情報（駐車場の有無・料金・空き状況・補足）から作成する（1〜3行）
・駐車場ありの場合:「駐車場のご用意御座います！！」から始め、料金があれば「料金は[料金]となっております！！」、空き状況があれば「空きについても確認済みで[空き状況]となっております！！」を続ける
・料金・空き状況はスタッフ入力の値をそのまま記載する（計算・変更禁止）
・空き状況が「要確認」の場合は「空き状況につきましては確認取れ次第すぐにご連絡させて頂きます！！」とする
・駐車場なしの場合:「確認させて頂いたところ[物件名]には駐車場のご用意がないとのことでした！！」と正直に伝えつつ（謝罪表現は使用禁止）、「近隣の月極駐車場もお探し出来ますのでお気軽にお申し付けください😌！！」のように前向きに締める
${guidanceRule}`,
        },
        mgmt_pet: {
          label: "ペット飼育",
          format: `${mgmtGreeting}
[物件名]のペット飼育について管理会社へ確認させて頂きました！！
[確認結果]${guidanceClose ? `\n${guidanceClose}` : ""}`,
          rules: `・[確認結果]はスタッフ入力情報（可否・条件・補足）から作成する（1〜3行）
・ペット可の場合:「ペット飼育可能なお部屋となっております😊！！」から始め、条件があれば「[条件]となっております！！」を続ける（条件はスタッフ入力の値をそのまま記載・変更禁止）
・相談可の場合:「ペット飼育につきましてはご相談可能とのことでした！！」＋条件があれば続け、「ご希望のペットの種類お教え頂けましたら管理会社へ確認させて頂きます😌！！」で締める
・不可の場合:「残念ながらペット飼育不可のお部屋となっておりました！！」と正直に伝えつつ（謝罪表現は使用禁止）、「ペット飼育可能なお部屋を改めてピックアップさせて頂きます😊！！」のように前向きに締める
${guidanceRule}`,
        },
        mgmt_equipment: {
          label: "設備",
          format: `${mgmtGreeting}
[物件名]の設備状況につきまして管理会社へ確認させて頂きました！！
[確認結果]
${guidanceClose ?? `ご不明な点がございましたらお気軽にご連絡ください😊！！`}`,
          rules: `・[確認結果]はスタッフ入力情報（エアコン・給湯器・バス・トイレ等の設備状況）から作成する（1〜3行）
・設備がある/新しい/使える場合:「[設備名]は[状態]でございます！！」のように具体的に前向きに伝える（スタッフ入力の値をそのまま記載・数値や型番の創作禁止）
・設備がない/古い場合も正直に伝えつつ（謝罪表現は使用禁止）、前向きに締める
・複数の設備がある場合は各設備を1行ずつ記載してよい
${guidanceRule}`,
        },
        mgmt_availability: {
          // 募集状況は会話文脈に合わせた自由生成（mgmtSystem側で専用プロンプトを使用。format/rulesは未使用）
          label: "募集状況",
          format: "",
          rules: "",
        },
        nearby_parking: {
          label: "近隣の月極駐車場",
          format: `${mgmtGreeting}
[物件名]の近隣の月極駐車場を確認させて頂きました！！
[確認結果]${guidanceClose ? `\n${guidanceClose}` : ""}`,
          rules: `・[確認結果]はスタッフ入力情報（駐車場名・物件からの距離・月額料金・空き状況・補足）から作成する（1〜3行）
・空きありの場合:「[駐車場名]（物件から[距離]）が空きありとなっております😊！！」から始め、月額料金があれば「月額[料金]となっております！！」を続ける
・駐車場名の入力がない場合は「近隣の月極駐車場」とする。距離・料金はスタッフ入力の値をそのまま記載する（計算・変更・創作禁止）
・空きなしの場合:「[駐車場名]を確認したところ現在空きがない状況でした！！」と正直に伝えつつ（謝罪表現は使用禁止）、「引き続き近隣の月極駐車場お探しさせて頂きます😌！！」のように前向きに締める
・空き状況が「要確認」の場合:「[駐車場名]（物件から[距離]）が見つかりました！！」＋「空き状況につきましては確認取れ次第すぐにご連絡させて頂きます！！」とする
・これは管理会社への確認ではなく近隣の月極駐車場を自分で調べた結果の報告。「管理会社に確認」という表現は使用禁止
${guidanceRule}`,
        },
        owner_other: {
          label: "オーナーに確認した（その他）",
          format: `${mgmtGreeting}
[確認内容・結果の報告]
${guidanceClose ?? `ご不明な点がございましたらお気軽にご連絡ください😊！！`}`,
          rules: `・スタッフ入力情報（確認内容・確認結果）からオーナーへの確認内容と結果を自然な文章にする（1〜3行）
・「[物件名]について」から始め、オーナーに確認した内容と結果を簡潔に報告する
・確認結果が良い内容の場合は前向きに伝える。良くない内容の場合も正直に伝えつつ（謝罪表現禁止）前向きに締める
${guidanceRule}`,
        },
      };
      const mgmtDef = MGMT_PATTERNS[String(check_pattern)];

      const mgmtCostType = body.mgmt_cost_type as string | undefined;
      const isNegotiation = mgmtCostType === "negotiation";
      const isAvailability = check_pattern === "mgmt_availability";
      const availabilityStatus = body.mgmt_availability_status as string | undefined;

      // 2026-09-17 竹内（AIX キャッシュ点検）: 旧 mgmtSystem は1本の文字列（1h）に呼び出しごとに変わる値（proxyResult・guidanceClose・
      //   availabilityStatus・mgmtDef.format/rules に埋め込まれる誘導文）が混ざり、鍵が揃わず毎回書き込みになっていた。
      //   固定の頭（役割＋共通ルール＋呼び方＝mgmtSystemHead・5m の鍵）と、それ以降（フォーマット・置き換えルール・厳守ルール＝mgmtSystemTail・動的）に分ける。
      //   "\n\n" で結合すれば従来の mgmtSystem と同じ文字列。交渉結果（isNegotiation）は全て固定文なので head に丸ごと入れ tail は空
      const mgmtSystemHead = isAvailability
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
管理会社に物件の募集状況を確認した結果をお客様に報告するLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【お客様の呼び方】必ず「[お客様名]」で呼ぶこと`
        : isNegotiation
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
管理会社への初期費用交渉結果をお客様に報告するLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【お客様の呼び方】必ず「[お客様名]」で呼ぶこと

【メッセージ構成】
①挨拶：「（時候の挨拶）」
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

【お客様の呼び方】必ず「[お客様名]」で呼ぶこと（他の呼び方・〇〇さんの置き換えし忘れ禁止）`;

      const mgmtSystemTail = isAvailability
        ? `【メッセージ構成】
①挨拶：「（時候の挨拶）」
②結果報告（この一文を軸にする・必ず入れる）：${availabilityStatus === "available" ? "「管理会社に確認しましたところ現在まだ募集しているとのことでした！！」" : "「管理会社に確認しましたところ募集が終了したとのことでした」"}
③会話の文脈に合わせた続き（1〜2行）：会話履歴からお客様の質問・希望を読み取り、それに自然につながる内容にする

【③ 続きの書き方】
${availabilityStatus === "available"
  ? `・会話履歴でお客様が内覧や申込を希望していればそれに誘導する（例:「[お客様名]お気に召されましたらご内覧・お申込みのご案内をさせて頂きます😊！！」）
・スタッフ入力に補足があればその情報を必ず反映する（例: 申込がまだ入っていない→「まだお申込みも入っていない状況ですのでお早めのご検討がおすすめです！！」）
・人気物件感を出しつつ押し付けにならないようにする`
  : `・残念な結果だが謝罪表現（「申し訳ございません」等）は使用禁止。正直に伝えつつ前向きに締める
・「ご希望の条件に合うお部屋を改めてピックアップさせて頂きます😊！！」のように次の提案につなげる
・会話履歴からお客様の希望条件が分かればそれに触れてよい`}

【物件名の特定】
会話履歴からお客様が確認依頼した物件を特定し②の文頭に「[物件名]につきまして」のように付ける（号室があれば「マンション名 806号室」形式・先頭0省略）。特定できない場合は物件名なしで②をそのまま使う

【厳守ルール】
・感嘆符は「！！」（スモラスタイル）
・絵文字は 😊 😌 のみ・1〜2個まで（他は全禁止）
・完成したLINEメッセージのみ出力（候補複数・前置きは禁止）`
        : isNegotiation
        ? ""
        : `【出力フォーマット（この構成・行数を厳守。[ ]の部分のみ置き換える）】
${mgmtDef.format}

【置き換えルール】
${check_pattern === "mgmt_proxy" ? "" : `・[物件名]は会話履歴からお客様が確認依頼した物件を特定する（号室があれば「マンション名 806号室」形式・号室の先頭0は省略: 0806→806）。特定できない場合は「ご確認頂きましたお部屋」とする
`}${mgmtDef.rules}

【厳守ルール】
・フォーマット外の挨拶・説明・解説は一切追加しない
・感嘆符は「！！」（スモラスタイル）
・絵文字は 😊 😌 のみ・1〜2個まで（他は全禁止）
・完成したLINEメッセージのみ出力（候補複数・前置きは禁止）`;

      // 学習済み差分ルール（スタッフ修正から学習したパターン）＋DBルールをプロンプト末尾に注入
      // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ
      const [mgmtDiffNote, mgmtRules] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.property_check_result, currentAction, conversationId, latestCustomerMsg, brainContext),
        fetchPromptRulesSplit("property_check_result", { check_pattern: String(check_pattern ?? "") }).catch(() => ({ global: "", action: "" })),
      ]);
      // ブロック: [global ルール 1h] → [固定の頭＋action 別ルール 5m] → [フォーマット・置き換えルール・厳守ルール（動的）→ 挨拶フレーズ]
      const mgmtSystemSpec: SystemSpecBlocks = {
        semiStatic: mgmtRules.global.replace(/^\n\n/, ""),
        routeStatic: mgmtSystemHead + mgmtRules.action,
        dynamic: mgmtSystemTail,
      };

      message_text = await callClaude(
        mgmtSystemSpec,
        isNegotiation
          ? `${name}への初期費用交渉結果報告メッセージを作成してください。

【スタッフが管理会社と交渉した内容・結果（この情報を必ず使うこと）】
${mgmtInfo}${recentHistory}` + (mgmtDiffNote ? `\n\n${mgmtDiffNote}` : "")
          : `${name}への${mgmtDef.label}確認報告メッセージを作成してください。

【スタッフが${check_pattern === "nearby_parking" ? "近隣の月極駐車場を調べた" : "管理会社に確認した"}内容（この情報を必ず使うこと）】
${mgmtInfo}${recentHistory}` + (mgmtDiffNote ? `\n\n${mgmtDiffNote}` : ""),
        currentAction,
        // 代理契約はお客様の依頼への返答＝挨拶を付けない（実送信の形。カイナ 9/16 11:48）
        check_pattern !== "mgmt_proxy" && greetingPhrase ? `【挨拶フレーズ】${greetingPhrase}\n` : undefined
      );
      // 挨拶フレーズを渡さなくても LLM が「〇〇さんお世話になっております！！」を書くので出口で落とす（本番4回とも付いた）
      if (check_pattern === "mgmt_proxy") {
        const sg = stripHeadGreeting(message_text);
        if (sg.count) {
          message_text = sg.text;
          console.log(JSON.stringify({ tag: "aix:proxy-head-greeting-stripped", conversationId }));
        }
      }
      // 号室の先頭ゼロ除去はメインパス末尾の finalize() で一括処理（⑦で共通化）

    } else if (action === "property_check_result") {
      // conversation_match: 会話に合わせた自然文生成（テンプレ固定なし・GENERATION_SYSTEM品質）
      if (body.conversation_match) {
        // M2: 同封する見積書の費用情報（割引額・クリーニング費用・初期費用総額）をOCRして確定事実化する。
        // 従来は estimate_image_urls を受け取りながら conversation_match パスで一切参照しておらず、
        // 「〇〇号室は募集中です」だけの薄い返信になっていた（見積書送付の事実すら消えていた）。
        const cmEstUrlsRaw = (body.estimate_image_urls as (string | null)[] | undefined) ?? [];
        const cmEstSingle = body.estimate_image_url as string | undefined;
        const cmEstUrls: (string | null | undefined)[] = cmEstUrlsRaw.length > 0 ? cmEstUrlsRaw : (cmEstSingle ? [cmEstSingle] : []);
        const cmHasEstimate = cmEstUrls.some((u) => !!u);
        // 会話を合わせる改善ルール（このブロック内の adaptMessageToConversation 4呼び出しで共用）
        const [adaptRulesNotePCR, cmEstimateFacts, pcrQuoted] = await Promise.all([
          getAdaptImprovementRules(currentAction),
          cmHasEstimate
            ? buildEstimateCostFacts(cmEstUrls, (property_names as string[] | undefined) ?? [], currentAction)
            : Promise.resolve({ block: "", notes: [] } as EstimateCostFacts),
          // 2026-09-15 竹内（みく事例）: お客様の引用返信の引用先（スタッフが送った物件資料の画像 → sent_properties で物件名）
          conversationId ? resolveLatestQuotedContext(conversationId) : Promise.resolve(null),
        ]);
        const pcrQuotedBlock = formatQuotedContextBlock(pcrQuoted);
        // 見積書送付の事実 + 費用メモを aix_usage_logs へ永続化させる（クライアント → log-aix-usage）
        const cmEstimateExtra = cmHasEstimate
          ? { estimate_sent: true, ...(cmEstimateFacts.notes.length > 0 ? { prop_cost_notes: cmEstimateFacts.notes } : {}) }
          : undefined;
        // base_message適応モード: 既存のAIX生成文を会話に合わせて補正
        if (baseMessage) {
          // 適応モードは原則「金額の創作禁止」だが、OCR済みの費用情報は確定事実として明示的に使用許可する
          const adaptEstNote = (cmEstimateFacts.block
            ? `\n\n【追加で使ってよい確定事実（同封する御見積書のOCR結果・創作ではありません）】\n${cmEstimateFacts.block}\n※ベースメッセージの結果・構成・アクションは変えず、上記の費用情報を1〜2文で自然に補足すること。`
            : "") + (pcrQuotedBlock ? `\n\n${pcrQuotedBlock}` : "");
          message_text = await adaptMessageToConversation(baseMessage, recentHistory, name, currentAction, adaptEstNote, adaptRulesNotePCR, aixBrainMeta);
          return finalizeResponse(message_text, cmEstimateExtra);
        }

        // バグ修正: 「会話を合わせる」は生成前（aiDraft空）に押される動線のため base_message が無く、
        // スタッフが選択した確認結果（check_pattern）がAIに一切渡らず
        // 「募集状況確認させて頂きます」等の確認前メッセージが生成されていた。
        // → 結果が確定している unavailable/exclusive は固定テンプレを内部生成して適応モードへ、
        //   それ以外は確認結果をプロンプトに必ず注入する。
        const cmPattern = String(check_pattern ?? "");
        const cmSentCount = (body.sent_property_count as number | undefined) ?? null;

        // 「物件なかった」: 固定テンプレ（通常生成と同一文面）をベースに会話適応
        // （adaptMessageToConversation のガードで確認前文への書き換えは絶対禁止済み）
        if (cmPattern === "unavailable") {
          const cmUnavailPropName = typeof property_name === "string" ? property_name.trim() : "";
          // 確定ベーステンプレ（通常生成と同一構造）: 冒頭表現以外は固定
          const cmBuild = (opening: string) =>
            `${name}お世話になっております！！\n${opening}募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！\n\n引き続き${name}のご条件に合ったお部屋をピックアップしてお送りさせて頂きます！！`;
          let cmBase: string;
          if (cmSentCount !== null) {
            cmBase = cmBuild(`お送り頂きました物件${cmSentCount}件につきまして`);
          } else if (cmUnavailPropName) {
            cmBase = cmBuild(`${cmUnavailPropName}につきまして`);
          } else {
            const cmCountM = recentHistory.match(/([2-9０-９])\s*件/);
            const cmCnt = cmCountM ? parseInt(cmCountM[1].replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xFF10))) : 1;
            cmBase = cmBuild(cmCnt >= 2 ? `お送り頂きました物件${cmCnt}件につきまして` : "お送り頂きました物件につきまして");
          }
          message_text = await adaptMessageToConversation(cmBase, recentHistory, name, currentAction, "", adaptRulesNotePCR, aixBrainMeta);
          return finalizeResponse(message_text);
        }

        // 「専任物件だった」: 固定文をベースに会話適応
        if (cmPattern === "exclusive") {
          const cmExPropName = ((body.exclusive_prop_name as string | undefined) ?? "").trim();
          const cmExRoomNo = ((body.exclusive_room_no as string | undefined) ?? "").trim();
          const cmBase = `お送りいただきました${cmExPropName}${cmExRoomNo}は専任のお部屋となっており、弊社ではご紹介ができないお部屋となります！！\n\nよろしければ私の方で${name}にオススメ出来るお部屋ピックアップさせていただきます😊！！`;
          message_text = await adaptMessageToConversation(cmBase, recentHistory, name, currentAction, "", adaptRulesNotePCR, aixBrainMeta);
          return finalizeResponse(message_text);
        }

        // 「別の部屋について確認した」: 固定文をベースに会話適応（AIX生成なし・会話を合わせる専用）
        if (cmPattern === "other_room_check") {
          const orStatus = String(other_room_status ?? "");
          if (orStatus !== "has_room" && orStatus !== "no_room") {
            throw new Error("別の部屋の有無（other_room_status）が必要です");
          }
          const orPropName = typeof property_name === "string" ? property_name.trim() : "";
          let cmBase: string;
          if (orStatus === "no_room") {
            cmBase = orPropName
              ? `${orPropName}\nこちらのお部屋が一番広いお部屋となり\n他のお部屋は募集されていない形となります！！`
              : "こちらのお部屋が一番広いお部屋となり\n他のお部屋は募集されていない形となります！！";
          } else {
            // has_room
            cmBase = orPropName
              ? `こちらが${orPropName}広い間取りのお部屋となります`
              : "こちらが広い間取りのお部屋となります";
          }
          message_text = await adaptMessageToConversation(cmBase, recentHistory, name, currentAction, "", adaptRulesNotePCR, aixBrainMeta);
          return finalizeResponse(message_text);
        }

        // 「物件あった」「別の部屋が募集してた」等: 自由生成だが確認結果を必ず注入
        const CM_RESULT_DESC: Record<string, string> = {
          available: "空室あり・入居可能（募集中）",
          alternative: "リクエストのお部屋は募集終了。ただし同じ物件で別のお部屋が募集中",
        };
        const CM_STATUS_LABEL: Record<string, string> = {
          available: "空室・募集中",
          vacating: "退去予定あり（募集中）",
          unavailable: "申込あり",
          alternative: "別のお部屋が募集中",
        };
        const cmPropNamesRaw = ((property_names as string[] | undefined) ?? []).map((s) => (s ?? "").trim());
        const cmStatuses = (prop_statuses as string[] | undefined) ?? [];
        const cmPropCount = (property_count as number | undefined) ?? 0;
        const cmVacancyDates = (property_vacancy_dates as string[] | undefined) ?? [];
        const cmFacilities = body.prop_facilities as PropFacilityData[] | undefined;
        const cmPerPropLines = cmPattern === "available" && cmPropCount > 0
          ? Array.from({ length: cmPropCount }, (_, i) => {
              // 物件名が未入力（「物件①」は画面の仮の名前）なら本文に仮の名前を書かせない（2026-09-15 みく事例）
              const rawNm = cmPropNamesRaw[i] ?? "";
              const nm = rawNm && !/^物件[①②③\d]?$/.test(rawNm) ? rawNm : `物件${i + 1}（物件名は未入力。本文に「物件${i + 1}」と書かず、引用返信・会話から分かる階・お部屋として伝える）`;
              const rawVac = (cmVacancyDates[i] ?? "").trim();
              // 過去日付・年号は落とす（通常生成パスの propList と同じ正規化）
              const vac = rawVac && !isPastVacancyDate(rawVac) ? rawVac.replace(/^\d{4}年/, "") : "";
              const facLines = cmFacilities?.[i] ? buildFacilityLines(cmFacilities[i]) : [];
              // 2026-09-17 竹内: 退去予定は「いつから見られるか」まで材料に入れる（退去日の翌日＝内覧解禁日）
              const vacView = vac ? viewableFromVacancyDate(vac) : null;
              return [
                `　- ${nm}: ${CM_STATUS_LABEL[cmStatuses[i] ?? ""] ?? "募集中"}${vac ? `（${vac}退去予定${vacView ? ` → ${vacView}以降ご内覧可能` : ""}）` : ""}`,
                ...facLines.map((l) => `　　・${l}`),
              ].join("\n");
            }).join("\n")
          : "";
        const cmSinglePropName = typeof property_name === "string" && property_name.trim() ? property_name.trim() : "";
        const cmEndedFloor = body.ended_floor as number | undefined;
        const cmEndedUnit = ((body.ended_unit as string | undefined) ?? "").trim();
        // 送られた件数 − 確認できた件数 = 募集終了件数。
        // これを渡さないと AI が「残り3件は引き続き確認中です」と事実に反する保留文を作ってしまう
        const cmEndedCount = cmSentCount !== null && cmPropCount > 0 && cmSentCount > cmPropCount
          ? cmSentCount - cmPropCount
          : 0;
        const cmAvailableApp = body.available_application as "yes" | "no" | undefined;
        const cmShowViewingInvite = !!(show_viewing_invite as boolean | undefined);
        const cmShowAppInvite = !!(body.check_application_invite as boolean | undefined);
        // 2026-09-16 竹内（カイナ事例）「会話の内容と合わせた実際に送ったような内容（内覧の話しだったので内覧）で送る」:
        //   内覧の流れ（こちらが日時を提案して返事待ち／お客様が見たいと言っている）を会話から決定論で判定し、締めを内覧の続きに縛る。
        //   画面の3択（流れを続ける／日程を出す／なし）が来ていればスタッフの入力が正（旧画面は null＝会話の判定）。
        //   新しい日程（内覧誘導あり）・申込誘導をスタッフが指定した時はそちらが正。判定は viewing-thread.ts（画面も同じ関数で初期値を出す）
        const vt = resolveViewingThread(
          recentMsgsForHistory.map((m) => ({ sender: m.sender, text: m.text, rawCreatedAt: (m as { rawCreatedAt?: string }).rawCreatedAt })),
          { nowMs: Date.now() },
        );
        const cmViewingContinueBody = typeof body.viewing_continuation === "boolean" ? (body.viewing_continuation as boolean) : null;
        const cmContinuationActive = (cmViewingContinueBody ?? vt.pending) && !cmShowViewingInvite && !cmShowAppInvite;
        const cmStaffForcedContinue = cmViewingContinueBody === true && !vt.pending;
        // 今回募集中と伝える部屋数（スタッフの入力＝正。資料の枚数から部屋数は推定しない・枚数は「資料N枚」の事実にだけ使う）
        const cmRooms = resolveEnclosedRooms({
          propertyCount: (property_count as number | undefined) ?? 0,
          roomCounts: Array.isArray(body.prop_room_counts) ? (body.prop_room_counts as (number | null)[]) : null,
          imageCount: Array.isArray(image_urls) ? (image_urls as string[]).length : (image_url ? 1 : 0),
          staffNote: typeof body.staff_note === "string" ? body.staff_note : "",
        });
        // 2026-09-15 竹内（みく事例）: スタッフだけが知っている事実（「同じ間取りのお部屋は301号室と101号室のみ」等）を補足で受け取り、そのまま使う
        const cmStaffNote = typeof body.staff_note === "string" ? body.staff_note.trim().slice(0, 600) : "";
        const cmResultLines = [
          `・確認結果: ${CM_RESULT_DESC[cmPattern] ?? "会話履歴から読み取ること"}`,
          cmSinglePropName ? `・対象物件名: ${cmSinglePropName}` : "",
          cmStaffNote ? `・スタッフからの補足（確定事実・必ず本文に入れる）: ${cmStaffNote}` : "",
          // 2026-09-15 みく事例: 御見積書を同封しているのに本文に書かれないことがあった（読み取りが間に合わない時も同封の事実は伝える）
          cmHasEstimate
            ? "・御見積書: この返信と一緒に同封する →「初期費用の御見積書同封させて頂きました！！」を必ず入れる（金額は【御見積書】の読み取り結果がある時だけ）"
            : "・御見積書: この返信には同封しない → 御見積書の作成・送付の約束（「作成しお送りさせて頂きます」「お見積書とあわせてご連絡」）は書かない（御見積書は別の AIX）",
          cmPerPropLines ? `・確認できた物件と状態:\n${cmPerPropLines}` : "",
          ...buildEnclosedCountLines(cmRooms),
          cmPattern === "alternative" && cmEndedFloor != null ? `・募集終了だったお部屋: ${cmEndedFloor}階${cmEndedUnit ? `${cmEndedUnit}号室` : ""}` : "",
          cmSentCount !== null ? `・お客様から送られた物件数: ${cmSentCount}件` : "",
          cmEndedCount > 0
            ? `・残り${cmEndedCount}件: 確認済みで「募集終了」（申込済み・募集に出ていない）。\n　※「残り${cmEndedCount}件は確認中」「引き続き確認します」等の保留表現は事実に反するため絶対禁止。募集終了として伝え「引き続き条件に合うお部屋を探させて頂きます！！」で締めること`
            : "",
          cmAvailableApp === "yes" ? "・お申込状況: 既に1番手のお申込あり → 2番手以降でのお申込となる旨を伝えること" : "",
          cmShowAppInvite ? "・締めの方向: お申込誘導（お気に召されましたらお申込みしお部屋を抑えさせて頂きます）" : "",
          !cmShowAppInvite && cmShowViewingInvite ? "・締めの方向: 内覧誘導（ご都合よろしいお日にちにご案内させて頂きます）" : "",
          cmContinuationActive ? `・締めの方向: 内覧の続き（既に内覧の話が進んでいる → 「${VIEWING_CONTINUATION_LINE}」の1文。新しい日時は出さない）` : "",
        ].filter(Boolean).join("\n");
        // 2026-09-17 竹内（AIX 物件確認した）: 退去予定のお部屋の伝え方を材料として渡す
        //   （状態は「現在退去予定で募集中」／退去日の翌日以降ご内覧可能／費用のマイナスの説明は入れない）
        const cmVacatingNote = buildVacatingPromptNote(
          Array.from({ length: cmPropCount }, (_, i) => ({
            name: cmPropNamesRaw[i] ?? "",
            vacDate: (cmStatuses[i] === "vacating" || (cmVacancyDates[i] ?? "").trim())
              ? ((cmVacancyDates[i] ?? "").trim() && !isPastVacancyDate((cmVacancyDates[i] ?? "").trim()) ? (cmVacancyDates[i] ?? "").trim() : "")
              : "",
          })),
        );
        const cmResultBlock = cmPattern
          ? `【スタッフの確認結果（確定事実・必ずこの結果を報告するメッセージにすること）】
${cmResultLines}
・スタッフは既に募集状況の確認を完了しています。上記の結果を報告するメッセージを作成してください
・「確認させて頂きます」「確認いたします」等の確認前メッセージの生成は絶対禁止（確認は完了済み）
・確認できた物件については「募集中です」で終わらせず、上記の状態・設備・費用情報まで伝えて次のアクション（内覧/申込）に繋げること${cmVacatingNote ? `\n\n${cmVacatingNote}` : ""}`
          : "";

        const calendarNoteForPCR = calendar_info ? String(calendar_info) : "";
        const pcrCalendarBlock = calendarNoteForPCR
          ? `【内覧可能日時（カレンダー自動取得・空室時はこの日程で案内すること）】\n${calendarNoteForPCR}`
          : "";
        const [pcrDiffNote, pcrStarNote, pcrRules, brainAddendumPcrConv] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.property_check_result, currentAction, conversationId, latestCustomerMsg, brainContext),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.property_check_result, latestCustomerMsg, aixBrainMeta),
          // 実際に選択された check_pattern を渡す（旧: "availability" ハードコードで unavailable 等のDBルールが引けていなかった）
          // 2026-09-16 カイナ事例: 会話を合わせる経路には、通常返信用の「物件画像→見積書作成宣言・内覧案内を混ぜるな」（PROP-URL-REPLY-001・
          //   FEEDBACK-d6f30f25）と構成を足す DIFF-POLICY-* を渡さない（固定の型の AIX 生成側には残す）
          // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ（旧: 動的接尾で毎回割引なし）。
          //   exclude の PROP-URL-REPLY-001 は global 側の行なので、この経路の global は他の AIX より1行短く準静的ブロックの鍵が別になる。
          //   この経路は AIX で最も呼び出しが多く 1h の鍵は自分で温まるので、別鍵を許容する（除外を外して文面を変えるより安全）
          fetchPromptRulesSplit("property_check_result", { check_pattern: cmPattern || "availability" }, { exclude: { keyPrefixes: ["DIFF-POLICY-"], keys: ["PROP-URL-REPLY-001", "FEEDBACK-d6f30f25"] } }).catch(() => ({ global: "", action: "" })),
          loadBrainTemplate("property_check_result"),
        ]);

        // 2026-09-15 竹内（みく事例）: スタッフの入力（確認結果・物件情報・同封する御見積書・補足）が正。ブレインの AIX-META は参考に下げる。
        //   旧: AIX-META を「必ず守る」で入れ、ブレインが物件を取り違えた key_topics（「駒川中野物件の空室確認結果報告」）・
        //   会話全体の成約戦略（「リアライズ長居公園通313号室への反応を待ちつつ…」を返信末尾で WE DO 宣言）・
        //   avoid_topics（「見積書」「初期費用」＝スタッフが御見積書を同封しているのに禁止）が、確認結果より強く効き、
        //   別の物件（313号室）の「募集状況確認させて頂きます」という確認前の文になった（穴:G6 古い判断の注入）
        const pcrWaitStance = aixBrainMeta?.engagement_stance === "wait";
        // スタッフが入れた事柄（御見積書の同封・内覧誘導・申込誘導）と食い違う禁止の話題は外す（aix-staff-first）
        const pcrAvoidTopics = avoidTopicsForAix("property_check_result", aixBrainMeta?.avoid_topics, {
          estimateEnclosed: cmHasEstimate, viewingInvite: cmShowViewingInvite || cmContinuationActive, applicationInvite: cmShowAppInvite || cmAvailableApp === "yes",
        });
        const pcrKeyTopics = (aixBrainMeta?.key_topics ?? []).filter((t): t is string => typeof t === "string" && t.trim() !== "");
        const pcrMetaLines = [
          pcrWaitStance
            ? "- ⏸️ 押し引きスタンス: WAIT（待ちの局面）— 強推し直後の了承、またはネガ文脈（断り・キャンセル・否決・募集終了）の直後です。内覧日程の提示・希少性訴求（「一番手確保」「お早めに」「今なら」等）・新規物件の提案は入れない。ただしスタッフが【スタッフの確認結果】で締めの方向（お申込誘導／内覧誘導）や補足を指定している時はスタッフの指定に従う"
            : "",
          aixBrainMeta?.recommended_tone
            ? `- 推奨トーン: ${aixBrainMeta.recommended_tone}${RECOMMENDED_TONE_GUIDE[aixBrainMeta.recommended_tone] ? `（${RECOMMENDED_TONE_GUIDE[aixBrainMeta.recommended_tone]}）` : ""}`
            : "",
          pcrKeyTopics.length > 0
            ? `- 参考: ブレインが見た話題: ${pcrKeyTopics.join(" / ")}（物件名・話題が【スタッフの確認結果】【引用返信】と食い違う時は使わない）`
            : "",
          pcrAvoidTopics.length > 0
            ? `- 避ける話題: ${pcrAvoidTopics.join(" / ")}`
            : "",
        ].filter(Boolean);
        const brainMetaBlockPCR = pcrMetaLines.length > 0
          ? `\n【AIX-META（ブレインの判断・参考。スタッフの確認結果・物件情報・御見積書・補足と食い違う時はスタッフの入力が正）】\n${pcrMetaLines.join("\n")}\n`
          : "";

        // キャッシュ最適化: 静的（GENERATION_SYSTEM/共通ルール/固定指示）と
        // 動的（確認結果・見積OCR・カレンダー・META・ブレイン）を分離し、静的側だけをキャッシュ対象のブロックに置く
        // （2026-09-17 AIX キャッシュ点検: DB ルールは動的から準静的／経路固有ブロックへ移した。下の pcrSystemSpec）
        const pcrStaticSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】ユーザーメッセージに記載のお客様名を使うこと

【この返信の目的】
・お客様からリクエストされた物件の確認結果を伝える
・空室あり → 締めは【スタッフの確認結果】の「締めの方向」に従う（無ければ結果報告で締める。日程・御見積書を勝手に足さない）
・満室/募集終了 → 正直に伝えつつ「引き続き探します！！」で前向きに締める
・謝罪表現（「申し訳ございません」等）は使わない。「残念ながら」で自然に伝える
・見積書を同封する場合は「御見積書同封させて頂きました！！」と費用の実情（割引の大小・クリーニング費用・初期費用の高低）まで伝えてから内覧/申込に繋げる
・見積書を同封しない時は御見積書の作成・送付の約束を書かない（御見積書は別の AIX で送る）

【重要：会話読解ルール（必ず守ること）】
・お客様の直近メッセージから「どの物件・号室」の確認を求めているか読み取る（【引用返信】があればそれが最優先の手がかり）
・物件名・号室が会話に登場する場合は必ず含める（創作禁止）
・テンプレ的な返信は絶対禁止。会話に直接応答する文から始める
・お客様が具体的に聞いたこと（「3階は空きありますか？」等）には最初の1文で答える（例:「3階部分のお部屋募集しております！！」）
・情報の優先順位: ①【スタッフの確認結果】（物件情報・補足）と同封する御見積書 ②【引用返信】とお客様の直近の発言 ③【AIX-META】（参考）。食い違う時は上を正とする

【スタッフの実際の返信の例（2026-09-15 みく: 2階が募集終了で1階を送った後「こちら3階は空きありますか？」→ 3階が募集中・同じ間取りは残りわずか）】
3階部分のお部屋募集しております！！
初期費用の御見積書同封させて頂きました！！
こちらの間取りのお部屋（29.62㎡）は現在
301号室と101号室のみとなりますので
お気に召されましたらお申込しお部屋抑えさせて頂きます！！
お手隙の際にご査収ください😌！！
（※中身は別のお客様の話。広さ・号室・残りの部屋数はスタッフの補足・物件情報にある時だけ書く）

【絶対禁止】
・🙏 絵文字は絶対に使わない
・「申し訳ございません」等の謝罪表現
・物件名の創作
・スタッフの確認結果があるのに「確認させて頂きます」「確認出来次第ご連絡」等の確認前メッセージを生成すること
・上記の見積書情報に無い金額・費用項目を創作すること
・確認済みの物件を「確認中」「引き続き確認します」と保留扱いにすること

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;

        // 動的（顧客・案件ごとに変わる）ブロック。キャッシュ対象外
        const pcrDynamicSuffix = [
          pcrQuotedBlock,
          cmResultBlock,
          buildViewingThreadBlock(vt, { customerName: name, estimateEnclosed: cmHasEstimate, active: cmContinuationActive, staffForced: cmStaffForcedContinue }),
          cmEstimateFacts.block,
          pcrCalendarBlock,
          brainMetaBlockPCR,
          brainAddendumPcrConv ? `【ブレイン改善ルール】\n${brainAddendumPcrConv}` : "",
        ].filter(Boolean).join("\n\n");
        // ブロック: [shared 1h] → [global ルール（exclude 済み）1h] → [固有文＋action 別ルール 5m] → [動的]。作り直しも同じ構成（2回目は read）
        const pcrShared = splitSharedPrefix(pcrStaticSystem);
        const pcrSystemSpec: SystemSpecBlocks = {
          shared: pcrShared.shared,
          semiStatic: pcrRules.global.replace(/^\n\n/, ""),
          routeStatic: pcrShared.routeStatic + pcrRules.action,
          dynamic: pcrDynamicSuffix,
        };

        const pcrConvUserFinal = greetingTimeNote + `${recentHistory}\n\n上記の会話を深く読み取り、${name}への物件確認結果の返信を生成してください。` + (pcrDiffNote ? `\n\n${pcrDiffNote}` : "") + (pcrStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + pcrStarNote : "");
        const parsePCR = (raw: string): string => {
          try {
            const mPCR = raw.match(/\{[\s\S]*\}/);
            if (mPCR) return ((JSON.parse(mPCR[0]) as { message?: string }).message || raw).replace(/\\n/g, "\n");
          } catch { /* JSON で無ければ本文そのもの */ }
          return raw;
        };
        const rawPCR = await callClaude(
          pcrSystemSpec,
          pcrConvUserFinal,
          currentAction
        );
        message_text = parsePCR(rawPCR);
        // 2026-09-15 竹内（みく事例）: スタッフの入力が本文に入っているかを決定論で確かめ、足りなければ1回だけ作り直す。
        //   YUMA での再現（同じ入力で4回）: 3階の募集中は毎回出たが、同封する御見積書・補足（301号室と101号室のみ）のどちらかが落ちる回があった。
        //   ①確認前の文（「募集状況確認させて頂きます」「確認出来次第ご連絡」）②御見積書を同封するのに触れていない ③補足の数字（号室・㎡）が無い
        const PCR_PROMISE_RE = /確認(?:させて(?:頂|いただ)き|いたし|致し)ます|確認(?:出来|でき)次第|確認中/;
        const noteNumbers: string[] = [...new Set<string>(cmStaffNote.normalize("NFKC").match(/\d+(?:\.\d+)?/g) ?? [])];
        const pcrMissing = (text: string): string[] => {
          const t = text.normalize("NFKC");
          const out: string[] = [];
          if ((cmPattern === "available" || cmPattern === "alternative") && PCR_PROMISE_RE.test(text)) out.push("確認前の文（「確認させて頂きます」「確認出来次第」）になっている → 確認結果を報告する文にする");
          // 同封する（済み）ので「作成しお送りさせて頂きます」（これからの約束）は不可。「同封させて頂きました」「お送りさせて頂きました」
          if (cmHasEstimate && !/見積[^。！!\n]{0,16}(?:同封|添付|お送りさせて(?:頂|いただ)きました|お送りいたしました)/.test(text)) out.push("御見積書を同封するのに「同封させて頂きました」と書いていない（「作成しお送りさせて頂きます」は未来の約束で不可）→「初期費用の御見積書同封させて頂きました！！」を入れる");
          const lostNums = noteNumbers.filter((n) => !t.includes(n));
          if (cmStaffNote && lostNums.length > 0) out.push(`スタッフの補足（${cmStaffNote}）の内容が入っていない（${lostNums.join("・")}）→ 補足の内容を本文に入れる`);
          // 2026-09-16 カイナ事例: 御見積書なしの約束・内覧の続きなのに新しい日時
          if (!cmHasEstimate && ESTIMATE_PROMISE_LINE_RE.test(t)) out.push("御見積書を同封しないのに作成・送付を約束している → その行を無くし、締めは内覧の続き／結果報告にする");
          if (cmContinuationActive && NEW_SLOT_LINE_RE.test(t)) out.push(`新しい内覧日時を書いている → 日時は書かず「${VIEWING_CONTINUATION_LINE}」の1文にする`);
          return out;
        };
        let pcrNotice: string | undefined;
        const firstMissing = pcrMissing(message_text);
        if (firstMissing.length > 0) {
          console.warn(JSON.stringify({ tag: "aix:pcr-retry", conversationId, missing: firstMissing, text: message_text.slice(0, 120) }));
          const retryRaw = await callClaude(
            pcrSystemSpec,
            `${pcrConvUserFinal}\n\n【作り直し】前の案:「${message_text.replace(/\n/g, " ").slice(0, 200)}」\n足りない・違う点:\n${firstMissing.map((m) => `・${m}`).join("\n")}\n前の案の良い所（お客様の質問への答え・構成）は保ったまま直してください。`,
            currentAction,
          );
          message_text = parsePCR(retryRaw);
          const stillMissing = pcrMissing(message_text);
          if (stillMissing.length > 0) pcrNotice = `確認してから送信してください: ${stillMissing.map((m) => m.split(" → ")[0]).join("／")}`;
        }
        // 2026-09-16 竹内（カイナ事例）: 出口の決定論（指示だけでは落ちる＝設計知見 404389ab）。この順で通す:
        //   ①御見積書なしなら約束の行を落とす ②内覧の続きなら新しい日時の行を落とす ③続きの1文が無ければ足す ④部屋数が無ければ「こちらのN部屋」
        const exitLog: Record<string, unknown> = {};
        if (!cmHasEstimate) { const r = stripEstimatePromiseLines(message_text, { estimateEnclosed: false }); if (r.removed.length) { message_text = r.text; exitLog.removedEstimate = r.removed; } }
        if (cmContinuationActive) { const r = stripNewSlotLines(message_text); if (r.removed.length) { message_text = r.text; exitLog.removedSlots = r.removed; } }
        { const r = ensureViewingContinuationLine(message_text, cmContinuationActive); if (r.added) { message_text = r.text; exitLog.added = r.added; } }
        { const r = ensureRoomCountPhrase(message_text, cmRooms.rooms); if (r.fixed) { message_text = r.text; exitLog.roomFixed = true; } }
        message_text = message_text.replace(/\n{3,}/g, "\n\n").trim();
        // 御見積書の約束を落とした後に「お手隙の際にご査収ください」だけが締めで残る（資料は同封しているので可）。続きの1文がその前に入る
        console.log(JSON.stringify({ tag: "aix:pcr-viewing-thread", conversationId, kind: vt.kind, reason: vt.reason, slots: vt.slots, active: cmContinuationActive, fromBody: cmViewingContinueBody, rooms: cmRooms, ...exitLog }));
        Object.assign(conditionsSnapshot, { viewing_thread: { kind: vt.kind, reason: vt.reason, slots: vt.slots, active: cmContinuationActive, from_body: cmViewingContinueBody }, rooms: cmRooms, exit: exitLog });
        // ⑦修正: conversation_match 早期returnでも共通後処理（号室ゼロ除去・内部メモ分離）を通す
        return finalizeResponse(message_text, { ...(cmEstimateExtra ?? {}), ...(pcrNotice ? { notice: pcrNotice } : {}) });
      }

      // 「別の部屋について確認した」は会話を合わせる（conversation_match）専用（通常AIX生成は未対応）
      if (check_pattern === "other_room_check") {
        throw new Error("「別の部屋について確認した」は会話を合わせる専用です");
      }

      const pattern = check_pattern as "available" | "alternative" | "unavailable" | "exclusive";

      // 「専任物件だった」は固定文専用フロー（AI不要・DB取得もスキップ）
      // ※ name は「◯◯さん」形式（さん付き）のため、テンプレは ${name}に とする
      if (pattern === "exclusive") {
        const exPropName = ((body.exclusive_prop_name as string | undefined) ?? "").trim();
        const exRoomNo = ((body.exclusive_room_no as string | undefined) ?? "").trim();
        const propText = `${exPropName}${exRoomNo}`;
        message_text = `お送りいただきました${propText}は専任のお部屋となっており、弊社ではご紹介ができないお部屋となります！！\n\nよろしければ私の方で${name}にオススメ出来るお部屋ピックアップさせていただきます😊！！`;
        // aix_generate_log 記録（finalizeResponse を経由しない早期returnパス）
        // C-2: fire-and-forget（.then）だとレスポンス返却後にサーバレス実行が凍結されて
        // INSERT が失われることがあるため、finalizeResponse と同じ after() パターンに統一
        if (conversationId) {
          const exclusiveText = message_text;
          after(async () => {
            try {
              await supabase.from("aix_generate_log").insert({
                action_type: currentAction,
                conversation_id: conversationId,
                check_pattern: generateLogCheckPattern,
                generated_text: safeSlice(exclusiveText, 2000),
                conditions_snapshot: conditionsSnapshot,
              });
            } catch (e) {
              console.error("[aix/action] aix_generate_log insert failed (exclusive):", e);
            }
          });
        }
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
スモラ:「${greetingPhrase ? `${greetingPhrase}\n` : ""}〇〇（物件名）空室確認取れました😊！！
ぜひご内覧させていただきたいのですが
直近ですと
6/15（月）15:00〜17:00
6/16（火）12:00〜14:00
ご案内可能です！！
〇〇さんご都合いかがでしょうか😌！！」`,
        alternative: `[パターン例: 満室・代替案あり]
スモラ:「${greetingPhrase ? `${greetingPhrase}\n` : ""}確認させていただきました物件のお部屋残念ながら全て募集が終了しておりました🙇‍♀️！！
ただAPRILE南森町は一回り広い33.62㎡のお部屋が募集中です！！
こちらのお部屋〇〇さんお気に召されましたらご案内させていただきます！！
ご都合いかがでしょうか😊！！」`,
        unavailable: `[パターン例: 満室・空きなし]
スモラ:「〇〇さんお世話になっております！！
お送り頂きました物件につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！

引き続き〇〇さんのご条件に合ったお部屋をピックアップしてお送りさせて頂きます！！」`,
      };

      const calendarNote = (pattern === "available" && calendar_info) ? String(calendar_info) : null;

      const PATTERN_INSTRUCTION: Record<string, string> = {
        available: calendarNote
          ? `物件を確認した結果「空室あり・入居可能」でした。空室報告をしたあと、提供された内覧可能日時を以下フォーマットで含めてください：
「直近ですと
M/D（曜日）HH:MM〜HH:MM
M/D（曜日）HH:MM〜HH:MM
ご案内可能です！！」
案内不可の日は除外。締めは「ご都合いかがでしょうか😌！！」`
          : "物件を確認した結果「空室あり・入居可能」でした。空室報告をして、内覧日程の調整へ自然に誘導してください。",
        alternative: floor_plan_match === "same"
          ? `以下の構成・文体で一字一句この通りに作成してください（[物件名]部分のみ会話履歴から特定して置き換える）：
「${greetingPhrase ? `${greetingPhrase}\n\n` : ""}お送り頂きました[物件名]${endedRoomStr}ですが確認しましたところ募集終了しておりました！！

別の階数となりますが、同じ間取りで
[物件名]で現在募集中のお部屋御座いましたので、最大限割引しました御見積書と併せてお送りさせて頂きました！！
お手隙の際にご査収ください！！」`
          : `物件を確認した結果「${endedRoomStr}は募集終了でしたが別の間取りのお部屋が募集中」でした。「残念ながら」等で正直に伝えつつ（「申し訳ございません」等の謝罪表現は使用禁止）、代替案への期待感を持たせて内覧誘導で締めてください。募集終了だったお部屋は${endedRoomStr}です。`,
        unavailable: `物件を確認した結果「満室・空きなし」でした。以下の確定テンプレの構成・文体を一字一句守って作成してください（〇〇はお客様名。冒頭の「お送り頂きました物件につきまして」の部分のみ状況に応じて置き換え可：お客様がURL等で物件を送ってきた場合はそのまま、物件名が分かる場合は「[物件名]につきまして」）：
「〇〇さんお世話になっております！！
お送り頂きました物件につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！

引き続き〇〇さんのご条件に合ったお部屋をピックアップしてお送りさせて頂きます！！」`,
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
          .eq("hypothesis_status", "confirmed") // 改善⑧: 他のknowledge取得（L189/199/268/278/321）と同じconfirmedゲートに統一。confirmed済みナレッジのみ注入
          .order("importance", { ascending: false })
          .order("id", { ascending: true })
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

【お客様の呼び方】必ず「[お客様名]」で呼ぶこと（他の呼び方・〇〇さんの置き換えし忘れ禁止）

【作成ルール】
・冒頭は【挨拶の時間ルール】の挨拶フレーズで始める（当日送信済みで挨拶フレーズが無い場合は挨拶行なしで結果報告から始める）。「お待たせいたしました」「お待たせ致しました」は禁止語
・画像（物件資料）が添付されている場合は物件名・間取りなどを読み取って言及する
・会話履歴がある場合はその流れを踏まえた自然な報告文にする
・感嘆符は「！！」（スモラスタイル）
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字：😊 😌 🙇‍♀️ 🌟 ✨ のみ（他は全禁止）
▼ 絵文字は1〜2個まで`;
      // 2026-09-17 竹内（AIX キャッシュ点検）: お手本（greetingPhrase 入り＝呼び出しごとに変わる）と DB 由来の実例・ノウハウは
      //   経路固有ブロック（5m の鍵）から出して動的ブロックへ。"\n\n" で結合すれば従来の checkSystem と同じ文字列
      const checkSystemTail = `【このパターンのお手本（スモラ実データ由来・文体・構成をこれに合わせる）】
${patternExample}${knowledgeText}${examplesText}`;

      const available_application = body.available_application as "yes" | "no" | undefined;
      const propNames = (property_names as string[] | undefined) ?? [];
      const propVacancyDates = (property_vacancy_dates as string[] | undefined) ?? [];
      const propCount = (property_count as number | undefined) ?? 1;

      const propStatusesArr = prop_statuses as string[] | undefined;

      // 送られた物件数（任意・AixModalの「送られた物件数」セレクター）
      // 募集終了件数 N = 送られた物件数 − 確認できた物件数
      const sentPropCount = (body.sent_property_count as number | undefined) ?? null;
      const endedPropCount = sentPropCount !== null && sentPropCount > propCount ? sentPropCount - propCount : 0;
      // ケース2（一部のみ募集あり）: 末尾に「他N件は募集終了」の案内を追加
      const endedSection = endedPropCount > 0
        ? `\n\n${name}お送りいただきました他${endedPropCount}件は\n募集終了しているお部屋となります。\n引き続き条件に合うお部屋を探させていただきます！！`
        : "";

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
        // estimate_image_urls は物件indexと対応した配列（見積書が無い物件は null）。some() で判定する
        const hasAnyEstimate = ((body.estimate_image_urls as (string | null)[] | undefined) ?? []).some((u) => !!u) || !!(estimate_image_url as string | undefined);
        if (hasAnyEstimate) estimate_sent_result = true;

        if (propCount === 1) {
          // 1件モード: 物件名があれば直接テンプレ生成（④ 改善）
          const p = propList[0];
          const propFacilitiesData = body.prop_facilities as PropFacilityData[] | undefined;
          const facilityText = propFacilitiesData?.[0] ? buildFacilityLines(propFacilitiesData[0]).map(l => `・${l}`).join("\n") : "";
          const pName = p.name;
          const estimate1 = hasAnyEstimate ? "\n最大限割引しました御見積書同封させて頂きました！！" : "";
          // 2026-09-17 竹内（YUYA 事例）: 画面の「見積書の下」に入れた保証会社名から説明を1行足す（実送信も御見積書の直後）。
          //   文は種類ごとにスタッフの実送信そのまま（app/lib/guarantor-companies.ts）。入力が無ければ空＝何も足さない
          const guarantorNote1 = buildGuarantorCheckNote([guarantorPropertyOf(p.name, propFacilitiesData?.[0])].filter((x): x is GuarantorProperty => !!x));
          const guarantorSection1 = guarantorNote1 ? `\n\n${guarantorNote1}` : "";
          const showVI1 = !!(show_viewing_invite as boolean | undefined);
          const showAppInvite1 = !!(body.check_application_invite as boolean | undefined);
          const greeting1 = greetingPhrase; // 挨拶時間ルール共通化（#19）
          // 保証会社はその物件の情報の一部なので、設備の箇条書きまで出し切った直後・締め（内覧/申込の誘導・他N件募集終了）の前に置く
          if (p.status === "vacating") {
            // 2026-09-17 竹内: 退去予定は「いつから見られるか」まで書く（退去日の翌日＝内覧解禁日・実送信51件の言い回し）
            const vacLine = (p.vacDate ? vacatingViewableSentence(p.vacDate) : null)
              ?? (p.vacDate ? `${p.vacDate}退去予定のお部屋となります！！` : "退去予定のお部屋となります！！");
            const facSection = facilityText ? `\n\n${facilityText}` : "";
            message_text = `${pName}現在募集中となります！！\n${vacLine}${estimate1}${facSection}${guarantorSection1}\n\nお気に召されましたらお申込みしお部屋を抑えさせていただきます！！`;
          } else if (showAppInvite1) {
            const estimateApp = hasAnyEstimate ? "\n\n🌟最大限割引しました初期費用の御見積書同封させて頂きました！" : "";
            const facSection = facilityText ? `\n\n${facilityText}` : "";
            message_text = `${pName}募集中となります！！\n現在1番手でお申込みが入っている為、2番手以降でのお申込となります！！${estimateApp}${facSection}${guarantorSection1}\n\n※2番手お申込の場合1番手の方が審査否決となった場合1番手に繰り上がります。`;
          } else {
            const inviteText = showVI1 ? `\n\n${name}ご都合よろしいお日にちにご案内させて頂きます😊！！` : "";
            const facSection = facilityText ? `\n\n${facilityText}` : "";
            message_text = `${pName}現在募集中となります！！${estimate1}${facSection}${guarantorSection1}${inviteText}`;
          }
          // greeting1 を先頭に連結（1件モードで挨拶が抜けていたバグ修正）
          // 送られた物件数指定時: ケース1=「確認させていただきました」/ ケース2=「物件の中で」ヘッダー + 他N件募集終了
          const sentHeader1 = sentPropCount === null
            ? ""
            : endedPropCount > 0
              ? `${name}お送りいただきました物件の中で\n`
              : `${name}確認させていただきました！！\n`;
          message_text = `${greeting1 ? `${greeting1}\n` : ""}${sentHeader1}${message_text}${endedSection}`; // G32: 当日送信済みは挨拶行なし
        } else {
          // 複数物件モード: per-property ステータスで箇条書き + クロージング
          const recommendIdx = (body.recommend_prop_index as number | undefined) ?? -1;
          const propFacilitiesData = body.prop_facilities as PropFacilityData[] | undefined;
          const bulletLines = propList.map((p, pi) => {
            const n = p.name || `物件${fallbackNames[pi] ?? ""}`;
            const prefix = pi === recommendIdx ? "🌟" : "・";
            let line: string;
            if (p.status === "vacating") line = p.vacDate ? `${prefix}${n}　※ ${p.vacDate}退去予定` : `${prefix}${n}`;
            else if (p.status === "unavailable") line = `${prefix}${n}　※ 申込あり`;
            else if (p.status === "alternative") line = `${prefix}${n}　※ 別のお部屋が募集中`;
            else line = `${prefix}${n}`;
            const fac = propFacilitiesData?.[pi];
            if (fac) {
              const facLines = buildFacilityLines(fac);
              if (facLines.length > 0) line += "\n" + facLines.map(l => `   ・${l}`).join("\n");
            }
            return line;
          }).join("\n");
          const recommendNote = recommendIdx >= 0 && recommendIdx < propList.length
            ? `\n\n特に🌟の${propList[recommendIdx].name || fallbackNames[recommendIdx] || "こちら"}が${name}に特にオススメです！！`
            : "";
          // 2026-09-17 竹内（YUYA 事例）: 保証会社の説明（御見積書の直後）。全部同じ会社なら「こちら2部屋とも〜」、
          //   分かれていれば物件名を頭に付けて会社ごとに1行（app/lib/guarantor-companies.ts・入力が無ければ空）
          const guarantorNoteMulti = buildGuarantorCheckNote(
            propList.map((p, pi) => guarantorPropertyOf(p.name || fallbackNames[pi] || "", propFacilitiesData?.[pi])).filter((x): x is GuarantorProperty => !!x)
          );
          const guarantorSectionMulti = guarantorNoteMulti ? `\n\n${guarantorNoteMulti}` : "";
          // 竹内「保証会社の説明の位置の場所は物件毎なので、位置を上にあげる」: 実送信は例外なく
          //   「御見積書同封させて頂きました。→ 保証会社 → お手隙の際にご査収ください！！」の順（9/10・7/21・7/17・7/14 ほか）。
          //   締めの「お手隙の際にご査収ください！！」を保証会社の後ろに回す（保証会社が無ければ従来と同じ2行）
          const estimateSection = hasAnyEstimate
            ? `\n最大限割引しました初期費用御見積書同封させて頂きました。${guarantorSectionMulti}${guarantorSectionMulti ? "\n\n" : "\n"}お手隙の際にご査収ください！！`
            : guarantorSectionMulti;
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
          const header = (all_properties_available as boolean | undefined) && endedPropCount === 0
            ? `${name}お送り頂きました\n`
            : `${name}お送り頂きました物件の中で\n`;
          // 保証会社は estimateSection の中（御見積書の行の直後・お手隙の前）に入っているのでここでは足さない
          message_text = `${greeting ? `${greeting}\n` : ""}${header}${bulletLines}\nこちら${propCount}件現在募集中となります！！${recommendNote}${estimateSection}${vacancySection}${endedSection}`; // G32: 当日送信済みは挨拶行なし
        }

      // 「物件あった」申込あり・申込なし・未選択 は固定テンプレ（1件）
      } else if (pattern === "available") {
        const estimateLine = estimate_image_url ? "\n最大限割引しました御見積書同封させて頂きました！！" : "";
        if (estimate_image_url) estimate_sent_result = true;
        const availableTemplate = available_application === "yes"
          ? `[物件名と号室]募集中となります！！
現在1番手でお申込みが入っている為、2番手以降でのお申込となります！！${estimateLine}

※2番手お申込の場合1番手の方が審査否決となった場合1番手に繰り上がります。${endedSection}`
          : `[物件名と号室]現在募集中となります！！${estimateLine}

${name}ご都合よろしいお日にちにご案内させて頂きます😊！！${endedSection}`;

        const availableFixedSystem = `あなたはテキスト置換エンジンです。
以下のテンプレートを一字一句そのまま出力してください。
[物件名と号室]の部分のみ、画像または会話履歴から「マンション名 ○○○号室」の形式で置き換えること（例: アドバンス難波ラシュレ 806号室）。
号室番号は先頭の0を省略すること（0806 → 806、0102 → 102）。
号室が不明な場合はマンション名のみ記載する。
それ以外の文字・絵文字・改行は一切変更・追加・削除しないこと。`;
        // テンプレート本文は顧客名・募集終了物件名を含む動的コンテンツ → キャッシュ対象の system から分離
        const availableFixedDynamic = `テンプレート:
${availableTemplate}`;

        if (image_url) {
          const content: Array<{ type: string; text?: string; source?: { type: string; url: string } }> = [
            { type: "text", text: `以下の会話と画像から物件名と号室を特定して[物件名と号室]を置き換えてください。${recentHistory}` },
            { type: "image", source: { type: "url", url: image_url } },
          ];
          message_text = await callClaudeVision(availableFixedSystem, content, currentAction, availableFixedDynamic);
        } else {
          message_text = await callClaude(
            availableFixedSystem,
            `以下の会話から物件名と号室を特定して[物件名と号室]を置き換えてください。${recentHistory}`,
            currentAction,
            availableFixedDynamic
          );
        }
        // 号室の先頭ゼロ除去はメインパス末尾の finalize() で一括処理（⑦で共通化）

      // 「物件なかった」は確定ベーステンプレ（構造は完全固定・冒頭表現のみ文脈判断）
      } else if (pattern === "unavailable") {
        const unavailPropName = typeof property_name === "string" ? property_name.trim() : "";
        // 確定ベーステンプレ: 冒頭表現（〇〇につきまして）以外は一字一句固定・AIに構造を崩させない
        const buildUnavailableMessage = (opening: string) =>
          `${name}お世話になっております！！\n${opening}募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！\n\n引き続き${name}のご条件に合ったお部屋をピックアップしてお送りさせて頂きます！！`;
        const UNAVAILABLE_DEFAULT_OPENING = "お送り頂きました物件につきまして";
        if (sentPropCount !== null) {
          // 送られた物件数が指定されている → 件数入りの冒頭表現
          message_text = buildUnavailableMessage(`お送り頂きました物件${sentPropCount}件につきまして`);
        } else if (unavailPropName) {
          // 物件名が分かる場合 → 「[物件名]につきまして」
          message_text = buildUnavailableMessage(`${unavailPropName}につきまして`);
        } else {
          // その他: AIは冒頭表現のみ判断（本文構造はコード側で固定）。失敗時はデフォルト冒頭にフォールバック
          try {
            const aiOpening = (await callClaudeHaiku(
              `あなたは不動産賃貸仲介スタッフのメッセージの冒頭表現だけを決めるエンジンです。
「（冒頭表現）募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！」という固定文の（冒頭表現）に入る一句だけを出力してください。
ルール:
- お客様がURLや画像で物件を送ってきた場合 → 「お送り頂きました物件につきまして」
- 物件が複数件送られている場合 → 「お送り頂きました物件○件につきまして」（○は件数）
- 会話から物件名が特定できる場合 → 「[物件名]につきまして」
- 判断できない場合 → 「お送り頂きました物件につきまして」
出力は冒頭表現の一句のみ。説明・改行・引用符・絵文字は一切禁止。`,
              `以下の会話履歴から冒頭表現を決めてください。${recentHistory}`,
              currentAction
            )).replace(/[\n\r"「」]/g, "").trim();
            message_text = buildUnavailableMessage(
              aiOpening && aiOpening.length <= 40 && aiOpening.endsWith("につきまして")
                ? aiOpening
                : UNAVAILABLE_DEFAULT_OPENING
            );
          } catch {
            message_text = buildUnavailableMessage(UNAVAILABLE_DEFAULT_OPENING);
          }
        }

      // 「同じ間取り」「違う間取り」は固定テンプレートを完全に守らせる専用フロー
      } else if (pattern === "alternative" && (floor_plan_match === "same" || floor_plan_match === "different")) {
        if (floor_plan_match === "same") {
          // G32: 冒頭は buildGreeting（当日送信済みなら空＝本題から）。「お待たせいたしました」は禁止語
          const templateText = `${greetingPhrase ? `${greetingPhrase}\n\n` : ""}お送り頂きました[物件名]${endedRoomStr}ですが確認しましたところ募集終了しておりました！！

別の階数となりますが、同じ間取りで
[物件名]で現在募集中のお部屋御座いましたので、最大限割引しました御見積書と併せてお送りさせて頂きました！！
お手隙の際にご査収ください！！`;

          const fixedSystem = `あなたはテキスト置換エンジンです。
以下のテンプレートを一字一句そのまま出力してください。
[物件名]の部分のみ、会話履歴から特定した物件名に置き換えること。
それ以外の文字・絵文字・改行は一切変更・追加・削除しないこと。`;
          // テンプレート本文は募集終了号室を含む動的コンテンツ → キャッシュ対象の system から分離
          const fixedDynamic = `テンプレート:
${templateText}`;

          message_text = await callClaude(fixedSystem, `以下の会話から物件名を特定して[物件名]を置き換えてください。${recentHistory}`, currentAction, fixedDynamic);

        } else {
          // 違う間取り: 物件画像から広さ（㎡）を読み取って文に反映
          const templateText = `${greetingPhrase ? `${greetingPhrase}\n\n` : ""}お送り頂きました[物件名]${endedRoomStr}ですが確認しましたところ募集終了しておりました！！

別の間取り（[㎡]）となりますが
[物件名]で現在募集中のお部屋が御座いますので、最大限割引しました御見積書と併せてお送りさせて頂きました！！
お手隙の際にご査収ください！！`;

          const fixedSystem = `あなたはテキスト置換エンジンです。
以下のテンプレートを一字一句そのまま出力してください。
[物件名]の部分のみ、会話履歴から特定した物件名に置き換えること。
[㎡]の部分のみ、添付画像から読み取った部屋の広さ（例: 46.2㎡）に置き換えること（画像がない・読み取れない場合は[㎡]ごと削除すること）。
それ以外の文字・絵文字・改行は一切変更・追加・削除しないこと。`;
          // テンプレート本文は募集終了号室を含む動的コンテンツ → キャッシュ対象の system から分離
          const fixedDynamic = `テンプレート:
${templateText}`;

          if (image_url) {
            const content: Array<{ type: string; text?: string; source?: { type: string; url: string } }> = [
              { type: "text", text: `以下の会話から物件名を特定して[物件名]を置き換え、添付画像から部屋の広さを読み取って[㎡]を置き換えてください。${recentHistory}` },
              { type: "image", source: { type: "url", url: image_url } },
            ];
            message_text = await callClaudeVision(fixedSystem, content, currentAction, fixedDynamic);
          } else {
            message_text = await callClaude(fixedSystem, `以下の会話から物件名を特定して[物件名]を置き換えてください。[㎡]は削除してください。${recentHistory}`, currentAction, fixedDynamic);
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
        // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ
        const [checkDiffNote, checkStarNote, checkRules, checkBrainAddendum] = await Promise.all([
          getKnowledgeForState(checkResultStates, currentAction, conversationId, latestCustomerMsg, brainContext),
          getStarredExamplesForAction(checkResultStates, latestCustomerMsg, aixBrainMeta),
          fetchPromptRulesSplit("property_check_result", { check_pattern: patternStr }).catch(() => ({ global: "", action: "" })),
          loadBrainTemplate("property_check_result"),
        ]);

        const instruction = PATTERN_INSTRUCTION[pattern] ?? PATTERN_INSTRUCTION.unavailable;
        const calendarPart = calendarNote
          ? `\n\n【内覧可能日時（1日1行で含めること・案内不可の日は除外）】\n${calendarNote}`
          : "";
        // 2026-09-17 竹内: 退去予定のお部屋の伝え方（内覧解禁日・費用のマイナスの説明を入れない）を材料として渡す
        const checkVacatingNote = buildVacatingPromptNote(
          Array.from({ length: Math.max(propCount, propVacancyDates.length) }, (_, i) => {
            const vd = ((propVacancyDates[i] as string | undefined) ?? "").trim();
            return { name: ((propNames[i] as string | undefined) ?? "").trim(), vacDate: vd && !isPastVacancyDate(vd) ? vd : "" };
          }),
        );
        const vacatingPart = checkVacatingNote ? `\n\n${checkVacatingNote}` : "";
        const userText = `${name}への物件確認報告メッセージを作成してください。\n\n${instruction}${templateSampleNote}${templateStructureNote}${calendarPart}${vacatingPart}${summaryNote}${recentHistory}`;

        // ブロック: [global ルール 1h] → [固定文＋action 別ルール 5m] → [お手本・実例・ノウハウ・ブレイン（動的）]。Vision も同じ構成
        const checkSystemSpec: SystemSpecBlocks = {
          semiStatic: checkRules.global.replace(/^\n\n/, ""),
          routeStatic: checkSystem + checkRules.action,
          dynamic: [
            checkSystemTail,
            checkBrainAddendum ? `【ブレイン改善ルール】\n${checkBrainAddendum}` : "",
          ].filter(Boolean).join("\n\n"),
        };
        const checkUserFinal = greetingTimeNote + userText + (checkDiffNote ? `\n\n${checkDiffNote}` : "") + (checkStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + checkStarNote : "");

        if (image_url || estimate_image_url) {
          const content: Array<{ type: string; text?: string; source?: { type: string; url: string } }> = [
            { type: "text", text: checkUserFinal },
          ];
          if (image_url) content.push({ type: "image", source: { type: "url", url: image_url } });
          if (estimate_image_url) content.push({ type: "image", source: { type: "url", url: estimate_image_url } });
          message_text = await callClaudeVision(checkSystemSpec, content, currentAction);
        } else {
          message_text = await callClaude(checkSystemSpec, checkUserFinal, currentAction);
        }
      }

      // 見積書テキスト同封: available パターンかつフラグON時、見積書画像から費用テキストを生成・末尾に追加（並列実行）
      if (pattern === "available" && (include_estimate_text as boolean | undefined) && message_text) {
        // 物件indexと対応した配列（見積書が無い物件は null）→ 下の map で pi を物件名の添字に使う
        const estUrls = (body.estimate_image_urls as (string | null)[] | undefined) ?? [];
        if (estUrls.some((u) => !!u)) {
          const checkEstSystem = `この見積書画像から初期費用情報を抽出してください。JSON形式のみ返答（説明文なし）：
{"discount":"34,000円","initial_cost":"146,000円","savings":"102,200円"}
- discount: 割引額（「〇〇,〇〇〇円」形式）
- initial_cost: 初期費用合計（「〇〇〇,〇〇〇円」形式）
- savings: スモラ節約額（一般業者との差額）
不明はnull。`;
          const checkEstBadges = ["①","②","③","④","⑤"];
          // null を含むため「実際に見積書がある件数」で単数/複数を判定する
          const estAttachedCount = estUrls.filter((u) => !!u).length;
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
                const prefix = estAttachedCount > 1 ? `${checkEstBadges[pi] ?? (pi + 1) + "."}【${pName}】` : `【${pName}】`;
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
      // フォーム本体はテンプレで直接生成（conversation_match の早期returnでも返せるよう先に組み立てる）
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
      hearing_form_content = `（${name}ご希望のお部屋探しご条件）
${formItems}`;
      // conversation_match 早期return用: finalizeResponse は hearing_form_content を自動では含めないため extra で渡す
      const hearingFormExtra = { hearing_form: hearing_form_content };

      // conversation_match: 会話に合わせた自然な挨拶＋ヒアリング導入メッセージを生成（固定フォームなし）
      if (body.conversation_match) {
        // base_message適応モード: 既存のAIX生成文を会話に合わせて補正
        if (baseMessage) {
          const adaptRulesNoteCH = await getAdaptImprovementRules(currentAction);
          message_text = await adaptMessageToConversation(baseMessage, recentHistory, name, currentAction, "", adaptRulesNoteCH, aixBrainMeta);
          return finalizeResponse(message_text, hearingFormExtra);
        }
        const [hearingCMDiffNote, hearingCMStarNote, hearingCMBrainAddendum] = await Promise.all([
          getKnowledgeForState([...AIX_ACTION_TO_STATES.condition_hearing, "first_reply"], currentAction, conversationId, latestCustomerMsg, brainContext),
          getStarredExamplesForAction([...AIX_ACTION_TO_STATES.condition_hearing, "first_reply"], latestCustomerMsg, aixBrainMeta),
          loadBrainTemplate("condition_hearing"),
        ]);

        const hearingCMSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】ユーザーメッセージに記載のお客様名を使うこと

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

        // キャッシュ最適化: hearingCMSystem は全て静的。動的なブレイン改善ルールのみ第4引数へ
        const hearingCMDynamicSuffix = hearingCMBrainAddendum ? `【ブレイン改善ルール】\n${hearingCMBrainAddendum}` : "";
        const hearingCMUserFinal = greetingTimeNote + `${recentHistory}\n\n上記の会話を読み取り、${name}への挨拶＋ヒアリング導入メッセージを生成してください。` + (hearingCMDiffNote ? `\n\n${hearingCMDiffNote}` : "") + (hearingCMStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + hearingCMStarNote : "");
        const rawHCM = await callClaude(
          hearingCMSystem,
          hearingCMUserFinal,
          currentAction,
          hearingCMDynamicSuffix || undefined
        );
        try {
          const mHCM = rawHCM.match(/\{[\s\S]*\}/);
          if (mHCM) {
            const dHCM = JSON.parse(mHCM[0]) as { message?: string };
            message_text = (dHCM.message || rawHCM).replace(/\\n/g, "\n");
          } else { message_text = rawHCM; }
        } catch { message_text = rawHCM; }
        // ⑦修正: conversation_match 早期returnでも共通後処理（号室ゼロ除去・内部メモ分離）を通す
        return finalizeResponse(message_text, hearingFormExtra);
      }
      // ─── ヒアリング: 条件フォームはテンプレで直接生成（従来通り・上で組み立て済み）＋ AI導入メッセージ（LL-09）────
      // フォーム本体は固定テンプレのまま。フォームに添える「導入メッセージ」のみAI生成し、
      // getDiffKnowledgeForState / getStarredExamplesForAction を注入して学習ループの対象にする。
      // 導入メッセージの生成に失敗してもフォームはそのまま送れる（hearingIntro は空になるだけ）。

      // LL-09: フォームに添える導入メッセージをAI生成（学習ループ対象化）
      try {
        // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールを global（semiStatic・全 AIX 共有 1h）／action（routeStatic 5m）に分け、ブレイン改善ルールは dynamic へ
        const [hearingDiffNote, hearingStarNote, hearingRules, hearingBrainAddendum] = await Promise.all([
          getKnowledgeForState([...AIX_ACTION_TO_STATES.condition_hearing, "first_reply"], currentAction, conversationId, latestCustomerMsg, brainContext),
          getStarredExamplesForAction([...AIX_ACTION_TO_STATES.condition_hearing, "first_reply"], latestCustomerMsg || "", aixBrainMeta),
          fetchPromptRulesSplit("condition_hearing", {}).catch(() => ({ global: "", action: "" })),
          loadBrainTemplate("condition_hearing"),
        ]);

        const hearingSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
お客様への条件ヒアリングの導入メッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【このメッセージの目的】
・次のメッセージで条件ヒアリングフォーム（①ご入居時期②ご希望家賃…の箇条書き）を送る予告をする
・「お部屋探しのご条件を教えてもらえますか」的な内容を自然に伝える

【スモラのLINEスタイル — 厳守】
・「！！」（全角感嘆符2つ）を使う
・お客様名（ユーザーメッセージに記載）で呼びかける
・絵文字は 😊 😌 のみ・1〜2個まで
・50〜100文字程度・2〜3行まで
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）
・条件項目の箇条書き自体はこのメッセージに含めない（フォームは別送するため）`;

        const hearingSystemSpec: SystemSpecBlocks = {
          semiStatic: hearingRules.global.replace(/^\n\n/, ""),
          routeStatic: hearingSystem + hearingRules.action,
          dynamic: hearingBrainAddendum ? "【ブレイン改善ルール】\n" + hearingBrainAddendum : "",
        };
        const hearingUserFinal = greetingTimeNote + `${name}へのヒアリング導入メッセージを作成してください。${latestCustomerMsg ? `\nお客様の最新メッセージ: ${latestCustomerMsg}` : ""}${recentHistory}` + (hearingDiffNote ? `\n\n${hearingDiffNote}` : "") + (hearingStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + hearingStarNote : "");
        const hearingResult = await callClaude(
          hearingSystemSpec,
          hearingUserFinal,
          currentAction
        );
        hearing_intro_result = hearingResult.trim();
        message_text = hearing_intro_result;
      } catch {
        // 導入メッセージ生成失敗でも固定フォームはそのまま送れる
      }

    } else if (action === "extract_datetime") {
      // 会話履歴から内覧日時をAIで抽出（待ち合わせ場所の日程・時間フィールド自動補完用）
      //
      // 2026-09-16 竹内（YUYA 事例）: 前日 21:23 の AIX「明日10:30にカーザSunⅠ」を翌朝 9:50 に読み、
      //   「明日＝本日（9/16）の翌日」＝9/17 と変換して viewings に登録していた（実際の内覧は 9/16）。
      //   内覧が未来扱いになり、AIX の自動セットが greeting_viewing にならず、生成にも「内覧は明日」が流れて
      //   下書きが「明日以降も気になる点等…」になった。
      //   → 各発言の「明日」は**その発言の日**を起点に絶対の日へ直してから渡す（決定論・LLM に相対の語を見せない）。
      //     行にも日付を付ける（この経路は行頭の形に依存する処理が無いので安全）
      const msgs = (Array.isArray(recent_messages) ? (recent_messages as Array<{ sender?: string; text?: string; rawCreatedAt?: string; createdAt?: string }>) : [])
        .filter(m => m.text && m.text !== "[画像]" && m.text !== "[動画]")
        .slice(-20)
        .map(m => {
          const atRaw = m.rawCreatedAt || m.createdAt || "";
          const atMs = atRaw ? Date.parse(atRaw) : NaN;
          if (Number.isNaN(atMs)) return `${m.sender === "customer" ? "お客様" : "スモラ"}: ${m.text}`;
          const head = `${jstDayLabel(jstDayStartMs(atMs))} ${m.sender === "customer" ? "お客様" : "スモラ"}`;
          return `${head}: ${absolutizeRelativeDays(m.text ?? "", atMs)}`;
        })
        .join("\n");

      if (!msgs) return NextResponse.json({ ok: true, date: "", time: "" });

      // 本日のJST日付（相対日付「明日」「来週」等の解決用）
      const jstToday = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const jstWeekday = ["日", "月", "火", "水", "木", "金", "土"][jstToday.getUTCDay()];
      const jstTodayStr = `${jstToday.getUTCFullYear()}/${jstToday.getUTCMonth() + 1}/${jstToday.getUTCDate()}(${jstWeekday})`;

      const system = `あなたは会話テキストから内覧の日程と時間を抽出するアシスタントです。
以下の会話から、内覧・案内の日程と時間を抽出してください。

【出力ルール（JSON1行のみ）】
{"date":"7/3（金）","time":"10:00"}

・dateは「月/日（曜日）」形式（例: 7/3（金）、7/3）
・timeは「HH:MM」の24時間表記（例: 10:00、14:30）
・お客様が確定・承諾した日時を最優先で抽出する
・日程は見つかるが時間が不明な場合はtimeを空文字に
・どちらも不明な場合は両方空文字に
・JSONのみ返す（説明文・コメント不要）`;

      // 本日の日付は日次で変わる動的コンテンツ → キャッシュ対象の system から分離
      const extractDatetimeDynamic = `【本日の日付（JST）】
${jstTodayStr}
・各行の先頭は「その発言をした日」（例: 9/15（火） スモラ: …）
・「明日」「明後日」などの語は、発言の日を起点に既に実際の日付へ直してある。行に書かれている日付をそのまま使い、本日を基準に数え直さないこと
・「今週土曜」など残っている相対表現だけは、その発言をした日を基準に変換すること`;

      // LLMが出力した曜日は信用せず、月/日から決定論的に曜日を再計算して上書きする
      // （例: 2026/7/21（火）をLLMが「（月）」と誤答するバグの恒久対策）
      const fixExtractedWeekday = (dateStr: string): string => {
        const dm = dateStr.match(/(\d{1,2})\/(\d{1,2})/);
        if (!dm) return dateStr;
        const mo = parseInt(dm[1], 10);
        const da = parseInt(dm[2], 10);
        const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        let yr = nowJst.getUTCFullYear();
        const todayMid = Date.UTC(yr, nowJst.getUTCMonth(), nowJst.getUTCDate());
        if (Date.UTC(yr, mo - 1, da) < todayMid - 180 * 24 * 3600 * 1000) yr += 1;
        const wd = ["日", "月", "火", "水", "木", "金", "土"][new Date(Date.UTC(yr, mo - 1, da)).getUTCDay()];
        return `${mo}/${da}（${wd}）`;
      };

      try {
        const raw = await callClaudeHaiku(system, msgs, currentAction, extractDatetimeDynamic);
        const jsonMatch = raw.match(/\{[^}]+\}/);
        if (!jsonMatch) return NextResponse.json({ ok: true, date: "", time: "" });
        const parsed = JSON.parse(jsonMatch[0]) as { date?: string; time?: string };
        return NextResponse.json({ ok: true, date: parsed.date ? fixExtractedWeekday(parsed.date) : "", time: parsed.time || "" });
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
①「[お客様名]（時候の挨拶・greetingTimeNoteの挨拶ルールに従う）」
②「本日〇〇時お部屋ご案内させて頂きます！」（〇〇を時刻に置き換え。時刻がなければ「本日お部屋ご案内させて頂きます！」）
③「本日は何卒よろしくお願い致します！！」

【時刻フォーマット】
・「14:00」→「14時」、「14:30」→「14時半」のように自然な日本語に変換する
・「！！」は①③のみ。②は「！」1つ

【禁止】
・3行以外の追加は一切しない。解説・絵文字・補足は不要`;

        // 学習済み差分ルール（スタッフ修正から学習したパターン）＋DBルールをプロンプト末尾に注入
        // 2026-09-17 竹内（AIX キャッシュ点検）: Haiku の呼び出しは cache なし（ttl "none"）のまま。global ≈12k tokens を準静的ブロックに置くと
        //   Haiku でも 1h の書き込みが起きる（数回/日の経路では純損）ので、ここは従来の fetchPromptRules（1本の文字列）を変えない
        const [beforeDiffNote, greetingViewingDbRules, greetingBeforeBrainAddendum] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.greeting_viewing, currentAction, conversationId, latestCustomerMsg, brainContext),
          fetchPromptRules("greeting_viewing", { sub_mode: sub_mode ?? "" }).catch(() => ""),
          loadBrainTemplate("greeting_viewing"),
        ]);

        const greetingBeforeSystemFinal = system + greetingViewingDbRules + (greetingBeforeBrainAddendum ? "\n\n【ブレイン改善ルール】\n" + greetingBeforeBrainAddendum : "");
        message_text = await callClaudeHaiku(
          greetingBeforeSystemFinal,
          greetingTimeNote + `${name}への内覧前挨拶を生成してください。${dateInfo}${recentHistory}` + (beforeDiffNote ? `\n\n${beforeDiffNote}` : ""),
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
        const [afterDiffNote, greetingAfterBrainAddendum] = await Promise.all([
          AFTER_FIXED_TYPES.includes(after_type ?? "")
            ? Promise.resolve("")
            : getKnowledgeForState(AIX_ACTION_TO_STATES.greeting_viewing, currentAction, conversationId, latestCustomerMsg, brainContext),
          loadBrainTemplate("greeting_viewing"),
        ]);
        // 2026-09-17 竹内（AIX キャッシュ点検）: ブレイン改善ルール（呼び出しごとに変わる）は静的 system から出して動的接尾へ（固定文だけが 5m の鍵）
        const greetingAfterDynamic = greetingAfterBrainAddendum ? `【ブレイン改善ルール】\n${greetingAfterBrainAddendum}` : undefined;

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
1行目: 「[お客様名]本日お時間頂きありがとうございました！！」（固定）
2行目以降: 以下の確認事項を踏まえた自然なメッセージ（2〜3行まで）
・感嘆符は「！！」スモラ文体で。補足・解説は不要

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}`;
          message_text = await callClaude(sys, `確認事項: ${freeword}${recentHistory}` + (afterDiffNote ? `\n\n${afterDiffNote}` : ""), currentAction, greetingAfterDynamic);

        } else if (after_type === "search_new") {
          // 引き続き物件探す / 新着探す
          message_text = `${thankLine}\n引き続き新着でおすすめできる物件が出次第ご連絡させて頂きます！`;

        } else if (after_type === "search_expand") {
          // 引き続き物件探す / 条件広げる → AI生成
          const sys = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
内覧後に送るメッセージを生成してください。
1行目: 「[お客様名]本日お時間頂きありがとうございました！！」（固定）
2行目: 「{条件情報}でご条件に合ったお部屋ピックアップしご連絡させて頂きます！」の形で条件を自然に組み込む
・スモラ文体・感嘆符「！！」・補足不要

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}`;
          message_text = await callClaude(sys, `条件: ${freeword}${recentHistory}` + (afterDiffNote ? `\n\n${afterDiffNote}` : ""), currentAction, greetingAfterDynamic);

        } else if (after_type === "search_change") {
          // 引き続き物件探す / 条件変更 → AI生成
          const sys = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
内覧後に送るメッセージを生成してください。
1行目: 「[お客様名]本日お時間頂きありがとうございました！！」（固定）
2行目: 「{変更後条件}で物件ピックアップしお送りさせて頂きます！」の形で条件を自然に組み込む
・スモラ文体・感嘆符「！！」・補足不要

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}`;
          message_text = await callClaude(sys, `変更条件: ${freeword}${recentHistory}` + (afterDiffNote ? `\n\n${afterDiffNote}` : ""), currentAction, greetingAfterDynamic);

        } else {
          // フォールバック（after_type未指定 = 旧フロー）
          const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
内覧後に送る「内覧後挨拶」LINEメッセージを3行で生成してください。
①「本日はお忙しいところご内覧頂きありがとうございます！！」
②「いかがでしたでしょうか？！」
③「気になる点ございましたらお気軽にお申し付けください！！」
・「！！」を文末に使う・3行のみ出力`;
          message_text = await callClaude(system, `${name}への内覧後挨拶を生成してください。${recentHistory}` + (afterDiffNote ? `\n\n${afterDiffNote}` : ""), currentAction, greetingAfterDynamic);
        }
      }

    } else if (action === "meeting_place") {
      // conversation_match: テンプレ固定なし・会話から日時・物件を読んで自然な待ち合わせ文を生成
      if (body.conversation_match) {
        // base_messageがある場合もadaptMessageToConversationは使わず再生成（テンプレ冒頭が残るため）
        // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ（旧: 動的接尾で毎回割引なし）
        const [mpDiffNote, mpStarNote, mpRules, mpCMBrainAddendum] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.meeting_place, currentAction, conversationId, latestCustomerMsg, brainContext),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.meeting_place, latestCustomerMsg, aixBrainMeta),
          fetchPromptRulesSplit("meeting_place", {}).catch(() => ({ global: "", action: "" })),
          loadBrainTemplate("meeting_place"),
        ]);
        const mpPropertyName = body.meeting_property_name ? String(body.meeting_property_name) : "";
        const mpAddress = body.meeting_property_address ? String(body.meeting_property_address) : "";
        const mpDate = body.meeting_date ? String(body.meeting_date) : "";

        // キャッシュ最適化: 静的（固定指示）と動的（物件名・住所・内覧日・DBルール・ブレイン）を分離
        const mpSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】ユーザーメッセージに記載のお客様名を使うこと

【この返信の目的】
・会話の流れに合わせたシンプルな冒頭1文から始める（「かしこまりました！！」は使わず、お客様の言葉・状況に沿った自然な一言）
・次に、会話から読み取った時間・物件名（あれば）・「現地エントランスお待ち合わせ」で待ち合わせを確定する
・物件名・住所があれば含める

【重要：会話読解ルール（必ず守ること）】
・会話から内覧の確定日時を読み取り、そのまま確定メッセージに使う
・時間が会話に出ていない場合は「[お時間]」としてプレースホルダーを残す
・テンプレ的な返信は絶対禁止

【絶対禁止】
・🙏 絵文字は絶対に使わない

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;

        const mpBaseHint = baseMessage ? `\n\n【参考：前回生成した待ち合わせ情報（日時・物件・住所の参考のみ。冒頭文言は使わない）】\n${baseMessage}` : "";
        const mpCMDynamicSuffix = [
          mpPropertyName ? `【物件名】${mpPropertyName}` : "",
          mpAddress ? `【住所】${mpAddress}` : "",
          mpDate ? `【内覧日】${mpDate}` : "",
          mpCMBrainAddendum ? `【ブレイン改善ルール】\n${mpCMBrainAddendum}` : "",
        ].filter(Boolean).join("\n\n");
        // ブロック: [shared 1h] → [global ルール 1h] → [固有文＋action 別ルール 5m] → [物件名・住所・内覧日・ブレイン（動的）]
        const mpShared = splitSharedPrefix(mpSystem);
        const mpSystemSpec: SystemSpecBlocks = {
          shared: mpShared.shared,
          semiStatic: mpRules.global.replace(/^\n\n/, ""),
          routeStatic: mpShared.routeStatic + mpRules.action,
          dynamic: mpCMDynamicSuffix,
        };
        const mpCMUserFinal = greetingTimeNote + `${recentHistory}${mpBaseHint}\n\n上記の会話を読み取り、${name}への待ち合わせ確定メッセージを生成してください。` + (mpDiffNote ? `\n\n${mpDiffNote}` : "") + (mpStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + mpStarNote : "");
        const rawMP = await callClaude(
          mpSystemSpec,
          mpCMUserFinal,
          currentAction
        );
        try {
          const mMP = rawMP.match(/\{[\s\S]*\}/);
          if (mMP) {
            const dMP = JSON.parse(mMP[0]) as { message?: string };
            message_text = (dMP.message || rawMP).replace(/\\n/g, "\n");
          } else { message_text = rawMP; }
        } catch { message_text = rawMP; }
        // ⑦修正: conversation_match 早期returnでも共通後処理（号室ゼロ除去・内部メモ分離）を通す
        return finalizeResponse(message_text);
      }

      const mDate = body.meeting_date ? String(body.meeting_date) : "";
      const mName = body.meeting_property_name ? String(body.meeting_property_name) : "";
      const mAddr = body.meeting_property_address ? String(body.meeting_property_address) : "";

      // 学習済み差分ルール（スタッフ修正から学習したパターン）＋☆成功返信パターン＋DBルールをプロンプト末尾に注入
      // 2026-09-17 竹内（AIX キャッシュ点検）: Haiku の呼び出しは cache なし（ttl "none"）のまま。global ≈12k tokens を準静的ブロックに置くと
      //   Haiku でも 1h の書き込みが起きる（数回/日の経路では純損）ので、ここは従来の fetchPromptRules（1本の文字列）を変えない
      const [meetingDiffNote, meetingStarNote, meetingDbRules, meetingBrainAddendum] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.meeting_place, currentAction, conversationId, latestCustomerMsg, brainContext),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.meeting_place, latestCustomerMsg, aixBrainMeta),
        fetchPromptRules("meeting_place", {}).catch(() => ""),
        loadBrainTemplate("meeting_place"),
      ]);

      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
会話履歴を読み取り、待ち合わせ確認メッセージを生成してください。

【時間の読み取りルール】
・会話履歴から待ち合わせの時間（例：11時、14:00、午後2時など）を読み取り [時間] に当てはめること
・「11時」→「11:00」、「14時30分」→「14:30」のように整形すること
・時間が会話に見当たらない場合は [時間] をそのまま残すこと
・構成・文言は一切変えず [時間] だけを置き換えること

【スモラLINE営業ルール（必ず守る・ただし上記の出力形式が最優先）】
${SMORA_COMMON_RULES}`;

      // 日程・物件名・住所は呼び出しごとに変わる動的コンテンツ → キャッシュ対象の system から分離
      const meetingDynamicSuffix = `【出力形式（一字一句この構成で）】
かしこまりました！！
${mDate}ご案内させて頂きます！！

${mDate}[時間]に${mName}
現地エントランスお待ち合わせで何卒よろしくお願い致します！！${mAddr ? `\n住所: ${mAddr}` : ""}`;

      const meetingSystemFinal = system + meetingDbRules + (meetingBrainAddendum ? "\n\n【ブレイン改善ルール】\n" + meetingBrainAddendum : "");
      const meetingUserFinal = greetingTimeNote + `会話履歴から待ち合わせ時間を読み取り、メッセージを生成してください。${recentHistory}` + (meetingDiffNote ? `\n\n${meetingDiffNote}` : "") + (meetingStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + meetingStarNote : "");
      message_text = await callClaudeHaiku(meetingSystemFinal, meetingUserFinal, currentAction, meetingDynamicSuffix);

    // ── ✅ 確認します ──────────────────────────────────────────────
    } else if (action === "acknowledge_check") {
      // conversation_match: 会話から確認内容を正確に読み取って自然な管理会社向けメッセージを生成
      if (body.conversation_match) {
        // ⭐実例注入: 管理会社向けの文体は acknowledge_check の送信済み実例からのみ学ぶ
        //   （hearing/proposing はお客様向け文体のため混ぜない。states は必ず ["acknowledge_check"] のみ）
        // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ（旧: 動的接尾で毎回割引なし）
        const [ackCMDiffNote, ackCMStarNote, ackCMRules, ackCMBrainAddendum] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.acknowledge_check, currentAction, conversationId, latestCustomerMsg, brainContext),
          getStarredExamplesForAction(["acknowledge_check"], latestCustomerMsg, aixBrainMeta),
          fetchPromptRulesSplit("acknowledge_check", {}).catch(() => ({ global: "", action: "" })),
          loadBrainTemplate("acknowledge_check"),
        ]);
        const ackCMLabel = familyName ? `${familyName}さん` : "お客様";

        const ackCMSystem = `あなたは賃貸仲介サービス「スモラ」のスタッフです。
物件の管理会社・オーナーへLINEで送る確認メッセージを1つ生成してください。

${SMORA_COMMON_RULES}

【宛先と立場 — 最重要（上記の共通ルールと矛盾する場合はこちらを優先）】
・宛先は管理会社またはオーナー（お客様宛てではない）
・案内しているお客様名: ユーザーメッセージに記載のお客様名を使うこと
・スモラは仲介会社として管理会社に「お願いする側」。確認するのは管理会社であり自分ではない
　× 「募集状況確認させていただきます」（お客様向けの言い回し。管理会社宛てでは意味が逆）
　○ 「現在も募集中でしょうか」「〜お伺いできますでしょうか」「〜ご確認頂けますでしょうか」

【必ず含める要素（文言は会話に合わせて自然に調整する・順番はこの流れが基本）】
1. 冒頭1行目: 「[お客様名]のご案内をしております！！」（[お客様名]はユーザーメッセージに記載のお客様名に置き換える）
2. どの物件か: 物件名・号室が会話に出ていれば必ず含める（創作禁止）。出ていない場合は駅名・間取り・階数など会話から読み取れた情報だけで特定する
3. 確認したい内容: お客様の疑問・状況を正確に読み取り、管理会社への質問・依頼の形で1〜2文にする
4. 初期費用の見積もり依頼（会話でまだ見積もりを依頼していない場合のみ）: 「あわせて最大限割引した初期費用の御見積もりもお願いできますでしょうか！！」
5. 締め: 「ご確認頂けますと幸いです。よろしくお願い致します！！」（同義の自然な言い換え可）

【自然な文章のためのルール（必ず守ること）】
・お客様名は冒頭の1回だけ。2回以上書かない
・お客様が物件を見つけた経緯（SUUMOで見た・LINEで送ってきた等）は書かない。管理会社に必要なのは「どの物件か」と「何を確認したいか」だけ
・検索条件の羅列をそのまま書かない → 「なんば1K5階」ではなく「なんば駅周辺の1K・5階のお部屋」のような自然な日本語に直す
・「！！」で終える文は多くても2〜3文まで。すべての行を「！！」で終えない。「。」「でしょうか？」も混ぜる
・「頂けますでしょうか」「頂けますと幸いです」など、お願いする側の丁寧で明るい文体を使う

【禁止事項】
・「お世話になっております」は使わない
・「様」を使わない（「さん」で統一）
・物件名・号室を創作しない
・「確認させていただきます」「承りました」「少々お待ちください」「確認中です」は使わない
・🙏絵文字は絶対禁止。絵文字は😊のみ1個まで（なくても可）
・「**太字**」等のマークダウン記法は使わない

【文例（構成・トーンの参考。内容は必ず今回の会話に合わせること）】
例1（募集状況＋見積もり依頼）:
アヤさんのご案内をしております！！
〇〇マンション301号室、現在も募集中でしょうか？
あわせて最大限割引した初期費用の御見積もりもお願いできますでしょうか！！
ご確認頂けますと幸いです。よろしくお願い致します！！

例2（個別の確認事項がある場合）:
タナカさんのご案内をしております！！
〇〇レジデンス502号室について、ペット（小型犬1匹）の飼育が可能かお伺いできますでしょうか？
ご確認頂けますと幸いです。よろしくお願い致します！！

【文字数】3〜6行のコンパクトなメッセージ`;
        // ⑤修正: 管理会社向けメッセージは「お世話になっております禁止」のため、
        //   「必ず挨拶を使え」と指示する greetingTimeNote は連結しない（矛盾指示の排除）

        // ブロック: [global ルール 1h] → [固有文＋【お客様名】の固定行＋action 別ルール 5m] → [ブレイン（動的）]。【お客様名】の行は固定文なので経路固有ブロックへ
        const ackCMSystemSpec: SystemSpecBlocks = {
          semiStatic: ackCMRules.global.replace(/^\n\n/, ""),
          routeStatic: `${ackCMSystem}\n\n【お客様名】ユーザーメッセージに記載のお客様名を使うこと${ackCMRules.action}`,
          dynamic: [
            ackCMBrainAddendum ? `【ブレイン改善ルール】\n${ackCMBrainAddendum}` : "",
            brainGuidanceNote,
          ].filter(Boolean).join("\n\n"),
        };
        const ackCMUserFinal = `${ackCMLabel}のご案内について、物件の管理会社へ送る確認メッセージを生成してください。${extra_input ? `\n補足: ${extra_input}` : ""}${recentHistory}` + (ackCMDiffNote ? `\n\n${ackCMDiffNote}` : "") + (ackCMStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + ackCMStarNote : "");
        const rawACM = await callClaude(
          ackCMSystemSpec,
          ackCMUserFinal,
          currentAction
        );
        message_text = rawACM;
        // ⑦修正: conversation_match 早期returnでも共通後処理（号室ゼロ除去・内部メモ分離）を通す
        return finalizeResponse(message_text);
      }

      // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ（旧: 動的接尾で毎回割引なし）
      const [ackDiffNote, ackRules, ackBrainAddendum] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.acknowledge_check, currentAction, conversationId, latestCustomerMsg, brainContext),
        fetchPromptRulesSplit("acknowledge_check", {}).catch(() => ({ global: "", action: "" })),
        loadBrainTemplate("acknowledge_check"),
      ]);
      // ★宛先はお客様ではなく物件の管理会社・オーナー。スモラは全LINEで「さん」表記のため familyName＋さん で組み立てる
      const ackCustomerLabel = familyName ? `${familyName}さん` : "お客様";
      const ackSystem = `あなたは賃貸仲介サービス「スモラ」のLINE担当スタッフです。
管理会社・オーナーへの物件確認メッセージ（LINE）を生成してください。

${SMORA_COMMON_RULES}

【メッセージの宛先】管理会社またはオーナー（お客様宛てではない）

【構成ルール（この順番で・必ず守ること）】
① 書き出し: 「[お客様名]のご案内をしております！！」（[お客様名]はユーザーメッセージに記載のお客様名に置き換える）
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

【文字数】4〜6行のコンパクトなメッセージ`;
      // ⑤修正: 管理会社向けメッセージは「お世話になっております禁止」のため、
      //   「必ず挨拶を使え」と指示する greetingTimeNote は連結しない（矛盾指示の排除）

      // ブロック: [global ルール 1h] → [固有文＋【お客様名】の固定行＋action 別ルール 5m] → [ブレイン（動的）]。【お客様名】の行は固定文なので経路固有ブロックへ
      const ackSystemSpec: SystemSpecBlocks = {
        semiStatic: ackRules.global.replace(/^\n\n/, ""),
        routeStatic: `${ackSystem}\n\n【お客様名】ユーザーメッセージに記載のお客様名を使うこと${ackRules.action}`,
        dynamic: [
          ackBrainAddendum ? `【ブレイン改善ルール】\n${ackBrainAddendum}` : "",
          brainGuidanceNote,
        ].filter(Boolean).join("\n\n"),
      };
      message_text = await callClaude(
        ackSystemSpec,
        `${ackCustomerLabel}のご案内について、物件の管理会社へ送る「募集状況確認 ＋ 最大限割引した初期費用の御見積もり依頼」メッセージを生成してください。${extra_input ? `\n補足: ${extra_input}` : ""}${recentHistory}` + (ackDiffNote ? `\n\n${ackDiffNote}` : ""),
        currentAction
      );

    // ── 📣 追客する ──────────────────────────────────────────────
    } else if (action === "followup_revive") {
      const followSubMode = body.follow_sub_mode as string | undefined;
      const followPropertyName = (body.property_name as string | undefined) || "";

      // ── 申込補足情報催促 ────────────────────────────────────────────────────
      if (followSubMode === "apply_supplement") {
        // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ。ブレイン改善ルールは動的へ
        const [supDiffNote, supStarNote, supRules, supBrainAddendum] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.followup_revive, currentAction, conversationId, latestCustomerMsg, brainContext),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.followup_revive, latestCustomerMsg, aixBrainMeta),
          fetchPromptRulesSplit("followup_revive", { follow_sub_mode: followSubMode }).catch(() => ({ global: "", action: "" })),
          loadBrainTemplate("followup_revive"),
        ]);

        const supSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
お申込み手続き中のお客様へ、まだ頂けていない申込書類・情報のご提出をお願いするLINEメッセージを1つ生成してください。

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}

【構成ルール（この順番で・必ず守ること）】
① 書き出し: 「[お客様名]（時候の挨拶）」（greetingTimeNoteの時間帯・初回・当日挨拶済みルールと整合させる）
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
        // ブロック: [global ルール 1h] → [固有文＋action 別ルール 5m] → [ブレイン・挨拶（動的）]
        const supSystemSpec: SystemSpecBlocks = {
          semiStatic: supRules.global.replace(/^\n\n/, ""),
          routeStatic: supSystem + supRules.action,
          dynamic: [
            supBrainAddendum ? `【ブレイン改善ルール】\n${supBrainAddendum}` : "",
            greetingPhrase ? `【挨拶フレーズ】${greetingPhrase}\n` : "",
          ].filter(Boolean).join("\n\n"),
        };
        const supUserFinal = greetingTimeNote + supUser + (supDiffNote ? `\n\n${supDiffNote}` : "") + (supStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + supStarNote : "");
        message_text = await callClaude(supSystemSpec, supUserFinal, currentAction);

      // ── 物件探し継続確認 ──────────────────────────────────────────────────
      } else if (followSubMode === "search_continue") {
        // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ。ブレイン改善ルールは動的へ
        const [scDiffNote, scStarNote, scRules, scBrainAddendum] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.followup_revive, currentAction, conversationId, latestCustomerMsg, brainContext),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.followup_revive, latestCustomerMsg, aixBrainMeta),
          fetchPromptRulesSplit("followup_revive", { follow_sub_mode: followSubMode }).catch(() => ({ global: "", action: "" })),
          loadBrainTemplate("followup_revive"),
        ]);

        const scSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
しばらく連絡が取れていないお客様へ、新着物件をきっかけにお部屋探しを継続されているか軽く確認するLINEメッセージを1つ生成してください。

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}

【トーン】
・押しつけがましくない・軽いタッチ
・返信を強要する表現（「ご返信ください」「お早めに」等）は使わない
・「〜ご満足いただけるまでサポートします」「引き続きお手伝いします」等の宣言は絶対に入れない

【文字数】①②③の3パート・完成したLINEメッセージのみを出力（JSONや説明文は不要）`;

        // 物件名は呼び出しごとに変わる動的コンテンツ → キャッシュ対象の system から分離
        const scDynamicNote = `【構成ルール（この順番で・必ず守ること）】
① 書き出し: 「[お客様名]（時候の挨拶）」（greetingTimeNoteの時間帯・初回・当日挨拶済みルールと整合させる）
② 新着のご連絡: ${followPropertyName ? `「新しく${followPropertyName}が募集にでましたのでご連絡させていただきました！！」` : `「新しくオススメ出来る物件が募集にでましたのでご連絡させていただきました！！」`}
  ※補足情報に物件の特徴（駅近・築浅・家賃など）があれば、②に一言だけ自然に添えてよい
③ 締め（＝メッセージの最後の一文）: 「[お客様名]お部屋探し継続されていますでしょうか！！」
  ※③の後に文章を追加しない・サポート宣言・フォロー宣言・補足一切不要

【禁止事項】
・③の後に一切の文章・絵文字・補足を追加しない（③で完全に終える）
・補足情報にない物件の設備・家賃・条件を創作しない
・物件名を創作しない（${followPropertyName ? `「${followPropertyName}」以外の物件名を出さない` : "物件名が不明な場合は「オススメ出来る物件」のままにする"}）
・「様」を使わない（「さん」で統一）
・🙏絵文字は絶対禁止`;

        const scUser = `${name}への物件探し継続確認メッセージを生成してください。${followPropertyName ? `\n物件名: ${followPropertyName}` : ""}${extra_input ? `\n補足（物件の特徴など）: ${extra_input}` : ""}${recentHistory}`;
        // ブロック: [global ルール 1h] → [固有文＋action 別ルール 5m] → [ブレイン・物件名入りの構成ルール・挨拶（動的）]
        const scSystemSpec: SystemSpecBlocks = {
          semiStatic: scRules.global.replace(/^\n\n/, ""),
          routeStatic: scSystem + scRules.action,
          dynamic: [
            scBrainAddendum ? `【ブレイン改善ルール】\n${scBrainAddendum}` : "",
            scDynamicNote,
            greetingPhrase ? `【挨拶フレーズ】${greetingPhrase}\n` : "",
          ].filter(Boolean).join("\n\n"),
        };
        const scUserFinal = greetingTimeNote + scUser + (scDiffNote ? `\n\n${scDiffNote}` : "") + (scStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + scStarNote : "");
        message_text = await callClaude(scSystemSpec, scUserFinal, currentAction);

      // conversation_match: 過去の会話文脈を最大活用した自然な追客メッセージを生成
      } else if (body.conversation_match) {
        // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ（旧: 動的接尾で毎回割引なし）
        const [followupCMDiffNote, followupCMStarNote, followupCMRules, followupCMBrainAddendum] = await Promise.all([
          getKnowledgeForState(AIX_ACTION_TO_STATES.followup_revive, currentAction, conversationId, latestCustomerMsg, brainContext),
          getStarredExamplesForAction(AIX_ACTION_TO_STATES.followup_revive, latestCustomerMsg, aixBrainMeta),
          fetchPromptRulesSplit("followup_revive", {}).catch(() => ({ global: "", action: "" })),
          loadBrainTemplate("followup_revive"),
        ]);

        const followupCMSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】ユーザーメッセージに記載のお客様名を使うこと

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

        // キャッシュ最適化: followupCMSystem は全て静的。ブレイン改善ルール・ブレインの判断のみ動的ブロックへ
        const followupCMDynamicSuffix = [
          followupCMBrainAddendum ? `【ブレイン改善ルール】\n${followupCMBrainAddendum}` : "",
          brainGuidanceNote,
        ].filter(Boolean).join("\n\n");
        // ブロック: [shared 1h] → [global ルール 1h] → [固有文＋action 別ルール 5m] → [ブレイン（動的）]
        const followupCMShared = splitSharedPrefix(followupCMSystem);
        const followupCMSystemSpec: SystemSpecBlocks = {
          shared: followupCMShared.shared,
          semiStatic: followupCMRules.global.replace(/^\n\n/, ""),
          routeStatic: followupCMShared.routeStatic + followupCMRules.action,
          dynamic: followupCMDynamicSuffix,
        };
        const followupCMUserFinal = greetingTimeNote + `${recentHistory}\n\n上記の会話を深く読み取り、${name}への追客メッセージを生成してください。${extra_input ? `\n補足情報: ${extra_input}` : ""}` + (followupCMDiffNote ? `\n\n${followupCMDiffNote}` : "") + (followupCMStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + followupCMStarNote : "");
        const rawFCM = await callClaude(
          followupCMSystemSpec,
          followupCMUserFinal,
          currentAction
        );
        try {
          const mFCM = rawFCM.match(/\{[\s\S]*\}/);
          if (mFCM) {
            const dFCM = JSON.parse(mFCM[0]) as { message?: string };
            message_text = (dFCM.message || rawFCM).replace(/\\n/g, "\n");
          } else { message_text = rawFCM; }
        } catch { message_text = rawFCM; }
        // ⑦修正: conversation_match 早期returnでも共通後処理（号室ゼロ除去・内部メモ分離）を通す
        return finalizeResponse(message_text);
      } else {

      // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ（旧: 動的接尾で毎回割引なし）
      const [followupDiffNote, followupStarNote, followupRules, followupBrainAddendum] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.followup_revive, currentAction, conversationId, latestCustomerMsg, brainContext),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.followup_revive, latestCustomerMsg, aixBrainMeta),
        fetchPromptRulesSplit("followup_revive", {}).catch(() => ({ global: "", action: "" })),
        loadBrainTemplate("followup_revive"),
      ]);
      const followupSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
しばらく連絡が取れていないお客様への追客LINEメッセージを1つ生成してください。

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}

【追客メッセージのルール】
・[お客様名]と呼びかけ、現在もお部屋探しをサポートする意思を伝える
・「その後いかがでしょうか！！」などの近況確認から入ると自然
・補足情報（extra_input）がある場合は活用する（例: 新着物件あり、条件変更の提案など）
・押しつけがましくならず、お客様のペースを尊重した文体
・2〜4行程度・完成したLINEメッセージのみ出力`;

      const followupDynamic = [
        followupBrainAddendum ? `【ブレイン改善ルール】\n${followupBrainAddendum}` : "",
        brainGuidanceNote,
      ].filter(Boolean).join("\n\n");
      // ブロック: [global ルール 1h] → [固有文＋action 別ルール 5m] → [ブレイン（動的）]
      const followupSystemSpec: SystemSpecBlocks = {
        semiStatic: followupRules.global.replace(/^\n\n/, ""),
        routeStatic: followupSystem + followupRules.action,
        dynamic: followupDynamic,
      };
      const followupUserFinal = greetingTimeNote + `${name}への追客メッセージを生成してください。${extra_input ? `\n補足: ${extra_input}` : ""}${recentHistory}` + (followupDiffNote ? `\n\n${followupDiffNote}` : "") + (followupStarNote ? "\n\n【参考にすべき成功返信例（必ず参考にして返信スタイルを合わせてください）】\n" + followupStarNote : "");
      message_text = await callClaude(
        followupSystemSpec,
        followupUserFinal,
        currentAction
      );
      }

    // ── 💪 全力サポート ──────────────────────────────────────────────────────
    } else if (action === "zenryoku_support") {
      const area = typeof body.area === "string" ? body.area.trim() : "";
      const memo = typeof body.memo === "string" ? body.memo.trim() : "";
      const imageDataUrl = typeof body.image_data_url === "string" ? body.image_data_url.trim() : "";

      const zenryokuSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
お客様が希望する物件が現在見つからない時に送る「全力サポートメッセージ」を1つ生成してください。

【スモラLINE営業ルール（必ず守る）】
${SMORA_COMMON_RULES}

【構成ルール（この順番で・必ず守ること）】
① 書き出し: 「[お客様名]（時候の挨拶）」（greetingTimeNoteの挨拶ルールに従う）
② 査収のお礼: ご確認いただいたことへの感謝を自然に入れる
③ 全域ピックアップ説明: 指定エリアを含む広域から条件に合う物件を探したが、現在の募集状況では完全に条件を満たす物件がない旨を丁寧に伝える
   ※補足（memo）がある場合はその理由・状況を自然に織り込む（例: 「家賃が上限を超えてしまいますのでオススメできません」等）
④ 引き続きのサポート約束: 新着が出次第すぐにお送りする旨を前向きに伝える

【禁止事項】
・存在しない物件・具体的な金額・数字のハルシネーション絶対禁止
・物件の詳細（間取り・家賃・号室等）を勝手に作り上げない
・「様」を使わない（「さん」で統一）
・🙏絵文字は絶対禁止
・「承りました」「少々お待ちください」禁止
・LINEメッセージ本文のみ出力（JSONや説明文・前置き・後置き一切不要）

【文体】
・スモラらしい丁寧・熱心・前向きなトーン（😊や！！を自然に使う）
・2〜5行程度`;

      const zenryokuBrainAddendum = await loadBrainTemplate("zenryoku_support");
      // 2026-09-17 竹内（AIX キャッシュ点検）: ブレイン改善ルール（呼び出しごとに変わる）は静的 system から出して動的接尾へ（固定文だけが 5m の鍵）
      const zenryokuDynamic = [
        zenryokuBrainAddendum ? `【ブレイン改善ルール】\n${zenryokuBrainAddendum}` : "",
        greetingPhrase ? `【挨拶フレーズ】${greetingPhrase}\n` : "",
      ].filter(Boolean).join("\n\n") || undefined;
      const zenryokuUser = `${name}への全力サポートメッセージを生成してください。
探しているエリア: ${area || "（未指定）"}${memo ? `\n補足・特記事項: ${memo}` : ""}${recentHistory}`;
      const zenryokuUserFinal = greetingTimeNote + zenryokuUser;

      if (imageDataUrl) {
        // data URL 解析: "data:<mediatype>;base64,<data>"
        const dataUrlMatch = imageDataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
        if (!dataUrlMatch) throw new Error("zenryoku_support: 画像データURLの形式が不正です");
        const mediaType = dataUrlMatch[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        const base64Data = dataUrlMatch[2];
        const visionContent: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [
          { type: "text", text: zenryokuUserFinal },
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
        ];
        message_text = await callClaudeVision(zenryokuSystem, visionContent, currentAction, zenryokuDynamic);
      } else {
        message_text = await callClaude(
          zenryokuSystem,
          zenryokuUserFinal,
          currentAction,
          zenryokuDynamic
        );
      }

    } else if (action === "cost_breakdown") {
      // AIX【初期費用について】（2026-09-15 竹内・ゆうこ事例）: 会話を合わせる専用。
      //   「家賃だけ払ったら住めるんですか？」等の初期費用の中身の質問に、スタッフが貼り付けた御見積書の画像の読み取り結果だけで答える。
      //   旧: 本文の下書きが見積書を見ずに「家賃・管理費に加え敷金礼金等含む総額」と断言した（その物件の敷金・礼金が0円かもしれないのに）。
      //   金額は読み取り結果とスタッフの入力（火災保険）にある物だけ → それ以外は〇〇円（checkAmountsAgainstBreakdown）→ 送信前チェックで止まる
      const cbUrls = ((body.estimate_image_urls as (string | null)[] | undefined) ?? [])
        .filter((u): u is string => typeof u === "string" && !!u.trim())
        .slice(0, 3);
      if (cbUrls.length === 0) throw new Error("御見積書の画像を貼り付けてください");
      const cbInsRaw = Number(body.insurance_separate_yen);
      const cbInsurance = Number.isFinite(cbInsRaw) && cbInsRaw > 0 ? Math.round(cbInsRaw) : null;
      const cbParsed = await Promise.all(cbUrls.map(async (url) => {
        try {
          const key = `cost_breakdown:${url}`;
          let raw = ocrCacheGet(key);
          if (!raw) {
            raw = await callClaudeVision(
              COST_BREAKDOWN_OCR_SYSTEM,
              [
                { type: "text", text: "この御見積書の初期費用の内訳を読み取ってください。" },
                { type: "image", source: { type: "url", url } },
              ],
              currentAction,
            );
            ocrCacheSet(key, raw);
          }
          return parseCostBreakdownJson(raw);
        } catch (e) {
          console.error("[aix/action] cost_breakdown OCR failed:", e);
          return null;
        }
      }));
      const cbBreakdowns = cbParsed.filter((b): b is CostBreakdown => b !== null);
      if (cbBreakdowns.length === 0) throw new Error("御見積書の画像から金額を読み取れませんでした。画像を確認してもう一度お試しください");
      const cbFacts = formatCostBreakdownFacts(cbBreakdowns, { insuranceSeparateYen: cbInsurance });

      // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ（旧: 動的接尾で毎回割引なし）
      const [cbKnowledge, cbStarNote, cbRules, cbBrainAddendum] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.cost_breakdown, currentAction, conversationId, latestCustomerMsg, brainContext),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.cost_breakdown, latestCustomerMsg, aixBrainMeta),
        fetchPromptRulesSplit("cost_breakdown", {}).catch(() => ({ global: "", action: "" })),
        loadBrainTemplate("cost_breakdown"),
      ]);

      // キャッシュ最適化: 静的（GENERATION_SYSTEM/共通ルール/固定指示/スタッフの実文）と動的（見積書の内訳・ブレイン・DBルール）を分ける
      const cbStaticSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】ユーザーメッセージに記載のお客様名を使うこと

【この返信の目的】
・お客様の初期費用についての質問（家賃・管理費だけで入居できるか・初期費用に何が含まれるか・別途かかる費用はあるか 等）に、手元の御見積書の内訳を使って1通で答える

【構成】
①最初の文でお客様の質問に直接答える（家賃・管理費だけで入居できるかと聞かれたら、御見積書の初期費用の合計と、それに含まれる主な項目で答える）
②御見積書に含まれる項目を御見積書の項目名のまま伝える（0円の項目は「敷金0円」のようにお得な点として触れてよい）
③火災保険は【御見積書の内訳】の「・火災保険」の行のとおり（含まれている物を「別途」と書かない）
④日割家賃を1文（ご入居日によって日割家賃が発生・1日のご入居ならかからない。金額は書かない）
⑤締めは1文（ご不明点があればお気軽に 等）。内覧・お申込の押し・新しい物件の提案は入れない

【言い回し】下の「スタッフの実際の返信」の口調・構成に合わせる（「〜となります！！」「〜含めさせて頂いております」）

【絶対禁止】
・【御見積書の内訳】に無い金額・費用項目を書くこと（足し算・引き算・日数計算で作った金額も禁止）
・日割家賃の金額を書くこと
・【御見積書の内訳】に火災保険の金額が無いのに火災保険の金額を書くこと
・「確認させて頂きます」等の確認前の文（御見積書は手元にある）
・謝罪表現（「申し訳ございません」等）・🙏 絵文字

【スタッフの実際の返信（言い回しの手本。別の物件の話なので、金額と「火災保険は別途」等の中身は写さない。中身は必ず【御見積書の内訳】に従う）】
${COST_BREAKDOWN_STAFF_EXAMPLES.map((t, i) => `例${i + 1}:\n${t}`).join("\n\n")}

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;

      const cbDynamicSuffix = [
        cbFacts.block,
        brainGuidanceNote ? `【ブレインの判断（この局面の方針）】${brainGuidanceNote}` : "",
        cbBrainAddendum ? `【ブレイン改善ルール】\n${cbBrainAddendum}` : "",
      ].filter(Boolean).join("\n\n");
      // ブロック: [shared 1h] → [global ルール 1h] → [固有文＋action 別ルール 5m] → [見積書の内訳・ブレイン（動的）]
      const cbShared = splitSharedPrefix(cbStaticSystem);
      const cbSystemSpec: SystemSpecBlocks = {
        shared: cbShared.shared,
        semiStatic: cbRules.global.replace(/^\n\n/, ""),
        routeStatic: cbShared.routeStatic + cbRules.action,
        dynamic: cbDynamicSuffix,
      };
      const cbUser = greetingTimeNote
        + `${recentHistory}\n\n上記の会話を読み取り、${name}の初期費用についてのご質問に、御見積書の内訳を使って答える返信を生成してください。`
        + (cbKnowledge ? `\n\n${cbKnowledge}` : "")
        + (cbStarNote ? `\n\n【参考にすべき成功返信例（返信スタイルを合わせる）】\n${cbStarNote}` : "");
      const cbRaw = await callClaude(cbSystemSpec, cbUser, currentAction);
      let cbMessage = cbRaw;
      try {
        const m = cbRaw.match(/\{[\s\S]*\}/);
        if (m) cbMessage = ((JSON.parse(m[0]) as { message?: string }).message || cbRaw).replace(/\\n/g, "\n");
      } catch { /* JSON で無ければ本文そのもの */ }
      const cbChecked = checkAmountsAgainstBreakdown(cbMessage, cbFacts.allowedAmounts);
      if (cbChecked.unmatched.length > 0) {
        console.warn("[aix/action] cost_breakdown: 御見積書に無い金額を伏せ字:", cbChecked.unmatched);
      }
      return finalizeResponse(cbChecked.cleaned, {
        prop_cost_notes: cbFacts.notes,
        cost_breakdown_items: cbBreakdowns.map((b) => ({
          property: [b.propertyName, b.roomNumber].filter(Boolean).join(" "),
          items: b.items,
          total: b.total,
          discount: b.discount,
        })),
        ...(cbChecked.unmatched.length > 0
          ? { notice: `御見積書に無い金額（${cbChecked.unmatched.join("・")}）を〇〇円にしました。御見積書を見て書き換えてから送信してください` }
          : {}),
      });

    } else if (action === "phone_followup") {
      // 2026-09-15 竹内（H 事例）「電話終了後ピッカーのテキスト部分に内容をいれると文が生成される形」:
      //   スタッフが電話で話した内容のメモから、お礼＋決まったこと＋こちらがすること／お客様にお願いすることの1通を作る。
      //   メモに無い金額・日付・時刻・号室は作らない（maskNumbersNotInNotes で〇〇 → 送信前チェックで止まる）。
      //   ブレインの方針・時間帯の挨拶は入れない（電話で話した内容が正・古い判断を混ぜない）
      const pfNotes = String(body.call_notes ?? "").trim().slice(0, 2000);
      if (!pfNotes) throw new Error("電話でお話しした内容を入力してください");
      // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ（旧: 動的接尾で毎回割引なし）
      const [pfKnowledge, pfStarNote, pfRules] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.phone_followup, currentAction, conversationId, latestCustomerMsg, brainContext),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.phone_followup, latestCustomerMsg, aixBrainMeta),
        fetchPromptRulesSplit("phone_followup", {}).catch(() => ({ global: "", action: "" })),
      ]);
      const pfStaticSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】ユーザーメッセージに記載のお客様名を使うこと

【この返信の目的】
・お客様とのお電話の後に、電話でお話しした内容（スタッフのメモ）をLINEで1通にまとめて送る

【構成】
①1行目は「お電話有難うございました😊！！」（会話でスタッフが呼び名を使っていれば「〇〇さん\\n先ほどはお電話ありがとうございました😊！！」でもよい）
②電話で決まったこと・こちらがすることを「〜させて頂きます！！」で書く（例:「〜のお部屋ピックアップしお送りさせて頂きます！！」「確認出来次第ご連絡させて頂きます！！」）
③お客様にお願いすること（書類・写真・ご返事等）がメモにあれば「〜お送りの程よろしくお願い致します😌！！」
④注意点・補足（キャンセル料・審査の流れ等）がメモにあれば「※〜」で1行
⑤締めは「引き続き何卒よろしくお願い致します！！」
・内容のまとまりごとに空行を入れる。メモの箇条書きは自然な文にする（条件は「・」の箇条書きのままでもよい）

【絶対禁止】
・メモに無いこと（物件名・金額・日付・時刻・号室・条件・約束・理由）を足すこと
・メモの内容を落とすこと
・「確認させて頂きます」等のメモに無い約束
・謝罪表現（「申し訳ございません」等）・🙏 絵文字

【スタッフの実際の電話後の返信（言い回しの手本。別のお客様の話なので中身は写さない。中身は必ず【電話でお話しした内容】に従う）】
${PHONE_FOLLOWUP_STAFF_EXAMPLES.map((t, i) => `例${i + 1}:\n${t}`).join("\n\n")}

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\n で）"}`;
      const pfDynamicSuffix = `【電話でお話しした内容（スタッフのメモ・この内容だけで書く）】\n${pfNotes}`;
      // ブロック: [shared 1h] → [global ルール 1h] → [固有文＋action 別ルール 5m] → [メモ（動的）]
      const pfShared = splitSharedPrefix(pfStaticSystem);
      const pfSystemSpec: SystemSpecBlocks = {
        shared: pfShared.shared,
        semiStatic: pfRules.global.replace(/^\n\n/, ""),
        routeStatic: pfShared.routeStatic + pfRules.action,
        dynamic: pfDynamicSuffix,
      };
      const pfUser = `${recentHistory}\n\n上記の会話の後、${name}とお電話でお話ししました。【電話でお話しした内容】だけを使って、電話後のお礼とまとめの1通を生成してください。`
        + (pfKnowledge ? `\n\n${pfKnowledge}` : "")
        + (pfStarNote ? `\n\n【参考にすべき成功返信例（返信スタイルを合わせる）】\n${pfStarNote}` : "");
      const pfRaw = await callClaude(pfSystemSpec, pfUser, currentAction);
      let pfMessage = pfRaw;
      try {
        const m = pfRaw.match(/\{[\s\S]*\}/);
        if (m) pfMessage = ((JSON.parse(m[0]) as { message?: string }).message || pfRaw).replace(/\\n/g, "\n");
      } catch { /* JSON で無ければ本文そのもの */ }
      // 数字の照合: メモ（＋会話に出ていた物件・号室）に無い金額・日付・時刻・号室は〇〇（送信前チェックで止まる）
      const pfChecked = maskNumbersNotInNotes(pfMessage, `${pfNotes}\n${recentHistory}`);
      if (pfChecked.unmatched.length > 0) console.warn("[aix/action] phone_followup: メモに無い数字を伏せ字:", pfChecked.unmatched);
      return finalizeResponse(pfChecked.text, pfChecked.unmatched.length > 0
        ? { notice: `メモに無い数字（${pfChecked.unmatched.join("・")}）を〇〇にしました。電話でお話しした内容を見て書き換えてから送信してください` }
        : undefined);

    } else if (action === "guarantor_info") {
      // AIX【保証会社について】（2026-09-15 竹内・YUYA 事例）: 管理会社に確認した物件ごとの保証会社名・種類（独立系／LICC系／信販系）を一覧で案内し、
      //   審査の通りやすさを種類ごとの決まった言い回しで伝える。「並行して審査かける」ON で、かぶっていない保証会社の並行審査を勧める。
      //   会社名・種類はスタッフの入力だけ（LLM に作らせない）。conversation_match=false は固定テンプレ（LLM 0回）、true は会話に合わせた1通
      //   （入力に無い会社名・種類の表現は checkGuarantorFacts で〇〇→1回だけ作り直し→残れば notice＝送信前チェックで止まる。cost_breakdown の金額の照合と同じ考え）
      const giRaw = Array.isArray(body.properties) ? (body.properties as Array<{ name?: unknown; company?: unknown; type?: unknown }>) : [];
      // スタッフが登録した会社（guarantor_companies）: 名寄せの既定の種類と、会話から拾った別の登録会社名を伏せる走査に使う。読めなければマスタだけで動く
      let giCustoms: Array<{ name: string; type: GuarantorType }> = [];
      try {
        const { data: giRows } = await supabase.from("guarantor_companies").select("name, type");
        giCustoms = ((giRows ?? []) as Array<{ name?: string | null; type?: string | null }>)
          .map((r) => ({ name: String(r.name ?? "").trim(), type: (isGuarantorType(r.type) ? r.type : "unknown") as GuarantorType }))
          .filter((r) => r.name);
      } catch { /* テーブル未作成・接続不可でもマスタだけで動く */ }
      const giProps: GuarantorProperty[] = giRaw.map((p) => {
        const nm = String(p?.name ?? "").trim().slice(0, 100);
        const co = String(p?.company ?? "").trim().slice(0, 60);
        const r = resolveGuarantor(co, giCustoms);   // 名寄せ（正規名）と既定の種類
        const ty: GuarantorType = isGuarantorType(p?.type) ? p.type : r.type;   // 画面で選んだ種類が最優先。無ければ既定
        return { name: nm, company: r.name, type: ty };
      }).filter((p) => p.name && p.company).slice(0, 20);
      if (giProps.length === 0) throw new Error("物件名と保証会社名を1件以上入力してください");
      const giParallel = body.parallel === true;
      const giMatch = body.conversation_match === true;
      const giFacts = formatGuarantorFacts(giProps, { parallel: giParallel });
      // UI が「入力の確認」と onAfterSend（→ log-aix-usage → sent_facts）に使う
      const giExtra = { guarantor_properties: giProps, parallel_screening: giParallel, parallel_plan: giFacts.plan };

      if (!giMatch) {
        // 固定テンプレ（YUYA 9/15 17:31 の実送信の型・LLM を呼ばない）
        const giFixed = buildGuarantorInfoText({ customerName: familyName || rawName || "", properties: giProps, parallel: giParallel });
        return finalizeResponse(giFixed, { ...giExtra, fixed: true });
      }

      // 2026-09-17 竹内（AIX キャッシュ点検）: DB ルールは global（準静的・1h）と action 別（経路固有の末尾・5m）に分けてキャッシュ内へ（旧: 動的接尾で毎回割引なし）
      const [giKnowledge, giStarNote, giRules, giBrainAddendum] = await Promise.all([
        getKnowledgeForState(AIX_ACTION_TO_STATES.guarantor_info, currentAction, conversationId, latestCustomerMsg, brainContext),
        getStarredExamplesForAction(AIX_ACTION_TO_STATES.guarantor_info, latestCustomerMsg, aixBrainMeta),
        fetchPromptRulesSplit("guarantor_info", {}).catch(() => ({ global: "", action: "" })),
        loadBrainTemplate("guarantor_info"),
      ]);
      // キャッシュ最適化: 静的（GENERATION_SYSTEM/共通ルール/固定指示/スタッフの実文）と動的（物件ごとの保証会社・ブレイン・DBルール）を分ける
      const giStaticSystem = `${GENERATION_SYSTEM}

${SMORA_COMMON_RULES}

【お客様名】ユーザーメッセージに記載のお客様名を使うこと

【この返信の目的】
・管理会社に確認した物件ごとの保証会社名と種類（独立系／LICC系／信販系）を一覧で伝え、審査の通りやすさを種類に応じた決まった言い回しで説明し、（指示がある時だけ）保証会社がかぶっていないお部屋の並行審査を勧める1通を作る

【構成】
①お客様の直近の発言に質問・不安（審査が心配・保証会社はどこか・保証人は要るか 等）があれば、最初の1文でそれに直接答える（無ければ「こちら保証会社一覧となります！！」から始める）
②物件ごとの一覧: 「・物件名」を1行ずつ並べ、続けて「の保証会社は〇〇と独立系の保証会社となりますので、…」の形（同じ会社の物件は同じ段落にまとめる。会社が違えば段落を分ける）
③種類ごとの説明は【種類ごとに使ってよい言い回し】の文だけを使う（種類が「不明・その他」の物件は審査の緩い・厳しいに触れない）
④【並行審査】の指示どおり（指示が「書かない」なら並行審査に一切触れない。同じ会社の組があれば「どちらか1件の審査となります」）
⑤「よろしければお気に召されたお部屋一度審査かけさせて頂きます！！」
⑥最終行は「※保証会社審査通過後、オーナー審査移行するまでキャンセル料不要となります！！」

【言い回し】下の「スタッフの実際の返信」の口調・構成に合わせる（「〜となります！！」「審査かけさせて頂きます！！」）。内容のまとまりごとに空行

【絶対禁止】
・【物件ごとの保証会社】に無い保証会社名・種類を書くこと（会話に別の保証会社名が出ていても書かない）
・「審査通ります」「通りそうです」「必ず」等の審査通過の断言（許される言い回しは「審査通過する可能性十分に御座います」「審査無事通過する為」まで）
・保証人・緊急連絡先・年収・勤務先など審査の中身に踏み込むこと（聞かれていても「保証会社の審査となります」までにとどめる）
・内覧の候補日時・見積金額・他物件の提案・「確認させて頂きます」等の確認前の文（保証会社は確認済み）
・謝罪表現（「申し訳ございません」等）・🙏 絵文字

【スタッフの実際の返信（言い回しの手本。別のお客様・別の物件の話なので、物件名・保証会社名・種類は写さない。中身は必ず【物件ごとの保証会社】に従う）】
${GUARANTOR_INFO_STAFF_EXAMPLES.map((t, i) => `例${i + 1}:\n${t}`).join("\n\n")}

【出力形式（必須・JSONのみ・説明不要）】
{"message":"〜（実際のLINEメッセージ全文・改行は\\nで）"}`;
      const giDynamicSuffix = [
        giFacts.block,
        brainGuidanceNote ? `【ブレインの判断（この局面の方針）】${brainGuidanceNote}` : "",
        giBrainAddendum ? `【ブレイン改善ルール】\n${giBrainAddendum}` : "",
      ].filter(Boolean).join("\n\n");
      // ブロック: [shared 1h] → [global ルール 1h] → [固有文＋action 別ルール 5m] → [動的]。作り直しも同じ構成（2回目は read）
      const giShared = splitSharedPrefix(giStaticSystem);
      const giSystemSpec = (dynamic: string): SystemSpecBlocks => ({
        shared: giShared.shared,
        semiStatic: giRules.global.replace(/^\n\n/, ""),
        routeStatic: giShared.routeStatic + giRules.action,
        dynamic,
      });
      const giUser = greetingTimeNote
        + `${recentHistory}\n\n上記の会話を読み取り、${name}に物件ごとの保証会社の一覧と審査の通りやすさを案内する返信を生成してください。お客様の直近の質問・不安があれば最初の1文で答えてください。`
        + (giKnowledge ? `\n\n${giKnowledge}` : "")
        + (giStarNote ? `\n\n【参考にすべき成功返信例（返信スタイルを合わせる）】\n${giStarNote}` : "");
      const giParse = (raw: string): string => {
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) return ((JSON.parse(m[0]) as { message?: string }).message || raw).replace(/\\n/g, "\n"); } catch { /* JSON で無ければ本文そのもの */ }
        return raw;
      };
      let giMessage = giParse(await callClaude(giSystemSpec(giDynamicSuffix), giUser, currentAction));
      let giCheck = checkGuarantorFacts(giMessage, giProps, giCustoms);
      if (!giCheck.ok) {
        // 入力に無い会社名・種類の表現 → 1回だけ作り直す（同じ static system＝キャッシュ HIT）
        console.warn("[aix/action] guarantor_info: 入力に無い保証会社名・種類 → 作り直し:", giCheck.unmatched, giCheck.typeWarnings);
        const giRetrySuffix = `${giDynamicSuffix}\n\n【やり直し】前回の本文に【物件ごとの保証会社】に無い保証会社名（${giCheck.unmatched.join("・") || "なし"}）・種類の表現（${giCheck.typeWarnings.join("・") || "なし"}）が入りました。上の一覧にある会社名・種類だけで書き直してください`;
        giMessage = giParse(await callClaude(giSystemSpec(giRetrySuffix), giUser, currentAction));
        giCheck = checkGuarantorFacts(giMessage, giProps, giCustoms);
      }
      const giNotice = giCheck.ok ? null
        : `入力に無い保証会社名（${giCheck.unmatched.join("・") || "なし"}）を〇〇にしました${giCheck.typeWarnings.length ? `／種類の表現に注意（${giCheck.typeWarnings.join("・")}）` : ""}。入力した保証会社を見て書き換えてから送信してください`;
      return finalizeResponse(giCheck.cleaned, { ...giExtra, fixed: false, ...(giNotice ? { notice: giNotice } : {}) });

    } else {
      return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }

    // ⑦修正: 共通後処理（号室の先頭ゼロ除去 + 内部メモ分離）を finalize() に統一
    const { message: cleanedMessage, notice } = finalize(message_text);

    // aix_generate_log 記録（メインフロー: finalizeResponse を使わない全アクションパス）
    // C-2: fire-and-forget（.then）だとレスポンス返却後にサーバレス実行が凍結されて
    // INSERT が失われることがあるため、finalizeResponse と同じ after() パターンに統一
    if (conversationId) {
      after(async () => {
        try {
          // property_recommendation のみ: GPT-5.4-nano で物件画像から構造データを抽出
          let propertyDetails = null;
          if (currentAction === "property_recommendation" && image_url) {
            propertyDetails = await extractPropertyDetailsFromImage(String(image_url)).catch(() => null);
          }
          await supabase.from("aix_generate_log").insert({
            action_type: currentAction,
            conversation_id: conversationId,
            check_pattern: generateLogCheckPattern,
            generated_text: safeSlice(cleanedMessage, 2000),
            conditions_snapshot: conditionsSnapshot,
            ...(propertyDetails ? { property_details: propertyDetails } : {}),
          });
        } catch (e) {
          console.error("[aix/action] aix_generate_log insert failed (main):", e);
        }
      });
    }

    return NextResponse.json({
      ok: true,
      message_text: cleanedMessage,
      ...(notice ? { notice } : {}),
      ...(parsed_estimate_result ? { parsed_estimate: parsed_estimate_result } : {}),
      ...(estimate_text_result ? { estimate_text: estimate_text_result } : {}),
      // M2: 御見積書を同封したか（AixModal → onAfterSend → log-aix-usage → aix_usage_logs.estimate_sent）
      ...(estimate_sent_result ? { estimate_sent: true } : {}),
      // 各ピッカーのパーツ別生成結果（コンポーネント学習ループ用）
      ...(aiComponents ? { ai_components: aiComponents } : {}),
      // viewing_invite AIX生成ドラフト（差分学習ループ用: スタッフが編集して送った場合に差分を記録）
      ...(viewingInviteDraft ? { aiDraft: viewingInviteDraft } : {}),
      // estimate_sheet のAIカバーレター（LL-07）: フロントのプレビュー表示用 + 学習ループ用ドラフト
      ...(cover_letter ? { coverLetter: cover_letter, aiDraft: cover_letter } : {}),
      // condition_hearing のAI導入メッセージ（LL-09）: フロントのプレビュー表示用 + 学習ループ用ドラフト
      ...(hearing_intro_result ? { hearingIntro: hearing_intro_result, aiDraft: hearing_intro_result } : {}),
      // condition_hearing のフォーム本体: フロントが導入メッセージとは別に表示・送信する
      ...(hearing_form_content ? { hearing_form: hearing_form_content } : {}),
      // AIX完了後テンプレ誘導: フロントがテンプレモーダルをこのカテゴリで開く（AixModal→onAfterSend経由）
      ...(suggestTemplateCategory ? { suggest_template_category: suggestTemplateCategory } : {}),
    });
  } catch (err) {
    console.error("[aix/action]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

// ── ストリーミングラッパー ──────────────────────────────────────────────────
const SERVER_BUDGET_MS = 55_000;

export async function POST(request: NextRequest) {
  if (!request.headers.get("accept")?.includes("application/x-ndjson")) {
    return aixRequestCtx.run({ conversationId: null }, () => handleAction(request));
  }

  const encoder = new TextEncoder();
  const deadline = Date.now() + SERVER_BUDGET_MS;
  const ac = new AbortController();
  const onClientAbort = () => ac.abort(new Error("client disconnected"));
  request.signal.addEventListener("abort", onClientAbort);
  const hardStop = setTimeout(() => ac.abort(new Error("server budget 55s exceeded")), SERVER_BUDGET_MS);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (ev: AixEvent) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n")); }
        catch { closed = true; }
      };
      emit({ t: "phase", phase: "prepare", label: "情報を集めています" });

      const ctx: AixStreamCtx = { emit, deadline, signal: ac.signal, seq: 0, busy: false };
      try {
        const res = await aixRequestCtx.run({ conversationId: null }, () => aixStream.run(ctx, () => handleAction(request)));
        const resData = await (res as Response).json().catch(() => ({}));
        emit({ t: "done", payload: resData });
      } catch (err) {
        console.error("[aix/action] stream error:", err);
        const msg = err instanceof Error ? err.message : String(err);
        emit({ t: "error", error: /abort|timeout|budget/i.test(msg)
          ? "AI生成がタイムアウトしました（55秒）。もう一度お試しください"
          : msg });
      } finally {
        closed = true;
        clearTimeout(hardStop);
        request.signal.removeEventListener("abort", onClientAbort);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
