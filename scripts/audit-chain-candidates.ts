// scripts/audit-chain-candidates.ts — CHAIN_INSIGHT_LINE（連鎖の型）が当てはまる試験の問題を選ぶ（2026-11-27 作業員A・LLM/DB なし）
//   試験の問題（problems.json）を、照らしの json（audit-route-progress-takeuchi --json の行・駅・細かい状態・前に送った AIX）と会話と時刻（2時間の内）で突き合わせ、
//   chain-patterns の型に当てはまって見立ての1行が出る問題だけを出す（L の辞書・昼の届きの確かめの候補に足す）
//   実行: npx tsx scripts/audit-chain-candidates.ts <problems.json> <route-progress.json>
import { readFileSync } from "node:fs";
import { featuresOf, chainInsightLine } from "../app/lib/chain-patterns";

const [pPath, rPath] = process.argv.slice(2).filter((a) => a.endsWith(".json"));
const probs = JSON.parse(readFileSync(pPath, "utf8")) as Array<{ id: string; conv: string; at: string }>;
const rows = JSON.parse(readFileSync(rPath, "utf8")) as Array<{ conv: string; at: string; node: string | null; branch: string | null; sub1?: string | null; sentBefore?: Record<string, string> }>;
const hits: string[] = [];
let matched = 0;
for (const q of probs) {
  const t = Date.parse(q.at);
  const r = rows.find((x) => q.conv.startsWith(x.conv) && Math.abs(Date.parse(x.at) - t) <= 2 * 36e5);
  if (!r) continue;
  matched++;
  const line = chainInsightLine(featuresOf({ node: r.node, branch: r.branch, sub1: r.sub1 ?? null, sentBefore: r.sentBefore ?? {}, at: r.at }));
  if (line) hits.push(q.id);
}
console.log(JSON.stringify({ 問題: probs.length, 照らしの行と合った: matched, 型が当てはまる: hits.length, ids: hits }));
