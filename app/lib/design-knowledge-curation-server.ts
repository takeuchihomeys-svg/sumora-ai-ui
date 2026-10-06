// app/lib/design-knowledge-curation-server.ts — 設計知見の整理を DB に当てる（読む・退役・まとめを残す）
//   決まりは design-knowledge-curation.ts（純）。ここは読み書きと DeepSeek の呼び出しだけ。
//   退役は消さない: is_current=false・retired_reason・superseded_by・retired_at・retired_by を書く（migrate-schema に列）
//   まとめ（分野ごと）と要確認の一覧は design_rules_digest（1分野1行）に置く。手元では scripts/kb-digest.ts が memory/rules_digest_<分野>.md に写す
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AREAS, buildDigest, findDecisionConflicts, findDuplicates, parseSimilar, similarPairs, similarPrompt, SIMILAR_SYSTEM,
  type KbRow, type RetirePlan, type ReviewItem,
} from "@/app/lib/design-knowledge-curation";
import { callDeepSeek } from "@/app/lib/vision-alt-provider";

export async function loadKbRows(sb: SupabaseClient): Promise<KbRow[]> {
  const all: KbRow[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("system_design_thinking")
      .select("id, title, category, insight, rationale, context, applied_to, tags, is_current, created_at")
      .order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(`system_design_thinking: ${error.message}`);
    all.push(...((data ?? []) as KbRow[]));
    if ((data ?? []).length < 1000) break;
  }
  return all;
}

/** 退役（消さない）。現行の行だけ書き換える（同時に他の担当が退役していても二重にならない） */
export async function retireKbRows(sb: SupabaseClient, plans: RetirePlan[], by: string): Promise<number> {
  let n = 0;
  for (const p of plans) {
    const { data, error } = await sb.from("system_design_thinking")
      .update({ is_current: false, retired_reason: p.reason, superseded_by: p.supersededBy, retired_at: new Date().toISOString(), retired_by: by })
      .eq("id", p.id).eq("is_current", true).select("id");
    if (error) throw new Error(`退役 ${p.id}: ${error.message}`);
    n += (data ?? []).length;
  }
  return n;
}

/** ③ 似ている組を DeepSeek に聞く（推論なし・温度0・1組 約200トークン）。答えられなかった組は「要確認（判定なし）」 */
export async function judgeSimilarPairs(pairs: ReturnType<typeof similarPairs>, opts: { max?: number } = {}): Promise<{ review: ReviewItem[]; calls: number; failed: number }> {
  const review: ReviewItem[] = [];
  let calls = 0, failed = 0;
  for (const p of pairs.slice(0, opts.max ?? 120)) {
    calls++;
    const res = await callDeepSeek(SIMILAR_SYSTEM, similarPrompt(p.a, p.b), { thinking: false, temperature: 0, maxTokens: 120, timeoutMs: 30_000 });
    const j = res ? parseSimilar(res.text) : null;
    if (!j) { failed++; review.push({ kind: "similar", ids: [p.a.id, p.b.id], relation: "unknown", note: `似ている（本文 ${p.body.toFixed(2)}・題 ${p.title.toFixed(2)}）・判定なし` }); continue; }
    if (j.relation === "different" || j.relation === "related") continue;
    review.push({ kind: "similar", ids: [p.a.id, p.b.id], relation: j.relation, note: `${j.relation}: ${j.reason}（本文 ${p.body.toFixed(2)}・題 ${p.title.toFixed(2)}）` });
  }
  return { review, calls, failed };
}

export type KbCycleResult = {
  rows: number; current: number;
  retiredDuplicates: number; retiredDecisions: number;
  plannedDuplicates: RetirePlan[]; plannedDecisions: RetirePlan[];
  review: ReviewItem[]; missingDecisionRows: string[];
  llm: { calls: number; failed: number };
  digests: Array<{ area: string; rows: number }>;
};

/**
 * 1回の整理（週1の cron・scripts/kb-curate.ts が同じ関数）:
 *   読む → ①重複・②決定の auto を退役（dry なら数えるだけ）→ ③似ている組を DeepSeek（llm の時・週は新しい行を含む組だけ）
 *   → ④分野ごとのまとめと要確認の一覧を design_rules_digest へ
 */
export async function runDesignKnowledgeCycle(sb: SupabaseClient, opts: { dry: boolean; llm: boolean; sinceDays?: number | null; by?: string }): Promise<KbCycleResult> {
  const by = opts.by ?? "kb-curate";
  let rows = await loadKbRows(sb);
  const dups = findDuplicates(rows);
  const dec = findDecisionConflicts(rows);
  let rd = 0, rdec = 0;
  if (!opts.dry) {
    rd = await retireKbRows(sb, dups, `${by}:duplicate`);
    rdec = await retireKbRows(sb, dec.retire, `${by}:decision`);
    if (rd || rdec) rows = await loadKbRows(sb);
  }
  const sinceIso = opts.sinceDays ? new Date(Date.now() - opts.sinceDays * 86400e3).toISOString() : undefined;
  const sim = opts.llm ? await judgeSimilarPairs(similarPairs(rows, { sinceIso })) : { review: [] as ReviewItem[], calls: 0, failed: 0 };
  const review = [...dec.review, ...sim.review];
  const now = new Date().toISOString();
  const digests: Array<{ area: string; rows: number }> = [];
  for (const a of AREAS) {
    const d = buildDigest(rows, a.area, now);
    digests.push({ area: a.area, rows: d.ids.length });
    if (!opts.dry) {
      const { error } = await sb.from("design_rules_digest").upsert({ area: a.area, markdown: d.markdown, row_ids: d.ids, generated_at: now }, { onConflict: "area" });
      if (error) throw new Error(`design_rules_digest ${a.area}: ${error.message}`);
    }
  }
  if (!opts.dry) {
    const { error } = await sb.from("design_rules_digest").upsert({ area: "要確認", markdown: reviewMarkdown(review, rows, now), row_ids: [...new Set(review.flatMap((r) => r.ids))], review, generated_at: now }, { onConflict: "area" });
    if (error) throw new Error(`design_rules_digest 要確認: ${error.message}`);
  }
  return {
    rows: rows.length, current: rows.filter((r) => r.is_current).length,
    retiredDuplicates: rd, retiredDecisions: rdec, plannedDuplicates: dups, plannedDecisions: dec.retire,
    review, missingDecisionRows: dec.missing, llm: { calls: sim.calls, failed: sim.failed }, digests,
  };
}

export function reviewMarkdown(review: ReviewItem[], rows: KbRow[], nowIso: string): string {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const t = (id: string) => { const r = byId.get(id); return r ? `${r.title.replace(/\s+/g, " ").slice(0, 90)} ［${r.created_at.slice(0, 10)}・${id.slice(0, 8)}］` : id; };
  return [
    `# 設計知見の要確認（自動で退役しなかった物・${nowIso.slice(0, 10)}）`,
    "",
    "> 竹内さん・コーディネーターが読んで、古い方を `scripts/kb-retire.ts --id=<古い id> --by=<新しい id> --reason=…` で退役する。",
    "",
    ...(review.length ? review.map((r) => `- ${r.note}\n  - ${r.ids.map(t).join("\n  - ")}`) : ["- （なし）"]),
    "",
  ].join("\n");
}
