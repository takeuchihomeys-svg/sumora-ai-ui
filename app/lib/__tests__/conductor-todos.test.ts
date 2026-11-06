// 実行: npx tsx app/lib/__tests__/conductor-todos.test.ts
import { conductorTodosOn, turnTodosRecord } from "../conductor-todos";
import { toFreshDigest } from "../brain-layers";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
it("既定 off", () => { ok(!conductorTodosOn({})); ok(conductorTodosOn({ CONDUCTOR_TODOS: "on" })); });
it("やる事の一覧と考える力の配分", () => {
  const r = turnTodosRecord({ asks: [{ quote: "駐車場ありますか", route: "reply" }, { quote: "空いてますか", route: "aix" }, { quote: "x", route: "none" }, "bad"], finalAix: "property_check_result", need: { difficulty: "high", confidence: "mid", missing: ["sheet_detail"] } });
  ok(r.td === "答0/1,A0/1,取0/1", r.td ?? ""); ok(r.tb === "sonnet_thinking:4000", r.tb);
  const r2 = turnTodosRecord({ asks: null, finalAix: null, need: null }); ok(r2.td === null && r2.tb === "sonnet", JSON.stringify(r2));
});
it("配線: digest に td・tb が出る（無い番は欄なし）", () => {
  const d = toFreshDigest({ conductor_todos: { td: "答1/1", tb: "sonnet" } } as Record<string, unknown>, null) as Record<string, unknown>;
  ok(d.td === "答1/1" && d.tb === "sonnet", JSON.stringify({ td: d.td, tb: d.tb }));
  const e = toFreshDigest({} as Record<string, unknown>, null) as Record<string, unknown>; ok(!("td" in e) && !("tb" in e));
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
