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
export type DictSwitch = { sw: string; needs: string[]; testable: boolean; why: string; withMaterial: string[]; hit: string[]; none: string[] };
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
}): ExamDictionary {
  const unit = i.unitUsd ?? 0.03;
  const problems: Record<string, DictProblem> = {};
  for (const p of i.problems) {
    const obs = i.obsOf(p.id);
    const lastObs = [...obs].sort((a, b) => a.at.localeCompare(b.at)).pop();
    problems[p.id] = { id: p.id, type: String(p.type ?? ""), scene: String(p.sub ?? "").split(":")[0] || "-", materials: materialsOf(p, i.priorOf?.(p.id) ?? null), flake: flakeOf(obs), last: { pass: lastObs ? /\|○/.test(lastObs.sig) : null, at: lastObs?.at ?? null }, unitUsd: unit };
  }
  const switches: Record<string, DictSwitch> = {};
  const names = new Set([...Object.keys(i.reach), ...Object.keys(i.learned ?? {})]);
  for (const sw of names) {
    const needs = i.reach[sw]?.needs ?? [];
    const withMaterial = needs.length ? Object.values(problems).filter((p) => needs.some((t) => (p.materials[t] ?? 0) > 0)).map((p) => p.id) : [];
    const lp = i.learned?.[sw]?.problems ?? {};
    const hit = Object.entries(lp).filter(([, v]) => v?.v === "hit").map(([k]) => k), none = Object.entries(lp).filter(([, v]) => v?.v === "none").map(([k]) => k);
    const testable = !needs.length || withMaterial.length > 0;
    const why = !needs.length ? "要る材料の行が表に無い（印・指示文で見る・写しでは決められない）" : withMaterial.length ? `要る材料（${needs.join("・")}）が写しにある問題 ${withMaterial.length}` : `試験できない・先に写し（db-snapshot）: 要る材料（${needs.join("・")}）がどの問題の写しにも無い`;
    switches[sw] = { sw, needs, testable, why, withMaterial, hit, none };
  }
  return { v: 1, builtAt: i.builtAt ?? new Date().toISOString(), problems, switches };
}
/** 選び（純関数）: on にするスイッチの組と積む問題 → 残す・外す（材料なし・前に効かなかった・揺れ）・試験できないスイッチ。守りは触らない */
export function dictSelect(d: ExamDictionary, onSwitches: readonly string[], ids: readonly string[], guards: readonly string[] = []): { keep: string[]; dropNoMaterial: string[]; dropNone: string[]; flaky: string[]; untestable: string[]; line: string } {
  const g = new Set(guards);
  const sws = onSwitches.map((s) => d.switches[s]).filter((x): x is DictSwitch => !!x);
  const untestable = sws.filter((s) => !s.testable).map((s) => s.sw);
  const judged = sws.filter((s) => s.needs.length && s.testable);
  const keep: string[] = [], dropNoMaterial: string[] = [], dropNone: string[] = [], flaky: string[] = [];
  for (const id of ids) {
    if (g.has(id)) { keep.push(id); continue; }
    const p = d.problems[id];
    if (p?.flake.flaky) flaky.push(id);
    if (judged.length && p && judged.every((s) => !s.withMaterial.includes(id))) { dropNoMaterial.push(id); continue; }
    if (sws.length && sws.every((s) => s.none.includes(id) && !s.hit.includes(id))) { dropNone.push(id); continue; }
    keep.push(id);
  }
  const line = `試験の辞書: 残す ${keep.length}・材料なし ${dropNoMaterial.length}・前に効かなかった ${dropNone.length}・揺れの大きい ${flaky.length}${untestable.length ? `・⚠ 試験できない（先に写し）: ${untestable.join(",")}` : ""}`;
  return { keep, dropNoMaterial, dropNone, flaky, untestable, line };
}
export function examDictionaryMode(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): "off" | "shadow" | "on" {
  const v = String(env.EXAM_DICTIONARY ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "shadow";
}
/** 物差し（純関数）: 前の晩の組に辞書を当てて、外れた問題の数・浮いた費用・比べられる問題（守りでない・揺れの小さい）の数の前後 */
export function dictEval(d: ExamDictionary, jobs: ReadonlyArray<{ label: string; switches: string[]; ids: string[]; guards?: string[]; usd: number; signal?: string[] }>): { jobs: number; dropped: number; savedUsd: number; comparableBefore: number; comparableAfter: number; missedSignals: number; untestableJobs: string[] } {
  let dropped = 0, saved = 0, cb = 0, ca = 0, missed = 0; const un: string[] = [];
  for (const j of jobs) {
    const s = dictSelect(d, j.switches, j.ids, j.guards ?? []);
    const drop = s.dropNoMaterial.length + s.dropNone.length;
    dropped += drop;
    missed += [...s.dropNoMaterial, ...s.dropNone].filter((x) => (j.signal ?? []).includes(x)).length; // 外した問題のうち、その晩に確かな悪化・良くなったが出た物（辞書の見落とし）
    if (j.ids.length) saved += (j.usd * drop) / j.ids.length;
    const comp = (xs: readonly string[]) => xs.filter((x) => !(j.guards ?? []).includes(x) && !d.problems[x]?.flake.flaky).length;
    cb += comp(j.ids); ca += comp(s.keep);
    if (s.untestable.length) un.push(j.label);
  }
  return { jobs: jobs.length, dropped, savedUsd: Math.round(saved * 1000) / 1000, comparableBefore: cb, comparableAfter: ca, missedSignals: missed, untestableJobs: un };
}
