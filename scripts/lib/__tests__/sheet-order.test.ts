// npx tsx scripts/lib/__tests__/sheet-order.test.ts
// 2026-11-23 作業員N2（台帳 #473）: 毎朝の1枚を竹内さんが読む順に
import assert from "node:assert/strict";
import { orderSheetLines } from "../sheet-order";
const lines = [
  "# 自己改善の統括 毎朝の1枚", "",
  "## 1. 方針", "- 重点の型: x", "",
  "## 2. 外れ",
  "### 本番の物差し（主: 2026-11-21）", "- 返信の一致 85%",
  "### 芯: 連携が弱い", "- 統括の受け持ち: 持つ 5/12",
  "### AIX の番の一致（主の数）", "- 今 54.9%",
  "### 伸びしろ（毎朝追う・下がった／上がらない日は直しの候補へ）", "- AIX の最初の一手 —", "- 行動台帳の約束（14日）: 開いている 39・うち期日超え 66.7%",
  "## 3. 組む",
  "### ① 直しの候補（点検の穴・45）", "- 芯: x",
  "### ④ 竹内さんへの確認（open 5件）", "- 費用: y",
];
const out = orderSheetLines(lines);
const heads = out.filter((l) => /^#{2,3} /.test(l));
assert.deepEqual(heads, [
  "## 竹内さんに動いてほしい事（確認事項・まだ果たしていない約束）", "### まだ果たしていない約束", "### ④ 竹内さんへの確認（open 5件）",
  "## 今の質の数と見込み（AIX の番・組・申込までの地図の進み・決めに行く）", "### 本番の物差し（主: 2026-11-21）", "### AIX の番の一致（主の数）",
  "## 統括の受け持ち・穴", "### 芯: 連携が弱い", "### ① 直しの候補（点検の穴・45）",
  "## 作業の細かい行", "### 1. 方針", "### 伸びしろ（毎朝追う・下がった／上がらない日は直しの候補へ）",
]);
assert.equal(out[0], "# 自己改善の統括 毎朝の1枚", "表題はそのまま先頭");
assert.ok(out.indexOf("- 行動台帳の約束（14日）: 開いている 39・うち期日超え 66.7%") < out.indexOf("### ④ 竹内さんへの確認（open 5件）"), "まだ果たしていない約束を先頭に上げる");
assert.equal(out.filter((l) => l === "- 行動台帳の約束（14日）: 開いている 39・うち期日超え 66.7%").length, 1, "動かすだけ（二重にしない）");
const content = (a: readonly string[]) => a.filter((l) => l.startsWith("- ")).sort();
assert.deepEqual(content(out), content(lines), "中身の行は1つも減らない・増えない");
console.log("sheet-order: ok");
