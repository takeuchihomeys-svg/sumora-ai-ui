// scripts/build-second-takeuchi-data.ts — 竹内さんの2通目の手本・型の要約を作る（手元の確かめ用・LLM なし）
//
// 2026-10-29 作業員5。本番の表（second_takeuchi_examples・second_takeuchi_forms）に置くのは週1の cron（/api/cron/second-takeuchi-data）だけ。
//   この script は、試験の生の番（scripts/audit-r11-aix-second-cases.ts の出力・伏せ済み）から同じ関数で作り、手元のファイル（.claude/exam-cache の下・git に入れない）に書く。
//   会話由来の文なので倉庫には置かない。
// 実行: npx tsx scripts/build-second-takeuchi-data.ts --raw=<raw-second-appeal.json> --out=<.claude/exam-cache/…/second-takeuchi-local.json>
import { readFileSync, writeFileSync } from "node:fs";
import { buildSecondForms, buildSecondExampleRows, type TakeuchiSecond } from "../app/lib/second-takeuchi-build";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Raw = { action: string; src: string; at: string; body: { sentMessage?: string | null }; sent: string };
const raw = (JSON.parse(readFileSync(arg("raw"), "utf8")) as { cases: Raw[] }).cases;
const scene = (a: string) => a.replace(/^rec-second:/, "物件オススメ・").replace(/^estimate-second$/, "見積書");
const cases: TakeuchiSecond[] = raw.filter((c) => (c.sent ?? "").trim()).map((c) => ({ src: c.src, scene: scene(c.action), at: c.at, card: c.body.sentMessage ?? "", sent: c.sent }));
const forms = buildSecondForms(cases);
const examples = buildSecondExampleRows(cases);
const out = arg("out");
if (!out) throw new Error("--out を付ける（.claude/exam-cache の下）");
writeFileSync(out, JSON.stringify({ forms, examples }, null, 1));
console.log(`手本 ${examples.length}・場面 ${Object.keys(forms).length} → ${out}`);
