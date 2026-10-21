// 【やることリスト】×🌟ターゲット・並び・的確な指示・☑（2026-10-21 竹内さんの決定 268a904a・cb760598・1214dc48・c0a91198）
//   作り物のデータだけ（実在のお客様の文は使わない）・LLM なし
// 実行: npx tsx app/lib/__tests__/staff-todo-target.test.ts（全 PASS で exit 0）
import {
  buildStaffTodoList, renderStaffTodoList, numberTodoItems, newArrivalKey, todoTargetMergeEnabled, todoSonotaMergeEnabled, todoDailyBriefMergeEnabled,
  pickOtherDaily, TODO_MARK_VIA_NONE, TODO_LIST_MAX_CHARS, STAFF_TODO_COOLDOWN_MS, type TodoInput,
} from "../staff-todo-list";
import { todoInstruction, conditionShort } from "../staff-todo-instruction";
import { todoGroupOf, todoScore, compareTodoPriority, applyConductor } from "../staff-todo-priority";
import { parseTodoReply, resolveTodoReply, renderTodoReplyAck, type TodoSnapshot } from "../staff-todo-reply";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, m = "expected truthy") { if (!v) throw new Error(m); }

const AT = Date.parse("2026-10-21T11:30:00+09:00");
const iso = (s: string) => new Date(Date.parse(s)).toISOString();
const conv = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, customer_name: name, account: "sumora", status: "proposing", is_post_apply: false, created_at: iso("2026-09-01T10:00:00+09:00"), ...extra });
const base = (): TodoInput => ({ atMs: AT, conversations: [], aixItems: [], promises: [], facts: [], viewings: [], messages: [], everSent: [], deliveries: [], conditions: {} });
const pending = (id: string, c: string, action: string, created: string, cp: string | null = null) => ({
  id, conversation_id: c, customer_name: null, action, check_pattern: cp, status: "pending" as const, created_at: iso(created), done_at: null, done_aix_type: null,
});

console.log("staff-todo-target");

it("切替: ターゲット・その他・朝夕の便のまとめは既定 on・一覧を off にすると全部戻る・間隔は50分", () => {
  eq(todoTargetMergeEnabled({}), true);
  eq(todoTargetMergeEnabled({ TODO_TARGET_MERGE: "off" }), false);
  eq(todoTargetMergeEnabled({ STAFF_TODO_LIST: "off" }), false);
  eq(todoSonotaMergeEnabled({}), true);
  eq(todoSonotaMergeEnabled({ TODO_SONOTA_MERGE: "off" }), false);
  eq(todoDailyBriefMergeEnabled({ STAFF_TODO_LIST: "off" }), false);
  eq(todoDailyBriefMergeEnabled({ TODO_DAILY_BRIEF_MERGE: "off" }), false);
  ok(STAFF_TODO_COOLDOWN_MS >= 50 * 60_000 && STAFF_TODO_COOLDOWN_MS < 60 * 60_000);
});

it("条件の一言は欄にある物だけ（作らない）", () => {
  eq(conditionShort({ commute_station: "テスト駅", rent_max: 80000, floor_plan: "2LDK", other_requests: "ペット可、静かなところが良いです" }), "テスト駅・〜8万・2LDK・ペット可");
  eq(conditionShort({ desired_area: "テスト区、別区", rent_max: 65000 }), "テスト区・〜6.5万");
  eq(conditionShort({}), null);
  eq(conditionShort(null), null);
});

it("的確な指示: ボタン→ピッカー→何を入れる（分からなければ null）", () => {
  eq(todoInstruction({ action: "property_check_result", checkPattern: "mgmt_parking", source: "promise" }),
    "AIX【物件確認した】→管理会社に確認した→駐車場について：空き状況と月額を管理会社に確認して入力");
  eq(todoInstruction({ action: "property_send", checkPattern: null, source: "target_new_arrival", everSent: true, conditions: "テスト駅・〜8万・2LDK・ペット可" }),
    "AIX【物件ピックアップした】→新着まとめ：条件（テスト駅・〜8万・2LDK・ペット可）で新着を確認して送る、無ければ☑");
  eq(todoInstruction({ action: "property_send", checkPattern: null, source: "aix_item", everSent: false, conditions: null }),
    "AIX【物件ピックアップした】→初回まとめ：ご条件で探して送る");
  // 送ったことがある・種類が分からない・条件も無い＝決めない
  eq(todoInstruction({ action: "property_send", checkPattern: null, source: "aix_item", everSent: true }), null);
  eq(todoInstruction({ action: "property_send", checkPattern: null, source: "aix_item", everSent: null }), null);
  // 結果のピッカー（物件あった 等）は前もって決めない
  eq(todoInstruction({ action: "property_check_result", checkPattern: "available", source: "aix_item" }), null);
  eq(todoInstruction({ action: "estimate_sheet", checkPattern: null, source: "aix_item" }), null);
  eq(todoInstruction({ action: "viewing_invite", checkPattern: null, source: "aix_item" }), null);
});

it("組: ①ターゲット×やること ②新規 ③やること ④ターゲットの新着確認だけ ⑤その他", () => {
  const f = (open: boolean) => ({ hasOpenTask: open, hasOpenNewArrival: true, maxOverdueDays: 0, maxElapsedDays: 0, firstOriginMs: 0 });
  eq(todoGroupOf({ tier: "viewed" }, f(true)), 1);
  eq(todoGroupOf({ tier: "new" }, f(true)), 2);
  eq(todoGroupOf({ newInquiry: true }, f(true)), 2);
  eq(todoGroupOf({}, f(true)), 3);
  eq(todoGroupOf({ tier: "engaged" }, f(false)), 4);
  eq(todoGroupOf({ reapply: true }, f(false)), 4);
  eq(todoGroupOf({ otherDaily: true }, f(false)), 5);
});

it("点と「なぜ上か」（15字まで・いちばん効いた理由）", () => {
  const s = todoScore({ tier: "viewed", routeIndex: 8 }, { hasOpenTask: true, hasOpenNewArrival: false, maxOverdueDays: 2, maxElapsedDays: 3, firstOriginMs: 0 }, AT);
  ok(s.why.length <= 15, s.why);
  ok(s.why.startsWith("内覧済み"), s.why);
  const r = todoScore({ reapply: true }, { hasOpenTask: true, hasOpenNewArrival: false, maxOverdueDays: 0, maxElapsedDays: 0, firstOriginMs: 0 }, AT);
  ok(r.why.startsWith("申込歴あり"), r.why);
  const o = todoScore({}, { hasOpenTask: true, hasOpenNewArrival: false, maxOverdueDays: 5, maxElapsedDays: 0, firstOriginMs: 0 }, AT);
  eq(o.why, "期限5日過ぎ");
});

it("同点は決まった順・司令塔の入れ口は足し引きした答えを使わない", () => {
  const a = { group: 1 as const, score: 10, done: false, firstOriginMs: 5, conversationId: "b" };
  const b = { group: 1 as const, score: 10, done: false, firstOriginMs: 5, conversationId: "a" };
  eq([a, b].sort(compareTodoPriority).map((x) => x.conversationId), ["a", "b"]);
  const xs = [a, b];
  eq(applyConductor(xs, (o) => [...o].reverse()).map((x) => x.conversationId), ["a", "b"]);
  eq(applyConductor(xs, (o) => o.slice(0, 1)).map((x) => x.conversationId), ["b", "a"]);
});

it("ターゲットの毎日の新着確認: 物件を送れば✅・グループの☑で☑・物件を送る要対応がある時は作らない", () => {
  const i = base();
  i.conversations = [conv("t1", "テストA"), conv("t2", "テストB"), conv("t3", "テストC"), conv("t4", "テストD")];
  i.targets = [{ conversationId: "t1", tier: "viewed" }, { conversationId: "t2", tier: "engaged" }, { conversationId: "t3", tier: "engaged" }, { conversationId: "t4", tier: "engaged" }];
  i.everSent = ["t1", "t2", "t3", "t4"];
  i.deliveries = [{ conversation_id: "t2", at: iso("2026-10-21T10:00:00+09:00") }];
  i.marks = [{ item_key: newArrivalKey("t3", AT), conversation_id: "t3", marked_at: iso("2026-10-21T11:00:00+09:00"), via: TODO_MARK_VIA_NONE }];
  i.aixItems = [pending("a4", "t4", "property_send", "2026-10-21T09:00:00+09:00")];
  i.conditions = { t1: { commute_station: "テスト駅", rent_max: 80000, floor_plan: "2LDK" }, t4: { rent_max: 70000 } };
  const list = buildStaffTodoList(i);
  const text = renderStaffTodoList(list)!;
  ok(text.includes("━ ①ターゲット×やること ━"), text);
  ok(text.includes("━ ④ターゲットの新着確認 ━"), text);
  ok(text.includes("AIX【物件ピックアップした】→新着まとめ：条件（テスト駅・〜8万・2LDK）で新着を確認して送る、無ければ☑"), text);
  ok(text.includes("✅新着の物件確認：物件をお送りした"), text);
  ok(text.includes("☑新着の物件確認：確認済み・物件なし"), text);
  // t4 は物件を送る要対応が同じ仕事＝新着確認の行は作らない
  const t4 = list.customers.find((c) => c.conversationId === "t4")!;
  eq(t4.items.map((x) => x.source), ["aix_item"]);
  eq(t4.group, 1);
  eq(t4.items[0].instruction, "AIX【物件ピックアップした】：条件（〜7万）で探して送る");
  ok(text.includes("🌟テストAさん（スモラ）"), text);
  ok(text.includes("【審査中】（なし）"), text);
});

it("並び: ①ターゲット×やること → ②新規 → ③その他 → ④新着確認だけ", () => {
  const i = base();
  i.conversations = [
    conv("o1", "テスト他"),
    conv("n1", "テスト新", { created_at: iso("2026-10-20T10:00:00+09:00") }),
    conv("t1", "テスト標"),
    conv("t2", "テスト新着"),
  ];
  i.targets = [{ conversationId: "t1", tier: "viewed" }, { conversationId: "t2", tier: "engaged" }];
  i.everSent = ["o1", "t1", "t2"];
  i.aixItems = [
    pending("x1", "o1", "viewing_invite", "2026-10-18T09:00:00+09:00"),
    pending("x2", "n1", "condition_hearing", "2026-10-21T09:00:00+09:00"),
    pending("x3", "t1", "estimate_sheet", "2026-10-21T09:00:00+09:00"),
  ];
  const list = buildStaffTodoList(i);
  eq(list.customers.map((c) => [c.conversationId, c.group]), [["t1", 1], ["n1", 2], ["o1", 3], ["t2", 4]]);
  // 番号は表示の順
  eq(numberTodoItems(list).map((x) => x.customer.conversationId), ["t1", "t1", "n1", "o1", "t2"]);
});

it("長すぎる時は④の新着確認を1人1行に詰める（番号は同じ）", () => {
  const i = base();
  const n = 70;
  i.conversations = Array.from({ length: n }, (_, k) => conv(`t${k}`, `テスト長い名前のお客様${k}`));
  i.targets = i.conversations.map((c) => ({ conversationId: c.id, tier: "engaged" as const }));
  i.everSent = i.conversations.map((c) => c.id);
  i.conditions = Object.fromEntries(i.conversations.map((c) => [c.id, { commute_station: "テスト長い駅名", rent_max: 85000, floor_plan: "2LDK", other_requests: "ペット可、駐車場あり" }]));
  const list = buildStaffTodoList(i);
  const text = renderStaffTodoList(list)!;
  ok(text.length <= TODO_LIST_MAX_CHARS, String(text.length));
  ok(/①🌟テスト長い名前のお客様\d+さん（スモラ） 新着確認\n/.test(text), text.slice(0, 400));
  // 少ない時は詰めた行に条件と理由が残る
  const j = { ...i, targets: i.targets!.slice(0, 40) };
  const t40 = renderStaffTodoList(buildStaffTodoList(j), { compact: true })!;
  ok(t40.length <= TODO_LIST_MAX_CHARS, String(t40.length));
  ok(t40.includes("新着確認〔テスト長い駅名駅・〜8.5万・2LDK・ペット可・駐車場あり〕"), t40.slice(0, 400));
  // 番号は詰めても同じ（控えと同じ並び）
  eq(numberTodoItems(list).length, n);
});

it("その他（announce-sonota と同じ選び方）: ターゲット除外・7日以内に送った人は出さない・☑→・→✅・上限", () => {
  const now = AT;
  const convs = [
    { id: "s1", customer_name: "A", property_customer_id: "p1" },
    { id: "s2", customer_name: "B", property_customer_id: "p2" },
    { id: "s3", customer_name: "C", property_customer_id: "p3" },
    { id: "s4", customer_name: "D", property_customer_id: "p4" },
    { id: "tg", customer_name: "T", property_customer_id: "p5" },
  ];
  const pcs = [
    { id: "p1", last_property_sent_at: iso("2026-10-01T10:00:00+09:00"), property_viewed_at: null },
    { id: "p2", last_property_sent_at: null, property_viewed_at: null },
    { id: "p3", last_property_sent_at: iso("2026-10-20T10:00:00+09:00"), property_viewed_at: null },
    { id: "p4", last_property_sent_at: iso("2026-10-20T10:00:00+09:00"), property_viewed_at: iso("2026-10-20T12:00:00+09:00") },
    { id: "p5", last_property_sent_at: null, property_viewed_at: null },
  ];
  const r = pickOtherDaily(convs, pcs, new Set(["tg"]), now, 10);
  eq(r.rows.map((x) => x.conversationId), ["s4", "s2", "s1"]);
  ok(r.rows.every((x) => x.other && x.tier === null));
  eq(pickOtherDaily(convs, pcs, new Set(["tg"]), now, 2).rows.length, 2);
  const i = base();
  i.conversations = [conv("s2", "テスト他")];
  i.targets = [{ conversationId: "s2", tier: null, other: true }];
  const list = buildStaffTodoList(i);
  eq(list.customers[0].group, 5);
  const text = renderStaffTodoList(list)!;
  ok(text.includes("━ ⑤その他の新着確認 ━") && !text.includes("🌟") && !text.includes("【審査中】"), text);
  ok(text.includes("初回まとめ"), text);
});

const SNAP: TodoSnapshot = { messageId: "m1", sentAt: iso("2026-10-21T11:30:00+09:00"), items: [
  { n: 1, key: "aix:x1", conversationId: "c1", name: "テスト太郎", label: "AIX：x" },
  { n: 2, key: `newarrival:c1:2026-10-21`, conversationId: "c1", name: "テスト太郎", label: "新着の物件確認：x" },
  { n: 3, key: `newarrival:c2:2026-10-21`, conversationId: "c2", name: "テスト花子", label: "新着の物件確認：x" },
] };

it("グループの☑: 「☑3」「〇〇さん なし」は☑（名前は新着確認の行だけ）・✅とは別", () => {
  eq(parseTodoReply("☑3"), { numbers: [3], names: [], none: true });
  eq(parseTodoReply("☑️3"), { numbers: [3], names: [], none: true });
  eq(parseTodoReply("テスト太郎さん なし"), { numbers: [], names: ["テスト太郎"], none: true });
  eq(parseTodoReply("✅3"), { numbers: [3], names: [] });
  eq(parseTodoReply("テスト太郎さん 完了"), { numbers: [], names: ["テスト太郎"] });
  eq(parseTodoReply("今日はなし"), null); // 番号も名前も無い
  const r = resolveTodoReply(parseTodoReply("テスト太郎さん なし")!, SNAP);
  eq(r.hits.map((h) => h.key), ["newarrival:c1:2026-10-21"]);
  ok(renderTodoReplyAck(r, null)!.startsWith("☑2 テスト太郎さん"));
  const d = resolveTodoReply(parseTodoReply("テスト太郎さん 完了")!, SNAP);
  eq(d.hits.map((h) => h.n), [1, 2]);
});

it("グループの☑: 普段の会話の「なし」は読まない・☑の番号は新着確認の行だけ（AIX・約束を閉じない）", () => {
  for (const t of ["テスト太郎さん 連絡なし", "テスト太郎さんから返信なし", "テスト太郎さん 問題なしです", "問題なし", "特になし", "3件なし"]) eq(parseTodoReply(t), null);
  eq(parseTodoReply("3 なし"), { numbers: [3], names: [], none: true });
  eq(parseTodoReply("テスト太郎さん 物件なしです"), { numbers: [], names: ["テスト太郎"], none: true });
  eq(parseTodoReply("テスト太郎さん、新着ありませんでした🙏"), { numbers: [], names: ["テスト太郎"], none: true });
  const r = resolveTodoReply(parseTodoReply("☑1")!, SNAP);
  eq(r.hits, []);
  eq(r.unknownNumbers, [1]);
  ok(renderTodoReplyAck(r, null)!.includes("新着の物件確認"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
