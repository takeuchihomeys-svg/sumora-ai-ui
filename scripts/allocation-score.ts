// scripts/allocation-score.ts — 配分ごとの当たりと費用（AI を呼ばない・DB を読まない・費用0・作業員22・2026-11-12・KB fd1c7c62⑤）
//
// 実行: npx tsx scripts/allocation-score.ts --results=<jsonl かフォルダ,…> [--spec=scripts/brain-exam/spec.json] [--usage=<llm_usage の route 別の JSON>] [--json=<出力>] [--show]
//   --usage の形: [{"route":"script:brain-exam-<label>","usd":0.123,"calls":10}, {"route":"…","usd":0.01,"id":"q041"}]
//     （llm_usage_logs を route 別に足した物を手で書き出す。DB の重い読みは JST 9〜22時はしない）
//   答案の label はファイル名（拡張子なし）。route の script:brain-exam-<label> と同じ名前で費用を等分する
// 中身は scripts/lib/allocation-score.ts（純関数）
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildAllocReport, formatAllocReport, type AnswerWithLabel, type UsageRow } from "./lib/allocation-score";
import type { SpecLite } from "./lib/judge-basis-score";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROOT = resolve(__dirname, "..");

const specRaw = JSON.parse(readFileSync(resolve(ROOT, arg("spec", "scripts/brain-exam/spec.json")), "utf8")) as unknown;
const specs = (Array.isArray(specRaw) ? specRaw : Object.values(specRaw as object)) as SpecLite[];

const files: string[] = [];
for (const p of arg("results", "").split(",").filter(Boolean)) {
  const abs = resolve(ROOT, p);
  if (!existsSync(abs)) { console.error(`無い: ${p}`); continue; }
  if (statSync(abs).isDirectory()) for (const f of readdirSync(abs)) { if (f.endsWith(".jsonl")) files.push(join(abs, f)); } else files.push(abs);
}
if (!files.length) { console.error("--results=<jsonl かフォルダ> を指定してください"); process.exit(1); }
const rows: AnswerWithLabel[] = files.flatMap((f) => {
  const label = basename(f).replace(/\.jsonl$/, "");
  return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [{ ...(JSON.parse(l) as AnswerWithLabel), label }]; } catch { return []; } });
});
const usage: UsageRow[] = arg("usage") ? (JSON.parse(readFileSync(resolve(ROOT, arg("usage")), "utf8")) as UsageRow[]) : [];

const rep = buildAllocReport(specs, rows, usage);
console.log(`答案 ${files.length} ファイル・${rows.length} 行・usage ${usage.length} 行`);
console.log(formatAllocReport(rep));
if (args.includes("--show")) for (const v of rep.verdicts) console.log(`${v.id}#${v.rep} ${v.alloc ?? "-"}(${v.source}) 道=${v.pathOk} 目安$${v.estUsd} 実測$${v.usd ?? "-"}`);
if (arg("json")) writeFileSync(resolve(ROOT, arg("json")), JSON.stringify(rep, null, 1));
