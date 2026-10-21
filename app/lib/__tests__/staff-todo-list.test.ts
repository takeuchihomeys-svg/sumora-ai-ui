// 【やることリスト】の組み立て（app/lib/staff-todo-list.ts）— 作り物のデータだけ（実在のお客様の文は使わない）・LLM なし
// 実行: npx tsx app/lib/__tests__/staff-todo-list.test.ts（全 PASS で exit 0）
import {
  buildStaffTodoList, renderStaffTodoList, customerHeader, isCloserOnly, promiseTaskOf, promiseAixLabelOf, routeRank,
  staffTodoListEnabled, aixInstantNoticeEnabled, actionTask, TODO_MAX_AGE_DAYS, todoNumberMark, numberTodoItems, promiseMootReason, type TodoInput,
} from "../staff-todo-list";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, m = "expected truthy") { if (!v) throw new Error(m); }
/** 見出しの「▶なぜ上か」を外す（並びの理由は staff-todo-priority のテストで見る） */
const noWhy = (s: string) => s.replace(/ ▶[^\n]*/g, "");

// 2026-10-20 10:30 JST
const AT = Date.parse("2026-10-20T10:30:00+09:00");
const iso = (s: string) => new Date(Date.parse(s)).toISOString();
const base = (): TodoInput => ({ atMs: AT, conversations: [], aixItems: [], promises: [], facts: [], viewings: [], messages: [] });
const conv = (id: string, name: string, account: string, status = "proposing") => ({ id, customer_name: name, account, status, is_post_apply: false });
const NOTES_PICKUP = "【必ず】物件ピックアップ送付【今日中】\n約束: 「（作り物）」\nAIX: 【物件ピックアップした（または 物件オススメ）】を送ったら完了\n（10/18 12:00 の送信から）";
const NOTES_CONFIRM = "【必ず】駐車場の確認→ご連絡\n約束: 「（作り物）」\nAIX: 【確認した（条件・交渉）→駐車場】を送ったら完了\n（10/20 09:00 の送信から）";
const NOTES_WAIT = "【必ず】新着が出たら物件送付【新着待ち】\n約束: 「（作り物）」\nAIX: 【物件ピックアップした（または 物件オススメ）】を送ったら完了";

console.log("staff-todo-list");

it("切替は既定 on（off の時だけ止まる）", () => {
  eq(staffTodoListEnabled({}), true);
  eq(staffTodoListEnabled({ STAFF_TODO_LIST: "off" }), false);
  eq(staffTodoListEnabled({ STAFF_TODO_LIST: "on" }), true);
  eq(staffTodoListEnabled({ STAFF_TODO_LIST: " OFF " }), false);
  // 1件ずつの AIX要対応の通知は一覧が on の間は止まる（STAFF_TODO_INSTANT_NOTICE=on で併用・一覧を off にすれば元どおり）
  eq(aixInstantNoticeEnabled({}), false);
  eq(aixInstantNoticeEnabled({ STAFF_TODO_INSTANT_NOTICE: "on" }), true);
  eq(aixInstantNoticeEnabled({ STAFF_TODO_LIST: "off" }), true);
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
  ok(text.includes("①AIX【見積書送る】：御見積書を作ってお送りする（期限 10/18 過ぎ）（2日）"), text);
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
  ok(noWhy(text).includes("テストCさん（ギガ賃貸）\n①AIX【物件ピックアップした】：物件ピックアップ送付（お約束）（期限 10/18 過ぎ）（2日）"), text);
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
  ok(noWhy(text).includes("テストAさん（スモラ）\n②返信：10/20 09:00 のご連絡に返信する（期限 今日中）\n"), text);
  ok(!text.includes("（0日）"), text);
  ok(!text.includes("テストBさん") && !text.includes("テストCさん"), text);
  ok(noWhy(text).includes("テストDさん（スモラ）\n①AIX【内覧日調整】"), text);
  ok(!/テストDさん[^\n]*\n[^\n]*\n.返信/.test(text), text);
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
  ok(text.includes("①内覧：13:00 テスト荘 101のご案内（終わったら内覧の記録）（期限 13:00まで）\n"), text);
  ok(!text.includes("別の日"));
  const done = buildStaffTodoList({ ...i, atMs: Date.parse("2026-10-20T15:00:00+09:00"), viewings: [{ ...i.viewings[0], viewing_report_at: iso("2026-10-20T14:00:00+09:00") }] });
  eq(done.doneCount, 1);
});

// ── 2026-10-21 本番に出す前の正確さ（済んだのに毎日「まだ」で繰り越す行を減らす）──
it("AIX 要対応: AIX を押さずに送った（送信の記録）でも✅・今日より前に送っていれば出ない", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "sumora"), conv("c2", "テストB", "sumora")];
  i.aixItems = [
    { id: "a1", conversation_id: "c1", customer_name: "テストA", action: "property_send", check_pattern: null, status: "pending", created_at: iso("2026-10-20T09:00:00+09:00"), done_at: null, done_aix_type: null },
    { id: "a2", conversation_id: "c2", customer_name: "テストB", action: "estimate_sheet", check_pattern: null, status: "pending", created_at: iso("2026-10-18T09:00:00+09:00"), done_at: null, done_aix_type: null },
  ];
  i.facts = [
    { conversation_id: "c1", kind: "properties_sent", sent_at: iso("2026-10-20T09:04:00+09:00") },
    { conversation_id: "c2", kind: "estimate_sent", sent_at: iso("2026-10-19T12:00:00+09:00") },
  ];
  const l = buildStaffTodoList(i);
  eq(l.openCount, 0); eq(l.doneCount, 1);
  eq(l.skipped.aix_done_by_send_before, 1);
  ok(renderStaffTodoList(l)!.includes("✅AIX【物件ピックアップした】"), renderStaffTodoList(l)!);
});

it("約束: カレンダーが開いたままでも履行の送信があれば✅（閉じ忘れを繰り越さない）", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "sumora")];
  i.promises = [{ id: 1, conversation_id: "c1", customer_name: "テストA", event_type: "property_send", start_at: iso("2026-10-19T12:00:00+09:00"), created_at: iso("2026-10-19T12:00:00+09:00"), notes: NOTES_PICKUP, is_done: false }];
  i.facts = [{ conversation_id: "c1", kind: "properties_sent", sent_at: iso("2026-10-20T09:00:00+09:00") }];
  eq(buildStaffTodoList(i).doneCount, 1);
  i.facts = [{ conversation_id: "c1", kind: "properties_sent", sent_at: iso("2026-10-19T18:00:00+09:00") }];
  eq(buildStaffTodoList(i).customers.length, 0);
});

it("もう要らない約束は外す: 申込のご案内の後／ご条件待ちのピックアップ／お部屋が無くなった初期費用の確認", () => {
  const P = (id: number, cid: string, type: string, notes: string) => ({ id, conversation_id: cid, customer_name: null, event_type: type, start_at: iso("2026-10-19T12:00:00+09:00"), created_at: iso("2026-10-19T12:00:00+09:00"), notes, is_done: false });
  const NOTES_COST = "【必ず】初期費用の確認→ご連絡\n約束: 「（作り物）」\nAIX: 【確認した（条件・交渉）→初期費用】を送ったら完了";
  const facts = [
    { conversation_id: "c1", kind: "application_guided", sent_at: iso("2026-10-19T15:00:00+09:00") },
    { conversation_id: "c2", kind: "condition_asked", sent_at: iso("2026-10-19T12:01:00+09:00") },
    { conversation_id: "c3", kind: "confirmation_reported", sent_at: iso("2026-10-19T15:00:00+09:00"), detail: { checkPattern: "unavailable" } },
  ];
  eq(promiseMootReason(P(1, "c1", "property_send", NOTES_PICKUP), { facts, customerTurns: [] }, AT), "apply");
  eq(promiseMootReason(P(2, "c2", "property_send", NOTES_PICKUP), { facts, customerTurns: [] }, AT), "cond");
  // ご条件をいただいたら（お客様が返したら）待ちではない
  eq(promiseMootReason(P(2, "c2", "property_send", NOTES_PICKUP), { facts, customerTurns: [{ conversation_id: "c2", created_at: iso("2026-10-19T20:00:00+09:00") }] }, AT), null);
  eq(promiseMootReason(P(3, "c3", "follow_up", NOTES_COST), { facts, customerTurns: [] }, AT), "gone");
  // 駐車場の確認は、お部屋の募集終了の報告では外さない（別の要件）
  eq(promiseMootReason(P(4, "c3", "follow_up", NOTES_CONFIRM), { facts, customerTurns: [] }, AT), null);
});

it("内覧: 内覧の時刻の後にスタッフが内覧の話を送ったら✅（記録が無くても）", () => {
  const i = base();
  i.atMs = Date.parse("2026-10-20T16:00:00+09:00");
  i.conversations = [conv("c1", "テストA", "giga", "viewing")];
  i.viewings = [{ id: 1, conversation_id: "c1", scheduled_date: "2026-10-20", scheduled_time: "13:00", status: "scheduled", property_name: "テスト荘 101" }];
  i.messages = [{ conversation_id: "c1", sender: "staff", text: "本日はご内覧ありがとうございました（作り物）", created_at: iso("2026-10-20T14:10:00+09:00") }];
  eq(buildStaffTodoList(i).doneCount, 1);
  i.messages = [{ conversation_id: "c1", sender: "staff", text: "本日はご内覧よろしくお願いします（作り物）", created_at: iso("2026-10-20T11:00:00+09:00") }];
  eq(buildStaffTodoList(i).openCount, 1);
});

it("グループの✅（staff_todo_marks）で済み・番号は残りの行だけに上から", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "sumora"), conv("c2", "テストB", "sumora")];
  i.viewings = [{ id: 7, conversation_id: "c1", scheduled_date: "2026-10-20", scheduled_time: "18:00", status: "scheduled", property_name: "テスト荘" }];
  i.aixItems = [{ id: "a2", conversation_id: "c2", customer_name: "テストB", action: "viewing_invite", check_pattern: null, status: "pending", created_at: iso("2026-10-19T09:00:00+09:00"), done_at: null, done_aix_type: null }];
  const before = buildStaffTodoList(i);
  eq(numberTodoItems(before).map((x) => [x.n, x.item.key]), [[1, "aix:a2"], [2, "viewing:7"]]);
  const after = buildStaffTodoList({ ...i, marks: [{ item_key: "viewing:7", conversation_id: "c1", marked_at: iso("2026-10-20T10:00:00+09:00") }] });
  eq(after.openCount, 1); eq(after.doneCount, 1);
  ok(renderStaffTodoList(after)!.includes("✅内覧"), renderStaffTodoList(after)!);
});

it("営業時間外（最後の一覧 20:30 より後）の連絡・要対応は翌営業日の今日（期限 今日中・経過は数えない）", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "sumora"), conv("c2", "テストB", "sumora"), conv("c3", "テストC", "sumora")];
  i.messages = [
    { conversation_id: "c1", sender: "customer", text: "夜分にすみません、内覧できますか？", created_at: iso("2026-10-19T22:00:00+09:00") },
    { conversation_id: "c2", sender: "customer", text: "初期費用を教えてください", created_at: iso("2026-10-20T07:30:00+09:00") },
  ];
  i.aixItems = [
    { id: "a3", conversation_id: "c3", customer_name: "テストC", action: "estimate_sheet", check_pattern: null, status: "pending", created_at: iso("2026-10-19T20:45:00+09:00"), done_at: null, done_aix_type: null },
  ];
  const text = renderStaffTodoList(buildStaffTodoList(i))!;
  ok(text.includes("返信：10/19 22:00 のご連絡に返信する（期限 今日中）\n"), text);
  ok(text.includes("返信：10/20 07:30 のご連絡に返信する（期限 今日中）\n"), text);
  ok(text.includes("AIX【見積書送る】：御見積書を作ってお送りする（期限 今日中）\n"), text);
  ok(!text.includes("過ぎ") && !text.includes("（1日）"), text);
  // 営業時間内（20:30 より前）に立った物は翌朝には期限を過ぎて（1日）
  i.aixItems = [{ ...i.aixItems[0], created_at: iso("2026-10-19T20:00:00+09:00") }];
  ok(renderStaffTodoList(buildStaffTodoList(i))!.includes("（期限 10/19 過ぎ）（1日）"), renderStaffTodoList(buildStaffTodoList(i))!);
});

it("番号は表示の順（優先度の高いお客様から・お客様の中も優先度順）に 1 から通し", () => {
  const i = base();
  i.conversations = [conv("c1", "テストA", "sumora"), conv("c2", "テストB", "sumora")];
  const a = (id: string, c: string, action: string, created: string) => ({ id, conversation_id: c, customer_name: null, action, check_pattern: null, status: "pending" as const, created_at: iso(created), done_at: null, done_aix_type: null });
  i.aixItems = [a("x1", "c1", "property_send", "2026-10-20T09:00:00+09:00"), a("x2", "c2", "estimate_sheet", "2026-10-17T09:00:00+09:00")];
  i.promises = [{ id: 9, conversation_id: "c2", customer_name: null, event_type: "follow_up", start_at: iso("2026-10-19T12:00:00+09:00"), created_at: iso("2026-10-19T12:00:00+09:00"), notes: NOTES_CONFIRM, is_done: false }];
  const l = buildStaffTodoList(i);
  const shown = l.customers.flatMap((c) => c.items.filter((x) => !x.doneAt).map((x) => x.key));
  eq(numberTodoItems(l).map((x) => x.item.key), shown);
  eq(shown, ["aix:x2", "promise:9", "aix:x1"]);
  const text = renderStaffTodoList(l)!;
  ok(text.indexOf("①") < text.indexOf("②") && text.indexOf("②") < text.indexOf("③"), text);
});

it("番号の印: ①〜⑳・㉑〜㊿・51 から (51)", () => {
  eq(todoNumberMark(1), "①"); eq(todoNumberMark(20), "⑳"); eq(todoNumberMark(21), "㉑"); eq(todoNumberMark(35), "㉟");
  eq(todoNumberMark(36), "㊱"); eq(todoNumberMark(50), "㊿"); eq(todoNumberMark(51), "(51)");
});

it("やる事が無ければ送らない（null）", () => {
  eq(renderStaffTodoList(buildStaffTodoList(base())), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
