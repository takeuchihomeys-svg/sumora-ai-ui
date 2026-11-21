// 2026-11-21 作業員H（統括役・竹内さん「試験もっと効率よく・試験とブレインと連携して最善の改善」）: 当たる問題だけ積む（2段目）の記録の口。
//   試験の1回の答え（ブレインの meta）に、連携の地図（app/lib/linkage-map.ts）の行のうち「材料が埋まった行」の id を残す。
//   これが貯まると「スイッチ → 地図の行（作る側のスイッチ・読む側の親のスイッチ） → その行が埋まった問題」が答えから自動で引ける。
//   LLM は使わない（meta にもう入っている物を見るだけ）。地図の fill が meta.xxx の行だけ（表の行は試験の会話では数えない）
import { LINKAGE_MAP, nonEmptyAt, type LinkageRow } from "../../app/lib/linkage-map";

/** meta で埋まった地図の行の id（fill.src="meta" の行だけ・並びは地図の順） */
export function filledRowsOf(meta: unknown, rows: ReadonlyArray<LinkageRow> = LINKAGE_MAP): string[] {
  if (!meta || typeof meta !== "object") return [];
  const out: string[] = [];
  for (const r of rows) {
    const f = r.fill as { src?: string; path?: string };
    if (f?.src !== "meta" || !f.path) continue;
    if (nonEmptyAt(meta, f.path)) out.push(r.id);
  }
  return out;
}

/** スイッチ → そのスイッチが作る側か読む側の親にある地図の行の id */
export function rowsOfSwitch(name: string, rows: ReadonlyArray<LinkageRow> = LINKAGE_MAP): string[] {
  return rows.filter((r) => r.switches.includes(name) || r.readerSwitches.includes(name)).map((r) => r.id);
}

/**
 * 答えの記録（問題ごとの filled の和）から、スイッチの当たる問題を選ぶ。
 *   地図に行が無いスイッチ・記録が無い問題は「分からない」＝落とさず残す（安全側）
 */
export function problemsHitBySwitches(switches: string[], filledById: Record<string, string[] | undefined>, candidates: string[], rows: ReadonlyArray<LinkageRow> = LINKAGE_MAP): { hit: string[]; unknown: string[]; skip: string[]; unmapped: string[] } {
  const want = new Set<string>(); const unmapped: string[] = [];
  for (const s of switches) { const ids = rowsOfSwitch(s, rows); if (!ids.length) unmapped.push(s); ids.forEach((i) => want.add(i)); }
  const hit: string[] = [], unknown: string[] = [], skip: string[] = [];
  for (const id of candidates) {
    const f = filledById[id];
    if (unmapped.length || !f) { unknown.push(id); continue; }
    if (f.some((r) => want.has(r))) hit.push(id); else skip.push(id);
  }
  return { hit, unknown, skip, unmapped };
}
