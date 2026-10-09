// app/lib/feedback-auto-answer-server.ts — 待っている AI 質問を設計知見（竹内さんの決定 P0/P1）で自動で答える（サーバー専用・DeepSeek）
//   決まりは feedback-auto-answer.ts（純）。毎週の prompt-candidate-gen の最初に呼ぶ。戻す: FEEDBACK_AUTO_ANSWER=off
//   書くのは ai_feedback_items の status・user_answer・answered_at（自動の答え）と、aix_pattern の閉じ（expired・dismissed_reason）だけ。ルールは変えない。
import type { SupabaseClient } from "@supabase/supabase-js";
import { callDeepSeek } from "@/app/lib/vision-alt-provider";
import { altUsageUsd } from "@/app/lib/llm-price";
import { searchKb, loadRagRows } from "@/app/lib/design-knowledge-rag-server";
import { effectivePriority } from "@/app/lib/design-knowledge-priority";
import { maskForLlm } from "@/app/lib/design-knowledge-curation";
import { maskPersonalValues } from "@/app/lib/example-pii-guard";
import {
  feedbackAutoAnswerEnabled, pickAutoAnswerTargets, pickAixPatternToClose, questionQuery, autoAnswerPrompt, parseAutoAnswer, buildAutoAnswer,
  AUTO_ANSWER_SYSTEM, AUTO_ANSWER_STATUS, AIX_PATTERN_CLOSE_REASON, type PendingQuestion, type KbBasisRow,
} from "@/app/lib/feedback-auto-answer";

export type AutoAnswerSummary = { skipped?: string; targets: number; answered: number; notAnswerable: number; failed: number; closedAixPattern: number; calls: number; usd: number; dry: boolean; examples: Array<{ id: string; answer: string }> };

/** 申込フォーマットの本名・電話・メール・生年月日を伏せる（LINE の表示名・呼び名は渡して良い＝10/08 竹内さん） */
const mask = (s: string) => maskForLlm(maskPersonalValues(String(s ?? "")));

export async function runFeedbackAutoAnswer(sb: SupabaseClient, opts: { dry?: boolean; nowMs?: number; max?: number; maxExamples?: number } = {}): Promise<AutoAnswerSummary> {
  const dry = !!opts.dry;
  const nowMs = opts.nowMs ?? Date.now();
  const out: AutoAnswerSummary = { targets: 0, answered: 0, notAnswerable: 0, failed: 0, closedAixPattern: 0, calls: 0, usd: 0, dry, examples: [] };
  if (!feedbackAutoAnswerEnabled(process.env)) return { ...out, skipped: "FEEDBACK_AUTO_ANSWER=off" };
  const { data, error } = await sb.from("ai_feedback_items").select("id, question, category, created_at, entry_source, aix_action").eq("status", "pending").order("created_at").limit(1000);
  if (error) return { ...out, skipped: error.message };
  const pending = (data ?? []) as PendingQuestion[];

  // aix_pattern は aix-weekly-learning が自動で学ぶ → 7日たったら閉じる
  const closeIds = pickAixPatternToClose(pending, nowMs);
  if (closeIds.length && !dry) {
    const { error: e } = await sb.from("ai_feedback_items").update({ status: "expired", dismissed_reason: AIX_PATTERN_CLOSE_REASON }).in("id", closeIds).eq("status", "pending");
    if (!e) out.closedAixPattern = closeIds.length;
  } else out.closedAixPattern = closeIds.length;

  const targets = pickAutoAnswerTargets(pending, opts.max);
  out.targets = targets.length;
  if (!targets.length) return out;
  const rows = await loadRagRows(sb);
  const prio = new Map(rows.map((r) => [r.id, effectivePriority(r as Parameters<typeof effectivePriority>[0])]));
  const vecCache = new Map<string, Map<string, number>>();
  for (const q of targets) {
    try {
      const hits = await searchKb(sb, questionQuery(q.question), { k: 6, rows, vecCache });
      const basisRows: KbBasisRow[] = hits.map((h) => ({ id: h.row.id, title: h.row.title, insight: h.row.insight, priority: prio.get(h.row.id) ?? null }))
        .filter((r) => r.priority === 0 || r.priority === 1);
      if (!basisRows.length) { out.notAnswerable++; continue; }
      const res = await callDeepSeek(AUTO_ANSWER_SYSTEM, autoAnswerPrompt(q.question ?? "", basisRows, mask), { thinking: false, temperature: 0, maxTokens: 400, timeoutMs: 45_000 });
      out.calls++;
      if (!res) { out.failed++; continue; }
      out.usd += altUsageUsd({ model: res.model, input_uncached: res.usage.cacheMiss + res.usage.cacheHit > 0 ? res.usage.cacheMiss : res.usage.input, cache_read: res.usage.cacheHit, output_tokens: res.usage.output, created_at: new Date().toISOString() });
      const a = buildAutoAnswer(parseAutoAnswer(res.text), basisRows);
      if (!a) { out.notAnswerable++; continue; }
      if (out.examples.length < (opts.maxExamples ?? 5)) out.examples.push({ id: q.id, answer: `${(q.question ?? "").replace(/s+/g, " ").slice(0, 160)}
  → ${a.text.slice(0, 300)}` });
      if (dry) { out.answered++; continue; }
      const { error: e } = await sb.from("ai_feedback_items").update({ status: AUTO_ANSWER_STATUS, user_answer: a.text, answered_at: new Date(nowMs).toISOString() }).eq("id", q.id).eq("status", "pending");
      if (e) out.failed++; else out.answered++;
    } catch (e) {
      out.failed++;
      console.warn("[feedback-auto-answer]", q.id.slice(0, 8), e instanceof Error ? e.message : e);
    }
  }
  return out;
}
