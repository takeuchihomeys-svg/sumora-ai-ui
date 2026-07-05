import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";
import { PHASE_GUIDE, REAL_ESTATE_RULES, SMORA_QUICK_PATTERNS, EMOJI_RULE, STATE_SEARCH_ALIASES, CRITICAL_RULES_COMPACT } from "@/app/lib/line-reply-prompts";
import { validateAndClean } from "@/app/lib/validate-reply";

export const maxDuration = 30;

const analysisModel = new ChatAnthropic({
  model: "claude-haiku-4-5-20251001",
  maxTokens: 1024,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

const generationModel = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  maxTokens: 2000,
  temperature: 0.65,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

const PATTERN_LABELS = ["A", "B", "C"] as const;




// ─── ステート正規化 ──────────────────────────────────────────────────────────
// STATE_SEARCH_ALIASES は @/app/lib/line-reply-prompts からインポート済み
const STATE_ALIAS: Record<string, string> = {
  condition_hearing: "hearing", property_search: "hearing",
  property_recommendation: "proposing", viewing: "proposing",
  estimate_request: "proposing", availability_check: "proposing", property_send: "proposing",
  application: "applying", screening: "applying", contract: "applying", application_push: "applying",
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
// JST 当日（0:00〜23:59）の開始時刻（UTC）を返す
function getJSTDayStart(): Date {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate(), 0, 0, 0, 0));
}
// JST 当日の終了時刻（UTC）を返す
function getJSTDayEnd(): Date {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate(), 23, 59, 59, 999));
}

// ─── Haiku 分析（1案と同じフィールド数に拡張）───────────────────────────────
async function analyzeCustomer(message: string, history: string, state: string, name: string): Promise<string> {
  const prompt = `【営業フェーズ】${state}\n【お客様名】${name || "不明"}\n【直近の会話履歴】\n${history || "なし"}\n【最新メッセージ】\n${message}\n\n以下をJSONで分析してください：\n{"emotion":"","real_need":"","approach":"","tone":"","questions":[],"hesitancy_pattern":null,"future_timeline":null,"repeated_concern":null,"current_property":null}`;
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

// ─── 実例取得（6件→12件に増加）──────────────────────────────────────────────
async function fetchExamples(state: string, message: string, analysisCtx?: string, lastStaffMsg?: string): Promise<string> {
  const aliases = STATE_SEARCH_ALIASES[state] || [state];
  // 前のスタッフ返信をコンテキストに含めると「わかりました」等の汎用返答でも文脈が特定できる
  const baseQuery = lastStaffMsg
    ? `${state}: [前返信]${lastStaffMsg.slice(0, 100)} [顧客]${message}`
    : `${state}: ${message}`;
  const query = analysisCtx ? `${baseQuery} パターン: ${analysisCtx}` : baseQuery;
  if (process.env.OPENAI_API_KEY) {
    const embedding = await getEmbedding(query);
    if (embedding) {
      const { data: similar } = await supabase.rpc("match_reply_examples", {
        query_embedding: embedding, match_count: 20, filter_states: aliases,
      }) as { data: Array<{ customer_message: string; sent_reply: string; is_starred: boolean; reply_angle: string | null; similarity: number }> | null };
      if (similar && similar.length > 0) {
        const above = similar.filter(e => e.similarity >= 0.45);
        if (above.length > 0) {
          const sorted = [...above].sort((a, b) => {
            // ★+0.15 に加え、4案から選ばれた実例（reply_angle あり）は+0.1 追加ブースト
            const sa = a.similarity + (a.is_starred ? 0.15 : 0) + (a.reply_angle ? 0.1 : 0);
            const sb = b.similarity + (b.is_starred ? 0.15 : 0) + (b.reply_angle ? 0.1 : 0);
            return sb - sa;
          }).slice(0, 25);
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
    .eq("is_starred", true)
    .order("created_at", { ascending: false })
    .limit(25);
  if (!data || data.length === 0) return "";
  return "\n\n【⭐ スモラの実際の返信例】\n" +
    data.map((e, i) => `[例${i + 1}]\nお客様: 「${e.customer_message}」\nスモラ: 「${e.sent_reply}」`).join("\n\n");
}

// ─── ナレッジ取得（3層）────────────────────────────────────────────────────
async function fetchKnowledge(state: string, customerMessage?: string): Promise<string> {
  const aliases = STATE_SEARCH_ALIASES[state] || [state];

  // pgvector検索（customerMessageがある場合・OPENAI_API_KEYが設定済みの場合）
  if (customerMessage && process.env.OPENAI_API_KEY) {
    const embedding = await getEmbedding(`${state}: ${customerMessage}`.slice(0, 2000));
    if (embedding) {
      const { data: vectorResults } = await supabase.rpc("match_reply_knowledge", {
        query_embedding: embedding,
        match_count: 20,
        min_importance: 7,
      }) as { data: Array<{ id: string; title: string; content: string; category: string; conversation_state: string; importance: number; similarity: number }> | null };

      if (vectorResults && vectorResults.length > 0) {
        // 差分学習ルールを類似度降順・上位8件に絞る
        const diffLearned = vectorResults.filter(r => r.title.includes("差分学習")).slice(0, 8);
        const correctionPairs = vectorResults.filter(r => r.title.includes("修正対比")).slice(0, 8);
        const stateSpecific = vectorResults.filter(r => !r.title.includes("差分学習") && !r.title.includes("修正対比") && aliases.includes(r.conversation_state)).slice(0, 12);
        const globalKnowledge = vectorResults.filter(r => !r.title.includes("差分学習") && !r.title.includes("修正対比") && !aliases.includes(r.conversation_state) && r.importance >= 8).slice(0, 8);

        const stateKeys = new Set(stateSpecific.map(k => k.content));
        const globalDeduped = globalKnowledge.filter(k => !stateKeys.has(k.content));

        const parts: string[] = [];
        if (diffLearned.length > 0) parts.push("【🔴 AIが過去に間違えたパターン（最優先・必ず守る）】\n" + diffLearned.map(k => `・${k.content}`).join("\n"));
        if (correctionPairs.length > 0) parts.push("【🟠 スタッフが修正したポイント】\n" + correctionPairs.map(k => `・${k.content}`).join("\n"));
        if (stateSpecific.length > 0) parts.push("【スモラの営業ルール】\n" + stateSpecific.map(k => `・${k.content}`).join("\n"));
        if (globalDeduped.length > 0) parts.push("【スモラ共通ノウハウ】\n" + globalDeduped.map(k => `・${k.content}`).join("\n"));
        if (parts.length > 0) return parts.join("\n\n");
      }
    }
  }

  // フォールバック: created_at/importance順検索
  const [{ data: diffLearned }, { data: correctionPairs }, { data: stateSpecific }, { data: global }] = await Promise.all([
    // ① 差分学習: AIが間違えた→正解ルール（最優先）
    supabase.from("ai_reply_knowledge").select("content")
      .ilike("title", "%差分学習%").gte("importance", 7)
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(20),
    // ② 修正対比: スタッフがどう直したかのパターン
    supabase.from("ai_reply_knowledge").select("content")
      .ilike("title", "%修正対比%").in("conversation_state", aliases)
      .order("importance", { ascending: false }).limit(12),
    // ③ フェーズ別ナレッジ
    supabase.from("ai_reply_knowledge").select("content, importance")
      .in("conversation_state", aliases).gte("importance", 7)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .order("importance", { ascending: false }).limit(12),
    // ④ グローバル横断ナレッジ（全フェーズ共通・高importance）
    supabase.from("ai_reply_knowledge").select("content, importance")
      .gte("importance", 8)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .not("category", "eq", "principle")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(8),
  ]);

  // stateSpecificとglobalの重複除去
  const stateKeys = new Set((stateSpecific ?? []).map(k => k.content));
  const globalDeduped = (global ?? []).filter(k => !stateKeys.has(k.content));

  const parts: string[] = [];
  if ((diffLearned?.length ?? 0) > 0) parts.push("【🔴 AIが過去に間違えたパターン（最優先・必ず守る）】\n" + diffLearned!.map(k => `・${k.content}`).join("\n"));
  if ((correctionPairs?.length ?? 0) > 0) parts.push("【🟠 スタッフが修正したポイント】\n" + correctionPairs!.map(k => `・${k.content}`).join("\n"));
  if ((stateSpecific?.length ?? 0) > 0) parts.push("【スモラの営業ルール】\n" + stateSpecific!.map(k => `・${k.content}`).join("\n"));
  if (globalDeduped.length > 0) parts.push("【スモラ共通ノウハウ】\n" + globalDeduped.map(k => `・${k.content}`).join("\n"));
  return parts.join("\n\n");
}

// ─── 4案同時生成 ─────────────────────────────────────────────────────────────
async function generateAllPatterns(
  customerMessage: string,
  customerName: string,
  history: string,
  state: string,
  analysis: string,
  knowledge: string,
  examples: string,
  customerConditions: string,
  customerSummary: string,
  recentMessages: Array<{ sender: string; text: string; imageUrl?: string; createdAt?: string }>,
): Promise<string[]> {
  const jstHour = getJSTHour();
  const jstDay = getJSTDayOfWeek();
  const isWeekend = jstDay === 0 || jstDay === 6;

  // 挨拶使用済み判定: タイムスタンプがある場合はJST当日のメッセージのみで判定
  const hasTimestamps = recentMessages.some(m => !!m.createdAt);
  let alreadyGreeted: boolean;
  if (hasTimestamps) {
    const jstDayStart = getJSTDayStart();
    const jstDayEnd = getJSTDayEnd();
    // JST当日のスタッフメッセージのみを対象に挨拶済みチェック
    alreadyGreeted = recentMessages.some(m => {
      if (m.sender !== "staff" || !m.text || !m.createdAt) return false;
      const ts = new Date(m.createdAt);
      if (ts < jstDayStart || ts > jstDayEnd) return false;
      return m.text.includes("お世話になっております") || m.text.includes("夜分遅くに失礼");
    });
  } else {
    // フォールバック: タイムスタンプなしの場合は履歴全体から判定（既存動作）
    const historyLines = (history || "").split("\n").filter(Boolean);
    const staffLines = historyLines.filter(l => l.startsWith("スモラ:"));
    alreadyGreeted = staffLines.some(l =>
      l.includes("お世話になっております") || l.includes("夜分遅くに失礼")
    );
  }

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

  // 過去のスモラ返信を抽出して繰り返し防止リストを生成
  const segments = history.split(/\n(?=スモラ:|お客様:)/);
  const staffGroups: string[] = [];
  let currentGroup: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith("スモラ:")) {
      currentGroup.push(seg.replace(/^スモラ:\s*/, "").trim());
    } else if (seg.startsWith("お客様:")) {
      if (currentGroup.length > 0) { staffGroups.push(currentGroup.join("\n")); currentGroup = []; }
    }
  }
  if (currentGroup.length > 0) staffGroups.push(currentGroup.join("\n"));

  const repetitionNote = staffGroups.length > 1
    ? `\n【🚫 繰り返し厳禁（スモラが過去に送った内容）— 同じ情報・同じ言い回しを絶対に使わない】\n${
        staffGroups.slice(0, -1).slice(-5).map(m => `・${m.slice(0, 120)}${m.length > 120 ? "…" : ""}`).join("\n")
      }\n→ 費用・ルール・フロー説明は「一度伝えた」事実を踏まえ、繰り返さず次のアクションへ進む。`
    : "";

  // 分析結果から各フィールドを抽出
  let analysisNote = "";
  let hesitancyNote = "";
  let repeatedConcernNote = "";
  let currentPropertyNote = "";
  let isAnxietyDetected = false;

  if (analysis) {
    try {
      const p = JSON.parse(analysis) as Record<string, unknown>;

      if (p.approach) {
        analysisNote = `\n【返し方の方針】${p.approach}（トーン: ${p.tone || "自然に"}）`;
      }

      // 質問検出 + 不安系検出
      if (Array.isArray(p.questions) && (p.questions as string[]).length > 0) {
        const questions = p.questions as string[];
        const anxietyKeywords = ["名義", "審査", "リスク", "キャンセル", "退去", "違約", "トラブル", "詐称", "仲違い", "離婚", "死亡", "相続", "大丈夫", "問題ない", "断られ", "通らな"];
        isAnxietyDetected = questions.some(q => anxietyKeywords.some(k => q.includes(k)));
        if (questions.length > 1) {
          analysisNote += `\n【複数質問（全て漏れなく答えること）】${questions.map((q, i) => `${i + 1}. ${q}`).join(" / ")}`;
        }
        if (isAnxietyDetected) {
          analysisNote += `\n【🚨 不安系質問検出】お客様はリスク・ルール・法的な点について不安を持っている。曖昧・ぼかした回答は信頼を損なう。事実・手順・リスクを具体的に説明し、リスクがある場合は正直に伝えた上で代替案をセットで提示すること。`;
        }
      }

      // 物件トラッキング
      if (p.current_property && typeof p.current_property === "string") {
        currentPropertyNote = `\n【話題の物件】${p.current_property} — この物件の文脈で返信すること`;
      }

      // 迷いパターン検出（1案と同等の対応策を注入）
      if (p.hesitancy_pattern && typeof p.hesitancy_pattern === "string") {
        const hp = p.hesitancy_pattern;
        const timeline = p.future_timeline && typeof p.future_timeline === "string" ? p.future_timeline : null;
        if (hp === "thinking" || hp === "callback") {
          hesitancyNote = `\n【🤔 保留パターン検出（${hp === "thinking" ? "検討中" : "また連絡"}）】「お気軽にご連絡ください」だけで終わらない。必ず①物件の好条件・希少性を一言 ②申込促し（「お申込みしてお部屋抑えさせて頂きます！！」） ③待機中の具体アクション約束（「新着出次第随時お送りします」）の3点セットを入れる。`;
        } else if (hp === "waiting") {
          hesitancyNote = `\n【⏳ 「少し待って」パターン検出】バリアを取り除く：「保証会社の審査が通過するまでの間はキャンセル料は一切かかりませんのでご安心ください😊！！審査期間中にお部屋のご案内もさせて頂けますので、実際に見てからご判断いただけます！！」のように安心感を先に伝える。`;
        } else if (hp === "timeline" && timeline) {
          hesitancyNote = `\n【📅 タイムライン確定（${timeline}）】そのタイミングで動く具体アクションを約束：「${timeline}に新着物件も含めてピックアップしお送りさせて頂きます😊！！」のように日付・アクションを明示してコミットする。`;
        } else if (hp === "undecided") {
          hesitancyNote = `\n【🔀 物件迷いパターン検出】判断軸を提供：各物件の具体的な違い（費用・立地・設備）を数字で比較し、「初期費用を軸にお選びになられるのはいかがでしょうか」等で決断を後押しする。`;
        }
      }

      // 繰り返し懸念（同じテーマを何度も聞いているお客様）
      if (p.repeated_concern && typeof p.repeated_concern === "string") {
        repeatedConcernNote = `\n【💭 繰り返し懸念検出】このお客様は「${p.repeated_concern}」について繰り返し確認している。表面的な質問の裏に根本的な不安がある。今回の返信でその不安を正面から・具体的な数字・事実で解消すること。同じ説明の繰り返しはNG — 別の角度・具体例で伝える。`;
      }
    } catch { /* ignore */ }
  }

  const conditionsNote = customerConditions
    ? `\n【お客様の希望条件（DB登録済み・必ず考慮）】\n${customerConditions}` : "";
  const summaryNote = customerSummary
    ? `\n【このお客さんのAI要約 — 今の状況・次の必須対応を最優先で文案に反映すること。人物像・文体も合わせること】\n${customerSummary}` : "";

  const phaseGuide = PHASE_GUIDE[state] ?? PHASE_GUIDE["first_reply"];

  // 実例がある場合はQUICK_PATTERNSを省略（実例を最優先）
  const quickPatternsSection = examples ? "" : `\n${SMORA_QUICK_PATTERNS}`;
  // 不安系質問検出時のみREAL_ESTATE_RULESを注入
  const realEstateSection = isAnxietyDetected ? `\n\n${REAL_ESTATE_RULES}` : "";

  const systemPrompt = `${CRITICAL_RULES_COMPACT}

あなたはスモラ（賃貸仲介）のLINE営業担当です。
同じ内容・意図のLINE返信を3つ生成してください。

【スモラの営業スタイル — 最重要】
「誘導」とはお客様を考えさせないこと。スタッフが常に先手を打って次のアクションを示す。
→ 条件をもらったら「ピックアップします」と即動く
→ 物件を送ったら「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！直近ですと[日時]ご案内可能です！！」と内覧日時をこちらから提示
→ URLを受け取ったら「空室確認＋初期費用見積もり＋内覧確認」をセットで宣言
→ お客様がすべきことは最小限（フォーム入力・承認・日程を言うだけ）。それ以外はすべてスタッフがやる

【3案の役割 — 最重要・それぞれ明確に異なる案を書く】
・[A]王道案: 最短・最もシンプル。余計な説明ゼロで核心だけ伝える。3〜5行以内。
・[B]安心案: A案に理由や一言の補足を加えて不安を解消するバージョン。A案より少し長くなってよい。
・[C]別切り口案: AとBとは全く異なるアプローチ・別の角度から提案。例：Aが即アクション宣言なら、Cは状況確認・共感・別提案など。
・全て⭐実例と同じスモラの返信スタイル（文体・絵文字・感嘆符）で書く

【質問・相談への回答ルール — 最重要】
お客様から質問・相談（名義貸し・審査・費用・退去・キャンセル等）を受けた場合は「本質的・具体的」に答える。
× 曖昧・ぼかした回答（「〜の可能性があります」「〜かもしれません」）→ 不安なお客様の信頼を損なう
○ 事実・手順・リスク・数字を具体的に示す。リスクがあれば正直に伝え、代替案もセットで提示する

【返信の文構成原則】
①挨拶（その日初回メッセージにのみ「〇〇さんお世話になっております！！」）
②承認（お客様の行動・発言を受け取ったことを示す「お送り頂きありがとうございます😊！！」等）
③アクション宣言（具体的に何をするかを先に宣言・行動してから答える姿勢）
④締め（媚びすぎない・押しつけすぎない「何卒よろしくお願い致します😌！！」等）

【禁止表現・絶対NG】
・「少々お待ちください」→ 上から目線。「何卒よろしくお願い致します😌！！」で締める
・「変な媚び」→ 行動・サポートで誠実さを示す
・審査落ち・物件が埋まった等のネガティブな状況でも謝罪禁止（「申し訳ございません」「ご迷惑おかけし」「大変恐縮ですが」等） → 引き続き全力サポートする姿勢で返す
・担当者名（鈴木など）を入れない
・「スモラにてお取り扱い可能か確認」は絶対に使わない → 不動産物件はほぼ全て取り扱い可能。確認するのは「募集状況（空室かどうか）」のみ。正しい表現：「募集状況確認させていただきます！！」
・「ご共有頂き」はお客様に対して使わない → お客様が物件を送ってきた時は「お送り頂き」を使う

【共通ルール】
・文体・言い回し・文の長さ・絵文字の使い方は⭐実例に完全に合わせる
・${EMOJI_RULE}
・感嘆符「！」「！！」を文脈で使い分け
・「させて頂きます」「頂きます」を多用する（スモラの文体の核心）
・お客様名が「不明」の場合は名前を絶対に使わない
・お客様が言ったことは繰り返さない → 次のアクションへ直行

【出力フォーマット（必ず守る・余計な説明・注釈禁止）】

[A] ← 王道案（最重要・絶対に守る）
最短・最もシンプル。「余計な説明ゼロ」「お客様の要望に直接答えて即アクション宣言のみ」。
目安：3〜5行以内。長い説明・他社比較・制度解説は一切書かない。
例のトーン：「かしこまりました！！最大限割引させていただいたお見積書を明日一番でお送りさせていただきます！！何卒よろしくお願い致します😌！！」

[B] ← 安心案（A案に補足を加えて不安を解消・絶対に守る）
・A案の内容に「理由・根拠・一言の補足」を加えて不安を解消するバージョン
・A案より少し長くなってよい（8行以内厳守）
・「なぜそうするのか」「どのくらいかかるか」「どうなるか」など一言の安心材料を追加
・文体・絵文字・感嘆符はスモラスタイルを守る
例のトーン：「〇〇さんお世話になっております！！かしこまりました！！〇〇の理由から△△させていただきます！！全力でサポートさせていただきますので何卒よろしくお願い致します😌！！」

[C] ← 別切り口案（AとBとは全く異なるアプローチ・絶対に守る）
・AともBとも異なる方向性・アプローチ・構成の案
・「同じ状況でスタッフが次に考える全く別のアプローチ」
・例：A/Bが即アクション宣言なら、Cは状況確認・共感・別の選択肢提示など
・文体・絵文字・感嘆符はスモラスタイルを守る

【現在の営業フェーズ: ${state}】
${phaseGuide}`;

  const userPrompt = `お客様名: ${customerName || "不明"}${conditionsNote}${summaryNote}${greetingNote}${managementNote}${repetitionNote}${currentPropertyNote}${repeatedConcernNote}${hesitancyNote}${analysisNote}

【直近の会話履歴（スモラ:=自分の返信 / お客様:=顧客）】
${history || "なし"}
${knowledge}${quickPatternsSection}${realEstateSection}
${examples}

【お客様の最新メッセージ】
${customerMessage}

上記⭐実例の文体・言い回し・感嘆符・絵文字を完全に再現しながら、[A]王道案・[B]安心案・[C]別切り口案の3案を生成してください。[B]はAに補足を加えて不安を解消する案、[C]はA・Bと全く異なる切り口で書くこと。`;

  try {
    const res = await generationModel.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);
    const text = typeof res.content === "string" ? res.content : "";

    // ── パース: 1次試行 ── \[A\]\n 等で区切る厳密パターン
    let variants: string[] = [];
    const regex = /\[([ABC])\]\n([\s\S]*?)(?=\n\[[ABC]\]|$)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const body = match[2].trim();
      if (body) variants.push(body);
    }

    // ── パース: 2次フォールバック ── [A][B][C] を区切りとしてsplit
    if (variants.length < 3) {
      console.warn("[generate-reply-patterns] parse fallback used (split by [A][B][C])");
      const parts = text.split(/\[([ABC])\]/).filter(Boolean);
      const fallbackVariants: string[] = [];
      for (let i = 0; i < parts.length - 1; i++) {
        if (/^[ABC]$/.test(parts[i])) {
          const body = (parts[i + 1] || "").trim();
          if (body) fallbackVariants.push(body);
        }
      }
      if (fallbackVariants.length >= variants.length) {
        variants = fallbackVariants;
      }
    }

    // ── パース: 3次フォールバック ── 全テキストをA案として返す
    if (variants.length === 0) {
      console.warn("[generate-reply-patterns] parse fallback used (full text as A)");
      const trimmed = text.trim();
      if (trimmed) variants = [trimmed, "", ""];
    }

    return variants;
  } catch {
    return [];
  }
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  type RecentMessage = { sender: string; text: string; imageUrl?: string; createdAt?: string };
  let body: {
    message: string;
    state: string;
    customerName?: string;
    recentMessages?: RecentMessage[];
    customerConditions?: string;
    customerSummary?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "不正なJSONです" }, { status: 400 });
  }
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

  // Step1: 分析
  const analysis = await analyzeCustomer(message, history, currentState, customerName);

  // 分析結果からRAGクエリを強化
  const analysisCtx = (() => {
    try {
      const p = JSON.parse(analysis) as Record<string, unknown>;
      const parts: string[] = [];
      if (p.approach && typeof p.approach === "string") parts.push(p.approach.slice(0, 60));
      const hp = p.hesitancy_pattern;
      if (hp === "thinking") parts.push("検討します また連絡します");
      else if (hp === "waiting") parts.push("少し待ってほしい キャンセル");
      else if (p.repeated_concern && typeof p.repeated_concern === "string") parts.push(p.repeated_concern);
      return parts.join(" ") || undefined;
    } catch { return undefined; }
  })();

  // 直前のスタッフ返信を抽出（embeddingコンテキスト強化）
  const lastStaffMsg = recentMessages
    .filter(m => m.sender === "staff" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .at(-1)?.text;

  // Step2: knowledge + examples を並列取得
  const [knowledge, examples] = await Promise.all([
    fetchKnowledge(currentState, message),
    fetchExamples(currentState, message, analysisCtx, lastStaffMsg),
  ]);

  // Step3: 3案を1回のcallで同時生成
  const variants = await generateAllPatterns(
    message, customerName, history, currentState,
    analysis, knowledge, examples, customerConditions, customerSummary,
    recentMessages,
  );

  const PATTERN_DISPLAY_LABELS = ["王道案", "安心案", "別切り口案"];
  const patterns = variants.map((text, i) => {
    const { cleaned, issues } = validateAndClean(text);
    if (issues.length > 0) console.warn(`[validate-reply] pattern ${PATTERN_LABELS[i] ?? i + 1} issues:`, issues);
    return {
      angle: PATTERN_LABELS[i] ?? String(i + 1),
      label: PATTERN_DISPLAY_LABELS[i] ?? `${i + 1}案`,
      text: cleaned,
    };
  }).filter(p => p.text.length > 0);

  return NextResponse.json({ ok: true, patterns });
}
