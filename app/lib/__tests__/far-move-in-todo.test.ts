// 入居の時期が先のお客様は連絡の日まで待つ行（app/lib/far-move-in-todo.ts・staff-todo-list の moveInTurns）— 作り物のデータ・LLM なし
// 実行: npx tsx app/lib/__tests__/far-move-in-todo.test.ts（全 PASS で exit 0）
import { todoFarMoveInEnabled, farMoveInOfTurns, moveInRangeLabel, farMoveInWaitText } from "../far-move-in-todo";
import { buildStaffTodoList, renderStaffTodoList, numberTodoItems, type TodoInput } from "../staff-todo-list";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, m = "expected truthy") { if (!v) throw new Error(m); }

const AT = Date.parse("2026-10-28T10:30:00+09:00");
const iso = (s: string) => new Date(Date.parse(s)).toISOString();
const SAID = { conversation_id: "c1", text: "ここもあんまり待ってもらえない感じですかね、、\n12月末から1月前半で引っ越しできそうです！", created_at: iso("2026-10-16T18:02:25+09:00") };

console.log("far-move-in-todo");
it("切替は既定 off", () => {
  eq(todoFarMoveInEnabled({}), false);
  eq(todoFarMoveInEnabled({ TODO_FAR_MOVE_IN: "on" }), true);
});
it("入居の時期の発言から連絡の日（1ヶ月半前）と幅の言い方", () => {
  const p = farMoveInOfTurns([SAID], AT)!;
  ok(p);
  eq(p.contactLabel, "11月15日");
  eq(moveInRangeLabel(p), "12月末〜1月前半");
  eq(farMoveInWaitText(p), "11月15日に連絡（12月末〜1月前半入居）・それまで物件は探さない");
});
it("連絡の日が近い（7日未満）・時期を言っていない・古い発言は null", () => {
  eq(farMoveInOfTurns([SAID], Date.parse("2026-11-10T10:30:00+09:00")), null);
  eq(farMoveInOfTurns([{ ...SAID, text: "よろしくお願いします" }], AT), null);
  eq(farMoveInOfTurns([{ ...SAID, created_at: iso("2026-08-01T10:00:00+09:00") }], AT), null);
});

const base = (): TodoInput => ({
  atMs: AT,
  conversations: [{ id: "c1", customer_name: "テスト", account: "ieyasu", status: "viewing", is_post_apply: false }],
  aixItems: [{ id: "a1", conversation_id: "c1", customer_name: "テスト", action: "property_send", check_pattern: null, status: "pending", created_at: iso("2026-10-17T11:29:48+09:00"), updated_at: iso("2026-10-17T11:29:48+09:00"), done_at: null, done_aix_type: null, done_by: null, resolution_note: null }],
  promises: [], facts: [], viewings: [], messages: [],
});
it("moveInTurns が無い（切替 off）時は今まで通りの番号つきの行", () => {
  const l = buildStaffTodoList(base());
  eq(l.openCount, 1);
  ok(/①AIX【物件ピックアップした】/.test(renderStaffTodoList(l) ?? ""), renderStaffTodoList(l) ?? "");
});
it("入居が先なら待ちの行（番号なし・残りに数えない）", () => {
  const l = buildStaffTodoList({ ...base(), moveInTurns: [SAID] });
  eq(l.openCount, 0);
  eq(numberTodoItems(l).length, 0);
  const text = renderStaffTodoList(l) ?? "";
  ok(text.includes("⏳11月15日に連絡（12月末〜1月前半入居）・それまで物件は探さない"), text);
  ok(!/①/.test(text), text);
});
it("連絡の日が近づけば今まで通りの行に戻る", () => {
  const near = Date.parse("2026-11-10T10:30:00+09:00");
  const l = buildStaffTodoList({ ...base(), atMs: near, aixItems: base().aixItems.map((r) => ({ ...r, created_at: iso("2026-11-09T11:00:00+09:00"), updated_at: iso("2026-11-09T11:00:00+09:00") })), moveInTurns: [SAID] });
  eq(l.openCount, 1);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
