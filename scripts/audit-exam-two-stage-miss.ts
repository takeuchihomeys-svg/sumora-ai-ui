// scripts/audit-exam-two-stage-miss.ts — 読むだけ・LLM なし（2026-11-15 作業員H・統括役の頼み）
//   試験の外れの台帳（exam-queue/results/weakness-pending.jsonl）から「2段で道が変わる（exam-stage:two_stage:decision:two_stage_promise）」の番を集め、
//   問題ごとに 2段の種類（check・check_question・brought_both・pickup…）・道の並び（ブレイン → 書き換え後）・正解（spec.json の accept）を並べる。
//   正解が AIX なのに約束（2段）に書き換えた型（A）と、正解が約束（2段）なのに外した型（B）に分ける。
//   使い方: npx tsx scripts/audit-exam-two-stage-miss.ts [--days=14]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "14");
const since = Date.now() - DAYS * 86_400_000;
const spec = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")) as Array<{ id: string; accept?: string[]; conv?: string; at?: string; type?: string }>;
const acceptOf = new Map(spec.map((p) => [p.id, p.accept ?? []]));
const lines = readFileSync(join(examCacheRoot(), "exam-queue", "results", "weakness-pending.jsonl"), "utf8").split("\n").filter(Boolean);
type Row = { q: string; label: string; kind: string; path: string; from: string; to: string; accept: string[]; type: "A_aix_to_promise" | "B_promise_missed" | "C_other" };
const rows: Row[] = [];
for (const l of lines) {
  let j: { label?: string; at?: string; hits?: Array<{ key?: string; symptom?: string }> };
  try { j = JSON.parse(l); } catch { continue; }
  if (!j.at || Date.parse(j.at) < since) continue;
  for (const h of j.hits ?? []) {
    if (h.key !== "exam-stage:two_stage:decision:two_stage_promise") continue;
    for (const seg of String(h.symptom ?? "").split(/\s*\/\s*(?=q\d{3})|；|;(?=\s*q\d{3})/)) {
      const m = seg.match(/(q\d{3})#\d+:.*?two_stage_promise\(([a-z_]+)\)/);
      if (!m) continue;
      const path = (seg.match(/・道 ([^・]+)/) ?? [])[1] ?? "";
      const parts = path.split(/\s*→\s*/);
      const from = parts[0] ?? "", to = parts[parts.length - 1] ?? "";
      const accept = acceptOf.get(m[1]) ?? [];
      const acceptAix = accept.some((a) => a.startsWith("AIX:")), acceptTwo = accept.some((a) => a.startsWith("2段"));
      const type: Row["type"] = acceptAix && !acceptTwo && /2段/.test(to) ? "A_aix_to_promise" : acceptTwo && !/2段/.test(to) ? "B_promise_missed" : "C_other";
      rows.push({ q: m[1], label: j.label ?? "", kind: m[2], path, from, to, accept, type });
    }
  }
}
const byQ = new Map<string, Row[]>();
for (const r of rows) { const a = byQ.get(r.q) ?? []; a.push(r); byQ.set(r.q, a); }
const count = (t: Row["type"]) => rows.filter((r) => r.type === t).length;
console.log(`直近 ${DAYS} 日・2段で道が変わる外れ ${rows.length} 回・問題 ${byQ.size}（A 正解 AIX→約束に書き換え ${count("A_aix_to_promise")}・B 正解 約束→外した ${count("B_promise_missed")}・C ほか ${count("C_other")}）`);
for (const [q, rs] of [...byQ].sort((a, b) => b[1].length - a[1].length)) {
  const kinds = [...new Set(rs.map((r) => r.kind))].join(",");
  const paths = [...new Set(rs.map((r) => r.path))].slice(0, 3).join(" ｜ ");
  console.log(`${q}\t${rs.length}回\t型=${[...new Set(rs.map((r) => r.type))].join(",")}\t2段=${kinds}\t正解=${JSON.stringify(rs[0].accept)}\t道=${paths}`);
}
