// 実行: npx tsx app/lib/__tests__/conductor-combine.test.ts
import { conductorCombineOn, combineFromMeta } from "../conductor-combine";
import { planFromMeta } from "../two-message-plan";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

it("既定 off", () => { ok(!conductorCombineOn({})); ok(conductorCombineOn({ CONDUCTOR_COMBINE: "on" })); });
it("返信の番: 組み立てを作り、返信か AIX かは変えない・重点があれば使った順番", () => {
  const meta = { action: null, reply_mode: "reply", turn_contract: { asks: [{ quote: "駐車場はありますか", route: "reply" }] }, conductor_focus: { focus: "answer" } };
  const p = combineFromMeta(meta);
  ok(p && p.two_message_plan && p.two_message_plan.messages.length >= 1);
  ok(p!.conductor_order?.startsWith("judge>"), p!.conductor_order ?? "");
  ok(!("action" in (p as object)), "action を返さない");
});
it("置いた組み立ては planFromMeta でそのまま読める（1つの正）", () => {
  const meta: Record<string, unknown> = { action: "property_check_result", turn_contract: { asks: [{ quote: "空いてますか", route: "aix", aix: "property_check_result" }] } };
  const p = combineFromMeta(meta)!;
  Object.assign(meta, p);
  const back = planFromMeta(meta);
  ok(back && back.messages.length === p.two_message_plan.messages.length);
  ok(p.two_message_plan.seen_customer_at === null, "見た時刻（analyzed_msg_ts が無ければ null）");
  ok(p.conductor_order === null, "重点が無ければ順番は無い");
});
it("形の崩れた asks は捨てる・meta が無ければ null", () => {
  ok(combineFromMeta(null) === null);
  const p = combineFromMeta({ action: null, turn_contract: { asks: [{ route: "reply" }, "x", null] } });
  ok(p && Array.isArray(p.two_message_plan.messages));
});
it("relation の継続の約束: keepPromise=true の番は順番に compose の1段が入る", () => {
  const p = combineFromMeta({ action: null, turn_contract: { asks: [] }, conductor_focus: { focus: "relation", keepPromise: true } }, { scene: "ack" });
  ok(p?.conductor_order === "judge>compose>writer", p?.conductor_order ?? "");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
