// scripts/lib/r11-table.ts — 11巡目: 小場面 × 差の型の一致率の表（本番の下書きの監査・YUMA の再生の採点で同じ物差し）
//   型（一致＝その型の差が無い）: 冒頭・挨拶・呼び名・受けの語・改行・！・絵文字・敬語（頂/致/如何 等の表記）・何卒・語尾・文の数（足した/消した）・順番・事実（数字）
//   完全＝文字が同じ／近い＝芯の Dice 0.8 以上／似＝芯の Dice の平均（app/lib/text-diff-types.ts）
import { diffTexts, type TextDiff } from "../../app/lib/text-diff-types";

export type TablePair = { sub: string; draft: string; staff: string; id?: string };
export const R11_TYPES = ["冒頭", "挨拶", "呼び名", "受けの語", "改行", "！", "絵文字", "敬語", "何卒", "語尾", "文の数", "順番", "事実"] as const;
export type R11Type = (typeof R11_TYPES)[number];
const NANITOZO_RE = /何卒/;
/** 敬語の表記（竹内さんの形: 頂・致・如何・下さい/ください は数えない） */
function keigoDiff(d: string, s: string): boolean {
  const pairs: Array<[RegExp, RegExp]> = [[/頂(?:き|け|く|いて)/, /いただ(?:き|け|く|いて)/], [/致し/, /いたし/], [/如何/, /いかが/], [/出来/, /でき(?:る|ます|次第|れ|ない|た)/]];
  return pairs.some(([a, b]) => (a.test(d) && !a.test(s) && b.test(s)) || (b.test(d) && !b.test(s) && a.test(s)));
}
export function r11TypesOf(d: TextDiff, draft: string, staff: string): Set<R11Type> {
  const t = new Set<R11Type>();
  const has = (x: string) => d.types.includes(x as never);
  if (has("opener")) t.add("冒頭");
  if (has("greeting")) t.add("挨拶");
  if (has("name_call")) t.add("呼び名");
  if (has("ack_word")) t.add("受けの語");
  if (has("newline")) t.add("改行");
  if (has("exclaim")) t.add("！");
  if (has("emoji")) t.add("絵文字");
  if (keigoDiff(draft, staff)) t.add("敬語");
  if (NANITOZO_RE.test(draft) !== NANITOZO_RE.test(staff)) t.add("何卒");
  if (has("ending")) t.add("語尾");
  if (has("added") || has("removed")) t.add("文の数");
  if (has("order")) t.add("順番");
  if (has("number")) t.add("事実");
  return t;
}
export type TableRow = { sub: string; n: number; same: number; near: number; sim: number; typeOk: Record<R11Type, number> };
export function buildTable(pairs: readonly TablePair[]): { rows: TableRow[]; all: TableRow } {
  const by = new Map<string, TablePair[]>();
  for (const p of pairs) { if (!by.has(p.sub)) by.set(p.sub, []); by.get(p.sub)!.push(p); }
  const mk = (sub: string, l: readonly TablePair[]): TableRow => {
    const ok = Object.fromEntries(R11_TYPES.map((x) => [x, 0])) as Record<R11Type, number>;
    let same = 0, near = 0, sim = 0;
    for (const p of l) {
      const d = diffTexts(p.draft, p.staff);
      if (d.same) same++; if (d.same || d.sim >= 0.8) near++; sim += d.sim;
      const ty = r11TypesOf(d, p.draft, p.staff);
      for (const x of R11_TYPES) if (!ty.has(x)) ok[x]++;
    }
    return { sub, n: l.length, same, near, sim: l.length ? sim / l.length : 0, typeOk: ok };
  };
  const rows = [...by.entries()].map(([k, l]) => mk(k, l)).sort((a, b) => b.n - a.n || a.sub.localeCompare(b.sub));
  return { rows, all: mk("全体", pairs) };
}
const pc = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}` : "-");
export function printTable(title: string, pairs: readonly TablePair[], minN = 1): { rows: TableRow[]; all: TableRow } {
  const t = buildTable(pairs);
  console.log(`\n■ ${title}（n=${pairs.length}・数字は％＝その型の差が無い番の割合）`);
  console.log(["小場面", "n", "完全", "近い", "似", ...R11_TYPES].join(" | "));
  for (const r of [t.all, ...t.rows.filter((r) => r.n >= minN)]) {
    console.log([r.sub, r.n, pc(r.same, r.n), pc(r.near, r.n), r.sim.toFixed(2), ...R11_TYPES.map((x) => pc(r.typeOk[x], r.n))].join(" | "));
  }
  return t;
}
