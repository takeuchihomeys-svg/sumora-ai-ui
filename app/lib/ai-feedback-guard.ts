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
