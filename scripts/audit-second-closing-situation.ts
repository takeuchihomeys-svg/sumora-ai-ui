// scripts/audit-second-closing-situation.ts — 竹内さんの2通目の締め（内覧／申込／ご査収）と、その時の状況を並べる（LLM なし）
//   2026-10-29 作業員5（竹内さん「状況に応じて内覧訴求か申込訴求か、竹内のように変えて訴求を行っていく」）。
//   状況（会話と1通目から決定論で読む・網）: 退去予定か／内覧済みか／遠方・時間が無いか／人気・先に申込が入りそうか／刺さり具合（お客様の直近の反応）／入居時期の近さ。
// 実行: npx tsx scripts/audit-second-closing-situation.ts --raw=<raw-second-appeal.json> [--md=<file>]
import { readFileSync, appendFileSync } from "node:fs";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Raw = { action: string; body: { sentMessage?: string | null; recentMessages?: Array<{ sender: string; text: string | null }> }; sent: string };
const raw = (JSON.parse(readFileSync(arg("raw"), "utf8")) as { cases: Raw[] }).cases.filter((c) => c.action.startsWith("rec-second") && (c.sent ?? "").trim());
const closeOf = (t: string) => /お申込|お部屋(?:を)?抑え|押さえ|並行して審査/.test(t) ? "申込" : /ご案内させて|ご内覧|内覧/.test(t) ? "内覧" : "ご査収";
const SIT: Array<{ k: string; f: (c: Raw, cust: string, all: string) => boolean }> = [
  { k: "退去予定（まだ内覧できない）", f: (c, _cu, all) => /退去予定/.test(`${c.body.sentMessage ?? ""}\n${c.sent}`) || /退去予定/.test(all.slice(-600)) },
  { k: "内覧済み", f: (_c, _cu, all) => /内覧(?:頂き|いただき|して頂き)ありがとう|ご内覧ありがとう|本日はお時間頂き/.test(all) },
  { k: "遠方・来られない", f: (_c, cu) => /遠方|県外|東京|名古屋|福岡|来阪|行けない|見に行けない|内覧(?:は|に)?行け/.test(cu) },
  { k: "急ぎ・時間が無い", f: (_c, cu) => /急ぎ|早め|すぐ|今月中|今週|時間が(?:無|な)/.test(cu) },
  { k: "人気・先に申込が入りそう", f: (c) => /人気|申込(?:が)?入|埋まって|早い者勝ち/.test(c.sent) },
  { k: "刺さっている（前向きな反応）", f: (_c, cu) => /いいですね|良さそう|気になり|気に入|素敵|ここ(?:が)?いい|見てみたい|内覧したい/.test(cu.slice(-300)) },
  { k: "入居が近い（今月・来月）", f: (_c, cu) => /今月|来月|[0-9０-９]{1,2}月(?:中|上旬|中旬|頭|末)|すぐ入居/.test(cu) },
];
const counts: Record<string, Record<string, number>> = {};
const total: Record<string, number> = {};
for (const c of raw) {
  const msgs = c.body.recentMessages ?? [];
  const cust = msgs.filter((m) => m.sender === "customer").map((m) => m.text ?? "").join("\n");
  const all = msgs.map((m) => m.text ?? "").join("\n");
  const cl = closeOf(c.sent);
  total[cl] = (total[cl] ?? 0) + 1;
  const sits = SIT.filter((s) => s.f(c, cust, all)).map((s) => s.k);
  for (const s of sits.length ? sits : ["（どれにも当たらない）"]) { counts[s] ??= {}; counts[s][cl] = (counts[s][cl] ?? 0) + 1; }
}
const L = ["", `## 竹内さんの2通目の締めと状況（物件オススメ ${raw.length}通）`, `締め: ${Object.entries(total).map(([k, v]) => `${k} ${v}（${Math.round(100 * v / raw.length)}%）`).join("・")}`, "", "| 状況 | 内覧 | 申込 | ご査収 | 番 |", "|---|---|---|---|---|"];
for (const [s, o] of Object.entries(counts).sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0))) {
  const n = Object.values(o).reduce((x, y) => x + y, 0);
  const p = (k: string) => `${o[k] ?? 0}（${Math.round(100 * (o[k] ?? 0) / n)}%）`;
  L.push(`| ${s} | ${p("内覧")} | ${p("申込")} | ${p("ご査収")} | ${n} |`);
}
const md = L.join("\n");
if (arg("md")) appendFileSync(arg("md"), md + "\n");
console.log(md);
