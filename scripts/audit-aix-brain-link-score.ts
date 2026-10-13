// scripts/audit-aix-brain-link-score.ts — yuma-aix-brain-link-test.ts の前後を竹内さんの実送信で採点する（読むだけ・LLM なし）
//   物差し: ①芯の近さ（dice）②竹内さんが書いていない文（余計）の数 ③竹内さんだけの文（足りない）の数
//          ④竹内さんが書いていない約束の文（確認・交渉・作成・お送りします）⑤冒頭・締めの型が竹内さんと同じか ⑥作り事（入力に無い日付・時刻・金額・号室）
//   本質（ブレインの turn_contract）が届いた番と届かない番を分けて出す（届かない番は前後が同じ材料＝揺れの大きさの目安）
// 実行: npx tsx scripts/audit-aix-brain-link-score.ts --label=link1 [--samples=3]
import { readFileSync, existsSync } from "node:fs";
import { diffTexts, coreOf, dice, openerKindOf } from "../app/lib/text-diff-types";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const LABEL = arg("label", "link1");
const SAMPLES = Number(arg("samples", "0"));
type Case = { id: string; action: string; route: string; sent: string; inputText: string };
type Out = { id: string; action: string; v: "before" | "after"; rep: number; text: string; err: string | null; contract?: boolean };
const cases = new Map((JSON.parse(readFileSync(`scripts/.replay-out/aixlink-cases-${LABEL}.json`, "utf8")).cases as Case[]).map((c) => [c.id, c]));
const outs = readFileSync(`scripts/.replay-out/r11-aix-${LABEL}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Out).filter((o) => o.text && cases.has(o.id));
const PROMISE_RE = /(?:確認|交渉|作成|お探し|ピックアップ|手配|調整|ご連絡|お送り)(?:させて|致し|いたし)(?:頂|いただ)きます|別途お送り|改めて(?:ご案内|ご連絡)/;
const sents = (t: string) => t.split("\n").flatMap((l) => l.split(/(?<=[！!。])(?=[^！!])/)).map((x) => x.trim()).filter((x) => x.length >= 6);
const closer = (t: string) => { const l = (t.trim().split("\n").filter(Boolean).pop() ?? "").normalize("NFKC"); return /ご査収/.test(l) ? "査収" : /ご都合|ご案内させて|如何|いかが|御座いますでしょうか/.test(l) ? "内覧・都合" : /お申込/.test(l) ? "申込" : /何卒|よろしく/.test(l) ? "何卒" : "その他"; };
const N = (s: string) => s.normalize("NFKC").replace(/,/g, "");
function novel(text: string, input: string): number {
  const ni = N(input); let n = 0;
  for (const m of N(text).matchAll(/(\d{1,2})\/(\d{1,2})|(\d{1,2}):(\d{2})|(\d{4,})円|(\d{2,4})号室/g)) if (!ni.includes(m[0])) n++;
  return n;
}
type Sc = { sim: number; extra: number; missing: number; extraPromise: number; opener: boolean; closer: boolean; novel: number };
function score(o: Out, c: Case): Sc {
  const d = diffTexts(o.text, c.sent);
  const sentPromises = sents(c.sent).filter((x) => PROMISE_RE.test(x)).map(coreOf);
  const extraPromise = sents(o.text).filter((x) => PROMISE_RE.test(x) && !sentPromises.some((s) => dice(s, coreOf(x)) >= 0.6)).length;
  return { sim: d.sim, extra: d.detail.removed.length, missing: d.detail.added.length, extraPromise, opener: openerKindOf(o.text) === openerKindOf(c.sent), closer: closer(o.text) === closer(c.sent), novel: novel(o.text, c.inputText) };
}
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const f = (x: number) => Number.isNaN(x) ? "-" : x.toFixed(2);
const pct = (xs: boolean[]) => xs.length ? `${Math.round(100 * xs.filter(Boolean).length / xs.length)}%` : "-";
console.log(`# ${LABEL}: ブレインの本質を AIX の文へ（前=AIX_BRAIN_CONTRACT=off／後=on）× 竹内さんの実送信`);
console.log("種類｜本質｜番｜版｜生成｜近さ｜余計な文｜足りない文｜竹内さんに無い約束の文｜冒頭が同じ｜締めが同じ｜作り事");
const groups = new Map<string, Out[]>();
for (const o of outs) { const k = `${o.action}｜${o.contract ? "あり" : "なし"}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(o); }
const tot: Record<string, Sc[]> = { before: [], after: [] };
for (const [k, os] of [...groups].sort()) {
  for (const v of ["before", "after"] as const) {
    const ss = os.filter((o) => o.v === v).map((o) => score(o, cases.get(o.id)!));
    if (k.endsWith("あり")) tot[v].push(...ss);
    console.log(`${k}｜${new Set(os.map((o) => o.id)).size}｜${v === "before" ? "前" : "後"}｜${ss.length}｜${f(avg(ss.map((s) => s.sim)))}｜${f(avg(ss.map((s) => s.extra)))}｜${f(avg(ss.map((s) => s.missing)))}｜${f(avg(ss.map((s) => s.extraPromise)))}｜${pct(ss.map((s) => s.opener))}｜${pct(ss.map((s) => s.closer))}｜${f(avg(ss.map((s) => s.novel)))}`);
  }
}
for (const v of ["before", "after"] as const) { const ss = tot[v]; console.log(`本質ありの合計｜${v === "before" ? "前" : "後"}｜${ss.length}｜近さ ${f(avg(ss.map((s) => s.sim)))}｜余計 ${f(avg(ss.map((s) => s.extra)))}｜足りない ${f(avg(ss.map((s) => s.missing)))}｜無い約束 ${f(avg(ss.map((s) => s.extraPromise)))}｜冒頭 ${pct(ss.map((s) => s.opener))}｜締め ${pct(ss.map((s) => s.closer))}｜作り事 ${f(avg(ss.map((s) => s.novel)))}`); }
// 番ごと（後が前より悪い番＝近さが 0.1 以上下がった番）
const byId = new Map<string, Out[]>(); for (const o of outs) { if (!byId.has(o.id)) byId.set(o.id, []); byId.get(o.id)!.push(o); }
const worse: string[] = [], better: string[] = [];
for (const [id, os] of byId) {
  const c = cases.get(id)!; const b = avg(os.filter((o) => o.v === "before").map((o) => score(o, c).sim)), a = avg(os.filter((o) => o.v === "after").map((o) => score(o, c).sim));
  if (a - b <= -0.1) worse.push(`${id}（${f(b)}→${f(a)}）`); else if (a - b >= 0.1) better.push(`${id}（${f(b)}→${f(a)}）`);
}
console.log(`\n近さが 0.1 以上 良くなった番 ${better.length}: ${better.join(" ")}`);
console.log(`近さが 0.1 以上 悪くなった番 ${worse.length}: ${worse.join(" ")}`);
if (SAMPLES) {
  for (const [id, os] of [...byId].slice(0, 200)) {
    const c = cases.get(id)!;
    console.log(`\n━━ ${id}\n  竹内: ${c.sent.replace(/\n+/g, "／").slice(0, 240)}`);
    for (const o of os.filter((x) => x.rep < SAMPLES)) console.log(`  ${o.v === "before" ? "前" : "後"}${o.rep + 1}(${f(score(o, c).sim)}): ${o.text.replace(/\n+/g, "／").slice(0, 240)}`);
  }
}
if (!existsSync(`scripts/.replay-out/r11-aix-${LABEL}.brain.jsonl`)) console.log("（判断の記録なし）");
