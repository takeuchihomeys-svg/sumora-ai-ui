// app/lib/exam-savings-server.ts — exam_savings への書き込み・竹内さんへの質問（owner_questions）を足す（サーバーの鍵だけ・RLS 有効・ポリシーなし）
//   読み: 鍵の数だけ1回。書き: 鍵の数だけ（多くて十数行）。LLM なし・$0。止める EXAM_SAVINGS_LEDGER=off
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateSavingHits, examSavingsLedgerEnabled, mergeSavingRow, ownerQuestionFor, type AutoApplied, type SavingHit, type SavingRow } from "./exam-savings";

export const SAVING_COLS = "id, key, title, kind, detail, est_usd_per_day, evidence, status, safe, fix_ref, occurrences, first_seen, last_seen";

/**
 * 印を台帳に足す。mode=add（1回の試験＝今日の分に足す・onceLabel で同じ回は二重に足さない）／set（今日の全部を数え直した＝今日の分を上書き）
 *   新しく needs_owner になった行は竹内さんへの質問を1つ足す（dedupe_key exam-savings:<key>・同じ物は足さない）
 */
export async function upsertSavingHits(sb: SupabaseClient, hits: ReadonlyArray<SavingHit>, opts: { nowIso?: string; mode?: "add" | "set"; onceLabel?: string; env?: Record<string, string | undefined> } = {}): Promise<{ rows: number; questions: number; skipped?: string; written: SavingRow[] }> {
  const aggs = aggregateSavingHits(hits);
  if (!aggs.length) return { rows: 0, questions: 0, written: [] };
  if (!examSavingsLedgerEnabled(opts.env)) return { rows: 0, questions: 0, skipped: "EXAM_SAVINGS_LEDGER is off", written: [] };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const { data, error } = await sb.from("exam_savings").select(SAVING_COLS).in("key", aggs.map((a) => a.key));
  if (error) throw new Error(`exam_savings 読み: ${error.message}`);
  const existing = new Map(((data ?? []) as SavingRow[]).map((r) => [r.key, r]));
  const todo = opts.onceLabel ? aggs.filter((a) => !(existing.get(a.key)?.evidence?.run_labels ?? []).includes(opts.onceLabel!)) : aggs;
  if (!todo.length) return { rows: 0, questions: 0, skipped: `この回（${opts.onceLabel}）は足し済み`, written: [...existing.values()] };
  const rows = todo.map((a) => { const m = mergeSavingRow(existing.get(a.key) ?? null, a, nowIso, { mode: opts.mode ?? "add", label: opts.onceLabel }); delete m.id; return { ...m, updated_at: nowIso }; });
  const { data: out, error: e2 } = await sb.from("exam_savings").upsert(rows, { onConflict: "key" }).select(SAVING_COLS);
  if (e2) throw new Error(`exam_savings 書き: ${e2.message}`);
  const written = (out ?? []) as SavingRow[];
  const newOwner = written.filter((r) => r.status === "needs_owner" && existing.get(r.key)?.status !== "needs_owner");
  const questions = newOwner.length ? await addOwnerQuestions(sb, newOwner) : 0;
  return { rows: rows.length, questions, written };
}

/** needs_owner の行 → 竹内さんへの質問（同じ dedupe_key は足さない）。足した数 */
export async function addOwnerQuestions(sb: SupabaseClient, rows: ReadonlyArray<Pick<SavingRow, "key" | "title" | "detail" | "est_usd_per_day" | "kind">>): Promise<number> {
  if (!rows.length) return 0;
  const qs = rows.map(ownerQuestionFor);
  const { data, error } = await sb.from("owner_questions").upsert(qs, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(`owner_questions 書き: ${error.message}`);
  return (data ?? []).length;
}

/** 自動で戻したスイッチ → その鍵の行を auto_applied に（fix_ref にスイッチ）。行が無ければ何もしない */
export async function markAutoApplied(sb: SupabaseClient, auto: ReadonlyArray<AutoApplied>): Promise<number> {
  let n = 0;
  for (const a of auto) {
    const { data, error } = await sb.from("exam_savings").update({ status: "auto_applied", fix_ref: `自動: ${a.from} → ${a.value ?? "既定"}（${a.at.slice(0, 10)}）`, updated_at: new Date().toISOString() })
      .eq("key", a.key).in("status", ["open"]).select("key");
    if (error) throw new Error(`exam_savings 自動の印: ${error.message}`);
    n += (data ?? []).length;
  }
  return n;
}

/** 開いている案を $ の大きい順に */
export async function readOpenSavings(sb: SupabaseClient, limit = 50): Promise<SavingRow[]> {
  const { data, error } = await sb.from("exam_savings").select(SAVING_COLS).in("status", ["open", "needs_owner"]).order("est_usd_per_day", { ascending: false }).limit(limit);
  if (error) throw new Error(`exam_savings 読み: ${error.message}`);
  return (data ?? []) as SavingRow[];
}
