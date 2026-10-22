// app/lib/owner-questions.ts — 竹内さんへの質問の台帳（owner_questions）の形と並べ方（純関数・DB も LLM も持たない）
//
// 2026-10-22 竹内さんの決定（設計知見 395e0064）: 確認事項は全部まとめて聞く。台帳の行は
//   kind=question（普通の質問・推奨の答えを1つ添える）／gold（この場面の正解はどれ？・試験の問題 id か見張りの番 id）／
//   judge_check（AI の判定 line_watch_turns.verdict と竹内さんの判断の比べ）。
//   答えたら scripts/owner-questions.ts --answer が状態を answered にして設計知見（P1・札 竹内さんの決定）を作る。
export type OwnerQuestionKind = "question" | "gold" | "judge_check";
export type OwnerQuestionStatus = "open" | "answered" | "obsolete";
export type OwnerQuestion = {
  id: string; kind: OwnerQuestionKind; topic: string; question: string; options: unknown; recommended: string | null; why: string | null;
  source_kind: string | null; source_ref: string | null; status: OwnerQuestionStatus; answer: string | null; answered_at: string | null;
  kb_id: string | null; priority: number; created_at: string; dedupe_key?: string | null;
  ref_exam_qid?: string | null; ref_watch_turn_id?: number | null; ai_verdict?: string | null; owner_verdict?: string | null;
};

/** 話題の並び（先に出す物から）。無い話題は後ろに名前順 */
export const TOPIC_ORDER = ["用意してもらう物", "ブレインの判断", "やることリスト", "申込歴・2番手", "試験・見張り", "費用", "管理ツール連携", "その他"];

export function optionsOf(q: Pick<OwnerQuestion, "options">): string[] {
  return Array.isArray(q.options) ? (q.options as unknown[]).map((o) => String(o)).filter(Boolean) : [];
}

/** 未回答の普通の質問を話題ごとに（優先度→作った順）並べる */
export function groupOpenQuestions(rows: ReadonlyArray<OwnerQuestion>): Array<{ topic: string; items: OwnerQuestion[] }> {
  const open = rows.filter((r) => r.status === "open" && r.kind === "question");
  const m = new Map<string, OwnerQuestion[]>();
  for (const r of open) m.set(r.topic, [...(m.get(r.topic) ?? []), r]);
  const rank = (t: string) => { const i = TOPIC_ORDER.indexOf(t); return i < 0 ? TOPIC_ORDER.length : i; };
  return [...m.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], "ja"))
    .map(([topic, items]) => ({ topic, items: [...items].sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at)) }));
}

/** 竹内さんに見せる文（番号つき・推奨つき）。gold・judge_check は数だけ */
export function renderOpenQuestions(rows: ReadonlyArray<OwnerQuestion>): string {
  const groups = groupOpenQuestions(rows);
  const lines: string[] = [];
  let n = 0;
  for (const g of groups) {
    lines.push(`■ ${g.topic}`);
    for (const q of g.items) {
      n++;
      lines.push(`${n}. ${q.question}`);
      const opts = optionsOf(q);
      if (opts.length) lines.push(`   選択: ${opts.join(" ／ ")}`);
      if (q.recommended) lines.push(`   → オススメ: ${q.recommended}${q.why ? `（${q.why}）` : ""}`);
      lines.push(`   [id ${q.id.slice(0, 8)}]`);
    }
    lines.push("");
  }
  if (!n) lines.push("未回答の質問はありません。");
  const gold = rows.filter((r) => r.status === "open" && r.kind === "gold").length;
  const judge = rows.filter((r) => r.status === "open" && r.kind === "judge_check").length;
  lines.push(`ほかに: 正解を決めてもらう番（gold）${gold}件・AI の判定の比べ（judge_check）${judge}件が用意できています（scripts/owner-questions.ts --gold / --judge で一覧）。`);
  return lines.join("\n");
}

/** --answer で作る設計知見の行（category architecture・P1・札 竹内さんの決定） */
export function kbRowForAnswer(q: Pick<OwnerQuestion, "id" | "topic" | "question" | "recommended" | "why" | "source_ref" | "kind">, answer: string, todayIso: string): Record<string, unknown> {
  const t = Date.parse(todayIso);
  const day = Number.isFinite(t) ? new Date(t + 9 * 3_600_000).toISOString().slice(0, 10) : todayIso.slice(0, 10); // 日本の日付（日本の朝9時前は UTC では前の日になるため）
  const shortQ = q.question.replace(/\s+/g, " ").slice(0, 70);
  return {
    title: `【決定】${shortQ} → ${answer.replace(/\s+/g, " ").slice(0, 60)}`,
    category: "architecture",
    insight: `竹内さん ${day} の答え（質問の台帳 owner_questions ${q.id.slice(0, 8)}・話題「${q.topic}」）。問い: ${q.question} 答え: ${answer}`,
    rationale: q.why ? `質問の時の推奨: ${q.recommended ?? "なし"}（${q.why}）` : `質問の時の推奨: ${q.recommended ?? "なし"}`,
    context: q.source_ref ? `出どころ: ${q.source_ref}` : null,
    applied_to: "sumora-ai-ui（ブレイン・設計知見）",
    tags: ["竹内さんの決定", "質問の台帳", q.topic],
    priority: 1,
  };
}

/** 見張りの番の AI の判定（same/partial/different）の日本語 */
export const VERDICT_JA: Record<string, string> = { same: "同じ", partial: "一部同じ", different: "違う" };
