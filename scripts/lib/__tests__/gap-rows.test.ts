// npx tsx scripts/lib/__tests__/gap-rows.test.ts
// 2026-11-23 作業員N2: 穴のまとまりの数と、まとまりが表す行の数（check_gaps_rows:<型>）
import assert from "node:assert/strict";
import { gapRowsOf } from "../../owner-feedback-check";
assert.equal(gapRowsOf([{ rows: 1 }, { rows: 2 }, { rows: 89 }, { rows: 4 }]), 96);
assert.equal(gapRowsOf([{}, { rows: 3 }]), 4, "rows の無い穴は1行と数える");
assert.equal(gapRowsOf([]), 0);
console.log("gap-rows: ok");
