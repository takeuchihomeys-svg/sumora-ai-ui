// npx tsx scripts/lib/__tests__/promise-check-sent-close.test.ts
import assert from "node:assert/strict";
import { closedByProperty, pairSentClosed, summarizeSentClose } from "../../audit-promise-check-sent-close";
import type { PromiseRow } from "../../audit-promise-kept";
assert.equal(closedByProperty("sent_properties"), true);
assert.equal(closedByProperty("aix:property_send"), true);
assert.equal(closedByProperty("aix:property_recommendation"), true);
assert.equal(closedByProperty("aix:property_check_result"), false);
assert.equal(closedByProperty("aix:estimate_sheet"), false);
assert.equal(closedByProperty("staff_text"), false);
assert.equal(closedByProperty(null), false);
const r = (at: string, kind: PromiseRow["kind"], state: PromiseRow["state"], by: string | null): PromiseRow => ({ conv: "82c4d3e8", at, kind, writer: "takeuchi", deadlineBy: "default72h", state, by, scene: "番なし", sceneKey: null });
const off = [r("a", "check", "in_time", "sent_properties"), r("b", "check", "in_time", "aix:property_send"), r("c", "check", "in_time", "staff_text"), r("d", "pickup", "in_time", "sent_properties")];
const on = [r("a", "check", "late", "aix:property_check_result"), r("b", "check", "overdue", null), r("c", "check", "in_time", "staff_text"), r("d", "pickup", "in_time", "sent_properties")];
const pairs = pairSentClosed(off, on);
assert.deepEqual(pairs.map((p) => [p.at, p.onState]), [["a", "late"], ["b", "overdue"]]);
assert.deepEqual(summarizeSentClose(pairs), { closedByProperty: 2, laterResult: 1, laterInTime: 0, laterLate: 1, noResultOverdue: 1, noResultPending: 0 });
console.log("promise-check-sent-close ok 10");
