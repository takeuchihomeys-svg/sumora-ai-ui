// scripts/lib/exam-reflection.ts — 試験の統括ブレインの ⑥決め直す・⑦振り返る（純関数・LLM も DB も使わない）
//
// 2026-11-10 作業員8c（竹内さんの決定 KB 7b5ef932「読む→重点→選ぶ→回数と止め時→確かめ→決め直す→振り返る」・P0 8805bd74・作業員8b と分担）:
//   ⑥決め直す: 依頼の結果で「狙いが効かず（狙いの問題の合格・本質が前と同じ）悪化0」の時、同じ重点（依頼のスイッチ・狙いの問題の場面）で
//     足すとよい問題を1〜3問、計画の案として結果の1行と results の json に出す（自動では流さない＝積むのは依頼者）。
//   ⑦振り返る: 選んだ問題のうち、外れ・道の悪化・本質の悪化・揺れ・合格の悪化を見つけた問題と、何も見つけなかった問題を results の json に記録する。
//     週1の集計（scripts/exam-reflection-weekly.ts）が、何も見つけなかった問題の割合・費用・作業員ごと・守り（EXAM_AUTO_GUARDS）が見つけた数を出す。
//   止める: EXAM_REFLECTION=off（記録も案も出さない）

export type FindKind = "miss" | "worse" | "path" | "essence" | "flake";
export const FIND_LABEL: Record<FindKind, string> = { miss: "外れ", worse: "合格の悪化", path: "道の悪化", essence: "本質の悪化", flake: "揺れ" };

/** 結果の行（brain-exam の results/<label>.jsonl の1行）のうち使う所だけ */
export type ReflRow = { id: string; rep?: number; error?: string; path?: { code?: string; ok?: boolean } | null; score?: { pass?: boolean } | null; essence?: { ok?: boolean; code?: string } | null };
export type IdWhy = { id: string; why?: string };
export type ProblemFinding = { id: string; role: "target" | "guard"; kinds: FindKind[] };
export type Reflection = {
  v: 1;
  selected: number; targets: number; guards: number;
  found: ProblemFinding[]; nothing: ProblemFinding[];
  /** 問題ごとの回（費用の割り振りに使う） */ reps: Record<string, number>;
};

/** 結果の json に残っている形（週の集計が古い結果から振り返りを作り直す時も使う） */
export type ResultLite = {
  label?: string; owner?: string; switch?: string; runner?: string; only?: string; reps?: Record<string, number>; usd?: string | null; at?: string;
  worseSure?: IdWhy[] | null; worseFlake?: IdWhy[] | null; pathWorse?: IdWhy[] | null; essenceWorse?: IdWhy[] | null;
  missStages?: Array<{ id: string; n?: number; reps?: number[] } | null> | null;
  reflection?: Reflection | null; replan?: Replan | null;
};

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/**
 * ⑦ 問題ごとに何を見つけたか（純関数）。
 *   外れ＝今の回で合格しなかった回がある（rows があれば rows・無ければ missStages）
 *   揺れ＝同じ問題の回で合否か道が割れた・または係が「揺れの範囲の差」とした（worseFlake）
 *   合格の悪化（worseSure）・道の悪化（pathWorse）・本質の悪化（essenceWorse）は係の比べた結果のまま
 */
export function reflectRun(input: { ids: ReadonlyArray<string>; guards?: ReadonlyArray<string> | null; rows?: ReadonlyArray<ReflRow> | null; result: ResultLite }): Reflection {
  const ids = uniq([...input.ids].filter(Boolean));
  const guards = new Set(input.guards ?? []);
  const r = input.result;
  const has = (xs: IdWhy[] | null | undefined) => new Set((xs ?? []).map((x) => x.id));
  const worse = has(r.worseSure), flakeW = has(r.worseFlake), path = has(r.pathWorse), ess = has(r.essenceWorse);
  const rowsOf = (id: string) => (input.rows ?? []).filter((x) => x.id === id && !x.error);
  const msOf = (id: string) => (r.missStages ?? []).find((m) => m && m.id === id) ?? null;
  const reps: Record<string, number> = {};
  const found: ProblemFinding[] = [], nothing: ProblemFinding[] = [];
  for (const id of ids) {
    const rs = rowsOf(id);
    const ms = msOf(id);
    const nRep = rs.length || r.reps?.[id] || 1;
    reps[id] = nRep;
    const kinds: FindKind[] = [];
    const missRows = rs.filter((x) => x.score?.pass === false || (x.score?.pass == null && x.path?.ok === false));
    const miss = rs.length ? missRows.length > 0 : !!(ms && (ms.n ?? 1) > 0);
    if (miss) kinds.push("miss");
    if (worse.has(id)) kinds.push("worse");
    if (path.has(id)) kinds.push("path");
    if (ess.has(id)) kinds.push("essence");
    const passSplit = rs.length > 1 && new Set(rs.map((x) => x.score?.pass ?? x.path?.ok ?? null)).size > 1;
    const codeSplit = rs.length > 1 && new Set(rs.map((x) => x.path?.code ?? null)).size > 1;
    const msSplit = !rs.length && !!ms && (ms.n ?? 0) > 0 && (r.reps?.[id] ?? 1) > (ms.n ?? 0);
    if (flakeW.has(id) || passSplit || codeSplit || msSplit) kinds.push("flake");
    const f: ProblemFinding = { id, role: guards.has(id) ? "guard" : "target", kinds };
    (kinds.length ? found : nothing).push(f);
  }
  return { v: 1, selected: ids.length, targets: ids.filter((id) => !guards.has(id)).length, guards: ids.filter((id) => guards.has(id)).length, found, nothing, reps };
}

/** 1行に足す言葉（純関数） */
export function reflectionLine(x: Reflection): string {
  if (!x.selected) return "";
  const g = x.found.filter((f) => f.role === "guard").length;
  return `・振り返り: 見つけた ${x.found.length}/${x.selected}問${x.found.length ? `（${x.found.map((f) => `${f.id} ${f.kinds.map((k) => FIND_LABEL[k]).join("+")}`).join("／")}）` : ""}${x.guards ? `・守り ${g}/${x.guards}問が見つけた` : ""}`;
}

// ─── ⑥ 決め直す ────────────────────────────────────────────────────────────────
export type ReplanCard = { id: string; type?: string | null; sub?: string | null; stage?: "brain" | "draft"; embedding?: number[] | null };
export type ReplanPick = { id: string; why: string; sim: number; sameScene: boolean; reusable: boolean };
export type Replan = { v: 1; why: string; focus: { switch: string; scenes: string[] }; add: ReplanPick[]; cmd: string | null };

const rate = (xs: Array<boolean | null | undefined>) => { const k = xs.filter((x) => x != null) as boolean[]; return k.length ? k.filter(Boolean).length / k.length : null; };
const same = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) < 1e-9;

/**
 * 狙いが効いたか（純関数）: 狙いの問題（守りを除く）ごとに、合格の割合と本質の当たりの割合が前と同じなら「効かず」。
 *   両方で解いた狙いが1問も無い時は判断しない（unchanged=false・compared=0）。本質が無い問題は合格だけで見る
 */
export function targetsUnchanged(cur: ReadonlyArray<ReflRow>, base: ReadonlyArray<ReflRow>, targets: ReadonlyArray<string>): { unchanged: boolean; compared: number; changed: string[] } {
  let compared = 0; const changed: string[] = [];
  for (const id of uniq([...targets])) {
    const c = cur.filter((r) => r.id === id && !r.error), b = base.filter((r) => r.id === id && !r.error);
    if (!c.length || !b.length) continue;
    compared++;
    const pc = rate(c.map((r) => r.score?.pass ?? r.path?.ok)), pb = rate(b.map((r) => r.score?.pass ?? r.path?.ok));
    const ec = rate(c.map((r) => r.essence?.ok)), eb = rate(b.map((r) => r.essence?.ok));
    const passSame = same(pc, pb) || (pc == null && pb == null);
    const essSame = (ec == null && eb == null) || same(ec, eb);
    if (!passSame || !essSame) changed.push(id);
  }
  return { unchanged: compared > 0 && changed.length === 0, compared, changed };
}

const cos = (a: number[], b: number[]): number => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

/**
 * 決め直しの案（純関数）: 効かず・悪化0（合格・道・本質）の時だけ、同じ重点で足すとよい問題を1〜max問。
 *   重点＝狙いの問題の場面（札の type）。候補＝同じ場面の問題（依頼に入っていない物）を狙いへの近さで並べ、
 *   同じ場面＞使い回せる（夜の基準あり）＞安定＞近さ。同じ場面が足りない時だけ、近さ minSim 以上の別の場面で埋める。
 *   スイッチが同じ過去の依頼で外れを見つけた問題（hitIds）は同じ場面と同じ重さで先に入れる。
 */
export function replanSuggest(input: {
  targets: ReadonlyArray<string>; jobIds: ReadonlyArray<string>; switchName?: string | null; label?: string; owner?: string; cwd?: string;
  cards: ReadonlyArray<ReplanCard>; nightlyIds?: ReadonlySet<string>; stableIds?: ReadonlySet<string>; hitIds?: ReadonlySet<string>;
  verdict: { unchanged: boolean; compared: number; worseN: number; pathN: number; essenceN: number };
  max?: number; minSim?: number; stage?: "brain" | "draft" | null;
}): Replan | null {
  const v = input.verdict;
  if (!v.unchanged || v.compared === 0 || v.worseN || v.pathN || v.essenceN) return null;
  const max = Math.max(1, Math.min(3, input.max ?? 3)), minSim = input.minSim ?? 0.45;
  const t = new Set(input.targets), inJob = new Set(input.jobIds);
  const tc = input.cards.filter((c) => t.has(c.id));
  const scenes = uniq(tc.map((c) => c.type ?? "").filter(Boolean));
  const tv = tc.filter((c) => c.embedding?.length).map((c) => c.embedding as number[]);
  const nightly = input.nightlyIds ?? new Set<string>(), stable = input.stableIds ?? new Set<string>(), hits = input.hitIds ?? new Set<string>();
  const cands = input.cards
    .filter((c) => !inJob.has(c.id) && (input.stage !== "draft" || c.stage === "draft"))
    .map((c) => ({ c, sim: tv.length && c.embedding?.length ? Math.max(...tv.map((x) => cos(x, c.embedding as number[]))) : 0, sameScene: !!c.type && scenes.includes(c.type) }))
    .filter((x) => x.sameScene || hits.has(x.c.id) || x.sim >= minSim);
  const score = (x: (typeof cands)[number]) => (x.sameScene || hits.has(x.c.id) ? 4 : 0) + (nightly.has(x.c.id) ? 2 : 0) + (stable.has(x.c.id) ? 1 : 0);
  const add = cands.sort((a, b) => score(b) - score(a) || b.sim - a.sim || a.c.id.localeCompare(b.c.id)).slice(0, max).map((x) => {
    const reusable = nightly.has(x.c.id);
    const why = [x.sameScene ? `同じ場面 ${x.c.type}` : `別の場面 ${x.c.type ?? "?"}`, hits.has(x.c.id) ? "同じスイッチの依頼で外れを見つけた" : "", reusable ? "夜の基準あり" : "前を作る", stable.has(x.c.id) ? "安定" : "", `近さ ${x.sim.toFixed(2)}`].filter(Boolean).join("・");
    return { id: x.c.id, why, sim: Math.round(x.sim * 100) / 100, sameScene: x.sameScene, reusable };
  });
  if (!add.length) return null;
  const sw = input.switchName ?? "";
  const cmd = input.label ? `npx tsx --env-file=.env.local scripts/exam-conductor.ts --add --label=${input.label}-rp --owner=${input.owner ?? "?"}${sw ? ` --switch=${sw}` : ""}${input.cwd ? ` --cwd="${input.cwd}"` : ""} --only=${add.map((a) => a.id).join(",")} --repeat=1` : null;
  return { v: 1, why: `狙い ${v.compared}問の合格・本質が前と同じ（効かず）・悪化0 → 同じ重点（${sw || "スイッチなし"}・場面 ${scenes.join(",") || "?"}）で足す案`, focus: { switch: sw, scenes }, add, cmd };
}

export function replanLine(x: Replan | null): string {
  return x ? `・決め直しの案（流さない）: +${x.add.map((a) => `${a.id}（${a.why}）`).join("／")}` : "";
}

// ─── 週の集計 ──────────────────────────────────────────────────────────────────
export type WeeklyRow = { label: string; owner: string; at: string; usd: number | null; reflection: Reflection; rebuilt: boolean; replan: boolean; /** 作り直した古い結果に missStages の欄が無い（11/06 より前）＝外れを数えられない */ missUnknown?: boolean };
export type WeeklySummary = {
  from: string; to: string; jobs: number; rebuilt: number; missUnknown: number;
  problems: number; nothing: number; nothingRate: number | null;
  usd: number; nothingUsd: number;
  byKind: Record<FindKind, number>;
  byOwner: Array<{ owner: string; jobs: number; problems: number; nothing: number; usd: number; nothingUsd: number }>;
  guards: { added: number; found: number; kinds: Record<FindKind, number>; ids: string[] };
  replans: number;
  /** 何度選ばれても何も見つけなかった問題（2回以上・多い順） */ idleIds: Array<{ id: string; times: number }>;
};

export const parseUsd = (s: string | number | null | undefined): number | null => {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const m = String(s ?? "").match(/\$?\s*(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
};

/** 結果の json 1つ → 週の行（純関数）。brain-exam 以外・問題の無い結果は null。reflection が無い古い結果は残っている欄から作り直す */
export function weeklyRowOf(r: ResultLite, guardsOf?: (label: string) => string[] | null): WeeklyRow | null {
  if (!r || !r.label || (r.runner && r.runner !== "brain-exam")) return null;
  let refl = r.reflection && r.reflection.v === 1 ? r.reflection : null;
  let rebuilt = false;
  if (!refl) {
    const ids = String(r.only ?? "").split(",").filter(Boolean);
    if (!ids.length) return null;
    refl = reflectRun({ ids, guards: guardsOf?.(r.label) ?? null, result: r });
    rebuilt = true;
  }
  if (!refl.selected) return null;
  return { label: r.label, owner: r.owner || "?", at: r.at ?? "", usd: parseUsd(r.usd), reflection: refl, rebuilt, replan: !!r.replan, ...(rebuilt && r.missStages == null ? { missUnknown: true } : {}) };
}

/** 費用を問題の回の数で割り振った「何も見つけなかった問題の費用」（純関数） */
export function nothingUsdOf(row: WeeklyRow): number {
  if (row.usd == null) return 0;
  const reps = row.reflection.reps ?? {};
  const all = [...row.reflection.found, ...row.reflection.nothing].reduce((s, f) => s + (reps[f.id] ?? 1), 0);
  const no = row.reflection.nothing.reduce((s, f) => s + (reps[f.id] ?? 1), 0);
  return all ? row.usd * no / all : 0;
}

export function summarizeWeek(rows: ReadonlyArray<WeeklyRow>, range: { from: string; to: string }): WeeklySummary {
  const zero = (): Record<FindKind, number> => ({ miss: 0, worse: 0, path: 0, essence: 0, flake: 0 });
  const byKind = zero(), gk = zero();
  const owners = new Map<string, { owner: string; jobs: number; problems: number; nothing: number; usd: number; nothingUsd: number }>();
  const idle = new Map<string, { times: number; found: number }>();
  let problems = 0, nothing = 0, usd = 0, nothingUsd = 0, gAdded = 0, gFound = 0, replans = 0, rebuilt = 0, missUnknown = 0;
  const gIds: string[] = [];
  for (const r of rows) {
    const x = r.reflection;
    problems += x.selected; nothing += x.nothing.length;
    const nu = nothingUsdOf(r);
    usd += r.usd ?? 0; nothingUsd += nu;
    if (r.replan) replans++;
    if (r.rebuilt) rebuilt++;
    if (r.missUnknown) missUnknown++;
    for (const f of x.found) for (const k of f.kinds) byKind[k]++;
    for (const f of [...x.found, ...x.nothing]) { const e = idle.get(f.id) ?? { times: 0, found: 0 }; e.times++; if (f.kinds.length) e.found++; idle.set(f.id, e); }
    const gs = [...x.found, ...x.nothing].filter((f) => f.role === "guard");
    gAdded += gs.length;
    for (const g of gs) if (g.kinds.length) { gFound++; gIds.push(g.id); for (const k of g.kinds) gk[k]++; }
    const o = owners.get(r.owner) ?? { owner: r.owner, jobs: 0, problems: 0, nothing: 0, usd: 0, nothingUsd: 0 };
    o.jobs++; o.problems += x.selected; o.nothing += x.nothing.length; o.usd += r.usd ?? 0; o.nothingUsd += nu;
    owners.set(r.owner, o);
  }
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  return {
    from: range.from, to: range.to, jobs: rows.length, rebuilt, missUnknown,
    problems, nothing, nothingRate: problems ? Math.round((nothing / problems) * 1000) / 1000 : null,
    usd: r4(usd), nothingUsd: r4(nothingUsd), byKind,
    byOwner: [...owners.values()].map((o) => ({ ...o, usd: r4(o.usd), nothingUsd: r4(o.nothingUsd) })).sort((a, b) => b.usd - a.usd || b.jobs - a.jobs),
    guards: { added: gAdded, found: gFound, kinds: gk, ids: uniq(gIds) },
    replans,
    idleIds: [...idle.entries()].filter(([, e]) => e.found === 0 && e.times >= 2).map(([id, e]) => ({ id, times: e.times })).sort((a, b) => b.times - a.times || a.id.localeCompare(b.id)).slice(0, 15),
  };
}

const pct = (n: number | null) => (n == null ? "-" : `${Math.round(n * 100)}%`);
export function weeklyMarkdown(s: WeeklySummary): string {
  const L: string[] = [];
  L.push(`# 試験の振り返り（週）${s.from.slice(0, 10)}〜${s.to.slice(0, 10)}`);
  L.push("");
  L.push(`- 一言: 依頼 ${s.jobs}本・選んだ問題 ${s.problems}問のうち何も見つけなかった ${s.nothing}問（${pct(s.nothingRate)}）・費用 $${s.usd.toFixed(2)}（何も見つけなかった問題の分の見込み $${s.nothingUsd.toFixed(2)}）・守り ${s.guards.found}/${s.guards.added}問が見つけた・決め直しの案 ${s.replans}本`);
  L.push(`- 見つけた中身: ${(Object.keys(FIND_LABEL) as FindKind[]).map((k) => `${FIND_LABEL[k]} ${s.byKind[k]}`).join("・")}`);
  if (s.rebuilt) L.push(`- ${s.rebuilt}本は振り返りの記録が無い古い結果から作り直した（外れは missStages・守りは done の依頼から）${s.missUnknown ? `・うち ${s.missUnknown}本は missStages の欄が無い＝外れを数えられない（何も見つけなかった割合は多めに出る）` : ""}`);
  L.push("");
  L.push("## 作業員ごと");
  L.push("| 作業員 | 依頼 | 問題 | 何も見つけなかった | 費用 | うち何も見つけなかった分 |");
  L.push("|---|---|---|---|---|---|");
  for (const o of s.byOwner) L.push(`| ${o.owner} | ${o.jobs} | ${o.problems} | ${o.nothing}（${pct(o.problems ? o.nothing / o.problems : null)}） | $${o.usd.toFixed(2)} | $${o.nothingUsd.toFixed(2)} |`);
  L.push("");
  L.push("## 守り（EXAM_AUTO_GUARDS）");
  L.push(`- 足した ${s.guards.added}問・見つけた ${s.guards.found}問${s.guards.found ? `（${(Object.keys(FIND_LABEL) as FindKind[]).filter((k) => s.guards.kinds[k]).map((k) => `${FIND_LABEL[k]} ${s.guards.kinds[k]}`).join("・")}・${s.guards.ids.join(",")}）` : ""}`);
  if (s.idleIds.length) {
    L.push("");
    L.push("## 何度選んでも何も見つけなかった問題（選び方を見直す候補）");
    L.push(s.idleIds.map((x) => `${x.id}×${x.times}`).join("・"));
  }
  return L.join("\n") + "\n";
}
