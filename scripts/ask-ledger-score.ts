// scripts/ask-ledger-score.ts — 試験の答案から要件の帳面（app/lib/ask-ledger.ts）を数える（読むだけ・LLM なし・DB なし・費用 0）
//   2026-11-15 作業員M。答案に meta.ask_ledger があればそれを、無ければ答案の turn_contract・action から同じ純関数で作り直して数える
//   （ASK_LEDGER が off の試験の答案でも数えられる＝前の試験と比べられる）。
//   出す物: 組み立ての型（R・A・AT・RAT・AR・ATR・RAR）の数・要件の行き先×何通目の型・取りこぼし／重ね／取り違えの数と問題の id。
//   --base=<label> を付けると、同じ問題で外れが増えた問題（悪くなった）と減った問題を出す。
//   実行: npx tsx scripts/ask-ledger-score.ts --label=<label> [--base=<label>] [--dir=scripts/brain-exam/results] [--json]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { askLedgerFromMeta, askLedgerOf, type AskLedger } from "../app/lib/ask-ledger";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const dir = arg("dir", "scripts/brain-exam/results");
const label = arg("label");
const base = arg("base");
if (!label) { console.error("--label=<label> が要る"); process.exit(1); }

type Row = { id: string; rep?: number; brain?: Record<string, unknown> };
function read(l: string): Row[] {
  const f = join(dir, `${l}.jsonl`);
  if (!existsSync(f)) { console.error(`無い: ${f}`); process.exit(1); }
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((s) => { try { return JSON.parse(s) as Row; } catch { return null; } }).filter((x): x is Row => !!x);
}
const ledgerOfRow = (r: Row): AskLedger | null => askLedgerOf(r.brain) ?? askLedgerFromMeta(r.brain ?? null);

export function score(rows: Row[]) {
  const shapes = new Map<string, number>();
  const routeMsg = new Map<string, number>();
  const issues = { dropped: [] as string[], doubled: [] as string[], misrouted: [] as string[] };
  let withAsks = 0, noAsks = 0, asks = 0;
  const byQ = new Map<string, number>();
  for (const r of rows) {
    const L = ledgerOfRow(r);
    const key = `${r.id}#${r.rep ?? 0}`;
    if (!L) { noAsks++; continue; }
    withAsks++;
    shapes.set(L.shape, (shapes.get(L.shape) ?? 0) + 1);
    for (const e of L.items) {
      asks++;
      const k = `${e.route}→${e.msg ? `${e.msg}通目の${e.slot === "reply" ? "返信" : e.slot === "aix" ? "AIX" : "テンプレート"}` : "通なし"}`;
      routeMsg.set(k, (routeMsg.get(k) ?? 0) + 1);
    }
    for (const c of ["dropped", "doubled", "misrouted"] as const) if (L.check[c].length) issues[c].push(r.id);
    byQ.set(key, L.check.issues.length);
  }
  return { rows: rows.length, withAsks, noAsks, asks, shapes: Object.fromEntries([...shapes].sort((a, b) => b[1] - a[1])), routeMsg: Object.fromEntries([...routeMsg].sort((a, b) => b[1] - a[1])), issues, byQ };
}

const now = score(read(label));
const out: Record<string, unknown> = { label, ...now, byQ: undefined };
if (base) {
  const b = score(read(base));
  const worse: string[] = [], better: string[] = [];
  for (const [k, n] of now.byQ) { const m = b.byQ.get(k); if (m === undefined) continue; if (n > m) worse.push(k); else if (n < m) better.push(k); }
  out.base = { label: base, issues: { dropped: b.issues.dropped.length, doubled: b.issues.doubled.length, misrouted: b.issues.misrouted.length } };
  out.worse = worse; out.better = better;
}
if (argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`■ ${label}: 答案 ${now.rows}（要件あり ${now.withAsks}・無し ${now.noAsks}）・要件 ${now.asks}`);
  console.log(`  型: ${Object.entries(now.shapes).map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`  行き先→何通目: ${Object.entries(now.routeMsg).map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`  取りこぼし ${now.issues.dropped.length}（${now.issues.dropped.join(",")}）・重ね ${now.issues.doubled.length}（${now.issues.doubled.join(",")}）・取り違え ${now.issues.misrouted.length}（${now.issues.misrouted.join(",")}）`);
  if (base) console.log(`  基準 ${base} と比べて 悪くなった ${(out.worse as string[]).length}（${(out.worse as string[]).join(",")}）・良くなった ${(out.better as string[]).length}`);
}
