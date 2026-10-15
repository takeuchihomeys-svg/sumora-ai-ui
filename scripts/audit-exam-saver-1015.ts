// scripts/audit-exam-saver-1015.ts — 読むだけ。試験（brain-exam）の節約の道具が効いているかを、全作業ツリーの results/*.cost.json で数える。
//   新しく呼んだ（real）・再生（replayed）・録音に無かった（missed）・使い回し（baseline）・変わった所（misses の中身）を label ごとに並べる。
// 実行: npx tsx scripts/audit-exam-saver-1015.ts [--since=2026-10-15T12:00] [--root=<倉庫の根>]
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const root = arg("root", join(process.cwd(), "..", "..", ".."));
const since = Date.parse(arg("since", "2026-10-15T00:00:00+09:00"));
type Tot = { real: number; realUsd: number; replayed: number; replayUsd: number; missed: number; unrecordable: number };
type Cost = { mode?: string; total?: Tot; byAction?: Record<string, Tot>; misses?: Array<Record<string, unknown>>; judge?: { calls: number; usd: number; replayed?: number }; baseline?: Record<string, unknown> | null };

const dirs: string[] = [join(root, "scripts", "brain-exam", "results")];
const wt = join(root, ".claude", "worktrees");
if (existsSync(wt)) for (const d of readdirSync(wt)) dirs.push(join(wt, d, "scripts", "brain-exam", "results"));
const rows: Array<{ at: number; where: string; label: string; c: Cost }> = [];
for (const d of dirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".cost.json")) continue;
    const p = join(d, f); const at = statSync(p).mtimeMs;
    if (at < since) continue;
    try { rows.push({ at, where: d.split(/[\\/]worktrees[\\/]/)[1]?.split(/[\\/]/)[0] ?? "main", label: f.replace(/\.cost\.json$/, ""), c: JSON.parse(readFileSync(p, "utf8")) }); } catch { /* 壊れた行は飛ばす */ }
  }
}
rows.sort((a, b) => a.at - b.at);
const sum = { real: 0, usd: 0, replayed: 0, replayUsd: 0, missed: 0, baseUsed: 0, baseRan: 0 };
const missKinds: Record<string, number> = {};
for (const r of rows) {
  const t = r.c.total ?? ({} as Tot);
  const b = r.c.baseline as Record<string, unknown> | null | undefined;
  const bUsed = Number(b?.reused ?? b?.used ?? (Array.isArray(b?.reusedTags) ? (b!.reusedTags as unknown[]).length : 0)) || 0;
  const bRan = Number(b?.ran ?? (Array.isArray(b?.ranTags) ? (b!.ranTags as unknown[]).length : 0)) || 0;
  sum.real += t.real ?? 0; sum.usd += t.realUsd ?? 0; sum.replayed += t.replayed ?? 0; sum.replayUsd += t.replayUsd ?? 0; sum.missed += t.missed ?? 0; sum.baseUsed += bUsed; sum.baseRan += bRan;
  for (const m of r.c.misses ?? []) { const k = String(m.reason ?? m.kind ?? m.diff ?? "?").slice(0, 60); missKinds[k] = (missKinds[k] ?? 0) + 1; }
  const tm = new Date(r.at + 9 * 3600e3).toISOString().slice(11, 16);
  console.log(`${tm} ${r.where.slice(0, 22).padEnd(22)} ${r.label.padEnd(34)} mode=${String(r.c.mode ?? "-").padEnd(7)} real=${String(t.real ?? 0).padStart(3)} $${(t.realUsd ?? 0).toFixed(3)} replay=${String(t.replayed ?? 0).padStart(3)} missed=${t.missed ?? 0} judge=${r.c.judge?.calls ?? 0}/${r.c.judge?.replayed ?? 0} base=${b ? JSON.stringify(b).slice(0, 120) : "-"}`);
}
console.log("\n合計", JSON.stringify({ files: rows.length, ...sum, usd: +sum.usd.toFixed(3), replayUsd: +sum.replayUsd.toFixed(3) }));
console.log("変わった所の種類", JSON.stringify(missKinds));
