// scripts/lib/brain-self-review-db.ts — ブレインの自己点検の結果を表に書く（朝の報告 /api/cron/morning-report が読む）
//
// 2026-10-18 竹内さん 10/18 OK「毎晩の自己点検を朝の報告に載せる」: 本番の cron は手元のファイル（morning-line.txt）を読めない
//   → self-review が表に書き、朝の報告が表を読む。表は scripts/brain-self-review-migration.sql（親が流す・このファイルは作らない）。
//   表が無い間は書かずに進む（手元のファイルだけ）。止める BRAIN_SELF_REVIEW_DB=off。
// 個人情報: 原因の名前・案・直す所・問題の id・竹内さんに聞く事（伏せた材料からの説明）だけ。お客様の発言・会話 id は書かない。
import type { SupabaseClient } from "@supabase/supabase-js";
import { causeCore, type Bundle, type CaseResult } from "./brain-self-review";

const cut = (s: unknown, n: number) => [...String(s ?? "").replace(/\s+/g, " ").trim()].slice(0, n).join("");

export function selfReviewDbEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BRAIN_SELF_REVIEW_DB ?? "").trim().toLowerCase() !== "off";
}

/** 同じ原因を1行にする鍵（直しの種類|外れの場所|原因の芯・120字まで） */
export function bundleKeyOf(b: Pick<Bundle, "kind" | "where" | "causeKeys">): string {
  return cut(`${b.kind}|${b.where}|${causeCore(b.causeKeys[0] ?? "")}`, 120);
}

export type RunRow = {
  day: string; morning_line: string; explained: number; proposals: number; ask_count: number;
  questions: string[]; top_cause: string | null; usd: number; updated_at: string;
};
/** 1日1行（同じ日はその日の全部の説明から作り直す＝何回流しても同じ） */
export function runRowOf(o: { day: string; line: string; results: ReadonlyArray<CaseResult>; bundles: ReadonlyArray<Bundle>; usd: number; now?: Date }): RunRow {
  const ask = o.bundles.filter((b) => b.needsTakeuchi);
  const top = o.bundles.filter((b) => !b.needsTakeuchi)[0];
  return {
    day: o.day,
    morning_line: cut(o.line, 300),
    explained: o.results.length,
    proposals: o.bundles.length,
    ask_count: ask.length,
    questions: [...new Set(ask.flatMap((b) => b.questions))].slice(0, 5).map((q) => cut(q, 200)),
    top_cause: top ? cut(`${top.causeKeys[0]}→${top.kind}（${top.n}件）`, 120) : null,
    usd: Math.round(o.usd * 10000) / 10000,
    updated_at: (o.now ?? new Date()).toISOString(),
  };
}

export type ProposalRow = {
  bundle_key: string; fix_kind: string; where_failed: string; cause_keys: string[]; plans: string[]; targets: string[];
  problem_ids: string[]; kb_ids: string[]; needs_takeuchi: boolean; questions: string[]; n: number; day_counts: Record<string, number>;
  first_seen: string; last_seen: string; updated_at: string;
};
type Existing = Pick<ProposalRow, "bundle_key" | "cause_keys" | "plans" | "targets" | "problem_ids" | "kb_ids" | "questions" | "day_counts" | "first_seen">;
const uniq = (xs: ReadonlyArray<string>, max: number, n = 120) => [...new Set(xs.map((x) => cut(x, n)).filter(Boolean))].slice(0, max);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * 束 → 表の行。前の行があれば足す（原因・案・問題は和・数は日ごとの数の和＝同じ日を流し直しても二重に数えない）。
 *   status・decision（竹内さんの決定）は書かない＝前の行のまま
 */
export function proposalRowOf(b: Bundle, day: string, prev: Existing | null, now = new Date()): ProposalRow {
  const day_counts = { ...(prev?.day_counts ?? {}), [day]: b.n };
  return {
    bundle_key: bundleKeyOf(b),
    fix_kind: b.kind,
    where_failed: b.where,
    cause_keys: uniq([...(prev?.cause_keys ?? []), ...b.causeKeys], 8, 20),
    plans: uniq([...b.plans, ...(prev?.plans ?? [])], 5, 300),
    targets: uniq([...(prev?.targets ?? []), ...b.targets], 8),
    problem_ids: uniq([...(prev?.problem_ids ?? []), ...b.ids], 30, 60),
    kb_ids: uniq([...(prev?.kb_ids ?? []), ...b.kb.map((k) => k.id)].filter((x) => UUID_RE.test(x)), 10, 36),
    needs_takeuchi: b.needsTakeuchi,
    questions: uniq([...(prev?.questions ?? []), ...b.questions], 5, 200),
    n: Math.max(1, Object.values(day_counts).reduce((a, x) => a + (Number(x) || 0), 0)),
    day_counts,
    first_seen: prev?.first_seen ?? day,
    last_seen: day,
    updated_at: now.toISOString(),
  };
}

const NO_TABLE = (e: { code?: string; message?: string } | null) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|Could not find the table/i.test(e.message ?? ""));

/** 表に書く（表が無い・止めている時は書かない）。失敗しても自己点検は止めない＝結果を返すだけ */
export async function writeSelfReviewToDb(sb: SupabaseClient, o: { day: string; line: string; results: ReadonlyArray<CaseResult>; bundles: ReadonlyArray<Bundle>; usd: number }): Promise<{ ok: boolean; reason?: string; proposals?: number }> {
  if (!selfReviewDbEnabled()) return { ok: false, reason: "BRAIN_SELF_REVIEW_DB=off" };
  const run = runRowOf(o);
  const r1 = await sb.from("brain_self_review_runs").upsert(run, { onConflict: "day" });
  if (r1.error) return { ok: false, reason: NO_TABLE(r1.error) ? "表がまだ無い（scripts/brain-self-review-migration.sql を流すと書く）" : `runs: ${r1.error.message}` };
  if (!o.bundles.length) return { ok: true, proposals: 0 };
  const keys = o.bundles.map(bundleKeyOf);
  const { data: prevRows, error: e2 } = await sb.from("brain_self_review_proposals")
    .select("bundle_key, cause_keys, plans, targets, problem_ids, kb_ids, questions, day_counts, first_seen").in("bundle_key", keys);
  if (e2) return { ok: false, reason: NO_TABLE(e2) ? "表がまだ無い（proposals）" : `proposals: ${e2.message}` };
  const prev = new Map(((prevRows ?? []) as Existing[]).map((r) => [r.bundle_key, r]));
  // 同じ鍵に束が2つ来たら1つに（数は足す）
  const merged = new Map<string, ProposalRow>();
  for (const b of o.bundles) {
    const k = bundleKeyOf(b);
    const row = proposalRowOf(b, o.day, prev.get(k) ?? null);
    const m = merged.get(k);
    if (m) { m.day_counts[o.day] = (m.day_counts[o.day] ?? 0) + b.n; m.n += b.n; m.problem_ids = uniq([...m.problem_ids, ...row.problem_ids], 30, 60); }
    else merged.set(k, row);
  }
  const r3 = await sb.from("brain_self_review_proposals").upsert([...merged.values()], { onConflict: "bundle_key" });
  if (r3.error) return { ok: false, reason: `proposals upsert: ${r3.error.message}` };
  return { ok: true, proposals: merged.size };
}
