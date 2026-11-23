// npx tsx app/lib/__tests__/action-ledger-digest.test.ts
// 2026-11-23 作業員N2（台帳 #566）: 行動台帳の行の数の短い形と digest.ld
import assert from "node:assert/strict";
import { actionLedgerDigestOf, parseActionLedgerDigest } from "../action-ledger-digest";
import { brainDecisionDigestExtra } from "../brain-decision-ledger";

const s = actionLedgerDigestOf([
  { kind: "pickup_declared", status: "promised" }, { kind: "properties_sent", status: "done" },
  { kind: "properties_sent", status: "done" }, { kind: "estimate_declared", status: "promised" },
]);
assert.equal(s, "e:4|p:2|d:2|k:3");
assert.equal(actionLedgerDigestOf([]), "e:0|p:0|d:0|k:0", "行が0でも分母に入る");
assert.equal(actionLedgerDigestOf(null), null);
assert.deepEqual(parseActionLedgerDigest(s), { entries: 4, promised: 2, done: 2, kinds: 3 });
assert.equal(parseActionLedgerDigest("e:1"), null);
assert.equal(parseActionLedgerDigest(3), null);
// digest: meta に無い番は ld を出さない（今の本番＝何も変わらない）・ある番は写す・形の違う物は入れない
assert.equal("ld" in brainDecisionDigestExtra({}, {}), false);
assert.equal((brainDecisionDigestExtra({ action_ledger_counts: s }, {}) as Record<string, unknown>).ld, s);
assert.equal("ld" in brainDecisionDigestExtra({ action_ledger_counts: "壊れた" }, {}), false);
console.log("action-ledger-digest: ok");
