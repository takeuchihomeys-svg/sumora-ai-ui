// scripts/lib/count-verified.ts — 穴の型④「数え方の誤りで低く見える」の決め（純関数・作業員N2・2026-11-21・台帳 #505）
//
// 統括役 11/21 の5つの型の④。毎日の数（quality_daily）を書く数えの台本ごとに、「実物1件で照らした日」の記録があるかを見る。
//   照らす＝数えが拾った（または落とした）実物の1件を開き、本当にそう数えるべきかを目で確かめる（数え方の誤りで低く・高く見えていないか）。
//   記録の置き場: 今ある表 quality_daily（新しい表・欄は作らない）。metric='count_verified:<数えの単位の鍵>'・scope='all'（scope は takeuchi・all・draft・employee だけの決まりがある）・day=照らした日（JST）・
//     value=1（数えと実物が合った）／0（ズレがあった＝数え方を直す）・n=照らした件数・detail={ metric, conv（会話の id の頭8字）, note, by }
//   単位: 台本1本（台本が変わったら照らし直し）。self-improve の中で数える物は「scripts/self-improve.ts#<metric の頭2つ>」（30日で照らし直し）
//   穴: never（一度も照らしていない）・mismatch（最後に照らした時ズレ＝直していない）・changed（照らした後に台本が変わった）・old（# の単位で30日を超えた）

export type CountUnit = { key: string; script: string; owner: string; metrics: string[] };
export type Verif = { scope: string; day: string; value: number | null };
export type UnverifiedKind = "never" | "mismatch" | "changed" | "old";
export type Unverified = CountUnit & { kind: UnverifiedKind; lastVerified: string | null; lastChange: string | null };

export const VERIFY_METRIC = "count_verified";
/** 照らした日の記録の metric（count_verified:<単位の鍵>） */
export const verifyMetricOf = (unit: string) => `${VERIFY_METRIC}:${unit}`;
export const VERIFY_OLD_DAYS = 30;

/** metric の頭2つ（core:window_miss:brain.msg → core:window_miss） */
export const familyOf = (metric: string) => metric.split(":").slice(0, 2).join(":");

/** metric ごとに本当に数えている台本（self-improve が呼んで書く物・統括役 11/21 の時点） */
export const METRIC_SCRIPT: Record<string, { script: string; owner: string }> = {
  "growth:pickup_via_tool": { script: "scripts/audit-appeal-vs-codes.ts", owner: "作業員K2" },
  "growth:appeal_text_only": { script: "scripts/audit-appeal-vs-codes.ts", owner: "作業員K2" },
  "growth:combo": { script: "scripts/lib/combo-daily.ts", owner: "作業員M" },
  "growth:ask": { script: "scripts/lib/ask-route-of.ts", owner: "作業員M" },
  "core:linkage": { script: "scripts/check-linkage.ts", owner: "作業員N" },
  "core:no_denominator": { script: "scripts/check-linkage.ts", owner: "作業員N" },
  "core:foundation": { script: "scripts/check-foundation.ts", owner: "作業員N" },
  "core:stale": { script: "scripts/check-stale.ts", owner: "作業員N" },
  "core:cron_no_log": { script: "scripts/check-stale.ts", owner: "作業員N" },
  "core:subdivide": { script: "scripts/owner-feedback-check.ts", owner: "作業員N" },
  "core:conductor": { script: "scripts/check-conductor.ts", owner: "作業員N" },
  "core:conductor_aix": { script: "scripts/check-conductor.ts", owner: "作業員N" },
  "core:conductor_sway": { script: "scripts/check-conductor.ts", owner: "作業員N" },
  "core:window_miss": { script: "scripts/check-windows.ts", owner: "作業員N" },
  "core:count_unverified": { script: "scripts/check-count-verified.ts", owner: "作業員N" },
  "core:off_path": { script: "scripts/check-off-path.ts", owner: "作業員N" },
  found: { script: "scripts/foundation-fill.ts", owner: "作業員N" },
  check_gaps: { script: "scripts/owner-feedback-check.ts", owner: "作業員N" },
  "growth:writer_link": { script: "scripts/audit-writer-linkage.ts", owner: "作業員L" },
};
const SOURCE_OWNER: Array<[RegExp, string]> = [[/image-/, "作業員G"], [/appeal|aix-/, "作業員K2"], [/self-improve|check-|foundation/, "作業員N"]];
const LINE_WATCH_EVAL = "app/api/cron/line-watch-eval/route.ts";

/** quality_daily の (metric, source) から数えの単位（純関数） */
export function unitOf(metric: string, source: string | null): { key: string; script: string; owner: string } | null {
  const fam = familyOf(metric);
  const m = METRIC_SCRIPT[fam] ?? METRIC_SCRIPT[metric] ?? METRIC_SCRIPT[metric.split(":")[0]];
  if (m) return { key: m.script, ...m };
  if (!source) return null;
  if (source === "line-watch-eval") return { key: LINE_WATCH_EVAL, script: LINE_WATCH_EVAL, owner: "統括役" };
  const script = source.split(/\s+/)[0];
  const owner = SOURCE_OWNER.find(([re]) => re.test(script))?.[1] ?? "統括役";
  if (script === "scripts/self-improve.ts") return { key: `${script}#${fam}`, script, owner };
  return { key: script, script, owner };
}

/** 単位をまとめる（純関数） */
export function unitsOf(rows: ReadonlyArray<{ metric: string; source: string | null }>, extra: ReadonlyArray<{ script: string; owner: string; metric: string | null }> = []): CountUnit[] {
  const by = new Map<string, CountUnit>();
  const put = (u: { key: string; script: string; owner: string }, metric: string | null) => {
    const cur = by.get(u.key) ?? { ...u, metrics: [] };
    if (metric && !cur.metrics.includes(metric)) cur.metrics.push(metric);
    by.set(u.key, cur);
  };
  for (const r of rows) { if (r.metric === VERIFY_METRIC || r.metric.startsWith(`${VERIFY_METRIC}:`)) continue; const u = unitOf(r.metric, r.source); if (u) put(u, r.metric); }
  for (const e of extra) put({ key: e.script, script: e.script, owner: e.owner }, e.metric);
  return [...by.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

/** 照らしていない単位（純関数）。lastChangeOf は台本の最後のコミットの日（YYYY-MM-DD）・分からなければ null */
export function unverifiedOf(units: ReadonlyArray<CountUnit>, verifs: ReadonlyArray<Verif>, lastChangeOf: (script: string) => string | null, todayJst: string): Unverified[] {
  const latest = new Map<string, Verif>();
  for (const v of verifs) { const cur = latest.get(v.scope); if (!cur || v.day > cur.day) latest.set(v.scope, v); }
  const out: Unverified[] = [];
  for (const u of units) {
    const v = latest.get(u.key) ?? null;
    const lc = u.key.includes("#") ? null : lastChangeOf(u.script);
    const base = { ...u, lastVerified: v?.day ?? null, lastChange: lc };
    if (!v) out.push({ ...base, kind: "never" });
    else if (v.value === 0) out.push({ ...base, kind: "mismatch" });
    else if (lc && lc > v.day) out.push({ ...base, kind: "changed" });
    else if (u.key.includes("#") && daysBetween(v.day, todayJst) > VERIFY_OLD_DAYS) out.push({ ...base, kind: "old" });
  }
  return out;
}

export const UNVERIFIED_JA: Record<UnverifiedKind, string> = { never: "実物1件で一度も照らしていない", mismatch: "最後に照らした時ズレがあった（直していない）", changed: "照らした後に台本が変わった", old: `照らしてから${VERIFY_OLD_DAYS}日を超えた` };

/** 台帳に足す行（純関数）: 一度も照らしていない物は持ち主ごとに1行（台本の名前を並べる）・ズレ／変わった／古い物は単位ごとに1行 */
export function countGapsForLedger(us: ReadonlyArray<Unverified>): Array<{ title: string; owner: string; priority: number; next: string }> {
  const rec = (k: string) => `scripts/check-count-verified.ts --record --unit=${k} --ok（ズレなら --off）`;
  const out: Array<{ title: string; owner: string; priority: number; next: string }> = [];
  const never = new Map<string, Unverified[]>();
  for (const u of us) if (u.kind === "never") never.set(u.owner, [...(never.get(u.owner) ?? []), u]);
  for (const [owner, xs] of never) out.push({ title: `数え方を実物で照らしていない: ${owner} の数えの台本`, owner, priority: 30, next: `check-count-verified（穴の型④）: ${UNVERIFIED_JA.never} ${xs.length}本（${xs.map((x) => x.key.replace(/^scripts\//, "")).join("・").slice(0, 220)}）・1本ずつ、数えが拾った／落とした実物を1件開いて確かめ ${rec("<台本>")} で記録（台帳 #505）` });
  for (const u of us.filter((x) => x.kind !== "never")) out.push({ title: `数え方を実物で照らしていない: ${u.key}`, owner: u.owner, priority: u.kind === "mismatch" ? 10 : 30, next: `check-count-verified（穴の型④）: ${UNVERIFIED_JA[u.kind]}・数 ${u.metrics.slice(0, 5).join("・")}・実物を1件開いて確かめ ${rec(u.key)}（台帳 #505）` });
  return out;
}
