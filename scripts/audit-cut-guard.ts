// scripts/audit-cut-guard.ts — 試験の削りごとの見落としを毎朝数える1本の口（台帳 #686 の③・2026-11-25 作業員L・読むだけ・LLM なし・DB なし）
//   なぞりの道具（audit-narrow-rule・audit-reps-rule・audit-guard-yield）を順に流し、削りごとに見落とした悪化を出す。
//   --apply: 見落としが出た削り（自動で止める物）を、試験の係の設定（exam-queue/config.json の examEnv）に =off で書き、統括役に知らせる（notify.jsonl）。
//   止めた削りを戻すのは人（統括役）＝この台本は on に戻さない。
// 実行: npx tsx scripts/audit-cut-guard.ts [--dir=<results>] [--queue=<exam-queue>] [--apply]
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CUTS, decideOff, missedOf, type CutId } from "./lib/exam-cut-guard";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const Q = arg("queue", "C:/Users/竹内 悠馬/sumora-ai-ui/.claude/exam-cache/exam-queue");
const DIR = arg("dir", "scripts/brain-exam/results");
const cfgPath = join(Q, "config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { examEnv?: Record<string, string> } & Record<string, unknown>;
const env = cfg.examEnv ?? {};
const lines: string[] = [];
const offs: Array<{ sw: string; why: string }> = [];
for (const cut of Object.keys(CUTS) as CutId[]) {
  const c = CUTS[cut];
  let out: Record<string, unknown> = {};
  try {
    const s = execFileSync("npx", ["tsx", c.tool, `"--dir=${DIR}"`, `"--queue=${Q}"`], { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
    out = JSON.parse(s.slice(s.indexOf("{")));
  } catch (e) { lines.push(`- ${c.name}（${c.sw}）: なぞれない（${String(e).slice(0, 80)}）`); continue; }
  const missed = missedOf(cut, out);
  const d = decideOff(cut, missed, env);
  lines.push(`- ${c.name}（${c.sw}・今 ${env[c.sw] ?? "既定"}）: ${d.why}${d.off ? " → 止める" : ""}`);
  if (d.off) offs.push({ sw: c.sw, why: d.why });
}
// 2026-11-25 作業員L（統括役の決め）: 判定の段（tier）の見落とし＝flash 2回が揃って pro と合否が違った答案（q051 の型）。
//   判定の比べの出力（brain-exam --judge-compare-out の JSON・--tier-compare=<path>）があれば数える。止めずに数だけ（tier は試験の比べの中では崩れない＝統括役の決め）
const tc = arg("tier-compare");
if (tc) {
  try {
    const j = JSON.parse(readFileSync(tc, "utf8")) as { rows?: Array<{ id: string; v: Record<string, { asks: boolean[]; ng: boolean[] } | null> }> };
    const pass = (x: { asks: boolean[]; ng: boolean[] } | null | undefined) => (x ? x.asks.every(Boolean) && !x.ng.some(Boolean) : null);
    const pairs: Array<[string, string]> = [["tier", "pro"], ["tier-v3", "v3"]];
    for (const [a, b] of pairs) {
      const rs = (j.rows ?? []).filter((r) => r.v[a] && r.v[b]);
      if (!rs.length) continue;
      const miss = rs.filter((r) => pass(r.v[a]) !== pass(r.v[b])).map((r) => r.id);
      lines.push(`- 判定の段（${a} と ${b}）: 合否が違った ${miss.length}/${rs.length}答案${miss.length ? `（${miss.join("・")}）` : ""}（止めずに数だけ）`);
    }
  } catch (e) { lines.push(`- 判定の段: 比べの出力を読めない（${String(e).slice(0, 60)}）`); }
}
console.log(`# 試験の削りの見落とし（前の答案になぞる・${new Date().toISOString()}）`);
console.log(lines.join("\n"));
if (offs.length && argv.includes("--apply")) {
  for (const o of offs) { env[o.sw] = "off"; (cfg as Record<string, unknown>)[`_cutGuard_${o.sw}`] = `${new Date().toISOString()} audit-cut-guard が止めた（${o.why}）・戻すのは統括役`; }
  cfg.examEnv = env;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 1));
  appendFileSync(join(Q, "results", "notify.jsonl"), JSON.stringify({ at: new Date().toISOString(), to: "main", owner: "作業員L", label: "audit-cut-guard", msg: `削りの見落としで止めた: ${offs.map((o) => `${o.sw}（${o.why}）`).join("・")}` }) + "\n");
  console.log(`止めた（examEnv に =off）: ${offs.map((o) => o.sw).join("・")}・係の起動し直しで効く`);
} else if (offs.length) console.log("（--apply で止める）");
