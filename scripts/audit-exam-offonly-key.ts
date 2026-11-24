// scripts/audit-exam-offonly-key.ts — 「段に効くファイルの変更」で off の基準を作り直した物のうち、変更が off のスイッチの中だけだった物（鍵を変えなくてよかった物）を過去に当てる（読むだけ）
// 実行: npx tsx scripts/audit-exam-offonly-key.ts [--days=7] [--json=<file>]
// 2026-11-24 作業員A（統括役の頼み・既定 off の直しの前の数）。DB も LLM も使わない（置き場のファイルと git だけ）
//   見分け: scripts/lib/exam-offonly-diff.ts（迷う物は作り直す側）
//   外れの恐れ: 「off の所だけ」と見た作り直しで、前と今の答えの LLM の要求（pk）が違った問題＝入力が変わっていた（コード以外＝DB の写しの日・時刻の違いでも変わるので多めに出る）
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_DIR } from "./lib/brain-exam-baseline";
import { offOnlyBetween, pairMemo } from "./lib/exam-offonly-key";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const DAYS = Number(arg("days") || 7);
const readJ = <T>(p: string, d: T): T => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return d; } };

type Cfg = { args?: Record<string, unknown>; env?: Record<string, string> };
type BFile = { id: string; problemHash: string; savedAt: string; commit: string; rows: Array<{ rep: number; error?: string; llmCalls?: Array<{ pk: string; src: string }> }>; config?: Cfg };
type Row = { dir: string; cfg: string; commit: string; vk: string; stage: string; b: BFile; t: number; usd: number; config: Cfg };
const stageKeys = readJ<Record<string, { brain: string; draft: string }>>(join(BASELINE_DIR, "stage-keys-sk2.json"), {});
const rows: Row[] = [];
for (const d of readdirSync(BASELINE_DIR)) {
  const m = d.match(/^(?:v-([0-9a-f]+)|([0-9a-f]{10}))-([0-9a-f]{10})$/);
  if (!m) continue;
  const conf = readJ<{ commit?: string; versionKey?: string | null; config?: Cfg }>(join(BASELINE_DIR, d, "config.json"), {});
  for (const f of readdirSync(join(BASELINE_DIR, d))) {
    if (!f.endsWith(".json") || f === "config.json") continue;
    const b = readJ<(BFile & { cost?: { realUsd?: number; replayUsd?: number } }) | null>(join(BASELINE_DIR, d, f), null);
    if (!b?.id || !b.savedAt) continue;
    const config = b.config ?? conf.config ?? {};
    rows.push({ dir: d, cfg: m[3], commit: b.commit ?? conf.commit ?? "", vk: m[1] ?? "", stage: String(config.args?.stage ?? "draft"), b, t: Date.parse(b.savedAt), usd: Number(b.cost?.realUsd ?? 0) + Number(b.cost?.replayUsd ?? 0), config });
  }
}
rows.sort((a, z) => a.t - z.t);
const since = Date.now() - DAYS * 86_400_000;

const pkSet = (b: BFile, rep: number) => new Set((b.rows.find((x) => x.rep === rep && !x.error)?.llmCalls ?? []).map((c) => c.pk));
const sameInput = (a: BFile, b: BFile) => { const x = pkSet(a, 1), y = pkSet(b, 1); if (!x.size || !y.size) return null; return x.size === y.size && [...x].every((p) => y.has(p)); };

const out: Array<{ id: string; dir: string; prev: string; usd: number; safe: boolean; why: string; inputSame: boolean | null }> = [];
for (const [i, r] of rows.entries()) {
  if (r.t < since) continue;
  const prior = rows.slice(0, i).filter((p) => p.b.id === r.b.id && p.b.problemHash === r.b.problemHash && p.stage === r.stage && p.cfg === r.cfg && p.dir !== r.dir);
  const p = prior[prior.length - 1];
  if (!p || !r.commit || !p.commit) continue;
  const st = r.stage === "brain" ? "brain" : "draft";
  const a = stageKeys[r.commit]?.[st], b = stageKeys[p.commit]?.[st];
  if (!a || !b || a === b) continue; // 段の鍵が同じ物は今の持ち越しで済む（ここでは見ない）
  const j = offOnlyBetween(p.commit, r.commit, r.config.env ?? {}, st);
  out.push({ id: r.b.id, dir: r.dir, prev: p.dir, usd: r.usd, safe: j.safe, why: j.why, inputSame: sameInput(p.b, r.b) });
}
const sum = (xs: typeof out) => xs.reduce((s, x) => s + x.usd, 0);
const safe = out.filter((x) => x.safe);
console.log(`■ 段に効くファイルの変更で作り直した off の基準（直近 ${DAYS}日・同じ構成・前の答えあり）: ${out.length}件・$${sum(out).toFixed(2)}（commit の組 ${pairMemo.size}）`);
console.log(`  off のスイッチの中だけ（鍵を変えなくてよかった＝減る金額）: ${safe.length}件・$${sum(safe).toFixed(2)}`);
const risky = safe.filter((x) => x.inputSame === false), sure = safe.filter((x) => x.inputSame === true);
console.log(`  外れの恐れ（off の所だけと見たのに、前と今で LLM の要求が違った）: ${risky.length}件（要求が同じ＝見分けが当たっていた ${sure.length}件・比べられない ${safe.length - risky.length - sure.length}件）`);
console.log(`  作り直すと見た物: ${out.length - safe.length}件・うち前と今の要求が同じだった（見分けが厳しすぎた）${out.filter((x) => !x.safe && x.inputSame === true).length}件`);
console.log(`\n■ commit の組ごと（上位）`);
for (const [k, v] of [...pairMemo.entries()].slice(0, 25)) console.log(`  ${k.split("|")[0].replace(/([0-9a-f]{7})[0-9a-f]+/g, "$1")}: ${v.safe ? "○" : "✗"} ${v.why.slice(0, 160)}`);
if (arg("json")) writeFileSync(arg("json"), JSON.stringify(out, null, 1));
