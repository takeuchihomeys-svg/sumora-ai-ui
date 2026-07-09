import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// Vercel Functions のタイムアウト上限（秒）— Haiku分析チェーン×3に余裕を持たせる
export const maxDuration = 60;

// ─── OpenAI 埋め込み生成（text-embedding-3-small・1536次元）────────────────────
async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      signal: AbortSignal.timeout(6_000),
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// conversationState → phrase_dictionary カテゴリ（新5段階 + 旧ステート + AIXステート）
const STATE_TO_PHRASE_CATEGORY: Record<string, string> = {
  // 新5段階
  first_reply:            "hearing_start",
  hearing:                "hearing_followup",
  proposing:              "property_recommendation",
  applying:               "application_push",
  closed_won:             "application_push",
  // 旧ステート（後方互換）
  condition_hearing:      "hearing_followup",
  property_search:        "property_search_start",
  property_recommendation:"property_recommendation",
  viewing:                "viewing_invite",
  estimate_request:       "estimate_send",
  availability_check:     "availability_check",
  application:            "application_push",
  // ④ AIXアクション固有ステート（AixModal の ACTION_TO_STATE と一致）
  estimate_sheet:         "estimate_send",
  property_send:          "property_search_start",
  viewing_invite:         "viewing_invite",
  application_push:       "application_push",
  property_check_result:  "property_recommendation",
  meeting_place:          "viewing_invite",
  acknowledge_check:      "hearing_followup",
  followup_revive:        "hearing_followup",
  // T02: AIXサブパターン（property_check_result サブモード）
  property_check_result_available:        "property_recommendation",
  property_check_result_unavailable:      "property_recommendation",
  property_check_result_alternative:      "property_recommendation",
  property_check_result_vacate_date:      "property_recommendation",
  property_check_result_mgmt_guarantor:   "property_recommendation",
  property_check_result_mgmt_move_in:     "property_recommendation",
  property_check_result_mgmt_initial_cost:"property_recommendation",
  // T02: AIXサブパターン（application_push サブモード）
  application_push_push:          "application_push",
  application_push_confirm:       "application_push",
  application_push_docs_request:  "application_push",
  // T02: AIXサブパターン（property_send サブモード）
  property_send_new_arrival:  "property_search_start",
  property_send_widen:        "property_search_start",
  // T02: その他AIXサブパターン
  greeting_viewing:   "viewing_invite",
};

const VALID_STATES = [
  // 新5段階ステート
  "first_reply", "hearing", "proposing", "applying", "closed_won",
  // 旧ステート（後方互換）
  "condition_hearing", "property_search", "property_recommendation",
  "viewing", "estimate_request", "availability_check",
  "application", "screening", "contract",
];

// 旧ステートを新5段階に正規化して保存する（一貫性確保）
const STATE_NORMALIZE: Record<string, string> = {
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

// ─── コンポーネント変化タイプ判定（パターン変化 vs 文字変化）──────────────────
// probe(先頭15文字)が見つからない = 変化あり。さらにどう変わったかを分類:
//   phrase   = 構成は同じ・言い回しが変わった（中間/末尾プローブが sent_reply に存在）
//   structure = コンポーネントごと省略・大幅再構成（全プローブが不在）
function detectComponentChangeType(compNorm: string, sentNorm: string): "phrase" | "structure" {
  if (compNorm.length < 20) return "phrase"; // 短すぎると判定不能 → phrase扱い
  const len = compNorm.length;
  const probes = [
    compNorm.slice(0, 10),
    compNorm.slice(Math.floor(len / 2) - 5, Math.floor(len / 2) + 5),
    compNorm.slice(-10),
  ].filter(p => p.length >= 6);
  const foundCount = probes.filter(p => sentNorm.includes(p)).length;
  // 1つでもプローブが見つかれば「一部残存 = 文字変化」、全不在なら「構成変化」
  return foundCount >= 1 ? "phrase" : "structure";
}

// ─── テキスト類似度（AI文案と送信文を比較してwasAiUsedを判定）─────────────────
// LCS Dice係数（analyze-diffsと統一）— 旧グリーディーマッチは j がループをまたいで不正確だった
function textSimilarity(a: string, b: string): number {
  const s1 = a.replace(/\s+/g, "");
  const s2 = b.replace(/\s+/g, "");
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const la = [...s1], lb = [...s2];
  const m = la.length, n = lb.length;
  const dp = new Array(n + 1).fill(0);
  let prev = 0;
  for (let i = 1; i <= m; i++) {
    prev = 0;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = la[i - 1] === lb[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  const lcs = dp[n];
  return (2 * lcs) / (m + n);
}

// ─── Claude Haiku 共通ヘルパー ────────────────────────────────────────────────
async function callHaiku(prompt: string, maxTokens = 1024): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
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
// isStarred=true の場合: importance +1〜2 上乗せ（☆はより重要な学習シグナル）
async function analyzeAndSaveKnowledge(
  exampleId: string,
  conversationState: string,
  customerMessage: string,
  sentReply: string,
  isStarred = false
) {
  const text = await callHaiku(`以下のLINE賃貸営業のやりとりから、次回即使えるルールを抽出してください。

【お客様のメッセージ】
${customerMessage}

【スモラスタッフの返信】
${sentReply}

JSONのみで返答（説明不要）：

{
  "situation": "状況を一言（例：条件ヒアリング完了・物件満室お詫び・内覧日程確認）",
  "pattern": "次回この状況でどう返すか（具体的なルール・文章構造）例：「〇〇さんお世話になっております！！〜の件、〜させて頂きます！！」の形で開始し本日中など期限を添える",
  "key_phrases": ["そのまま使える完全な一文（20文字以上・お客様名は全て〇〇さんに置換・途中で切れた断片フレーズは不可）"]
}

注意: key_phrasesは完全な文のみ。「かしこまりました！！」「はい！！」などの短い断片・名前の断片は含めない。`);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const analysis = JSON.parse(match[0]) as {
      situation: string;
      pattern: string;
      key_phrases: string[];
    };

    // ☆の場合: importance を1上乗せ（pattern/phraseは最大8・principleと区別）
    const boost = isStarred ? 1 : 0;
    const entries = [
      // pattern: 具体的な返し方ルール（20文字未満は除外）
      ...(analysis.pattern && analysis.pattern.length >= 20
        ? [{ category: "pattern" as const, title: analysis.situation, content: analysis.pattern, importance: 7 + boost }]
        : []),
      // phrase: 完全な一文のみ（20文字未満・〇〇さん以外の実名は除外）
      ...(Array.isArray(analysis.key_phrases) ? analysis.key_phrases : [])
        .filter((phrase) => typeof phrase === "string" && phrase.length >= 20)
        .map((phrase) => ({
          category: "phrase" as const, title: "フレーズ", content: phrase, importance: 7 + boost,
        })),
    ];

    if (entries.length > 0) {
      await supabase.from("ai_reply_knowledge").insert(
        entries.map((entry) => ({
          category: entry.category,
          title: entry.title,
          content: entry.content,
          importance: entry.importance,
          conversation_state: conversationState || null,
          source_example_id: exampleId,
        }))
      );
    }
  } catch (e) {
    console.error("analyzeAndSaveKnowledge error:", e);
  }
}

// 修正量(sim)に応じてimportanceを変動させる（膨張防止）
// sim < 0.4 = 大幅修正 → 9 / 0.4〜0.65 = 中程度 → 8 / 0.65〜0.9 = 微修正 → 7
function diffImportance(sim: number): number {
  if (sim < 0.4) return 9;
  if (sim < 0.65) return 8;
  return 7;
}

// ─── ① 差分分析（AIドラフト修正からの逆学習）→ 修正量に応じたimportanceで保存 ───
async function analyzeDiff(
  exampleId: string,
  conversationState: string,
  customerMessage: string,
  aiDraft: string,
  sentReply: string,
  sim = 0.5
) {
  const text = await callHaiku(`あなたはスモラ（賃貸仲介）のLINE営業AIのトレーナーです。
スタッフが修正した内容から、次回のAI生成を改善するルールを抽出してください。

【スモラのLINEスタイル（前提として必ず守ること）】
・絵文字（😊 😌 🌟 ✨ ✅）は積極的に使う — スモラの特徴。スタッフが1つ減らしても「絵文字禁止」ルールを生成しない
・「させて頂きます」「頂きます」の多用は正しい丁寧語スタイル
・「本日中に〜します！！」などの積極的な行動宣言はスモラの強み
・「全力でサポートします！！」などの約束表現はスモラのスタイル — 「過度」ではない
・顧客名（〇〇さん）は文頭で積極的に呼びかける — 多用は正しい
・感嘆符「！」「！！」を文脈で使い分けるのは正しい
・営業的な条件提示（割引・初期費用・スモ割）は積極的に伝える

【注意：以下は絶対に生成しないルール】
× 「絵文字を避けること」「絵文字を減らすこと」
× 「営業的な表現を控えること」「条件提示を控えること」
× 「過度な約束を避けること」
× 「顧客名の使用を控えること」

【お客様のメッセージ】
${customerMessage}

【AIが生成した文案（修正前）】
${aiDraft}

【スタッフが実際に送った文（修正後）】
${sentReply}

【重要】スタッフはLINEで1つの返信を2〜3通に分けて送ることがよくあります。
送信文がAI文案より短い場合、「削除・短縮した」のではなく「分割して送った」可能性が高いです。
その場合は「AI文案が長すぎた」「冗長だった」「削りすぎた」等のルールは絶対に生成しないこと。
分析は「文体・言い回し・言葉の選び方・構成の変化」に集中すること。

以下を分析してJSONのみで返答（説明不要）：
{
  "ai_mistake": "AIが間違えた点（スモラスタイルの観点で・1〜2文）",
  "correction_pattern": "スタッフがどう直したか・何を重視したか（スモラスタイルの観点で・1〜2文）",
  "rule": "次回から守るべきルール（スモラスタイルに沿った具体的な1文）"
}`);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const analysis = JSON.parse(match[0]) as {
      ai_mistake: string;
      correction_pattern: string;
      rule: string;
    };

    const diffImp = diffImportance(sim);
    await supabase.from("ai_reply_knowledge").insert([
      {
        category: "pattern",  // MED-03修正: analyze-diffsのポリシーと統一（principleはフォールバック経路で除外される）
        title: `[差分学習] ${(analysis.ai_mistake || "").slice(0, 30)}`,
        content: analysis.rule,
        importance: diffImp,
        conversation_state: conversationState || null,
        source_example_id: exampleId,
      },
      {
        category: "pattern",
        title: `[修正対比] ${conversationState}`,
        content: analysis.correction_pattern,
        importance: Math.max(7, diffImp - 1),
        conversation_state: conversationState || null,
        source_example_id: exampleId,
      },
    ]);
  } catch (e) {
    console.error("analyzeDiff error:", e);
  }
}

// ─── ②③ フレーズ抽出（重複排除 + priority 昇格）→ phrase_dictionary ────────
// isStarred=true の場合: 新規priority=18、boost=+5（即座にfetchPhrases>=10に反映）
// 通常の場合: 新規priority=5、boost=+1（累積で徐々に昇格）
async function extractAndSavePhrases(conversationState: string, sentReply: string, isStarred: boolean) {
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
・固有情報（物件名・金額・部屋番号・人名）は含めない
・お客様の名前が入っている場合は除去して汎用的なフレーズにする（テンプレート変数は使わない）
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

    // ☆の場合は高priority(18)で即反映、通常は5で累積昇格
    const newPriority = isStarred ? 18 : 5;
    const boostAmount = isStarred ? 5 : 1;
    const boostCap    = isStarred ? 25 : 15;

    // 新フレーズを挿入（{{}} テンプレート変数を含む場合は除外）
    for (const phrase of newPhrases) {
      if (typeof phrase === "string" && phrase.trim() && !/\{/.test(phrase)) {
        await supabase.from("phrase_dictionary").insert({
          category: phraseCategory,
          phrase: phrase.trim(),
          priority: newPriority,
          role: "auto_extracted",
        });
      }
    }

    // 類似フレーズの priority を昇格（☆は+5、通常は+1）
    for (const boostPhrase of boostPhrases) {
      if (typeof boostPhrase !== "string") continue;
      const found = existingMap[boostPhrase]
        ?? existingMap[Object.keys(existingMap).find((k) => k.includes(boostPhrase.slice(0, 8)) || boostPhrase.includes(k.slice(0, 8))) ?? ""];
      if (found) {
        await supabase
          .from("phrase_dictionary")
          .update({ priority: Math.min(boostCap, (found.priority || 5) + boostAmount) })
          .eq("id", found.id);
      }
    }
  } catch (e) {
    console.error("extractAndSavePhrases error:", e);
  }
}

// ─── PATCH: 既存レコードを☆に更新して差分学習を再実行 ────────────────────────
// isAutoStar=true（auto-star-winners等のバッチ経由）の場合はAnthropic分析チェーンを
// 実行しない（☆フラグ更新のみ）。大量☆付与時のコスト暴発を防止する。
export async function PATCH(req: NextRequest) {
  let id: string, is_starred: boolean, isAutoStar: boolean | undefined;
  try {
    ({ id, is_starred, isAutoStar } = await req.json() as {
      id: string;
      is_starred: boolean;
      isAutoStar?: boolean;
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  // 既存レコードを取得
  const { data: existing } = await supabase
    .from("ai_reply_examples")
    .select("id, conversation_state, customer_message, sent_reply, ai_draft, was_ai_used, was_ai_modified")
    .eq("id", id)
    .maybeSingle();

  if (!existing) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  // is_starred を更新
  await supabase.from("ai_reply_examples").update({ is_starred }).eq("id", id);

  if (!is_starred) return NextResponse.json({ ok: true });

  // 🚫 バッチ☆（auto-star-winners）→ LLM分析はスキップ（☆フラグのみで完了）
  // 手動☆1件ずつと違い、バッチは一度に数十件走るためHaiku×3/件のコストが暴発する
  if (isAutoStar) {
    return NextResponse.json({ ok: true, skippedAnalysis: true });
  }

  // ☆追加時 → 星ブーストで再分析（aiDraft があれば差分学習も実行）
  const jobs: Promise<void>[] = [
    analyzeAndSaveKnowledge(existing.id, existing.conversation_state, existing.customer_message, existing.sent_reply, true),
    extractAndSavePhrases(existing.conversation_state, existing.sent_reply, true),
  ];
  if (existing.ai_draft) {
    const patchSim = textSimilarity((existing.ai_draft as string).trim(), (existing.sent_reply as string).trim());
    jobs.push(analyzeDiff(existing.id, existing.conversation_state, existing.customer_message, existing.ai_draft, existing.sent_reply, patchSim));
  }
  await Promise.all(jobs);

  // PATCH分析後に diff_analyzed_at を更新 → 翌朝cronの二重処理を防止
  await supabase.from("ai_reply_examples")
    .update({ diff_analyzed_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true });
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  type PostBody = {
    conversationState: string;
    customerMessage: string;
    sentReply: string;
    aiDraft?: string;
    isStarred?: boolean;
    replyAngle?: string;
    previousStaffMessage?: string;
    conversationId?: string;
    sentAt?: string;
    skipNormalize?: boolean;
    isAutoStar?: boolean; // バッチ経由（auto-star-winners等）→ LLM分析チェーンを抑止
    aiComponents?: Record<string, string> | null; // 物件ピックアップした コンポーネント別生成結果
    template_id?: string | null; // 使ったテンプレートのID（テンプレート成果学習ループ用）
  };
  let body: PostBody;
  try {
    body = await req.json() as PostBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }
  const {
    conversationState: rawState,
    customerMessage,
    sentReply,
    aiDraft,
    isStarred,
    previousStaffMessage,
    conversationId,
    sentAt,
    skipNormalize,
    isAutoStar,
    aiComponents,
  } = body;
  const templateId = typeof body.template_id === "string" ? body.template_id : null;
  let replyAngle = typeof body.replyAngle === "string" ? body.replyAngle : null;

  if (!customerMessage || !sentReply) {
    return NextResponse.json(
      { ok: false, error: "customerMessage and sentReply required" },
      { status: 400 }
    );
  }

  // ★ aiDraftなしで☆つき保存の場合（別セッションからの☆）→ 既存レコードを探してPATCHに転換
  // 同じ sent_reply + customer_message のレコードが既にあれば、そちらに is_starred を付ける。
  // これにより「AI生成→修正→送信」時に保存された aiDraft 付きレコードが正しく☆される。
  if (isStarred && !aiDraft) {
    // sent_replyのみで検索（customer_messageは連続メッセージ連結により不一致になる場合がある）
    // conversation_id でも絞り込む（別会話の同一 sent_reply レコードに☆が付く混線を防止）
    let starQuery = supabase
      .from("ai_reply_examples")
      .select("id, conversation_state, customer_message, sent_reply, ai_draft, was_ai_modified, is_starred")
      .eq("sent_reply", sentReply);
    if (conversationId) {
      starQuery = starQuery.eq("conversation_id", conversationId);
    }
    const { data: existingRecord } = await starQuery
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingRecord && !existingRecord.is_starred) {
      // 既存レコードを☆に更新してPATH相当の分析を実行
      await supabase.from("ai_reply_examples").update({ is_starred: true }).eq("id", existingRecord.id);
      // 🚫 バッチ☆はLLM分析をスキップ（コスト暴発防止）
      if (isAutoStar) {
        return NextResponse.json({ ok: true, id: existingRecord.id, merged: true, skippedAnalysis: true });
      }
      const existConvState = existingRecord.conversation_state as string;
      const existSentReply = existingRecord.sent_reply as string;
      const existCustMsg   = existingRecord.customer_message as string;
      const existAiDraft   = existingRecord.ai_draft as string | null;
      const jobs: Promise<void>[] = [
        analyzeAndSaveKnowledge(existingRecord.id, existConvState, existCustMsg, existSentReply, true),
        extractAndSavePhrases(existConvState, existSentReply, true),
      ];
      if (existAiDraft) {
        const mergeSim = textSimilarity(existAiDraft.trim(), existSentReply.trim());
        jobs.push(analyzeDiff(existingRecord.id, existConvState, existCustMsg, existAiDraft, existSentReply, mergeSim));
      }
      await Promise.all(jobs);
      // ☆マージ分析後に diff_analyzed_at を更新 → cronの二重処理を防止
      await supabase.from("ai_reply_examples")
        .update({ diff_analyzed_at: new Date().toISOString() })
        .eq("id", existingRecord.id);
      return NextResponse.json({ ok: true, id: existingRecord.id, merged: true });
    }
    // 既存なし → 通常通り新規作成
  }

  // ─── 冪等ガード: 同一 conversation_id + sent_at + sent_reply は重複保存しない ───
  // クライアントのリトライ・二重送信で同じレコードが複数INSERTされ、
  // Haiku分析チェーンが再実行されるのを防ぐ（DBにユニーク制約がないためアプリ側で担保）
  if (conversationId && sentAt) {
    const { data: dup } = await supabase
      .from("ai_reply_examples")
      .select("id, conversation_state")
      .eq("conversation_id", conversationId)
      .eq("sent_at", sentAt)
      .eq("sent_reply", sentReply)
      .limit(1)
      .maybeSingle();
    if (dup) {
      return NextResponse.json({ ok: true, id: dup.id, duplicate: true, conversation_state: dup.conversation_state });
    }
  }

  // ④ state が未指定または "auto" の場合は自動判定 → 常に新5段階に正規化して保存
  const rawResolved = !rawState || rawState === "auto"
    ? await autoClassifyState(customerMessage, sentReply)
    : rawState;
  // skipNormalize=true の場合（AixModal側で既に正規化済み）はノーマライズをスキップ
  const conversationState = skipNormalize ? rawResolved : (STATE_NORMALIZE[rawResolved] ?? rawResolved);

  // ─── 分割送信マージ: 90秒以内に同じcustomerMessageで送ったものは1レコードに結合 ───
  // LINEでは1つの返信を複数メッセージに分けて送ることが多い。別レコードにすると
  // RAGが断片的な文のみ参照してしまうため、1つの完全な返信として結合して保存する。
  const ninetySecondsAgo = new Date(Date.now() - 90 * 1000).toISOString();
  // conversation_id で絞り込む（定型 customer_message「（初回連絡）」等での別顧客データ混線を防止）
  let splitQuery = supabase
    .from("ai_reply_examples")
    .select("id, sent_reply, ai_draft")
    .eq("customer_message", customerMessage)
    .eq("conversation_state", conversationState)
    .gte("created_at", ninetySecondsAgo);
  if (conversationId) {
    splitQuery = splitQuery.eq("conversation_id", conversationId);
  } else {
    // conversationId 未指定の保存は conversation_id が null のレコードのみマージ対象
    splitQuery = splitQuery.is("conversation_id", null);
  }
  const { data: splitCandidate } = await splitQuery
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (splitCandidate) {
    // 冪等ガード: 同一 sentReply が既にレコードに含まれる場合（リトライ・二重送信）は
    // 再結合しない（同じ文が2回連結されて sent_reply が汚染されるのを防止）
    const candidateReply = splitCandidate.sent_reply as string;
    if (candidateReply === sentReply || candidateReply.endsWith("\n" + sentReply)) {
      if (isStarred) {
        await supabase.from("ai_reply_examples").update({ is_starred: true }).eq("id", splitCandidate.id);
      }
      return NextResponse.json({ ok: true, id: splitCandidate.id, duplicate: true });
    }
    const mergedReply = splitCandidate.sent_reply + "\n" + sentReply;
    const mergedEmbeddingInput = previousStaffMessage
      ? `${conversationState}: [前返信]${previousStaffMessage.slice(0, 100)} [顧客]${customerMessage}`
      : `${conversationState}: ${customerMessage}`;
    const mergedEmbedding = await getEmbedding(mergedEmbeddingInput);
    const updatePayload: Record<string, unknown> = { sent_reply: mergedReply };
    if (mergedEmbedding) updatePayload.embedding = JSON.stringify(mergedEmbedding);
    if (isStarred) updatePayload.is_starred = true;
    await supabase.from("ai_reply_examples").update(updatePayload).eq("id", splitCandidate.id);

    // A01: マージパスでも RLHF フィードバックを発火（分割送信でループが止まるのを防止）
    // splitCandidate.ai_draft（1通目保存時の ai_draft）と mergedReply を比較して判定
    if (conversationId) {
      const candidateAiDraft = (splitCandidate.ai_draft as string | null) ?? aiDraft ?? null;
      if (candidateAiDraft) {
        const mergedSim = textSimilarity(candidateAiDraft.trim(), mergedReply.trim());
        const mergedWasAiUsed = mergedSim >= 0.9;
        const mergedWasAiModified = mergedSim >= 0.05 && mergedSim < 0.9;
        const feedbackResult = mergedWasAiUsed ? "correct" : mergedWasAiModified ? "wrong" : null;
        if (feedbackResult) {
          supabase.rpc("confirm_knowledge_feedback", {
            p_conversation_id: conversationId,
            p_result: feedbackResult,
          }).then(() => {}, () => {});
        }
      }
    }

    return NextResponse.json({ ok: true, id: splitCandidate.id, merged: true });
  }

  // 90%以上 → AIをほぼそのまま使った
  // 5〜90% → 何らかの修正あり（軽微〜大幅・すべて差分学習の対象）
  // 5%未満 → ほぼ手書き（AIは参考のみ）
  const sim = aiDraft ? textSimilarity(aiDraft.trim(), sentReply.trim()) : 0;
  const wasAiUsed    = !!aiDraft && aiDraft.trim().length > 0 && sim >= 0.9;
  // スプリット送信判定: sentReplyがaiDraftの55%未満 かつ 類似度30%以上 → 分割送信の可能性が高い
  // この場合、差分学習を実行しない（「削った」と誤判定を防ぐ）
  // 分割送信判定: 送信文が40%未満 かつ 類似度50%以上のみスキップ（閾値緩和で「意図的な短縮」を誤判定しない）
  const likelySplit  = !!aiDraft && sentReply.trim().length < aiDraft.trim().length * 0.4 && sim >= 0.5;
  const wasAiModified = !!aiDraft && aiDraft.trim().length > 0 && sim >= 0.05 && sim < 0.9 && !likelySplit;

  // RLHF: 仮説検証フィードバック（conversationId + aiDraft がある場合のみ・fire-and-forget）
  // wasAiUsed（修正なし送信）→ correct、wasAiModified（修正して送信）→ wrong
  if (conversationId && aiDraft) {
    const feedbackResult = wasAiUsed ? "correct" : wasAiModified ? "wrong" : null;
    if (feedbackResult) {
      supabase.rpc("confirm_knowledge_feedback", {
        p_conversation_id: conversationId,
        p_result: feedbackResult,
      }).then(() => {}, () => {});
    }
  }

  // 埋め込み生成（バックグラウンドで並列実行・失敗してもINSERTは続行）
  // [画像][動画]メッセージはテキスト意味がないのでsentReplyをembeddingの主成分にする
  const isImageMsg = customerMessage === "[画像]" || customerMessage === "[動画]" || !customerMessage.trim();
  // 前のスタッフ返信をコンテキストに含めると「わかりました」等の汎用返答でも文脈が特定できる
  const embeddingInput = isImageMsg
    ? `${conversationState}: [画像受信への返信] ${sentReply.slice(0, 300)}`
    : previousStaffMessage
      ? `${conversationState}: [前返信]${previousStaffMessage.slice(0, 100)} [顧客]${customerMessage}`
      : `${conversationState}: ${customerMessage}`;
  const embeddingPromise = getEmbedding(embeddingInput);

  // 各ピッカー: 変更されたコンポーネントを reply_angle に記録（analyze-diffs が固有情報スキップを精密化）
  // アクション別の固有情報パーツ（日時・物件名等 — 変化しても学習不要）
  const FIXED_INFO_BY_STATE: Record<string, Set<string>> = {
    property_send:   new Set(["vacating", "calendar"]),
    viewing_invite:  new Set(["dates"]),
    application_push: new Set(["property"]),
  };
  const aiComponentsObj = aiComponents && typeof aiComponents === "object" ? aiComponents as Record<string, string> : null;
  if (aiComponentsObj && wasAiModified && !replyAngle) {
    const FIXED_INFO = FIXED_INFO_BY_STATE[conversationState as string] ?? new Set(["dates", "calendar", "vacating"]);
    const changedWithType: string[] = [];
    const sentNorm = (sentReply as string).replace(/\s+/g, "");
    for (const [key, val] of Object.entries(aiComponentsObj)) {
      if (FIXED_INFO.has(key) || !val || (val as string).length < 5) continue;
      const compNorm = (val as string).replace(/\s+/g, "");
      const probe = compNorm.slice(0, 15);
      if (!sentNorm.includes(probe)) {
        // パターン変化 or 文字変化を分類して記録
        const changeType = detectComponentChangeType(compNorm, sentNorm);
        changedWithType.push(`${key}(${changeType})`);
      }
    }
    if (changedWithType.length > 0) replyAngle = `component_diff:${changedWithType.join(",")}`;
  }

  const [embedding, insertResult] = await Promise.all([
    embeddingPromise,
    supabase
      .from("ai_reply_examples")
      .insert({
        conversation_state: conversationState,
        customer_message: customerMessage,
        sent_reply: sentReply,
        ai_draft: aiDraft || null,
        was_ai_used: wasAiUsed,
        was_ai_modified: wasAiModified,
        is_starred: isStarred ?? false,
        reply_angle: replyAngle || null,
        conversation_id: conversationId || null,
        sent_at: sentAt ?? new Date().toISOString(),
        ai_components: aiComponentsObj || null,
        template_id: templateId || null,
      })
      .select("id")
      .single(),
  ]);

  const { data, error } = insertResult;

  // 埋め込みが取得できた場合のみ更新（fire-and-forget）
  if (data?.id && embedding) {
    void supabase.from("ai_reply_examples")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", data.id);
  }

  if (error) {
    console.error("save-reply-example error:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // 学習トリガー判定
  // ⭐ 手動インポート or 手動☆ → 深層分析 + フレーズ抽出
  // AI文案をそのまま使用（wasAiUsed）→ フレーズ抽出のみ（自己強化防止: 深層分析は行わない）
  // AI文案を修正して送った → 差分学習のみ（修正内容が最良の教師信号）
  const effectiveStarred = isStarred === true;
  let shouldDeepAnalyze = effectiveStarred || !aiDraft;
  let shouldExtractPhrases = shouldDeepAnalyze || wasAiModified || wasAiUsed;
  // 🚫 AI自己強化ループ防止: AI文をそのまま送信（wasAiUsed && !wasAiModified）した場合は
  // ☆有無に関わらず深層分析・フレーズ抽出を行わない（AIが書いた文をお手本として学習する循環を遮断）
  if (wasAiUsed && !wasAiModified) {
    shouldDeepAnalyze = false;
    shouldExtractPhrases = false;
  }
  // 🚫 バッチ経由（isAutoStar）はLLM分析チェーンを全て抑止（コスト暴発防止）
  if (isAutoStar) {
    shouldDeepAnalyze = false;
    shouldExtractPhrases = false;
  }

  const analysisJobs: Promise<void>[] = [];
  if (shouldDeepAnalyze && data?.id) {
    analysisJobs.push(analyzeAndSaveKnowledge(data.id, conversationState, customerMessage, sentReply, effectiveStarred));
  }
  if (shouldExtractPhrases && data?.id) {
    analysisJobs.push(extractAndSavePhrases(conversationState, sentReply, effectiveStarred));
  }
  if (analysisJobs.length > 0) await Promise.all(analysisJobs);

  return NextResponse.json({ ok: true, id: data?.id, conversation_state: conversationState });
}
