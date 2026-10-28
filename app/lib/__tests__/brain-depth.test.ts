// 統括の③深さ（2026-10-29・記録だけの第1段）
// 実行: npx tsx app/lib/__tests__/brain-depth.test.ts
import { decideBrainDepth } from "../brain-depth";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const base = { stampOnly: false, ackOnly: false, closedBefore: false, pickupReady: null, openPromises: 0, gapHours: 1 };

it("審査の相談・申込・複数の依頼は深く", () => {
  eq(decideBrainDepth({ ...base, turnText: "相談なのですが、審査通るように職場の案内してもらえますか" }).depth, "deep");
  eq(decideBrainDepth({ ...base, turnText: "これは最大の割引でしょうか？あと支払い時期はいつになりますか？" }).depth, "deep");
});
it("締めの後のスタンプ・短いお礼は軽い（送れる候補がある時・約束がある時は軽くしない）", () => {
  eq(decideBrainDepth({ ...base, turnText: "[スタンプ]", stampOnly: true, closedBefore: true }), { depth: "light", reason: "締めの後のスタンプ" });
  eq(decideBrainDepth({ ...base, turnText: "ありがとうございます！", ackOnly: true, closedBefore: true }).depth, "light");
  eq(decideBrainDepth({ ...base, turnText: "ありがとうございます！", ackOnly: true, closedBefore: true, pickupReady: true }).depth, "normal", "送れる候補がある時は軽くしない");
  eq(decideBrainDepth({ ...base, turnText: "[スタンプ]", stampOnly: true, closedBefore: true, openPromises: 1 }).depth, "normal", "約束がある時は軽くしない");
});
it("約束の結果待ちの番の新しい発言・久しぶりは深く", () => {
  eq(decideBrainDepth({ ...base, turnText: "まだですか", openPromises: 1 }).reason, "約束の結果待ちの番");
  eq(decideBrainDepth({ ...base, turnText: "お久しぶりです、まだ探してます", gapHours: 24 * 10 }).reason, "久しぶりの連絡");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
