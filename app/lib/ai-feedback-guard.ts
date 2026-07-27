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

export type AiQuestionItem = {
  category: string;
  question: string;
  speculation?: string | null;
  evidence?: string | null;
  confidence?: string | null;
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
