// scripts/lib/situation-check.ts — 現状把握の物差し（台帳 #17・竹内さん 11/15「文の中身9割への土台」）: ブレインが番ごとに持っていた今の状況の数が、実物と合っているか（純関数）
//
// 2026-11-23 作業員L（統括役の割り振り・今日の型＝地図の根）。根の名前（作業員P の地図と合わせる・相談中）: situation:match
//   番＝竹内さん本人の番（見張りの番の staff_writer=takeuchi）の、こちらの送信の直前の一番新しい判断の記録の digest.sn（situation-now.situationNowDigest の数）。
//   実物＝その判断の時刻までの DB の決まった線で数え直した数（呼ぶ側が読む）:
//     po（開いている約束）… 行動台帳の約束の行で closed_by が無く・後に同じ種類の済みが無い物（situation-now.promises_open と同じ線）
//     tv（帳面の内覧の予定）… カレンダーの時刻がある予定（60日の内・判断の時刻までに作られた行）
//   外れの型: ok（同じ数）・under（帳面が実物より少ない＝拾い落とし）・over（帳面が実物より多い＝閉じたのを知らない・古い）
//   原因（P の地図と同じ鍵）: under → material（帳面に届いていない）・over → counting（数え方・閉じ方が実物とずれる）
export const SITUATION_MAP_ROOT = "situation:match";
export const SITUATION_FIELDS = ["po", "tv"] as const;
export type SituationField = typeof SITUATION_FIELDS[number];
export const SITUATION_FIELD_JA: Record<SituationField, string> = { po: "開いている約束の数", tv: "帳面の内覧の予定の数" };
export type SituationMiss = "ok" | "under" | "over";
export const SITUATION_MISS_JA: Record<SituationMiss, string> = { ok: "実物と合う", under: "帳面が少ない（拾い落とし）", over: "帳面が多い（閉じたのを知らない・古い）" };
export type SituationCheckRow = { id: string; scene: string; field: SituationField; got: number; truth: number };
export type SituationTurn = { id: string; kind: SituationField; scene: string; miss: SituationMiss; cause: "material" | "counting" | null };
export function situationMissOf(got: number, truth: number): SituationMiss {
  return got === truth ? "ok" : got < truth ? "under" : "over";
}
/** digest.sn → 確かめる欄の数（無い欄は null） */
export function situationFieldsOf(sn: unknown): Partial<Record<SituationField, number>> {
  const o = (sn ?? {}) as Record<string, unknown>;
  const out: Partial<Record<SituationField, number>> = {};
  for (const f of SITUATION_FIELDS) if (typeof o[f] === "number") out[f] = o[f] as number;
  return out;
}
export function situationTurns(rows: ReadonlyArray<SituationCheckRow>): SituationTurn[] {
  return rows.map((r) => {
    const miss = situationMissOf(r.got, r.truth);
    return { id: `${r.id}:${r.field}`, kind: r.field, scene: r.scene || "other", miss, cause: miss === "ok" ? null : miss === "under" ? "material" : "counting" };
  });
}
export type SituationNode = { key: string; parent: string | null; depth: number; dim: "kind" | "scene" | "miss" | "cause" | null; val: string | null; n: number; ok: number; misses: number; value: number | null };
const pct1 = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
/** 木（欄 → 場面 → 外れの型 → 原因・P の地図と同じ形: 子を足すと親・一致の葉に原因の子は作らない） */
export function buildSituationTree(turns: ReadonlyArray<SituationTurn>, root = SITUATION_MAP_ROOT): SituationNode[] {
  const out: SituationNode[] = [];
  const dims: Array<"kind" | "scene" | "miss" | "cause"> = ["kind", "scene", "miss", "cause"];
  const walk = (rows: ReadonlyArray<SituationTurn>, key: string, parent: string | null, depth: number, dim: SituationNode["dim"], val: string | null) => {
    const ok = rows.filter((r) => r.miss === "ok").length;
    out.push({ key, parent, depth, dim, val, n: rows.length, ok, misses: rows.length - ok, value: pct1(ok, rows.length) });
    const next = dims[depth];
    if (!next || (next === "cause" && rows.every((r) => r.miss === "ok"))) return;
    const groups = new Map<string, SituationTurn[]>();
    for (const r of rows) { const v = String(r[next] ?? "-"); groups.set(v, [...(groups.get(v) ?? []), r]); }
    for (const [v, rs] of [...groups].sort((a, b) => b[1].length - a[1].length)) walk(rs, `${key}/${next}=${v}`, key, depth + 1, next, v);
  };
  walk(turns, root, null, 0, null, null);
  return out;
}
/** 実物の数（純関数・呼ぶ側が読んだ行で）: 開いている約束（situation-now と同じ線） */
const DONE_OF: Record<string, string> = { confirmation_promised: "confirmation_reported", pickup_declared: "properties_sent", estimate_declared: "estimate_sent" };
export function truthOpenPromises(facts: ReadonlyArray<{ kind: string; status: string; sent_at: string; detail?: { closed_by?: unknown } | null }>, atMs: number): number {
  const fs = facts.filter((f) => Date.parse(f.sent_at) <= atMs);
  // closed_by は結んだ済みの行の時刻（sent_at）を持つ＝判断の時刻より後に閉じた約束は、判断の時点では開いていた（今の値で見ると「帳面が多い」に誤って見える）
  const closedAt = (f: { detail?: { closed_by?: unknown } | null }) => { const c = f.detail?.closed_by as { sent_at?: string } | null | undefined; if (!c) return null; const t = c.sent_at ? Date.parse(c.sent_at) : NaN; return Number.isFinite(t) ? t : -Infinity; };
  return fs.filter((f) => { if (f.status !== "promised" || !DONE_OF[f.kind]) return false; const c = closedAt(f); if (c != null && c <= atMs) return false; return !fs.some((d) => d.status === "done" && d.kind === DONE_OF[f.kind] && d.sent_at > f.sent_at && Date.parse(d.sent_at) <= atMs); }).length;
}
/** 実物の数: 帳面の内覧の予定（カレンダーの時刻がある予定・60日の内・判断の時刻までに作られた行） */
export function truthTimedViewings(cal: ReadonlyArray<{ start_at: string | null; all_day: boolean | null; created_at: string }>, atMs: number): number {
  return cal.filter((c) => c.all_day === false && Date.parse(c.created_at) <= atMs && Date.parse(String(c.start_at)) >= atMs - 60 * 86_400_000).length;
}
