// 【やることリスト】の読み込みの時間の決まり（app/lib/staff-todo-load-timing.ts）— 作り物の時刻だけ・DB も LLM もなし
// 実行: npx tsx app/lib/__tests__/staff-todo-load-timing.test.ts（全 PASS で exit 0）
import { staffTodoFastLoadEnabled, hubBudgetMs, todoDeadlineAtMs, createStageTimer, withinDeadline, TODO_SEND_RESERVE_MS } from "../staff-todo-load-timing";

let passed = 0, failed = 0;
async function it(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

(async () => {
  console.log("staff-todo-load-timing");
  await it("切替は既定 off（on の時だけ）", () => {
    eq(staffTodoFastLoadEnabled({}), false);
    eq(staffTodoFastLoadEnabled({ STAFF_TODO_FAST_LOAD: "on" }), true);
    eq(staffTodoFastLoadEnabled({ STAFF_TODO_FAST_LOAD: " ON " }), true);
    eq(staffTodoFastLoadEnabled({ STAFF_TODO_FAST_LOAD: "off" }), false);
  });
  await it("締め切りが無ければ今まで通りの予算", () => {
    eq(hubBudgetMs({ baseMs: 20_000, nowMs: 0 }), 20_000);
    eq(hubBudgetMs({ baseMs: 20_000, nowMs: 0, deadlineAtMs: null }), 20_000);
  });
  await it("締め切りまで十分あれば今まで通りの予算（上限はそのまま）", () => {
    const start = 1_000_000;
    eq(hubBudgetMs({ baseMs: 20_000, nowMs: start + 10_000, deadlineAtMs: todoDeadlineAtMs(start, 300) }), 20_000);
  });
  await it("残りが少なければ残り（送信の分を引いた）まで", () => {
    const start = 1_000_000;
    const now = start + 50_000; // 60秒の締め切りまで残り10秒 → 送信の15秒を引くと読めない
    eq(hubBudgetMs({ baseMs: 20_000, nowMs: now, deadlineAtMs: todoDeadlineAtMs(start, 60) }), 0);
    const now2 = start + 30_000; // 残り30秒 → 15秒
    eq(hubBudgetMs({ baseMs: 20_000, nowMs: now2, deadlineAtMs: todoDeadlineAtMs(start, 60) }), 30_000 - TODO_SEND_RESERVE_MS);
  });
  await it("残りが最小（2秒）より短い時は 0", () => {
    eq(hubBudgetMs({ baseMs: 20_000, nowMs: 0, deadlineAtMs: TODO_SEND_RESERVE_MS + 1_500 }), 0);
    eq(hubBudgetMs({ baseMs: 20_000, nowMs: 0, deadlineAtMs: TODO_SEND_RESERVE_MS + 2_000 }), 2_000);
  });
  await it("段ごとの時間は前の印からの差・同じ段は足す", () => {
    let t = 100;
    const tm = createStageTimer(() => t);
    t = 150; tm.mark("first");
    t = 400; tm.mark("chunks");
    t = 410; tm.mark("first");
    eq(tm.stages(), { first: 60, chunks: 250 });
    eq(tm.totalMs(), 310);
  });
  await it("締め切りで待つのをやめて代わりを返す・間に合えば中身", async () => {
    eq(await withinDeadline(new Promise<number>((r) => setTimeout(() => r(1), 200)), 20, -1), -1);
    eq(await withinDeadline(Promise.resolve(7), 1000, -1), 7);
    eq(await withinDeadline(Promise.resolve(7), 0, -1), -1);
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
