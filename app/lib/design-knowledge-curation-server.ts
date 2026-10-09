// app/lib/design-knowledge-curation-server.ts — 設計知見の整理を DB に当てる（読む・退役・まとめを残す）
//   決まりは design-knowledge-curation.ts（純）。ここは読み書きと DeepSeek の呼び出しだけ。
//   退役は消さない: is_current=false・retired_reason・superseded_by・retired_at・retired_by を書く（migrate-schema に列）
//   まとめ（分野ごと）と要確認の一覧は design_rules_digest（1分野1行）に置く。手元では scripts/kb-digest.ts が memory/rules_digest_<分野>.md に写す
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AREAS, buildDigest, CONFLICT_RULE, mojibakeFields, findDecisionConflicts, findDuplicates, parseSimilar, planFromRelation, similarPairs, similarPrompt, SIMILAR_SYSTEM,
  type KbRow, type RetirePlan, type ReviewItem,
} from "@/app/lib/design-knowledge-curation";
import { callDeepSeek } from "@/app/lib/vision-alt-provider";
import { embedKbRows, hasPriorityColumn, neighborsOf } from "@/app/lib/design-knowledge-rag-server";
import { KB_SCENES, NEAR_DUP_MIN, rowInScene, type KbScene } from "@/app/lib/design-knowledge-rag";
import { effectivePriority, normalizeTags, priorityWatch, TAG_MAX } from "@/app/lib/design-knowledge-priority";

export async function loadKbRows(sb: SupabaseClient): Promise<KbRow[]> {
  const all: KbRow[] = [];
  // 2026-10-07 段（priority）は列がある時だけ読む（本番に ALTER を流す前でも動く）
  const withP = await hasPriorityColumn(sb);
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("system_design_thinking")
      .select("id, title, category, insight, rationale, context, applied_to, tags, is_current, created_at" + (withP ? ", priority" : ""))
      .order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(`system_design_thinking: ${error.message}`);
    all.push(...((data ?? []) as unknown as KbRow[]));
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

export type CandidatePair = ReturnType<typeof similarPairs>[number] & { src?: "embedding" | "lexical" | "scene" };

/**
 * ③ 似ている組を DeepSeek に聞く（推論なし・温度0・1組 約200トークン）。答えられなかった組は「要確認（判定なし）」
 *   2026-10-07（段）: 判定は planFromRelation で「確かな同じ（近さ 0.95 以上）は退役の計画」「上書き・食い違いは残す案つきの要確認」に分ける
 */
export async function judgeSimilarPairs(pairs: CandidatePair[], opts: { max?: number } = {}): Promise<{ review: ReviewItem[]; retire: RetirePlan[]; calls: number; failed: number }> {
  const review: ReviewItem[] = [];
  const retire: RetirePlan[] = [];
  const retired = new Set<string>();
  let calls = 0, failed = 0;
  for (const p of pairs.slice(0, opts.max ?? 120)) {
    if (retired.has(p.a.id) || retired.has(p.b.id)) continue;
    calls++;
    const res = await callDeepSeek(SIMILAR_SYSTEM, similarPrompt(p.a, p.b), { thinking: false, temperature: 0, maxTokens: 120, timeoutMs: 30_000 });
    const j = res ? parseSimilar(res.text) : null;
    if (!j) { failed++; review.push({ kind: "similar", ids: [p.a.id, p.b.id], relation: "unknown", note: `似ている（近さ/本文 ${p.body.toFixed(2)}・題 ${p.title.toFixed(2)}）・判定なし` }); continue; }
    const plan = planFromRelation(p.a, p.b, j.relation, j.reason, p.body, p.src ?? (p.title === 0 ? "embedding" : "lexical"));
    if (plan.retire) { retire.push(plan.retire); retired.add(plan.retire.id); }
    if (plan.review) review.push(plan.review);
  }
  return { review, retire, calls, failed };
}

export type KbCycleResult = {
  rows: number; current: number;
  retiredDuplicates: number; retiredDecisions: number;
  plannedDuplicates: RetirePlan[]; plannedDecisions: RetirePlan[];
  review: ReviewItem[]; missingDecisionRows: string[];
  llm: { calls: number; failed: number };
  digests: Array<{ area: string; rows: number }>;
  embed: { embedded: number; tokens: number; usd: number };
  candidates: { embedding: number; lexical: number; scene?: number };
  /** 2026-10-07 段と札の整理 */
  retiredSame?: number; plannedSame?: RetirePlan[];
  tags?: { planned: number; applied: number; examples: string[] };
  priority?: { counts: Record<number, number>; warnings: string[]; fixesPlanned: number; fixesApplied: number; column: boolean };
  /** 要確認の一覧の markdown（dry でも作る・scripts/kb-curate.ts --write-review が memory に写す） */
  reviewMd?: string;
};

/**
 * 2026-10-06（⑯・RAG）似ている組の候補は埋め込みの近さ（NEAR_DUP_MIN 以上・行ごとに近い3つ）を先に、文字の重なりの強い組（本文 0.25 以上）を足す。
 *   DeepSeek に聞くのはこの候補だけ（旧は文字の重なりの弱い組まで全部＝週の呼び出しが減る）。埋め込みが無い時は旧の文字の重なりだけ
 * 2026-10-07（段）食い違いの検出: P0/P1（決まり）の行は、近さ 0.72 以上で同じ場面（札・題の型）の決まり同士の組も候補に足す
 *   （言い方が違っても同じ場面の逆の決まりを拾う。DeepSeek が conflict／supersedes と言った物は残す案つきで要確認へ）
 */
export async function candidatePairs(sb: SupabaseClient, rows: KbRow[], sinceIso?: string): Promise<{ pairs: CandidatePair[]; embedding: number; lexical: number; scene: number }> {
  const cur = rows.filter((r) => r.is_current);
  const byId = new Map(cur.map((r) => [r.id, r]));
  const focus = sinceIso ? cur.filter((r) => r.created_at >= sinceIso) : cur;
  const seen = new Set<string>();
  const out: CandidatePair[] = [];
  let embedding = 0, scene = 0;
  const scenes = (Object.keys(KB_SCENES) as KbScene[]).filter((s) => s !== "other");
  const shareScene = (a: KbRow, b: KbRow) => scenes.some((s) => rowInScene(a, s) && rowInScene(b, s));
  for (const r of focus) {
    let nb: Array<{ id: string; similarity: number }> = [];
    try { nb = await neighborsOf(sb, r.id, 3, NEAR_DUP_MIN); } catch { nb = []; }
    for (const n of nb) {
      const o = byId.get(n.id);
      if (!o) continue;
      const key = [r.id, o.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const [a, b] = r.created_at <= o.created_at ? [r, o] : [o, r];
      out.push({ a, b, body: n.similarity, title: 0, src: "embedding" });
      embedding++;
    }
    if (effectivePriority(r) > 1) continue;
    let nb2: Array<{ id: string; similarity: number }> = [];
    try { nb2 = await neighborsOf(sb, r.id, 6, CONFLICT_RULE.sceneNearMin); } catch { nb2 = []; }
    for (const n of nb2) {
      const o = byId.get(n.id);
      if (!o || effectivePriority(o) > 1 || !shareScene(r, o)) continue;
      const key = [r.id, o.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const [a, b] = r.created_at <= o.created_at ? [r, o] : [o, r];
      out.push({ a, b, body: n.similarity, title: 0, src: "scene" });
      scene++;
    }
  }
  let lexical = 0;
  for (const p of similarPairs(rows, { sinceIso })) {
    if (p.body < 0.25) continue;
    const key = [p.a.id, p.b.id].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...p, src: "lexical" });
    lexical++;
  }
  return { pairs: out.slice(0, 120), embedding, lexical, scene };
}

/** 札の正規化を当てる（表記ゆれだけ・CLAUDE.md「タグの書き方」）。変えた行は埋め込みの指紋が変わるので、後の embedKbRows が埋め直す */
export async function normalizeKbTags(sb: SupabaseClient, rows: KbRow[], dry: boolean): Promise<{ planned: number; applied: number; examples: string[]; over: ReviewItem[] }> {
  let planned = 0, applied = 0;
  const examples: string[] = [];
  const over: ReviewItem[] = [];
  for (const r of rows) {
    if (!r.is_current) continue;
    const n = normalizeTags(r.tags);
    if (n.tags.length > TAG_MAX) over.push({ kind: "tags", ids: [r.id], note: `札が ${n.tags.length}個（${TAG_MAX}個まで）— 軸1〜2＋機能1〜2＋事例1 に絞る` });
    // 2026-10-08 文字化けの行（PowerShell の REST で入れた「????」等）は要確認へ（元の文を記録から探して kb-insert で入れ直し、kb-retire で退役）
    const mb = mojibakeFields(r as Parameters<typeof mojibakeFields>[0]);
    if (mb.length) over.push({ kind: "mojibake", ids: [r.id], note: `文字化け（${mb.join("・")}）— 元の文を探して scripts/kb-insert.ts で入れ直し、古い行は kb-retire` });
    if (!n.changed) continue;
    planned++;
    if (examples.length < 8) examples.push(`${(r.tags ?? []).join("/")} → ${n.tags.join("/")}`);
    if (dry) continue;
    const { error } = await sb.from("system_design_thinking").update({ tags: n.tags }).eq("id", r.id);
    if (error) throw new Error(`札の正規化 ${r.id}: ${error.message}`);
    r.tags = n.tags;
    applied++;
  }
  return { planned, applied, examples, over };
}

/** 段の見張りと付け直し（列がある時だけ書く）: 札「絶対・最優先」と列の食い違い・空の行の確かな推定を書く。迷う物は要確認 */
export async function checkKbPriority(sb: SupabaseClient, rows: KbRow[], dry: boolean): Promise<{ counts: Record<number, number>; warnings: string[]; fixesPlanned: number; fixesApplied: number; column: boolean; review: ReviewItem[] }> {
  const column = await hasPriorityColumn(sb);
  const w = priorityWatch(rows.filter((r) => r.is_current));
  let applied = 0;
  if (column && !dry) {
    for (const f of w.fixes) {
      const { error } = await sb.from("system_design_thinking").update({ priority: f.priority }).eq("id", f.id);
      if (error) throw new Error(`段の付け直し ${f.id}: ${error.message}`);
      applied++;
    }
  }
  const review: ReviewItem[] = [
    ...w.warnings.map((x) => ({ kind: "priority" as const, ids: [], note: x })),
    ...w.review.map((x) => ({ kind: "priority" as const, ids: [x.id], note: x.note })),
    ...(column ? [] : [{ kind: "priority" as const, ids: [], note: "priority 列がまだ無い（段は決定論の推定で並べている）— migrate-schema の ALTER と scripts/kb-priority.ts --apply を流す" }]),
  ];
  return { counts: w.counts, warnings: w.warnings, fixesPlanned: w.fixes.length, fixesApplied: applied, column, review };
}

/**
 * 1回の整理（週1の cron・scripts/kb-curate.ts が同じ関数）:
 *   読む → ①重複・②決定の auto を退役（dry なら数えるだけ）→ 札の正規化 → ③似ている組・同じ場面の決まり同士を DeepSeek（llm の時・週は新しい行を含む組だけ）
 *   （確かな同じだけ退役・上書きと食い違いは残す案つきで要確認）→ 段の見張り → ④分野ごとのまとめ（段の順）と要確認の一覧を design_rules_digest へ
 */
export async function runDesignKnowledgeCycle(sb: SupabaseClient, opts: { dry: boolean; llm: boolean; sinceDays?: number | null; by?: string }): Promise<KbCycleResult> {
  const by = opts.by ?? "kb-curate";
  let rows = await loadKbRows(sb);
  // P0（絶対・最優先）の行は自動では退役しない（竹内さんが決める）
  const p0 = new Set(rows.filter((r) => r.is_current && effectivePriority(r) === 0).map((r) => r.id));
  const dups = findDuplicates(rows).filter((p) => !p0.has(p.id));
  const dec0 = findDecisionConflicts(rows);
  const dec = { ...dec0, retire: dec0.retire.filter((p) => !p0.has(p.id)) };
  let rd = 0, rdec = 0;
  if (!opts.dry) {
    rd = await retireKbRows(sb, dups, `${by}:duplicate`);
    rdec = await retireKbRows(sb, dec.retire, `${by}:decision`);
    if (rd || rdec) rows = await loadKbRows(sb);
  }
  // 札の正規化（埋め込みの前＝変えた行はこの回で埋め直す）
  const tags = await normalizeKbTags(sb, rows, opts.dry);
  const sinceIso = opts.sinceDays ? new Date(Date.now() - opts.sinceDays * 86400e3).toISOString() : undefined;
  // 新しい行・文が変わった行の埋め込みを先に作る（似ている組の候補と自然文の引き方の両方に使う）
  const emb = opts.dry ? { embedded: 0, tokens: 0, usd: 0 } : await embedKbRows(sb, { dry: false }).catch((e) => { console.warn("[kb] 埋め込みに失敗:", e instanceof Error ? e.message : e); return { embedded: 0, tokens: 0, usd: 0 }; });
  const cand = opts.llm ? await candidatePairs(sb, rows, sinceIso) : { pairs: [] as CandidatePair[], embedding: 0, lexical: 0, scene: 0 };
  const sim = opts.llm ? await judgeSimilarPairs(cand.pairs) : { review: [] as ReviewItem[], retire: [] as RetirePlan[], calls: 0, failed: 0 };
  let rsame = 0;
  sim.retire = sim.retire.filter((p) => !p0.has(p.id));
  if (!opts.dry && sim.retire.length) {
    rsame = await retireKbRows(sb, sim.retire, `${by}:same`);
    if (rsame) rows = await loadKbRows(sb);
  }
  const prio = await checkKbPriority(sb, rows, opts.dry);
  if (prio.fixesApplied) rows = await loadKbRows(sb);
  const review = [...prio.review, ...dec.review, ...sim.review, ...tags.over.slice(0, 20)];
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
    const { error } = await sb.from("design_rules_digest").upsert({ area: "要確認", markdown: reviewMarkdown(review, rows, now, prio.counts), row_ids: [...new Set(review.flatMap((r) => r.ids))], review, generated_at: now }, { onConflict: "area" });
    if (error) throw new Error(`design_rules_digest 要確認: ${error.message}`);
  }
  return {
    rows: rows.length, current: rows.filter((r) => r.is_current).length,
    retiredDuplicates: rd, retiredDecisions: rdec, plannedDuplicates: dups, plannedDecisions: dec.retire,
    review, missingDecisionRows: dec.missing, llm: { calls: sim.calls, failed: sim.failed }, digests,
    embed: { embedded: emb.embedded, tokens: emb.tokens, usd: emb.usd }, candidates: { embedding: cand.embedding, lexical: cand.lexical, scene: cand.scene },
    retiredSame: rsame, plannedSame: sim.retire,
    tags: { planned: tags.planned, applied: tags.applied, examples: tags.examples },
    priority: { counts: prio.counts, warnings: prio.warnings, fixesPlanned: prio.fixesPlanned, fixesApplied: prio.fixesApplied, column: prio.column },
    reviewMd: reviewMarkdown(review, rows, now, prio.counts),
  };
}

const REVIEW_ORDER: Record<ReviewItem["kind"], number> = { priority: 0, conflict: 1, decision: 2, similar: 3, tags: 4, mojibake: 5 };
export function reviewMarkdown(review: ReviewItem[], rows: KbRow[], nowIso: string, counts?: Record<number, number>): string {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const t = (id: string) => { const r = byId.get(id); return r ? `${r.title.replace(/\s+/g, " ").slice(0, 90)} ［P${effectivePriority(r)}・${r.created_at.slice(0, 10)}・${id.slice(0, 8)}］` : id; };
  const sorted = [...review].sort((a, b) => REVIEW_ORDER[a.kind] - REVIEW_ORDER[b.kind]);
  const head: Record<ReviewItem["kind"], string> = { priority: "段（優先順位）", conflict: "食い違い・上書き（新しい決定の方を残す案）", decision: "竹内さんの決定と食い違うかもしれない行", similar: "似ている組", tags: "札の数", mojibake: "文字化け" };
  const out: string[] = [
    `# 設計知見の要確認（自動で退役しなかった物・${nowIso.slice(0, 10)}）`,
    "",
    "> 竹内さん・コーディネーターが読んで、古い方を `scripts/kb-retire.ts --id=<古い id> --by=<新しい id> --reason=…` で退役する。",
    ...(counts ? [`> 段の数（現行）: P0 ${counts[0] ?? 0}・P1 ${counts[1] ?? 0}・P2 ${counts[2] ?? 0}・P3 ${counts[3] ?? 0}`] : []),
    "",
  ];
  if (!sorted.length) out.push("- （なし）");
  let last: string | null = null;
  for (const r of sorted) {
    if (r.kind !== last) { out.push(`## ${head[r.kind]}`); last = r.kind; }
    out.push(`- ${r.note}${r.ids.length ? "\n  - " + r.ids.map(t).join("\n  - ") : ""}`);
  }
  out.push("");
  return out.join("\n");
}
