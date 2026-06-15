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

// ─── 4パターン定義（方向性のみ指定・文体は実例に任せる）──────────────────
// ※ スタイル強制禁止。文長・絵文字数・口調は実例から自然に継承させる。
// 4つの違いは「何を優先して返すか（方向性）」だけ。
export const REPLY_ANGLES = [
  {
    angle: "answer_first",
    label: "正面回答",
    direction: "お客様の質問・相談に正面から答えることを最優先にする。事実・手順・数字を具体的に示して信頼を得る返し。",
  },
  {
    angle: "reassure",
    label: "安心先取り",
    direction: "お客様が感じているであろう不安・懸念を先取りして解消することを最優先にする。リスクも正直に伝えつつ代替案・解決策をセットで提示する返し。",
  },
  {
    angle: "options",
    label: "選択肢提示",
    direction: "複数の選択肢・代替案・次の手をシンプルに並べて提示することを最優先にする。お客様が自分で判断・選択できる形にまとめる返し。",
  },
  {
    angle: "next_action",
    label: "次のアクション",
    direction: "質問に答えながら、内覧・申込・ご連絡など次の具体的なアクションを自然な流れで提案することを最優先にする返し。",
  },
] as const;

export type AngleKey = (typeof REPLY_ANGLES)[number]["angle"];

// ─── フェーズ別行動指針（簡略版）────────────────────────────────────────────
const PHASE_GUIDE: Record<string, string> = {
  first_reply: `今すべきこと: 初回挨拶＋条件ヒアリング開始。「〇〇さん初めまして😊！！この度ご連絡頂きありがとうございます！！担当させて頂きます鈴木と申します！！」で始める。条件フォームを送る場合は①入居時期 ②家賃 ③間取り ④築年数 ⑤エリア・駅 ⑥駅徒歩 ⑦初期費用 ⑧その他 の形式。`,
  hearing: `会話状況を判断して対応:
・条件がまだ届いていない → 条件フォームを送る
・条件の一部しかない → 足りない条件を1点だけ確認（複数聞かない）
・条件が揃った → 条件を具体的に復唱して「本日中にピックアップしお送りします」と宣言
・URLや物件名を送ってきた → 「募集状況確認させていただきます！」`,
  proposing: `会話状況を判断して対応:
・物件画像を送付済み → 内覧/申込へ誘導（画像を再送しない）
・「検討します」「また連絡します」→ 好条件一言＋申込促し＋新着継続サポートの3点セット
・お客様がURLを送ってきた → 「募集状況確認させていただきます！」
・退去予定物件は「退去予定のためお申込みでお部屋抑えさせて頂きます！」を添える`,
  applying: `会話状況を判断して対応:
・内覧日程調整 → 具体的な日時を複数提示
・申込方法を聞かれた → 「全てLINEで完結」と伝える
・初期費用の確認 → 「はい！！」で直接答える
・キャンセル可否 → 「保証会社審査通過前はキャンセル料一切なし」`,
  closed_won: `入居準備のサポート。感謝と次のステップを伝える。`,
};

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

// ─── JST時刻 ─────────────────────────────────────────────────────────────────
function getJSTHour(): number {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
}
function getJSTDayOfWeek(): number {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCDay();
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
  state: string,
  analysis: string,
  knowledge: string,
  examples: string,
  customerConditions: string,
  customerSummary: string,
): Promise<string> {
  // 時刻・挨拶ルール
  const jstHour = getJSTHour();
  const jstDay = getJSTDayOfWeek();
  const isWeekend = jstDay === 0 || jstDay === 6;

  const historyLines = (history || "").split("\n").filter(Boolean);
  const alreadyGreeted = historyLines.filter(l => l.startsWith("スモラ:"))
    .some(l => l.includes("お世話になっております") || l.includes("夜分遅くに失礼"));

  const greetingNote = alreadyGreeted
    ? `\n【⏰ 挨拶ルール最優先】本日の会話で冒頭挨拶は使用済み。今回は「はい！！」「かしこまりました！！」など短い言葉で直接始める。`
    : jstHour >= 21
      ? `\n【⏰ 時刻ルール最優先】現在${jstHour}時台（JST）。冒頭は「〇〇さん夜分遅くに失礼致します！！」を使う。`
      : `\n【⏰ 時刻ルール最優先】現在${jstHour}時台（JST）。冒頭挨拶は「〇〇さんお世話になっております！！」を使う。「夜分遅くに」は使用禁止。`;

  const managementNote = isWeekend
    ? `\n【管理会社】本日は土日。空室確認は可。交渉（フリーレント・値引き・審査再挑戦）は不可。交渉が必要なら「月曜日一番で管理会社に交渉させていただきます！！」と伝える。`
    : jstHour >= 18
      ? `\n【管理会社】${jstHour}時台。18時以降のため管理会社の営業時間終了。確認が必要な場合「明日一番でご確認しご連絡させて頂きます！！」と伝える。当日中の回答を約束しない。`
      : `\n【管理会社】平日営業中。確認が必要な場合「管理会社に確認させていただきます！！確認出来次第ご連絡させていただきます！！」と伝えてよい。`;

  // 分析からの方針注入
  let analysisNote = "";
  if (analysis) {
    try {
      const p = JSON.parse(analysis) as Record<string, unknown>;
      if (p.approach) analysisNote = `\n【返し方の方針】${p.approach}（トーン: ${p.tone || "自然に"}）`;

      // 質問検出
      if (Array.isArray(p.questions) && (p.questions as string[]).length > 0) {
        const questions = p.questions as string[];
        const anxietyKeywords = ["名義", "審査", "保証", "リスク", "キャンセル", "退去", "違約", "トラブル", "詐称", "仲違い", "離婚", "死亡", "相続", "ペット", "同居"];
        const isAnxietyQuestion = questions.some(q => anxietyKeywords.some(k => q.includes(k)));
        if (questions.length > 1) {
          analysisNote += `\n【複数質問（全て漏れなく答えること）】${questions.map((q, i) => `${i + 1}. ${q}`).join(" / ")}`;
        }
        if (isAnxietyQuestion) {
          analysisNote += `\n【⚠️ 不安系質問検出】お客様はリスク・ルール・法的な点について不安を持っている。曖昧・ぼかした回答は信頼を損なう。事実・手順・リスクを具体的に説明し、リスクがある場合は正直に伝えた上で代替案をセットで提示すること。`;
        }
      }

      if (p.current_property && typeof p.current_property === "string") {
        analysisNote += `\n【話題の物件】${p.current_property} — この物件の文脈で返信すること`;
      }
    } catch { /* ignore */ }
  }

  const conditionsNote = customerConditions
    ? `\n【お客様の希望条件（DB登録済み・必ず考慮）】\n${customerConditions}` : "";
  const summaryNote = customerSummary
    ? `\n【このお客さんの人物像・特徴】${customerSummary}` : "";

  const phaseGuide = PHASE_GUIDE[state] ?? PHASE_GUIDE["first_reply"];

  const systemPrompt = `あなたはスモラ（賃貸仲介）のLINE営業担当です。
返信を1つだけ生成してください。

【この返信で最優先にすること（方向性）】
${angle.direction}

【現在の営業フェーズ: ${state}】
${phaseGuide}

【質問・相談への回答ルール — 最重要】
お客様から質問・相談（名義貸し・審査・費用・退去・キャンセル等）を受けた場合は「本質的・具体的」に答える。
× 曖昧・ぼかした回答（「〜の可能性があります」「〜かもしれません」）→ 不安なお客様の信頼を損なう
○ 事実・手順・リスク・数字を具体的に示す。リスクがあれば正直に伝え、代替案もセットで提示する

【共通ルール】
・文体・言い回し・文の長さ・絵文字の使い方は⭐実例に完全に合わせる（スタイルを自分で変えない）
・絵文字は 😊 😌 🌟 ✨ の4つのみ・1〜2個まで・文末か区切りのみ
・感嘆符「！」「！！」を文脈で使い分け
・「させて頂きます」「頂きます」を多用する（スモラの文体の核心）
・お客様名が「不明」の場合は名前を絶対に使わない
・担当者名が必要な場合は「鈴木」を使う
・返信案1つのみ生成（説明・注釈・「---」などを付けない）
・お客様が言ったことは繰り返さない → 次のアクションへ直行`;

  const userPrompt = `お客様名: ${customerName || "不明"}${conditionsNote}${summaryNote}${greetingNote}${managementNote}${analysisNote}

【直近の会話履歴（スモラ:=自分の返信 / お客様:=顧客）】
${history || "なし"}
${knowledge}
${examples}

【お客様の最新メッセージ】
${customerMessage}

上記⭐実例の文体・言い回し・感嘆符・絵文字を完全に再現しながら、「${angle.direction}」という方向性で返信を1つ生成してください。`;

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
    customerConditions?: string;
    customerSummary?: string;
  };
  const {
    message,
    state,
    customerName = "",
    recentMessages = [],
    customerConditions = "",
    customerSummary = "",
  } = body;

  if (!message || message === "[画像]" || message === "[動画]") {
    return NextResponse.json({ ok: false, error: "有効なメッセージが必要です" }, { status: 400 });
  }

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

  // Step3: 最大4パターンを並列生成（失敗した分は除外してそのまま返す）
  const results = await Promise.all(
    REPLY_ANGLES.map(angle =>
      generateOnePattern(
        angle, message, customerName, history, currentState,
        analysis, knowledge, examples, customerConditions, customerSummary,
      )
    )
  );

  const patterns = REPLY_ANGLES.map((angle, i) => ({
    angle: angle.angle,
    label: angle.label,
    text: results[i] || "",
  })).filter(p => p.text.length > 0);

  return NextResponse.json({ ok: true, patterns });
}
