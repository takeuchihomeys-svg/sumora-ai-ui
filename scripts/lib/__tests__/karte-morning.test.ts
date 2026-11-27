// npx tsx scripts/lib/__tests__/karte-morning.test.ts
import assert from "node:assert/strict";
import { karteMorningLine } from "../karte-morning";
import { nightZeroCostSteps } from "../exam-night-jobs";
const d = "2026-11-28";
const rows = [{ day: d, metric: "karte:has_block", value: 100, n: 29 }, { day: d, metric: "karte:avg_len", value: 125 }, { day: d, metric: "karte:dropped", value: 0 }, { day: d, metric: "karte:field:priorities", value: 82.8 }, { day: d, metric: "karte:field:decider", value: 3.4 }];
assert.equal(karteMorningLine(rows), "- お客様のカルテ（#806・2026-11-28・前の7日・29会話）: 出る 100%・平均 125字・優先 82.8%・決める人 3.4%（CUSTOMER_KARTE は既定 off）");
assert.equal(karteMorningLine([]), null);
assert.equal(karteMorningLine([{ day: d, metric: "karte:avg_len", value: 1 }]), null, "出る割合が無ければ出さない");
assert.ok(nightZeroCostSteps("x.json").some((s) => s.args[0] === "scripts/audit-customer-karte.ts" && s.args.includes("--write")), "晩の費用0の仕事");
console.log("karte-morning ok 4");
