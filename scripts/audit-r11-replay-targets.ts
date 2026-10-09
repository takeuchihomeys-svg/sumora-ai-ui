// scripts/audit-r11-replay-targets.ts — 11巡目: YUMA の再生を、直した所ごとの的（竹内さんの形に合ったか）で版ごとに数える（読むだけ・LLM なし）
//   似ている度は DeepSeek の揺れ（同じ版の2回の差）に埋もれるので、直した所ごとに「竹内さんの送信と同じ形か」を番ごとに数える:
//     質問の番の書き出し（かしこまりましたで始めるか）・「確認出来次第」・何卒の有無・！！の数の差・行の数の差・空行の有無・約束の文末の「ね」・「新着で出次第」（物件0件の番）
// 実行: npx tsx scripts/audit-r11-replay-targets.ts <jsonl> [--versions=before,after,after2]
import { readFileSync } from "node:fs";
import { resolveReplySceneBrainFirst } from "../app/lib/reply-scene-brain";
const args = process.argv.slice(2);
const FILE = args.find((a) => !a.startsWith("--"))!;
const VERSIONS = (args.find((a) => a.startsWith("--versions="))?.slice(11) ?? "before,after,after2").split(",");
type Rec = { id: string; customer?: string[]; staff?: string; brain?: { intent?: string | null; q?: string[]; cond?: string | null; scope?: string | null; hes?: string | null; action?: string | null }; [k: string]: unknown };
const recs = readFileSync(FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Rec).filter((r) => r.staff && VERSIONS.every((v) => typeof r[`draft_${v}`] === "string" && (r[`draft_${v}`] as string).trim()));
const body = (t: string) => t.trim().replace(/^[^\n、！!。？?]{1,14}(?:さん|様)[、,\s]*/, "").replace(/^お世話になっております[^\n]*\n?/, "").trim();
const kashiko = (t: string) => /^(?:かしこまりました|承知)/.test(body(t));
const kakunin = (t: string) => /確認(?:出来|でき)次第/.test(t);
const nani = (t: string) => /何卒/.test(t);
const bang = (t: string) => (t.normalize("NFKC").match(/!{2,}/g) ?? []).length;
const lines = (t: string) => t.trim().split("\n").filter((l) => l.trim()).length;
const blank = (t: string) => /\n[ \t　]*\n/.test(t.trim());
const ne = (t: string) => /(?:頂|いただ)きますね|(?:致|いた)しますね/.test(t);
console.log(`番 ${recs.length}（全部の版がそろった番）`);
const rows: Array<[string, (r: Rec, d: string) => boolean | null]> = [
  ["質問の番の書き出しが竹内さんと同じ（かしこまりましたで始める／始めない）", (r, d) => { const s = resolveReplySceneBrainFirst({ customerText: (r.customer ?? []).join("\n"), brain: r.brain ? { fresh: true, intent: r.brain.intent, questions: r.brain.q, conditionChangeType: r.brain.cond, hesitancy: r.brain.hes, action: r.brain.action } : null }).scene; return s === "question" ? kashiko(d) === kashiko(r.staff!) : null; }],
  ["「確認出来次第」の有無が竹内さんと同じ", (r, d) => kakunin(d) === kakunin(r.staff!)],
  ["何卒の有無が竹内さんと同じ", (r, d) => nani(d) === nani(r.staff!)],
  ["！！の数の差が1以内", (r, d) => Math.abs(bang(d) - bang(r.staff!)) <= 1],
  ["行の数の差が1以内", (r, d) => Math.abs(lines(d) - lines(r.staff!)) <= 1],
  ["空行の有無が竹内さんと同じ", (r, d) => blank(d) === blank(r.staff!)],
  ["約束の文末の「ね」が無い", (_r, d) => !ne(d)],
];
console.log(["的", ...VERSIONS].join(" | "));
for (const [name, f] of rows) {
  const cells = VERSIONS.map((v) => { let n = 0, ok = 0; for (const r of recs) { const x = f(r, r[`draft_${v}`] as string); if (x === null) continue; n++; if (x) ok++; } return `${ok}/${n}（${n ? Math.round((100 * ok) / n) : 0}%）`; });
  console.log([name, ...cells].join(" | "));
}
const avg = (f: (t: string) => number) => VERSIONS.map((v) => (recs.reduce((a, r) => a + f(r[`draft_${v}`] as string), 0) / recs.length).toFixed(2));
console.log(`平均の！！: 竹内 ${(recs.reduce((a, r) => a + bang(r.staff!), 0) / recs.length).toFixed(2)} ／ ${VERSIONS.map((v, i) => `${v} ${avg(bang)[i]}`).join(" ")}`);
console.log(`平均の行: 竹内 ${(recs.reduce((a, r) => a + lines(r.staff!), 0) / recs.length).toFixed(2)} ／ ${VERSIONS.map((v, i) => `${v} ${avg(lines)[i]}`).join(" ")}`);
console.log(`何卒の数: 竹内 ${recs.filter((r) => nani(r.staff!)).length} ／ ${VERSIONS.map((v) => `${v} ${recs.filter((r) => nani(r[`draft_${v}`] as string)).length}`).join(" ")}`);
