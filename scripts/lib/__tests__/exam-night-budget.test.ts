// 晩の上限（全員で $10）の門（scripts/lib/exam-cost-gate.ts の nightBudgetGate・nightStartMs・nightCapUsd）
// 実行: npx tsx scripts/lib/__tests__/exam-night-budget.test.ts（全 PASS で exit 0）
import { nightBudgetGate, nightStartMs, nightCapUsd } from "../exam-cost-gate";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };

ok("既定 $10・off で止める・数で変える", nightCapUsd({}) === 10 && nightCapUsd({ EXAM_NIGHT_CAP_USD: "off" }) === null && nightCapUsd({ EXAM_NIGHT_CAP_USD: "15" }) === 15);

// 晩の始まり: JST 23時（14Z）→ 同じ日の JST 12時（03Z）／JST 2時（17Z 前日）→ 前の日の JST 12時
const n23 = Date.parse("2026-11-21T14:00:00Z"), n02 = Date.parse("2026-11-21T17:00:00Z"), n10 = Date.parse("2026-11-22T01:00:00Z");
ok("JST 23時の晩は同じ日の 12時から", nightStartMs(n23) === Date.parse("2026-11-21T03:00:00Z"));
ok("JST 2時の晩は前の日の 12時から", nightStartMs(n02) === Date.parse("2026-11-21T03:00:00Z"));
ok("JST 10時（昼の前）も前の日の 12時から", nightStartMs(n10) === Date.parse("2026-11-21T03:00:00Z"));

const jobs = [
  { label: "grp-brain", createdAt: "2026-11-21T13:00:00Z", usd: 3 },
  { label: "grp-reply", createdAt: "2026-11-21T13:05:00Z", usd: 3 },
  { label: "grp-reply", createdAt: "2026-11-21T13:05:00Z", usd: 3 },  // 同じ label は1回
  { label: "old", createdAt: "2026-11-20T15:00:00Z", usd: 9 },        // 前の晩は数えない
  { label: "bad", createdAt: "", usd: 9 },                            // 読めない時刻は数えない
];
const g1 = nightBudgetGate(jobs, 3, n23, 10);
ok("3＋3＋3 ≤ 10 は積む", g1.go && g1.usedUsd === 6, g1);
const g2 = nightBudgetGate(jobs, 4.5, n23, 10);
ok("3＋3＋4.5 ＞ 10 は積まない・理由に合計", !g2.go && g2.why.includes("$6.00") && g2.why.includes("$4.50"), g2);
ok("上限なしは積む", nightBudgetGate(jobs, 100, n23, null).go);

console.log(`exam-night-budget: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
