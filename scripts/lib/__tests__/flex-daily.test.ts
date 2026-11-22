// npx tsx scripts/lib/__tests__/flex-daily.test.ts
// 2026-11-22 作業員N2（台帳 #512）: 臨機応変の毎日の数
import assert from "node:assert/strict";
import { flexMetricsOf } from "../flex-daily";

const j = { days: 30, n: 100, groups: {
  "竹内:normal": { n: 40, match: 30 }, "竹内:scene_other": { n: 6, match: 2 }, "竹内:word_brain_mismatch": { n: 4, match: 1 },
  "竹内:mismatch:返信:質問→conditions": { n: 4, match: 1 }, "全体:normal": { n: 80, match: 50 },
} };
const m = flexMetricsOf(j);
assert.equal(m.turns, 50, "竹内さんの番だけ・mismatch の内訳は二重に数えない");
assert.equal(m.off, 10);
assert.equal(m.offRate, 20);
assert.equal(m.offMatch, 30);
assert.equal(m.normalMatch, 75);
assert.equal(flexMetricsOf({ days: 30, n: 0, groups: {} }).offRate, null);
console.log("flex-daily: ok");
import { trustMetricsOf } from "../flex-daily";
const t = trustMetricsOf([{ state: "in_time", writer: "takeuchi" }, { state: "late", writer: "takeuchi" }, { state: "overdue", writer: "employee" }, { state: "in_time", writer: "employee" }, { state: "n/a" }, { state: "pending" }]);
assert.equal(t.judged, 4, "判定なし・期限前は分母外");
assert.equal(t.rate, 50);
assert.equal(t.tkJudged, 2);
assert.equal(t.tkRate, 50);
assert.equal(t.overdue, 1);
console.log("trust-daily: ok");
