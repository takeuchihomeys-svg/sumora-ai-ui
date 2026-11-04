// 実行: npx tsx app/lib/__tests__/conductor-intake.test.ts
import { toFreshDigest } from "../brain-layers";
import { conductorIntakeMode, intakePrefix, intakeUser, parseIntake, intakeCompareTurn, intakeAgreement, intakeCostUsd, INTAKE_PREFIX_VERSION, intakeDigestLine, intakeSaysAix } from "../conductor-intake";
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
it("digest.ci の1行: AIX の印・DeepSeek の場面と AIX の印（前の形の /\\|ds:(.)/ はそのまま読める）", () => {
  const s = parseIntake('{"scene":"cost","roles":["aix_desk"],"need":[],"todos":[{"kind":"promise","what":"a"}],"confidence":"mid"}');
  const d = parseIntake('{"scene":"question","roles":["writer"],"need":[],"todos":[{"kind":"answer","what":"a"}],"confidence":"high"}');
  ok(intakeDigestLine({ answer: s, cacheRead: 1364 }) === "cost|m|cr1364|a1", String(intakeDigestLine({ answer: s, cacheRead: 1364 })));
  const line = intakeDigestLine({ answer: s, ds: d, cacheRead: 0, agree: intakeAgreement(s, d) });
  ok(line === "cost|m|cr0|ds:--n|a1|dx:question:a0", String(line));
  ok(/\|ds:(.)/.exec(line!)?.[1] === "-", "old reader");
  ok(intakeDigestLine({ answer: null }) === null && intakeDigestLine(undefined) === null);
  ok(intakeSaysAix(d) === false && intakeSaysAix(parseIntake('{"scene":"ack","roles":["writer"],"need":[],"todos":[{"kind":"aix","what":"x"}]}')) === true);
  // 前の形で保存された答え（roles・todos が無い）でも落ちない
  ok(intakeDigestLine({ answer: { scene: "ack", confidence: "high" } as never, cacheRead: 5 }) === "ack|h|cr5|a0");
});
it("配線: brain-layers.toFreshDigest が meta.conductor_intake を digest.ci に書く", () => {
  const s = parseIntake('{"scene":"viewing","roles":["writer"],"need":[],"todos":[{"kind":"aix","what":"a"}],"confidence":"high"}');
  const dg = toFreshDigest({ conductor_intake: { answer: s, ds: null, agree: null, cacheRead: 0 } }, null) as { ci?: string };
  ok(dg.ci === "viewing|h|cr0|a1", String(dg.ci));
  ok(!("ci" in (toFreshDigest({}, null) as object)), "no ci when absent");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
