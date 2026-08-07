import { supabase } from "@/app/lib/supabase";

// ── AI質問（ai_feedback_items）起票ガード（全書き込み元共通）──
// analyze-diffs だけでなく corpus2skill / adapt-feedback 等の直接INSERTにも
// 同じ上限を適用し、pending が溜まりすぎて竹内さんが処理しきれなくなるのを防ぐ。
// - pending 総数が MAX_PENDING 件以上なら新規起票をスキップ
// - 同一 aix_action × category の pending が MAX_PENDING_PER_ACTION_CATEGORY 件以上でもスキップ（②-1 窒息解消）
const MAX_PENDING = 60;
const MAX_PENDING_PER_ACTION_CATEGORY = 2;

export async function canInsertAiQuestion(): Promise<boolean> {
  const { count } = await supabase
    .from("ai_feedback_items")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  return (count ?? 0) < MAX_PENDING;
}

// ②-1: aix_action × category 単位のpending件数を数える（ハードキャップ判定用）
// aix_action が null の場合は「aix_action未設定の同category質問」を数える
async function countPendingForActionCategory(aixAction: string | null, category: string): Promise<number> {
  let query = supabase
    .from("ai_feedback_items")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .eq("category", category);
  query = aixAction != null ? query.eq("aix_action", aixAction) : query.is("aix_action", null);
  const { count } = await query;
  return count ?? 0;
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
- aix_action: AIX由来の場合は必ず設定（viewing_invite等）

### 質問文の設計原則（高品質な回答を引き出すために必ず守る）
- 質問本文にAIが実際に出した文またはルールの内容を必ず引用して見せる（抽象的な説明だけにしない）
- 「どんな場面で使いますか？」と聞かない — 代わりに「○○の場合は〜すべきか / △△の場合は〜しないか、という形でルールの適用条件を定義してください」と求める
- 使うべき場面と使わないべき場面を必ず両方セットで確認する（片方だけ聞かない）
- AIXボタンとの境界が関わる場合は「通常返信AIが担当すること / AIXボタンが担当すること」の役割分担を明示的に問う
- 既存ルールと差分が矛盾する場合は「現行ルール: [内容] ↔ 今回の差分: [内容]」と対比を見せてからどちらが正しいかを問う
- 選択肢（①②③）形式を使わない — 選択肢があると番号だけで終わる。代わりに「正しいルールを具体的に定義してください」と求める
- 「なければ特になし」「問題なければスキップ」等の逃げ道を作らない

### 高品質な質問の例（目指すフォーマット）
【良い例】
「今回の差分で、AIは『お気軽にご連絡ください』と送りましたが、スタッフが削除しました。
現在のルール：一次返信後の誘導文は禁止。
↔ 今回の差分：締め文として使った場面では削除された。
締め文としての「お気軽に〜」も禁止ですか？それとも一次返信の誘導文のみ禁止ですか？
・禁止の場面：〇〇のとき
・使ってよい場面：△△のとき
という形でルールの適用条件を定義してください。」

【悪い例（生成しない）】
「AIが送った文の何が問題でしたか？（なければ特になし）」
「① 新しいルールを採用 ② 既存ルールを維持 ③ 場面で使い分ける」
「どんな場面でこのルールを使いますか？」`;



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
  return `${markerPrefix ? `${markerPrefix}\n\n` : ""}竹内さん、2つのルールが矛盾しています。正しいルールを定義してください。

━━ 新しく学んだルール ━━
「${newRule.title}」（フェーズ: ${newRule.phase ?? "不明"} / 重要度: ${importanceText}）
適用 ${newRule.applyCount ?? 0}回 ／ 正解 ${newRule.correctCount ?? 0}回・誤答 ${newRule.wrongCount ?? 0}回

${newRule.content}

━━ 矛盾している既存ルール ━━
${existingRulesText || "（なし）"}

━━ 何が矛盾しているか ━━
${conflictReason}

❓ どちらが正しいか、または場面で使い分けるかを、以下の形で教えてください：
・新しいルールが正しい場合 → 既存ルールのどこを修正すべきか
・既存ルールが正しい場合 → 新しいルールのどこが誤っているか
・場面で使い分ける場合 → 「○○の場合は〜する / △△の場合は〜しない」という形でルールの適用条件を定義してください`;
}

// pending 上限を確認してから ai_feedback_items に起票する。
// 上限到達・INSERT失敗時は false を返す（呼び出し元はスキップとして扱う）。
export async function safeInsertAiQuestion(item: AiQuestionItem): Promise<boolean> {
  if (!(await canInsertAiQuestion())) {
    console.log(`[ai-feedback-guard] AI質問pending上限(${MAX_PENDING}件)到達、新規起票スキップ`);
    return false;
  }
  // ②-1: 同一 aix_action × category のpendingが2件以上あれば新規起票しない（ハードキャップ）
  const aixAction = item.aix_action?.trim() || null;
  const perActionCount = await countPendingForActionCategory(aixAction, item.category);
  if (perActionCount >= MAX_PENDING_PER_ACTION_CATEGORY) {
    console.log(`[ai-feedback-guard] aix_action=${aixAction ?? "(なし)"} × category=${item.category} のpendingが${perActionCount}件あるため新規起票スキップ`);
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
