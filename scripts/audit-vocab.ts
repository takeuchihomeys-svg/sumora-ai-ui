// scripts/audit-vocab.ts — ブレインの出力の欄の語彙の割れを答案（brain-exam の results の jsonl）で数える（AI を呼ばない・DB を読まない・費用0）
//
// 2026-11-12 作業員17。app/lib/brain-vocab.ts の変換表で、答案の customer_concern.topic（旧12種）を2段（物件の性質／お金・手続き・事情）に分けて数え、
//   表に無い語（割れている語）と、judge_basis に条件の強さ・範囲が書かれた数も出す。
// 実行: npx tsx scripts/audit-vocab.ts --results=<jsonl かフォルダ,…>
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeTopic } from "../app/lib/brain-vocab";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROOT = resolve(__dirname, "..");
const files: string[] = [];
for (const p of arg("results").split(",").filter(Boolean)) {
  const abs = resolve(ROOT, p);
  if (!existsSync(abs)) continue;
  if (statSync(abs).isDirectory()) for (const f of readdirSync(abs)) { if (f.endsWith(".jsonl")) files.push(join(abs, f)); } else files.push(abs);
}
if (!files.length) { console.error("--results=<jsonl かフォルダ> を指定してください"); process.exit(1); }

const byGroup: Record<string, number> = {}, byTopic: Record<string, number> = {}, unknown: Record<string, number> = {};
let rows = 0, withConcern = 0, staffFact = 0;
for (const f of files) for (const l of readFileSync(f, "utf8").split("\n")) {
  if (!l) continue;
  let r: { brain?: { customer_concern?: { topic?: string } | null } };
  try { r = JSON.parse(l); } catch { continue; }
  rows++;
  const t = r.brain?.customer_concern?.topic;
  if (!t) continue;
  withConcern++;
  const n = normalizeTopic(t);
  if (!n) { unknown[t] = (unknown[t] ?? 0) + 1; continue; }
  byGroup[n.group] = (byGroup[n.group] ?? 0) + 1; byTopic[n.key] = (byTopic[n.key] ?? 0) + 1; if (n.staffFact) staffFact++;
}
console.log(`答案 ${files.length} ファイル・${rows} 行・懸念あり ${withConcern}`);
console.log("2段:", JSON.stringify(byGroup), " スタッフしか知らない主題:", staffFact);
console.log("主題:", JSON.stringify(byTopic));
console.log("表に無い語（割れ）:", JSON.stringify(unknown));
