// app/lib/feedback-auto-answer.ts — AI 質問（ai_feedback_items）を竹内さんの決定（設計知見 P0/P1）で自動で答える決まり（純関数・DB/LLM なし）
//
// 2026-10-08 竹内さん「自動的にする」（学習の抜け: AI からの質問への回答が 8/12 から止まっている・pending 178）:
//   質問の答えは、今は Claude Code の会話で竹内さんが決めて設計知見（system_design_thinking）の P0/P1 に記録している。
//   → 毎週の prompt-candidate-gen の前に、待っている質問を設計知見で引き、決定がはっきり答えている物だけ自動で答える。
//     - 答えるのは knowledge_gap・prompt_ambiguity だけ（aix_boundary は人の答えが要る決まり・rule_review は統合の可否で設計知見では決まらない）
//     - 根拠は P0/P1 の行に限る（DeepSeek が挙げた根拠の id が引いた行の中の P0/P1 に無ければ答えない）。分からない物は答えない（推測で埋めない）
//     - 自動の答えは status='auto_answered'（人の答え 'applied' と分ける）。ルールを直接は変えない＝prompt-candidate-gen の候補（承認待ち）にだけ流れる
//   aix_pattern（「スタッフが繰り返し修正しているポイントを教えてください」）は aix-weekly-learning が編集差分から自動で学ぶので、7日たったら閉じる（expired・理由つき）。
//   戻す: FEEDBACK_AUTO_ANSWER=off
export function feedbackAutoAnswerEnabled(env: Record<string, string | undefined>): boolean {
  return (env.FEEDBACK_AUTO_ANSWER ?? "").trim().toLowerCase() !== "off";
}

export const AUTO_ANSWER_STATUS = "auto_answered";
export const AUTO_ANSWER_CATEGORIES = ["knowledge_gap", "prompt_ambiguity"] as const;
export const AUTO_ANSWER_MAX_PER_RUN = 20;
export const AIX_PATTERN_CLOSE_DAYS = 7;
export const AIX_PATTERN_CLOSE_REASON = "auto: AIX の編集差分は aix-weekly-learning が毎週自動で学ぶ（2026-10-08 竹内さん「自動的にする」）";

export type PendingQuestion = { id: string; question: string | null; category: string | null; created_at: string; entry_source?: string | null; aix_action?: string | null };

/** 自動で答える対象（古い順・上限まで） */
export function pickAutoAnswerTargets(rows: ReadonlyArray<PendingQuestion>, max = AUTO_ANSWER_MAX_PER_RUN): PendingQuestion[] {
  return rows.filter((r) => (AUTO_ANSWER_CATEGORIES as readonly string[]).includes(r.category ?? "") && (r.question ?? "").trim().length >= 10)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).slice(0, max);
}

/** 閉じてよい aix_pattern の質問（作ってから closeDays 日以上） */
export function pickAixPatternToClose(rows: ReadonlyArray<PendingQuestion>, nowMs: number, closeDays = AIX_PATTERN_CLOSE_DAYS): string[] {
  return rows.filter((r) => r.category === "aix_pattern" && nowMs - Date.parse(r.created_at) >= closeDays * 86_400_000).map((r) => r.id);
}

/** 設計知見を引く問い（質問の頭の札・区切り線を除いた最初の 300 字） */
export function questionQuery(question: string | null | undefined): string {
  return String(question ?? "")
    .replace(/^\[[^\]\n]{0,120}\]\s*/gm, "")
    .replace(/[━─]{2,}/g, " ")
    .replace(/❓|【[^】]{0,20}】/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}

export type KbBasisRow = { id: string; title: string; insight: string; priority: number | null };

export const AUTO_ANSWER_SYSTEM = "あなたは不動産の LINE 返信 AI の社内の質問係です。AI からの質問に、社長（竹内さん）が既に決めた設計メモ（決まり）だけを根拠に答えます。"
  + "決まりがはっきり答えている時だけ answerable=true。決まりに無い・決まりから推測が要る・食い違う時は answerable=false（推測で埋めない）。"
  + "answer は決まりの言い換えで 200 字以内・日本語。basis は根拠にした決まりの番号（[1] なら 1）。"
  + '形: {"answerable":true|false,"answer":"…","basis":[1,2]}';

/** DeepSeek への問い（質問と、引いた決まり）。mask は呼ぶ側の伏せ（申込フォーマットの本名・電話・メール） */
export function autoAnswerPrompt(question: string, rows: ReadonlyArray<KbBasisRow>, mask: (s: string) => string): string {
  const q = mask(question).slice(0, 1500);
  const kb = rows.map((r, i) => `[${i + 1}] （P${r.priority ?? "?"}）${mask(r.title).slice(0, 160)}\n${mask(r.insight).replace(/\s+/g, " ").slice(0, 500)}`).join("\n\n");
  return `■ AI からの質問\n${q}\n\n■ 竹内さんの決まり（設計メモ）\n${kb}`;
}

export type AutoAnswerVerdict = { answerable: boolean; answer: string; basis: number[] };
export function parseAutoAnswer(text: string | null | undefined): AutoAnswerVerdict | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { answerable?: unknown; answer?: unknown; basis?: unknown };
    if (typeof j.answerable !== "boolean") return null;
    const basis = Array.isArray(j.basis) ? j.basis.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1) : [];
    return { answerable: j.answerable, answer: typeof j.answer === "string" ? j.answer.trim().slice(0, 400) : "", basis };
  } catch { return null; }
}

/**
 * 自動の答えの文（user_answer に入れる）。根拠が P0/P1 の行に1つも無い・答えが空・answerable=false なら null（答えない）
 */
export function buildAutoAnswer(v: AutoAnswerVerdict | null, rows: ReadonlyArray<KbBasisRow>): { text: string; basisIds: string[] } | null {
  if (!v || !v.answerable || v.answer.length < 8) return null;
  const basis = [...new Set(v.basis)].map((n) => rows[n - 1]).filter((r): r is KbBasisRow => !!r && (r.priority === 0 || r.priority === 1));
  if (!basis.length) return null;
  const refs = basis.map((r) => `${r.id.slice(0, 8)}「${r.title.slice(0, 40)}」`).join("・");
  return { text: `【自動回答・竹内さんの決定（設計知見）から】${v.answer}\n根拠: ${refs}`, basisIds: basis.map((r) => r.id) };
}
