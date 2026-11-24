// scripts/build-learned-reach.ts — 前の on の回から「スイッチが効いた／効かなかった問題」を覚えて置き場に書く（台帳 #683・読むだけ・LLM なし・DB なし）
// 実行: npx tsx scripts/build-learned-reach.ts [--days=60] [--out=<置き場>]
// 2026-11-25 作業員A（統括役の取り次ぎ・L と表を1本に: L の exam-switch-reach.reachRowOf(sw) が読む）
//   置き場: <倉庫の根>/.claude/exam-cache/learned-reach.json（形は scripts/lib/exam-learned-reach.ts の LearnedReachFile）
//   1つのスイッチを試した回（依頼の switch に名前が1つ）だけを使う。行は依頼の作業ツリーの scripts/brain-exam/results/<label>.jsonl
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { atomicWriteJson } from "./lib/exam-shared-file";
import { learnedSwitchRow, type LearnRow, type LearnedReachFile } from "./lib/exam-learned-reach";
import { SWITCH_REACH } from "./lib/exam-switch-reach";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const DAYS = Number(arg("days") || 60);
const OUT = arg("out") || join(examCacheRoot(), "learned-reach.json");
const Q = join(examCacheRoot(), "exam-queue");
type Job = { label: string; switch?: string; createdAt: string; runner?: string; cwd?: string };
const readJ = <T>(p: string, d: T): T => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return d; } };
const bySw = new Map<string, Array<{ t: number; rows: LearnRow[] }>>();
for (const f of existsSync(join(Q, "done")) ? readdirSync(join(Q, "done")) : []) {
  if (!f.endsWith(".json")) continue;
  const j = readJ<Job | null>(join(Q, "done", f), null);
  if (!j?.label || (j.runner && j.runner !== "brain-exam") || Date.parse(j.createdAt) < Date.now() - DAYS * 864e5) continue;
  const named = [...new Set([...String(j.switch ?? "").matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)].map((m) => m[0]))];
  if (named.length !== 1) continue;
  const p = join(j.cwd ?? ".", "scripts", "brain-exam", "results", `${j.label}.jsonl`);
  if (!existsSync(p)) continue;
  const rows = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as LearnRow; } catch { return null; } }).filter((x): x is LearnRow => !!x);
  const a = bySw.get(named[0]) ?? []; a.push({ t: Date.parse(j.createdAt), rows }); bySw.set(named[0], a);
}
const out: LearnedReachFile = { v: 1, at: new Date().toISOString(), days: DAYS, switches: {} };
for (const [sw, runs] of bySw) out.switches[sw] = learnedSwitchRow(runs, SWITCH_REACH[sw]?.mark ? [SWITCH_REACH[sw].mark!] : []);
atomicWriteJson(OUT, out, true);
const cnt = (v: string) => Object.values(out.switches).reduce((n, s) => n + Object.values(s.problems).filter((p) => p.v === v).length, 0);
console.log(`覚えた表を書いた: ${OUT}（スイッチ ${bySw.size}・問題 効かない ${cnt("none")}・効いた ${cnt("hit")}・分からない ${cnt("unknown")}）`);
