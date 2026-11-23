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

// 2026-11-23 作業員N2: 申込までの地図の駅ごとの一致（sg の時代だけ）・つなぎの割合
import { routeSgMatchRowsOf, tsunagiRowsOf } from "../flex-daily";
{
  const rs = routeSgMatchRowsOf([
    { at: "2026-11-01T00:00", node: "viewing_arrange", digestNode: "proposing" }, // cp の時代＝外す
    { at: "2026-11-10T00:00", node: "hearing", digestNode: "pickup" }, // 同じに数える
    { at: "2026-11-10T00:00", node: "hearing", digestNode: "hearing" },
    { at: "2026-11-11T00:00", node: "estimate", digestNode: "viewing_arrange" },
    { at: "2026-11-12T00:00", node: null, digestNode: "pickup" }, // 駅なし＝外す
  ]);
  const g = (m: string) => rs.find((r) => r.metric === m);
  assert.equal(g("route:sg_match")?.n, 3);
  assert.equal(g("route:sg_match")?.value, 66.7);
  assert.equal(g("route:sg_match:hearing")?.value, 100);
  assert.equal(g("route:sg_match:estimate")?.value, 0);
  const ts = tsunagiRowsOf({ n: 10, by: { 全体: { 全体: { n: 10, apply: 1, viewing: 3, none: 6 } } } });
  assert.equal(ts.find((r) => r.metric === "foundation:link:tsunagi_rate")?.value, 40);
  assert.equal(ts.find((r) => r.metric === "foundation:link:kind:none")?.value, 60);
  assert.equal(tsunagiRowsOf({}).length, 0);
  console.log("route-sg-match・tsunagi-daily: ok");
}