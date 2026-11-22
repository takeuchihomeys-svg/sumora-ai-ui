// npx tsx app/lib/__tests__/watch-reopen.test.ts
// 2026-11-21 作業員K2（台帳 #313）: 判定の後にお客様の発言が足された見張りの番を読み直す（WATCH_REOPEN_ON_NEW_CUSTOMER・既定 off）
import assert from "node:assert/strict";
import { watchReopenOn, needsReopen } from "../watch-reopen";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
t("既定 off", () => { assert.equal(watchReopenOn({}), false); assert.equal(watchReopenOn({ WATCH_REOPEN_ON_NEW_CUSTOMER: "on" }), true); });
// 本番の番 13674 の形（判定 11/13・お客様の発言が 11/21 に足された）
t("判定の後にお客様の発言が足された番は読み直す", () => { assert.equal(needsReopen({ customer_last_at: "2026-11-21T00:28:09.808+00:00", evaluated_at: "2026-11-13T11:40:28.047+00:00" }), true); });
t("判定より前のお客様の発言・値が無い番は読み直さない", () => {
  assert.equal(needsReopen({ customer_last_at: "2026-11-13T10:00:00Z", evaluated_at: "2026-11-13T11:40:28Z" }), false);
  assert.equal(needsReopen({ customer_last_at: null, evaluated_at: "2026-11-13T11:40:28Z" }), false);
  assert.equal(needsReopen({ customer_last_at: "2026-11-21T00:28:09Z", evaluated_at: null }), false);
});
console.log(`${n} ok`);
