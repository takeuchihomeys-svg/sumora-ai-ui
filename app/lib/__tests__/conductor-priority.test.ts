// 実行: npx tsx app/lib/__tests__/conductor-priority.test.ts
import { customerPriority, rankCustomers, planConsumerHints, routingLessons, planDeadlineMs, crossCustomerPriorityOn, planAheadConsumersOn } from "../conductor-priority";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const NOW = Date.parse("2026-11-03T12:00:00+09:00");

it("記録だけ＝既定 on・off で止まる", () => { ok(crossCustomerPriorityOn({}) && planAheadConsumersOn({})); ok(!crossCustomerPriorityOn({ CROSS_CUSTOMER_PRIORITY: "off" })); });
it("優先の点: 内覧の直前・期限・待たせ・約束", () => {
  const a = customerPriority({ stage: "viewing_scheduled", planGoal: "今週中に内覧", lastCustomerAt: "2026-11-03T08:00:00+09:00", lastStaffAt: "2026-11-03T07:00:00+09:00", openPromises: 1, nowMs: NOW });
  const b = customerPriority({ stage: "searching", nowMs: NOW });
  ok(a.score > b.score && a.deep && !b.deep, JSON.stringify([a, b]));
  ok(planDeadlineMs("申込", NOW) === null);
});
it("並べ直しは同点で元の順", () => {
  ok(rankCustomers(["x", "y", "z"], (s) => (s === "z" ? 2 : 1)).join("") === "zxy");
});
it("計画を渡す", () => {
  const h = planConsumerHints({ goal: "今週中に内覧", steps: ["見積書", "内覧調整"] }, NOW);
  ok(h.property?.preferViewable && h.estimate?.nextIsEstimate && h.calendar?.beforeMs != null && h.todo?.label === "次の手: 見積書", JSON.stringify(h));
  ok(planConsumerHints(null, NOW).property === null);
});
it("振り分けの教訓は2回以上だけ", () => {
  const l = routingLessons([
    { scene: "持ち込み", kind: "missed_role", detail: "fetch_sheet_detail" }, { scene: "持ち込み", kind: "missed_role", detail: "fetch_sheet_detail" },
    { scene: "お礼", kind: "handoff_drop", detail: "intent_lost" },
  ]);
  ok(l.length === 1 && l[0].count === 2 && l[0].lesson.includes("fetch_sheet_detail"), JSON.stringify(l));
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
