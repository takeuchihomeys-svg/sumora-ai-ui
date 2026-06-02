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
  maxTokens: 512,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// ─── 絵文字・スタイルルール（全プロンプト共通） ──────────────────────────────
const EMOJI_RULE = `
【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字はこの5つだけ：😊 😌 🙇‍♀️ 🌟 ✨
▼ 上記以外は一切禁止：🙏 ⭐️ 🏠 💰 💪 👍 🔍 ✋ 👏 🎉 📋 😆 😄 その他すべて禁止
▼ 絵文字は1〜2個まで。文末か文の区切りにのみ置く。
・😊 😌 → 余裕を示しながらリードする場面（誘導・申込・締め）
・🙇‍♀️ → 連絡が遅れた時・男性客の冒頭（女性スタッフ感）
・🌟 ✨ → 物件紹介の冒頭・オススメ強調のみ`.trim();

const STYLE_RULE = `
【スモラのLINEスタイル】
・感嘆符は「！！」（スモラスタイル。「!」1つや「！」1つは禁止）
・「〇〇さん」とお客様名を必ず呼ぶ（名前が分かる場合）
・こちらが動く姿勢を示す（「確認します」「ピックアップします」等）
・「顧客」「弊社」「御社」などビジネス敬語は一切使わない
・箇条書き・番号リスト・見出し・改行の多用は禁止
・LINEでそのまま送れる文章のみ。解説・補足・候補複数は禁止
・返信案は必ず1つだけ
・【文字数制限】返信全体は4行・120文字以内を目安に。短いほど良い。お客様が言ったことを繰り返す「確認系」の文は入れない`.trim();

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

// ─── スモラ実例から抽出した返信パターン ─────────────────────────────────────
const SMORA_PATTERN_EXAMPLES = `
【スモラの実際の返信パターン（必ずこれを参考にする）】

▼ 冒頭（最初の1行の作り方）
・条件を受け取った      → 「〇〇さんご条件ありがとうございます！！全部ピックアップさせていただきます！！」
・お客様が承諾・了解した → 「かしこまりました！！」で即アクション（余計な説明追加は禁止）
・初回問い合わせ        → 「〇〇さんお世話になっております！！スモラの[担当名]です😊」
・質問への回答          → 冒頭から答えを直接書く。前置きは1文以内。

▼ こちらのアクション宣言（「します」で締める）
・「全部ピックアップして送らせていただきます！！」
・「確認してご連絡させていただきます！！」
・「ご案内させていただきます！！」
・「お送りさせていただきます！！」

▼ 日程提案（複数日を1行に並べるだけ）
「6/3（水）6/4（木）6/5（金）ご都合いかがでしょうか？」
→ 説明不要。候補日を列挙して終える。

▼ 物件紹介の冒頭
「🌟[物件名]」で始めて、重要情報のみを続ける。

▼ 締め方（長くしない）
「ご確認よろしくお願いいたします！！」「またご連絡お待ちしております！！」
→ 1行で終える。感謝・確認・次アクションのうち1つだけ選ぶ。`.trim();

// ─── Step2: LINE返信生成（Sonnet）──────────────────────────────────────────
const GENERATION_SYSTEM = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当（女性スタッフ）です。
お客様の状況分析と会話履歴をもとに、そのまま送れる最高品質のLINE返信案を1つだけ作成してください。

${EMOJI_RULE}

${STYLE_RULE}

【スモラの返信原則（必ず守ること）】
・簡潔さを最優先。敬語の重複（「〜させていただきますね」等）は禁止
・「少々お待ちください」「確認中です」など待機表現は禁止。代わりに「〇〇します」と完了形・実行形で書く
・お客様がすでに言ったことは繰り返さない。受け止めてすぐ次のアクションを示す
・お客様が明示していない条件を推測で書かない
・長い前置き・丁寧な枕詞は不要。本題から入る
・お客様がアクションを約束した段階では確認と感謝のみ。新たな説明や指示は加えない

${SMORA_PATTERN_EXAMPLES}

【説明ルール（曖昧表現禁止）】
× 築浅 → ○ 2023年6月築
× 広い → ○ 洋室9帖
× 駅近 → ○ 本町駅徒歩5分

【会話履歴の画像表記について】
・「スモラ: 【物件資料を送付した】」= 物件のPDF・写真をLINEで送った
・「スモラ: 【見積書を送付した】」= 初期費用の見積書をLINEで送った
・「スモラ: 【物件資料・画像を送付した】」= 資料系の画像を送った（種類不明）
・「お客様: 【画像を送ってきた】」= お客様が画像（間取り図・内装写真など）を送ってきた
これらの後のメッセージは、送付した資料への反応や次の質問である。

【会話履歴の読み方（最重要）】
・「スモラ:」と書かれた行 = 自分（スモラスタッフ）が過去に送った返信
・「お客様:」と書かれた行 = お客様が送ってきたメッセージ
・スモラが既に伝えた内容は絶対に繰り返さない
・スモラが「確認します」「ピックアップします」と言った場合 → その結果を報告する返信を生成する
・スモラが質問した場合 → お客様の回答を受けて次のステップへ進む返信を生成する
・直前のスモラの返信との一貫性を必ず保つ

【心がけること】
こちらが動く姿勢を短く示す。次のステップ（内覧・申込）へ自然に近づける。押しつけがましくしない。

【禁止パターン（⭐実例と照合して除外）】
× お客様の言葉をそのままオウム返しにする（例：「〇〇をご希望ですね」等）
× 「ご確認のほどよろしくお願いいたします」などの文末定型句を末尾に付け足す
× お客様が聞いていない情報を補足で足す
× 「まず」「次に」など列挙する構成
× スモラが前回の返信で既に言ったことをもう一度書く
⭐実例・ナレッジで学んだ口調・長さ感を必ず参照すること`;

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

  let analysisBlock = "";
  if (analysis) {
    try {
      const parsed = JSON.parse(analysis) as Record<string, string>;
      analysisBlock = `
【お客様状況の深層分析（必ず参考にすること）】
・感情状態：${parsed.emotion || ""}
・本当のニーズ・懸念：${parsed.real_need || ""}
・重要な気づき：${parsed.key_insight || ""}
・最適な返し方の方針：${parsed.approach || ""}
・適切なトーン：${parsed.tone || ""}`;
    } catch {
      analysisBlock = "";
    }
  }

  const prompt = `
${nameNote}
【現在の営業フェーズ】${state} → 次フェーズ：${nextState}

【直近の会話履歴（スモラ自身の返信も含む）】
${history || "なし"}
${analysisBlock}
${knowledge}
${examples}
${phrases}

【お客様の最新メッセージ】
${customerMessage}

上記の分析と会話の流れを踏まえ、スモラスタイルのLINE返信案を1つだけ作成してください。`;

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
      .slice(-40)
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
