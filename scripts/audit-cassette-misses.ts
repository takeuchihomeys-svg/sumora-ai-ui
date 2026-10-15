// scripts/audit-cassette-misses.ts — 読むだけ。試験の録音（.claude/exam-cache/llm-cassette）で、同じ問題・同じ名札なのに鍵が違う録音の組を
//   並べ、本文のどこが違うか（最初に違う所の前後）を出す。直した所（材料・指示）以外が違っていれば、毎回変わる物の伏せ漏れ。
// 実行: npx tsx scripts/audit-cassette-misses.ts [--since=2026-10-15T00:00+09:00] [--show=20]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CASSETTE_DIR, type CassetteEntry } from "./lib/llm-cassette";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const since = Date.parse(arg("since", "2026-10-15T00:00:00+09:00"));
const show = Number(arg("show", "20")) || 20;
const dir = arg("dir", DEFAULT_CASSETTE_DIR);

const entries: CassetteEntry[] = [];
for (const sub of readdirSync(dir)) {
  const p = join(dir, sub);
  if (!statSync(p).isDirectory()) continue;
  for (const f of readdirSync(p)) {
    try { const e = JSON.parse(readFileSync(join(p, f), "utf8")) as CassetteEntry; if (Date.parse(e.firstAt) >= since) entries.push(e); } catch { /* */ }
  }
}
const groupKey = (e: CassetteEntry) => `${e.action ?? "-"}|${e.tag?.problem ?? e.tag?.tag ?? JSON.stringify(e.tag ?? {})}`;
const groups = new Map<string, CassetteEntry[]>();
for (const e of entries) { const k = groupKey(e); const a = groups.get(k) ?? []; a.push(e); groups.set(k, a); }
console.log("entries", entries.length, "groups", groups.size, "groups with >1 keys", [...groups.values()].filter((g) => g.length > 1).length);

/** 最初に違う所の前後（その周りの言葉で種類を当てる） */
function firstDiff(a: string, b: string): { at: number; a: string; b: string } {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return { at: i, a: a.slice(Math.max(0, i - 60), Math.min(a.length - j, i + 160)), b: b.slice(Math.max(0, i - 60), Math.min(b.length - j, i + 160)) };
}
const kinds: Record<string, number> = {};
const samples: string[] = [];
for (const [k, g] of groups) {
  if (g.length < 2) continue;
  g.sort((x, y) => Date.parse(x.firstAt) - Date.parse(y.firstAt));
  for (let i = 1; i < g.length; i++) {
    const d = firstDiff(g[i - 1].normBody, g[i].normBody);
    // 種類: 違う所の手前にある見出し（【…】）
    const head = (g[i].normBody.slice(0, d.at).match(/【[^】]{1,30}】(?![\s\S]*【)/)?.[0]) ?? (g[i].normBody.slice(Math.max(0, d.at - 40), d.at).replace(/\\n/g, " ").slice(-30));
    const kk = `${k.split("|")[0]} @ ${head}`;
    kinds[kk] = (kinds[kk] ?? 0) + 1;
    if (samples.length < show && (!arg("action") || k.startsWith(arg("action") + "|"))) samples.push(`── ${k} #${i} at ${d.at}/${g[i].normBody.length}\n  前: ${d.a.replace(/\\n/g, "⏎")}\n  後: ${d.b.replace(/\\n/g, "⏎")}`);
  }
}
console.log("\n違う所の手前の見出し（多い順）");
for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(String(n).padStart(4), k);
console.log("\n例");
for (const s of samples) console.log(s);
