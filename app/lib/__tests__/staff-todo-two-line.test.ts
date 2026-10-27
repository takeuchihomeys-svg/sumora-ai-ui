// 【やることリスト】の2行の形（app/lib/staff-todo-two-line.ts・staff-todo-list の twoLine）— 作り物のデータ・LLM なし
// 実行: npx tsx app/lib/__tests__/staff-todo-two-line.test.ts（全 PASS で exit 0）
import { todoTwoLineEnabled, todoItemTitle, todoItemNextStep, cleanNextAction } from "../staff-todo-two-line";
import { buildStaffTodoList, renderStaffTodoList, type TodoInput } from "../staff-todo-list";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, m = "expected truthy") { if (!v) throw new Error(m); }

console.log("staff-todo-two-line");
it("切替は既定 off", () => {
  eq(todoTwoLineEnabled({}), false);
  eq(todoTwoLineEnabled({ TODO_TWO_LINE: "on" }), true);
});
it("タイトル: AIX の種類・返信・内覧・約束", () => {
  eq(todoItemTitle({ source: "aix_item", action: "property_send", kindLabel: "AIX【物件ピックアップした】", task: "x" }), "物件を探して送る");
  eq(todoItemTitle({ source: "promise", action: "estimate_sheet", kindLabel: "AIX【見積書送る】", task: "x" }), "御見積書を送る（お約束）");
  eq(todoItemTitle({ source: "unanswered", action: null, kindLabel: "返信", task: "x" }), "返信する");
  eq(todoItemTitle({ source: "aix_item", action: "unknown_x", kindLabel: "AIX【何か】", task: "x" }), "何か");
});
it("2行目: 決まった形の指示 → 要約の次にする事 → やる事", () => {
  const base = { source: "aix_item", action: "property_send", kindLabel: "AIX【物件ピックアップした】", task: "ご条件に合うお部屋をピックアップしてお送りする" };
  eq(todoItemNextStep({ ...base, instruction: "AIX【物件ピックアップした】→新着まとめ：条件（梅田・〜8万）で新着を確認して送る" }, "3DKを探して送る"), "AIX【物件ピックアップした】→新着まとめ：条件（梅田・〜8万）で新着を確認して送る");
  eq(todoItemNextStep(base, "同条件の3DKを検索して送る"), "同条件の3DKを検索して送る");
  eq(todoItemNextStep(base, "  "), "AIX【物件ピックアップした】：ご条件に合うお部屋をピックアップしてお送りする");
  eq(todoItemNextStep({ ...base, source: "viewing" }, "何か"), "AIX【物件ピックアップした】：ご条件に合うお部屋をピックアップしてお送りする");
});
it("長い要約は60字で切る", () => {
  eq(cleanNextAction("あ".repeat(80))!.length, 60);
});

const AT = Date.parse("2026-10-28T10:30:00+09:00");
const iso = (s: string) => new Date(Date.parse(s)).toISOString();
const input = (): TodoInput => ({
  atMs: AT,
  conversations: [{ id: "c1", customer_name: "テスト", account: "sumora", status: "proposing", is_post_apply: false }],
  aixItems: [{ id: "a1", conversation_id: "c1", customer_name: "テスト", action: "estimate_sheet", check_pattern: null, status: "pending", created_at: iso("2026-10-28T09:00:00+09:00"), updated_at: null, done_at: null, done_aix_type: null }],
  promises: [], facts: [], viewings: [], messages: [],
  nextActions: { c1: "3件の御見積書を作って送る" },
});
it("一覧: 切替 off は今まで通り1行", () => {
  delete process.env.TODO_TWO_LINE;
  const text = renderStaffTodoList(buildStaffTodoList(input())) ?? "";
  ok(text.includes("①AIX【見積書送る】：御見積書を作ってお送りする（期限 今日中）"), text);
  ok(!text.includes("　→ "), text);
});
it("一覧: 切替 on は タイトル＋2行目", () => {
  process.env.TODO_TWO_LINE = "on";
  try {
    const text = renderStaffTodoList(buildStaffTodoList(input())) ?? "";
    ok(text.includes("①御見積書を送る（期限 今日中）\n　→ 3件の御見積書を作って送る"), text);
  } finally { delete process.env.TODO_TWO_LINE; }
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
