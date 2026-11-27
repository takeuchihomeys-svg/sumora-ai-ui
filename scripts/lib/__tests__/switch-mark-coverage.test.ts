// npx tsx scripts/lib/__tests__/switch-mark-coverage.test.ts
// 2026-11-27 作業員L（統括役の決め③）: 新しく既定 off の部品を作る時は、材料に入った番に material_marks の印を付け、SWITCH_TARGET_MARK（scripts/lib/exam-snapshot-need.ts）にも足す。
//   今ある印の無いスイッチ（switch-mark-allowlist.json）は警告だけ・一覧に無い新しいスイッチはこのテストで止める（一覧に足して逃がさない）
import assert from "node:assert/strict";
import { join } from "node:path";
import { offSwitchesInCode, offSwitchesInDir, markCoverage } from "../switch-mark-coverage";
import { coveredSwitches, loadAllowlist } from "../../audit-switch-marks";

// 拾う形
assert.deepEqual(offSwitchesInCode('const a = (env.FOO_BAR ?? "").trim().toLowerCase() === "on"; const b = process.env.BAZ_QUX === "on"; const c = (env.KEEP_ON ?? "").trim().toLowerCase() !== "off";'), ["BAZ_QUX", "FOO_BAR"], "既定 off の形だけ（!== off は既定 on）");
assert.deepEqual(markCoverage(["A_X", "B_X", "C_X"], new Set(["A_X"]), new Set(["B_X"])), { covered: ["A_X"], allowed: ["B_X"], fresh: ["C_X"] });
// 本物の点検
const off = offSwitchesInDir(join(__dirname, "..", "..", "..", "app", "lib"));
const cov = markCoverage(off, coveredSwitches(), loadAllowlist());
assert.ok(off.length > 100, "既定 off のスイッチを読めている");
if (cov.allowed.length) console.log(`  ⚠ 印の無い既定 off のスイッチ（今ある物・警告だけ）${cov.allowed.length}`);
assert.deepEqual(cov.fresh, [], `新しい既定 off のスイッチに材料の印が無い: ${cov.fresh.join(",")}（材料に入った番に material_marks の印を付け、scripts/lib/exam-snapshot-need.ts の SWITCH_TARGET_MARK に足す）`);
console.log("switch-mark-coverage ok 4");
