// scripts/judge-basis-score.ts — 重点の物差し＋判断の根拠のメモの物差し（AI を呼ばない・DB を読まない・費用0）
//
// 2026-11-12 作業員17。試験の答案（scripts/brain-exam/results/<label>.jsonl）と問題の spec から、
//   竹内さんがその番で一番大切にした事（重点）とブレインの重点の当たり・外れた段（読み・選び・深さ・優先・重点・順番・道）・選んだ順番が竹内さんと合ったかを、場面別・深さ別に出す。
//   正解の足し方: spec.json の問題に "basis": {"focus":"answer|promise_make|promise_keep|ease|close|propose|relation","priority":["answer_question",…],"depth":"shallow|normal|deep","order":["judge","fetch",…],"by":"誰が・いつ・どの番から"} を足す
//     （型の名前は app/lib/judge-basis-types.ts の1か所。人が付けた物は source=human・無い問題は accept の AIX 型から重点だけ推定）。
//     決まり: ① 竹内さんの実際の番（送った文・AIX の種類）を読んで人が付ける（AI の推測だけで付けない）② 申込の門より前の番だけ ③ by に根拠の番号を書く ④ 迷う番は付けずに空にする（推定に任せる）
// 実行: npx tsx scripts/judge-basis-score.ts --results=<jsonl かフォルダ,…> [--spec=scripts/brain-exam/spec.json] [--json=<出力>] [--show]
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildReport, formatReport, type AnswerRow, type SpecLite } from "./lib/judge-basis-score";

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
const rows: AnswerRow[] = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as AnswerRow]; } catch { return []; } }));

const rep = buildReport(specs, rows);
console.log(`答案 ${files.length} ファイル・${rows.length} 行`);
console.log(formatReport(rep));
if (args.includes("--show")) for (const v of rep.verdicts.filter((x) => x.missStage)) console.log(`${v.id}#${v.rep} 外れた段=${v.missStage} 重点=${v.focusHit} 優先=${v.priorityHit} 深さ=${v.depthHit} 順番=${v.orderExact}/${v.orderHead} 道=${v.pathOk}`);
if (arg("json")) writeFileSync(resolve(ROOT, arg("json")), JSON.stringify(rep, null, 1));
