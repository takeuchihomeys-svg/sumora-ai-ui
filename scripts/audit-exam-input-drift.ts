// scripts/audit-exam-input-drift.ts — 読むだけ（LLM なし・DB なし）。試験の録音（.claude/exam-cache/llm-cassette）で、同じ問題・同じ回・同じ名札の要求が
//   前の録音と違った時、違いの出所（写し・台帳／時計／本番の DB の育ち／コード）を数える（scripts/lib/exam-input-drift.ts）。
//   「コードは同じで台帳・時計・DB だけ違った組」＝直せば録音で使い回せた組（その組の費用も出す）。
// 実行: npx tsx scripts/audit-exam-input-drift.ts [--since=2026-11-04T00:00:00+09:00] [--action=brain_full] [--show=10]
//   ※ 録音は約8万ファイル。更新の時刻（mtime）で先に絞るので、--since を短くすると速い（11/04〜05 で約10分）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CASSETTE_DIR } from "./lib/llm-cassette";
import { classifyDrift, tallyDrift, type DriftResult } from "./lib/exam-input-drift";

const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const since = Date.parse(arg("since", new Date(Date.now() - 2 * 86_400_000).toISOString()));
const actions = new Set(arg("action", "brain_full").split(",").filter(Boolean));
const show = Number(arg("show", "10")) || 10;
const dir = arg("dir", DEFAULT_CASSETTE_DIR);

type E = { action: string; key: string; at: string; body: string; usd: number };
const groups = new Map<string, E[]>();
let files = 0;
for (const sub of readdirSync(dir)) {
  const p = join(dir, sub);
  try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
  for (const f of readdirSync(p)) {
    const fp = join(p, f);
    try { if (statSync(fp).mtimeMs < since) continue; } catch { continue; }
    files++;
    try {
      const e = JSON.parse(readFileSync(fp, "utf8")) as { action?: string; tag?: { problem?: string; rep?: string }; firstAt?: string; normBody?: string; responses?: Array<{ usd?: number }> };
      if (!e.action || !actions.has(e.action) || !e.tag?.problem || Date.parse(e.firstAt ?? "") < since) continue;
      const k = `${e.action}|${e.tag.problem}|${e.tag.rep ?? ""}`;
      const a = groups.get(k) ?? []; a.push({ action: e.action, key: k, at: e.firstAt ?? "", body: String(e.normBody ?? ""), usd: (e.responses ?? []).reduce((s, r) => s + (r.usd ?? 0), 0) }); groups.set(k, a);
    } catch { /* 壊れた録音は飛ばす */ }
  }
}
const results: DriftResult[] = []; let noiseUsd = 0, allUsd = 0;
const samples: string[] = [];
for (const [k, a] of groups) {
  if (a.length < 2) continue;
  a.sort((x, y) => (x.at < y.at ? -1 : 1));
  for (let i = 1; i < a.length; i++) {
    const r = classifyDrift(a[i - 1].body, a[i].body);
    results.push(r); allUsd += a[i].usd;
    if (!r.same && r.kinds.code === 0 && r.kinds.other === 0) noiseUsd += a[i].usd;
    if (samples.length < show && !r.same) samples.push(`${k} #${i}: 主 ${r.primary}（${Object.entries(r.kinds).filter(([, v]) => v).map(([k2, v]) => `${k2} ${v}`).join("・")}）${r.headings.slice(0, 6).join(" ")}`);
  }
}
const t = tallyDrift(results);
console.log(`# 試験の入力の違いの出所（${new Date(since).toISOString()} 以降・名札 ${[...actions].join(",")}・録音 ${files}ファイル）`);
console.log(`- 組 ${t.pairs}（同じ ${t.same}）・主な出所: ${Object.entries(t.byPrimary).map(([k, v]) => `${k} ${v}`).join("・")}`);
console.log(`- 1つでもあった組: ${Object.entries(t.anyOf).map(([k, v]) => `${k} ${v}`).join("・")}`);
console.log(`- コードは同じで台帳・時計・DB だけ違った組（直せば使い回せた）: ${t.onlyNoise}（その組の費用 $${noiseUsd.toFixed(2)}／全組 $${allUsd.toFixed(2)}・録音の値＝DeepSeek の表の単価）`);
for (const s of samples) console.log(`  ${s}`);
