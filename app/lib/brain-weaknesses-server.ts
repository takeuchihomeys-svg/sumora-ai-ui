// app/lib/brain-weaknesses-server.ts — brain_weaknesses への書き込み（サーバーの鍵だけ・RLS 有効・ポリシーなしの表）
//   読み: 鍵の数だけ1回。書き: 鍵の数だけ（多くて数十行）。LLM なし・$0。止める BRAIN_WEAKNESS_LEDGER=off
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateWeaknessHits, brainWeaknessLedgerEnabled, mergeWeaknessRow, renderTouchedWeaknesses, type WeaknessHit, type WeaknessRow } from "./brain-weaknesses";

const COLS = "id, key, title, area, symptom, root_cause, status, fix_ref, evidence, occurrences, first_seen, last_seen";

/** 印を台帳に足す（読んでから足して書く＝cron と手の実行・試験だけが書く前提）。同じ回（exam_labels に label がある鍵）は二重に足さない */
export async function upsertWeaknessHits(sb: SupabaseClient, hits: ReadonlyArray<WeaknessHit>, opts: { nowIso?: string; onceLabel?: string; env?: Record<string, string | undefined> } = {}): Promise<{ rows: number; hits: number; skipped?: string; touched: WeaknessRow[]; nThisRun: Record<string, number>; reopened?: string[] }> {
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
  // 直した行に当たって open に戻した key（mergeWeaknessRow が status と evidence.reopened を付ける）
  const reopened = todo.filter((a) => existing.get(a.key)?.status === "fixed").map((a) => a.key);
  return { rows: rows.length, hits: todo.reduce((s, a) => s + (a.n ?? 1), 0), touched, nThisRun, reopened };
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
    return `${renderTouchedWeaknesses(r.touched, r.nThisRun, new Set(r.reopened ?? []))}${r.skipped ? `（${r.skipped}）` : `（台帳に ${r.rows}行・${r.hits}件 足した）`}`;
  } catch (e) {
    return `弱い所の台帳に書けない: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`;
  }
}

/**
 * ★ 2026-11-15 竹内さん「バグあったらちゃんとそこもちゃんと記憶して改善するように
 *   統括の土台も強化していくようにする。学習したら強化する形」
 *
 *   **写真読み取りの失敗を台帳に残す**。
 *   ⚠ 今までは `why`（読めなかった理由）を**その場のログに出すだけ**だったので、
 *     「46枚読めなかった」のような事実が**どこにも残らず**、統括は次の日も同じことを言っていた。
 *   → 理由ごとに1行（`learn:photo:<理由の種類>`）。回数が増えるほど「一番よく起きる失敗」が分かる。
 *   ⚠ 入れるのは**理由の種類と回数だけ**（写真の置き場所・お客様の情報は入れない）。
 */
export async function recordPhotoLearnWeaknesses(
  sb: SupabaseClient,
  results: ReadonlyArray<{ ok: boolean; why: string | null; shot_w: number }>,
  opts: { nowIso?: string; label?: string } = {},
): Promise<{ rows: number; hits: number; skipped?: string; summary: string }> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  if (!results.length) return { rows: 0, hits: 0, summary: "写真の読み取り: 対象なし" };
  // 理由を「種類」に丸める（数字や時刻を落として数えられるように）
  const kindOf = (why: string | null): string => {
    const w = String(why ?? "").trim();
    if (!w) return "nothing";
    if (w.startsWith("deepseek_empty")) return w.includes("length") ? "max_tokens不足" : "答えが空";
    if (w.startsWith("deepseek_http_")) return "APIエラー(" + w.replace(/[^0-9]/g, "").slice(0, 3) + ")";
    if (w.startsWith("no_fields")) return "欄が見つからない";
    if (w.startsWith("signed_url_failed")) return "写真を取れない";
    if (w.startsWith("no_api_key")) return "キーが無い";
    if (w.startsWith("exception")) return "例外";
    return w.split(":")[0].slice(0, 20);
  };
  const acc = new Map<string, { n: number; sizes: Set<number> }>();
  for (const r of results) {
    if (r.ok) continue;
    const k = kindOf(r.why);
    const cur = acc.get(k) || { n: 0, sizes: new Set<number>() };
    cur.n++;
    cur.sizes.add(Math.round(r.shot_w / 100) * 100);
    acc.set(k, cur);
  }
  const okN = results.filter((r) => r.ok).length;
  const failN = results.length - okN;
  if (!failN) return { rows: 0, hits: 0, summary: `写真の読み取り: ${okN}枚すべて読めた` };
  const hits: WeaknessHit[] = [...acc.entries()].map(([k, v]) => ({
    key: `learn:photo:${k}`.slice(0, 80),
    title: `写真から読めない（${k}）`,
    area: "learn" as const,
    symptom: `${v.n}枚が読めなかった（大きさ ${[...v.sizes].join("/")}px）`,
    n: v.n,
    evidence: {},
  }));
  try {
    if (!brainWeaknessLedgerEnabled()) return { rows: 0, hits: failN, skipped: "BRAIN_WEAKNESS_LEDGER is off", summary: `写真の読み取り: ${okN}枚読めた・${failN}枚読めず（台帳は off）` };
    const r = await upsertWeaknessHits(sb, hits, { nowIso, ...(opts.label ? { onceLabel: opts.label } : {}) });
    const top = [...acc.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    return {
      rows: r.rows, hits: r.hits, skipped: r.skipped,
      summary: `写真の読み取り: ${okN}枚読めた・${failN}枚読めず（一番多い理由: ${top ? top[0] + " " + top[1].n + "枚" : "－"}）`,
    };
  } catch (e) {
    return { rows: 0, hits: failN, summary: `写真の読み取り: ${okN}枚読めた・${failN}枚読めず（台帳に書けない: ${String(e instanceof Error ? e.message : e).slice(0, 100)}）` };
  }
}
