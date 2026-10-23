// app/lib/brain-unknowns-server.ts — brain_unknowns への書き込み（サーバーの鍵だけ・RLS 有効の表）
//   読み: line_watch_turns の窓の分（最終チェックの結果と下書き）を1回。書き: 型×鍵の数だけ（多くて数十行）。LLM なし・$0。
import type { SupabaseClient } from "@supabase/supabase-js";
import { weaknessHitsFromUnknownAggs } from "./brain-weaknesses";
import { upsertWeaknessHits } from "./brain-weaknesses-server";
import { aggregateUnknowns, mergeUnknownRow, unknownsFromTurn, type UnknownAgg, type UnknownHit, type WatchTurnRow } from "./brain-unknowns";

/** 見張りの番（最終チェックが窓の中に入った物）から拾う */
export async function loadTurnUnknowns(sb: SupabaseClient, fromIso: string, toIso: string): Promise<UnknownHit[]> {
  const hits: UnknownHit[] = [];
  const PAGE = 500;
  for (let off = 0; off < 10_000; off += PAGE) {
    const { data, error } = await sb.from("line_watch_turns")
      .select("id, conversation_id, customer_turn_at, final_check, draft_last")
      .gte("final_check_at", fromIso).lt("final_check_at", toIso)
      .order("id", { ascending: true }).range(off, off + PAGE - 1);
    if (error) throw new Error(`line_watch_turns: ${error.message}`);
    const rows = (data ?? []) as WatchTurnRow[];
    for (const r of rows) hits.push(...unknownsFromTurn(r));
    if (rows.length < PAGE) break;
  }
  return hits;
}

/** まとめた数を brain_unknowns に足す（読んでから足して書く＝1日1回の cron と手の実行だけが書く前提）。行の id を返す（弱い所の台帳の印に使う） */
export async function upsertUnknowns(sb: SupabaseClient, aggs: ReadonlyArray<UnknownAgg>, nowIso: string = new Date().toISOString()): Promise<{ rows: number; hits: number; idOf: (kind: string, key: string) => number | undefined }> {
  if (!aggs.length) return { rows: 0, hits: 0, idOf: () => undefined };
  const kinds = [...new Set(aggs.map((a) => a.kind))];
  const { data, error } = await sb.from("brain_unknowns").select("kind, key, count, sample_ref, first_at, last_at").in("kind", kinds)
    .in("key", [...new Set(aggs.map((a) => a.key))]); // 鍵でも絞る（行が1000を超えても読み漏らして数を0から数え直さない）
  if (error) throw new Error(`brain_unknowns 読み: ${error.message}`);
  const existing = new Map(((data ?? []) as Array<{ kind: string; key: string; count: number; sample_ref: unknown; first_at: string; last_at: string }>).map((r) => [`${r.kind}\u0000${r.key}`, r]));
  const rows = aggs.map((a) => ({ kind: a.kind, key: a.key, label: a.label, ...mergeUnknownRow(existing.get(`${a.kind}\u0000${a.key}`) ?? null, a, nowIso) }));
  const { data: written, error: e2 } = await sb.from("brain_unknowns").upsert(rows, { onConflict: "kind,key" }).select("id, kind, key");
  if (e2) throw new Error(`brain_unknowns 書き: ${e2.message}`);
  const ids = new Map(((written ?? []) as Array<{ id: number; kind: string; key: string }>).map((r) => [`${r.kind}\u0000${r.key}`, Number(r.id)]));
  return { rows: rows.length, hits: aggs.reduce((s, a) => s + a.n, 0), idOf: (kind, key) => ids.get(`${kind}\u0000${key}`) };
}

/** 毎晩の集め（link-brain-watch から呼ぶ）: 見張りの番＋つなぎの切れ。
 *  2026-10-23: 同じまとめを型ごとに弱い所の台帳（brain_weaknesses）へ寄せる（決まった計算・LLM なし・止める BRAIN_WEAKNESS_LEDGER=off・失敗しても集めは止めない） */
export async function collectBrainUnknowns(sb: SupabaseClient, fromIso: string, toIso: string, extra: ReadonlyArray<UnknownHit> = []): Promise<{ rows: number; hits: number; byKind: Record<string, number>; weaknesses?: { rows: number; hits: number; skipped?: string } | { error: string } }> {
  const hits = [...(await loadTurnUnknowns(sb, fromIso, toIso)), ...extra];
  const aggs = aggregateUnknowns(hits);
  const { idOf, ...r } = await upsertUnknowns(sb, aggs);
  const byKind: Record<string, number> = {};
  for (const h of hits) byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
  let weaknesses: { rows: number; hits: number; skipped?: string } | { error: string } | undefined;
  try {
    const w = await upsertWeaknessHits(sb, weaknessHitsFromUnknownAggs(aggs, idOf));
    weaknesses = { rows: w.rows, hits: w.hits, ...(w.skipped ? { skipped: w.skipped } : {}) };
  } catch (e) { weaknesses = { error: e instanceof Error ? e.message : String(e) }; }
  return { ...r, byKind, weaknesses };
}
