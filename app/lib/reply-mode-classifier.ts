// =====================================================================
// reply-mode-classifier.ts
// 純ルールベースの返信モード分類器（SHADOW MODE専用・ログ記録のみ）
// LLM呼び出し・supabase・外部依存なし。純関数のみ。
//
// 顧客メッセージ＋会話コンテキストから以下を判定する：
//   - mode: "text"   → テキスト返信のみ（AIX提案を抑制）
//   - mode: "aix"    → AIXアクションのみ（テキスト生成スキップ）
//   - mode: "hybrid" → 短文テキスト＋AIXアクション
//
// 判定順序: Tier 0（ステータスガード）→ Tier 1（TEXT_ONLY抑制）
//          → Tier 2（AIX_ONLY）→ Tier 3（HYBRID）→ fallback
// =====================================================================

export interface ClassifierInput {
  customerMessage: string;
  conversationStatus: string;
  recentStaffMessage?: string;
  recentHistory?: string;
}

export interface ClassifierResult {
  mode: "text" | "aix" | "hybrid";
  suggestedAction: string | null;
  matchedRule: string;
  confidence: "high" | "medium" | "low";
  shortDraft?: string;
}

// ─────────────────────────────────────────────────────────────────────
// 正規表現定義
// ─────────────────────────────────────────────────────────────────────

// Tier 1: TEXT_ONLY 抑制パターン
const CANCEL_RE = /キャンセル|辞退|他(社|の会社|で).{0,6}決(ま|め)|見送り|やめ(とき|てお)/;
const CLOSING_GREETING_RE =
  /^(こちらこそ|よろしくお願いし|ありがとうございます|承知(しま|いたしま)|了解|わかりました|かしこまりました)/;
const VIEWING_INTENT_RE = /(拝見|見てみ|確認し(ます|てみ)|見させて)/;
const RESCHEDULE_DATE_RE =
  /([0-9０-９]+月|来月|再来月|(上|中|下)旬|年明け|ボーナス後).{0,15}(連絡|ご連絡|また)/;
const APOLOGY_ONLY_RE = /^(すみません|申し訳|ごめん|遅くなり)/;
const KNOWLEDGE_QUESTION_RE =
  /審査.{0,10}(どの(くらい|位)|期間|日数|何日)|キャンセル料|手続き.{0,6}(方法|どう)|電話.{0,8}(来|かか)/;
const WAITING_SHORT_REPLY_RE = /(了解|わかりました|はい|ありがとう|お願いします)/;
const STAFF_CHECKING_RE = /確認(させて頂きます|出来次第|でき次第)/;

// Tier 2: AIX_ONLY パターン
const VIEWING_REQUEST_RE = /(内覧|内見|見学).{0,4}(したい|希望|でき|いつ|日程|調整)/;
const EXIT_SCHEDULED_RE = /(退去|退室|現在.*住|今.*住んで|入居中)/;
const VIEWING_CONFIRMED_RE =
  /([月火水木金土日]曜.{0,6}[0-9０-９]+時|[0-9０-９]+月[0-9０-９]+日).{0,15}(でお願い|で大丈夫|伺います|行きます|確定)/;
// 「よろしくお願いします」の「お願い」を誤検知しないよう、文末/単独形のみマッチ
const APPLICATION_DECIDED_RE =
  /申(し)?込(み)?(たい|ます$|で|お願い$)|決めます|決めたい|こちらで(お願い|申)/;
const APPLICATION_GREETING_GUARD_RE = /よろしくお願いし/;
const DOCS_FORM_RE = /氏名|生年月日|緊急連絡先|勤務先|年収/;
const VIEWING_AFTER_RE =
  /(内覧|内見|見学).{0,8}(終わり|でき(ました|た)|してきました|行ってきました)/;

// Tier 3: HYBRID パターン
const CONDITION_CHANGE_REQ_RE =
  /([0-9０-９]+\s*万(円)?台|万円?台|(もっと|もう少し)安|安め|安い(お?部屋|物件)|(別|他|違う)の?(お?部屋|物件)|同じ(マンション|建物|物件))/;
const REQUEST_FORM_RE =
  /(ない(です|でしょう)?か|あります|ありませんか|あれば|欲しい|希望|探して|お願い)/;
const PROPERTY_URL_RE =
  /https?:\/\/(reins\.|itandi|homes\.co|suumo|athome|lifull|chintai|rakumachi)/i;
const PROPERTY_INQUIRY_RE = /(まだありますか|空いてますか|こちらの物件|募集.*ですか)/;
const CONDITION_FORM_PATTERNS: RegExp[] = [
  /[①②③④⑤]/,
  /入居時期/,
  /家賃.{0,4}[0-9０-９万]/,
  /間取り/,
  /[0-9]LD?K/,
  /徒歩[0-9]+分/,
];
const CONDITION_CHANGE_RE =
  /(もっと|もう少し|さらに).{0,6}(安|広|抑え)|やっぱり.*間取り|エリア.{0,6}(広げ|変え)|家賃.{0,8}(上げ|下げ|抑え)/;
const ESTIMATE_REQUEST_RE = /(初期費用|見積|費用.*教え|いくら.*かかる)/;
const NEGOTIATION_FAILED_STAFF_RE = /(難しい状況|必須.*となっております|できかね)/;
const NEGOTIATION_ACK_RE = /(そうですか|了解|わかりました|残念)/;
const CONSIDERING_RE = /(検討(します|させて)|また.*連絡|少し.*考え)/;

// 直近履歴に物件情報（URL or 画像）が含まれるか
const HISTORY_PROPERTY_RE =
  /https?:\/\/(reins\.|itandi|homes\.co|suumo|athome|lifull|chintai|rakumachi)|物件|お部屋|号室/i;
const HISTORY_IMAGE_RE = /\[画像\]|\[image\]|image\/(jpeg|png)|スクリーンショット|写真/i;

// ─────────────────────────────────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────────────────────────────────

function hasImage(recentHistory?: string): boolean {
  if (!recentHistory) return false;
  return HISTORY_IMAGE_RE.test(recentHistory);
}

function hasPropertyInHistory(recentHistory?: string): boolean {
  if (!recentHistory) return false;
  return HISTORY_PROPERTY_RE.test(recentHistory);
}

function countConditionFormHits(msg: string): number {
  let hits = 0;
  for (const re of CONDITION_FORM_PATTERNS) {
    if (re.test(msg)) hits++;
  }
  return hits;
}

function textOnly(matchedRule: string, confidence: ClassifierResult["confidence"] = "high"): ClassifierResult {
  return { mode: "text", suggestedAction: null, matchedRule, confidence };
}

// ─────────────────────────────────────────────────────────────────────
// メイン分類器
// ─────────────────────────────────────────────────────────────────────

export function classifyReplyMode(input: ClassifierInput): ClassifierResult {
  const msg = (input.customerMessage || "").trim();
  const status = input.conversationStatus || "";
  const staffMsg = input.recentStaffMessage || "";
  const history = input.recentHistory;

  // ═══ Tier 0: ステータスガード（成約済み・契約中はAIX不要）═══
  if (status === "closed_won" || status === "contract") {
    return textOnly("status_closed_won");
  }

  // ═══ Tier 1: TEXT_ONLY 抑制ルール（AIX提案より先に必ずチェック）═══

  // キャンセル・辞退・他決
  if (CANCEL_RE.test(msg)) {
    return textOnly("suppress_cancel");
  }

  // 締めの挨拶（短文・疑問符なし）
  if (msg.length <= 25 && CLOSING_GREETING_RE.test(msg) && !msg.includes("？") && !msg.includes("?")) {
    return textOnly("suppress_closing_greeting");
  }

  // F4: 「拝見します」等 顧客が資料を見る意思表示（直近に物件送付あり）
  if (VIEWING_INTENT_RE.test(msg) && hasPropertyInHistory(history)) {
    return textOnly("suppress_viewing_intent");
  }

  // F2: 具体的な再連絡時期の提示（「来月また連絡します」等）
  if (RESCHEDULE_DATE_RE.test(msg)) {
    return textOnly("suppress_reschedule_date");
  }

  // D: 謝罪のみ（他の意図なし・短文）
  if (APOLOGY_ONLY_RE.test(msg) && msg.length <= 30) {
    return textOnly("suppress_apology_only");
  }

  // 手続き・知識系の質問（審査期間・キャンセル料等）
  if (KNOWLEDGE_QUESTION_RE.test(msg)) {
    return textOnly("suppress_knowledge_question");
  }

  // W: スタッフ確認中への短い相槌
  if (
    msg.length <= 15 &&
    WAITING_SHORT_REPLY_RE.test(msg) &&
    STAFF_CHECKING_RE.test(staffMsg)
  ) {
    return textOnly("suppress_waiting_reply");
  }

  // ═══ Tier 2: AIX_ONLY ルール（テキスト生成をスキップ）═══

  // 内覧希望（退去予定/入居中は除外）
  if (VIEWING_REQUEST_RE.test(msg) && !EXIT_SCHEDULED_RE.test(msg)) {
    return {
      mode: "aix",
      suggestedAction: "viewing_invite",
      matchedRule: "aix_viewing_schedule",
      confidence: "high",
      shortDraft: "",
    };
  }

  // 内覧日時確定（「土曜14時でお願いします」等）
  if (VIEWING_CONFIRMED_RE.test(msg)) {
    return {
      mode: "aix",
      suggestedAction: "meeting_place",
      matchedRule: "aix_viewing_confirmed",
      confidence: "high",
      shortDraft: "",
    };
  }

  // 申込意思の表明（「よろしくお願いします」単体は除外）
  if (APPLICATION_DECIDED_RE.test(msg) && !APPLICATION_GREETING_GUARD_RE.test(msg)) {
    return {
      mode: "aix",
      suggestedAction: "application_push",
      matchedRule: "aix_application_decided",
      confidence: "high",
      shortDraft: "",
    };
  }

  // 申込フォーム本文の受信（氏名・生年月日等）
  if (DOCS_FORM_RE.test(msg)) {
    return {
      mode: "aix",
      suggestedAction: "docs_request",
      matchedRule: "aix_docs_request_needed",
      confidence: "high",
      shortDraft: "",
    };
  }

  // 内覧完了報告（申込フェーズ中）
  if (status === "applying" && VIEWING_AFTER_RE.test(msg)) {
    return {
      mode: "aix",
      suggestedAction: "greeting_viewing",
      matchedRule: "aix_viewing_after",
      confidence: "high",
      shortDraft: "",
    };
  }

  // ═══ Tier 3: HYBRID ルール（短文テキスト＋AIX）═══

  // 同一マンション内・別号室/別価格帯の依頼（提案中フェーズ限定）
  if (
    status === "proposing" &&
    CONDITION_CHANGE_REQ_RE.test(msg) &&
    REQUEST_FORM_RE.test(msg)
  ) {
    return {
      mode: "hybrid",
      suggestedAction: "property_recommendation",
      matchedRule: "hybrid_same_building",
      confidence: "high",
      shortDraft: "ございます！！\n少々お待ちください！！",
    };
  }

  // 物件URL・画像・空室確認の問い合わせ
  if (PROPERTY_URL_RE.test(msg) || hasImage(history) || PROPERTY_INQUIRY_RE.test(msg)) {
    return {
      mode: "hybrid",
      suggestedAction: "acknowledge_check",
      matchedRule: "hybrid_property_url",
      confidence: "medium",
      shortDraft: "",
    };
  }

  // 条件フォーム回答（①②③形式・入居時期・家賃等 2項目以上）
  if (countConditionFormHits(msg) >= 2) {
    return {
      mode: "hybrid",
      suggestedAction: "property_send",
      matchedRule: "hybrid_condition_form",
      confidence: "high",
      shortDraft: "",
    };
  }

  // 条件変更の依頼（「もっと安く」「エリア広げて」等）
  if (CONDITION_CHANGE_RE.test(msg)) {
    return {
      mode: "hybrid",
      suggestedAction: "property_send",
      matchedRule: "hybrid_condition_change",
      confidence: "medium",
      shortDraft: "",
    };
  }

  // 初期費用・見積もりの依頼
  if (ESTIMATE_REQUEST_RE.test(msg)) {
    return {
      mode: "hybrid",
      suggestedAction: "estimate_sheet",
      matchedRule: "hybrid_estimate_request",
      confidence: "high",
      shortDraft: "",
    };
  }

  // 交渉不成立後の短い相槌 → 内覧へ切り替え提案
  if (
    NEGOTIATION_FAILED_STAFF_RE.test(staffMsg) &&
    msg.length < 30 &&
    NEGOTIATION_ACK_RE.test(msg)
  ) {
    return {
      mode: "hybrid",
      suggestedAction: "viewing_invite",
      matchedRule: "hybrid_negotiation_failed",
      confidence: "medium",
      shortDraft: "",
    };
  }

  // 検討します（具体的な再連絡時期なし）→ クロージング提案
  // ※ RESCHEDULE_DATE_RE は Tier 1 で先に判定済みだが、明示的に二重ガード
  if (CONSIDERING_RE.test(msg) && !RESCHEDULE_DATE_RE.test(msg)) {
    return {
      mode: "hybrid",
      suggestedAction: "application_push",
      matchedRule: "hybrid_considering",
      confidence: "medium",
      shortDraft: "",
    };
  }

  // ═══ Fallback: どのルールにも該当しない → 通常テキスト生成 ═══
  return { mode: "text", suggestedAction: null, matchedRule: "fallback", confidence: "low" };
}
