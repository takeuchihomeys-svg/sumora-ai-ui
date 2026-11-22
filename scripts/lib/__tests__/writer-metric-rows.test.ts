// npx tsx scripts/lib/__tests__/writer-metric-rows.test.ts
// 2026-11-23 作業員N2（台帳 #466）: L の writer_link の行を quality_daily に書ける形に（scope の読み替え）
import assert from "node:assert/strict";
import { writerMetricRowsForQd } from "../self-improve-growth";

const r = writerMetricRowsForQd([
  { metric: "writer_link:field:focus:delivered", scope: "reply", value: 100, n: 8, detail: { hours: 72 } },
  { metric: "writer_link:brief:asks:in_draft", scope: "reply", value: 60, n: 5 },
  { metric: "other:x", scope: "reply", value: 1, n: 1 },
]);
assert.equal(r.length, 2, "writer_link の行だけ");
assert.equal(r[0].scope, "draft", "reply は quality_daily の決まりに無い＝draft に");
assert.deepEqual(r[0].detail, { hours: 72 });
assert.equal(writerMetricRowsForQd([{ metric: "writer_link:field:a:delivered", scope: "all", value: 1, n: 1 }])[0].scope, "all");
console.log("writer-metric-rows: ok");
