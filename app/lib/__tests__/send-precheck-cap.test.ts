// 実行: npx tsx app/lib/__tests__/send-precheck-cap.test.ts
import { withCap, sendPrecheckFastOn } from "../send-precheck-cap";
let passed = 0, failed = 0;
async function it(name: string, fn: () => Promise<void> | void) { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const sleep = <T,>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
(async () => {
  console.log("send-precheck-cap");
  await it("間に合えば中身", async () => eq(await withCap(sleep(10, "ok"), 200, "fb"), "ok"));
  await it("間に合わなければ fallback・onTimeout を呼ぶ", async () => { let n = 0; const t0 = Date.now(); eq(await withCap(sleep(500, "late"), 50, "fb", () => n++), "fb"); eq(n, 1); eq(Date.now() - t0 < 300, true); });
  await it("null の fallback（読めない時は確かめない＝今と同じ）", async () => eq(await withCap(sleep(500, { data: [1] }), 30, null), null));
  await it("既定 off", () => { eq(sendPrecheckFastOn({}), false); eq(sendPrecheckFastOn({ SEND_PRECHECK_FAST: "on" }), true); });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
