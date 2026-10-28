// scripts/build-second-takeuchi-data.ts — 2通目の生成に渡す「竹内さんの型の要約」と「手本の候補」を作る（静的データ・LLM なし・毎週作り直す）
//
// 2026-10-29 作業員5（竹内さん 10/29「今までの竹内が送っているのを参考に。1つや2つだけじゃなくて参考にして改善する」）。
//   材料: scripts/audit-r11-aix-second-cases.ts の生の番（竹内さん本人の2通目・確かな書き手だけ・名前は YUMA・maskPII 済み）。
//   出力: app/lib/second-takeuchi-data.ts（FORMS＝場面ごとの数と言い回し・EXAMPLES＝手本の候補）。
//   --holdout=<問題の組の json>: 試験に使う番（src）は手本から外す（答えを手本で見せない）。
// 実行: npx tsx scripts/build-second-takeuchi-data.ts --raw=<raw-second-appeal.json> --forms=<second-forms.json> [--holdout=<second-appeal.json>]
import { readFileSync, writeFileSync } from "node:fs";
import { elementsOf } from "../app/lib/second-appeal-points";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Raw = { id: string; action: string; src: string; at: string; body: { sentMessage?: string | null }; sent: string };
const raw = (JSON.parse(readFileSync(arg("raw"), "utf8")) as { cases: Raw[] }).cases;
const forms = JSON.parse(readFileSync(arg("forms"), "utf8")) as Record<string, unknown>;
const hold = new Set<string>(arg("holdout") ? (JSON.parse(readFileSync(arg("holdout"), "utf8")) as { questions: Array<{ src: string }> }).questions.map((q) => q.src) : []);
const scene = (a: string) => a.replace(/^rec-second:/, "物件オススメ・").replace(/^est-second$/, "見積書");
const examples = raw.filter((c) => !hold.has(c.src) && (c.sent ?? "").trim().length >= 40 && !/〈URL〉|https?:/.test(c.sent))
  .map((c) => ({ scene: scene(c.action), els: elementsOf(c.sent), firstEls: elementsOf(c.body.sentMessage ?? ""), text: c.sent.replace(/\r/g, "").slice(0, 320), at: c.at.slice(0, 10) }));
const fixedForms = Object.fromEntries(Object.entries(forms).map(([k, v]) => [k.replace(/^estimate-second$/, "見積書"), v]));
const out = [
  "// app/lib/second-takeuchi-data.ts — 自動生成（scripts/build-second-takeuchi-data.ts）。手で直さない。",
  `// 竹内さん本人の2通目（確かな書き手だけ・名前は YUMA・伏せ済み）から作った場面ごとの型の要約と手本の候補。作った日 ${new Date().toISOString().slice(0, 10)}・手本 ${examples.length}（試験の番 ${hold.size} は外した）`,
  "/* eslint-disable */",
  `export const SECOND_TAKEUCHI_FORMS: Record<string, { n: number; avgPoints: number; first: Array<{ el: string; pct: number }>; phrases: Array<{ text: string; n: number }>; links: Array<{ key: string; pct: number }>; closing: Array<{ kind: string; pct: number }> }> = ${JSON.stringify(fixedForms, null, 1)};`,
  `export const SECOND_TAKEUCHI_EXAMPLES: Array<{ scene: string; els: string[]; firstEls: string[]; text: string; at: string }> = ${JSON.stringify(examples, null, 0)};`,
  "",
].join("\n");
writeFileSync("app/lib/second-takeuchi-data.ts", out);
console.log(`手本 ${examples.length}・場面 ${Object.keys(fixedForms).length} → app/lib/second-takeuchi-data.ts`);
