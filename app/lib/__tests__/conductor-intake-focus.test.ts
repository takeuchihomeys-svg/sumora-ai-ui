// 実行: npx tsx app/lib/__tests__/conductor-intake-focus.test.ts — 入口の統括に重点を重ねた所（作業員5・11/05・CONDUCTOR_FOCUS 既定 off）
import { intakePrefix, intakePrefixVersion, intakeUser, parseIntake } from "../conductor-intake";
import { FOCUS_INTAKE_RULES } from "../conductor-focus";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const m = [{ brain: "judge", short: "返信か AIX か" }];

it("CONDUCTOR_FOCUS=off: 先頭の文は重点なし・版は ci-v1／ci-v3 のまま（既定は shadow）", () => {
  ok(intakePrefixVersion({ CONDUCTOR_FOCUS: "off" }) === "ci-v1"); ok(intakePrefixVersion({ CONDUCTOR_INTAKE_CUES: "v3", CONDUCTOR_FOCUS: "off" }) === "ci-v3"); ok(intakePrefixVersion({}) === "ci-v1+f1");
  ok(!intakePrefix(m, { CONDUCTOR_FOCUS: "off" }).includes(FOCUS_INTAKE_RULES)); ok(!intakePrefix(m, { CONDUCTOR_FOCUS: "off" }).includes("focus_read"));
});
it("CONDUCTOR_FOCUS=shadow: 先頭に重点の段・書き方に focus_read・版に +f1（ci-v3 の上にも重なる）", () => {
  const env = { CONDUCTOR_FOCUS: "shadow", CONDUCTOR_INTAKE_CUES: "v3" };
  const p = intakePrefix(m, env);
  ok(p.includes(FOCUS_INTAKE_RULES)); ok(p.includes("focus_read")); ok(intakePrefixVersion(env) === "ci-v3+f1"); ok(p.includes("AIX の番になる合図"));
});
it("後ろに近い番の重点の1行（渡した時だけ）", () => {
  const base = { customerTurn: "ありがとうございます", lastStaff: null, ledgerBlock: "", carryLine: "", ruleMeta: "" };
  ok(!intakeUser(base).includes("近い過去の番")); ok(intakeUser({ ...base, nearFocusLine: "【竹内さんの近い過去の番の重点】x" }).includes("近い過去の番"));
});
it("答えの focus_read を読む・無い答えは今まで通り", () => {
  const a = parseIntake('{"scene":"ack","roles":["writer"],"need":[],"todos":[],"doubt":null,"confidence":"high","focus_read":{"surface":"お礼","background":"送った物件を見た","focus":"relation","why":"受けで足りる"}}');
  ok(a?.focus_read?.focus === "relation", JSON.stringify(a?.focus_read));
  const b = parseIntake('{"scene":"ack","roles":["writer"],"need":[],"todos":[],"doubt":null,"confidence":"high"}');
  ok(b && !("focus_read" in b));
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
