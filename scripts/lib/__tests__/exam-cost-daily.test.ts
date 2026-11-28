// npx tsx scripts/lib/__tests__/exam-cost-daily.test.ts
import assert from "node:assert/strict";
import { nightCostsOf, qualityRowsOf, examCostMorningLines } from "../exam-cost-daily";
import { nightZeroCostSteps } from "../exam-night-jobs";
const rows = [
  { night: "2026-11-24", cat: "main", route: null, n: 670, usd: 2.58 },
  { night: "2026-11-24", cat: "own", route: "script:brain-exam-l-w30-v3-sol-med", n: 247, usd: 2.46 },
  { night: "2026-11-24", cat: "own", route: "script:brain-exam-a-x", n: 10, usd: 0.05 },
  { night: "2026-11-24", cat: "other", route: "/api/aix/action", n: 6, usd: 0.11 },
  { night: "2026-11-25", cat: "main", route: null, n: 573, usd: 0.18 },
];
const c = nightCostsOf(rows);
assert.equal(c.length, 2);
assert.deepEqual([c[0].main, c[0].own, c[0].other, c[0].total], [2.58, 2.51, 0.11, 5.2]);
assert.equal(c[0].ownRoutes[0].route, "brain-exam-l-w30-v3-sol-med");
const q = qualityRowsOf(c[0], "t");
assert.deepEqual(q.map((r) => r.metric), ["exam_cost:main", "exam_cost:own", "exam_cost:other", "exam_cost:total"]);
assert.ok(q.every((r) => r.scope === "all" && r.day === "2026-11-24"), "scope は quality_daily_scope_chk の許す all");
const lines = examCostMorningLines(q.map((r) => ({ day: r.day, metric: r.metric, value: r.value, detail: r.detail })));
assert.equal(lines[0], "- 試験の費用（llm_usage_logs の名札・2026-11-24 の晩）: 係の試験 $2.58・手元の試験 $2.51・ほか $0.11・計 $5.20／夜の上限 $10 の 52%");
assert.match(lines[1], /⚠ 係の外の試験 \$2\.51（\$1 超え）: brain-exam-l-w30-v3-sol-med \$2\.46（247件）$/);
// 手元が $1 以下なら ⚠ は出さない
assert.equal(examCostMorningLines(qualityRowsOf(c[1], "t") as never).length, 1);
assert.deepEqual(examCostMorningLines([]), []);
assert.ok(nightZeroCostSteps("x.json").some((s) => s.args[0] === "scripts/audit-exam-cost-daily.ts" && s.args.includes("--write")));
console.log("exam-cost-daily ok 10");
