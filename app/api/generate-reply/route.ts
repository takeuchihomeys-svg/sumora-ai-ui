import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";

// ─── モデル定義 ───────────────────────────────────────────────────────────────
// Step1（分析）: Haiku — 速度重視
const analysisModel = new ChatAnthropic({
  model: "claude-haiku-4-5-20251001",
  maxTokens: 1024,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// Step2（生成）: Sonnet — 品質重視
const generationModel = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  maxTokens: 380,
  temperature: 0.7,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// ─── スタイルルール（共通） ──────────────────────────────────────────────────
const EMOJI_RULE = `絵文字: 😊 😌 🙇‍♀️ 🌟 ✨ の5つのみ・1〜2個まで・文末か区切りのみ`.trim();

const STYLE_RULE = `感嘆符「！！」必須 / 「〇〇さん」で呼ぶ / 箇条書き禁止 / 1つの返信案のみ`.trim();

// ─── Step1: お客様状況の深層分析（Haiku）───────────────────────────────────
const ANALYSIS_SYSTEM = `あなたは賃貸仲介の営業コーチです。
LINEのやりとりから、お客様の状況・感情・本当のニーズを深く分析してください。
JSONのみで返答（説明不要）。`;

async function analyzeCustomerSituation(
  customerMessage: string,
  history: string,
  state: string,
  customerName: string
): Promise<string> {
  const prompt = `
【営業フェーズ】${state}
【お客様名】${customerName || "不明"}
【直近の会話履歴】
${history || "なし"}
【最新メッセージ】
${customerMessage}

以下をJSONで分析してください：
{
  "emotion": "お客様の感情状態（例：期待と不安が混在、前向き、迷っているなど）",
  "real_need": "表面の質問の奥にある本当のニーズ・懸念（例：費用が心配で踏み出せない、家族に相談したいなど）",
  "key_insight": "優秀な営業スタッフが気づくべき重要なポイント（例：価格比較をしている、決断を急かされたくないなど）",
  "approach": "このメッセージへの最適な返し方の方針（例：まず共感→動画を送ると約束→内覧への自然な誘導など）",
  "tone": "適切なトーン（例：温かく・余裕を持って・軽く背中を押す）"
}`;

  try {
    const res = await analysisModel.invoke([
      new SystemMessage(ANALYSIS_SYSTEM),
      new HumanMessage(prompt),
    ]);
    const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const match = text.match(/\{[\s\S]*\}/);
    return match ? match[0] : "";
  } catch {
    return "";
  }
}

// ─── フェーズ別行動指針 ──────────────────────────────────────────────────────
const PHASE_GUIDE: Record<string, string> = {
  first_reply: `▶ 今すべきこと: 自己紹介 + 条件ヒアリング開始
例: 「〇〇さんはじめまして！スモラ担当です😊 ご希望の条件を教えていただけますか？」`,
  hearing: `▶ 今すべきこと: 条件を受け取ったらピックアップ宣言。不足条件があれば1点だけ質問。
例: 「〇〇さんご条件ありがとうございます！！全部ピックアップして送ります！！」`,
  proposing: `▶ 今すべきこと: 物件の具体的な魅力（数字で）を伝え、内覧へ自然に誘導。
例: 「〇〇駅徒歩4分・2022年築・家賃◯円で条件ぴったりです！内覧いかがでしょうか？」`,
  applying: `▶ 今すべきこと: 書類・手続きを具体的に案内。安心感を与えながら前進させる。
例: 「審査書類の準備ができましたらお知らせください！スムーズに進めます！！」`,
  closed_won: `▶ 今すべきこと: 入居準備のサポート。感謝と次のステップを伝える。`,
};

// ─── Step2: LINE返信生成（Sonnet）──────────────────────────────────────────
const GENERATION_SYSTEM = `あなたはスモラ（賃貸仲介）のLINE営業担当です。
お客様へのLINE返信を1つだけ生成してください。

【最優先ルール — 必ず守ること】
1. 3行以内・100文字以内。短いほど高品質。
2. ${EMOJI_RULE}
3. ${STYLE_RULE}
4. お客様が言ったことは繰り返さない → 次のアクションへ直行
5. スモラが前回言ったことは繰り返さない → 一貫性を保ちながら前進

【禁止ワード・パターン】
× 「承りました」「ご確認のほど」「少々お待ちください」「確認中です」
× 「〇〇とのことですね」「〇〇をご希望ですね」（オウム返し）
× 「まず〜、次に〜」（列挙構成）
× 築浅・広い・駅近（曖昧表現）→ 2023年6月築・洋室9帖・本町駅徒歩5分（数字で）
× 3行を超える返信

【会話履歴の読み方】
「スモラ:」= 自分の過去の返信 / 「お客様:」= お客様のメッセージ
【画像】スモラが物件資料・見積書を送付した場合はその旨が記録されている`;

// ─── フェーズ別スモラ返信パターン（buildGenerationMessages で注入）─────────
const SMORA_QUICK_PATTERNS = `
【スモラの実際の返信パターン】
・条件受け取り → 「〇〇さんご条件ありがとうございます！！全部ピックアップします！！」
・承諾・了解系 → 「かしこまりました！！」で即アクション（余計な説明禁止）
・日程提案 → 「6/3（水）6/4（木）6/5（金）ご都合いかがでしょうか？」（候補日を列挙するだけ）
・物件紹介冒頭 → 「🌟〇〇マンション」で始めて重要情報のみ続ける
・締め方 → 「またご連絡お待ちしております！！」など1行で終える`.trim();

function buildGenerationMessages(
  customerMessage: string,
  customerName: string,
  history: string,
  state: string,
  nextState: string,
  analysis: string,
  knowledge: string,
  examples: string,
  phrases: string
): [SystemMessage, HumanMessage] {
  const nameNote = customerName ? `お客様名：${customerName}さん` : "お客様名：不明";
  const analysisBlock = analysis; // フェーズ別ガイド内で直接使う
  void nextState; // 将来用（現在はフェーズガイドに統合）

  // フェーズ別の行動指針を取得
  const phaseGuide = PHASE_GUIDE[state] || PHASE_GUIDE["first_reply"];

  const prompt = `
${nameNote}
【現在の営業フェーズ】${state}
${phaseGuide}
${analysisBlock ? `\n【今回の返し方の方針（最優先で参照）】\n${(() => { try { const p = JSON.parse(analysis) as Record<string,string>; return `方針: ${p.approach || ""}\nトーン: ${p.tone || ""}`.trim(); } catch { return analysisBlock; } })()}` : ""}

【直近の会話履歴】
${history || "なし"}

${SMORA_QUICK_PATTERNS}
${knowledge}
${examples}
${phrases}

【お客様の最新メッセージ】
${customerMessage}

↑このメッセージに対してスモラらしい返信を3行以内で1つ生成してください。`;

  return [new SystemMessage(GENERATION_SYSTEM), new HumanMessage(prompt)];
}

// ─── Intent分類（Haiku）──────────────────────────────────────────────────────
const ALLOWED_INTENTS = new Set([
  "condition_share", "consult_property_search", "estimate_request",
  "like_property", "dislike_property", "viewing_request", "application_interest",
  "search_more_properties", "conditions_complete", "conditions_incomplete",
  "property_available", "property_unavailable", "screening_passed", "screening_failed", "other",
]);

const ALLOWED_STATES = new Set([
  "first_reply", "hearing", "proposing", "applying", "closed_won",
  // 旧キーも受け付ける（後方互換）
  "condition_hearing", "property_search", "property_recommendation",
  "viewing", "estimate_request", "availability_check", "application", "screening", "contract",
]);

// 旧ステータスキーを新5段階に正規化
const STATE_ALIAS: Record<string, string> = {
  condition_hearing:       "hearing",
  property_search:         "hearing",
  property_recommendation: "proposing",
  viewing:                 "proposing",
  estimate_request:        "proposing",
  availability_check:      "proposing",
  application:             "applying",
  screening:               "applying",
  contract:                "applying",
};

const NEXT_STATE_MAP: Record<string, Record<string, string>> = {
  first_reply: { condition_share: "hearing", consult_property_search: "hearing", other: "hearing" },
  hearing:     { conditions_complete: "proposing", other: "hearing" },
  proposing:   { like_property: "proposing", application_interest: "applying", other: "proposing" },
  applying:    { screening_passed: "applying", screening_failed: "proposing", other: "applying" },
  closed_won:  { other: "closed_won" },
};

function normalizeState(k: string): string {
  const resolved = STATE_ALIAS[k] ?? k;
  return ALLOWED_STATES.has(resolved) ? resolved : "first_reply";
}
function getNextState(current: string, intent: string): string {
  const map = NEXT_STATE_MAP[normalizeState(current)] || {};
  return map[intent] || map["other"] || current;
}

async function classifyIntent(message: string, state: string, history: string): Promise<string> {
  const system = `賃貸仲介LINE営業のintent分類器。以下のintent_keyのどれか1つをJSONで返す。
condition_share, consult_property_search, estimate_request, like_property, dislike_property,
viewing_request, application_interest, search_more_properties, conditions_complete,
conditions_incomplete, property_available, property_unavailable, screening_passed, screening_failed, other
必ず {"intent_key":"..."} のみ返すこと。`;

  try {
    const res = await analysisModel.invoke([
      new SystemMessage(system),
      new HumanMessage(`state: ${state}\n履歴:\n${history || "なし"}\nメッセージ: ${message}`),
    ]);
    const text = typeof res.content === "string" ? res.content : "";
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { intent_key?: string };
      const intent = parsed.intent_key || "other";
      return ALLOWED_INTENTS.has(intent) ? intent : "other";
    }
    return "other";
  } catch {
    return "other";
  }
}

// ─── phrase_dictionary → conversationState マッピング ───────────────────────
const STATE_TO_PHRASE_CATEGORY: Record<string, string> = {
  first_reply: "hearing_start",
  hearing:     "hearing_followup",
  proposing:   "property_recommendation",
  applying:    "application_push",
  closed_won:  "contract",
};

async function fetchPhrases(state: string): Promise<string> {
  const category = STATE_TO_PHRASE_CATEGORY[state];
  if (!category) return "";

  const { data } = await supabase
    .from("phrase_dictionary")
    .select("phrase, priority")
    .eq("category", category)
    .order("priority", { ascending: false })
    .limit(10);

  if (!data || data.length === 0) return "";

  return "\n\n【スモラの言葉・フレーズ（自然に組み込む）】\n" +
    (data as Array<{ phrase: string }>).map((r) => `「${r.phrase}」`).join("　");
}

// ─── DB取得 ─────────────────────────────────────────────────────────────────
async function fetchKnowledge(state: string): Promise<string> {
  const [{ data: global }, { data: stateSpecific }] = await Promise.all([
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .is("conversation_state", null).order("importance", { ascending: false }).limit(8),
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .eq("conversation_state", state).order("importance", { ascending: false }).limit(6),
  ]);

  const all = [...(stateSpecific || []), ...(global || [])];
  if (all.length === 0) return "";

  const patterns = all.filter((k) => k.category === "pattern" || k.category === "principle");
  const phrases = all.filter((k) => k.category === "phrase");

  const sections: string[] = [];
  if (patterns.length > 0) {
    sections.push("【スモラの営業パターン・原則】\n" + patterns.map((k) => `・${k.content}`).join("\n"));
  }
  if (phrases.length > 0) {
    sections.push("【よく使うフレーズ】\n" + phrases.map((k) => `「${k.content}」`).join("　"));
  }
  return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
}

async function fetchExamples(state: string): Promise<string> {
  const [{ data: starred }, { data: aiUsed }] = await Promise.all([
    supabase.from("ai_reply_examples").select("customer_message, sent_reply")
      .eq("conversation_state", state).eq("is_starred", true)
      .order("created_at", { ascending: false }).limit(3),
    supabase.from("ai_reply_examples").select("customer_message, sent_reply")
      .eq("conversation_state", state).eq("is_starred", false).eq("was_ai_used", true)
      .order("created_at", { ascending: false }).limit(2),
  ]);

  const all = [
    ...(starred || []).map((ex) => ({ ...ex, label: "★実例" })),
    ...(aiUsed || []).map((ex) => ({ ...ex, label: "参考" })),
  ];
  if (all.length === 0) return "";

  return "\n\n【実際のやりとり例（文体・トーンの参考）】\n" +
    all.map((ex) => `[${ex.label}]\nお客様:「${ex.customer_message}」\nスモラ:「${ex.sent_reply}」`).join("\n\n");
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  type RecentMessage = { sender: string; text: string; imageUrl?: string };
  let message: string, state: string, customerName: string, recentMessages: RecentMessage[];
  try {
    const body = await req.json() as {
      message: string;
      state: string;
      customerName?: string;
      recentMessages?: RecentMessage[];
    };
    message = body.message;
    state = body.state;
    customerName = body.customerName || "";
    recentMessages = body.recentMessages || [];
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (!message) return NextResponse.json({ ok: false, error: "message required" }, { status: 400 });

  try {
    const currentState = normalizeState(state || "first_reply");

    // 画像送付を会話履歴に反映（[画像]をフィルタせず意味のあるラベルに変換）
    const history = recentMessages
      .slice(-25)
      .map((m, i, arr) => {
        const who = m.sender === "customer" ? "お客様" : "スモラ";
        const isImageMsg = m.text === "[画像]" || m.text === "[動画]" || (!m.text && !!m.imageUrl);

        if (isImageMsg) {
          if (m.sender === "customer") return `${who}: 【画像を送ってきた】`;
          // スタッフの画像: 前後テキストで物件資料か見積書かを判定
          const nearby = [arr[i - 1], arr[i + 1]].filter(Boolean).map((x) => x?.text || "").join(" ");
          if (/見積|初期費用/.test(nearby)) return `${who}: 【見積書を送付した】`;
          if (/物件|お部屋|ピックアップ|間取り|アパート|マンション|資料/.test(nearby)) return `${who}: 【物件資料を送付した】`;
          return `${who}: 【物件資料・画像を送付した】`;
        }

        // テキスト + 画像が同一メッセージの場合
        if (m.imageUrl && m.text && m.text !== "[画像]") {
          const label = m.sender === "staff" ? "【物件資料を送付しながら】" : "";
          return `${who}: ${label}「${m.text}」`;
        }

        if (!m.text) return null;
        return `${who}: ${m.text}`;
      })
      .filter(Boolean)
      .join("\n");

    // 並列実行: intent分類 + 状況分析 + 知識取得 + 実例取得 + フレーズ取得
    const [detectedIntent, analysis, knowledge, examples, phrases] = await Promise.all([
      classifyIntent(message, currentState, history),
      analyzeCustomerSituation(message, history, currentState, customerName),
      fetchKnowledge(currentState),
      fetchExamples(currentState),
      fetchPhrases(currentState),
    ]);

    const nextState = getNextState(currentState, detectedIntent);

    // Sonnetでストリーミング生成
    const messages = buildGenerationMessages(
      message, customerName, history, currentState, nextState,
      analysis, knowledge, examples, phrases
    );
    const genStream = generationModel.stream(messages);

    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          // 1行目: メタデータJSON（フロントエンドがok確認に使用）
          controller.enqueue(encoder.encode(
            JSON.stringify({ ok: true, detected_intent: detectedIntent, next_state: nextState }) + "\n"
          ));
          try {
            for await (const chunk of await genStream) {
              const text = typeof chunk.content === "string" ? chunk.content : "";
              if (text) controller.enqueue(encoder.encode(text));
            }
          } catch (streamErr) {
            console.error("generate-reply stream error:", streamErr);
          }
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "返信生成エラー";
    console.error("generate-reply error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
