// 実行: npx tsx app/lib/__tests__/conductor-roles.test.ts
import { ROSTER, rosterById, ROSTER_PROMPT, initTurnTodos, markTodo, todosOpen, todoDigest, thinkBudget, conductorRosterOn } from "../conductor-roles";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

it("既定 off・名簿の id は重ならない・道具11", () => {
  ok(!conductorRosterOn({}));
  ok(new Set(ROSTER.map((r) => r.id)).size === ROSTER.length);
  ok(ROSTER.filter((r) => r.kind === "tool").length === 11, String(ROSTER.filter((r) => r.kind === "tool").length));
  ok(rosterById("deep")?.cost.model === "sonnet_thinking"); ok(ROSTER_PROMPT.includes("aix_desk:"));
});
it("やる事の一覧: 作る・済み・digest", () => {
  let t = initTurnTodos({ asks: [{ what: "駐車場の有無", route: "reply" }, { what: "募集状況", route: "promise" }, { what: "x", route: "none" }], finalAction: "estimate", missing: ["sheet_detail"], checks: ["check_coverage"] });
  ok(t.length === 5, String(t.length));
  ok(todoDigest(t) === "答0/1,約0/1,A0/1,取0/1,確0/1", todoDigest(t) ?? "");
  t = markTodo(t, "writer", "done"); t = markTodo(t, "aix_desk", "done"); t = markTodo(t, "fetch_sheet_detail", "skipped");
  ok(todosOpen(t).length === 1 && todosOpen(t)[0].kind === "check");
  ok(todoDigest(t) === "答1/1,約1/1,A1/1,取0/1,確0/1", todoDigest(t) ?? "");
  ok(todoDigest([]) === null);
});
it("考える力の配分", () => {
  ok(thinkBudget({ difficulty: "high", confidence: "low" }).thinkingTokens === 4000);
  ok(thinkBudget({ difficulty: "mid", confidence: "low" }).conductor === "sonnet_thinking");
  ok(thinkBudget(null).conductor === "sonnet" && thinkBudget(null).sub === "deepseek");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
