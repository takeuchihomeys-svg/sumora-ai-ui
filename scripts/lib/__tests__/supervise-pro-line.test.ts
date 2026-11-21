// npx tsx scripts/lib/__tests__/supervise-pro-line.test.ts
// 2026-11-22 作業員N2（作業員G の頼み・台帳 #474）: 統括Pro の1行と直しの候補
import assert from "node:assert/strict";
import { superviseProLine } from "../supervise-pro-line";

const rows = [
  { day: "2026-11-21", metric: "search_found_ok:realpro", value: "0.661" }, { day: "2026-11-22", metric: "search_found_ok:realpro", value: "0.640" },
  { day: "2026-11-21", metric: "search_found_critical:realpro", value: "3" }, { day: "2026-11-22", metric: "search_found_critical:realpro", value: "3" },
  { day: "2026-11-22", metric: "search_pro_completion:realpro", value: "65" },
  { day: "2026-11-22", metric: "search_cause_layer:土台:realpro", value: "7" }, { day: "2026-11-22", metric: "search_cause_layer:反映:realpro", value: "2" }, { day: "2026-11-22", metric: "search_cause_layer:把握:realpro", value: "0" },
];
const r = superviseProLine(rows);
assert.equal(r.day, "2026-11-22");
assert.ok(r.line!.includes("土台 ✓ 0.64（前の日 -0.021"), r.line!);
assert.ok(r.line!.includes("原因の型 土台 7・反映 2"), r.line!);
assert.ok(!r.line!.includes("段A"), "まだ入っていない数は出さない");
assert.equal(r.fixes.length, 1);
assert.ok(r.fixes[0].includes("作業員G"));
assert.equal(superviseProLine([]).line, null);
console.log("supervise-pro-line: ok");
