// scripts/lib/exam-efficiency.ts — 試験の効率の物差しと、効率が悪くなった晩の分け方（純関数・台帳 #686・2026-11-24 作業員L）
//   竹内さん 11/24 20時「試験の費用も抑えて、質も上げていく仕組みを強化していく」。その場ごとの削りでなく毎日回る物差しにする。
//   依頼1本の分け方（係の結果 exam-queue/results/<label>.json から）:
//     sure＝確かな悪化を見つけた・better＝良くなった・flake＝揺れの範囲の差だけ・nodiff＝差なし（悪化0・良くなった0・揺れ0）
//   効率: on にできた直し1本あたりの $・差なしの組に使った $ の割合・止めた $（使い回した基準・入力が同じで返した録音・外した問題の見込み）
//   悪くなった晩の理由: 差なし・作り直し（基準を作り直した $）・守り（守りの問題の分の $）・揺れ（揺れだけの組の $）のうち、前の晩の平均から一番増えた物

export type JobCls = "sure" | "better" | "flake" | "nodiff";
export type EffJob = { label: string; owner: string; usd: number; cls: JobCls; guardUsd: number };
export type EffNight = { jobs: EffJob[]; rebuildUsd: number; fixesOn: number; stoppedUsd: number; totalUsd: number; matchDelta: number | null };
export type EffMetrics = {
  totalUsd: number; jobs: number; sure: number; better: number; fixesOn: number; matchDelta: number | null;
  usdPerFix: number | null; noDiffShare: number | null; stoppedUsd: number;
  reasonUsd: { nodiff: number; rebuild: number; guards: number; flake: number };
};
export type Reason = keyof EffMetrics["reasonUsd"];
export const REASON_JA: Record<Reason, string> = { nodiff: "差なし", rebuild: "作り直し", guards: "守り", flake: "揺れ" };

/** 係の結果1本（worseSure・worseFlake・better）から分ける */
export function classifyJob(r: { worseSure?: unknown[] | null; worseFlake?: unknown[] | null; better?: number | null; worse?: number | null }): JobCls {
  if ((r.worseSure ?? []).length) return "sure";
  if ((r.better ?? 0) > 0) return "better";
  if ((r.worseFlake ?? []).length || (r.worse ?? 0) > 0) return "flake";
  return "nodiff";
}

export function effMetrics(n: EffNight): EffMetrics {
  const jobUsd = n.jobs.reduce((a, j) => a + j.usd, 0);
  const sum = (c: JobCls) => n.jobs.filter((j) => j.cls === c).reduce((a, j) => a + j.usd, 0);
  return {
    totalUsd: n.totalUsd, jobs: n.jobs.length, sure: n.jobs.filter((j) => j.cls === "sure").length, better: n.jobs.filter((j) => j.cls === "better").length,
    fixesOn: n.fixesOn, matchDelta: n.matchDelta,
    usdPerFix: n.fixesOn > 0 ? n.totalUsd / n.fixesOn : null,
    noDiffShare: jobUsd > 0 ? sum("nodiff") / jobUsd : null,
    stoppedUsd: n.stoppedUsd,
    reasonUsd: { nodiff: sum("nodiff"), rebuild: n.rebuildUsd, guards: n.jobs.reduce((a, j) => a + j.guardUsd, 0), flake: sum("flake") },
  };
}

/** 効率が悪くなったか（前の晩の平均より 差なしの割合が 10 ポイント以上・直し1本あたりの $ が 1.2 倍以上・費用があるのに直し0）と、一番増えた理由 */
export function worseNight(now: EffMetrics, prev: readonly EffMetrics[]): { worse: boolean; why: string[]; reason: Reason | null; overUsd: number } {
  const ran = prev.filter((p) => p.totalUsd > 0.01);
  if (now.totalUsd <= 0.01 || !ran.length) return { worse: false, why: [], reason: null, overUsd: 0 };
  const why: string[] = [];
  const shares = ran.map((p) => p.noDiffShare).filter((x): x is number => x != null);
  const avgShare = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null;
  if (now.noDiffShare != null && avgShare != null && now.noDiffShare - avgShare >= 0.1) why.push(`差なしの組の $ の割合 ${(now.noDiffShare * 100).toFixed(0)}%（前の平均 ${(avgShare * 100).toFixed(0)}%）`);
  const pers = ran.map((p) => p.usdPerFix).filter((x): x is number => x != null);
  const avgPer = pers.length ? pers.reduce((a, b) => a + b, 0) / pers.length : null;
  if (now.usdPerFix != null && avgPer != null && now.usdPerFix >= avgPer * 1.2) why.push(`直し1本あたり $${now.usdPerFix.toFixed(2)}（前の平均 $${avgPer.toFixed(2)}）`);
  if (now.usdPerFix == null && now.totalUsd >= 1) why.push(`$${now.totalUsd.toFixed(2)} 使って on にできた直しが0`);
  let reason: Reason | null = null, over = 0;
  for (const k of Object.keys(REASON_JA) as Reason[]) {
    const avg = ran.reduce((a, p) => a + p.reasonUsd[k], 0) / ran.length;
    const d = now.reasonUsd[k] - avg;
    if (d > over) { over = d; reason = k; }
  }
  return { worse: why.length > 0, why, reason: why.length ? reason : null, overUsd: why.length ? over : 0 };
}

/** 次の削りの案（理由ごと・台帳の行の題と次の一手）。持ち主は差なしなら一番使った組の依頼者、ほかは試験の仕組みの持ち主 */
export function proposalFor(reason: Reason, jobs: readonly EffJob[], night: string, sysOwner = "作業員L"): { title: string; next: string; owner: string } {
  const top = [...jobs].filter((j) => reason === "guards" ? j.guardUsd > 0 : reason === "nodiff" ? j.cls === "nodiff" : reason === "flake" ? j.cls === "flake" : true)
    .sort((a, b) => (reason === "guards" ? b.guardUsd - a.guardUsd : b.usd - a.usd)).slice(0, 3);
  const labels = top.map((j) => j.label).join("・") || "（組なし）";
  const owner = reason === "nodiff" && top[0]?.owner ? top[0].owner : sysOwner;
  const next: Record<Reason, string> = {
    nodiff: `差なしの組（${labels}）は、積む前にスイッチが効く問題か（材料・場面の表）を確かめる。表に無いスイッチを表に足すか、差なしが続くスイッチは束から外す`,
    rebuild: `基準の作り直しの元（構成の違い・commit の違い）を audit-exam-baseline-reuse で分け、使い回せる形にする（${labels}）`,
    guards: `守りの問題（${labels}）は使い回せる基準のある物だけか・守りの数の上限を見直す（守りで見つけた悪化の数と並べる）`,
    flake: `揺れだけの組（${labels}）は、揺れる問題の回数を増やすより、揺れの元（判定・道）を確かめる。揺れの問題を守りから外す案も`,
  };
  return { title: `試験の削りの案（${night} の晩・${REASON_JA[reason]}）`, next: next[reason], owner };
}
