// app/lib/brain-weaknesses-server.ts — brain_weaknesses への書き込み（サーバーの鍵だけ・RLS 有効・ポリシーなしの表）
//   読み: 鍵の数だけ1回。書き: 鍵の数だけ（多くて数十行）。LLM なし・$0。止める BRAIN_WEAKNESS_LEDGER=off
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateWeaknessHits, brainWeaknessLedgerEnabled, mergeWeaknessRow, renderTouchedWeaknesses, type WeaknessHit, type WeaknessRow } from "./brain-weaknesses";

const COLS = "id, key, title, area, symptom, root_cause, status, fix_ref, evidence, occurrences, first_seen, last_seen";

/** 印を台帳に足す（読んでから足して書く＝cron と手の実行・試験だけが書く前提）。同じ回（exam_labels に label がある鍵）は二重に足さない */
export async function upsertWeaknessHits(sb: SupabaseClient, hits: ReadonlyArray<WeaknessHit>, opts: { nowIso?: string; onceLabel?: string; env?: Record<string, string | undefined> } = {}): Promise<{ rows: number; hits: number; skipped?: string; touched: WeaknessRow[]; nThisRun: Record<string, number> }> {
  const aggs = aggregateWeaknessHits(hits);
  const nThisRun: Record<string, number> = Object.fromEntries(aggs.map((a) => [a.key, a.n ?? 1]));
  if (!aggs.length) return { rows: 0, hits: 0, touched: [], nThisRun };
  if (!brainWeaknessLedgerEnabled(opts.env)) return { rows: 0, hits: 0, skipped: "BRAIN_WEAKNESS_LEDGER is off", touched: [], nThisRun };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const { data, error } = await sb.from("brain_weaknesses").select(COLS).in("key", aggs.map((a) => a.key));
  if (error) throw new Error(`brain_weaknesses 読み: ${error.message}`);
  const existing = new Map(((data ?? []) as WeaknessRow[]).map((r) => [r.key, r]));
  const todo = opts.onceLabel ? aggs.filter((a) => !(existing.get(a.key)?.evidence?.exam_labels ?? []).includes(opts.onceLabel!)) : aggs;
  if (!todo.length) return { rows: 0, hits: 0, skipped: `この回（${opts.onceLabel}）は足し済み`, touched: [...existing.values()], nThisRun };
  const rows = todo.map((a) => { const m = mergeWeaknessRow(existing.get(a.key) ?? null, a, nowIso); delete m.id; return { ...m, updated_at: nowIso }; });
  const { data: out, error: e2 } = await sb.from("brain_weaknesses").upsert(rows, { onConflict: "key" }).select(COLS);
  if (e2) throw new Error(`brain_weaknesses 書き: ${e2.message}`);
  const written = new Map(((out ?? []) as WeaknessRow[]).map((r) => [r.key, r]));
  const touched = aggs.map((a) => written.get(a.key) ?? existing.get(a.key)).filter((r): r is WeaknessRow => !!r);
  return { rows: rows.length, hits: todo.reduce((s, a) => s + (a.n ?? 1), 0), touched, nThisRun };
}

/** 試験のまとめから呼ぶ: 足して、この回で触った弱い所を文にして返す（失敗しても試験は止めない） */
export async function recordExamWeaknesses(sb: SupabaseClient, label: string, hits: ReadonlyArray<WeaknessHit>, opts: { dry?: boolean } = {}): Promise<string> {
  if (!hits.length) return "弱い所の台帳: この回の外れなし";
  try {
    if (opts.dry || !brainWeaknessLedgerEnabled()) {
      const keys = aggregateWeaknessHits(hits).map((a) => `${a.key} ${a.n}`).join("・");
      return `弱い所の台帳（${opts.dry ? "下見" : "BRAIN_WEAKNESS_LEDGER=off"}・書いていない）: ${keys}`;
    }
    const r = await upsertWeaknessHits(sb, hits, { onceLabel: label });
    return `${renderTouchedWeaknesses(r.touched, r.nThisRun)}${r.skipped ? `（${r.skipped}）` : `（台帳に ${r.rows}行・${r.hits}件 足した）`}`;
  } catch (e) {
    return `弱い所の台帳に書けない: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`;
  }
}
