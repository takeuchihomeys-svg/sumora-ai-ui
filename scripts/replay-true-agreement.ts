// scripts/replay-true-agreement.ts
// 2026-10-02 ⑫: 再生の結果を「当たり／竹内さんの決定どおり／再生の環境／稀な動き／本当の外れ」に分けて、本当の一致を出す。揺れ（同じ場面が巡で変わった）も数える。読むだけ
// 実行: npx tsx scripts/replay-true-agreement.ts --labels=l12-r22,l12-r22s,l12-r22m [--history=l12-r19,l12-r20]
import { readFileSync, existsSync } from "node:fs";
import { truthOf, flipped, type TruthRec, type Correction } from "./lib/replay-truth";
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const load = (l: string): TruthRec[] => { const f = `scripts/.replay-out/${l}.jsonl`; if (!existsSync(f)) return []; return readFileSync(f, "utf8").trim().split("\n").map((x) => { try { return JSON.parse(x) as TruthRec; } catch { return {}; } }).filter((r) => r.id); };
const corr = (JSON.parse(readFileSync("scripts/replay-reference-corrections.json", "utf8")) as { corrections: Record<string, Correction> }).corrections;
const hist = arg("history").split(",").filter(Boolean).map(load);
for (const l of arg("labels").split(",").filter(Boolean)) {
  const rs = load(l);
  const by: Record<string, string[]> = {};
  for (const r of rs) (by[truthOf(r, corr)] ??= []).push(r.id!);
  const ran = rs.filter((r) => !r.error).length;
  const ok = (by.hit?.length ?? 0) + (by.decision?.length ?? 0) + (by.environment?.filter((id) => !rs.find((r) => r.id === id)?.error).length ?? 0) + (by.outlier?.length ?? 0);
  const flips = rs.filter((r) => !r.error && flipped([r.decided, ...hist.map((h) => h.find((x) => x.id === r.id && !x.error)?.decided)].filter((x) => x !== undefined)) && hist.some((h) => h.find((x) => x.id === r.id))).map((r) => r.id!);
  console.log(`${l}: 走った ${ran}/${rs.length}・当たり ${by.hit?.length ?? 0}・決定どおり ${by.decision?.length ?? 0}・環境 ${by.environment?.length ?? 0}・稀な動き ${by.outlier?.length ?? 0}・本当の外れ ${by.miss?.length ?? 0} → 本当の一致 ${ok}/${ran}（${ran ? Math.round((ok / ran) * 100) : 0}%）`);
  if (by.miss?.length) console.log(`   本当の外れ: ${by.miss.join("・")}`);
  if (flips.length) console.log(`   揺れ（前の巡と判断が違う）: ${flips.join("・")}`);
}
