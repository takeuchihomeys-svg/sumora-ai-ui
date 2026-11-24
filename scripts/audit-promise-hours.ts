// scripts/audit-promise-hours.ts — 約束が実際に何時間で果たされているか（種類ごと・書き手ごと・読むだけ・LLM なし・DB なし）
// 2026-11-25 作業員L（台帳 #664 の②・統括役の頼み「72時間が竹内さんの感覚に合っているか」）。
//   元は B1（scripts/audit-promise-kept.ts --out の行・fulfilledAt）。果たした約束の、約束から果たすまでの時間の中央と8割の時間を種類ごとに出し、
//   72時間（期限の言葉が無い約束の決め）と比べる。まだ果たしていない約束（期日超え・期限前）は数に入らない＝短い側に寄る（右側の打ち切り）ので、果たした割合も並べる。
// 実行: npx tsx scripts/audit-promise-hours.ts --b1=<b1.json> [--writer=takeuchi]
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = { kind: string; writer: string; at: string; state: string; deadlineBy: string; fulfilledAt?: string | null };
export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
}
export function hoursByKind(rows: readonly Row[], writer?: string) {
  const out: Record<string, { n: number; fulfilled: number; median: number | null; p80: number | null; over72: number }> = {};
  for (const r of rows) {
    if (writer && r.writer !== writer) continue;
    if (!["in_time", "late", "overdue", "pending"].includes(r.state)) continue;
    const k = r.kind;
    const e = (out[k] ??= { n: 0, fulfilled: 0, median: null, p80: null, over72: 0 });
    e.n++;
  }
  for (const k of Object.keys(out)) {
    const hs = rows.filter((r) => r.kind === k && (!writer || r.writer === writer) && r.fulfilledAt).map((r) => (Date.parse(r.fulfilledAt as string) - Date.parse(r.at)) / 36e5).filter((h) => h >= 0);
    out[k].fulfilled = hs.length; out[k].median = quantile(hs, 0.5); out[k].p80 = quantile(hs, 0.8); out[k].over72 = hs.filter((h) => h > 72).length;
  }
  return out;
}

if (process.argv[1] && /audit-promise-hours/.test(process.argv[1])) {
  const j = JSON.parse(readFileSync(arg("b1"), "utf8")) as { days?: number; rows: Row[] };
  const f = (h: number | null) => (h == null ? "—" : h < 48 ? `${h.toFixed(1)}時間` : `${(h / 24).toFixed(1)}日`);
  for (const w of [arg("writer") || "takeuchi", ""]) {
    const t = hoursByKind(j.rows, w || undefined);
    console.log(`\n## ${w ? `書き手 ${w}` : "全体"}（${j.days ?? "?"}日・果たした約束の、約束から果たすまで）`);
    console.log("| 種類 | 約束 | 果たした | 中央 | 8割 | 72時間を超えて果たした |");
    console.log("|---|---|---|---|---|---|");
    for (const [k, e] of Object.entries(t).sort((a, b) => b[1].n - a[1].n)) console.log(`| ${k} | ${e.n} | ${e.fulfilled} | ${f(e.median)} | ${f(e.p80)} | ${e.over72} |`);
  }
}
