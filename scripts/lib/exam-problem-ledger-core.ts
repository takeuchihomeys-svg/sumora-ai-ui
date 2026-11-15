// scripts/lib/exam-problem-ledger-core.ts — 試験の問題の帳面の数え（純関数）。scripts/exam-problem-ledger.ts が DB の答えを渡す
//   2026-11-15 作業員I（統括役の穴7）。テスト: scripts/lib/__tests__/exam-problem-ledger.test.ts
export type LedgerProblem = { id: string; type?: string; conv: string; at: string; source?: string; why?: string; basis?: unknown; addedAt?: string };

/** 正解の根拠に書いた設計知見の id8（「KB 1d2400c6」「KB P1 a504029a」の形） */
export function kbIdsOf(p: LedgerProblem): string[] {
  const t = [p.source ?? "", p.why ?? "", typeof p.basis === "string" ? p.basis : JSON.stringify(p.basis ?? "")].join("\n");
  return [...new Set([...t.matchAll(/KB(?:\s*P[0-3])?\s*([0-9a-f]{8})/g)].map((m) => m[1]))];
}

export function ledgerSummary(spec: ReadonlyArray<LedgerProblem>, o: { writerOf: (id: string) => string | null; gatedOf: (id: string) => string | null; retired: ReadonlySet<string> }): {
  n: number; takeuchi: number; employee: number; unknown: number; gated: Array<{ id: string; why: string }>; retired: Array<{ id: string; kb: string[] }>; employeeIds: string[]; lines: string[];
} {
  let takeuchi = 0, employee = 0, unknown = 0;
  const employeeIds: string[] = [];
  const gated: Array<{ id: string; why: string }> = [], retired: Array<{ id: string; kb: string[] }> = [];
  const byType = new Map<string, { n: number; tk: number }>();
  for (const p of spec) {
    const w = o.writerOf(p.id);
    if (w === "takeuchi") takeuchi++; else if (w === "employee") { employee++; employeeIds.push(p.id); } else unknown++;
    const t = byType.get(p.type ?? "?") ?? { n: 0, tk: 0 }; t.n++; if (w === "takeuchi") t.tk++; byType.set(p.type ?? "?", t);
    const g = o.gatedOf(p.id); if (g) gated.push({ id: p.id, why: g });
    const kb = kbIdsOf(p).filter((k) => o.retired.has(k)); if (kb.length) retired.push({ id: p.id, kb });
  }
  const pct = (a: number) => `${Math.round((a / Math.max(1, spec.length)) * 100)}%`;
  const lines = [
    `# 試験の問題の帳面（${spec.length}問）`,
    "",
    `- ① 竹内さん本人の番から作った問題: ${takeuchi}（${pct(takeuchi)}）・従業員の番 ${employee}（${pct(employee)}）・書き手が決まらない ${unknown}（${pct(unknown)}）`,
    `- ② 申込以降の番の疑い（申込の門で外れる）: ${gated.length}問${gated.length ? `: ${gated.map((g) => `${g.id}（${g.why.slice(0, 30)}）`).join("・")}` : ""}`,
    `- ③ 正解の根拠の設計知見が退役している: ${retired.length}問${retired.length ? `: ${retired.map((r) => `${r.id}（KB ${r.kb.join("・")}）`).join("・")}` : ""}`,
    "",
    "## 型ごとの竹内さんの番の割合",
    "| 型 | 問題 | 竹内さんの番 |", "|---|---|---|",
    ...[...byType.entries()].sort((a, b) => b[1].n - a[1].n).map(([t, x]) => `| ${t} | ${x.n} | ${x.tk}（${Math.round((x.tk / x.n) * 100)}%） |`),
    "",
    "## 手入れの案（統括役の OK の後に）",
    ...(gated.length ? [`- 申込以降の ${gated.length}問は spec から外す（brain-exam-add --gate-check --remove-from-problems）`] : []),
    ...(retired.length ? [`- 退役した決まりを根拠にした ${retired.length}問は、新しい決定（kb-retire の by の行）で正解を書き直すか外す`] : []),
    ...(employee ? [`- 従業員の番から作った ${employee}問（${employeeIds.slice(0, 12).join(",")}${employeeIds.length > 12 ? " ほか" : ""}）は、竹内さんの番で同じ型の問題に置き換えるか、正解を竹内さんの決まりで確かめる（基準は竹内さんの番・KB 41dadfe6）`] : []),
  ];
  return { n: spec.length, takeuchi, employee, unknown, gated, retired, employeeIds, lines };
}
