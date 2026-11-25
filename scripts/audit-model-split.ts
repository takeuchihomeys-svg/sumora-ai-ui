// scripts/audit-model-split.ts — 試験の DeepSeek の道と本番の Claude の道の食い違い（読むだけ・LLM なし・DB なし・置き場のファイルだけ）
// 2026-11-25 作業員A（統括役の頼み「試験のブレインは DeepSeek・本番は Claude」）:
//   本番の道＝problems.json の prodBrain（その番の本番のブレインの決め: mode・action・src）／試験の道＝scripts/brain-exam/results の DeepSeek の行の path.code（off の前の行＝label が main- の物を優先・無ければ全部）。
//   系統（返信・確認・見積・物件・内覧…）で比べる。2段（two_stage・two_stage_promise）は今の通＝返信。問題の型・正解の系統・本番の系統ごとに一致率
// 実行: npx tsx scripts/audit-model-split.ts [--results=scripts/brain-exam/results] [--problems=scripts/brain-exam/problems.json]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { aixFamily } from "./lib/prod-yardstick-db";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type P = { id: string; type?: string; accept?: string[]; prodBrain?: { action?: string | null; mode?: string | null; src?: string | null } | null };
const raw = JSON.parse(readFileSync(arg("problems", "scripts/brain-exam/problems.json"), "utf8"));
const probs = (Array.isArray(raw) ? raw : raw.problems ?? Object.values(raw)) as P[];
// 2026-11-25: 本番の記録の2段の漏れ（mode=aix・action は後で果たす AIX・方向は約束の返信）を今の通＝返信に読む（--raw-prod で記録のまま）
const PROMISE_DIR = /約束|確認させて|確認(?:出来|でき)次第|お送りさせて頂きます|ピックアップして|お調べ/;
const prodFam = (b: NonNullable<P["prodBrain"]> & { dir?: string | null }) => (/two_stage/.test(String(b.src ?? "")) || b.mode !== "aix" ? "返信"
  : !process.argv.includes("--raw-prod") && (PROMISE_DIR.test(String(b.dir ?? "")) || /answerable_direct[(](?:brought_both|check)/.test(String(b.src ?? ""))) ? "返信" : aixFamily(b.action ?? ""));
const famOfCode = (code: string) => (code.startsWith("AIX:") ? aixFamily(code.slice(4).split("/")[0]) : "返信");
const acceptFam = (a: string[] | undefined) => [...new Set((a ?? []).map((x) => (x.startsWith("AIX:") ? aixFamily(x.slice(4).split("/")[0].replace(/^物件$/, "property_send")) : "返信")))].join("|");

// 試験の DeepSeek の答え（問題ごとに off の行の多数・無ければ全部の行の多数）
const ds = new Map<string, { base: Map<string, number>; any: Map<string, number> }>();
const dir = arg("results", "scripts/brain-exam/results");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
  let txt = ""; try { txt = readFileSync(join(dir, f), "utf8"); } catch { continue; }
  for (const l of txt.split("\n")) {
    if (!l.includes('"deepseek')) continue;
    try {
      const r = JSON.parse(l) as { id?: string; label?: string; model?: string; error?: string; path?: { code?: string } | null };
      if (!r.id || r.error || !r.path?.code || !String(r.model ?? "").includes("deepseek")) continue;
      const fam = famOfCode(r.path.code);
      const o = ds.get(r.id) ?? { base: new Map(), any: new Map() };
      o.any.set(fam, (o.any.get(fam) ?? 0) + 1);
      if (String(r.label ?? "").startsWith("main-") || /-off|base/.test(String(r.label ?? "")) || f.includes("base")) o.base.set(fam, (o.base.get(fam) ?? 0) + 1);
      ds.set(r.id, o);
    } catch { /* */ }
  }
}
const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
type Pair = { id: string; type: string; prod: string; ds: string; ans: string };
const pairs: Pair[] = [];
for (const p of probs) {
  if (!p.prodBrain) continue;
  const o = ds.get(p.id); if (!o) continue;
  const d = top(o.base.size ? o.base : o.any); if (!d) continue;
  pairs.push({ id: p.id, type: p.type ?? "?", prod: prodFam(p.prodBrain), ds: d, ans: acceptFam(p.accept) });
}
const agree = (xs: Pair[]) => xs.filter((x) => x.prod === x.ds).length;
const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "—");
console.log(`■ 本番の Claude（problems.json の prodBrain）× 試験の DeepSeek（results の行）: 同じ問題 ${pairs.length}・同じ系統 ${agree(pairs)}（${pct(agree(pairs), pairs.length)}）`);
const okProd = pairs.filter((x) => x.ans.split("|").includes(x.prod)).length, okDs = pairs.filter((x) => x.ans.split("|").includes(x.ds)).length;
console.log(`  正解の系統に入る: 本番の Claude ${okProd}/${pairs.length}（${pct(okProd, pairs.length)}）・試験の DeepSeek ${okDs}/${pairs.length}（${pct(okDs, pairs.length)}）`);
for (const [name, key] of [["問題の型", (x: Pair) => x.type], ["本番の系統", (x: Pair) => x.prod], ["正解の系統", (x: Pair) => x.ans]] as const) {
  const g = new Map<string, Pair[]>(); for (const x of pairs) g.set(key(x), [...(g.get(key(x)) ?? []), x]);
  console.log(`\n${name}ごと（一致の低い順）:`);
  for (const [k, xs] of [...g].sort((a, b) => agree(a[1]) / a[1].length - agree(b[1]) / b[1].length)) console.log(`  ${k}: ${agree(xs)}/${xs.length}（${pct(agree(xs), xs.length)}）`);
}
const cross = new Map<string, number>(); for (const x of pairs) if (x.prod !== x.ds) cross.set(`${x.prod}→${x.ds}`, (cross.get(`${x.prod}→${x.ds}`) ?? 0) + 1);
console.log(`\n食い違いの向き（本番の Claude → 試験の DeepSeek）: ${[...cross].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
