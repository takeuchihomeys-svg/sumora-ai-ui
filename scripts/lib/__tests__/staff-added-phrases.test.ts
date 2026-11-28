// npx tsx scripts/lib/__tests__/staff-added-phrases.test.ts — スタッフが足した一言の型（台帳 #815）
import assert from "node:assert/strict";
import { addedPhraseKinds, phraseKindsOf, phraseTable } from "../staff-added-phrases";

// 設計知見 2ac1b4b9 の実例の形（ご査収のお礼を頭に足した）
assert.deepEqual(addedPhraseKinds("かしこまりました！！新着が出次第お送りさせて頂きます！！", "ご査収いただきありがとうございます！！\nかしこまりました！！新着が出次第お送りさせて頂きます！！"), ["satisa"]);
assert.deepEqual(addedPhraseKinds("かしこまりました！！", "かしこまりました！！"), [], "同じ型が下書きにもあれば足したと数えない");
assert.deepEqual(addedPhraseKinds("", "ご査収ありがとうございます"), [], "下書きが無い番は数えない");
assert.ok(phraseKindsOf("田中さん\nお世話になっております！！").includes("name") && phraseKindsOf("田中さん\nお世話になっております！！").includes("greeting"));
assert.ok(phraseKindsOf("本日中にご連絡させて頂きます").includes("deadline"));
const t = phraseTable([
  ...Array.from({ length: 4 }, () => ({ scene: "返信:質問", writer: "takeuchi" as const, draft: "はい", sent: "はい！！何卒よろしくお願い致します" })),
  { scene: "返信:質問", writer: "takeuchi" as const, draft: "はい", sent: "はい" },
  ...Array.from({ length: 5 }, () => ({ scene: "返信:質問", writer: "staff" as const, draft: "はい", sent: "はい" })),
], 5);
const tk = t.find((r) => r.who === "竹内さん" && r.kind === "close")!, all = t.find((r) => r.who === "全員" && r.kind === "close")!;
assert.deepEqual([tk.added, tk.turns, tk.share], [4, 5, 80], "竹内さん本人の番だけで数える");
assert.deepEqual([all.added, all.turns, all.share], [4, 10, 40], "全員は全部の番で数える");
assert.equal(phraseTable([{ scene: "少ない", writer: "staff", draft: "a", sent: "よろしくお願いします" }], 5).length, 0, "番が少ない場面は出さない");
console.log("staff-added-phrases ok 9");
