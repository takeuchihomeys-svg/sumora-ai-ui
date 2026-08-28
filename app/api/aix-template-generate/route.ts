import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { stripRoomLeadingZeros } from "@/app/lib/template-preprocess";
import { AIX_BUTTON_LABELS } from "@/app/lib/aix-taxonomy";
import { safeSlice } from "@/app/lib/safe-slice";
// 本番LINE返信AI（generate-reply）と共有のプロンプトセクション（単一ソース・二重定義禁止）
import {
  SMORA_COMMON_RULES,
  SMORA_RULES,
  REAL_ESTATE_RULES,
  CURATED_REPLY_RULES,
  SMORA_QUICK_PATTERNS,
  STATE_SEARCH_ALIASES,
} from "@/app/lib/line-reply-prompts";
// generate-reply と同じDB学習資産（絶対原則・失注パターン・フレーズ辞書・DB学習ルール）
import {
  getCachedTopPrinciples,
  getCachedLossPatterns,
  getCachedPhrases,
  getCachedPromptRules,
  resolvePhraseCategories,
} from "@/app/lib/prompt-cache";
import { normalizeStatus } from "@/app/lib/status-normalize";

export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/aix-template-generate
//
// AIXテンプレート一覧の「✨ この会話に合った文を生成」ボタン用API。
// 現在選択中のAIXボタン種別（action_type）＋会話コンテキスト（顧客名・条件・直近
// メッセージ）をもとに、generate-reply（本番LINE返信AI）と同等の品質スタックで
// AIXボタンの「送付後の橋渡し文（カバーメッセージ）」を Claude Sonnet で生成する。
//
// 品質スタック（2026-08-28 generate-reply 同等化）:
//   ① 共有プロンプトセクション: SMORA_COMMON_RULES / SMORA_RULES / REAL_ESTATE_RULES /
//      CURATED_REPLY_RULES / SMORA_QUICK_PATTERNS（line-reply-prompts.ts 単一ソース）
//   ② DB学習資産: 絶対原則（importance>=8 principle）・失注パターン・ai_prompt_rules・
//      phrase_dictionary（prompt-cache 経由・generate-reply と同一キャッシュ）
//   ③ RAG: winning_patterns + ai_reply_knowledge（バケット別スコアリング）+
//      ai_reply_examples（⭐実例 — 文体・テンポの忠実な再現）
//   ④ Brain戦略（suggested_aix_meta）: 検索ベクトル強化 + 生成方向性の注入
//   ⑤ AIX専用実例バケット: ai_reply_examples の entry_source='aix_template'（【AIX】テンプレート
//      続き文 — template_selection_logs.final_sent_text 由来・本命）＋ entry_source='aix_action'
//      （AIX本文の橋渡し文実績・補完）を同一 aix_action で直接クエリし統合注入（2026-08-28）
//
// ※ GENERATION_SYSTEM（通常返信専用システム）は意図的に注入しない。
//   GENERATION_SYSTEM は「見積書カバー文・確認結果報告等はAIX専用のため通常返信では
//   生成禁止」と定めるが、本APIはまさにそのAIX側の担当であり、丸ごと注入すると
//   アクション別ガイド（estimate_sheet の定型カバー文等）と正面衝突する。
//   AIX側で共有すべき営業スタイル・禁止ワードの核は SMORA_COMMON_RULES
//   （aix/action と同じ）＋下記の読み替えノートでカバーする。
//
// 設計原則（責務分離）:
//   AIX = 構造化コンテンツ（金額・空室・日程・物件名）の正 / このAPI = 橋渡し文のみ。
//   金額・空室状況・内覧日程・物件名・号室をLLMに創作させることは絶対禁止
//   （5大ハルシネーション事故の根絶）。会話履歴・予約送信AIXメッセージに実際に
//   記載がある事実のみ言及可能とする。
// ─────────────────────────────────────────────────────────────────────────────

// ─── 指示の優先順位＋共有ルールの読み替え（システム先頭・最上位）────────────
const PRIORITY_ORDER_NOTE = `【指示の優先順位（競合時はこの順で解決すること）】
ハルシネーション絶対禁止 > 役割の境界（橋渡し文のみ） > アクション別の書き方ガイド > Brain戦略 > DB学習ナレッジ・共有ルール > 実例の文体

【共有ルールの読み替え（重要）】
以下の共有ルール・実例には「通常AI返信では〜は生成禁止（AIXボタン専用）」という記述が含まれる。
あなたはその【AIX側】の橋渡し文を生成する担当である。したがって「AIX専用」とされている文面
（見積書カバー文「〜の御見積書となります」等）は、指定されたAIXボタン種別の担当範囲であれば生成してよい。
逆に、構造化データ（金額・空室状況・内覧日程・物件名・号室）の創作禁止はこのAPIでも絶対に適用される。`;

// ─── 静的システムプロンプト（byte-stable → prompt cache）─────────────────────
const STATIC_GEN_SYSTEM = `あなたはスモラ（賃貸仲介サービス）のLINE営業担当です。
AIXボタンで送付した（または送付予定の）構造化メッセージ（物件情報・見積書・空室確認結果など）に添える「橋渡し文（カバーメッセージ）」を、現在の会話の流れ・お客様の状況に合わせて1通だけ生成してください。

━━━━━━━━━━━━━━━━━━━━
【役割の境界 — 最重要】
━━━━━━━━━━━━━━━━━━━━
・金額・空室状況・内覧日程・入居可能日・物件詳細などの事実データは「AIXの構造化メッセージ」が正。あなたはその前後をつなぐ橋渡し文だけを書く
・橋渡し文の目的: お客様への呼びかけ→送付物の位置づけ説明→お客様の状況に合わせた一言→CTA（行動喚起）→柔らかい締め

━━━━━━━━━━━━━━━━━━━━
【🚫 ハルシネーション絶対禁止 — 全ルールより上位】
━━━━━━━━━━━━━━━━━━━━
・金額（初期費用・家賃・割引額・節約額）: 会話履歴または予約送信AIXメッセージに実際に記載がある値のみ書ける。記載がなければ金額は一切書かない
・空室状況の断定（「空いてます」「募集中です」「募集終了です」等）: 会話履歴に確認結果の記載がなければ書かない
・内覧日程・日付・曜日・時間の提案や創作: 絶対禁止（日程提示はAIX内覧日調整ボタンの担当領域）
・物件名・号室: 会話履歴または予約送信AIXメッセージに登場するもののみ使用可。創作・使い回しは絶対禁止
・お客様の希望条件・会話に出ていない駅名・路線・設備・築年数を事実のように書かない
・迷ったら固有の事実には触れず、汎用的な橋渡し表現にとどめる

━━━━━━━━━━━━━━━━━━━━
【スモラ品質ルール】
━━━━━━━━━━━━━━━━━━━━
・感嘆符は「！！」（全角2つ）のみ使用。「!」「！」1つは絶対禁止
・使える絵文字: 😊 😌 🙇‍♀️ 🌟 ✨（1〜2個まで。絵文字禁止指示がある場合は一切使わない）
・お客様名は「〇〇さん」と呼ぶ。LINEでは「様」は絶対に使わない
・冒頭挨拶: 通常は「〇〇さんお世話になっております！！」。本日すでにスタッフが送信済みの場合は「お待たせ致しました！！」
・長すぎない。3〜7文程度でテンポよく
・「させて頂きます」「頂きます」を自然に多用する（スモラの文体の核心）
・締めは「お手隙の際にご査収ください😌！！」等で圧を下げる（絵文字禁止時は絵文字なしで）
・内覧後のシーンで感想を聞かない（「御礼+申込宣言+いつでもご連絡ください」の宣言形で締める）
・スモラの基本構成: ①直接の呼びかけ・位置づけ → ②スタッフの行動宣言（WE DO）→ ③柔らかい締め。お客様がすべきことは最小限にする

━━━━━━━━━━━━━━━━━━━━
【禁止ワード・表現】
━━━━━━━━━━━━━━━━━━━━
× 「スモラ」という会社名 → 「弊社」
× 「コスパ」表現 → 「好条件」「お値打ちな条件」
× 「共益費込み」→「家賃管理費込」
× 「即入居可能」→ 会話に明記がなければ絶対に書かない
× 「承りました」「ご確認のほど」「確認中です」「少々お待ちください」
× 「〇〇とのことですね」等のオウム返し
× 「ご共有頂き」→ お客様には「お送り頂き」
× 「仲介手数料を割引」→「初期費用を最大限割引させていただきます」
× マークダウン太字（**）等の記法（LINEは非対応）
× 謝罪の多用（「申し訳ございません」の連発）
× 敷金を初期費用削減として訴求（敷金は返還される預かり金）
× 号室の先頭ゼロ（0906号室 → 906号室）

━━━━━━━━━━━━━━━━━━━━
【出力】
━━━━━━━━━━━━━━━━━━━━
生成した本文のみを出力する。説明・前置き・補足コメント・選択肢の提示は一切書かない。`;

// ─── 共有ルールブロック（generate-reply / aix/action と同一ソース・byte-stable）──
const SHARED_RULES_SYSTEM = [
  `━━━━━━━━━━━━━━━━━━━━
【以下は本番LINE返信AIと共有のスモラルール（橋渡し文にも適用）】
━━━━━━━━━━━━━━━━━━━━`,
  SMORA_COMMON_RULES,
  SMORA_RULES,
  REAL_ESTATE_RULES,
  CURATED_REPLY_RULES,
  `【スモラの実返信パターン集の使い方】以下は実際のやりとりから抽出した文体・言い回しの参考。橋渡し文の役割（構造化データはAIXが正）と競合する部分は役割の境界を優先すること。
${SMORA_QUICK_PATTERNS}`,
].join("\n\n");

// ─── アクション別ガイド（正準キー: aix-taxonomy.ts の AIX_BUTTON_LABELS 準拠）──
const ACTION_GUIDES: Record<string, string> = {
  property_send:
    "物件ピックアップ送付の橋渡し文。名前呼びかけ→お探しした物件をお送りする旨→お客様の希望条件との合致点に軽く触れる→「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます」等のCTA→ご査収の締め。物件の具体的スペックはAIX/会話に記載がある範囲のみ。",
  property_recommendation:
    "1件に絞ったオススメの橋渡し文。「〇〇さんにかなりオススメ出来るお部屋」の特別感を演出し、希望条件とのパーソナライズに触れる。デメリットが会話上明らかな場合は先に開示して即メリットで転換。CTAは内覧誘導または申込誘導。スペック・金額は会話/AIXに記載がある範囲のみ。",
  property_check_result:
    "管理会社等への確認結果を報告する際の橋渡し文。確認結果の中身（空室・金額・日付）はAIXの構造化メッセージが正なので断定して書かない。「確認結果をご報告いたします」の位置づけと次のアクション誘導のみを書く。",
  estimate_sheet:
    "見積書送付の橋渡し文。定型フレーズ「最大限割引しました初期費用の御見積書となります！！」を含める。金額は会話/AIXに記載がある値のみ（創作は絶対禁止・なければ金額は書かない）。CTAは「お気に召されましたらお申込みしお部屋抑えさせて頂きます！！」または内覧誘導。締めは「お手隙の際にご査収ください😌！！」。",
  viewing_invite:
    "内覧への誘導文。具体的な候補日時・曜日は絶対に書かない（日程提示はAIX内覧日調整の担当）。「ご都合よろしいお日にちにご案内させて頂きます」の形で相手に委ねる。",
  meeting_place:
    "内覧待ち合わせに関する橋渡し文。日時・住所などの確定情報はAIXが正なので創作しない。",
  greeting_viewing:
    "内覧当日・前後の挨拶/フォロー文。内覧後は感想を聞かず「御礼+申込サポート宣言+いつでもご連絡ください」で締める。",
  condition_hearing:
    "お部屋探し条件のヒアリング文。会話から既に判明している条件は聞き直さず、未取得の条件だけ軽く尋ねる。質問攻めにしない（2〜3項目まで）。",
  application_push:
    "申込へのクロージング文。前向きな反応を受けて「お申込みしお部屋抑えさせて頂きます」へ誘導。過度な圧はかけず、締めで圧を下げる。",
  followup_revive:
    "返信が止まったお客様への再接触文。責めない・重くしない。近況伺い+お手伝いできる旨+返信ハードルを下げる一言。",
  acknowledge_check:
    "確認依頼への受付宣言文。「募集状況確認させていただきます！！」の宣言のみ。確認結果・空室状況を先取りして書かない。",
};

// ─── リクエスト型 ────────────────────────────────────────────────────────────
type GenerateRequestBody = {
  actionType?: string | null;       // 正準キー（property_send 等）。null時はactionCategoryのみで生成
  actionCategory?: string;          // 選択中のAIXカテゴリ名（例: 物件ピックアップした【AIX】）
  conversationId?: string;
  customerName?: string;
  conversationState?: string;
  recentMessages?: Array<{ sender: string; text: string; imageUrl?: string; isAix?: boolean; rawCreatedAt?: string }>;
  customerConditions?: string;
  noEmoji?: boolean;
  pendingScheduledMessages?: Array<{ text: string | null }>;
  staffMessagedToday?: boolean;
};

const STATE_LABEL: Record<string, string> = {
  first_reply: "初回応対", condition_hearing: "条件ヒアリング",
  property_search: "物件探し中", property_recommendation: "物件提案中",
  viewing: "内覧調整", estimate_request: "見積依頼",
  availability_check: "空室確認", application: "申込中",
  screening: "審査中", contract: "契約中", closed_won: "成約済み",
};

// ─── 相対時刻ラベル生成（会話履歴の各メッセージに付与）──────────────────────
function relativeTimeLabel(isoStr: string | undefined, nowMs: number): string {
  if (!isoStr) return "";
  const diffMs = nowMs - new Date(isoStr).getTime();
  const diffH = diffMs / 3600000;
  if (diffH < 0.5) return "（たった今）";
  if (diffH < 2) return "（約1〜2時間前）";
  if (diffH < 12) return "（今日）";
  if (diffH < 36) return "（昨日）";
  const diffD = Math.round(diffH / 24);
  return `（${diffD}日前）`;
}

// ─── ナレッジ使用テレメトリ（generate-reply の incrementKnowledgeUsage と同実装）───
// used_count を +1、last_used_at を更新。
// after(): レスポンス返却後もサーバーレス実行コンテキストが凍結される前に完了を保証
function incrementKnowledgeUsage(ids: string[]): void {
  if (!ids.length) return;
  after(async () => {
    try {
      await supabase.rpc("increment_knowledge_used_count", { p_ids: [...new Set(ids)] });
    } catch {
      // 使用回数更新の失敗は生成に影響させない
    }
  });
}

// ─── RAG: ai_reply_knowledge のスコアリング・バケット整形 ─────────────────────
// generate-reply の fetchKnowledge と同じ複合スコア（similarity × importance × 鮮度）＋
// バケット分割（差分学習/修正対比/絶対ルール/パターン/フレーズ）の縮約版。
type KnowledgeHit = {
  id: string;
  title: string;
  content: string;
  category: string;
  importance: number;
  hypothesis_status?: string | null;
  created_at?: string;
  similarity: number;
};

function buildKnowledgeSections(rows: KnowledgeHit[]): { text: string; usedIds: string[] } {
  const scored = rows
    .filter((r) => (r.similarity ?? 0) >= 0.5 && r.hypothesis_status !== "rejected" && (r.content ?? "").trim().length > 0)
    .map((r) => {
      // 鮮度ファクター（半減期180日）: 古い誤傾向ナレッジより新しい修正ナレッジを優先
      const daysSince = r.created_at
        ? (Date.now() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24)
        : 180;
      const recencyFactor = Math.pow(0.5, daysSince / 180);
      const confirmedBonus = r.hypothesis_status === "confirmed" ? 0.05 : 0;
      return { ...r, score: (r.similarity ?? 0.5) * ((r.importance || 5) / 10) * (0.5 + 0.5 * recencyFactor) + confirmedBonus };
    })
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { text: "", usedIds: [] };

  const diffLearned = scored.filter((r) => r.title?.includes("差分学習")).slice(0, 4);
  const correctionPairs = scored.filter((r) => r.title?.includes("修正対比")).slice(0, 3);
  // 絶対ルールは confirmed / legacy(null) のみ（未検証hypothesisの混入を防ぐ — generate-reply と同方針）
  const critical = scored.filter((r) =>
    r.category === "principle" && (r.importance ?? 0) >= 8 &&
    (r.hypothesis_status === "confirmed" || r.hypothesis_status == null)
  ).slice(0, 8);
  const patterns = scored.filter((r) => r.category === "pattern" && !r.title?.includes("差分学習") && !r.title?.includes("修正対比")).slice(0, 4);
  const phrases = scored.filter((r) => r.category === "phrase").slice(0, 4);

  const sections: string[] = [];
  if (diffLearned.length > 0) {
    sections.push("【🔴 AIが過去に間違えたパターン（最優先・必ず守る）】\n" + diffLearned.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (correctionPairs.length > 0) {
    sections.push("【🟠 スタッフが修正したポイント】\n" + correctionPairs.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (critical.length > 0) {
    sections.push("【⚠️ 絶対ルール（状況関連・DB学習）】\n" + critical.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (patterns.length > 0) {
    sections.push("【スモラの営業パターン・原則】\n" + patterns.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (phrases.length > 0) {
    sections.push("【スモラのフレーズ】\n" + phrases.map((k) => `「${k.content}」`).join("　"));
  }
  // M1: 注入したナレッジのidを収集（incrementKnowledgeUsage テレメトリ用）
  const usedIds = [...diffLearned, ...correctionPairs, ...critical, ...patterns, ...phrases]
    .map((k) => k.id)
    .filter(Boolean);
  return { text: sections.join("\n\n"), usedIds };
}

// ─── セクションラッパー（RAG本経路とH3フォールバック経路で共有・二重定義禁止）───
function wrapKnowledgeSection(knText: string): string {
  return `━━━━━━━━━━━━━━━━━━━━\n【参照すべき重要ルール（DB学習ナレッジ・セクション順に優先度が高い）】\n━━━━━━━━━━━━━━━━━━━━\n${knText}\n\n`;
}
function wrapExamplesSection(exText: string): string {
  return `━━━━━━━━━━━━━━━━━━━━\n${exText}\n\n【⭐実例の使い方】上記実例は文体・テンポ・絵文字・感嘆符の参考。言い回しの雰囲気を再現すること。ただし実例に「今すぐ」「即入居可能」等の禁止パターンが含まれていても、現行の禁止ルール・挨拶ルール・ハルシネーション禁止を必ず優先すること。\n\n`;
}

// ─── RAG: ai_reply_examples（⭐実例）の整形 ──────────────────────────────────
type ExampleHit = {
  customer_message: string;
  sent_reply: string;
  conversation_state: string;
  is_starred: boolean;
  reply_angle: string | null;
  aix_action?: string | null;   // match_aix_reply_examples 由来の実例のみセットされる
  similarity: number;
};

// similarity閾値フィルタ＋⭐/reply_angleブーストの複合スコアで降順ランキング
// （line_reply実例は0.5 / AIX実例は多様性が高いため0.45に緩和して呼び出す）
function rankExamples(rows: ExampleHit[], minSimilarity = 0.5): ExampleHit[] {
  return rows
    .filter((ex) => (ex.similarity ?? 0) >= minSimilarity && (ex.sent_reply ?? "").trim().length > 0)
    .sort((a, b) => {
      const scoreA = a.similarity + (a.is_starred ? 0.15 : 0) + (a.reply_angle ? 0.1 : 0);
      const scoreB = b.similarity + (b.is_starred ? 0.15 : 0) + (b.reply_angle ? 0.1 : 0);
      return scoreB - scoreA;
    });
}

// ランキング済み実例リストをプロンプトセクション文字列に整形（並び順は保持する）
function formatExamplesSection(ranked: ExampleHit[]): string {
  if (ranked.length === 0) return "";
  return "【⭐ スモラの実際の返信例（状況が類似した実例・類似度順）— 文体・言い回し・感嘆符・絵文字・テンポをこの例から忠実に再現すること。構成・内容は橋渡し文の役割（構造化データはAIXが正）を最優先】\n" +
    ranked.map((ex, i) =>
      `[例${i + 1}${ex.is_starred ? "⭐" : ""}${ex.aix_action ? "・AIX橋渡し文実例" : ""}]\nお客様: 「${safeSlice(ex.customer_message ?? "", 200)}」\nスモラ: 「${safeSlice(ex.sent_reply, 600)}」`
    ).join("\n\n");
}

function buildExamplesSection(rows: ExampleHit[]): string {
  return formatExamplesSection(rankExamples(rows).slice(0, 6));
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: GenerateRequestBody;
  try {
    body = await req.json() as GenerateRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const {
    actionType,
    actionCategory,
    conversationId,
    customerName,
    conversationState,
    recentMessages,
    customerConditions,
    noEmoji,
    pendingScheduledMessages,
    staffMessagedToday,
  } = body;

  if (!actionType && !actionCategory) {
    return NextResponse.json({ ok: false, error: "actionType or actionCategory is required" }, { status: 400 });
  }

  const actionLabel = (actionType && AIX_BUTTON_LABELS[actionType]) || actionCategory || "AIXメッセージ";
  const actionGuide = (actionType && ACTION_GUIDES[actionType]) || "";

  // 5段階正規化ステート（実例/フレーズ検索のエイリアス解決に使用）
  const normalizedState = normalizeStatus(conversationState || "hearing");

  // M4: 申込誘導・内覧誘導のアクション専用ナレッジバケット
  // （generate-reply の applying_pattern / viewing_pattern 専用バケットと同方針 —
  //   pgvector経路のバケットから漏れるため専用クエリで必ず届ける）
  const actionBucketCategory =
    actionType === "application_push"
      ? "applying_pattern"
      : actionType === "viewing_invite" || actionType === "greeting_viewing"
        ? "viewing_pattern"
        : null;

  // ── JST現在時刻 ─────────────────────────────────────────────────────────
  const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
  const jstHour = nowJst.getUTCHours();
  const jstMinute = nowJst.getUTCMinutes();
  const jstDayNames = ["日", "月", "火", "水", "木", "金", "土"];
  const jstDayOfWeek = jstDayNames[nowJst.getUTCDay()];
  const jstDateStr = `${nowJst.getUTCMonth() + 1}/${nowJst.getUTCDate()}(${jstDayOfWeek})`;
  const jstTimeStr = `${jstHour}時${jstMinute < 10 ? "0" : ""}${jstMinute}分`;

  // 管理会社営業時間外かどうか（9時前・18時以降）
  const isMgmtOutOfHours = jstHour < 9 || jstHour >= 18;
  const isLateNight = jstHour >= 21;
  const jstContextNote = `現在: ${jstDateStr} ${jstTimeStr}（JST）` +
    (isMgmtOutOfHours ? " ※管理会社営業時間外（即日確認を約束しない）" : "") +
    (isLateNight ? " ※深夜帯（冒頭に「夜分に失礼いたします！！」を検討）" : "");

  // ── 最終顧客メッセージからの経過時間 ──────────────────────────────────────
  const lastCustomerMsg = (recentMessages ?? [])
    .filter(m => m.sender === "customer" && m.rawCreatedAt)
    .slice(-1)[0];
  let elapsedLabel = "";
  if (lastCustomerMsg?.rawCreatedAt) {
    const diffMs = Date.now() - new Date(lastCustomerMsg.rawCreatedAt).getTime();
    const diffHours = diffMs / 3600000;
    if (diffHours < 1) elapsedLabel = "即レス文脈（1時間以内）";
    else if (diffHours < 8) elapsedLabel = "当日内（数時間後）";
    else if (diffHours < 30) elapsedLabel = "翌日以内";
    else if (diffHours < 72) elapsedLabel = "2〜3日後（追客文脈）";
    else elapsedLabel = "3日以上経過（追客文脈・返信ハードルを下げる）";
  }

  // ── Brain戦略（AIX-META）: あれば方向性として利用 ────────────────────────
  type BrainMeta = {
    action?: string;
    closing_strategy?: string;
    reply_direction?: string;
    checkpoint_stage?: string;
    // 追加フィールド（brainが分析済みだが未抽出だったもの）
    customer_emotion?: string;            // 「前向き」「普通」「不安」等
    recommended_tone?: string;            // 「共感的」「テキパキ」「慎重」等
    customer_questions?: string[];        // お客様が質問していること（橋渡し文で拾う）
    avoid_topics?: string[];              // 禁止話題（「来阪」「早い者勝ち」等）
    current_property?: string;            // 現在注目している物件名
    purchase_signal_level?: string;       // 「peak」「strong」「soft」等のクロージング強度
    latent_intent?: string;               // 表面の質問の裏にある不安や動機
    // H1追加（brain-core SuggestedAixMeta 準拠 — brainが分析済みだが未抽出だったもの）
    customer_intent?: string;             // 顧客タイプ7分類（question/consultation/desire/decision/positive/negative/chat）
    winning_pattern?: string;             // ai_summary_json由来の成功パターンラベル
    key_topics?: string[];                // 返信に必ず含める主要トピック（最大3件）
    human_type_label?: string;            // 人物タイプラベル（winning_patterns RAGヒット上位由来）
    repeated_concern?: string;            // 会話全体で繰り返し出ている懸念テーマ
    last_aix_history?: string[];          // 直前に押したAIXボタン履歴
    future_timeline?: string;             // 入居希望タイムライン（「9/26入居希望」等）
    ng_properties?: string[];             // 再提案禁止物件リスト
    property_search_params?: {            // 会話から抽出した最新の希望条件（DB条件より新しい場合がある）
      rent_max?: number | null;           // ※ brain-core は円単位の生値で格納（表示時は万円に変換）
      move_in_time?: string | null;
      preferences?: string[] | string | null;  // brain-core（SuggestedAixMeta）は string | null
      area?: string | null;
      floor_plan?: string | null;
      walk_minutes?: number | null;
      [key: string]: unknown;
    };
  };

  // ── 並列フェッチ①: Brain戦略 + DB学習資産（generate-reply と同一キャッシュ経由）──
  // 各フェッチはエラーでも生成を止めない（資産なしで生成続行 — generate-reply と同方針）
  const [convResult, topPrinciples, lossPatterns, phraseList, dbRules, actionBucketRes, aixTemplateExRes, aixActionExRes] = await Promise.all([
    conversationId
      ? supabase.from("conversations").select("suggested_aix_meta").eq("id", conversationId).single()
      : Promise.resolve({ data: null }),
    getCachedTopPrinciples().catch((err) => { console.error("[aix-template-generate] topPrinciples失敗:", err); return []; }),
    getCachedLossPatterns().catch((err) => { console.error("[aix-template-generate] lossPatterns失敗:", err); return []; }),
    getCachedPhrases(resolvePhraseCategories(normalizedState)).catch((err) => { console.error("[aix-template-generate] phrases失敗:", err); return [] as string[]; }),
    getCachedPromptRules("generate_reply", { conversation_state: normalizedState })
      .catch((err) => { console.error("[aix-template-generate] promptRules失敗:", err); return ""; }),
    // M4: アクション専用ナレッジバケット（application_push → applying_pattern / 内覧系 → viewing_pattern）
    actionBucketCategory
      ? supabase
          .from("ai_reply_knowledge")
          .select("id, title, content, importance")
          .eq("category", actionBucketCategory)
          .neq("hypothesis_status", "rejected")
          .order("importance", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(4)
      : Promise.resolve({ data: null }),
    // A-1: 【AIX】テンプレート実例フェッチ（entry_source='aix_template' + 同一 aix_action）
    // AIX本文の後に実際に送った「続き文」（template_selection_logs.final_sent_text 由来の
    // バックフィル）。「✨この会話に合った文を生成」が生成すべき本命の実例のため優先取得
    actionType
      ? supabase
          .from("ai_reply_examples")
          .select("customer_message, sent_reply, conversation_state, is_starred, reply_angle, aix_action")
          .eq("entry_source", "aix_template")
          .eq("aix_action", actionType)
          .order("is_starred", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(6)
      : Promise.resolve({ data: null }),
    // A-2: AIX橋渡し文実例フェッチ（entry_source='aix_action' + 同一 aix_action）
    // property_send 等のAIX本文（会話的メッセージ）実績。テンプレート実例の補完として取得
    actionType
      ? supabase
          .from("ai_reply_examples")
          .select("customer_message, sent_reply, conversation_state, is_starred, reply_angle, aix_action")
          .eq("entry_source", "aix_action")
          .eq("aix_action", actionType)
          .order("is_starred", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(4)
      : Promise.resolve({ data: null }),
  ]);
  const brainMeta = (convResult.data as { suggested_aix_meta?: BrainMeta } | null)?.suggested_aix_meta ?? null;

  // M4: アクション専用バケットの整形（申込誘導=💡applying / 内覧誘導=🏠viewing）
  type ActionBucketRow = { id: string; title: string | null; content: string; importance: number };
  const actionBucketRows = ((actionBucketRes?.data ?? []) as ActionBucketRow[])
    .filter((r) => (r.content ?? "").trim().length > 0);
  const actionBucketSection = actionBucketRows.length > 0
    ? `━━━━━━━━━━━━━━━━━━━━\n` +
      (actionBucketCategory === "applying_pattern"
        ? "【💡 申込に至った実例パターン（この展開を参考に橋渡し文を組み立てる・文面の丸写しは禁止）】"
        : "【🏠 内見に至った・案内成功の実例パターン（この展開を参考に橋渡し文を組み立てる・文面の丸写しは禁止）】") +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      actionBucketRows.map((p, i) => `${i + 1}. ${p.title ? `[${p.title}] ` : ""}${p.content}`).join("\n") + "\n\n"
    : "";

  // A: AIX実例バケットの整形（テンプレート実例を先頭・橋渡し文実例を補完として1バケットに統合）
  // 0件のときはバケット自体を注入しない（フォールバック不要）
  type AixExampleRow = {
    customer_message: string | null;
    sent_reply: string | null;
    conversation_state: string | null;
    is_starred: boolean | null;
    reply_angle: string | null;
    aix_action: string | null;
  };
  const seenAixReplies = new Set<string>();
  const aixExampleRows = [
    ...((aixTemplateExRes?.data ?? []) as AixExampleRow[]),
    ...((aixActionExRes?.data ?? []) as AixExampleRow[]),
  ].filter((r) => {
    const key = (r.sent_reply ?? "").trim();
    if (key.length === 0 || seenAixReplies.has(key)) return false;
    seenAixReplies.add(key);
    return true;
  });
  const aixExamplesSection = aixExampleRows.length > 0
    ? `━━━━━━━━━━━━━━━━━━━━\n【過去の【AIX】テンプレート実例（同じAIXボタン後に実際に送った続き文）】\n━━━━━━━━━━━━━━━━━━━━\n` +
      `※ 以下はお客様の状況と、そのとき実際に送った続き文（テンプレート文・橋渡し文）の実例です。文体・トーン・構成の参考にしてください。ただし金額・物件名・日程などの固有の事実は今回の会話履歴/AIXメッセージにあるもののみ使うこと（実例からの持ち込みは絶対禁止）。\n\n` +
      aixExampleRows.map((ex, i) =>
        `--- 実例${i + 1}${ex.is_starred ? " ⭐" : ""} ---\n` +
        `[お客様の状況] 「${safeSlice(ex.customer_message ?? "", 200)}」\n` +
        `[実際に送った続き文] 「${safeSlice(ex.sent_reply ?? "", 600)}」`
      ).join("\n\n") + "\n\n"
    : "";

  // M1: 注入した ai_reply_knowledge の id を収集（レスポンス後に used_count テレメトリ）
  const knowledgeUsedIds: string[] = [...actionBucketRows.map((r) => r.id).filter(Boolean)];

  // ── 並列フェッチ②: RAG（winning_patterns + ai_reply_knowledge + ai_reply_examples）──
  let winningSection = "";
  let knowledgeSection = "";
  let examplesSection = "";
  let ragQueryLength = 0;
  let aixVecHitCount = 0;   // match_aix_reply_examples のヒット数（テレメトリ用）
  if (process.env.OPENAI_API_KEY) {
    const recentCustomerMsgs = (recentMessages ?? [])
      .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
      .slice(-3)
      .map((m) => m.text)
      .join(" ");
    // AIX-META全フィールド（action / closing_strategy / reply_direction / checkpoint_stage）を
    // 検索ベクトルに含める（brain-coreのprevMeta 5フィールド注入と同じ設計思想）
    // H1: property_search_params → 希望条件テキスト化（preferences は brain-core 側が string の場合もあるため両対応）
    const psp = brainMeta?.property_search_params;
    const pspPrefs = psp
      ? (Array.isArray(psp.preferences) ? psp.preferences.join("・") : (psp.preferences ?? ""))
      : "";
    const pspText = psp
      ? [
          psp.area ? `エリア: ${psp.area}` : null,
          psp.floor_plan ? `間取り: ${psp.floor_plan}` : null,
          psp.walk_minutes ? `駅徒歩: ${psp.walk_minutes}分以内` : null,
          psp.move_in_time,
          psp.rent_max ? `家賃${psp.rent_max}円以下` : null,
          pspPrefs,
        ].filter(Boolean).join("・")
      : "";
    const ragQuery = [
      `AIXアクション: ${actionLabel}`,
      customerConditions ? `希望条件: ${customerConditions.slice(0, 200)}` : "",
      brainMeta?.action && AIX_BUTTON_LABELS[brainMeta.action]
        ? `Brain推奨アクション: ${AIX_BUTTON_LABELS[brainMeta.action]}`
        : "",
      brainMeta?.closing_strategy ? `成約戦略: ${brainMeta.closing_strategy}` : "",
      brainMeta?.reply_direction ? `返信方向: ${brainMeta.reply_direction}` : "",
      brainMeta?.checkpoint_stage ? `フェーズ詳細: ${brainMeta.checkpoint_stage}` : "",
      brainMeta?.customer_emotion ? `顧客感情: ${brainMeta.customer_emotion}` : "",
      brainMeta?.latent_intent ? `潜在動機: ${brainMeta.latent_intent}` : "",
      brainMeta?.current_property ? `注目物件: ${brainMeta.current_property}` : "",
      // H1: 顧客インテント・成功パターン・キートピック等を検索ベクトルに追加
      // （generate-reply の brainContext と同構成 — winning_patterns / knowledge の命中精度向上）
      brainMeta?.customer_intent ? `顧客インテント: ${brainMeta.customer_intent}` : "",
      brainMeta?.winning_pattern ? `成功パターン: ${brainMeta.winning_pattern}` : "",
      brainMeta?.key_topics?.length ? `キートピック: ${brainMeta.key_topics.join("・")}` : "",
      brainMeta?.recommended_tone ? `推奨トーン: ${brainMeta.recommended_tone}` : "",
      brainMeta?.human_type_label ? `人物タイプ: ${brainMeta.human_type_label}` : "",
      brainMeta?.repeated_concern ? `繰り返し懸念: ${brainMeta.repeated_concern}` : "",
      pspText ? `希望条件: ${pspText}` : "",
      // 直前に何のAIXを送ったかは続き文の実例検索に直結する文脈（generate-reply の [AIX履歴] と同形式）
      ...(brainMeta?.last_aix_history ? [`[AIX履歴]${String(brainMeta.last_aix_history).slice(0, 100)}`] : []),
      conversationState ? `フェーズ: ${STATE_LABEL[conversationState] ?? conversationState}` : "",
      recentCustomerMsgs.slice(0, 200),
    ].filter(Boolean).join(" | ").slice(0, 2000);
    ragQueryLength = ragQuery.length;

    try {
      const emb = await generateEmbedding(ragQuery);
      if (emb) {
        const stateAliases = STATE_SEARCH_ALIASES[normalizedState] ?? [normalizedState];
        const [wpRes, knRes, exRes, aixExRes] = await Promise.all([
          supabase.rpc("match_winning_patterns", {
            query_embedding: emb,
            // H2: メタデータ再ランキングの母集団を確保するため 6→10 に拡大
            match_count: 10,
            min_importance: 8,
          }),
          // generate-reply の fetchKnowledge と同構成（match_count拡大 + importance/similarity/鮮度スコアリング）
          supabase.rpc("match_reply_knowledge", {
            query_embedding: emb,
            match_count: 40,
            min_importance: 7,
          }),
          // ⭐実例（スタッフの実返信）— 文体・テンポ再現の最重要ソース（generate-reply の fetchExamples と同RPC）
          supabase.rpc("match_reply_examples", {
            query_embedding: emb,
            match_count: 20,
            filter_states: stateAliases,
          }),
          // AIX専用pgvector検索（match_reply_examplesとは別RPC・entry_source IN ('aix_template','aix_action')）
          // match_reply_examples は entry_source='line_reply' ハードコードのためAIX実例が永遠に
          // ヒットしない → 専用RPCで過去の【AIX】テンプレート続き文・橋渡し文実例を類似検索する
          //（同一actionは+0.05ブースト）
          supabase.rpc("match_aix_reply_examples", {
            query_embedding: emb,
            match_count: 10,
            filter_action: actionType ?? null,
          }),
        ]);
        // H2: RPCが返すメタデータ列（checkpoint_stage / customer_intent / win_rate / human_type_label）を型に追加
        // （match_winning_patterns はこれらを既に返却している — brain-core の ragWinningPatterns 型と同構成）
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
        // H2: similarity フィルタ後、brainMeta とのメタデータ一致＋win_rate で複合スコア再ランキング
        const wpRows = ((wpRes.data ?? []) as WpRow[])
          .filter((w) => w.similarity >= 0.5)
          .map((w) => ({
            ...w,
            score: (w.similarity ?? 0)
              + (brainMeta?.checkpoint_stage && w.checkpoint_stage === brainMeta.checkpoint_stage ? 0.12 : 0)
              + (brainMeta?.customer_intent && w.customer_intent === brainMeta.customer_intent ? 0.15 : 0)
              + (w.win_rate ?? 0) * 0.1,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 6);
        if (wpRows.length > 0) {
          winningSection =
            `━━━━━━━━━━━━━━━━━━━━\n【過去の成約パターン（似た状況で効いた戦い方 — トーン・構成の参考にする）】\n━━━━━━━━━━━━━━━━━━━━\n` +
            wpRows.map((w) => {
              const parts = [
                w.situation ? `状況: ${w.situation}` : "",
                w.human_type_label ? `顧客タイプ: ${w.human_type_label}` : "",
                `パターン: ${w.pattern}`,
                w.closing_action ? `クロージング: ${w.closing_action}` : "",
                w.notes ? `補足: ${w.notes}` : "",
              ].filter(Boolean).join(" / ");
              return `・${parts}`;
            }).join("\n") + "\n\n";
        }
        const kn = buildKnowledgeSections((knRes.data ?? []) as KnowledgeHit[]);
        if (kn.text) {
          knowledgeSection = wrapKnowledgeSection(kn.text);
          knowledgeUsedIds.push(...kn.usedIds);
        }
        // AIX橋渡し文実例（pgvector）: 多様性が高いため閾値を0.45に緩和（⭐+0.15ブーストは共通）
        aixVecHitCount = ((aixExRes.data ?? []) as ExampleHit[]).length;
        const aixVecRows = rankExamples((aixExRes.data ?? []) as ExampleHit[], 0.45).slice(0, 4);
        const lineVecRows = rankExamples((exRes.data ?? []) as ExampleHit[]).slice(0, 6);
        // マージ: AIX実例を先頭に配置（橋渡し文の実績を優先）・sent_reply本文で重複排除
        const seenReplies = new Set<string>();
        const mergedRows = [...aixVecRows, ...lineVecRows].filter((ex) => {
          const key = (ex.sent_reply ?? "").trim();
          if (seenReplies.has(key)) return false;
          seenReplies.add(key);
          return true;
        }).slice(0, 8);
        const exText = formatExamplesSection(mergedRows);
        if (exText) {
          examplesSection = wrapExamplesSection(exText);
        }
      }
    } catch {
      // RAG失敗は無視して生成継続（既存方針: adapt/brain-coreと同じ）
    }
  }

  // ── H3: RAGフォールバック（OPENAI_API_KEY未設定・embedding失敗・RPC空振り時）──────
  // generate-reply の fetchKnowledge / fetchExamples のフォールバック経路と同方針。
  // pgvector不発でも実例・重要ナレッジをゼロにせず文体再現力を維持する。
  if (!examplesSection || !knowledgeSection) {
    try {
      const fbStates = Array.from(new Set([
        ...(STATE_SEARCH_ALIASES[normalizedState] ?? [normalizedState]),
        ...(conversationState ? [conversationState] : []),
      ]));
      // B: フォールバック実例はAIX実績を優先する4段リトライ
      //   ⓪ entry_source='aix_template' + aix_action=actionType（【AIX】テンプレート続き文の実績・本命）
      //   ① entry_source='aix_action' + aix_action=actionType（同一AIXボタンの橋渡し文実績）
      //   ② entry_source='aix_action' のみ（アクション不問のAIX橋渡し文実績）
      //   ③ entry_source='line_reply'（従来 — 通常返信の実例で文体だけでも維持）
      const fetchFallbackExamples = async () => {
        const selectCols = "customer_message, sent_reply, conversation_state, is_starred, reply_angle";
        if (actionType) {
          const r0 = await supabase
            .from("ai_reply_examples")
            .select(selectCols)
            .eq("entry_source", "aix_template")
            .eq("aix_action", actionType)
            .order("is_starred", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(6);
          if ((r0.data?.length ?? 0) > 0) return r0;
          const r1 = await supabase
            .from("ai_reply_examples")
            .select(selectCols)
            .eq("entry_source", "aix_action")
            .eq("aix_action", actionType)
            .order("is_starred", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(6);
          if ((r1.data?.length ?? 0) > 0) return r1;
        }
        const r2 = await supabase
          .from("ai_reply_examples")
          .select(selectCols)
          .eq("entry_source", "aix_action")
          .order("is_starred", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(6);
        if ((r2.data?.length ?? 0) > 0) return r2;
        return supabase
          .from("ai_reply_examples")
          .select(selectCols)
          .in("conversation_state", fbStates)
          .eq("entry_source", "line_reply")
          .order("is_starred", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(6);
      };
      const [fbExRes, fbKnRes] = await Promise.all([
        !examplesSection ? fetchFallbackExamples() : Promise.resolve({ data: null }),
        !knowledgeSection
          ? supabase
              .from("ai_reply_knowledge")
              .select("id, title, content, category, importance, hypothesis_status, created_at")
              .gte("importance", 8)
              .neq("hypothesis_status", "rejected")
              .order("importance", { ascending: false })
              .limit(20)
          : Promise.resolve({ data: null }),
      ]);
      if (!examplesSection && (fbExRes.data?.length ?? 0) > 0) {
        // similarity 0.5 を付与して既存の整形ロジック（閾値0.5・⭐ブースト順位付け）を通す
        const fbRows = (fbExRes.data as Array<Omit<ExampleHit, "similarity">>).map((ex) => ({ ...ex, similarity: 0.5 }));
        const exText = buildExamplesSection(fbRows);
        if (exText) examplesSection = wrapExamplesSection(exText);
      }
      if (!knowledgeSection && (fbKnRes.data?.length ?? 0) > 0) {
        const fbRows = (fbKnRes.data as Array<Omit<KnowledgeHit, "similarity">>).map((k) => ({ ...k, similarity: 0.5 }));
        const kn = buildKnowledgeSections(fbRows);
        if (kn.text) {
          knowledgeSection = wrapKnowledgeSection(kn.text);
          knowledgeUsedIds.push(...kn.usedIds);
        }
      }
    } catch (err) {
      console.error("[aix-template-generate] RAGフォールバック失敗（資産なしで生成続行）:", err);
    }
  }

  // ── フレーズ辞書（phrase_dictionary — generate-reply と同一キャッシュ）────────
  const phrasesSection = phraseList.length > 0
    ? `【スモラのフレーズ集（参考程度に・⭐実例を最優先すること）】\n` +
      phraseList.slice(0, 10).map((p) => `「${p}」`).join("　") + "\n\n"
    : "";

  // ── コンテキスト整形 ─────────────────────────────────────────────────────
  const nowMs = Date.now();
  const history = (recentMessages ?? [])
    .slice(-15)
    .map((m) => {
      const who = m.sender === "customer" ? "お客様" : (m.isAix ? "スモラ(AIX送信)" : "スモラ");
      const timeLabel = relativeTimeLabel(m.rawCreatedAt, nowMs);
      if (m.text === "[画像]" || m.text === "[動画]") return `${who}${timeLabel}: 【画像・資料を送付】`;
      if (!m.text) return null;
      return `${who}${timeLabel}: ${m.text}`;
    })
    .filter(Boolean)
    .join("\n");

  const pendingSection = (pendingScheduledMessages ?? [])
    .map((m) => m.text ?? "").filter(Boolean).join("\n\n---\n\n");

  const stateLabel = STATE_LABEL[conversationState || ""] || conversationState || "不明";

  const brainMetaSection = brainMeta
    ? `━━━━━━━━━━━━━━━━━━━━\n【🧠 Brain戦略 — 生成の方向性】\n━━━━━━━━━━━━━━━━━━━━\n` +
      `成約戦略: ${brainMeta.closing_strategy || "-"}\n` +
      `返信方向: ${brainMeta.reply_direction || "-"}\n` +
      `チェックポイント: ${brainMeta.checkpoint_stage || "-"}\n` +
      (brainMeta.customer_emotion ? `顧客感情: ${brainMeta.customer_emotion}\n` : "") +
      (brainMeta.recommended_tone ? `推奨トーン: ${brainMeta.recommended_tone}\n` : "") +
      (brainMeta.purchase_signal_level ? `購買シグナル強度: ${brainMeta.purchase_signal_level}\n` : "") +
      (brainMeta.current_property ? `注目物件: ${brainMeta.current_property}\n` : "") +
      (brainMeta.latent_intent ? `潜在動機（裏の不安）: ${brainMeta.latent_intent}\n` : "") +
      (brainMeta.future_timeline ? `入居希望タイムライン: ${brainMeta.future_timeline}\n` : "") +
      (brainMeta.customer_questions?.length
        ? `お客様が質問していること（橋渡し文で拾う）:\n${brainMeta.customer_questions.map(q => `  ・${q}`).join("\n")}\n`
        : "") +
      (brainMeta.avoid_topics?.length
        ? `禁止話題（絶対に触れない）: ${brainMeta.avoid_topics.join("・")}\n`
        : "") +
      (brainMeta.last_aix_history?.length
        ? `直前のAIX履歴: ${brainMeta.last_aix_history.join(" → ")}\n`
        : "") +
      (brainMeta.ng_properties?.length
        ? `再提案禁止物件（既に送付済み・NG）: ${brainMeta.ng_properties.join("、")}\n`
        : "") +
      "\n"
    : "";

  // preferences が string の場合は配列化、null/undefined の場合は空配列
  // （string を配列スプレッドすると1文字ずつ分解され「広 / め / ・ / 綺 / 麗」になるバグ防止 — ragQuery側と同処理）
  const userPromptPrefsRaw = brainMeta?.property_search_params?.preferences;
  const prefList = Array.isArray(userPromptPrefsRaw)
    ? userPromptPrefsRaw
    : typeof userPromptPrefsRaw === "string" && userPromptPrefsRaw
    ? [userPromptPrefsRaw]
    : [];

  const userPrompt = [
    `━━━━━━━━━━━━━━━━━━━━\n【今回生成する橋渡し文】\n━━━━━━━━━━━━━━━━━━━━`,
    `・AIXボタン種別: ${actionLabel}`,
    actionGuide ? `・この種別の書き方: ${actionGuide}` : "",
    "",
    brainMetaSection,
    aixExamplesSection,
    winningSection,
    knowledgeSection,
    actionBucketSection,
    `━━━━━━━━━━━━━━━━━━━━\n【現在の状況】\n━━━━━━━━━━━━━━━━━━━━`,
    jstContextNote,
    elapsedLabel ? `お客様の最終返信から: ${elapsedLabel}` : "",
    "",
    `━━━━━━━━━━━━━━━━━━━━\n【お客様情報】\n━━━━━━━━━━━━━━━━━━━━`,
    `・お客様名: ${customerName || "〇〇"}さん`,
    `・現在のフェーズ: ${stateLabel}`,
    customerConditions ? `・希望条件（DB）: ${customerConditions}\n⚠️ 上記の数字・金額（家賃・築年数・駅徒歩等）は一文字も変えずにそのまま引用すること。「13万円」を「3万円」に変形する等の誤変換は絶対禁止。` : "",
    brainMeta?.property_search_params
      ? `・希望条件（会話由来・最新・優先）: ${
          [
            // brain-core は rent_max を円単位の生値で格納 → 万円に変換（「90000万円」等の異常値防止）
            brainMeta.property_search_params.rent_max ? `家賃上限${Math.floor((brainMeta.property_search_params.rent_max ?? 0) / 10000)}万円` : "",
            brainMeta.property_search_params.move_in_time ? `入居希望${brainMeta.property_search_params.move_in_time}` : "",
            ...prefList,
          ].filter(Boolean).join(" / ")
        }（DB条件より優先して参照すること）`
      : "",
    staffMessagedToday ? `・本日すでにスタッフが送信済み（冒頭は「お待たせ致しました！！」系にする。「お世話になっております」の再使用は禁止）` : "",
    noEmoji ? `・絵文字禁止モード: 絵文字を一切使わないこと` : "",
    "",
    pendingSection
      ? `━━━━━━━━━━━━━━━━━━━━\n【🔑 予約送信待ちのAIXメッセージ（物件名・金額など事実の唯一の追加ソース）】\n━━━━━━━━━━━━━━━━━━━━\n${pendingSection}\n`
      : "",
    `━━━━━━━━━━━━━━━━━━━━\n【会話履歴（事実確認と流れの把握に使う）】\n━━━━━━━━━━━━━━━━━━━━\nこの履歴を必ず参照すること。履歴内でお客様が既に答えた質問を再度聞かない。スモラが既に伝えた情報と矛盾しない・同じ内容を繰り返さない。\n${history || "なし"}`,
    "",
    examplesSection,
    phrasesSection,
    `この会話の流れ・お客様の状況に合った「${actionLabel}」の橋渡し文を1通生成してください。金額・空室状況・日程・物件名は上記の会話履歴/AIXメッセージに記載がある事実のみ使い、なければ言及しないこと。⭐実例の文体・テンポを忠実に再現すること。出力は本文のみ。`,
  ].filter(Boolean).join("\n");

  // ── DB学習資産の第2システムブロック（TTLキャッシュ内はbyte-stable → prompt cache対象）──
  const dbKnowledgeBlock = [
    topPrinciples.length > 0
      ? "【📌 絶対原則（DB学習・全顧客共通・常時遵守）】\n" +
        topPrinciples.map((p, i) => `${i + 1}. ${p.title ? `[${p.title}] ` : ""}${p.content}`).join("\n")
      : "",
    lossPatterns.length > 0
      ? "【🚫 避けるべき対応（失注実例より）】\n" +
        lossPatterns.map((p, i) => `${i + 1}. ${p.content}`).join("\n")
      : "",
    dbRules ? dbRules.trim() : "",
  ].filter(Boolean).join("\n\n");

  // ── Anthropic API (Claude Sonnet + prompt cache) ─────────────────────────
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  try {
    const systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } }> = [
      {
        type: "text",
        text: `${PRIORITY_ORDER_NOTE}\n\n${STATIC_GEN_SYSTEM}\n\n${SHARED_RULES_SYSTEM}`,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ];
    if (dbKnowledgeBlock) {
      systemBlocks.push({
        type: "text",
        text: dbKnowledgeBlock,
        cache_control: { type: "ephemeral", ttl: "1h" },
      });
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(55_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        // claude-sonnet-5はthinking省略時adaptiveがデフォルト有効 → max_tokens 1024を
        // thinkingが消費して橋渡し文が途切れるのを防ぐ（generate-replyと同設定）
        thinking: { type: "disabled" },
        system: systemBlocks,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[aix-template-generate] Anthropic error ${res.status}:`, errText.slice(0, 300));
      return NextResponse.json({ ok: false, error: `AI生成エラー: ${res.status}` }, { status: 500 });
    }

    const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
    let text = data.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
    if (!text) {
      return NextResponse.json({ ok: false, error: "empty result" }, { status: 500 });
    }
    text = stripRoomLeadingZeros(text);

    console.log(
      `[aix-template-generate] action=${actionType || actionCategory || "-"}` +
      ` rag_wp=${winningSection ? "hit" : "miss"} rag_kn=${knowledgeSection ? "hit" : "miss"}` +
      ` rag_ex=${examplesSection ? "hit" : "miss"} phrases=${phraseList.length}` +
      ` principles=${topPrinciples.length} loss=${lossPatterns.length} dbRules=${dbRules ? "ok" : "none"}` +
      ` brainMeta=${brainMeta ? "ok" : "none"} brainAction=${brainMeta?.action || "-"} ragQueryLen=${ragQueryLength}` +
      ` actionBucket=${actionBucketCategory ? `${actionBucketCategory}:${actionBucketRows.length}` : "-"}` +
      ` aixEx=${aixExampleRows.length} aixVec=${aixVecHitCount}` +
      ` knUsedIds=${knowledgeUsedIds.length}`,
    );

    // M1: ナレッジ使用テレメトリ（レスポンス返却後に fire-and-forget — 生成成功時のみカウント）
    incrementKnowledgeUsage(knowledgeUsedIds);

    return NextResponse.json({ ok: true, text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI生成エラー";
    console.error("[aix-template-generate] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
