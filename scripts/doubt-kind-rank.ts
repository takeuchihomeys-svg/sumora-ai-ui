// scripts/doubt-kind-rank.ts — 疑いの印の種類ごとに「スタッフが AI の下書きを直した番」の数を数え、多い順を出す（AI を呼ばない・DB を読まない・費用0・作業員22）
//
// 入力: scripts/edited-turn-miner.ts の出力 weak-spots.json（<倉庫の根>/.claude/exam-cache/edited-turns/<JST の日付>/weak-spots.json）。
//   DB を読むのは edited-turn-miner の方（決まり: DB の重い読みは JST 22時以降に回す）。このスクリプトは出来たファイルを数えるだけ。
// 出す物: 種類ごとの数（多い順）と、今の表（app/lib/conductor-doubt.ts の DOUBT_TABLE の count1016）との差。並びが変わったら表を直す。
// 実行: npx tsx scripts/doubt-kind-rank.ts [--file=<weak-spots.json>]（無ければ edited-turns の一番新しい日）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DOUBT_TABLE, rankDoubtKinds } from "../app/lib/conductor-doubt";

const arg = (k: string) => process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const dir = resolve(__dirname, "../../../exam-cache/edited-turns");
const file = arg("file") ?? (existsSync(dir) ? (() => { const d = readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort().pop(); return d ? join(dir, d, "weak-spots.json") : null; })() : null);
if (!file || !existsSync(file)) { console.error("weak-spots.json が無い（JST 22時以降に scripts/edited-turn-miner.ts を回してから）"); process.exit(1); }
const w = JSON.parse(readFileSync(file, "utf8")) as { day?: string; days?: number; pairs?: unknown; spots: Array<{ bucket: string; type: string; key: string; n: number }> };
const r = rankDoubtKinds(w.spots);
console.log(`# 疑いの印の種類ごとの直しの数（${w.day ?? "?"}・${w.days ?? "?"}日分・${file}）`);
for (const x of r) {
  const d = DOUBT_TABLE.find((y) => y.kind === x.kind)!;
  console.log(`${String(x.n).padStart(4)}  ${x.kind.padEnd(20)} ${d.label}（表 ${d.count1016}）`);
}
const sameOrder = r.map((x) => x.kind).join() === DOUBT_TABLE.map((d) => d.kind).join();
console.log(sameOrder ? "表の並びと同じ" : "表の並びと違う → app/lib/conductor-doubt.ts の DOUBT_TABLE の並びと count を直す");
