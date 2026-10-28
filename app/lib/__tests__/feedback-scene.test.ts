// 「過去の AIX 判断」の行を今の場面に近い物から（2026-10-29 BRAIN_FEEDBACK_SCENE）
// 実行: npx tsx app/lib/__tests__/feedback-scene.test.ts
import { brainFeedbackSceneOn, pickFeedbackActionRowsForScene } from "../brain-aix-feedback";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const row = (action: string, pressed: number) => ({ kind: "action", action, n: pressed, pressed, alt_top: [{ aix: "x", n: 1 }] });
const FB = [row("property_check_result", 73), row("property_send", 47), row("viewing_invite", 40), row("estimate_sheet", 30), row("phone_call", 5)];

it("既定 off", () => { eq(brainFeedbackSceneOn({}), false); eq(brainFeedbackSceneOn({ BRAIN_FEEDBACK_SCENE: "on" }), true); });
it("場面の候補とスタッフが押した AIX に当たる行が先（件数の多い物件確認した を先頭に固定しない）", () => {
  const r = pickFeedbackActionRowsForScene(FB, { candidate: "phone_call", sceneAix: ["estimate_sheet"] });
  eq(r.map((x) => x.action).slice(0, 2), ["estimate_sheet", "phone_call"]);
});
it("場面が分からない・近い行が無い時は件数順の2行だけ", () => {
  eq(pickFeedbackActionRowsForScene(FB, null).map((x) => x.action), ["property_check_result", "property_send"]);
  eq(pickFeedbackActionRowsForScene(FB, { candidate: "zenryoku_support", sceneAix: [] }).length, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
