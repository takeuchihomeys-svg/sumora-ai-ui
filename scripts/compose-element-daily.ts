// scripts/compose-element-daily.ts — 文の要素の当たりと外れの根を、毎日（直しを入れるたびに）同じ物差しで測って台帳に足す（AI を呼ばない・DB を読まない・費用0）
//   2026-11-13 作業員10（統括役「文の要素の当たりを要素ごとに毎日同じ物差しで測れる形に」）。物差しは scripts/lib/compose-gold.ts の evalGoldTurn（audit-compose-roots と同じ）
//   正解: 竹内さんの番だけ（KB 41dadfe6）。既定は gold-1113（53番）。答案の brain が無い番は数えない（数えた番の数を出す）
//   要素: 主の役目・頭・つなぎ・押さえ・信頼・潜在・締め・事実。根: A 土台／B 細分化／C 材料／D 道・読み
//   台帳: exam-cache/compose-element-daily.jsonl（1回1行・日時・コミット・試したスイッチ・要素ごとの当たりと根の数）
// 実行: npx tsx scripts/compose-element-daily.ts [--gold=...] [--with=COMPOSE_PHRASE_CATALOG,COMPOSE_ASKS_FACTS] [--compare] [--no-write]
//   --with: そのスイッチを on にして測る（既定 off のスイッチの効きを見る）・--compare: off（今の既定）と --with の両方を並べる
import { appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { loadGold, loadProbs, loadBrains, evalGoldTurn, ELEMENTS, type El, type Root } from "./lib/compose-gold";

const ROOT = resolve(__dirname, "..");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const flag = (k: string) => process.argv.includes(`--${k}`);
const goldFile = arg("gold", "scripts/compose-understanding/gold-1113.json");
const gold = loadGold(ROOT, goldFile);
const probs = loadProbs(ROOT);
const brainOf = loadBrains(ROOT, new Set(gold.map((g) => g.id)));
const withSw = arg("with").split(",").map((x) => x.trim()).filter(Boolean);

type Row = { el: El; has: number; hit: number; roots: Record<Root, number> };
function measure(on: string[]): { n: number; rows: Row[] } {
  const saved = new Map(on.map((k) => [k, process.env[k]]));
  for (const k of on) process.env[k] = "on";
  try {
    const rows = new Map<El, Row>(ELEMENTS.map((el) => [el, { el, has: 0, hit: 0, roots: { A: 0, B: 0, C: 0, D: 0 } }]));
    let n = 0;
    for (const g of gold) {
      const b = brainOf.get(g.id); const p = probs.get(g.id);
      if (!b || !p?.staffText) continue;
      n++;
      for (const r of evalGoldTurn(g, b.brain, p)) {
        const row = rows.get(r.el)!;
        if (r.goldHas) { row.has++; if (r.hit) row.hit++; }
        if (r.root) row.roots[r.root]++;
      }
    }
    return { n, rows: [...rows.values()] };
  } finally { for (const [k, v] of saved) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const commit = (() => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch { return "?"; } })();
const runs: Array<{ label: string; on: string[] }> = flag("compare") && withSw.length ? [{ label: "今の既定", on: [] }, { label: `on: ${withSw.join("+")}`, on: withSw }] : [{ label: withSw.length ? `on: ${withSw.join("+")}` : "今の既定", on: withSw }];
const results = runs.map((r) => ({ ...r, ...measure(r.on) }));
console.log(`正解 ${goldFile}（答案のある番 ${results[0].n}）・コミット ${commit}`);
console.log(["要素", ...results.map((r) => `当たり（${r.label}）`), "外れの根 A/B/C/D（最後の列）"].join("｜"));
for (const el of ELEMENTS) {
  const cells = results.map((r) => { const x = r.rows.find((y) => y.el === el)!; return `${x.hit}/${x.has}（${pct(x.hit, x.has)}）`; });
  const last = results[results.length - 1].rows.find((y) => y.el === el)!;
  console.log([el, ...cells, `${last.roots.A}/${last.roots.B}/${last.roots.C}/${last.roots.D}`].join("｜"));
}
if (!flag("no-write")) {
  const line = { at: new Date().toISOString(), commit, gold: goldFile, runs: results.map((r) => ({ label: r.label, on: r.on, n: r.n, elements: Object.fromEntries(r.rows.map((x) => [x.el, { hit: x.hit, has: x.has, roots: x.roots }])) })) };
  appendFileSync(resolve(ROOT, "../../exam-cache/compose-element-daily.jsonl"), JSON.stringify(line) + "\n");
  console.log("台帳に足した: exam-cache/compose-element-daily.jsonl");
}
