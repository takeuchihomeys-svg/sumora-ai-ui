// app/lib/learn-supervisor-DB.ts
//
// 2026-11-14 竹内さん「統括はデータベース必要なら強化や追加できるようにしていく」
//
// 統括の判断を **1回ごとに1行** 残す（`learn_supervisor_log`）。
//   ⚠ 今までは `human_learn_profile.bundle`（JSONB）の中にしかなく、
//     **前回と比べる・推移を見る・打ち合わせで使う**ができなかった。
//   ⚠ 入れるのは**数と判断だけ**（入力した中身・お客様の名前・電話・住所は入れない）。
import { supabase } from "./supabase-server";
import type { SupervisorAdvice } from "./learn-supervisor";

export type SupervisorSnapshot = {
  scope: string;
  verdict: string;
  headline: string;
  coverage: number;
  weak_n: number;
  next_n: number;
  points_n: number;
  opens_n: number;
  screens_n: number;
  sequence_n: number;
  with_ops: number;
  guessed_opens: number;
  rows: number;
  block: string | null;
};

/** 保存する形に整える（純関数・DBに触らない） */
export function toLogRow(
  scope: string,
  adv: SupervisorAdvice,
  extra: { next_n?: number; points_n?: number; opens_n?: number; screens_n?: number; sequence_n?: number; with_ops?: number; guessed_opens?: number; rows?: number; bundle_at?: string | null },
): SupervisorSnapshot & { delta: unknown; actions: unknown; meeting: unknown; bundle_at: string | null } {
  const a = adv || ({} as SupervisorAdvice);
  return {
    scope: String(scope || "all").slice(0, 20),
    verdict: String(a.verdict || "not_yet").slice(0, 12),
    headline: String(a.headline || "").slice(0, 200),
    coverage: Math.max(0, Math.min(100, Number(a.score?.coverage) || 0)),
    weak_n: Math.max(0, Number(a.score?.weak) || 0),
    next_n: Math.max(0, Number(extra.next_n) || 0),
    points_n: Math.max(0, Number(extra.points_n) || 0),
    opens_n: Math.max(0, Number(extra.opens_n) || 0),
    screens_n: Math.max(0, Number(extra.screens_n) || 0),
    sequence_n: Math.max(0, Number(extra.sequence_n) || 0),
    with_ops: Math.max(0, Number(extra.with_ops) || 0),
    guessed_opens: Math.max(0, Number(extra.guessed_opens) || 0),
    rows: Math.max(0, Number(extra.rows) || 0),
    block: a.block ? String(a.block).slice(0, 300) : null,
    delta: a.score?.delta ?? null,
    actions: Array.isArray(a.actions) ? a.actions.slice(0, 8) : [],
    meeting: a.meeting ?? null,
    bundle_at: extra.bundle_at ?? null,
  };
}

/**
 * 1行足す。
 *   ⚠ 同じ束（`bundle_at`）の同じ scope が既にあれば足さない（二重に数えない）。
 *   ⚠ 表がまだ無いDBでは**黙って諦める**（学習そのものを止めない）。
 */
export async function saveSupervisorLog(
  scope: string,
  adv: SupervisorAdvice,
  extra: Parameters<typeof toLogRow>[2],
): Promise<{ ok: boolean; skipped?: string; error?: string; updated?: boolean }> {
  try {
    const row = toLogRow(scope, adv, extra);
    /**
     * ★ 2026-11-17 統括Proを全体脳に: 同じ束でも Pro 根拠が新しい時は上書きする。
     *   旧は same_bundle で捨て → learn_supervisor_log に Pro が残らず脳が薄くなる。
     */
    const proLabels = (ev: Array<{ label?: string }>) =>
      ev.filter((e) => /統括Pro|足りない土台|土台を作る次手|統括Pro RAG|統括Pro把握|統括Pro手配/.test(String(e.label || "")));
    const hasRag = (ev: Array<{ label?: string }>) =>
      ev.some((e) => /統括Pro RAG|統括Pro把握/.test(String(e.label || "")));
    const rowEv = Array.isArray((row.meeting as { evidence?: Array<{ label?: string }> } | null)?.evidence)
      ? (row.meeting as { evidence: Array<{ label?: string }> }).evidence
      : [];
    const hasPro = proLabels(rowEv).length > 0;
    if (row.bundle_at) {
      const dup = await supabase
        .from("learn_supervisor_log")
        .select("id,meeting")
        .eq("scope", row.scope)
        .eq("bundle_at", row.bundle_at)
        .limit(1);
      if (!dup.error && Array.isArray(dup.data) && dup.data.length) {
        const oldEv = Array.isArray((dup.data[0].meeting as { evidence?: Array<{ label?: string }> } | null)?.evidence)
          ? (dup.data[0].meeting as { evidence: Array<{ label?: string }> }).evidence
          : [];
        const oldHasPro = proLabels(oldEv).length > 0;
        // ★ RAG/手配が新規なら同束でも更新（脳を薄くしない）
        const richer = hasPro && (!oldHasPro || (hasRag(rowEv) && !hasRag(oldEv)));
        if (richer) {
          const upd = await supabase
            .from("learn_supervisor_log")
            .update({
              meeting: row.meeting,
              actions: row.actions,
              headline: row.headline,
              verdict: row.verdict,
              coverage: row.coverage,
              weak_n: row.weak_n,
              block: row.block,
            })
            .eq("id", dup.data[0].id);
          if (upd.error) return { ok: false, error: String(upd.error.message).slice(0, 200) };
          return { ok: true, updated: true };
        }
        return { ok: true, skipped: "same_bundle" };
      }
    }
    const ins = await supabase.from("learn_supervisor_log").insert(row as unknown as Record<string, unknown>);
    if (ins.error) {
      const missing = /does not exist|42P01|Could not find the table|schema cache/i.test(String(ins.error.message || ""));
      if (missing) return { ok: false, skipped: "no_table", error: String(ins.error.message).slice(0, 200) };
      return { ok: false, error: String(ins.error.message).slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && (e as Error).message) || e).slice(0, 200) };
  }
}

/** 直近の判断（推移を見る・打ち合わせで使う） */
export async function recentSupervisorLogs(scope: string, limit = 30) {
  const q = supabase
    .from("learn_supervisor_log")
    .select("created_at, scope, verdict, headline, coverage, weak_n, next_n, points_n, opens_n, screens_n, sequence_n, with_ops, guessed_opens, rows, delta, actions, meeting, block, bundle_at")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));
  const r = scope && scope !== "all" ? await q.eq("scope", scope) : await q;
  if (r.error) return { rows: [], error: String(r.error.message).slice(0, 200) };
  return { rows: (r.data ?? []) as Array<Record<string, unknown>>, error: null };
}
