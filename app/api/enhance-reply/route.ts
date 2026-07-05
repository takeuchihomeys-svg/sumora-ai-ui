import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 30;

const STATE_SEARCH_ALIASES: Record<string, string[]> = {
  first_reply: ["first_reply"],
  hearing:     ["hearing", "condition_hearing", "property_search"],
  proposing:   ["proposing", "property_recommendation", "viewing", "estimate_request", "availability_check", "property_send"],
  applying:    ["applying", "application", "screening", "contract", "application_push"],
  closed_won:  ["closed_won"],
};
const STATE_NORMALIZE: Record<string, string> = {
  condition_hearing: "hearing", property_search: "hearing",
  property_recommendation: "proposing", viewing: "proposing",
  estimate_request: "proposing", availability_check: "proposing",
  property_send: "proposing",
  application: "applying", screening: "applying", contract: "applying",
  application_push: "applying",
};

async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

const ANGLE_LABEL: Record<string, string> = { A: "王道", B: "シンプル", C: "C案", short_direct: "短く直接" };

async function fetchEnhanceContext(state: string, customerMessage?: string, lastStaffMsg?: string): Promise<{ knowledge: string; examples: string }> {
  const normalized = STATE_NORMALIZE[state] ?? state;
  const aliases = STATE_SEARCH_ALIASES[normalized] || [normalized];

  // A: ナレッジを差分学習・修正対比・一般・グローバルの4層で並列取得
  const [{ data: diffLearned }, { data: correctionPairs }, { data: knowledgeRows }, { data: globalKnowledge }, embedding] = await Promise.all([
    // ① 差分学習: AIが間違えた→正解ルール（最優先）
    supabase.from("ai_reply_knowledge")
      .select("category, title, content, importance")
      .ilike("title", "%差分学習%").gte("importance", 7)
      .order("created_at", { ascending: false }).limit(15),
    // ② 修正対比: スタッフがどう直したかのパターン
    supabase.from("ai_reply_knowledge")
      .select("category, title, content, importance")
      .ilike("title", "%修正対比%").in("conversation_state", aliases)
      .order("importance", { ascending: false }).limit(12),
    // ③ フェーズ別ナレッジ
    supabase.from("ai_reply_knowledge")
      .select("category, title, content, importance")
      .in("conversation_state", aliases).gte("importance", 8)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(10),
    // ④ グローバル横断ナレッジ（全フェーズ共通・高importance）
    supabase.from("ai_reply_knowledge")
      .select("category, title, content, importance")
      .gte("importance", 8)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .not("category", "eq", "principle")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(8),
    customerMessage && process.env.OPENAI_API_KEY
      ? getEmbedding(lastStaffMsg
          ? `${normalized}: [前返信]${lastStaffMsg.slice(0, 100)} [顧客]${customerMessage}`
          : `${normalized}: ${customerMessage}`)
      : Promise.resolve(null),
  ]);

  // ③と④の重複除去
  const stateKeys = new Set((knowledgeRows ?? []).map((k) => k.content));
  const globalDeduped = (globalKnowledge ?? []).filter((k) => !stateKeys.has(k.content));

  // ナレッジ文字列を構築（差分学習→修正対比→フェーズ別→グローバルの4層）
  const knowledgeSections: string[] = [];
  if (diffLearned?.length) {
    knowledgeSections.push("【🔴 AIが過去に間違えたパターン（最優先）】\n" + diffLearned.slice(0, 15).map((k) => `・${k.content}`).join("\n"));
  }
  if (correctionPairs?.length) {
    knowledgeSections.push("【🟠 スタッフが修正したポイント】\n" + correctionPairs.slice(0, 8).map((k) => `・${k.content}`).join("\n"));
  }
  if (knowledgeRows?.length) {
    knowledgeSections.push("【スモラのノウハウ（必ず従うこと）】\n" + (knowledgeRows as { category: string; content: string }[]).map((r) => `・[${r.category}] ${r.content}`).join("\n"));
  }
  if (globalDeduped.length > 0) {
    knowledgeSections.push("【スモラ共通ノウハウ】\n" + globalDeduped.map((k) => `・${k.content}`).join("\n"));
  }
  const knowledge = knowledgeSections.length > 0 ? "\n" + knowledgeSections.join("\n\n") : "";

  // B: pgvector + reply_angleブースト（generate-replyと同じスコアリング）
  if (embedding) {
    const { data: similar, error: rpcError } = await supabase.rpc("match_reply_examples", {
      query_embedding: embedding,
      match_count: 15,
      filter_states: aliases,
    }) as { data: Array<{ customer_message: string; sent_reply: string; conversation_state: string; is_starred: boolean; reply_angle: string | null; similarity: number }> | null; error: unknown };

    if (!rpcError && similar && similar.length > 0) {
      const sorted = [...similar].sort((a, b) => {
        const scoreA = a.similarity + (a.is_starred ? 0.15 : 0) + (a.reply_angle ? 0.1 : 0);
        const scoreB = b.similarity + (b.is_starred ? 0.15 : 0) + (b.reply_angle ? 0.1 : 0);
        return scoreB - scoreA;
      }).slice(0, 10);

      const examples = "\n【⭐ スモラの実際の送信例（状況が類似した良質な実例・類似度順）— 文体・言い回し・感嘆符・絵文字はこれに合わせる。ラベル: 王道=標準スモラスタイル / シンプル=短く簡潔 / C案=別角度アプローチ】\n" +
        sorted.map((ex, i) => {
          const angleTag = ex.reply_angle && ex.reply_angle !== "starred" ? `|${ANGLE_LABEL[ex.reply_angle] ?? ex.reply_angle}` : "";
          return `[例${i + 1}${ex.is_starred ? "⭐" : ""}${angleTag}]\nお客様:「${ex.customer_message}」\nスモラ:「${ex.sent_reply}」`;
        }).join("\n\n");

      return { knowledge, examples };
    }
  }

  // フォールバック: ☆つき実例をフェーズ別に取得
  const { data: exampleRows } = await supabase.from("ai_reply_examples")
    .select("customer_message, sent_reply, reply_angle")
    .in("conversation_state", aliases)
    .eq("is_starred", true)
    .order("created_at", { ascending: false })
    .limit(10);

  const examples = (exampleRows || []).length > 0
    ? "\n【⭐ スモラの実際の送信例（文体・感嘆符・絵文字はこれに合わせる。ラベル: 王道=標準スモラスタイル / シンプル=短く簡潔 / C案=別角度アプローチ）】\n" +
      (exampleRows as { customer_message: string; sent_reply: string; reply_angle?: string | null }[])
        .map((r, i) => {
          const angleTag = r.reply_angle && r.reply_angle !== "starred" ? `|${{"A":"王道","B":"シンプル","C":"C案","short_direct":"短く直接"}[r.reply_angle] ?? r.reply_angle}` : "";
          return `[例${i + 1}${angleTag}]\nお客様:「${r.customer_message}」\nスモラ:「${r.sent_reply}」`;
        })
        .join("\n\n")
    : "";

  return { knowledge, examples };
}

const BASE_SYSTEM = `あなたは賃貸仲介サービス「スモラ」のLINE文章改善AIです。
スタッフが入力した下書き・単語・メモをもとに、スモラらしい完成されたLINEメッセージに仕上げてください。

【スモラの営業スタイル — 最重要】
「誘導」とはお客様を考えさせないこと。スタッフが常に先手を打って次のアクションを示す。
→ 条件をもらったら「ピックアップします」と即動く
→ 物件を送ったら「お気に召されましたらお申込みでお部屋抑えさせて頂きます！！」と次を示す
→ お客様がすべきことは最小限（フォーム入力・承認・日程を言うだけ）。それ以外はすべてスタッフがやる
この姿勢がお客様の信頼を生み「任せよう」という気持ちを作る。

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字：😊 😌 🙇‍♀️ 🌟 ✨ のみ（他は全禁止）
▼ 絵文字は1〜2個まで。文末か文の区切りのみ。

【出力ルール】
・LINEでそのまま送れる完成文のみを出力する
・解説・補足・括弧書きは禁止
・候補は1つだけ
・感嘆符は「！！」（スモラスタイル）`;

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  const { currentDraft, conversationState, customerName, recentMessages, customerConditions, customerSummary, activeTasks } = await req.json() as {
    currentDraft: string;
    conversationState?: string;
    customerName?: string;
    recentMessages?: Array<{ sender: string; text: string }>;
    customerConditions?: string;
    customerSummary?: string;
    activeTasks?: string[];
  };

  if (!currentDraft?.trim()) {
    return NextResponse.json({ ok: false, error: "currentDraft required" }, { status: 400 });
  }

  // 直近のお客様メッセージを抽出（pgvector 類似検索のキーとして使用）
  const lastCustomerMsg = (recentMessages || [])
    .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .slice(-1)[0]?.text;

  // 直前のスタッフ返信を抽出（embeddingコンテキスト強化）
  const lastStaffMsg = (recentMessages || [])
    .filter((m) => m.sender === "staff" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .slice(-1)[0]?.text;

  // knowledge + examples を取得（pgvector 対応）
  const { knowledge, examples } = await fetchEnhanceContext(
    conversationState || "hearing",
    lastCustomerMsg,
    lastStaffMsg
  );

  const history = (recentMessages || [])
    .slice(-15)
    .filter((m) => m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .map((m) => `${m.sender === "customer" ? "お客様" : "スモラ"}: ${m.text}`)
    .join("\n");

  const TASK_LABEL: Record<string, string> = { property_check: "物件確認", property_send: "物件出し" };
  const nameNote = customerName ? `お客様名：${customerName}さん` : "";
  const conditionsNote = customerConditions ? `\n【お客様の希望条件】\n${customerConditions}` : "";
  const summaryNote = customerSummary ? `\n【このお客さんのAI要約 — 今の状況・次の必須対応を最優先で文案に反映すること。人物像・文体も合わせること】\n${customerSummary}` : "";
  const stateNote = conversationState ? `現在の営業フェーズ：${conversationState}` : "";
  const taskNote = (activeTasks && activeTasks.length > 0)
    ? `\n【現在対応中のタスク — このタスクの内容に沿ったメッセージに仕上げること】\n${activeTasks.map((t) => `・${TASK_LABEL[t] ?? t}`).join("\n")}`
    : "";

  const system = `${BASE_SYSTEM}${knowledge}${examples}`;

  const userPrompt = `
${nameNote}${conditionsNote}${summaryNote}${taskNote}
${stateNote}

【直近の会話】
${history || "なし"}

【スタッフが入力した下書き・単語・メモ】
${currentDraft.trim()}

上記の下書きを、スモラの実例・ノウハウに沿ったLINEメッセージに仕上げてください。`.trim();

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ ok: false, error: err }, { status: 500 });
    }

    const data = await res.json() as { content?: Array<{ text: string }> };
    const enhanced = data.content?.[0]?.text?.trim() || "";

    return NextResponse.json({ ok: true, enhanced });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
