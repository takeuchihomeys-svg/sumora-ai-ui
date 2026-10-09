// 2026-10-08 竹内さんの決定「ブレインの窓を 15→20 通」: brainMsgWindow（戻す BRAIN_MSG_WINDOW=15）
// 実行: npx tsx app/lib/__tests__/brain-msg-window.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { brainMsgWindow, BRAIN_MSG_WINDOW_DEFAULT } from "../brain-msg-window";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

it("既定は20通", () => { eq(BRAIN_MSG_WINDOW_DEFAULT, 20); eq(brainMsgWindow({}), 20); });
it("BRAIN_MSG_WINDOW=15 で旧に戻る", () => { eq(brainMsgWindow({ BRAIN_MSG_WINDOW: "15" }), 15); eq(brainMsgWindow({ BRAIN_MSG_WINDOW: " 25 " }), 25); });
it("範囲外・数でない値は既定（暴走を防ぐ）", () => {
  eq(brainMsgWindow({ BRAIN_MSG_WINDOW: "5" }), 20);
  eq(brainMsgWindow({ BRAIN_MSG_WINDOW: "100" }), 20);
  eq(brainMsgWindow({ BRAIN_MSG_WINDOW: "abc" }), 20);
  eq(brainMsgWindow({ BRAIN_MSG_WINDOW: "17.5" }), 20);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
