// scripts/brain-exam-split-measure.ts — ブレインの試験の答案を「AIX と返信を分けた物差し」で並べる（読むだけ・LLM なし）
//
// 2026-10-14 竹内さん（10/13）「ちゃんと AIX か返信か分別できる必要がある」。scripts/audit-split-reply-aix.ts（本番の番）と同じ分け方を試験の答案に当てる:
//   正解の道で問題を分ける（返信の問題＝accept に AIX が無い／AIX の問題＝accept が AIX か 2段 だけで返信が無い／両方）
//   ① AIX の言い過ぎ: 返信の問題でブレインが AIX（＝人が文で済ませた番に AIX）
//   ② AIX の言い足りない: AIX の問題でブレインが返信（2段の約束も返信でない＝AIX の問題の 2段 は外れにしない）
//   ③ 道の合格（judgePath の ok）・AIX の問題で同じ AIX
// 使い方: npx tsx scripts/brain-exam-split-measure.ts --labels=<前>,<後> [--only=q001,..]
import { readFileSync, existsSync } from "node:fs";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const labels = arg("labels").split(",").filter(Boolean);
const only = new Set(arg("only").split(",").filter(Boolean));
type Spec = { id: string; type: string; accept: string[]; mustNot?: string[] };
const spec: Spec[] = JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8"));
const byId = new Map(spec.map((s) => [s.id, s]));
type Row = { id: string; rep: number; path?: { code: string; ok: boolean }; error?: string };
const kindOf = (s: Spec) => {
  const a = s.accept;
  const aix = a.some((x) => x.startsWith("AIX")), rep = a.some((x) => x === "返信" || x === "なし"), two = a.some((x) => x.startsWith("2段"));
  if (aix && !rep) return two ? "AIX/2段の問題" : "AIX の問題";
  if (!aix && rep) return two ? "返信/2段の問題" : "返信の問題";
  if (!aix && !rep && two) return "2段の問題";
  return "両方の問題";
};
const codeKind = (c: string) => (c.startsWith("AIX") ? "AIX" : c.startsWith("2段") ? "2段" : c === "なし" ? "なし" : "返信");
for (const label of labels) {
  const f = `scripts/brain-exam/results/${label}.jsonl`;
  if (!existsSync(f)) { console.log(`${label}: 無い`); continue; }
  const rows: Row[] = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r: Row) => !r.error && r.path && (!only.size || only.has(r.id)));
  const m = new Map<string, { n: number; ok: number; aix: number; two: number; reply: number }>();
  const over: string[] = [], under: string[] = [];
  for (const r of rows) {
    const s = byId.get(r.id); if (!s) continue;
    const k = kindOf(s);
    const e = m.get(k) ?? { n: 0, ok: 0, aix: 0, two: 0, reply: 0 };
    e.n++; if (r.path!.ok) e.ok++;
    const ck = codeKind(r.path!.code);
    if (ck === "AIX") e.aix++; else if (ck === "2段") e.two++; else e.reply++;
    m.set(k, e);
    if ((k === "返信の問題" || k === "返信/2段の問題") && ck === "AIX") over.push(`${r.id}(${r.path!.code})`);
    if ((k === "AIX の問題") && ck !== "AIX") under.push(`${r.id}(${r.path!.code})`);
    if ((k === "AIX/2段の問題") && ck === "返信") under.push(`${r.id}(${r.path!.code})`);
  }
  console.log(`\n## ${label}（答案 ${rows.length}）`);
  for (const [k, e] of [...m].sort()) console.log(`  ${k.padEnd(14)} n=${String(e.n).padStart(3)} 道の合格 ${e.ok}・ブレイン 返信 ${e.reply}／2段 ${e.two}／AIX ${e.aix}`);
  console.log(`  ① AIX の言い過ぎ（返信の問題で AIX）${over.length}: ${over.join(" ")}`);
  console.log(`  ② AIX の言い足りない（AIX の問題で返信）${under.length}: ${under.join(" ")}`);
  console.log(`  道の合格 合計 ${rows.filter((r) => r.path!.ok).length}/${rows.length}`);
}
