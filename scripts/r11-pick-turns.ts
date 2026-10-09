// scripts/r11-pick-turns.ts — 11巡目: 竹内さんの手打ちの番（scripts/audit-r11-reply-table.ts の書き出し）から、YUMA の再生に流す番を小場面ごとに選ぶ（読むだけ・LLM なし）
//   出す形は scripts/yuma-r11-replay.ts の --src（{conv, at, scene, staffText, writer, sub}・at＝竹内さんの送信の2秒前＝その手前のお客様の連投まで）
// 実行: npx tsx scripts/r11-pick-turns.ts [--in=scripts/.replay-out/r11-table-prod.jsonl] [--per=4] [--max=110] [--out=scripts/.replay-out/r11-turns.jsonl]
import { readFileSync, writeFileSync } from "node:fs";
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IN = arg("in", "scripts/.replay-out/r11-table-prod.jsonl");
const PER = Number(arg("per", "4"));
const MAX = Number(arg("max", "110"));
const OUT = arg("out", "scripts/.replay-out/r11-turns.jsonl");
const rows = readFileSync(IN, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cid: string; at: string; subBrain: string; staff: string });
// 新しい順に小場面ごと PER まで（同じ会話は1小場面に2つまで）
rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
const cnt = new Map<string, number>(); const convSub = new Map<string, number>();
const out: unknown[] = [];
for (const r of rows) {
  if (out.length >= MAX) break;
  if ((cnt.get(r.subBrain) ?? 0) >= PER) continue;
  const cs = `${r.cid}|${r.subBrain}`; if ((convSub.get(cs) ?? 0) >= 2) continue;
  cnt.set(r.subBrain, (cnt.get(r.subBrain) ?? 0) + 1); convSub.set(cs, (convSub.get(cs) ?? 0) + 1);
  out.push({ conv: r.cid, at: new Date(Date.parse(r.at) - 2000).toISOString(), scene: r.subBrain.split(":")[0], sub: r.subBrain, staffText: r.staff, writer: "takeuchi", src: "r11-table" });
}
writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join("\n"));
console.log(`${out.length}番（小場面 ${cnt.size}）→ ${OUT}`);
console.log([...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
