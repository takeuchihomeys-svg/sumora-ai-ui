// npx tsx scripts/lib/__tests__/estimate-done-unsent-read.test.ts
// 2026-11-22 作業員N2（台帳 #580）: K2 の audit-estimate-done-unsent --json の1行を読む
import assert from "node:assert/strict";
import { lastJsonLine } from "../self-improve-growth";

const out = "見積の予定（30日）: 済み 65・送っていない 18（9会話）・重複 15\n{\"days\":30,\"done\":65,\"unsent\":18,\"unsent_convs\":9,\"dup\":15,\"convs\":[\"abcd1234\"]}\n";
assert.deepEqual(lastJsonLine<{ unsent: number; dup: number }>(out), { days: 30, done: 65, unsent: 18, unsent_convs: 9, dup: 15, convs: ["abcd1234"] });
assert.equal(lastJsonLine("json なし"), null);
assert.equal(lastJsonLine("{壊れた"), null);
console.log("estimate-done-unsent-read: ok");
