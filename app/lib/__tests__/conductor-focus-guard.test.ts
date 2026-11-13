// 触れない話題（no_touch）と条件の繰り返しの範囲（repeat_scope）: meta.conductor_focus の別の欄（2026-11-13 作業員5・作業員10 の頼み・CONDUCTOR_FOCUS_GUARD=on・既定 off）
// 実行: npx tsx app/lib/__tests__/conductor-focus-guard.test.ts
import { parseFocusRead, conductorFocusMeta, focusGuardOn, FOCUS_GUARD_RULES, FOCUS_GUARD_FIELD, parseNoTouch, normalizeRepeatScope } from "../conductor-focus";
import { intakePrefix, intakePrefixVersion } from "../conductor-intake";
import { toFreshDigest } from "../brain-layers";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

it("既定 off", () => { eq(focusGuardOn({}), false); eq(focusGuardOn({ CONDUCTOR_FOCUS_GUARD: " ON " }), true); });
it("読み取り: 触れない話題は空・重複を捨てて最大3つ・範囲は一覧の物だけ", () => {
  eq(parseNoTouch(["プレサンス立売堀の申込", "", "プレサンス立売堀の申込", "見積の金額", "x", "y"]), ["プレサンス立売堀の申込", "見積の金額", "x"]);
  eq(parseNoTouch("文字列"), []); eq(parseNoTouch([null, "null"]), []);
  eq(normalizeRepeatScope("Changed"), "changed"); eq(normalizeRepeatScope("some"), null); eq(normalizeRepeatScope(null), null);
});
it("12196 の形（条件の言い直しの番）: focus_read の中の欄を meta.conductor_focus の no_touch・repeat_scope に", () => {
  const r = parseFocusRead({ focus_read: { focus: "promise_make", surface: "a", background: "b", why: "c", no_touch: ["プレサンス立売堀"], repeat_scope: "changed" } });
  eq(r?.noTouch, ["プレサンス立売堀"]); eq(r?.repeatScope, "changed");
  const m = conductorFocusMeta(r) as { no_touch?: string[]; repeat_scope?: string };
  eq(m.no_touch, ["プレサンス立売堀"]); eq(m.repeat_scope, "changed");
  // 答えの一番上に書かれた時も読む（turn_topics と同じ）
  const r2 = parseFocusRead({ focus_read: { focus: "answer", surface: "a", background: "b", why: "c" }, no_touch: ["審査"], repeat_scope: "none" });
  eq(r2?.noTouch, ["審査"]); eq(r2?.repeatScope, "none");
});
it("欄が無い答えは何も足さない（今と同じ）・範囲が一覧外なら meta に出さない", () => {
  const plain = parseFocusRead({ focus_read: { focus: "answer", surface: "a", background: "b", why: "c" } });
  eq("noTouch" in (plain ?? {}) || "repeatScope" in (plain ?? {}), false);
  const s = JSON.stringify(conductorFocusMeta(plain));
  ok(!s.includes("no_touch") && !s.includes("repeat_scope"));
  const bad = conductorFocusMeta(parseFocusRead({ focus_read: { focus: "answer", surface: "a", background: "b", why: "c", repeat_scope: "some", no_touch: [] } }));
  ok(!JSON.stringify(bad).includes("repeat_scope") && !JSON.stringify(bad).includes("no_touch"));
});
it("入口の版と決まり・書き方は on の時だけ変わる（off の時は1文字も変わらない）", () => {
  const on = { CONDUCTOR_FOCUS: "shadow", CONDUCTOR_FOCUS_GUARD: "on" }, off = { CONDUCTOR_FOCUS: "shadow" };
  ok(intakePrefixVersion(on).endsWith("g1") && !intakePrefixVersion(off).includes("g1"), intakePrefixVersion(on));
  const pOn = intakePrefix([], on), pOff = intakePrefix([], off);
  ok(pOn.includes(FOCUS_GUARD_RULES) && pOn.includes(FOCUS_GUARD_FIELD));
  ok(!pOff.includes("no_touch") && !pOff.includes("repeat_scope"));
  ok(!intakePrefix([], { CONDUCTOR_FOCUS: "off", CONDUCTOR_FOCUS_GUARD: "on" }).includes("no_touch"), "重点が off の時は足さない");
  ok(FOCUS_GUARD_RULES.includes("家賃管理費込み12万円以内") && FOCUS_GUARD_RULES.includes("changed="));
});
it("digest.fg（範囲の頭文字＋触れない話題の数）", () => {
  const d = toFreshDigest({ conductor_focus: { focus: "promise_make", repeat_scope: "changed", no_touch: ["a", "b"] } } as never, null) as Record<string, unknown>;
  eq(d.fg, "c2");
  const d2 = toFreshDigest({ conductor_focus: { focus: "answer", no_touch: ["a"] } } as never, null) as Record<string, unknown>;
  eq(d2.fg, "-1");
  eq("fg" in (toFreshDigest({ conductor_focus: { focus: "answer" } } as never, null) as Record<string, unknown>), false);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
