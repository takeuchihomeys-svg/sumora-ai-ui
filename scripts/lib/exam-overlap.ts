// scripts/lib/exam-overlap.ts — 試験の依頼の重なりの知らせ（純関数・LLM も DB も使わない）
//   2026-11-10 作業員8b（統括役・試験の統括ブレインの①・KB 7b5ef932 の子・親 P0 9eb6aa9c）: 11/10 に、原因が分かっている q118 の掘りと、
//   別の作業員の q118 の試験が重なった。係が依頼を積む時に、同じ問題が他の依頼（待ち）・直近24時間に済んだ依頼にあれば計画の1行に出し、
//   同じスイッチ・同じ問題なら積まずに返す（--force で積める）。弱い所（brain_weaknesses）にその問題が書いてあれば、その id と原因も出す

export type OverlapJob = { label?: string; owner?: string; switch?: string; only?: string; cmds?: string[]; runner?: string; state: "待ち" | "済み" };
export type OverlapHit = { id: string; label: string; owner: string; state: "待ち" | "済み"; sameSwitch: boolean };
export type WeakRow = { id: number | string; status?: string | null; title?: string | null; symptom?: string | null; root_cause?: string | null; evidence?: unknown };

/** 依頼が流す問題（only と cmd の --only） */
export function jobProblemIds(j: Pick<OverlapJob, "only" | "cmds">): string[] {
  const s = new Set<string>();
  for (const id of String(j.only ?? "").split(",")) if (id.trim()) s.add(id.trim());
  for (const c of j.cmds ?? []) { const m = c.match(/--only=(\S+)/); if (m) for (const id of m[1].split(",")) if (id.trim()) s.add(id.trim()); }
  return [...s];
}

/** 他の依頼との重なり（同じ label・夜の基準・tsc は数えない） */
export function findOverlaps(ids: readonly string[], me: { label: string; switch?: string }, jobs: readonly OverlapJob[]): OverlapHit[] {
  const want = new Set(ids), out: OverlapHit[] = [], sw = (me.switch ?? "").trim();
  for (const j of jobs) {
    const label = String(j.label ?? "");
    if (!label || label === me.label || /^night-base-/.test(label) || j.runner === "tsc" || j.runner === "tsc-remote") continue;
    const js = String(j.switch ?? "").trim();
    for (const id of jobProblemIds(j)) if (want.has(id)) out.push({ id, label, owner: String(j.owner ?? "?"), state: j.state, sameSwitch: !!sw && js === sw });
  }
  return out;
}

/** 同じスイッチ・同じ問題の重なりがあれば積まない */
export function overlapBlocks(hits: readonly OverlapHit[]): OverlapHit[] { return hits.filter((h) => h.sameSwitch); }

/** 弱い所の行のうち、問題 id が書いてある物（fixed・wont_fix は除く）。id は語の切れ目で見る（q11 が q118 に当たらない） */
export function weakFor(ids: readonly string[], rows: readonly WeakRow[]): Map<string, WeakRow> {
  const m = new Map<string, WeakRow>();
  for (const r of rows) {
    if (r.status === "fixed" || r.status === "wont_fix") continue;
    const text = [r.title, r.symptom, r.root_cause, typeof r.evidence === "string" ? r.evidence : JSON.stringify(r.evidence ?? "")].join(" ");
    for (const id of ids) if (!m.has(id) && new RegExp(`(^|[^0-9A-Za-z])${id}(?![0-9])`).test(text)) m.set(id, r);
  }
  return m;
}

function causeKnown(r: WeakRow): boolean { const rc = String(r.root_cause ?? "").trim(); return !!rc && !/^未(調べ|確認|特定)/.test(rc); }

/** 計画の1行（重なりが無ければ空） */
export function overlapLine(hits: readonly OverlapHit[], weak: ReadonlyMap<string, WeakRow>): string {
  const ids = [...new Set([...hits.map((h) => h.id), ...weak.keys()])];
  if (!ids.length) return "";
  const parts = ids.map((id) => {
    const hs = hits.filter((h) => h.id === id);
    const w = weak.get(id);
    const who = hs.map((h) => `${h.owner} ${h.label}・${h.state}${h.sameSwitch ? "・同じスイッチ" : ""}`).join("／");
    const ws = w ? `${causeKnown(w) ? "原因は分かっている" : "弱い所にある（原因は未調べ）"}（弱い所 ${w.id}${causeKnown(w) ? `: ${String(w.root_cause).slice(0, 40)}` : ""}）` : "";
    return `${id}${who ? `（${who}）` : ""}${ws ? ` ${ws}` : ""}`;
  });
  return `重なり: ${parts.join("・")}`;
}
