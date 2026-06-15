import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";

const analysisModel = new ChatAnthropic({
  model: "claude-haiku-4-5-20251001",
  maxTokens: 1024,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

const generationModel = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  maxTokens: 700,
  temperature: 0.55,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// ─── 4パターン定義 ──────────────────────────────────────────────────────────
export const REPLY_ANGLES = [
  {
    angle: "short_direct",
    label: "簡潔",
    instruction: `【角度: 簡潔】
このパターンは「短くスパッと」返す。
・2〜3行が目標（長くても4行まで）
・「はい！！」「かしこまりました！！」で直接始める（冒頭挨拶なし）
・絵文字は0〜1個
・次の1アクションだけ伝える・余計な説明は入れない`,
  },
  {
    angle: "empathy",
    label: "共感",
    instruction: `【角度: 共感】
このパターンは「お客様の気持ちに寄り添う」返信。
・お客様の感情・状況を受け止める一言を冒頭に入れる
・「ご安心ください」「全力でサポートさせて頂きます」など安心感の言葉を使う
・温かみのあるトーン・押しつけがましくない
・絵文字は😊 😌 を1〜2個`,
  },
  {
    angle: "conversion",
    label: "背中を押す",
    instruction: `【角度: 背中を押す】
このパターンは「申込・内覧・次のアクションへの誘導」が目的。
・希少性・タイミングを1文添える（「かなり好条件のお部屋ですので」「繁忙期に入ると同様の物件は減ります」等）
・「お申込みでお部屋抑えさせて頂きます！！」など具体アクションを強めに促す
・プレッシャーを与えすぎず自然に背中を押す`,
  },
  {
    angle: "info_detail",
    label: "丁寧・詳しく",
    instruction: `【角度: 丁寧・詳しく】
このパターンは「具体的な数字・情報・流れ」を提供する返信。
・曖昧な表現を避け具体的な数字・日程・金額・ステップを使う
・「①〜 ②〜 ③〜」など流れを簡潔に説明するのも可
・5〜8行程度でしっかり情報を伝える
・「〇〇となっております😊！！」など丁寧な説明口調`,
  },
] as const;

export type AngleKey = (typeof REPLY_ANGLES)[number]["angle"];

// ─── ステート正規化 ──────────────────────────────────────────────────────────
const STATE_SEARCH_ALIASES: Record<string, string[]> = {
  first_reply: ["first_reply"],
  hearing:     ["hearing", "condition_hearing", "property_search"],
  proposing:   ["proposing", "property_recommendation", "viewing", "estimate_request", "availability_check"],
  applying:    ["applying", "application", "screening", "contract"],
  closed_won:  ["closed_won"],
};
const STATE_ALIAS: Record<string, string> = {
  condition_hearing: "hearing", property_search: "hearing",
  property_recommendation: "proposing", viewing: "proposing",
  estimate_request: "proposing", availability_check: "proposing",
  application: "applying", screening: "applying", contract: "applying",
};
function normalizeState(k: string): string {
  const r = STATE_ALIAS[k] ?? k;
  return STATE_SEARCH_ALIASES[r] ? r : "first_reply";
}

// ─── Haiku 分析 ──────────────────────────────────────────────────────────────
async function analyzeCustomer(message: string, history: string, state: string, name: string): Promise<string> {
  const prompt = `【営業フェーズ】${state}\n【お客様名】${name || "不明"}\n【直近の会話履歴】\n${history || "なし"}\n【最新メッセージ】\n${message}\n\n以下をJSONで分析してください：\n{"emotion":"","real_need":"","approach":"","tone":"","questions":[],"hesitancy_pattern":null,"current_property":null}`;
  try {
    const res = await analysisModel.invoke([
      new SystemMessage("あなたは賃貸仲介の営業コーチです。JSONのみで返答。"),
      new HumanMessage(prompt),
    ]);
    const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const match = text.match(/\{[\s\S]*\}/);
    return match ? match[0] : "";
  } catch { return ""; }
}

// ─── OpenAI 埋め込み ─────────────────────────────────────────────────────────
async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch { return null; }
}

// ─── 実例取得 ────────────────────────────────────────────────────────────────
async function fetchExamples(state: string, message: string, analysisCtx?: string): Promise<string> {
  const aliases = STATE_SEARCH_ALIASES[state] || [state];
  const query = analysisCtx ? `${state}: ${message} パターン: ${analysisCtx}` : `${state}: ${message}`;
  if (process.env.OPENAI_API_KEY) {
    const embedding = await getEmbedding(query);
    if (embedding) {
      const { data: similar } = await supabase.rpc("match_reply_examples", {
        query_embedding: embedding, match_count: 15, filter_states: aliases,
      }) as { data: Array<{ customer_message: string; sent_reply: string; is_starred: boolean; similarity: number }> | null };
      if (similar && similar.length > 0) {
        const above = similar.filter(e => e.similarity >= 0.45);
        if (above.length > 0) {
          const sorted = [...above].sort((a, b) => {
            const sa = a.similarity + (a.is_starred ? 0.15 : 0);
            const sb = b.similarity + (b.is_starred ? 0.15 : 0);
            return sb - sa;
          }).slice(0, 6);
          return "\n\n【⭐ スモラの実際の返信例（文体・言い回し・感嘆符・絵文字を最優先で再現すること）】\n" +
            sorted.map((e, i) =>
              `[例${i + 1}${e.is_starred ? "⭐" : ""}]\nお客様: 「${e.customer_message}」\nスモラ: 「${e.sent_reply}」`
            ).join("\n\n");
        }
      }
    }
  }
  // フォールバック
  const { data } = await supabase.from("ai_reply_examples")
    .select("customer_message, sent_reply, is_starred")
    .in("conversation_state", aliases)
    .not("embedding", "is", null)
    .order("is_starred", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(6);
  if (!data || data.length === 0) return "";
  return "\n\n【⭐ スモラの実際の返信例】\n" +
    data.map((e, i) => `[例${i + 1}]\nお客様: 「${e.customer_message}」\nスモラ: 「${e.sent_reply}」`).join("\n\n");
}

// ─── ナレッジ取得 ────────────────────────────────────────────────────────────
async function fetchKnowledge(state: string): Promise<string> {
  const aliases = STATE_SEARCH_ALIASES[state] || [state];
  const [{ data: diff }, { data: specific }] = await Promise.all([
    supabase.from("ai_reply_knowledge").select("content")
      .ilike("title", "%差分学習%").gte("importance", 9)
      .order("created_at", { ascending: false }).limit(10),
    supabase.from("ai_reply_knowledge").select("content, importance")
      .in("conversation_state", aliases).gte("importance", 7)
      .not("title", "ilike", "%差分学習%")
      .order("importance", { ascending: false }).limit(10),
  ]);
  const parts: string[] = [];
  if ((diff?.length ?? 0) > 0) parts.push("【AIが過去に間違えたパターン（必ず守る）】\n" + diff!.map(k => `・${k.content}`).join("\n"));
  if ((specific?.length ?? 0) > 0) parts.push("【スモラの営業ルール】\n" + specific!.map(k => `・${k.content}`).join("\n"));
  return parts.join("\n\n");
}

// ─── 1パターン生成 ──────────────────────────────────────────────────────────
async function generateOnePattern(
  angle: typeof REPLY_ANGLES[number],
  customerMessage: string,
  customerName: string,
  history: string,
  analysis: string,
  knowledge: string,
  examples: string,
): Promise<string> {
  let analysisNote = "";
  if (analysis) {
    try {
      const p = JSON.parse(analysis) as Record<string, unknown>;
      if (p.approach) analysisNote = `\n【返し方の方針】${p.approach}（トーン: ${p.tone || "自然に"}）`;
      if (Array.isArray(p.questions) && (p.questions as string[]).length > 1) {
        analysisNote += `\n【複数質問（全て答えること）】${(p.questions as string[]).map((q, i) => `${i+1}. ${q}`).join(" / ")}`;
      }
    } catch { /* ignore */ }
  }

  const systemPrompt = `あなたはスモラ（賃貸仲介）のLINE営業担当です。
以下の角度でLINE返信を1つだけ生成してください。

${angle.instruction}

【共通ルール】
・絵文字は 😊 😌 🌟 ✨ の4つのみ・1〜2個まで・文末か区切りのみ
・感嘆符「！」「！！」を文脈で使い分け
・「させて頂きます」「頂きます」を多用する（スモラの文体の核心）
・お客様名が「不明」の場合は名前を絶対に使わない
・担当者名が必要な場合は「鈴木」を使う
・返信案1つのみ生成（説明・注釈・「---」などを付けない）`;

  const userPrompt = `お客様名: ${customerName || "不明"}
【直近の会話履歴】
${history || "なし"}
${knowledge}${analysisNote}
${examples}

【お客様の最新メッセージ】
${customerMessage}

上記例の文体・言い回し・感嘆符・絵文字を最優先で再現しながら、${angle.label}な返信を1つ生成してください。`;

  try {
    const res = await generationModel.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);
    return typeof res.content === "string" ? res.content.trim() : "";
  } catch {
    return "";
  }
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  type RecentMessage = { sender: string; text: string; imageUrl?: string };
  const body = await req.json() as {
    message: string;
    state: string;
    customerName?: string;
    recentMessages?: RecentMessage[];
  };
  const { message, state, customerName = "", recentMessages = [] } = body;
  if (!message) return NextResponse.json({ ok: false, error: "message required" }, { status: 400 });

  const currentState = normalizeState(state || "first_reply");

  const history = recentMessages.slice(-20).map((m) => {
    const who = m.sender === "customer" ? "お客様" : "スモラ";
    if (!m.text || m.text === "[画像]" || m.text === "[動画]") return `${who}: 【画像/動画】`;
    return `${who}: ${m.text}`;
  }).join("\n");

  // Step1: 分析（先行）
  const analysis = await analyzeCustomer(message, history, currentState, customerName);

  // 分析結果からクエリ強化キーワードを抽出
  const analysisCtx = (() => {
    try {
      const p = JSON.parse(analysis) as Record<string, unknown>;
      const parts: string[] = [];
      if (p.approach && typeof p.approach === "string") parts.push(p.approach.slice(0, 60));
      const hp = p.hesitancy_pattern;
      if (hp === "thinking") parts.push("検討します また連絡します");
      else if (hp === "waiting") parts.push("少し待ってほしい キャンセル");
      return parts.join(" ") || undefined;
    } catch { return undefined; }
  })();

  // Step2: knowledge + examples を並列取得
  const [knowledge, examples] = await Promise.all([
    fetchKnowledge(currentState),
    fetchExamples(currentState, message, analysisCtx),
  ]);

  // Step3: 4パターンを並列生成
  const results = await Promise.all(
    REPLY_ANGLES.map(angle =>
      generateOnePattern(angle, message, customerName, history, analysis, knowledge, examples)
    )
  );

  const patterns = REPLY_ANGLES.map((angle, i) => ({
    angle: angle.angle,
    label: angle.label,
    text: results[i] || "",
  })).filter(p => p.text.length > 0);

  return NextResponse.json({ ok: true, patterns });
}
