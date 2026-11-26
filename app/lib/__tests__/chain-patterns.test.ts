// app/lib/__tests__/chain-patterns.test.ts — 連鎖の型（2026-11-26 作業員A）
//   実行: npx tsx app/lib/__tests__/chain-patterns.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sentMarksOf, featuresOf, comboKeysOf, chainPatternsOf, chainInsightLine, chainInsightLineOn, CHAIN_PATTERNS } from "../chain-patterns";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const T = Date.parse("2026-11-20T10:00:00Z");
t("送った印: 種類×日数の幅", sentMarksOf({ estimate_sheet: "2026-11-20T03:00:00Z", property_send: "2026-11-10T00:00:00Z" }, T).join() === "物件:前,見積:今日");
const f = featuresOf({ node: "estimate", branch: null, sub1: null, sentBefore: { estimate_sheet: "2026-11-20T03:00:00Z" }, at: "2026-11-20T10:00:00Z" });
t("組の鍵: 駅だけ・駅＋印", comboKeysOf(f).join("|") === "estimate|estimate+見積:今日");
const rows = [...Array(6)].map(() => ({ f, act: "reply:invite_viewing" })).concat([...Array(6)].map(() => ({ f: { station: "estimate", sub: null, marks: [] as string[] }, act: "reply:promise" })));
const ps = chainPatternsOf(rows);
t("型: 駅だけ 50% → 組 100% の型が出る", ps.length === 1 && ps[0].move === "reply:invite_viewing" && ps[0].share === 100 && ps[0].stationShare === 50);
t("見立ての1行: 当てはまった時だけ・決めるのはあなた", chainInsightLine(f, ps).includes("決めるのはあなた") && chainInsightLine({ station: "x", sub: null, marks: [] }, ps) === "");
t("表: 60日の12型・既定 off", CHAIN_PATTERNS.length === 12 && !chainInsightLineOn({}));
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: on の時だけ・控えの行 chain_insight・気持ちは前の番の判断の記録", bc.includes("cpm.chainInsightLineOn() && ar.loc") && bc.includes('key: "chain_insight"') && bc.includes("mindset: msPrev"));
t("気持ちの印: mindset があれば 気持ち:<状態> が組の部品になる・無ければ今と同じ", comboKeysOf(featuresOf({ node: "proposing", branch: null, at: "2026-11-20T10:00:00Z", mindset: "迷い" })).includes("proposing+気持ち:迷い") && comboKeysOf(featuresOf({ node: "proposing", branch: null, at: "2026-11-20T10:00:00Z" })).join() === "proposing");
console.log(`chain-patterns: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
