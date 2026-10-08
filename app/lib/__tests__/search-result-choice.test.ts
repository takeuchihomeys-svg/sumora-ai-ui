// 2026-10-08 竹内さん「物件が無ければそっちから送るので、その場面の時は2択にする」（search-result-choice.ts）
// 実行: npx tsx app/lib/__tests__/search-result-choice.test.ts
import { searchResultAltActions } from "../search-result-choice";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

it("ピックアップの約束の後（物件ピックアップした）・売上サポに候補なし → 全力サポートも並べる（元の物件オススメは残す）", () => {
  eq(searchResultAltActions({ finalAix: "property_send", pickupReady: false, postApply: false, altActions: ["property_recommendation"] }),
    { altActions: ["property_recommendation", "zenryoku_support"], added: true });
});
it("物件オススメ・物件を探す でも同じ", () => {
  eq(searchResultAltActions({ finalAix: "property_recommendation", pickupReady: false, postApply: false, altActions: undefined }).altActions, ["zenryoku_support"]);
  eq(searchResultAltActions({ finalAix: "property_search", pickupReady: false, postApply: false, altActions: undefined }).added, true);
});
it("売上サポに今送れる候補がある → 並べない（送れる物がある）", () => eq(searchResultAltActions({ finalAix: "property_send", pickupReady: true, postApply: false, altActions: undefined }).added, false));
it("候補を読んでいない（null）→ 並べない", () => eq(searchResultAltActions({ finalAix: "property_send", pickupReady: null, postApply: false, altActions: undefined }).added, false));
it("物件の AIX でない（見積書・内覧調整・約束の返信にした番＝AIX なし）→ 並べない", () => {
  eq(searchResultAltActions({ finalAix: "estimate_sheet", pickupReady: false, postApply: false, altActions: undefined }).added, false);
  eq(searchResultAltActions({ finalAix: null, pickupReady: false, postApply: false, altActions: undefined }).added, false);
});
it("申込以降 → 並べない", () => eq(searchResultAltActions({ finalAix: "property_send", pickupReady: false, postApply: true, altActions: undefined }).added, false));
it("既に並んでいる時は重ねない", () => eq(searchResultAltActions({ finalAix: "property_send", pickupReady: false, postApply: false, altActions: ["zenryoku_support"] }).added, false));
it("SEARCH_RESULT_TWO_CHOICE=off で今まで通り", () => eq(searchResultAltActions({ finalAix: "property_send", pickupReady: false, postApply: false, altActions: undefined, env: { SEARCH_RESULT_TWO_CHOICE: "off" } }).added, false));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
