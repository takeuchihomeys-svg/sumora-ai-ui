import { supabase } from "@/app/lib/supabase";

// ── AI質問（ai_feedback_items）起票ガード（全書き込み元共通）──
// analyze-diffs だけでなく corpus2skill / adapt-feedback 等の直接INSERTにも
// 同じ上限を適用し、pending が溜まりすぎて竹内さんが処理しきれなくなるのを防ぐ。
// - pending 総数が MAX_PENDING 件以上なら新規起票をスキップ
const MAX_PENDING = 60;

export async function canInsertAiQuestion(): Promise<boolean> {
  const { count } = await supabase
    .from("ai_feedback_items")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  return (count ?? 0) < MAX_PENDING;
}

// ── スモラAIシステム絶対ルール（AI質問生成プロンプト共通コンテキスト）──
// analyze-diffs / weekly-learning のAI質問生成LLM呼び出し（insertAiQuestion 前）に注入する。
// 目的: ①AIXボタンと通常返信の領域を混同した誤質問を防ぐ ②既存確定ルールと矛盾する質問の起票を防ぐ
//       ③質問登録フォーマット（抽象化・完全文・entry_source/aix_action）を徹底する
export const SUMORA_QUESTION_SYSTEM_CONTEXT = `## スモラAIシステム絶対ルール（質問生成時に必ず参照）

### AIXボタンと通常返信の専用領域（絶対に混同しない）
- viewing_invite（内覧へ！）: 内覧日時の具体提示・カレンダー調整 ← 通常返信では日時を絶対出さない
- estimate_sheet（見積書送る）: 見積書カバー文・金額内訳 ← 通常返信は作成宣言のみ
- property_send/property_recommendation: 物件紹介文本体・画像 ← 通常返信は送付宣言のみ
- application_push（申込へ！）: 申込書類リスト・フォーマット ← 通常返信は申込誘導のみ
- property_check_result（物件確認した）: 空室確認・退去日・入居可能日の報告 ← 通常返信では断言・推測禁止
- condition_hearing（条件ヒアリング）: 条件フォーム送付 ← 通常返信は条件確認会話のみ
- meeting_place（待ち合わせ）: 物件住所・集合場所・集合時間の確定文 ← 通常返信は「内覧の詳細についてはご連絡させて頂きます」等の宣言のみ

### スモラ確定ルール（既存ルールと矛盾する質問は起票しない）
- 先手の誘導・条件が揃ったら聞き返し絶対禁止
- 具体的期限（本日中・明日15時等）を入れない
- 急かし表現禁止・謝罪禁止・他社比較禁止
- 呼び方は「〇〇さん」統一（「様」はNG）
- 敷金は節約メリット表現禁止（返還される預り金）
- 本人確認書類は免許証かマイナンバーカード2択のみ
- 路線名・駅名はサイト（リアプロ/itandi/レインズ）別に独立・混同禁止

### 質問登録ルール
- 顧客実名・物件固有情報は必ず抽象化（「田中様」→「顧客名」等）
- 質問文は途中切れ・タイトルのみNG・必ず完全な文で
- entry_source: AIX生成文=aix_action、通常返信=line_reply
- aix_action: AIX由来の場合は必ず設定（viewing_invite等）`;

export type AiQuestionItem = {
  category: string;
  question: string;
  speculation?: string | null;
  evidence?: string | null;
  confidence?: string | null;
  entry_source?: string | null;
  aix_action?: string | null;
};

// ── ルール矛盾質問の統一フォーマット ──
// 全起票元（analyze-diffs / bulk-judge-knowledge / weekly-learning）で共通の
// 「■ 見出し」形式の質問テキストを生成する。
// markerPrefix には ai-feedback closed-loop 用の [knowledge_id:] / [old_knowledge_id:] マーカーを渡す
// （マーカーは質問先頭の1行目に置かれ、UI 表示時には除去される）。
export type RuleConflictNewRule = {
  title: string;
  content: string;
  phase?: string | null;
  importance?: number | null;
  applyCount?: number | null;
  correctCount?: number | null;
  wrongCount?: number | null;
};

export function buildRuleConflictQuestion(input: {
  markerPrefix?: string;
  newRule: RuleConflictNewRule;
  // 【ルール1】「タイトル」\n内容 ... の形式で整形済みの既存ルール一覧テキスト
  existingRulesText: string;
  conflictReason: string;
}): string {
  const { markerPrefix, newRule, existingRulesText, conflictReason } = input;
  const importanceText = newRule.importance != null ? `${newRule.importance}点` : "不明";
  return `${markerPrefix ? `${markerPrefix}\n\n` : ""}竹内さん、ルールの矛盾について判断をお願いします。

■ 新しく学んだルール
タイトル：「${newRule.title}」
フェーズ：${newRule.phase ?? "不明"} / 重要度：${importanceText} ／ 適用 ${newRule.applyCount ?? 0}回 ／ 正解 ${newRule.correctCount ?? 0}回・誤答 ${newRule.wrongCount ?? 0}回

内容：
${newRule.content}

■ ぶつかっている既存ルール
${existingRulesText || "（なし）"}

■ 何がぶつかっているか
${conflictReason}

■ 質問
どちらのルールを優先しますか？
① 新しいルールを採用する（既存ルールを更新）
② 既存ルールを維持する（新ルールは不採用）
③ 場面で使い分ける → どう使い分けますか？`;
}

// pending 上限を確認してから ai_feedback_items に起票する。
// 上限到達・INSERT失敗時は false を返す（呼び出し元はスキップとして扱う）。
export async function safeInsertAiQuestion(item: AiQuestionItem): Promise<boolean> {
  if (!(await canInsertAiQuestion())) {
    console.log(`[ai-feedback-guard] AI質問pending上限(${MAX_PENDING}件)到達、新規起票スキップ`);
    return false;
  }
  const { error } = await supabase.from("ai_feedback_items").insert({
    ...item,
    status: "pending",
  });
  if (error) {
    console.warn("[ai-feedback-guard] AI質問起票失敗:", error.message);
    return false;
  }
  return true;
}
