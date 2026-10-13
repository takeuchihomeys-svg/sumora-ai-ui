// 2026-10-13 竹内さん（KAORI）「左右にボタンを分ける。物件あった場合（複数＝物件ピックアップ・1件＝物件オススメ）／物件なかった場合（全力サポート）」（search-result-split.ts）
// 実行: npx tsx app/lib/__tests__/search-result-split.test.ts
import { searchSplitView, isSearchSplitTurn, applySearchSplit, searchSplitServerEnabled } from "../search-result-split";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

console.log("■ 画面: 出す・出さないはブレインの一手だけ");
it("一手が物件ピックアップした・物件オススメ・物件を探す・全力サポート → 左右の形", () => {
  for (const a of ["property_send", "property_recommendation", "property_search", "zenryoku_support"]) eq(isSearchSplitTurn({ brainAction: a }), true, a);
});
it("それ以外の AIX・AIX なし → 今まで通り", () => {
  for (const a of ["estimate_sheet", "property_check_result", "viewing_invite", "", null]) eq(isSearchSplitTurn({ brainAction: a }), false, String(a));
});
it("2択（AIX か返信か）の番は別のカードのまま", () => eq(isSearchSplitTurn({ brainAction: "property_send", twoChoiceMode: true }), false));
it("NEXT_PUBLIC_SEARCH_SPLIT_CHOICE=off（off: true）→ 今まで通り", () => eq(searchSplitView({ brainAction: "property_send", off: true }), null));

console.log("■ 画面: 並びは一手に関係なく固定（左上ピックアップ・左下オススメ・右全力サポート）");
it("KAORI の形（旧は一手＝全力サポート・2つ目＝物件ピックアップ）→ 左に物件ピックアップ・物件オススメ、右に全力サポート", () => {
  const v = searchSplitView({ brainAction: "zenryoku_support", altActions: ["property_send"] })!;
  eq(v.foundHeading, "物件あった場合"); eq(v.notFoundHeading, "物件なかった場合");
  eq(v.found.map((b) => b.action), ["property_send", "property_recommendation"]);
  eq(v.found.map((b) => b.sub), ["複数あった時", "1件の時"]);
  eq(v.notFound.action, "zenryoku_support"); eq(v.notFound.isBrain, true);
  eq(v.others, []);
});
it("一手が物件オススメでも同じ位置（色・位置で押し間違えない）", () => {
  const v = searchSplitView({ brainAction: "property_recommendation", altActions: ["zenryoku_support"] })!;
  eq(v.found.map((b) => b.action), ["property_send", "property_recommendation"]);
  eq(v.found[1].isBrain, true); eq(v.found[0].isBrain, false);
});
it("物件を探す（Chrome拡張で検索）→ 物件ピックアップが一手扱い", () => eq(searchSplitView({ brainAction: "property_search" })!.found[0].isBrain, true));
it("3つ以外の2つ目の AIX（見積書）は下に残す・重複は1つ", () => {
  eq(searchSplitView({ brainAction: "property_send", altActions: ["property_recommendation", "estimate_sheet", "zenryoku_support", "estimate_sheet"] })!.others, ["estimate_sheet"]);
});

console.log("■ サーバー: 出し切りで一手を【全力サポート】に書き換えない");
it("出し切り・一手が物件ピックアップした → 一手はそのまま・全力サポートを2つ目に", () => {
  eq(applySearchSplit({ finalAix: "property_send", fromReply: false, altActions: ["property_recommendation"], exhausted: true, postApply: false }),
    { applies: true, finalAix: "property_send", altActions: ["property_recommendation", "zenryoku_support"], toAix: false });
});
it("出し切り・2段のピックアップの約束（返信）→ AIX の番にし、一手は LLM の物件の AIX（物件オススメ）", () => {
  const r = applySearchSplit({ finalAix: null, fromReply: true, llmAix: "property_recommendation", altActions: undefined, exhausted: true, postApply: false });
  eq(r, { applies: true, finalAix: "property_recommendation", altActions: ["zenryoku_support"], toAix: true });
});
it("出し切り・返信で LLM の AIX が物件でない → 物件ピックアップ（全力サポートには決め打ちしない）", () => {
  eq(applySearchSplit({ finalAix: null, fromReply: true, llmAix: "estimate_sheet", altActions: undefined, exhausted: true, postApply: false }).finalAix, "property_send");
});
it("出し切りでない・申込以降・SEARCH_SPLIT_CHOICE=off → 何もしない（呼ぶ側が旧の動き）", () => {
  eq(applySearchSplit({ finalAix: "property_send", fromReply: false, altActions: undefined, exhausted: false, postApply: false }).applies, false);
  eq(applySearchSplit({ finalAix: "property_send", fromReply: false, altActions: undefined, exhausted: true, postApply: true }).applies, false);
  eq(applySearchSplit({ finalAix: "property_send", fromReply: false, altActions: undefined, exhausted: true, postApply: false, env: { SEARCH_SPLIT_CHOICE: "off" } }).applies, false);
  eq(searchSplitServerEnabled({}), true); eq(searchSplitServerEnabled({ SEARCH_SPLIT_CHOICE: "OFF" }), false);
});
it("返信のままの番（fromReply=false で一手なし）は触らない", () => {
  eq(applySearchSplit({ finalAix: null, fromReply: false, altActions: undefined, exhausted: true, postApply: false }).applies, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(f); process.exit(1); }
