// app/lib/second-takeuchi-build.ts — 竹内さんの2通目から「場面ごとの型の要約」と「手本の行」を作る（純関数）
//
// 2026-10-29 作業員5（竹内さん「今までの竹内が送っているのを参考に。1つや2つだけじゃなくて」・KB 585ec774）。
//   会話由来の文を倉庫（GitHub）に載せないため、作った物は DB（second_takeuchi_examples・second_takeuchi_forms・RLS・サーバーの鍵だけ）に置く。
//   集めるのは second-takeuchi-data-server.ts（週1の cron /api/cron/second-takeuchi-data と scripts/build-second-takeuchi-data.ts の両方から）。
import { APPEAL_ELEMENTS, elementsOf } from "./second-appeal-points";

export type TakeuchiSecond = { src: string; scene: string; at: string; card: string; sent: string };
export type SecondFormData = { n: number; avgPoints: number; first: Array<{ el: string; pct: number }>; phrases: Array<{ text: string; n: number }>; links: Array<{ key: string; pct: number }>; closing: Array<{ kind: string; pct: number }> };
export type SecondExampleRow = { src: string; scene: string; els: string[]; first_el: string | null; first_card_els: string[]; body: string; sent_on: string };

const CLOSING: Array<{ key: string; re: RegExp }> = [
  { key: "apply", re: /お申込|お部屋(?:を)?抑え|押さえ|並行して審査/ },
  { key: "viewing", re: /ご案内させて|ご内覧|内覧/ },
  { key: "receipt", re: /ご査収/ },
];
export const SECOND_LINKS: Array<{ key: string; ja: string; re: RegExp }> = [
  { key: "gap_first", ja: "希望とのずれを先に言って勧める（〜となりますが）", re: /(?:となります|ございます|御座います)が[、,]?|ギリギリ|外れますが/ },
  { key: "life_fit", ja: "暮らし方に合う（同棲・お二人・ペットに最適）", re: /(?:同棲|お二人|ご家族|ペット|猫|犬)[^。！!\n]{0,14}(?:最適|ピッタリ|理想|使いやすい|可能)/ },
  { key: "name_osusume", ja: "〇〇さんにかなりオススメ出来るお部屋", re: /さん(?:達)?に(?:かなり|特に)?オススメ(?:出来る|できる)/ },
  { key: "special_pick", ja: "お送りさせて頂きましたお部屋の中でも特に", re: /お部屋の中でも/ },
  { key: "new_listing", ja: "新着で…募集に出ました", re: /新着[^。！!\n]{0,20}募集に(?:出|で)ました/ },
  { key: "good_terms", ja: "好条件のお部屋", re: /好条件/ },
  { key: "screening_ease", ja: "審査が通りやすい（独立系の保証会社）", re: /審査[^。！!\n]{0,16}(?:通過|通り|柔軟|緩)/ },
];
/** 言い回しを数える節（数字・物件名らしい所を伏せる） */
export function phraseClauses(t: string): string[] {
  return t.split(/[、。！!\n]+/).map((s) => s.trim()
    .replace(/[0-9０-９][0-9０-９,，.．]*/g, "0")
    .replace(/[A-Za-zＡ-Ｚａ-ｚ゠-ヿ・ー]{3,}(?:\s?[0-9０-９]+号室)?/g, "〈名〉")
    .replace(/^[^ぁ-ん]{0,4}さん/, "〈名前〉さん")).filter((s) => s.length >= 5 && s.length <= 40);
}
function firstEl(t: string): string | null {
  const hits = APPEAL_ELEMENTS.map((e) => ({ k: e.key, at: t.search(e.re) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
  return hits[0]?.k ?? null;
}
export function buildSecondForms(cases: TakeuchiSecond[]): Record<string, SecondFormData> {
  const by = new Map<string, TakeuchiSecond[]>();
  for (const c of cases) { const l = by.get(c.scene) ?? []; l.push(c); by.set(c.scene, l); }
  const out: Record<string, SecondFormData> = {};
  const top = (o: Record<string, number>, n: number) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  for (const [scene, list] of by) {
    const first: Record<string, number> = {}, clause: Record<string, number> = {}, link: Record<string, number> = {}, closing: Record<string, number> = {};
    let elsSum = 0;
    for (const c of list) {
      const t = c.sent;
      elsSum += elementsOf(t).length;
      const f = firstEl(t); if (f) first[f] = (first[f] ?? 0) + 1;
      for (const cl of new Set(phraseClauses(t))) clause[cl] = (clause[cl] ?? 0) + 1;
      for (const l of SECOND_LINKS) if (l.re.test(t)) link[l.key] = (link[l.key] ?? 0) + 1;
      const k = CLOSING.filter((x) => x.re.test(t)).map((x) => x.key).join("+") || "none";
      closing[k] = (closing[k] ?? 0) + 1;
    }
    const n = list.length;
    out[scene] = {
      n, avgPoints: +(elsSum / n).toFixed(1),
      first: top(first, 4).map(([el, v]) => ({ el, pct: Math.round((100 * v) / n) })),
      phrases: top(clause, 10).filter(([, v]) => v >= 2).map(([text, v]) => ({ text, n: v })),
      links: top(link, 6).map(([key, v]) => ({ key, pct: Math.round((100 * v) / n) })),
      closing: top(closing, 4).map(([kind, v]) => ({ kind, pct: Math.round((100 * v) / n) })),
    };
  }
  return out;
}
export function buildSecondExampleRows(cases: TakeuchiSecond[]): SecondExampleRow[] {
  return cases.filter((c) => c.sent.trim().length >= 40 && !/〈URL〉|https?:/.test(c.sent)).map((c) => ({
    src: c.src, scene: c.scene, els: elementsOf(c.sent), first_el: firstEl(c.sent), first_card_els: elementsOf(c.card),
    body: c.sent.replace(/\r/g, "").slice(0, 400), sent_on: new Date(Date.parse(c.at) + 9 * 3600_000).toISOString().slice(0, 10),
  }));
}
