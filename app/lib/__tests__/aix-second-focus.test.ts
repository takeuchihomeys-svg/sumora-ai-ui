// npx tsx app/lib/__tests__/aix-second-focus.test.ts
// 2026-11-21 作業員L（台帳 #466）: 統括の重点を AIX の2通目の書き手へ（AIX_SECOND_FOCUS・既定 off）
import assert from "node:assert/strict";
import { aixSecondFocusOn, aixSecondFocusLine } from "../aix-second-focus";
assert.equal(aixSecondFocusOn({}), false);
assert.equal(aixSecondFocusOn({ AIX_SECOND_FOCUS: "on" }), true);
const line = aixSecondFocusLine({ conductor_focus: { focus: "promise_keep", why: "前の番の募集状況の確認の約束を果たす番" } });
assert.ok(line.includes("【統括の重点（この番で一番大切にする事）】約束を果たす＝前の番の募集状況の確認の約束を果たす番"), line);
assert.ok(line.includes("事実・物件名・金額は足さない"));
assert.equal(aixSecondFocusLine({}), "");
assert.equal(aixSecondFocusLine(null), "");
console.log("aix-second-focus: ok");
