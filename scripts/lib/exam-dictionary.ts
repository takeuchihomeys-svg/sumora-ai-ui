// scripts/lib/exam-dictionary.ts — 台帳 #803 の「試験の辞書」（純関数・LLM なし・DB なし）
// 2026-11-27 作業員L（竹内さん 11/27「試験の辞書のようなのはあるのか／作れば費用おさえられるのでは」・統括役の割り振り）:
//   ばらばらにある物（問題の定義 problems.json・スイッチの要る材料 SWITCH_REACH・前の on の回の覚え learned-reach.json・問題ごとの揺れ brain-exam-flake）を
//   1つの表にまとめる。① スイッチごと: 要る材料 → その材料が問題の写し（db-snapshot＝problems.json の ledger・前の回の ledger.inserted）に有る問題 → 前に効いた／効かなかった問題。
//   材料が写しに1問も無いスイッチは「試験できない・先に写し（db-snapshot）」。② 問題ごと: 場面・型・揺れ（独立の観測の何回中何回同じか）・前回の結果・1回の費用・載っている材料。
//   ③ 選び（dictSelect）: 効く問題だけ・揺れの小さい問題だけ。既定は記録だけ（EXAM_DICTIONARY=shadow）＝係は1行出すだけで外さない。悪化0を見てから on（選びに使う）。
//   置き場: 問題の定義は git のファイルのまま。毎晩変わる数は <exam-cache>/exam-dictionary.json（DB の exam_runs と重ねない）。
export type DictProblemIn = { id: string; type?: string; sub?: string; ledger?: Record<string, unknown> | null };
export type DictObs = { sig: string; at: string; independent?: boolean; model?: string; codeKey?: string };
export type DictProblem = { id: string; type: string; scene: string; materials: Record<string, number>; flake: { n: number; same: number; share: number | null; flaky: boolean }; last: { pass: boolean | null; at: string | null }; unitUsd: number };
export type DictMark = { mark: string; source: "手" | "推定"; n: number };
export type DictSwitch = { sw: string; needs: string[]; testable: boolean; why: string; withMaterial: string[]; hit: string[]; none: string[];
  /** 2026-11-27: 部品の材料の印（手＝SWITCH_REACH.mark・SWITCH_TARGET_MARK／推定＝前の on の回だけに出て off の回に出ない印） */ marks?: DictMark[];
  /** 前の on の回の行がある問題・そのうち印が出た問題（届いた） */ ranOn?: string[]; marked?: string[];
  /** 写しの欄（作業員A の SNAPSHOT_NEED）で決めたか */ snapshotRule?: boolean };
/** 2026-11-27 作業員L（統括役の頼み・#683 の考え方）: 前の回の結果から スイッチ→材料の印 を推定（純関数）。
 *   on の回（そのスイッチを on にした回・同時に on のスイッチが maxCo 以下）の行に出た印のうち、同じ問題の off の回（main の答え）に一度も出ない印を、
 *   その問題の数で数え、minN 問以上の印を「推定」にする。手で書いた行（SWITCH_REACH.mark 等）は別に「手」で持つ */
export type InferRun = { switches: readonly string[]; rows: ReadonlyArray<{ id: string; marks: readonly string[] }> };
export function inferSwitchMarks(runs: readonly InferRun[], offMarksOf: (id: string) => ReadonlySet<string>, o: { minN?: number; maxCo?: number } = {}): Record<string, DictMark[]> {
  const minN = o.minN ?? 2, maxCo = o.maxCo ?? 3;
  const by = new Map<string, Map<string, Set<string>>>();
  for (const r of runs) {
    if (!r.switches.length || r.switches.length > maxCo) continue;
    for (const sw of r.switches) {
      const m = by.get(sw) ?? new Map<string, Set<string>>();
      for (const row of r.rows) { const off = offMarksOf(row.id); for (const k of row.marks) { if (off.has(k)) continue; const ids = m.get(k) ?? new Set<string>(); ids.add(row.id); m.set(k, ids); } }
      by.set(sw, m);
    }
  }
  const out: Record<string, DictMark[]> = {};
  for (const [sw, m] of by) { const xs = [...m].filter(([, ids]) => ids.size >= minN).map(([mark, ids]) => ({ mark, source: "推定" as const, n: ids.size })).sort((a, b) => b.n - a.n).slice(0, 3); if (xs.length) out[sw] = xs; }
  return out;
}
/** 届いたかの関所（作業員A の reachGateOf と同じ考え・辞書の印で）: on の回の行で、スイッチの印（手も推定も）が出た問題だけを比べる。minReached 未満は「届かず」・印の無いスイッチは「印なし」 */
export function dictReachGate(d: ExamDictionary, sw: string, onRows: ReadonlyArray<{ id: string; marks: Record<string, unknown> | null | undefined }>, targets: readonly string[], minReached = 3): { marks: string[]; reached: string[]; notReached: string[]; verdict: "比べる" | "届かず" | "印なし" } {
  const marks = (d.switches[sw]?.marks ?? []).map((m) => m.mark);
  if (!marks.length) return { marks, reached: [], notReached: [...targets], verdict: "印なし" };
  const reached = targets.filter((id) => onRows.some((r) => r.id === id && marks.some((k) => Number((r.marks ?? {})[k] ?? 0) > 0)));
  return { marks, reached, notReached: targets.filter((id) => !reached.includes(id)), verdict: reached.length >= minReached ? "比べる" : "届かず" };
}
export type ExamDictionary = { v: 1; builtAt: string; problems: Record<string, DictProblem>; switches: Record<string, DictSwitch> };

/** 揺れが大きい＝同じコードの版・同じモデルの独立の観測が 3回以上あり、一番多い答えが 2/3 未満（版の違う観測を混ぜると直しの差を揺れと数える＝一番観測の多い版×モデルの組で見る） */
export const FLAKY_MIN_OBS = 3, FLAKY_SHARE = 2 / 3;
export function flakeOf(obs: readonly DictObs[]): DictProblem["flake"] {
  const ind = obs.filter((o) => o.independent !== false);
  const groups = new Map<string, DictObs[]>(); for (const o of ind) { const k = `${o.codeKey ?? ""}|${o.model ?? ""}`; groups.set(k, [...(groups.get(k) ?? []), o]); }
  const xs = [...groups.values()].sort((a, b) => b.length - a.length || (b[b.length - 1]?.at ?? "").localeCompare(a[a.length - 1]?.at ?? ""))[0] ?? [];
  const c = new Map<string, number>(); for (const o of xs) c.set(o.sig, (c.get(o.sig) ?? 0) + 1);
  const same = Math.max(0, ...c.values());
  const share = xs.length ? Math.round((same / xs.length) * 100) / 100 : null;
  return { n: xs.length, same, share, flaky: xs.length >= FLAKY_MIN_OBS && share != null && share < FLAKY_SHARE };
}
/** 問題の写しの材料（problems.json の ledger の表ごとの行の数と、前の回の ledger.inserted の大きい方） */
export function materialsOf(p: DictProblemIn, prior?: Record<string, number> | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p.ledger ?? {})) { const n = Array.isArray(v) ? v.length : 0; if (n) out[k] = n; }
  for (const [k, v] of Object.entries(prior ?? {})) { const n = Number(v) || 0; if (n > (out[k] ?? 0)) out[k] = n; }
  return out;
}
export function buildDictionary(i: {
  problems: readonly DictProblemIn[]; reach: Record<string, { needs?: string[] }>; learned?: Record<string, { problems?: Record<string, { v?: string }> }> | null;
  obsOf: (id: string) => readonly DictObs[]; priorOf?: (id: string) => Record<string, number> | null; unitUsd?: number; builtAt?: string;
  /** 2026-11-27: 手の印・推定の印・前の on の回（スイッチ→問題→印が出たか）・写しの欄（作業員A） */
  handMarks?: Record<string, string>; inferred?: Record<string, DictMark[]>; onRuns?: Record<string, Record<string, boolean>>;
  snapshotRule?: (sw: string, ledger: Record<string, unknown> | null | undefined) => boolean | null;
}): ExamDictionary {
  const unit = i.unitUsd ?? 0.03;
  const problems: Record<string, DictProblem> = {};
  for (const p of i.problems) {
    const obs = i.obsOf(p.id);
    const lastObs = [...obs].sort((a, b) => a.at.localeCompare(b.at)).pop();
    problems[p.id] = { id: p.id, type: String(p.type ?? ""), scene: String(p.sub ?? "").split(":")[0] || "-", materials: materialsOf(p, i.priorOf?.(p.id) ?? null), flake: flakeOf(obs), last: { pass: lastObs ? /\|○/.test(lastObs.sig) : null, at: lastObs?.at ?? null }, unitUsd: unit };
  }
  const switches: Record<string, DictSwitch> = {};
  const names = new Set([...Object.keys(i.reach), ...Object.keys(i.learned ?? {}), ...Object.keys(i.handMarks ?? {}), ...Object.keys(i.inferred ?? {}), ...Object.keys(i.onRuns ?? {})]);
  for (const sw of names) {
    const needs = i.reach[sw]?.needs ?? [];
    const ledgerOf = new Map(i.problems.map((p) => [p.id, p.ledger ?? null]));
    const snap = i.snapshotRule ? Object.values(problems).map((p) => ({ id: p.id, has: i.snapshotRule!(sw, ledgerOf.get(p.id)) })) : [];
    const snapshotRule = snap.some((x) => x.has != null);
    const withMaterial = snapshotRule ? snap.filter((x) => x.has).map((x) => x.id) : needs.length ? Object.values(problems).filter((p) => needs.some((t) => (p.materials[t] ?? 0) > 0)).map((p) => p.id) : [];
    const lp = i.learned?.[sw]?.problems ?? {};
    const hit = Object.entries(lp).filter(([, v]) => v?.v === "hit").map(([k]) => k), none = Object.entries(lp).filter(([, v]) => v?.v === "none").map(([k]) => k);
    const hand = i.handMarks?.[sw];
    const marks: DictMark[] = [...(hand ? [{ mark: hand, source: "手" as const, n: 0 }] : []), ...(i.inferred?.[sw] ?? []).filter((m) => m.mark !== hand)];
    const runs = i.onRuns?.[sw] ?? {};
    const ranOn = Object.keys(runs), marked = ranOn.filter((id) => runs[id]);
    const hasRule = needs.length > 0 || snapshotRule;
    const testable = !hasRule || withMaterial.length > 0;
    const why = !hasRule ? "要る材料の行が表に無い（印・指示文で見る・写しでは決められない）" : withMaterial.length ? `要る材料（${needs.join("・")}）が写しにある問題 ${withMaterial.length}` : `試験できない・先に写し（db-snapshot）: 要る材料（${needs.join("・")}）がどの問題の写しにも無い`;
    switches[sw] = { sw, needs, testable, why: snapshotRule && !withMaterial.length ? "試験できない・先に写し（db-snapshot）: 写しの欄（SNAPSHOT_NEED）に合う行がどの問題にも無い" : why, withMaterial, hit, none, marks, ranOn, marked, snapshotRule };
  }
  return { v: 1, builtAt: i.builtAt ?? new Date().toISOString(), problems, switches };
}
/** 選び（純関数）: on にするスイッチの組と積む問題 → 残す・外す（材料なし・前に効かなかった・揺れ）・試験できないスイッチ。守りは触らない */
export function dictSelect(d: ExamDictionary, onSwitches: readonly string[], ids: readonly string[], guards: readonly string[] = []): { keep: string[]; dropNoMaterial: string[]; dropNone: string[]; dropNoReach: string[]; flaky: string[]; untestable: string[]; line: string } {
  const g = new Set(guards);
  const sws = onSwitches.map((s) => d.switches[s]).filter((x): x is DictSwitch => !!x);
  const untestable = sws.filter((s) => !s.testable).map((s) => s.sw);
  const judged = sws.filter((s) => (s.needs.length || s.snapshotRule) && s.testable);
  const withMarks = sws.filter((s) => (s.marks ?? []).length);
  const keep: string[] = [], dropNoMaterial: string[] = [], dropNone: string[] = [], dropNoReach: string[] = [], flaky: string[] = [];
  for (const id of ids) {
    if (g.has(id)) { keep.push(id); continue; }
    const p = d.problems[id];
    if (p?.flake.flaky) flaky.push(id);
    if (judged.length && p && judged.every((s) => !s.withMaterial.includes(id))) { dropNoMaterial.push(id); continue; }
    if (sws.length && sws.every((s) => s.none.includes(id) && !s.hit.includes(id))) { dropNone.push(id); continue; }
    // 2026-11-27: 前の on の回で走ったのに、どのスイッチの印も一度も出なかった問題（場面が立たない＝材料が有っても部品が動かない・q472 の型）。前の回が無い問題は残す。
    //   統括役の決め①: 外さずに守り（1回・悪化の見張り）に回す＝比べる数からは外すが、思わぬ悪化を拾う役は残す（dropNoReach＝守りに回す問題・keep にも入る）
    if (withMarks.length && withMarks.every((s) => (s.ranOn ?? []).includes(id) && !(s.marked ?? []).includes(id))) { dropNoReach.push(id); keep.push(id); continue; }
    keep.push(id);
  }
  const line = `試験の辞書: 残す ${keep.length}・材料なし ${dropNoMaterial.length}・前に効かなかった ${dropNone.length}・前の on で届かなかった＝守りに回す ${dropNoReach.length}・揺れの大きい ${flaky.length}${untestable.length ? `・⚠ 試験できない（先に写し）: ${untestable.join(",")}` : ""}`;
  return { keep, dropNoMaterial, dropNone, dropNoReach, flaky, untestable, line };
}
export function examDictionaryMode(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): "off" | "shadow" | "on" {
  const v = String(env.EXAM_DICTIONARY ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "shadow";
}
/** 物差し（純関数）: 前の晩の組に辞書を当てて、外れた問題の数・浮いた費用・比べられる問題（守りでない・揺れの小さい）の数の前後 */
export function dictEval(d: ExamDictionary, jobs: ReadonlyArray<{ label: string; switches: string[]; ids: string[]; guards?: string[]; usd: number; signal?: string[] }>): { jobs: number; dropped: number; toGuard: number; savedUsd: number; comparableBefore: number; comparableAfter: number; watchedAfter: number; missedSignals: number; untestableJobs: string[] } {
  let dropped = 0, toGuard = 0, saved = 0, cb = 0, ca = 0, wa = 0, missed = 0; const un: string[] = [];
  for (const j of jobs) {
    const s = dictSelect(d, j.switches, j.ids, j.guards ?? []);
    const drop = s.dropNoMaterial.length + s.dropNone.length;
    dropped += drop; toGuard += s.dropNoReach.length;
    missed += [...s.dropNoMaterial, ...s.dropNone].filter((x) => (j.signal ?? []).includes(x)).length; // 外した問題のうち、その晩に確かな悪化・良くなったが出た物（辞書の見落とし）
    // 守りに回す問題は1回だけ（ふつうは3回）＝その問題の費用の 2/3 が浮く見込み
    if (j.ids.length) saved += (j.usd * (drop + s.dropNoReach.length * (2 / 3))) / j.ids.length;
    const comp = (xs: readonly string[]) => xs.filter((x) => !(j.guards ?? []).includes(x) && !d.problems[x]?.flake.flaky).length;
    cb += comp(j.ids); ca += comp(s.keep.filter((x) => !s.dropNoReach.includes(x))); wa += comp(s.keep);
    if (s.untestable.length) un.push(j.label);
  }
  return { jobs: jobs.length, dropped, toGuard, savedUsd: Math.round(saved * 1000) / 1000, comparableBefore: cb, comparableAfter: ca, watchedAfter: wa, missedSignals: missed, untestableJobs: un };
}
