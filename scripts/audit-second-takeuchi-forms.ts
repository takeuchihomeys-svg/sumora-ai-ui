// scripts/audit-second-takeuchi-forms.ts — 竹内さんの2通目の型を、ボタン×ピッカーと場面ごとに数える（LLM なし）
//
// 2026-10-29 作業員5（竹内さん 10/29「今までの竹内が送っているのを参考に。1つや2つだけじゃなくて参考にして改善する」）。
//   材料: scripts/audit-r11-aix-second-cases.ts の生の番（竹内さんが AIX の1通目の直後 20 分以内に手で送った2通目・確かな書き手だけ・伏せ済み）。
//   数える物: 何を一番に言うか（訴求の要素）・訴求の数・よく使う言い回しと回数・1通目のどの行を使ったか・お客様の条件／状況との結び方・締めの種類と場面。
//   出力: Markdown（scratchpad の second-appeal.md に足す）と、生成に渡す型の要約の JSON（--json=）。
// 実行: npx tsx scripts/audit-second-takeuchi-forms.ts --raw=<raw-second-appeal.json> [--md=<file>] [--json=<file>]
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { APPEAL_ELEMENTS, elementsOf, firstMessagePoints } from "../app/lib/second-appeal-points";
import { factSimilarity } from "../app/lib/knowledge-gap";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Raw = { id: string; action: string; at: string; body: { sentMessage?: string | null; recentMessages?: Array<{ sender: string; text: string | null }> }; sent: string };
const raw = (JSON.parse(readFileSync(arg("raw"), "utf8")) as { cases: Raw[] }).cases.filter((c) => (c.sent ?? "").trim());

const CLOSING: Array<{ key: string; re: RegExp }> = [
  { key: "apply", re: /お申込|お部屋(?:を)?抑え|押さえ|並行して審査/ },
  { key: "viewing", re: /ご案内させて|ご内覧|内覧/ },
  { key: "receipt", re: /ご査収/ },
];
const LINK: Array<{ key: string; ja: string; re: RegExp }> = [
  { key: "gap_first", ja: "希望とのずれを先に言って勧める（〜となりますが）", re: /(?:となります|ございます|御座います)が[、,]?|ギリギリ|外れますが/ },
  { key: "life_fit", ja: "暮らし方に合う（同棲・お二人・ペット等に最適）", re: /(?:同棲|お二人|ご家族|ペット|猫|犬)[^。！!\n]{0,14}(?:最適|ピッタリ|理想|使いやすい|可能)/ },
  { key: "name_osusume", ja: "〇〇さんにかなりオススメ出来るお部屋", re: /さん(?:達)?に(?:かなり|特に)?オススメ(?:出来る|できる)/ },
  { key: "special_pick", ja: "お送りさせて頂きましたお部屋の中でも特に", re: /お部屋の中でも/ },
  { key: "new_listing", ja: "新着で…募集に出ました", re: /新着[^。！!\n]{0,20}募集に(?:出|で)ました/ },
  { key: "good_terms", ja: "好条件のお部屋", re: /好条件/ },
  { key: "screening_ease", ja: "審査が通りやすい（独立系の保証会社）", re: /審査[^。！!\n]{0,16}(?:通過|通り|柔軟|緩)/ },
];
// 言い回し: 文を節に切って、数字・物件名らしい所を伏せて数える
function clauses(t: string): string[] {
  return t.split(/[、。！!\n]+/).map((s) => s.trim()
    .replace(/[0-9０-９][0-9０-９,，.．]*/g, "0")
    .replace(/[A-Za-zＡ-Ｚａ-ｚ゠-ヿ・ー]{3,}(?:\s?[0-9０-９]+号室)?/g, "〈名〉")
    .replace(/^[^ぁ-ん]{0,4}さん/, "〈名前〉さん")).filter((s) => s.length >= 5 && s.length <= 40);
}

type Agg = { n: number; elsSum: number; first: Record<string, number>; has: Record<string, number>; clause: Record<string, number>; link: Record<string, number>; closing: Record<string, number>; usedCardLine: number; cardPos: Record<string, number>; examples: string[] };
const groups = new Map<string, Agg>();
const sceneOf = (c: Raw) => c.action.replace(/^rec-second:/, "物件オススメ・").replace(/^est-second:/, "見積書・");
for (const c of raw) {
  const k = sceneOf(c);
  const g = groups.get(k) ?? { n: 0, elsSum: 0, first: {}, has: {}, clause: {}, link: {}, closing: {}, usedCardLine: 0, cardPos: {}, examples: [] };
  g.n++;
  const t = c.sent;
  const hits = APPEAL_ELEMENTS.map((e) => ({ key: e.key, at: t.search(e.re) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
  g.elsSum += hits.length;
  if (hits[0]) g.first[hits[0].key] = (g.first[hits[0].key] ?? 0) + 1;
  for (const h of hits) g.has[h.key] = (g.has[h.key] ?? 0) + 1;
  for (const cl of new Set(clauses(t))) g.clause[cl] = (g.clause[cl] ?? 0) + 1;
  for (const l of LINK) if (l.re.test(t)) g.link[l.key] = (g.link[l.key] ?? 0) + 1;
  const cls = CLOSING.filter((x) => x.re.test(t)).map((x) => x.key).join("+") || "none";
  g.closing[cls] = (g.closing[cls] ?? 0) + 1;
  // 1通目のどの行を使ったか（文の似方 0.35 以上の行の位置）
  const pts = firstMessagePoints(c.body.sentMessage);
  const sents = t.split(/[。！!\n]+/).filter((s) => s.trim().length >= 6);
  const used = pts.map((p, i) => ({ i, p, s: Math.max(0, ...sents.map((s) => factSimilarity(p, s))) })).filter((x) => x.s >= 0.35);
  if (used.length) { g.usedCardLine++; for (const u of used) { const el = elementsOf(u.p)[0] ?? "other"; g.cardPos[el] = (g.cardPos[el] ?? 0) + 1; } }
  if (g.examples.length < 4) g.examples.push(t.replace(/\s+/g, " ").slice(0, 200));
  groups.set(k, g);
}
const ja = (k: string) => APPEAL_ELEMENTS.find((e) => e.key === k)?.ja ?? k;
const top = (o: Record<string, number>, n: number) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
const L: string[] = ["", `## 竹内さんの2通目の型（全期間 2026-07-11〜・確かな書き手だけ・${raw.length}通）`, ""];
const forms: Record<string, unknown> = {};
for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const pct = (v: number) => `${Math.round((100 * v) / g.n)}%`;
  L.push(`### ${k}（${g.n}通）`, `- 訴求の数の平均 ${(g.elsSum / g.n).toFixed(1)}・1通目のオススメポイントの行を使った ${pct(g.usedCardLine)}`);
  L.push(`- 一番に言う物: ${top(g.first, 5).map(([e, v]) => `${ja(e)} ${pct(v)}`).join("・")}`);
  L.push(`- 含む物: ${top(g.has, 7).map(([e, v]) => `${ja(e)} ${pct(v)}`).join("・")}`);
  L.push(`- 1通目から使った行の種類: ${top(g.cardPos, 5).map(([e, v]) => `${ja(e)} ${v}`).join("・") || "-"}`);
  L.push(`- 結び方: ${top(g.link, 7).map(([e, v]) => `${LINK.find((x) => x.key === e)?.ja ?? e} ${pct(v)}`).join("・")}`);
  L.push(`- 締め: ${top(g.closing, 5).map(([e, v]) => `${e} ${pct(v)}`).join("・")}`);
  L.push(`- よく使う言い回し: ${top(g.clause, 12).filter(([, v]) => v >= 2).map(([cl, v]) => `「${cl}」${v}`).join("・")}`);
  L.push("- 実物:", ...g.examples.map((e) => `  - ${e}`), "");
  forms[k] = {
    n: g.n, avgPoints: +(g.elsSum / g.n).toFixed(1),
    first: top(g.first, 4).map(([e, v]) => ({ el: e, pct: Math.round((100 * v) / g.n) })),
    phrases: top(g.clause, 10).filter(([, v]) => v >= 2).map(([cl, v]) => ({ text: cl, n: v })),
    links: top(g.link, 6).map(([e, v]) => ({ key: e, pct: Math.round((100 * v) / g.n) })),
    closing: top(g.closing, 4).map(([e, v]) => ({ kind: e, pct: Math.round((100 * v) / g.n) })),
  };
}
const md = L.join("\n");
if (arg("md")) appendFileSync(arg("md"), md);
if (arg("json")) writeFileSync(arg("json"), JSON.stringify(forms, null, 1));
console.log(md);
