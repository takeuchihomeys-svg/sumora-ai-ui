// AIX の統括からの差し戻しの材料（2026-10-29）
// 実行: npx tsx app/lib/__tests__/aix-sendback.test.ts
import { sendBackMaterialLine } from "../aix-sendback";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

it("差し戻しが無い・理由が空なら空", () => { ok(sendBackMaterialLine(null, "x") === ""); ok(sendBackMaterialLine({ kind: "promise", why: " " }, "x") === ""); });
it("q197: 物件確認した → 約束で差し戻し（同じ連投の他の依頼も落とさない）", () => {
  const t = sendBackMaterialLine({ kind: "promise", why: "持ち込みの物件は確認の結果がまだ無い（needCheck）" }, "property_check_result");
  ok(/AIX property_check_result/.test(t) && /約束の返信にすべき/.test(t) && /他の依頼も落とさない/.test(t), t);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
