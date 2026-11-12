// scripts/lib/allocation-score.ts — 配分ごとの当たりと費用の物差し（純関数・LLM なし・DB なし・作業員22・2026-11-12・KB fd1c7c62⑤）
//
// 入力: ① 試験の答案の行（scripts/lib/judge-basis-score.ts の AnswerRow と同じ形）＋問題の spec（場面）
//       ② llm_usage の route 別の数（手で書き出した JSON: [{ route, usd, calls?, id? }]・DB はここでは読まない）
// 配分の決め方: 答案に brain.conductor_allocation（CONDUCTOR_ALLOCATION=shadow|on で回した答案）があればそれ。
//   無い答案（off で回した物）は、spec の場面と brain.judge_basis.depth／brain.brain_depth.depth から allocationFromMeta で「この配分になったはず」を出す（推定・別に数える）。
// 費用: usage の行に id（問題の id）があればその問題へ。無い行は route＝script:brain-exam-<label> の label の答案の数で等分する。
//   表の目安（estUsd）と実測を並べて出す（目安を実測に直すための数）。
import { allocationFromMeta, ALLOCATION, type AllocationMeta } from "../../app/lib/conductor-allocation";
import type { AnswerRow, SpecLite } from "./judge-basis-score";

export type UsageRow = { route: string; usd: number; calls?: number; id?: string | null };
export type AnswerWithLabel = AnswerRow & { label?: string };
export type AllocVerdict = { id: string; rep: number; label: string; alloc: string | null; source: "answer" | "inferred" | "none"; pathOk: boolean | null; estUsd: number; usd: number | null };
export type AllocRow = { alloc: string; n: number; inferred: number; pathOk: number; pathN: number; hitRate: number | null; estUsdPerTurn: number; usdPerTurn: number | null; usdN: number };
export type AllocReport = { verdicts: AllocVerdict[]; rows: AllocRow[]; none: number; byDepth: Record<string, { n: number; usd: number | null }> };

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const labelOfRoute = (route: string) => route.replace(/^script:brain-exam-/, "");

function allocOfRow(spec: SpecLite | undefined, row: AnswerRow): { meta: AllocationMeta | null; source: AllocVerdict["source"] } {
  const b = (row.brain ?? {}) as Record<string, unknown>;
  const ca = b.conductor_allocation as AllocationMeta | null | undefined;
  if (ca && typeof ca.name === "string" && Array.isArray(ca.parts)) return { meta: ca, source: "answer" };
  const m = allocationFromMeta(b, { scene: (spec?.scene as string | null | undefined) ?? null });
  return m ? { meta: m, source: "inferred" } : { meta: null, source: "none" };
}

export function buildAllocReport(specs: ReadonlyArray<SpecLite>, rows: ReadonlyArray<AnswerWithLabel>, usage: ReadonlyArray<UsageRow> = []): AllocReport {
  const specById = new Map(specs.map((s) => [s.id, s]));
  // 費用の割り当て: id つき → その問題・id なし → label の答案で等分
  const usdById = new Map<string, number>();
  const usdByLabel = new Map<string, number>();
  for (const u of usage) {
    if (!(u.usd > 0)) continue;
    if (u.id) usdById.set(u.id, (usdById.get(u.id) ?? 0) + u.usd);
    else { const l = labelOfRoute(u.route); usdByLabel.set(l, (usdByLabel.get(l) ?? 0) + u.usd); }
  }
  const nByLabel = new Map<string, number>();
  const nById = new Map<string, number>();
  for (const r of rows) { const l = r.label ?? ""; nByLabel.set(l, (nByLabel.get(l) ?? 0) + 1); nById.set(r.id, (nById.get(r.id) ?? 0) + 1); }

  const verdicts: AllocVerdict[] = rows.map((r) => {
    const { meta, source } = allocOfRow(specById.get(r.id), r);
    const pathOk = typeof r.score?.path === "boolean" ? r.score.path : typeof r.path?.ok === "boolean" ? r.path.ok : null;
    const label = r.label ?? "";
    const byId = usdById.has(r.id) ? usdById.get(r.id)! / (nById.get(r.id) ?? 1) : null;
    const byLabel = usdByLabel.has(label) ? usdByLabel.get(label)! / (nByLabel.get(label) ?? 1) : null;
    const usd = byId ?? byLabel;
    return { id: r.id, rep: r.rep ?? 1, label, alloc: meta?.name ?? null, source, pathOk, estUsd: meta?.est_usd ?? 0, usd: usd == null ? null : r4(usd) };
  });

  const agg = new Map<string, AllocVerdict[]>();
  for (const v of verdicts) if (v.alloc) agg.set(v.alloc, [...(agg.get(v.alloc) ?? []), v]);
  const rowsOut: AllocRow[] = [...agg.entries()].map(([alloc, vs]) => {
    const withPath = vs.filter((v) => v.pathOk !== null), withUsd = vs.filter((v) => v.usd !== null);
    const ok = withPath.filter((v) => v.pathOk).length;
    return {
      alloc, n: vs.length, inferred: vs.filter((v) => v.source === "inferred").length, pathOk: ok, pathN: withPath.length,
      hitRate: withPath.length ? r4(ok / withPath.length) : null,
      estUsdPerTurn: ALLOCATION[alloc.split("/")[0]]?.[({ s: "shallow", n: "normal", d: "deep" } as const)[alloc.split("/")[1] as "s" | "n" | "d"]]?.estUsd ?? 0,
      usdPerTurn: withUsd.length ? r4(withUsd.reduce((s, v) => s + v.usd!, 0) / withUsd.length) : null, usdN: withUsd.length,
    };
  }).sort((a, b) => a.alloc.localeCompare(b.alloc));

  const byDepth: AllocReport["byDepth"] = {};
  for (const v of verdicts) {
    if (!v.alloc) continue;
    const d = v.alloc.split("/")[1];
    const cur = byDepth[d] ?? { n: 0, usd: null };
    cur.n++;
    if (v.usd !== null) cur.usd = r4((cur.usd ?? 0) + v.usd);
    byDepth[d] = cur;
  }
  return { verdicts, rows: rowsOut, none: verdicts.filter((v) => !v.alloc).length, byDepth };
}

export function formatAllocReport(r: AllocReport): string {
  const out = ["配分 | 番 | 推定 | 道の当たり | 目安$/番 | 実測$/番（数）"];
  for (const x of r.rows) out.push(`${x.alloc} | ${x.n} | ${x.inferred} | ${x.hitRate === null ? "-" : `${x.pathOk}/${x.pathN}（${Math.round(x.hitRate * 100)}%）`} | ${x.estUsdPerTurn} | ${x.usdPerTurn === null ? "-" : `${x.usdPerTurn}（${x.usdN}）`}`);
  out.push(`配分が決まらない答案（場面が型に無い・other 等）: ${r.none}`);
  out.push(`深さ別: ${Object.entries(r.byDepth).map(([d, v]) => `${d}=${v.n}番${v.usd === null ? "" : `・$${v.usd}`}`).join(" ／ ") || "-"}`);
  return out.join("\n");
}
