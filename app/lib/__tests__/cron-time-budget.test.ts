// npx tsx app/lib/__tests__/cron-time-budget.test.ts
// 2026-11-22 作業員N2（台帳 #591・#592）: cron の時間の残り・一括更新の小分け
import assert from "node:assert/strict";
import { updateKnowledgeBudgetOn, canStartWithin, UPDATE_KNOWLEDGE_BUDGET, autoStarBulkChunk, chunksOf, updateKnowledgeUnusedMarkOn } from "../cron-time-budget";

assert.equal(updateKnowledgeBudgetOn({}), false, "既定 off");
assert.equal(updateKnowledgeBudgetOn({ UPDATE_KNOWLEDGE_TIME_BUDGET: "on" }), true);
// 11/21 の本番の形: 1組目の書き込みが 41秒で終わる → 2組目は始めない（始めると 60秒で切れていた）
assert.equal(canStartWithin(0, 41_000, UPDATE_KNOWLEDGE_BUDGET.nextChunkUntilMs), false);
assert.equal(canStartWithin(0, 20_000, UPDATE_KNOWLEDGE_BUDGET.nextChunkUntilMs), true);
assert.equal(canStartWithin(0, 39_000, UPDATE_KNOWLEDGE_BUDGET.cleanupUntilMs), true);
assert.equal(autoStarBulkChunk({}), null, "既定は分けない");
assert.equal(autoStarBulkChunk({ AUTO_STAR_BULK_CHUNK: "10" }), 10);
assert.equal(autoStarBulkChunk({ AUTO_STAR_BULK_CHUNK: "0" }), null);
assert.equal(autoStarBulkChunk({ AUTO_STAR_BULK_CHUNK: "abc" }), null);
const ids = Array.from({ length: 46 }, (_, i) => `id${i}`);
assert.deepEqual(chunksOf(ids, 10).map((c) => c.length), [10, 10, 10, 10, 6]);
assert.deepEqual(chunksOf(ids, null).map((c) => c.length), [46], "off は今まで通り1文");
assert.deepEqual(chunksOf([], 10), []);
assert.equal(updateKnowledgeUnusedMarkOn({}), false, "印も既定 off");
assert.equal(updateKnowledgeUnusedMarkOn({ UPDATE_KNOWLEDGE_UNUSED_MARK: "on" }), true);
console.log("cron-time-budget: ok");
