// scripts/lib/compose-prod-window.ts — 文の当たりの本番の物差しの「誰の番を見るか」と「直した物の前後の窓」（純関数・DB も LLM も使わない）
//   2026-11-19 作業員H（統括役の頼み・昼）: compose-prod-daily は竹内さん本人の番だけ（直近7日で6番）で、昨夜の直しの効きが測れない。
//   ①書き手の切り口（既定 takeuchi のまま・all＝AIX でないスタッフの返信全部・名前の並び）②直した物ごとに on の前と後の窓で比べる
export type WriterMode = "takeuchi" | "all" | { names: string[] };

/** --writers=<takeuchi|all|名前,名前> を読む（無い・空は takeuchi＝今まで通り） */
export function parseWriters(v: string | null | undefined): WriterMode {
  const s = String(v ?? "").trim();
  if (!s || s === "takeuchi") return "takeuchi";
  if (s === "all") return "all";
  const names = s.split(",").map((x) => x.trim()).filter(Boolean);
  return names.length ? { names } : "takeuchi";
}
/** その番を数えるか。AIX の通は数えない（AIX は文の物差しの外）。all は書き手が分からない番も数える（スタッフが手で送った返信） */
export function writerMatches(m: { writer: string | null; aix: boolean } | null, mode: WriterMode): boolean {
  if (!m || m.aix) return false;
  if (mode === "takeuchi") return m.writer === "takeuchi";
  if (mode === "all") return true;
  return !!m.writer && mode.names.includes(m.writer);
}
export function writersLabel(mode: WriterMode): string {
  return mode === "takeuchi" ? "竹内さん本人" : mode === "all" ? "スタッフ全員（AIX でない返信）" : `書き手 ${mode.names.join("・")}`;
}

export type FixSpec = { name: string; atMs: number };
/** --fix=<名前>@<日時>（日時は ISO・時差が無ければ JST とみる）。読めない物は捨てて理由を返す */
export function parseFix(v: string): FixSpec | { error: string } {
  const i = v.lastIndexOf("@");
  if (i <= 0) return { error: `--fix=${v}: 名前@日時 の形で` };
  const name = v.slice(0, i).trim(), at = v.slice(i + 1).trim();
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(at) ? at : `${at.length <= 10 ? `${at}T00:00:00` : at}+09:00`;
  const ms = Date.parse(iso);
  if (!name || !Number.isFinite(ms)) return { error: `--fix=${v}: 日時が読めない` };
  return { name, atMs: ms };
}
/**
 * on の前と後の窓。後の窓は今で切る（on から今までが短ければ、前の窓も同じ長さにそろえる＝比べる長さを同じにする）。
 * 後の窓が minHours より短い時は「まだ測れない」（null）
 */
export function windowsAround(fix: FixSpec, days: number, nowMs: number, minHours = 6): { before: [number, number]; after: [number, number]; spanH: number } | null {
  const want = days * 86_400_000;
  const span = Math.min(want, nowMs - fix.atMs);
  if (span < minHours * 3_600_000) return null;
  return { before: [fix.atMs - span, fix.atMs], after: [fix.atMs, fix.atMs + span], spanH: Math.round(span / 3_600_000) };
}
