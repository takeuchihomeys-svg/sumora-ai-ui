// npx tsx app/lib/__tests__/todo-old-promises.test.ts
// 2026-11-24 作業員L（台帳 #667）: やることリストが14営業日を過ぎて外す約束 ①送った記録で閉じる ②末尾に古い約束（どちらも既定 off）
import assert from "node:assert/strict";
import { buildStaffTodoList, stalePromisesOf, oldPromisesLines, renderStaffTodoList, todoCloseBySentOn, todoOldPromisesOn, type TodoInput } from "../staff-todo-list";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const AT = Date.parse("2026-11-24T03:00:00Z");
const iso = (d: number) => new Date(AT - d * 86_400_000).toISOString();
const input = (extra: Partial<TodoInput> = {}): TodoInput => ({
  atMs: AT,
  conversations: [{ id: "c1aaaaaa-0000", customer_name: "テストA", account: null, status: "proposing", is_post_apply: false }, { id: "c2bbbbbb-0000", customer_name: "テストB", account: null, status: "proposing", is_post_apply: false }] as never,
  aixItems: [],
  promises: [
    { id: 1, conversation_id: "c1aaaaaa-0000", customer_name: "テストA", event_type: "property_send", start_at: iso(30), created_at: iso(30), notes: "【必ず】物件ピックアップ送付【今日中】", is_done: false },
    { id: 2, conversation_id: "c2bbbbbb-0000", customer_name: "テストB", event_type: "follow_up", start_at: iso(25), created_at: iso(25), notes: "【必ず】保証会社の確認→ご連絡", is_done: false },
  ],
  facts: [], viewings: [], messages: [],
  ...extra,
});

t("既定は off（今まで通り外すだけ・stalePromises も付けない）", () => {
  assert.equal(todoCloseBySentOn({}), false);
  assert.equal(todoOldPromisesOn({}), false);
  const l = buildStaffTodoList(input());
  assert.equal(l.skipped.promise_stale, 2);
  assert.equal(l.stalePromises, undefined);
  assert.doesNotMatch(renderStaffTodoList(l) ?? "", /古い約束/);
});

t("外した約束を集める（古い順・日数）", () => {
  const st = stalePromisesOf(input());
  assert.deepEqual(st.map((x) => [x.id, x.openDays]), [[1, 30], [2, 25]]);
  assert.match(st[0].task, /物件ピックアップ送付/);
});

t("② 古い約束の段（上限を超えた分は件数だけ）", () => {
  const st = stalePromisesOf(input());
  const ls = oldPromisesLines(st, 1);
  assert.match(ls[1], /古い約束（期日から2週間を過ぎて開いたまま・2件）/);
  assert.match(ls[2], /（30日）/);
  assert.equal(ls[3], "ほか 1件");
  assert.deepEqual(oldPromisesLines([]), []);
});

t("① 送った記録で閉じる（STAFF_TODO_CLOSE_BY_SENT=on の時・ピックアップの約束だけ）", () => {
  const prev = process.env.STAFF_TODO_CLOSE_BY_SENT;
  process.env.STAFF_TODO_CLOSE_BY_SENT = "on";
  try {
    const st = stalePromisesOf(input({ propertySends: [{ conversation_id: "c1aaaaaa-0000", at: iso(20) }, { conversation_id: "c2bbbbbb-0000", at: iso(10) }] }));
    assert.deepEqual(st.map((x) => x.id), [2], "ピックアップは送った記録で済み・確認の約束は物件の送付で閉じない");
    const before = stalePromisesOf(input({ propertySends: [{ conversation_id: "c1aaaaaa-0000", at: iso(40) }] }));
    assert.deepEqual(before.map((x) => x.id), [1, 2], "約束より前の送付では閉じない");
  } finally { if (prev === undefined) delete process.env.STAFF_TODO_CLOSE_BY_SENT; else process.env.STAFF_TODO_CLOSE_BY_SENT = prev; }
});

console.log(`todo-old-promises: ${n} ok`);
