import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// conversationState → phrase_dictionary カテゴリ
const STATE_TO_PHRASE_CATEGORY: Record<string, string> = {
  first_reply: "hearing_start",
  condition_hearing: "hearing_followup",
  property_search: "property_search_start",
  property_recommendation: "property_recommendation",
  viewing: "viewing_invite",
  estimate_request: "estimate_send",
  availability_check: "availability_check",
  application: "application_push",
};

const VALID_STATES = [
  "first_reply", "condition_hearing", "property_search",
  "property_recommendation", "viewing", "estimate_request",
  "availability_check", "application", "screening", "contract", "closed_won",
];

// ─── Claude Haiku 共通ヘルパー ────────────────────────────────────────────────
async function callHaiku(prompt: string, maxTokens = 1024): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return "";
    const data = await res.json() as { content?: Array<{ text: string }> };
    return data.content?.[0]?.text?.trim() || "";
  } catch {
    return "";
  }
}

// ─── ④ state 自動判定 ────────────────────────────────────────────────────────
async function autoClassifyState(customerMessage: string, sentReply: string): Promise<string> {
  const text = await callHaiku(`以下のLINE賃貸営業のやりとりから会話フェーズを判定してください。

【お客様のメッセージ】
${customerMessage}

【スタッフの返信】
${sentReply}

フェーズ定義：
・first_reply = 初回問い合わせへの返信
・condition_hearing = 条件ヒアリング中
・property_search = 物件を探している・提案前
・property_recommendation = 物件を提案・オススメしている
・viewing = 内覧の調整・案内
・estimate_request = 見積もり・初期費用の説明
・availability_check = 空室確認・募集状況の確認
・application = 申込の促し・手続き
・screening = 審査中
・contract = 契約手続き
・closed_won = 成約済み

JSONのみ返答: {"state": "viewing"}`, 100);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return "first_reply";
    const { state } = JSON.parse(match[0]) as { state: string };
    return VALID_STATES.includes(state) ? state : "first_reply";
  } catch {
    return "first_reply";
  }
}

// ─── ① パターン・スタイル・フレーズ・原則を抽出 → ai_reply_knowledge ───────
async function analyzeAndSaveKnowledge(
  exampleId: string,
  conversationState: string,
  customerMessage: string,
  sentReply: string
) {
  const text = await callHaiku(`以下のLINE賃貸営業のやりとりを深く分析してください。

【お客様のメッセージ】
${customerMessage}

【スモラスタッフの返信】
${sentReply}

以下の4点を抽出してください。JSONのみで返答（説明不要）：

{
  "situation": "この状況を一言で表す（例：初めての条件共有、物件への反応など）",
  "pattern": "この状況でのベストな返し方の原則（具体的に・1〜2文）",
  "style_elements": ["口調・文体の特徴を3〜5点（例：お客様名を呼ぶ、絵文字を使う、etc.）"],
  "key_phrases": ["この返信で使われている再利用可能なフレーズ（1〜3個）"],
  "principle": "この返信が優れている核心的な理由（1文）"
}`);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const analysis = JSON.parse(match[0]) as {
      situation: string;
      pattern: string;
      style_elements: string[];
      key_phrases: string[];
      principle: string;
    };

    const entries = [
      { category: "pattern" as const, title: analysis.situation, content: analysis.pattern, importance: 7 },
      { category: "principle" as const, title: `原則：${analysis.situation}`, content: analysis.principle, importance: 8 },
      ...analysis.style_elements.map((el) => ({
        category: "style" as const, title: "口調・スタイル", content: el, importance: 6,
      })),
      ...analysis.key_phrases.map((phrase) => ({
        category: "phrase" as const, title: "フレーズ", content: phrase, importance: 6,
      })),
    ];

    for (const entry of entries) {
      await supabase.from("ai_reply_knowledge").insert({
        category: entry.category,
        title: entry.title,
        content: entry.content,
        importance: entry.importance,
        conversation_state: conversationState || null,
        source_example_id: exampleId,
      });
    }
  } catch (e) {
    console.error("analyzeAndSaveKnowledge error:", e);
  }
}

// ─── ① 差分分析（AIドラフト修正からの逆学習）→ importance:9 で保存 ─────────
async function analyzeDiff(
  exampleId: string,
  conversationState: string,
  customerMessage: string,
  aiDraft: string,
  sentReply: string
) {
  const text = await callHaiku(`AIが生成した賃貸営業LINEの文案と、スタッフが実際に修正して送った文を比較してください。

【お客様のメッセージ】
${customerMessage}

【AIが生成した文案（修正前）】
${aiDraft}

【スタッフが実際に送った文（修正後）】
${sentReply}

以下を分析してJSONのみで返答（説明不要）：
{
  "ai_mistake": "AIが間違えた点・不足していた点（1〜2文）",
  "correction_pattern": "スタッフがどう直したか・何を重視したか（1〜2文）",
  "rule": "次回から守るべきルール（1文・具体的に）"
}`);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const analysis = JSON.parse(match[0]) as {
      ai_mistake: string;
      correction_pattern: string;
      rule: string;
    };

    await supabase.from("ai_reply_knowledge").insert([
      {
        category: "principle",
        title: `[差分学習] ${(analysis.ai_mistake || "").slice(0, 30)}`,
        content: analysis.rule,
        importance: 9,
        conversation_state: conversationState || null,
        source_example_id: exampleId,
      },
      {
        category: "pattern",
        title: `[修正対比] ${conversationState}`,
        content: analysis.correction_pattern,
        importance: 8,
        conversation_state: conversationState || null,
        source_example_id: exampleId,
      },
    ]);
  } catch (e) {
    console.error("analyzeDiff error:", e);
  }
}

// ─── ②③ フレーズ抽出（重複排除 + priority 昇格）→ phrase_dictionary ────────
async function extractAndSavePhrases(conversationState: string, sentReply: string) {
  const phraseCategory = STATE_TO_PHRASE_CATEGORY[conversationState];
  if (!phraseCategory) return;

  // 既存フレーズを取得
  const { data: existing } = await supabase
    .from("phrase_dictionary")
    .select("id, phrase, priority")
    .eq("category", phraseCategory)
    .limit(100);

  const existingPhrases = (existing || []).map((r) => r.phrase as string);
  const existingMap = Object.fromEntries(
    (existing || []).map((r) => [r.phrase as string, { id: r.id as number, priority: r.priority as number }])
  );

  const existingList = existingPhrases.length > 0
    ? `\n\n【既存フレーズ（類似・重複は除外してboostへ）】\n${existingPhrases.map((p) => `- ${p}`).join("\n")}`
    : "";

  const text = await callHaiku(`以下のLINE賃貸営業メッセージから再利用できるフレーズを抽出してください。

【メッセージ】
${sentReply}${existingList}

ルール：
・15〜50文字程度のスモラらしいフレーズを抽出
・固有情報（物件名・金額・部屋番号）は含めない
・既存フレーズと同一・類似のものは "boost" に入れる（既存の文字列をそのまま）
・完全に新しいものだけ "new" に入れる（0件でもOK）
・JSONのみ返答

{"new": ["新フレーズ1"], "boost": ["既存フレーズ文字列"]}`, 512);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const { new: newPhrases = [], boost: boostPhrases = [] } = JSON.parse(match[0]) as {
      new: string[];
      boost: string[];
    };

    // 新フレーズを挿入
    for (const phrase of newPhrases) {
      if (typeof phrase === "string" && phrase.trim()) {
        await supabase.from("phrase_dictionary").insert({
          category: phraseCategory,
          phrase: phrase.trim(),
          priority: 5,
          role: "auto_extracted",
        });
      }
    }

    // 類似フレーズの priority を +1（上限10）
    for (const boostPhrase of boostPhrases) {
      if (typeof boostPhrase !== "string") continue;
      const found = existingMap[boostPhrase]
        ?? existingMap[Object.keys(existingMap).find((k) => k.includes(boostPhrase.slice(0, 8)) || boostPhrase.includes(k.slice(0, 8))) ?? ""];
      if (found) {
        await supabase
          .from("phrase_dictionary")
          .update({ priority: Math.min(10, (found.priority || 5) + 1) })
          .eq("id", found.id);
      }
    }
  } catch (e) {
    console.error("extractAndSavePhrases error:", e);
  }
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const {
    conversationState: rawState,
    customerMessage,
    sentReply,
    aiDraft,
    isStarred,
  } = await req.json() as {
    conversationState: string;
    customerMessage: string;
    sentReply: string;
    aiDraft?: string;
    isStarred?: boolean;
  };

  if (!customerMessage || !sentReply) {
    return NextResponse.json(
      { ok: false, error: "customerMessage and sentReply required" },
      { status: 400 }
    );
  }

  // ④ state が未指定または "auto" の場合は自動判定
  const conversationState =
    !rawState || rawState === "auto"
      ? await autoClassifyState(customerMessage, sentReply)
      : rawState;

  const wasAiUsed = !!aiDraft && aiDraft.trim() === sentReply.trim();
  const wasAiModified = !!aiDraft && !wasAiUsed && aiDraft.trim().length > 0;

  const { data, error } = await supabase
    .from("ai_reply_examples")
    .insert({
      conversation_state: conversationState,
      customer_message: customerMessage,
      sent_reply: sentReply,
      ai_draft: aiDraft || null,
      was_ai_used: wasAiUsed,
      was_ai_modified: wasAiModified,
      is_starred: isStarred ?? false,
    })
    .select("id")
    .single();

  if (error) {
    console.error("save-reply-example error:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // ★ 手動インポート or ☆ → 深層分析・フレーズ抽出を並列実行
  const shouldAnalyze = isStarred === true || !aiDraft;
  if (shouldAnalyze && data?.id) {
    await Promise.all([
      analyzeAndSaveKnowledge(data.id, conversationState, customerMessage, sentReply),
      extractAndSavePhrases(conversationState, sentReply),
    ]);
  }

  // ① AI差分学習：スタッフが修正して送った場合（最高品質の学習信号）
  if (wasAiModified && data?.id && aiDraft) {
    await analyzeDiff(data.id, conversationState, customerMessage, aiDraft, sentReply);
  }

  return NextResponse.json({ ok: true, id: data?.id, conversation_state: conversationState });
}
