// 実行: npx tsx app/lib/__tests__/conductor-intake.test.ts
import { conductorIntakeMode, intakePrefix, intakeUser, parseIntake, intakeCompareTurn, intakeAgreement, intakeCostUsd, INTAKE_PREFIX_VERSION } from "../conductor-intake";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

it("既定 off", () => { ok(conductorIntakeMode({}) === "off" && conductorIntakeMode({ CONDUCTOR_INTAKE: "shadow" }) === "shadow"); });
it("先頭は毎回同じ（日時・顧客名・件数を入れない・並びが変わっても同じ）", () => {
  const a = intakePrefix([{ brain: "judge", short: "x" }, { brain: "aix", short: "y" }]);
  const b = intakePrefix([{ brain: "aix", short: "y" }, { brain: "judge", short: "x" }]);
  ok(a === b && a.includes(INTAKE_PREFIX_VERSION) && !/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/.test(a), "prefix stable");
});
it("後ろは会話と帳面", () => { const u = intakeUser({ customerTurn: "空いてますか", lastStaff: null, ledgerBlock: "【帳面】a", carryLine: "", ruleMeta: "question|ln" }); ok(u.startsWith("【お客様の今の番】") && u.includes("【帳面】a")); });
it("答えの読み・造語は捨てる", () => {
  const a = parseIntake('```json\n{"scene":"question","roles":["writer","foo","aix_desk"],"need":["sheet_detail","x"],"todos":[{"kind":"answer","what":"空き"},{"kind":"zzz","what":"a"}],"doubt":{"kind":"AIXか返信か","between":["返信","AIX"]},"confidence":"low"}\n```');
  ok(a && a.roles.join() === "writer,aix_desk" && a.need.join() === "sheet_detail" && a.todos.length === 1 && a.doubt?.between[1] === "AIX" && a.confidence === "low", JSON.stringify(a));
  ok(parseIntake('{"scene":"made_up"}') === null && parseIntake("no json") === null);
});
it("5番に1番・合い方・費用", () => {
  let n = 0; for (let i = 0; i < 500; i++) if (intakeCompareTurn(`c${i}`, null)) n++;
  ok(n > 60 && n < 140, String(n));
  const x = parseIntake('{"scene":"question","roles":["writer"],"need":[],"confidence":"high"}');
  ok(JSON.stringify(intakeAgreement(x, x)) === '{"scene":true,"roles":true,"need":true}');
  ok(intakeCostUsd({ prefixTokens: 3000, variableTokens: 1500, outputTokens: 250, cacheHit: true }) === 0.00915);
  ok(intakeCostUsd({ prefixTokens: 3000, variableTokens: 1500, outputTokens: 250, cacheHit: false }) === 0.0195);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
