// 【やることリスト】の組み立て（app/lib/staff-todo-list.ts）— 作り物のデータだけ（実在のお客様の文は使わない）・LLM なし
// 実行: npx tsx app/lib/__tests__/staff-todo-list.test.ts（全 PASS で exit 0）
import {
  buildStaffTodoList, renderStaffTodoList, customerHeader, isCloserOnly, promiseTaskOf, promiseAixLabelOf, routeRank,
  staffTodoListEnabled, actionTask, TODO_MAX_AGE_DAYS, type TodoInput,
} from "../staff-todo-list";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, m = "expected truthy") { if (!v) throw new Error(m); }

// 2026-10-20 10:30 JST
const AT = Date.parse("2026-10-20T10:30:00+09:00");
const iso = (s: string) => new Date(Date.parse(s)).toISOString();
const base = (): TodoInput => ({ atMs: AT, conversations: [], aixItems: [], promises: [], facts: [], viewings: [], messages: [] });
const conv = (id: string, name: string, account: string, status = "proposing") => ({ id, customer_name: name, account, status, is_post_apply: false });
const NOTES_PICKUP = "【必ず】物件ピックアップ送付【今日中】\n約束: 「（作り物）」\nAIX: 【物件ピックアップした（または 物件オススメ）】を送ったら完了\n（10/18 12:00 の送信から）";
const NOTES_CONFIRM = "【必ず】駐車場の確認→ご連絡\n約束: 「（作り物）」\nAIX: 【確認した（条件・交渉）→駐車場】を送ったら完了\n（10/20 09:00 の送信から）";
const NOTES_WAIT = "【必ず】新着が出たら物件送付【新着待ち】\n約束: 「（作り物）」\nAIX: 【物件ピックアップした（または 物件オススメ）】を送ったら完了";

console.log("staff-todo-list");

it("切替は既定 off（on の時だけ）", () => {
  eq(staffTodoListEnabled({}), false);
  eq(staffTodoListEnabled({ STAFF_TODO_LIST: "off" }), false);
  eq(staffTodoListEnabled({ STAFF_TODO_LIST: "on" }), true);
});

it("お客様の段: 名前さん＋アカウント名（英語キー・日本語名どちらも）", () => {
  eq(customerHeader("テスト太郎", "sumora"), "テスト太郎さん（スモラ）");
  eq(customerHeader("テスト花子", "イエヤス"), "テスト花子さん（イエヤス）");
  eq(customerHeader(null, "giga"), "お客様さん（ギガ賃貸）");
});

it("約束の見出しから印を外す・AIX の言葉を取り出す", () => {
  eq(promiseTaskOf(NOTES_PICKUP), "物件ピックアップ送付");
  eq(promiseAixLabelOf(NOTES_PICKUP), "AIX【物件ピックアップした】");
  eq(promiseAixLabelOf(NOTES_CONFIRM), "AIX【確認した（条件・交渉）→駐車場】");
});

it("お礼・了承だけの発言は返信のやる事にしない", () => {
  eq(isCloserOnly("ありがとうございます😊"), true);
  eq(isCloserOnly("了解しました！よろしくお願いします"), true);
  eq(isCloserOnly("駐車場はありますか？"), false);
});

it("確認の AIX は確認の中身を書く", () => {
  eq(actionTask("property_check_result", "mgmt_parking"), "管理会社に駐車場を確認して結果をお伝えする");
});

it("申込に近い AIX ほど地図の順位が高い", () => {
  ok(routeRank("application_push", null) > routeRank("estimate_sheet", null));
  ok(routeRank("estimate_sheet", null) > routeRank("property_send", null));
  ok(routeRank(null, "viewing") > routeRank(null, "hearing"));
});

it("AIX 要対応: 未完了は（●日）、今日済んだ物は✅、昨日より前に済んだ物は出ない", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "sumora")];
  i.aixItems = [
    { id: "a1", conversation_id: "c1", customer_name: "テストA", action: "estimate_sheet", check_pattern: null, status: "pending", created_at: iso("2026-10-18T15:00:00+09:00"), done_at: null, done_aix_type: null },
    { id: "a2", conversation_id: "c1", customer_name: "テストA", action: "viewing_invite", check_pattern: null, status: "done", created_at: iso("2026-10-20T09:00:00+09:00"), done_at: iso("2026-10-20T09:30:00+09:00"), done_aix_type: "viewing_invite", done_by: "aix" },
    { id: "a3", conversation_id: "c1", customer_name: "テストA", action: "meeting_place", check_pattern: null, status: "done", created_at: iso("2026-10-18T09:00:00+09:00"), done_at: iso("2026-10-19T09:30:00+09:00"), done_aix_type: "meeting_place", done_by: "aix" },
  ];
  const text = renderStaffTodoList(buildStaffTodoList(i))!;
  ok(text.startsWith("【やることリスト】10/20 10:30"), text);
  ok(text.includes("テストAさん（スモラ）"));
  ok(text.includes("・AIX【見積書送る】：御見積書を作ってお送りする（期限 10/18 過ぎ）（2日）"), text);
  ok(text.includes("✅AIX【内覧日調整】"), text);
  ok(!text.includes("待ち合わせ"), text);
});

it("その時点で開いていた物を組み立て直す（後で済んだ物は未完了として出る）", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "sumora")];
  i.aixItems = [{ id: "a1", conversation_id: "c1", customer_name: "テストA", action: "estimate_sheet", check_pattern: null, status: "done", created_at: iso("2026-10-20T09:00:00+09:00"), done_at: iso("2026-10-20T12:00:00+09:00"), done_aix_type: "estimate_sheet" }];
  const l = buildStaffTodoList(i);
  eq(l.openCount, 1);
  eq(buildStaffTodoList({ ...i, atMs: Date.parse("2026-10-20T13:00:00+09:00") }).doneCount, 1);
});

it("約束: 待ち・先の日付・申込より後・古すぎる物は出ない／履行の送信で✅", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "ieyasu"), conv("c2", "テストB", "sumora", "applying"), conv("c3", "テストC", "giga")];
  i.promises = [
    { id: 1, conversation_id: "c1", customer_name: "テストA", event_type: "follow_up", start_at: iso("2026-10-20T09:00:00+09:00"), created_at: iso("2026-10-20T09:00:00+09:00"), notes: NOTES_CONFIRM, is_done: true },
    { id: 2, conversation_id: "c1", customer_name: "テストA", event_type: "property_send", start_at: iso("2026-10-18T12:00:00+09:00"), created_at: iso("2026-10-18T12:00:00+09:00"), notes: NOTES_WAIT, is_done: false },
    { id: 3, conversation_id: "c1", customer_name: "テストA", event_type: "property_send", start_at: iso("2026-10-22T10:00:00+09:00"), created_at: iso("2026-10-19T12:00:00+09:00"), notes: NOTES_PICKUP, is_done: false },
    { id: 4, conversation_id: "c2", customer_name: "テストB", event_type: "property_send", start_at: iso("2026-10-18T12:00:00+09:00"), created_at: iso("2026-10-18T12:00:00+09:00"), notes: NOTES_PICKUP, is_done: false },
    { id: 5, conversation_id: "c3", customer_name: "テストC", event_type: "property_send", start_at: iso("2026-09-01T12:00:00+09:00"), created_at: iso("2026-09-01T12:00:00+09:00"), notes: NOTES_PICKUP, is_done: false },
    { id: 6, conversation_id: "c3", customer_name: "テストC", event_type: "property_send", start_at: iso("2026-10-18T12:00:00+09:00"), created_at: iso("2026-10-18T12:00:00+09:00"), notes: NOTES_PICKUP, is_done: false },
  ];
  i.facts = [{ conversation_id: "c1", kind: "confirmation_reported", sent_at: iso("2026-10-20T10:00:00+09:00"), detail: { object: "駐車場", checkPattern: "mgmt_parking" } }];
  const l = buildStaffTodoList(i);
  const text = renderStaffTodoList(l)!;
  ok(text.includes("✅AIX【確認した（条件・交渉）→駐車場】：駐車場の確認→ご連絡（お約束）"), text);
  ok(text.includes("テストCさん（ギガ賃貸）\n・AIX【物件ピックアップした】：物件ピックアップ送付（お約束）（期限 10/18 過ぎ）（2日）"), text);
  ok(!text.includes("テストB"), text);
  eq(l.skipped.promise_wait, 1); eq(l.skipped.promise_future, 1); eq(l.skipped.promise_post_apply, 1); eq(l.skipped.promise_stale, 1);
  ok(TODO_MAX_AGE_DAYS === 14);
});

it("約束と同じ AIX の要対応は1行にまとめる（約束の言葉・古い方の経過）", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "sumora")];
  i.promises = [{ id: 1, conversation_id: "c1", customer_name: "テストA", event_type: "property_send", start_at: iso("2026-10-18T12:00:00+09:00"), created_at: iso("2026-10-18T12:00:00+09:00"), notes: NOTES_PICKUP, is_done: false }];
  i.aixItems = [{ id: "a1", conversation_id: "c1", customer_name: "テストA", action: "property_send", check_pattern: null, status: "pending", created_at: iso("2026-10-20T09:00:00+09:00"), done_at: null, done_aix_type: null }];
  const l = buildStaffTodoList(i);
  eq(l.openCount, 1);
  ok(renderStaffTodoList(l)!.includes("物件ピックアップ送付（お約束）（期限 10/18 過ぎ）（2日）"));
});

it("未返信: 30分以上・48時間以内・お礼だけでない・要対応が無い会話だけ", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "sumora"), conv("c2", "テストB", "sumora"), conv("c3", "テストC", "sumora"), conv("c4", "テストD", "sumora")];
  i.messages = [
    { conversation_id: "c1", sender: "staff", text: "（作り物）", created_at: iso("2026-10-20T08:00:00+09:00") },
    { conversation_id: "c1", sender: "customer", text: "内覧はできますか？", created_at: iso("2026-10-20T09:00:00+09:00") },
    { conversation_id: "c2", sender: "customer", text: "ありがとうございます！", created_at: iso("2026-10-20T09:00:00+09:00") },
    { conversation_id: "c3", sender: "customer", text: "質問です", created_at: iso("2026-10-20T10:20:00+09:00") },
    { conversation_id: "c4", sender: "customer", text: "質問です", created_at: iso("2026-10-20T09:00:00+09:00") },
  ];
  i.aixItems = [{ id: "a4", conversation_id: "c4", customer_name: "テストD", action: "viewing_invite", check_pattern: null, status: "pending", created_at: iso("2026-10-20T09:01:00+09:00"), done_at: null, done_aix_type: null }];
  const text = renderStaffTodoList(buildStaffTodoList(i))!;
  ok(text.includes("テストAさん（スモラ）\n・返信：10/20 09:00 のご連絡に返信する（期限 今日中）（0日）"), text);
  ok(!text.includes("テストBさん") && !text.includes("テストCさん"), text);
  ok(text.includes("テストDさん（スモラ）\n・AIX【内覧日調整】"), text);
  ok(!/テストDさん[^\n]*\n[^\n]*\n・返信/.test(text), text);
});

it("並び: 期限を過ぎた日数 → 経過 → 申込に近い。済んだだけの人は下", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "sumora"), conv("c2", "テストB", "sumora"), conv("c3", "テストC", "sumora"), conv("c4", "テストD", "sumora")];
  const item = (id: string, c: string, action: string, created: string, status: "pending" | "done" = "pending") => ({
    id, conversation_id: c, customer_name: null, action, check_pattern: null, status, created_at: iso(created),
    done_at: status === "done" ? iso("2026-10-20T10:00:00+09:00") : null, done_aix_type: status === "done" ? action : null,
  });
  i.aixItems = [
    item("x1", "c1", "property_send", "2026-10-20T09:00:00+09:00"),
    item("x2", "c2", "application_push", "2026-10-20T09:00:00+09:00"),
    item("x3", "c3", "property_send", "2026-10-17T09:00:00+09:00"),
    item("x4", "c4", "estimate_sheet", "2026-10-20T08:00:00+09:00", "done"),
  ];
  const order = buildStaffTodoList(i).customers.map((c) => c.conversationId);
  eq(order, ["c3", "c2", "c1", "c4"]);
});

it("今日の内覧: 時刻が期限・内覧の記録で✅", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "giga", "viewing")];
  i.viewings = [
    { id: 1, conversation_id: "c1", scheduled_date: "2026-10-20", scheduled_time: "13:00", status: "scheduled", property_name: "テスト荘 101" },
    { id: 2, conversation_id: "c1", scheduled_date: "2026-10-21", scheduled_time: "13:00", status: "scheduled", property_name: "別の日" },
  ];
  const text = renderStaffTodoList(buildStaffTodoList(i))!;
  ok(text.includes("・内覧：13:00 テスト荘 101のご案内（終わったら内覧の記録）（期限 13:00まで）（0日）"), text);
  ok(!text.includes("別の日"));
  const done = buildStaffTodoList({ ...i, atMs: Date.parse("2026-10-20T15:00:00+09:00"), viewings: [{ ...i.viewings[0], viewing_report_at: iso("2026-10-20T14:00:00+09:00") }] });
  eq(done.doneCount, 1);
});

it("やる事が無ければ送らない（null）", () => {
  eq(renderStaffTodoList(buildStaffTodoList(base())), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
