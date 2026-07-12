import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, buildKnowledgeEmbeddingInput, generateEmbedding } from "@/app/lib/knowledge-utils";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 30_000, maxRetries: 1 });

// コンポーネントが省略・大幅再構成された場合（structure変化）の学習ルール抽出
//「なぜこのパーツを省いたか」を学ぶ → カテゴリ=pattern
async function analyzeStructureDiff(
  customerMessage: string,
  aiComponentText: string,
  sentReply: string,
  componentState: string,
  componentName: string,
): Promise<{ skip: boolean; title?: string; rule?: string } | null> {
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `物件送り文の「${componentName}」をスタッフが省略または大きく変更しました。なぜそうしたか学習ルールを抽出してください。

【AIが生成した「${componentName}」】
${aiComponentText}

【スタッフが実際に送った全文】
${sentReply}

【お客様のメッセージ・状況】
${customerMessage || "不明"}

スキップ条件（以下なら {"skip":true} のみ返す）：
- 文が短すぎて判断できない
- 全文が固有情報（物件名・日付）のみ

学習ルールがある場合：
{"skip":false,"title":"${componentName}構成: [パターン名・30文字以内]","rule":"[どの状況でこのパーツを省く/変えるかの具体ルール・150文字以内]"}

JSONのみ返す。`,
      }],
    });
    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as { skip: boolean; title?: string; rule?: string };
  } catch {
    return null;
  }
}

// 物件ピックアップした: 特定のコンポーネント（intro/pickup/invite/closing）単位で差分分析
// aiComponentText = AIが生成したそのパーツのテキスト、sentReply = スタッフが送った全文
// Haikuがsentifyの中から該当パーツを特定して比較する
async function analyzeComponentDiff(
  customerMessage: string,
  aiComponentText: string,
  sentReply: string,
  componentState: string, // "property_send_pickup" 等
  componentName: string,  // "ピックアップ行（条件説明）" 等
): Promise<{ skip: boolean; title?: string; rule?: string } | null> {
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `物件ピックアップメッセージの「${componentName}」パーツについて、スタッフがAI文案を改善した差分から学習ルールを抽出してください。

【AIが生成した「${componentName}」】
${aiComponentText}

【スタッフが実際に送った全文（この中から「${componentName}」に対応する部分を見つけて比較する）】
${sentReply}

分析手順：
① スタッフの全文の中からAIの「${componentName}」に対応する部分を特定する
② AIの生成と比較して変わった点（言い回し・強調・省略・言葉の選択）を特定する
③ その変化が次回の生成に活かせるルールかを判断する

スキップ条件（以下のみなら {"skip":true}）：
- 物件名・エリア・日時・顧客名などの固有情報だけが違う
- ほぼ同じ（90%以上一致）
- スタッフの文中に対応するパーツが見当たらない

学習ルールがある場合のJSON（スキップ以外）：
{"skip":false,"title":"${componentName}改善: [パターン名・30文字以内]","rule":"[次回から守るべきルール・200文字以内。NG表現→OK表現の対比で書く]"}

JSONのみを返す。説明不要。`,
      }],
    });
    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as { skip: boolean; title?: string; rule?: string };
  } catch {
    return null;
  }
}

// AIドラフトと実送信の差分を比較して学習ルールを抽出
async function analyzeDiff(
  customerMessage: string,
  aiDraft: string,
  sentReply: string,
  conversationState: string,
  componentHint = "",
): Promise<{ skip: boolean; title?: string; rule?: string; category?: string; trigger_example?: string } | null> {
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 900,
      messages: [{
        role: "user",
        content: `スタッフが実際に送った返信とAIの下書きを「構成・文の役割」レベルで比較分析し、改善パターンを抽出してください。${componentHint}

【お客様のメッセージ】
${customerMessage || "不明"}

【AIの下書き】
${aiDraft}

【スタッフが実際に送った返信（正解）】
${sentReply}

【フェーズ】${conversationState}

▼ この順番で分析する
① スタッフの返信を1文ずつ分解し、各文の「役割」をラベル付け
   役割ラベル例：[承認][共感][情報提供][提案][申込誘導][確認質問][次アクション][感謝][サポート姿勢]
② AIの下書きも同様に分解・役割付け
③ 役割レベルで比較：削除された役割・追加された役割・順番の変化を特定
④ 「なぜその構成がこのお客様の心理に正解か」を1文で考える

▼ スキップ条件（以下のみなら {"skip":true} のみ返す）
- 固有情報（物件名・金額・日時・住所・顧客名）のみ違う
- 誤字修正のみ（1〜2文字）
- 役割・構成・意図に実質的な差がない（ほぼ同じ）

▼ 学習ルールがある場合のJSON出力
{"skip":false,"title":"差分学習: [構成パターン名（30文字以内・具体的に）]","rule":"[役割レベルのルール。NG構成→OK構成、なぜその順番が正解かの理由を含む。250文字以内]","category":"[pattern=構成テンプレート / style=文体・トーン / phrase=言い回し のいずれかのみ。principle は絶対に選ばないこと]","trigger_example":"[このルールが適用される典型的なお客様メッセージの例文（1〜2文）。お客様が実際に送ってきそうな言葉で書く。ルールの説明文ではなくお客様側のメッセージそのものを書くこと]"}

JSONのみを返す。分析の途中経過は不要。`,
      }],
    });

    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as { skip: boolean; title?: string; rule?: string; category?: string; trigger_example?: string };
  } catch {
    return null;
  }
}

function textSimilarity(a: string, b: string): number {
  const s1 = a.replace(/\s+/g, "");
  const s2 = b.replace(/\s+/g, "");
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  // 文字レベルLCS（Dice係数）— 旧実装は j がループをまたいでリセットされず不正確だった
  const la = [...s1], lb = [...s2];
  const m = la.length, n = lb.length;
  // メモリ節約のため1次元DP
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
  return (2 * lcs) / (m + n); // Dice係数
}

// 修正量に応じて importance を変動（save-reply-example と統一）
// sim < 0.4 = 大幅修正 → 9 / 0.4〜0.65 = 中程度 → 8 / 0.65〜 = 微修正 → 7
function diffImportance(sim: number): number {
  if (sim < 0.4) return 9;
  if (sim < 0.65) return 8;
  return 7;
}

// ── ブーストインフレ防止ガード ──
// 「よく引かれる（apply_count高い）」だけで正解率を見ずに importance を +1 する盲目ブーストを防ぐ。
// - apply_count > 0 かつ correct_count/apply_count < 0.5 → ブースト不可（正解率が不十分）
// - correct+wrong > 0 かつ wrong/(correct+wrong) >= 0.4 → ブースト不可（外れ率が高い）
// - フィードバック未取得（apply_count=0 かつ correct+wrong=0）は通す（新規ルールの成長を止めない）
type BoostStats = { apply_count?: number | null; correct_count?: number | null; wrong_count?: number | null };
function isBoostEligible(rule: BoostStats): boolean {
  const applyCount = rule.apply_count ?? 0;
  const correct = rule.correct_count ?? 0;
  const wrong = rule.wrong_count ?? 0;
  if (applyCount > 0 && correct / applyCount < 0.5) return false;
  if (correct + wrong > 0 && wrong / (correct + wrong) >= 0.4) return false;
  return true;
}

// ── モジュールレベル定数（コンポーネント学習・ポジティブ強化で共用）──
const STATE_LEARNABLE: Record<string, string[]> = {
  property_send:                    ["intro", "pickup", "invite", "calendar", "closing"],
  property_send_new_arrival:        ["intro", "pickup", "invite", "calendar", "closing"],
  property_send_widen:              ["intro", "widen_note", "pickup", "invite", "closing"],
  viewing_invite:                   ["greeting", "situation", "invite", "closing"],
  application_push:                 ["movein_date", "appeal", "cta", "invite", "reassurance", "closing"],
  application_push_push:            ["greeting", "appeal", "cta", "reassurance", "closing"],
  application_push_confirm:         ["greeting", "confirmation", "closing"],
  application_push_docs_request:    ["greeting", "doc_list", "cta", "closing"],
  acknowledge_check:                ["greeting", "property_info", "estimate_request", "closing"],
  // 全アクション網羅（ポジティブ強化・差分学習の抜け防止）
  property_recommendation:          ["intro", "recommendation", "appeal", "invite", "closing"],
  property_check_result:            ["intro", "result", "calendar", "invite", "closing"],
  property_check_result_available:  ["intro", "result", "calendar", "invite", "closing"],
  property_check_result_unavailable:["intro", "result", "closing"],
  property_check_result_alternative:["intro", "result", "invite", "closing"],
  condition_hearing:                ["greeting", "intro", "cta", "closing"],
  meeting_place:                    ["greeting", "confirmation", "location", "closing"],
  estimate_sheet:                   ["greeting", "estimate_note", "invite", "closing"],
  followup_revive:                  ["greeting", "reminder", "invite", "cta", "closing"],
  // F05: followup_revive の states に含まれるが STATE_LEARNABLE に未定義だったエントリ
  hearing:                          ["greeting", "questions", "proposal", "closing"],
  proposing:                        ["greeting", "recommendation", "appeal", "invite", "closing"],
  // MED-10: ACTION_TO_STATE にあるが STATE_LEARNABLE に抜けていたエントリ
  greeting_viewing:                 ["greeting", "reminder", "closing"],
  property_check_result_vacate_date:       ["greeting", "result", "calendar", "invite", "closing"],
  property_check_result_mgmt_guarantor:    ["greeting", "result", "invite", "closing"],
  property_check_result_mgmt_move_in:      ["greeting", "result", "closing"],
  property_check_result_mgmt_initial_cost: ["greeting", "result", "invite", "closing"],
  property_check_result_mgmt_parking:      ["greeting", "result", "closing"],
  property_check_result_mgmt_pet:          ["greeting", "result", "closing"],
};

const COMPONENT_NAMES: Record<string, string> = {
  intro:            "挨拶文",
  pickup:           "ピックアップ行（条件説明）",
  invite:           "内覧誘導文",
  calendar:         "内覧可能日時の記載（直近ですと〜ご案内可能です）",
  closing:          "締め文",
  greeting:         "挨拶文",
  situation:        "状況・背景説明",
  appeal:           "物件アピール文",
  cta:              "申込み後押し文",
  reassurance:      "不安解消・フォロー一言（保証会社審査〜キャンセル料なし等）",
  movein_date:      "入居日安心（〇月〇日のご入居で問題ございません！！）",
  property_info:    "物件・確認内容の記載",
  estimate_request: "最大限割引した初期費用の御見積もり依頼",
  recommendation:   "おすすめ物件の紹介文",
  result:           "物件確認結果（空室あり/満室等）",
  confirmation:     "日程・内容の確認文",
  location:         "待ち合わせ場所の案内",
  reminder:         "久しぶり連絡・状況確認文",
  estimate_note:    "見積書の補足説明文",
  doc_list:         "必要書類リスト",
  widen_note:       "条件広げ説明文",
};

// 【textSimilarity 案C】数字・肯否変化がある場合のみ true（意味的変化の有無を低コストで判定）
// 言い回しが変わっても数字・Yes/Noが同じなら意味的に同じとみなす
function hasSemanticChange(a: string, b: string): boolean {
  const numsA = a.match(/\d+/g) ?? [];
  const numsB = b.match(/\d+/g) ?? [];
  if (JSON.stringify(numsA) !== JSON.stringify(numsB)) return true;
  const negA = (a.match(/(?:できません|ございません|ありません|いません|しません|ません)/g) ?? []).length;
  const negB = (b.match(/(?:できません|ございません|ありません|いません|しません|ません)/g) ?? []).length;
  return negA !== negB;
}

// 【textSimilarity 案B】グレーゾーン（sim 0.7〜0.95）のみ Haiku で意味的同一性を判定
// 「大倉さんご都合如何」vs「はいかが」など言い回し差分の誤学習を防止
async function isMeaningfullySame(aiText: string, sentText: string): Promise<boolean> {
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 50,
      messages: [{ role: "user", content:
        `以下2つの文章は意味・意図が実質的に同じですか？言い回しが違うだけかどうか判断してください。\n【A】${aiText.slice(0, 400)}\n【B】${sentText.slice(0, 400)}\nJSONのみ: {"same": true}または{"same": false}`,
      }],
    });
    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return false;
    const parsed = JSON.parse(match[0]) as { same: boolean };
    return parsed.same === true;
  } catch {
    return false;
  }
}

// ── 回帰センチネル: 反復削除フレーズの自動検知・ナレッジ降格 ──
// 特定顧客の特殊ケース返信が文脈を剥がされて汎用フレーズ化 → 別顧客に誤出力される事故
// （例:「入居の審査まで」が内覧希望客に誤出力）を毎日自動検知する。
// 直近14日の was_ai_modified 例から「AI案にあってスタッフが削除した文」を文単位で抽出し、
// 別の conversation_id で2件以上削除されたフレーズを「反復削除フレーズ」と判定。
// 該当する ai_reply_knowledge を importance=min(現値,3) に降格（削除・rejected化はしない）し、
// ai_feedback_items（TemplateModal「❓ AI質問」タブ）に竹内さんへの確認質問を起票する。

// 句点・！！・改行で文分割（20文字以上のみ対象 = 固有情報の短文を除外）
function splitSentences(text: string): string[] {
  return text
    .split(/[。\n！!？?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
}

async function detectRepeatedDeletions(): Promise<{ detected: number; demoted: number }> {
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentExamples, error } = await supabase
    .from("ai_reply_examples")
    .select("id, conversation_id, ai_draft, sent_reply")
    .eq("was_ai_modified", true)
    .not("ai_draft", "is", null)
    .not("sent_reply", "is", null)
    .gte("created_at", fourteenDaysAgo)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error || !recentExamples || recentExamples.length === 0) return { detected: 0, demoted: 0 };

  // ① 各例で「ai_draftにあってsent_replyから消えた文」を抽出し、類似フレーズをクラスタ化
  type Cluster = { phrase: string; convIds: Set<string> };
  const clusters: Cluster[] = [];
  for (const ex of recentExamples) {
    const draftSentences = splitSentences((ex.ai_draft as string) ?? "");
    const sentSentences = splitSentences((ex.sent_reply as string) ?? "");
    const sentNorm = ((ex.sent_reply as string) ?? "").replace(/\s+/g, "");
    const convId = (ex.conversation_id as string | null) ?? `example:${ex.id as string}`;
    for (const sentence of draftSentences) {
      if (sentNorm.includes(sentence.replace(/\s+/g, ""))) continue; // そのまま残っている
      if (sentSentences.some((t) => textSimilarity(sentence, t) >= 0.85)) continue; // 言い換えで残っている
      // 完全一致 or 類似度>0.85 は同一フレーズとしてクラスタに集約
      const cluster = clusters.find((c) => c.phrase === sentence || textSimilarity(c.phrase, sentence) > 0.85);
      if (cluster) cluster.convIds.add(convId);
      else clusters.push({ phrase: sentence, convIds: new Set([convId]) });
    }
  }

  // ② 別の conversation_id で2件以上削除 = 反復削除フレーズ（1回あたり最大10件処理）
  const repeated = clusters.filter((c) => c.convIds.size >= 2).slice(0, 10);
  if (repeated.length === 0) return { detected: 0, demoted: 0 };

  // ③ category='phrase' のナレッジを一括取得して照合（テキスト比較のみ・embedding不使用）
  // 改善③: hypothesis_status='confirmed'（実績で正しさが検証済み）のナレッジは降格対象から除外する
  //         （降格せず ai_feedback_items への起票のみで竹内さんに確認を仰ぐ）
  const { data: phraseRules } = await supabase
    .from("ai_reply_knowledge")
    .select("id, content, importance")
    .eq("category", "phrase")
    .neq("hypothesis_status", "confirmed")
    .limit(500);

  let demoted = 0;
  for (const cluster of repeated) {
    const phrase = cluster.phrase;
    const phraseNorm = phrase.replace(/\s+/g, "");
    const matchedIds = new Map<string, number>(); // knowledge id → importance

    for (const rule of phraseRules ?? []) {
      const contentNorm = ((rule.content as string) ?? "").replace(/\s+/g, "");
      if (!contentNorm) continue;
      if (
        contentNorm.includes(phraseNorm) ||
        phraseNorm.includes(contentNorm) ||
        textSimilarity(phrase, (rule.content as string) ?? "") > 0.85
      ) {
        matchedIds.set(rule.id as string, (rule.importance as number) ?? 7);
      }
    }

    // phrase 以外のカテゴリでも content にフレーズをそのまま含むナレッジは照合対象
    // 改善③: confirmed（検証済み）と principle（絶対ルール）は無差別降格の対象外
    //         （該当時は降格せず ai_feedback_items 起票のみ = 竹内さんの判断に委ねる）
    const esc = phrase.replace(/[%_\\]/g, "\\$&");
    const { data: containRules } = await supabase
      .from("ai_reply_knowledge")
      .select("id, importance")
      .ilike("content", `%${esc}%`)
      .neq("hypothesis_status", "confirmed")
      .neq("category", "principle")
      .limit(10);
    for (const rule of containRules ?? []) {
      if (!matchedIds.has(rule.id as string)) matchedIds.set(rule.id as string, (rule.importance as number) ?? 7);
    }

    // ④ 降格: importance を min(現値, 3) に（rejected は保持・降格のみ / 物理削除しない）
    for (const [ruleId, imp] of matchedIds) {
      if (imp > 3) {
        const { error: demoteError } = await supabase
          .from("ai_reply_knowledge")
          .update({ importance: 3 })
          .eq("id", ruleId);
        if (!demoteError) demoted++;
      }
    }

    // ⑤ ai_feedback_items へ起票（既存スキーマ: question/category/evidence を使用）
    //    question 先頭50字（=フレーズ部分）で dedup し、同じフレーズを毎日重複起票しない
    const question = `「${phrase.slice(0, 60)}」が${cluster.convIds.size}件の別会話でスタッフに修正されています。このフレーズはどういう顧客状況のときに使うべきですか？また現在のプロンプトや知識のどこが曖昧でこのフレーズが不適切な場面で出てしまったと思いますか？`;
    const dedupKey = question.slice(0, 50).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const { data: existing } = await supabase
      .from("ai_feedback_items")
      .select("id")
      .in("status", ["pending", "answered"])
      .ilike("question", `${dedupKey}%`)
      .limit(1);
    if (existing && existing.length > 0) continue;

    await supabase.from("ai_feedback_items").insert({
      question,
      speculation: "特定顧客向けの特殊ケース返信が、文脈を剥がされて汎用フレーズとして学習された可能性があります",
      category: "prompt_ambiguity",
      evidence: `直近14日で${cluster.convIds.size}件の別会話から削除 / 降格ナレッジID: ${matchedIds.size > 0 ? [...matchedIds.keys()].join(", ") : "該当なし"}`,
      confidence: "high",
      status: "pending",
    });
  }

  return { detected: repeated.length, demoted };
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const runLogId = await startCronLog("analyze-diffs");
  // ?limit=N で件数を指定可能（デフォルト10・最大200）
  // maxDuration=60秒 / 1件あたりLLM最大3回（2〜6秒）→ 10件＋40秒タイムガードで後半処理の時間を確保
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 10, 200) : 10;

  // 未処理の差分を取得（is_starred順で重要な学習から処理）
  const { data: examples, error: examplesError } = await supabase
    .from("ai_reply_examples")
    .select("id, customer_message, ai_draft, sent_reply, conversation_state, is_starred, ai_components, reply_angle")
    .eq("was_ai_modified", true)
    .is("diff_analyzed_at", null)
    .not("ai_draft", "is", null)
    .not("sent_reply", "is", null)
    .order("is_starred", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  // DBエラーを空配列として握りつぶさず、明示的にエラーを返す
  if (examplesError) {
    await finishCronLog(runLogId, false, undefined, examplesError.message);
    return NextResponse.json({ ok: false, error: examplesError.message }, { status: 500 });
  }

  let processed = 0;
  let learned = 0;
  const now = new Date().toISOString();

  // ══ 【タイムアウト対策】後半処理（確認済みルール同期・stale decay・ポジティブ強化B/C）を
  //    メインループの「前」に実行する。以前はループの後にあり、ループが60秒を使い切ると
  //    一度も実行されず confirmed→ai_prompt_rules 同期・decay が永遠に走らなかった。══

  // ── 確認済みルール → ai_prompt_rules 自動同期 ──
  // importance>=8 かつ hypothesis_status='confirmed' のルールをプロンプトルールとして自動登録
  // ステートに応じた action_type でスコープ付き保存
  // （複合ステートはAIXアクション名へ、汎用ステートはgenerate_reply へ、未知はグローバル）

  // confirmed ナレッジの conversation_state → ai_prompt_rules の action_type マップ
  // AIX固有ステート → AIXのaction_type（scoped注入）
  // generate-reply 汎用ステート → "generate_reply"（generate-replyのみに注入）
  // 未知ステート / null → null（全アクションに注入するグローバル）
  const KNOWLEDGE_STATE_TO_ACTION: Record<string, string | null> = {
    // AIX アクション固有ステート
    property_send: "property_send", property_send_pickup: "property_send",
    viewing_invite: "viewing_invite", viewing: "viewing_invite",
    viewing_schedule: "viewing_invite", inspection: "viewing_invite",
    greeting_viewing: "greeting_viewing",
    application_push: "application_push", applying: "application_push",
    application: "application_push", screening: "application_push", contract: "application_push",
    condition_hearing: "condition_hearing",
    estimate_sheet: "estimate_sheet", estimate_request: "estimate_sheet",
    meeting_place: "meeting_place",
    property_check_result: "property_check_result",
    property_check_result_available: "property_check_result",
    property_check_result_unavailable: "property_check_result",
    property_check_result_alternative: "property_check_result",
    property_recommendation: "property_recommendation",
    // generate-reply 汎用ステート
    hearing: "generate_reply", first_reply: "generate_reply",
    proposing: "generate_reply", closed_won: "generate_reply",
    // 未知ステート → null（グローバル）
  };

  let synced = 0;
  let demotedConfirmed = 0;
  try {
    const { data: confirmedRules } = await supabase
      .from("ai_reply_knowledge")
      .select("id, title, content, conversation_state")
      .eq("hypothesis_status", "confirmed")
      .gte("importance", 8)
      .limit(100);

    if (confirmedRules && confirmedRules.length > 0) {
      const upserts = confirmedRules.map((r) => {
        const state = r.conversation_state as string | null;
        const mappedActionType = state
          ? (Object.prototype.hasOwnProperty.call(KNOWLEDGE_STATE_TO_ACTION, state)
              ? KNOWLEDGE_STATE_TO_ACTION[state]
              : null)
          : null;
        return {
          rule_key: `LEARN-${r.id as string}`,
          action_type: mappedActionType,   // ← ステートに応じた正しいスコープ
          condition_key: null,             // ← action_type でスコープ済み。condition は不要
          condition_value: null,
          rule_text: (r.content as string).slice(0, 500),
          reason: `ai_reply_knowledge自動昇格: ${(r.title as string).slice(0, 100)}`,
          priority: 8,
          is_active: true,
        };
      });
      const { error: upsertError } = await supabase
        .from("ai_prompt_rules")
        .upsert(upserts, { onConflict: "rule_key" });
      if (!upsertError) synced = confirmedRules.length;
    }

    // rejected ルールは ai_prompt_rules でも非アクティブ化
    const { data: rejectedRules } = await supabase
      .from("ai_reply_knowledge")
      .select("id")
      .eq("hypothesis_status", "rejected")
      .limit(100);
    if (rejectedRules && rejectedRules.length > 0) {
      const keys = rejectedRules.map((r) => `LEARN-${r.id as string}`);
      await supabase.from("ai_prompt_rules")
        .update({ is_active: false })
        .in("rule_key", keys);
    }
  } catch { /* ignore - プロンプトルール同期失敗はメイン処理を止めない */ }

  // ── ④ confirmed 再検証: 直近フィードバックで wrong 比率≥50%（計4件以上）→ hypothesis に差し戻し ──
  // 「昔は正しかったが今は違う」ルールを自動検出。市況変化・方針変更で陳腐化した confirmed を救出する。
  try {
    const { data: confirmedRules2 } = await supabase
      .from("ai_reply_knowledge")
      .select("id, title, correct_count, wrong_count")
      .eq("hypothesis_status", "confirmed")
      .limit(300);

    for (const rule of confirmedRules2 ?? []) {
      const correct = (rule.correct_count as number) ?? 0;
      const wrong   = (rule.wrong_count   as number) ?? 0;
      const total   = correct + wrong;
      if (total < 4) continue;
      if (wrong / total < 0.5) continue;
      // 外れ率50%超え → confirmed を剥奪して hypothesis に差し戻す
      await supabase.from("ai_reply_knowledge")
        .update({ hypothesis_status: "hypothesis" })
        .eq("id", rule.id as string);
      demotedConfirmed++; // demotedConfirmed は外側のスコープで集計
      // ai_feedback_items に再確認質問を起票（重複防止）
      const question = `「${(rule.title as string).slice(0, 50)}」ルールの妥当性を再確認してください（RLHF wrong率${Math.round(wrong / total * 100)}%）`;
      const dedupKey = question.slice(0, 50).replace(/[%_\\]/g, "\\$&");
      const { data: existsFb } = await supabase
        .from("ai_feedback_items")
        .select("id")
        .in("status", ["pending", "answered"])
        .ilike("question", `${dedupKey}%`)
        .limit(1);
      if (!existsFb || existsFb.length === 0) {
        await supabase.from("ai_feedback_items").insert({
          question,
          speculation: `このルールは過去に confirmed になりましたが、直近のRLHFフィードバックで外れ率が50%を超えました（correct:${correct}件, wrong:${wrong}件）。市況変化・ルール陳腐化の可能性があります。`,
          category: "knowledge_gap",
          evidence: `correct:${correct}, wrong:${wrong}, 外れ率:${Math.round(wrong / total * 100)}%`,
          confidence: "high",
          status: "pending",
        });
      }
    }
  } catch { /* ignore - confirmed再検証失敗はメイン処理を止めない */ }

  // ── stale decay: 90日間 used_count=0 のルールを自動 rejected に ──
  // apply_count>=5 判定(RPC)だけでは使われないまま放置されたルールは永遠に残る。
  // 一度も使われず90日経過 → 実運用に合わない可能性が高い → hypothesis_status=rejected
  // MED-02: correct_count>0 のルールは decay 対象外（一度でも正しく使われた実績あり = まだ有効）
  // S04: apply_count>0 条件追加 — 一度も検索でヒットしていないルールは除外。
  //      greeting_viewing / property_check_result_vacate_date 等の稀少ステートは90日以内に
  //      発火チャンスがなく rejected 化する恐れがあるため、apply 実績のあるルールのみを対象とする。
  try {
    const staleThreshold = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("ai_reply_knowledge")
      .update({ hypothesis_status: "rejected" })
      .lte("importance", 8)                          // importance=9以外を対象（F09: update-knowledgeの物理削除範囲と統一）
      .eq("used_count", 0)                          // 一度も使われていない
      .eq("correct_count", 0)                       // MED-02: 正答実績があるルールは除外
      .gt("apply_count", 0)                         // S04: apply実績がないルールは対象外（稀少ステート保護）
      .lt("created_at", staleThreshold)             // 90日以上前に作成
      .neq("hypothesis_status", "confirmed")        // 確認済みは除外
      .neq("hypothesis_status", "rejected");        // 既にrejectは除外
  } catch { /* decay 失敗は無視して処理を続ける */ }

  // ── F06: importance=9 の放置ルールを 180 日で soft-delete ──
  // importance=9 は通常の stale decay（lt("importance", 8)）と物理削除（update-knowledge cron）の
  // 両方から除外されるため、際限なく蓄積する。180日未使用なら rejected へ。
  try {
    const staleThreshold180 = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("ai_reply_knowledge")
      .update({ hypothesis_status: "rejected" })
      .eq("importance", 9)
      .eq("used_count", 0)
      .eq("correct_count", 0)
      .gt("apply_count", 0)                         // BUG-03: 90日decayと同様、apply実績ゼロは除外
      .lt("created_at", staleThreshold180)
      .neq("hypothesis_status", "confirmed")
      .neq("hypothesis_status", "rejected");
  } catch { /* ignore */ }

  // ── ポジティブ強化 B: correct_count >= 3 のルールを importance 昇格 ──
  // タイムアウト対策でループ前に移動。処理対象がある実行のみ昇格する
  // （旧 (learned+processed)>0 ガードと同等 — 処理対象ゼロの実行では走らず二重実行を防止）
  if ((examples?.length ?? 0) > 0) try {
    const { data: correctRules } = await supabase
      .from("ai_reply_knowledge")
      .select("id, importance, apply_count, correct_count, wrong_count")
      .gte("correct_count", 3)
      .lt("importance", 9)
      .neq("hypothesis_status", "rejected")
      .order("correct_count", { ascending: false })
      .limit(50);
    for (const rule of correctRules ?? []) {
      // correct_count>=3 でも apply_count に対する正解率が低い/外れ率が高いルールは昇格しない
      if (!isBoostEligible(rule as BoostStats)) continue;
      await supabase.from("ai_reply_knowledge")
        .update({ importance: Math.min(9, (rule.importance as number) + 1) })
        .eq("id", rule.id);
    }
  } catch { /* ignore */ }

  // ── ポジティブ強化 C: 過去30日の変更率（mod_rate）でステート単位スコア調整 ──
  // タイムアウト対策でループ前に移動。処理対象がある実行のみスコア調整する
  // 変更率 <= 20% = AIが当たり続けている → 上位ルール +1
  // 変更率 >= 70% = AIが外れ続けている → 下位ルール -1
  if ((examples?.length ?? 0) > 0) try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: examples30 } = await supabase
      .from("ai_reply_examples")
      .select("conversation_state, was_ai_modified")
      .gte("created_at", thirtyDaysAgo)
      .not("ai_draft", "is", null);

    if (examples30 && examples30.length >= 10) {
      const stateStats = new Map<string, { total: number; modified: number }>();
      for (const row of examples30) {
        const s = row.conversation_state as string;
        if (!s) continue;
        const st = stateStats.get(s) ?? { total: 0, modified: 0 };
        st.total++;
        if (row.was_ai_modified) st.modified++;
        stateStats.set(s, st);
      }
      for (const [state, stats] of stateStats) {
        if (stats.total < 5) continue; // データ少なすぎる場合はスキップ
        const modRate = stats.modified / stats.total;
        // S03: .like('${state}%') → .in([state, ...compStates]) で兄弟ステートへの誤ブースト/降格を防止
        const compStates = (STATE_LEARNABLE[state] ?? []).map(c => `${state}_${c}`);
        const matchStates = [state, ...compStates];
        if (modRate <= 0.2) {
          // AIが当たり続けている → 上位ルールを +1（正解率ガード通過ルールのみ）
          const { data: topRules } = await supabase
            .from("ai_reply_knowledge")
            .select("id, importance, apply_count, correct_count, wrong_count")
            .in("conversation_state", matchStates)
            .lt("importance", 9)
            .neq("hypothesis_status", "rejected")
            .order("apply_count", { ascending: false })
            .limit(3);
          for (const rule of topRules ?? []) {
            if (!isBoostEligible(rule as BoostStats)) continue; // apply_count順の盲目ブースト防止
            await supabase.from("ai_reply_knowledge")
              .update({ importance: Math.min(9, (rule.importance as number) + 1) })
              .eq("id", rule.id);
          }
        } else if (modRate >= 0.7) {
          // AIが外れ続けている → 下位ルールを -1
          const { data: lowRules } = await supabase
            .from("ai_reply_knowledge")
            .select("id, importance")
            .in("conversation_state", matchStates)
            .gt("importance", 5)
            .neq("hypothesis_status", "confirmed")
            .order("apply_count", { ascending: true })
            .limit(3);
          for (const rule of lowRules ?? []) {
            await supabase.from("ai_reply_knowledge")
              .update({ importance: Math.max(5, (rule.importance as number) - 1) })
              .eq("id", rule.id);
          }
        }
      }
    }
  } catch { /* ignore */ }

  if (!examples || examples.length === 0) {
    // 処理対象ゼロでも同期・decayは上で実行済み。cron logも完了させる（ok=null放置を防ぐ）
    await finishCronLog(runLogId, true, { processed: 0, learned: 0, synced, demotedConfirmed });
    return NextResponse.json({ ok: true, processed: 0, learned: 0, synced, demotedConfirmed, message: `処理対象なし・confirmed差し戻し${demotedConfirmed}件` });
  }

  // ── 回帰センチネル: メインの差分学習ループと並列実行 ──
  // LLM不使用（DBクエリ+ローカルテキスト比較のみ）のため maxDuration=60 への影響は軽微
  const sentinelPromise = detectRepeatedDeletions().catch((e) => {
    console.error("[analyze-diffs] 回帰センチネル失敗:", e);
    return { detected: 0, demoted: 0 };
  });

  // ── メインループ: 40秒タイムガード付き（残り約20秒を後続処理・レスポンスに確保）──
  const startTime = Date.now();
  let timedOut = false;
  for (const ex of examples) {
    if (Date.now() - startTime > 40_000) {
      timedOut = true;
      console.warn(`[analyze-diffs] 40秒タイムガード発動 — ${processed}/${examples.length}件で打ち切り（残りは次回実行で処理）`);
      break;
    }
    const { id, customer_message, ai_draft, sent_reply, conversation_state, is_starred, ai_components, reply_angle } = ex as {
      id: string;
      customer_message: string;
      ai_draft: string;
      sent_reply: string;
      conversation_state: string;
      is_starred: boolean;
      ai_components: Record<string, string> | null;
      reply_angle: string | null;
    };

    // 完全一致はスキップ（構成が同じなので学習不要）
    if ((ai_draft ?? "").trim() === (sent_reply ?? "").trim()) {
      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue;
    }

    // 分割送信っぽい場合（sentReplyがaiDraftの40%未満かつ類似度50%以上）はスキップ
    const sim = textSimilarity((ai_draft ?? "").trim(), (sent_reply ?? "").trim());
    const likelySplit = (sent_reply ?? "").trim().length < (ai_draft ?? "").trim().length * 0.4 && sim >= 0.5;
    if (likelySplit) {
      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue;
    }

    // 【textSimilarity 案C+B】グレーゾーン（sim 0.7〜0.95）かつ意味的変化なし → Haiku で確認 → 誤学習スキップ
    // 数字・肯否変化のない言い回し差分（如何→いかが等）を誤学習させない
    if (sim >= 0.7 && sim < 0.95 && !hasSemanticChange(ai_draft ?? "", sent_reply ?? "")) {
      const same = await isMeaningfullySame(ai_draft ?? "", sent_reply ?? "");
      if (same) {
        // 意味的に同じ = AIが実質正解 → コンポーネントをポジティブ強化してスキップ
        if (ai_components) {
          const posLearnList = STATE_LEARNABLE[conversation_state] ?? [];
          for (const comp of posLearnList.slice(0, 3)) {
            if (!(ai_components as Record<string, string>)[comp]) continue;
            const { data: posRules } = await supabase
              .from("ai_reply_knowledge")
              .select("id, importance, apply_count, correct_count, wrong_count")
              .eq("conversation_state", `${conversation_state}_${comp}`)
              .order("apply_count", { ascending: false })
              .limit(2);
            for (const rule of posRules ?? []) {
              if (!isBoostEligible(rule as BoostStats)) continue; // 正解率不足の盲目ブースト防止
              const imp = (rule.importance as number) ?? 7;
              if (imp < 9) {
                await supabase.from("ai_reply_knowledge")
                  .update({ importance: Math.min(9, imp + 1) }).eq("id", rule.id);
              }
            }
          }
        }
        await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
        processed++;
        continue;
      }
    }

    // コンポーネント単位の2層学習
    // reply_angle="component_diff:pickup(phrase),invite(structure)" などが対象
    if (ai_components && reply_angle?.startsWith("component_diff:")) {
      const rawChanged = reply_angle.replace("component_diff:", "").split(",");

      // 新フォーマット "pickup(phrase)" / 旧フォーマット "pickup" に対応
      type CompChange = { comp: string; changeType: "phrase" | "structure" };
      const parsedChanges: CompChange[] = rawChanged.map(c => {
        const m = c.match(/^(\w+)\((\w+)\)$/);
        return m
          ? { comp: m[1], changeType: m[2] as "phrase" | "structure" }
          : { comp: c, changeType: "phrase" as const }; // 旧フォーマットはphrase扱い
      });

      // STATE_LEARNABLE / COMPONENT_NAMES はモジュールレベルで定義済み
      const learnableList = STATE_LEARNABLE[conversation_state] ?? STATE_LEARNABLE["property_send"] ?? [];
      const learnableSet = new Set(learnableList);
      const learnableChanges = parsedChanges.filter(({ comp }) => learnableSet.has(comp));

      if (learnableChanges.length === 0) {
        // 固有情報コンポーネントのみ変化 → 学習不要
        await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
        processed++;
        continue;
      }

      // ── 誤差学習: 変化したコンポーネントをタイプ別に分析（最大2件）──
      const learnableChangedNames = new Set(learnableChanges.map(c => c.comp));
      for (const { comp, changeType } of learnableChanges.slice(0, 2)) {
        const aiCompText = (ai_components as Record<string, string>)[comp] ?? "";
        if (!aiCompText || aiCompText.length < 5) continue;
        const compState = `${conversation_state}_${comp}`;
        const compName = COMPONENT_NAMES[comp] ?? comp;

        // phrase=文字変化（言い回し）/ structure=パターン変化（省略・構成変更）
        const compResult = changeType === "structure"
          ? await analyzeStructureDiff(customer_message, aiCompText, sent_reply, compState, compName)
          : await analyzeComponentDiff(customer_message, aiCompText, sent_reply, compState, compName);

        if (compResult && !compResult.skip && compResult.title && compResult.rule) {
          const embInput = buildKnowledgeEmbeddingInput({
            trigger_example: customer_message,
            rule: compResult.rule,
            conversation_state: compState,
          });
          const embedding = await generateEmbedding(embInput);
          const imp = is_starred ? Math.min(9, diffImportance(sim) + 1) : diffImportance(sim);
          const upsertResult = await upsertKnowledge(supabase, {
            title: compResult.title,
            content: compResult.rule,
            // structure変化 → pattern（構成ルール） / phrase変化 → phrase（言い回しルール）
            category: changeType === "structure" ? "pattern" : "phrase",
            importance: imp,
            conversation_state: compState,
            source_example_id: id,
            ...(embedding ? { embedding } : {}),
          });
          if (upsertResult === "inserted" || upsertResult === "merged") learned++;
        }
      }

      // ── 予測スコア: 変化しなかったコンポーネントのルールをブースト ──
      // 「AIの予測どおりだった」コンポーネント → 最多適用ルールの importance +1（穴3修正: 盲目的な直近2件→apply_count順）
      // インフレ修正: 正解率ガード（isBoostEligible）を通過したルールのみブースト
      const correctComponents = learnableList.filter(c =>
        (ai_components as Record<string, string>)[c] && !learnableChangedNames.has(c),
      );
      for (const comp of correctComponents.slice(0, 2)) {
        const compState = `${conversation_state}_${comp}`;
        const { data: rules } = await supabase
          .from("ai_reply_knowledge")
          .select("id, importance, apply_count, correct_count, wrong_count")
          .eq("conversation_state", compState)
          .order("apply_count", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(2);
        for (const rule of rules ?? []) {
          if (!isBoostEligible(rule as BoostStats)) continue; // 外れ率>=40%のルールはブーストしない
          const imp = (rule.importance as number) ?? 7;
          if (imp < 9) {
            await supabase
              .from("ai_reply_knowledge")
              .update({ importance: Math.min(9, imp + 1) })
              .eq("id", rule.id);
          }
        }
      }

      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue; // 通常の full-message analyzeDiff はスキップ
    }

    const result = await analyzeDiff(customer_message, ai_draft, sent_reply, conversation_state);

    // AI呼び出し失敗時も diff_analyzed_at をマークして「試行済み」扱いにする
    // （マークしないと毎日同じレコードを拾い続け、常に失敗するレコードでキューが詰まるため）
    if (result === null) {
      console.error(`[analyze-diffs] analyzeDiff failed for example id=${id} — marking diff_analyzed_at to prevent infinite retry`);
      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue;
    }

    if (!result.skip && result.title && result.rule) {
      // principle は diff 由来ルールの「絶対ルール」昇格を防ぐため許可しない（#4）
      const ALLOWED_CATEGORIES = new Set(["pattern", "style", "phrase"]);
      const rawCategory = (result.category ?? "pattern").split("=")[0].trim();
      const safeCategory = ALLOWED_CATEGORIES.has(rawCategory) ? rawCategory : "pattern";
      // #21: 検索クエリ（顧客メッセージ）と意味空間を揃えるため trigger_example を優先して embedding 化
      const embeddingInput = buildKnowledgeEmbeddingInput({
        trigger_example: result.trigger_example,
        rule: result.rule,
        conversation_state: conversation_state ?? "proposing",
      });
      const embedding = await generateEmbedding(embeddingInput);
      // ☆つき or 大幅修正ほど importance を上げる
      const baseImp = diffImportance(sim);
      const imp = is_starred ? Math.min(9, baseImp + 1) : baseImp;

      const upsertResult = await upsertKnowledge(supabase, {
        title: result.title,
        content: result.rule,
        category: safeCategory,
        importance: imp,
        conversation_state: conversation_state ?? "proposing",
        source_example_id: id,
        ...(embedding ? { embedding } : {}),
      });

      if (upsertResult === "inserted") {
        learned++;
      } else if (upsertResult === "merged") {
        console.log(`[analyze-diffs] 既存ルール強化: "${result.title}"`);
        learned++;
      } else {
        console.log(`[analyze-diffs] スキップ（重複）: "${result.title}"`);
      }

      // F02: importance>=8 かつ pattern ルールを adaptation_improvement_rules にも同期
      // LINE/AIX修正からの学習をテンプレート修正学習ルールとして両方のAIに届ける
      if ((upsertResult === "inserted" || upsertResult === "merged") && imp >= 8 && safeCategory === "pattern" && result.rule) {
        const adaptCategory = conversation_state ?? "general";
        const adaptConfidence = imp >= 9 ? 0.9 : 0.75;
        const ruleKey = result.rule.slice(0, 50).replace(/[%_\\]/g, "\\$&");
        const { data: existingAdapt } = await supabase
          .from("adaptation_improvement_rules")
          .select("id, example_count, confidence")
          .eq("category", adaptCategory)
          .ilike("rule_text", `${ruleKey}%`)
          .limit(1).maybeSingle();
        if (existingAdapt) {
          await supabase.from("adaptation_improvement_rules").update({
            example_count: (existingAdapt.example_count as number) + 1,
            confidence: Math.min(Math.max(Number(existingAdapt.confidence), adaptConfidence) + 0.02, 0.99),
            last_triggered_at: now, is_active: true,
          }).eq("id", existingAdapt.id);
        } else {
          await supabase.from("adaptation_improvement_rules").insert({
            category: adaptCategory, rule_text: result.rule,
            confidence: adaptConfidence, example_count: 1, is_active: true, last_triggered_at: now,
          });
        }
      }
    }

    await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
    processed++;
  }

  // ── ポジティブ強化 A: was_ai_used=true（AIそのまま送信）→ コンポーネントルールをブースト ──
  // スタッフが修正せず送信 = AI予想が正解 = 各コンポーネントのルールを強化する
  // was_ai_modified=false かつ ai_components あり のレコードが対象（最大20件）
  {
    const { data: usedExamples } = await supabase
      .from("ai_reply_examples")
      .select("id, conversation_state, ai_components")
      .eq("was_ai_modified", false)
      .eq("was_ai_used", true)
      .is("diff_analyzed_at", null)
      .not("ai_components", "is", null)
      .order("created_at", { ascending: false })
      .limit(20);

    for (const ue of usedExamples ?? []) {
      const ueState = ue.conversation_state as string;
      const ueComps = ue.ai_components as Record<string, string>;
      const ueLearnList = STATE_LEARNABLE[ueState] ?? [];
      for (const comp of ueLearnList.slice(0, 3)) {
        if (!ueComps[comp]) continue;
        const compState = `${ueState}_${comp}`;
        const { data: posRules } = await supabase
          .from("ai_reply_knowledge")
          .select("id, importance, apply_count, correct_count, wrong_count")
          .eq("conversation_state", compState)
          .order("apply_count", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(2);
        for (const rule of posRules ?? []) {
          if (!isBoostEligible(rule as BoostStats)) continue; // correct_count/apply_count >= 0.5 のルールのみブースト
          const imp = (rule.importance as number) ?? 7;
          if (imp < 9) {
            await supabase.from("ai_reply_knowledge")
              .update({ importance: Math.min(9, imp + 1) }).eq("id", rule.id);
          }
        }
      }
      await supabase.from("ai_reply_examples")
        .update({ diff_analyzed_at: now }).eq("id", ue.id);
    }
  }

  // ── ⑤ 再生成シグナル: 同一会話で AIX を複数回生成 → 古いものを discarded に ──
  // 「気に入らなくて生成し直した」= 強い不満シグナル。生成→送信の窓（30分）を超えた 'generated' も破棄確定。
  {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: staleLogs } = await supabase
      .from("aix_generate_log")
      .select("id, conversation_id, action_type, generated_at")
      .eq("status", "generated")
      .lt("generated_at", twoHoursAgo)
      .order("generated_at", { ascending: true })
      .limit(500);

    // ① 2時間超えの未送信 → discarded（送信ウィンドウ30分を大幅超過）
    const staleIds = (staleLogs ?? []).map(r => r.id as string);

    // ② 2時間以内でも同一 conversation_id + action_type に複数 generated → 古いものを discarded
    const recentThreshold = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: recentLogs } = await supabase
      .from("aix_generate_log")
      .select("id, conversation_id, action_type, generated_at")
      .eq("status", "generated")
      .gte("generated_at", recentThreshold)
      .order("generated_at", { ascending: true })
      .limit(500);

    const regenMap = new Map<string, Array<{ id: string }>>();
    for (const row of recentLogs ?? []) {
      const key = `${(row.conversation_id as string | null) ?? "null"}::${row.action_type as string}`;
      const arr = regenMap.get(key) ?? [];
      arr.push({ id: row.id as string });
      regenMap.set(key, arr);
    }
    const regenDiscardIds: string[] = [];
    for (const [, rows] of regenMap) {
      if (rows.length >= 2) {
        // 最新1件を残して古いものを全て discarded に
        regenDiscardIds.push(...rows.slice(0, -1).map(r => r.id));
      }
    }

    const allDiscardIds = [...new Set([...staleIds, ...regenDiscardIds])];
    if (allDiscardIds.length > 0) {
      // 500件超えは分割して更新（Supabase .in() の上限対策）
      for (let i = 0; i < allDiscardIds.length; i += 100) {
        try {
          await supabase.from("aix_generate_log")
            .update({ status: "discarded" })
            .in("id", allDiscardIds.slice(i, i + 100));
        } catch { /* ignore - discarded更新失敗はメイン処理を止めない */ }
      }
    }
  }

  // ── 回帰センチネルの結果を回収（反復削除フレーズ検知数・ナレッジ降格数）──
  const sentinel = await sentinelPromise;

  // 学習済みナレッジのembeddingを即座にバックフィル
  if (learned > 0) {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
      ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
    void fetch(`${baseUrl}/api/backfill-embeddings`, {
      method: "POST",
      headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
    }).catch(() => {});
  }

  // ── cron失敗の可視化: 直近24時間に ok=null（未完了 = タイムアウト/クラッシュ）の実行記録があれば通知 ──
  let cronWarning = "";
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let staleQuery = supabase
      .from("cron_run_logs")
      .select("id")
      .eq("cron_name", "analyze-diffs")
      .is("ok", null)
      .gte("started_at", dayAgo);
    if (runLogId) staleQuery = staleQuery.neq("id", runLogId); // 実行中の今回レコードは除外
    const { data: staleRuns } = await staleQuery.limit(10);
    if (staleRuns && staleRuns.length > 0) {
      cronWarning = `⚠️ 直近24時間に未完了（ok=null）のcron実行が${staleRuns.length}件あります（タイムアウトの可能性）`;
    }
  } catch { /* ignore - 可視化失敗はメイン処理を止めない */ }

  await finishCronLog(runLogId, true, { processed, learned, synced, demotedConfirmed, timedOut, sentinelDetected: sentinel.detected, sentinelDemoted: sentinel.demoted, ...(cronWarning ? { cronWarning } : {}) });
  return NextResponse.json({
    ok: true, processed, learned, synced, demotedConfirmed, timedOut,
    sentinelDetected: sentinel.detected, sentinelDemoted: sentinel.demoted,
    ...(cronWarning ? { cronWarning } : {}),
    message: `${processed}件処理・${learned}件学習・${synced}件ルール同期・confirmed差し戻し${demotedConfirmed}件・反復削除フレーズ${sentinel.detected}件検知（${sentinel.demoted}件降格）${timedOut ? "・⏱40秒タイムガードで打ち切り" : ""}${cronWarning ? ` / ${cronWarning}` : ""}`,
  });
}

export async function GET(req: NextRequest) {
  // Vercel Cron からの呼び出しを CRON_SECRET で認証（#15）
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== "Bearer " + cronSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
