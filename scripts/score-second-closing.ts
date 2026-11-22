// scripts/score-second-closing.ts — AIX の文の試験の結果で、2通目の締めの強さ（内覧の誘い・申込の押し・ご査収だけ）を竹内さんの正解と並べる（読むだけ・LLM なし・費用0）
//   2026-11-21 作業員K2（#142・統括役「型1・型2 を正解で数え、締めの決めのどこで落ちるかを確かめる」）。
//   型1＝竹内さんは内覧の誘い（invite）・AI は誘い無し（door/none）／型2＝竹内さんは申込で抑える（strong）・AI は押さない／
//   逆向き＝竹内さんは誘わない（door）のに AI が誘う。物差しは appeal-record.appealStrengthOf（cece75180 で直した版）。ご査収の有無も並べる。
//   11/04 の結果（offg3-2nd-off2・second-appeal.json 30問）では: 型2 4/4（竹内さん strong→AI invite）・逆向き（door→invite）8・型1 1。
//   本番の下書き（aix_generate_log・10月）では型1 が7あった＝道ごとに締めの決めが違う疑い。今の版は③の組（second-appeal-sn.json の off）で数える。
// 実行: npx tsx scripts/score-second-closing.ts --res=<結果の json の名前（results/ の下）> [--qfile=second-appeal-sn.json] [--vs=<別の結果>]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appealStrengthOf } from "../app/lib/appeal-record";
import { examCacheRoot } from "./lib/llm-cassette";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DIR = join(examCacheRoot(), "aix-text-exam");
const RECEIPT = /お手隙の際に(?:ごゆっくり)?ご査収/;
const qs = (JSON.parse(readFileSync(join(DIR, arg("qfile", "second-appeal-sn.json")), "utf8")) as { questions: Array<{ id: string; gold: string }> }).questions;

function score(res: string) {
  const r = JSON.parse(readFileSync(join(DIR, "results", res), "utf8")) as { rows: Array<{ id: string; text?: string | null }> };
  const t = { same: 0, type1: 0, type2: 0, reverse: 0, other: 0, receiptBoth: 0, n: 0 };
  const lines: string[] = [];
  for (const q of qs) {
    const row = r.rows.find((x) => x.id === q.id); if (!row?.text) continue;
    t.n++;
    const g = appealStrengthOf(q.gold), a = appealStrengthOf(row.text);
    if (RECEIPT.test(q.gold) && RECEIPT.test(row.text)) t.receiptBoth++;
    const k = g === a ? "same" : g === "invite" && (a === "door" || a === "none") ? "type1" : g === "strong" && a !== "strong" ? "type2" : (g === "door" || g === "none") && (a === "invite" || a === "strong") ? "reverse" : "other";
    t[k]++;
    if (k !== "same") lines.push(`  ${q.id.slice(-8)} 竹内 ${g} → AI ${a}（${k}）`);
  }
  console.log(`${res}: ${t.n}問・締めの強さが同じ ${t.same}・型1（誘いを落とす）${t.type1}・型2（申込の押しを落とす）${t.type2}・逆向き（誘わない番で誘う）${t.reverse}・その他 ${t.other}・ご査収が両方 ${t.receiptBoth}`);
  for (const l of lines) console.log(l);
}
score(arg("res"));
if (arg("vs")) score(arg("vs"));
