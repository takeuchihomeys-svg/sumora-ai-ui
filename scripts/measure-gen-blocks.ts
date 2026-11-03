// scripts/measure-gen-blocks.ts — 返信の書き手に渡す前置き・動的な材料の文字数を、試験のログ（gen:blocks の行）から前と後で並べる（LLM なし・DB なし）
//
// 2026-11-03 作業員6（統括「場面の技能の決まりの本を on にした時の前置きの文字数の前と後を測る台本」）。
//   generate-reply は毎回 {"tag":"gen:blocks", cached:{system,dbRules,topPrinciples,staticBlock,phaseGuide}, dynamicTotal, dyn:{…}} を1行出す。
//   試験（exam-conductor の列で流した brain-exam／exam-aix-text）の出力のログを2つ（off と on）渡すと、塊ごとの平均・合計・場面ごとの平均と、
//   キャッシュの前置き（cached の合計）・動的な材料（dynamicTotal）の差を出す。トークンは 1.7字≒1トークンの目安（日本語）で概算する。
// 実行: npx tsx scripts/measure-gen-blocks.ts --a=<off の out.log> --b=<on の out.log> [--labels=off,on] [--out=<scratchpad の md>]
import { readFileSync, writeFileSync } from "node:fs";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type G = { scene: string | null; cached: Record<string, number>; dynamicTotal: number; dyn: Record<string, number> };
export function parseGenBlocks(text: string): G[] {
  const out: G[] = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('{"tag":"gen:blocks"');
    if (i < 0) continue;
    try { out.push(JSON.parse(line.slice(i)) as G); } catch { /* 途中で切れた行は飛ばす */ }
  }
  return out;
}
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
export function summarize(gs: G[]) {
  const keys = new Set<string>(); const dkeys = new Set<string>();
  for (const g of gs) { Object.keys(g.cached ?? {}).forEach((k) => keys.add(k)); Object.keys(g.dyn ?? {}).forEach((k) => dkeys.add(k)); }
  const cached = Object.fromEntries([...keys].map((k) => [k, avg(gs.map((g) => g.cached?.[k] ?? 0))]));
  const dyn = Object.fromEntries([...dkeys].map((k) => [k, avg(gs.map((g) => g.dyn?.[k] ?? 0))]));
  const cachedTotal = avg(gs.map((g) => Object.values(g.cached ?? {}).reduce((a, b) => a + b, 0)));
  const dynamicTotal = avg(gs.map((g) => g.dynamicTotal ?? 0));
  return { n: gs.length, cached, dyn, cachedTotal, dynamicTotal };
}
function main() {
  const [la, lb] = arg("labels", "off,on").split(",");
  const A = summarize(parseGenBlocks(readFileSync(arg("a"), "utf8")));
  const B = summarize(parseGenBlocks(readFileSync(arg("b"), "utf8")));
  const tok = (c: number) => Math.round(c / 1.7);
  const row = (k: string, a: number, b: number) => `| ${k} | ${a.toLocaleString()} | ${b.toLocaleString()} | ${(b - a >= 0 ? "+" : "") + (b - a).toLocaleString()} |`;
  const keys = [...new Set([...Object.keys(A.cached), ...Object.keys(B.cached)])];
  const dkeys = [...new Set([...Object.keys(A.dyn), ...Object.keys(B.dyn)])];
  const md = [
    `# 書き手の前置き・材料の文字数（${la}: ${A.n}回 ／ ${lb}: ${B.n}回・平均）`, "",
    `| 塊 | ${la} | ${lb} | 差 |`, "|---|---|---|---|",
    ...keys.map((k) => row(`前置き:${k}`, A.cached[k] ?? 0, B.cached[k] ?? 0)),
    row("**前置きの合計**", A.cachedTotal, B.cachedTotal),
    ...dkeys.map((k) => row(`材料:${k}`, A.dyn[k] ?? 0, B.dyn[k] ?? 0)),
    row("**動的な材料の合計**", A.dynamicTotal, B.dynamicTotal), "",
    `前置き ${tok(A.cachedTotal).toLocaleString()} → ${tok(B.cachedTotal).toLocaleString()} トークン（概算）・動的 ${tok(A.dynamicTotal).toLocaleString()} → ${tok(B.dynamicTotal).toLocaleString()} トークン`,
    "費用の目安（Claude の書き手・1回）: 冷えた書き込み 前置き×$6/M・読み 前置き×$0.3/M・動的 ×$3/M（DeepSeek の書き手は動的の差がそのまま効く）",
  ].join("\n");
  const out = arg("out");
  if (out) writeFileSync(out, md);
  console.log(md);
}
if (process.argv[1]?.includes("measure-gen-blocks")) main();
