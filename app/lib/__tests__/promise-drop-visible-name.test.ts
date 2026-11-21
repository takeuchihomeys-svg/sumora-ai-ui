// npx tsx app/lib/__tests__/promise-drop-visible-name.test.ts
// 2026-11-21 作業員L（#435 の確かめ: 本番の朝の文に「︎︎さん」と出た）: 見えない字だけの呼び名はお客様の名前に
import assert from "node:assert/strict";
import { visibleName } from "../promise-drop-watch-server";
assert.equal(visibleName("\uFE0E\uFE0E"), null);
assert.equal(visibleName("​"), null);
assert.equal(visibleName(" KAORI "), "KAORI");
assert.equal(visibleName(null), null);
console.log("promise-drop-visible-name: ok");
