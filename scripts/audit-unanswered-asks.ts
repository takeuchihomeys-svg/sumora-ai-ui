// scripts/audit-unanswered-asks.ts — 聞かれたのに答えていない事の照らしが正しいかの目安（#814・2026-11-27 作業員A）
//   LLM も DB も使わない。手元の写し（problems.json の context＝その番の前のやり取り・staffText＝実際にスタッフが送った次の通）と
//   書き手の表（.claude/exam-cache/problem-writers.json）で、竹内さん本人の番だけを見る。
//   数えるもの: 照らしが「答え漏れ」と見た問いのうち、竹内さんが次の通（staffText）で答えていた割合。
//     高い＝答え漏れと見た物は本当に竹内さんが拾う問い（照らしが合っている）。低い＝答えたのに漏れと見ている（照らしの読み違い）か、竹内さんも触れない問い
//   --show で照らしの組を目で読む用に出す（問いの文は 30字まで・お客様の名前は出さない）
//   実行: npx tsx scripts/audit-unanswered-asks.ts [problems.json] [--writers=all] [--show]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unansweredAsks, askStateOf, ASK_TOPIC_JA, type AskTopic } from "../app/lib/unanswered-asks";

const path = process.argv.find((a) => a.endsWith("problems.json")) ?? "scripts/brain-exam/problems.json";
const show = process.argv.includes("--show");
const allWriters = process.argv.includes("--writers=all");
const writers = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", ".claude", "exam-cache", "problem-writers.json"), "utf8")) as Record<string, string>;
type Ctx = { s: string; t: string; aix?: boolean; ago: number };
const probs = JSON.parse(readFileSync(path, "utf8")) as Array<{ id: string; conv: string; at: string; source?: string; context?: Ctx[]; staffText?: string; ledger?: Record<string, Array<{ ago: number; row: Record<string, unknown> }>> }>;
// 書き手の表（5行だけ）に無い時は、写しの出所の札「竹内さんの番」で竹内さん本人の番と見る
const writerOf = (q: { conv: string; at: string; source?: string }) => (/竹内さんの番|竹内さん本人/.test(q.source ?? "") ? "takeuchi" : null) ?? writers[`${q.conv}@${q.at}`] ?? Object.entries(writers).find(([k]) => k.startsWith(q.conv) && Math.abs(Date.parse(k.split("@")[1]) - Date.parse(q.at)) < 120e3)?.[1] ?? null;

let withdrawn = 0, stale = 0, answeredEarlier = 0;
let turns = 0, turnsFlagged = 0, flagged = 0, answeredNext = 0, promisedNext = 0, promised = 0, asksAll = 0;
const byTopic: Record<string, { flagged: number; next: number }> = {};
for (const q of probs) {
  const w = writerOf(q);
  if (!allWriters && w !== "takeuchi") continue;
  if (!q.context?.length || !q.staffText) continue;
  turns++;
  const atMs = Date.parse(q.at);
  const msgs = q.context.map((c) => ({ sender: c.s, text: c.t, created_at: new Date(atMs - c.ago * 6e4).toISOString(), is_aix_generated: !!c.aix }));
  const aix = (q.ledger?.aix_usage_logs ?? []).map((r) => ({ aix_type: String(r.row.aix_type ?? ""), created_at: new Date(atMs - r.ago * 6e4).toISOString() })).filter((a) => Date.parse(a.created_at) <= atMs);
  const asks = unansweredAsks({ msgs, aix, nowMs: atMs + 1 });
  asksAll += asks.length;
  const open = asks.filter((a) => a.state === "open");
  promised += asks.filter((a) => a.state === "promised").length;
  withdrawn += asks.filter((a) => a.state === "withdrawn").length; stale += asks.filter((a) => a.state === "stale").length; answeredEarlier += asks.filter((a) => a.state === "answered").length;
  if (open.length) turnsFlagged++;
  for (const a of open) {
    flagged++;
    const st = askStateOf(a, [{ text: q.staffText }], []);
    const t = (byTopic[a.topic] ??= { flagged: 0, next: 0 }); t.flagged++;
    if (st === "answered") { answeredNext++; t.next++; } else if (st === "promised") promisedNext++;
    if (show) console.log(`  ${q.id} [${ASK_TOPIC_JA[a.topic as AskTopic]}] 「${a.quote.slice(0, 30)}」 後のこちら${a.oursAfter}通 → 次の通: ${st}${st !== "answered" ? `｜次の通の頭「${q.staffText.replace(/\s+/g, " ").slice(0, 40)}」` : ""}`);
  }
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
console.log(JSON.stringify({
  書き手: allWriters ? "全員" : "竹内さん本人", 番: turns, 照らした問い: asksAll, 前の通で答えた: answeredEarlier, 約束で返した問い: promised, 取り消し・了承で外した: withdrawn, 古い問いで外した: stale,
  答え漏れと見た番: turnsFlagged, 答え漏れと見た問い: flagged, 次の通で答えた: answeredNext, 割合: pct(answeredNext, flagged), "答えた＋確認の約束の割合": pct(answeredNext + promisedNext, flagged), 次の通で確認の約束: promisedNext,
  種類ごと: Object.fromEntries(Object.entries(byTopic).map(([k, v]) => [ASK_TOPIC_JA[k as AskTopic], `${v.next}/${v.flagged}`])),
}));
