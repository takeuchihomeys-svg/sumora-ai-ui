// npx tsx app/lib/__tests__/embedding-cache-key.test.ts
// 2026-11-28 作業員L（統括役の決め・案B）: embedding_cache の鍵に文を残さない
import assert from "node:assert/strict";
import { embeddingCacheKey } from "../embedding-cache-key";
const k = embeddingCacheKey("[TPO:検討中] お客様: 審査通りそうですか");
assert.match(k, /^\[TPO:検討中\]h:[0-9a-f]{32}$/, "札と md5 だけ");
assert.ok(!k.includes("審査"), "文は残さない");
assert.match(embeddingCacheKey("前返信 お客様の発言"), /^h:[0-9a-f]{32}$/);
assert.equal(embeddingCacheKey("同じ文"), embeddingCacheKey("同じ文"), "同じ文は同じ鍵");
assert.notEqual(embeddingCacheKey("文A"), embeddingCacheKey("文B"));
assert.match(embeddingCacheKey("[TPO:" + "あ".repeat(60) + "] x"), /^h:/, "長すぎる札は残さない");
console.log("embedding-cache-key ok 6");
