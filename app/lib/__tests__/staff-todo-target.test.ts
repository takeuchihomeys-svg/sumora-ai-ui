// 【やることリスト】×🌟ターゲット・並び・的確な指示・☑（2026-10-21 竹内さんの決定 268a904a・cb760598・1214dc48・c0a91198）
//   作り物のデータだけ（実在のお客様の文は使わない）・LLM なし
// 実行: npx tsx app/lib/__tests__/staff-todo-target.test.ts（全 PASS で exit 0）
import {
  buildStaffTodoList, renderStaffTodoList, numberTodoItems, newArrivalKey, todoTargetMergeEnabled, todoSonotaMergeEnabled, todoDailyBriefMergeEnabled,
  pickOtherDaily, TODO_MARK_VIA_NONE, TODO_LIST_MAX_CHARS, STAFF_TODO_COOLDOWN_MS, type TodoInput,
  composeStaffTodoPost, rotationOrder, carriedLine, todoNumberMark, MORNING_CALL_LINE, type TodoPost,
} from "../staff-todo-list";
import { todoInstruction, conditionShort } from "../staff-todo-instruction";
import { todoGroupOf, todoScore, compareTodoPriority, applyConductor } from "../staff-todo-priority";
import { parseTodoReply, resolveTodoReply, renderTodoReplyAck, pickTodoSnapshot, type TodoSnapshot } from "../staff-todo-reply";

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
  ok(text.includes("━ 1. ターゲット×やること ━"), text);
  ok(text.includes("━ 4. ターゲットの新着確認 ━"), text);
  // 見出しは丸数字を使わない（行の番号の③と取り違えない・2026-10-21）。丸数字は番号の行だけ
  const CIRC = /[①-⑳㉑-㉟㊱-㊿]/;
  const heads = text.split("\n").filter((l) => l.startsWith("━"));
  ok(heads.length >= 2 && heads.every((l) => !CIRC.test(l)), heads.join(" / "));
  // 番号の行は丸数字のまま
  ok(text.split("\n").some((l) => l.startsWith("①")), text);
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

// 長い名前・条件の④のお客様 n 人（作り物）
function manyDaily(n: number, atMs = AT): TodoInput {
  const i = { ...base(), atMs };
  i.conversations = Array.from({ length: n }, (_, k) => conv(`t${k}`, `テスト長い名前のお客様${k}`));
  i.targets = i.conversations.map((c) => ({ conversationId: c.id, tier: "engaged" as const }));
  i.everSent = i.conversations.map((c) => c.id);
  i.conditions = Object.fromEntries(i.conversations.map((c) => [c.id, { commute_station: "テスト長い駅名", rent_max: 85000, floor_plan: "2LDK", other_requests: "ペット可、駐車場あり" }]));
  return i;
}
const COND = "新着確認〔テスト長い駅名駅・〜8.5万・2LDK・ペット可・駐車場あり〕";
const snapOfPost = (p: TodoPost, sentAt: string): TodoSnapshot => ({
  messageId: null, sentAt: iso(sentAt),
  items: numberTodoItems(p.list).map(({ n, item, customer }) => ({ n, key: item.key, conversationId: item.conversationId, name: customer.name, label: item.kindLabel })),
});
const shownIds = (p: TodoPost) => p.list.customers.filter((c) => c.group === 4).map((c) => c.conversationId);

it("長すぎる時: 少なければ④を1人1行（条件つき）で全員", () => {
  const t40 = renderStaffTodoList(buildStaffTodoList(manyDaily(40)), { compact: true })!;
  ok(t40.length <= TODO_LIST_MAX_CHARS, String(t40.length));
  ok(t40.includes(COND), t40.slice(0, 400));
  ok(!t40.includes("次の便で"), t40.slice(-300));
});

it("それでも長い時: 条件を外さず入るだけ出し、残りは「（4. ターゲットの新着確認）の残り N人は次の便で」・番号は出した行だけ", () => {
  const n = 70;
  const list = buildStaffTodoList(manyDaily(n));
  const post = composeStaffTodoPost(list);
  const text = post.text!;
  ok(text.length <= TODO_LIST_MAX_CHARS, String(text.length));
  const shown = shownIds(post).length;
  ok(shown > 0 && shown < n, String(shown));
  eq(post.carried[4], n - shown);
  ok(text.includes(carriedLine(4, n - shown)), text.slice(-400));
  // 出した行は全部条件つき（名前だけの行は無い）
  const rows = text.split("\n").filter((l) => l.includes(" 新着確認"));
  eq(rows.length, shown);
  ok(rows.every((l) => l.includes(COND)), rows.find((l) => !l.includes(COND)) ?? "");
  // 番号は出した行だけで 1..shown（文と控えが同じ）
  const nums = numberTodoItems(post.list);
  eq(nums.length, shown);
  ok(text.includes(`${todoNumberMark(shown)}🌟`) && !text.includes(`${todoNumberMark(shown + 1)}🌟`), text.slice(0, 300));
  // 最初の便は点の順の上から（t0 から）
  eq(shownIds(post)[0], "t0");
  // renderStaffTodoList も同じ文
  eq(renderStaffTodoList(list), text);
});

it("回す: 前の便で出ていない人が次の便で先・2便で全員・✅/☑済みは外れる・☑の番号は新しい便の番号", () => {
  const n = 80;
  const at1 = Date.parse("2026-10-21T10:30:00+09:00");
  const at2 = Date.parse("2026-10-21T11:30:00+09:00");
  const mk = (at: number) => manyDaily(n, at);
  const p1 = composeStaffTodoPost(buildStaffTodoList(mk(at1)));
  const s1 = shownIds(p1);
  ok(s1.length < n && s1.length > 0, String(s1.length));
  const snap1 = snapOfPost(p1, "2026-10-21T10:30:00+09:00");
  // 11:30: 10:30 に出た人の1人を☑（物件なし）にした
  const i2 = mk(at2);
  i2.marks = [{ item_key: newArrivalKey(s1[0], at2), conversation_id: s1[0], marked_at: iso("2026-10-21T10:40:00+09:00"), via: TODO_MARK_VIA_NONE }];
  const p2 = composeStaffTodoPost(buildStaffTodoList(i2), { snapshots: [snap1] });
  const s2 = shownIds(p2);
  // 10:30 に出ていない人が全員先に出る（入る数が足りれば）
  const notShown1 = Array.from({ length: n }, (_, k) => `t${k}`).filter((id) => !s1.includes(id));
  ok(s1.length * 2 >= n, `1便 ${s1.length}人では2便で回らない（作り物を直す）`);
  ok(notShown1.every((id) => s2.includes(id)), JSON.stringify({ s1, s2 }));
  // 2便で全員（☑の1人を含め）
  eq(new Set([...s1, ...s2]).size, n);
  // ☑済みの人は回した時は出さない
  ok(!s2.includes(s1[0]), s2.join(","));
  ok(!p2.text!.split("\n").some((l) => /^☑🌟/.test(l)), p2.text!.split("\n").filter((l) => l.includes("物件なし")).join("|"));
  // 出す並びは点の順のまま（回す順ではない）
  const prio = buildStaffTodoList(i2).customers.map((c) => c.conversationId).filter((id) => s2.includes(id));
  eq(s2, prio);
  // 番号: 11:30 の便の「☑1」は 11:30 の控えの1行目＝11:30 に出た1人目（10:30 の1人目ではない）
  const snap2 = snapOfPost(p2, "2026-10-21T11:30:00+09:00");
  const r = resolveTodoReply(parseTodoReply("☑1")!, snap2);
  eq(r.hits.map((h) => h.conversationId), [s2[0]]);
  // 12:30: 10:30・11:30 の両方に出た人は後回し（最後に出たのが古い順）
  const at3 = Date.parse("2026-10-21T12:30:00+09:00");
  const order3 = rotationOrder(buildStaffTodoList(mk(at3)).customers.filter((c) => c.group === 4), [snap1, snap2], at3).map((c) => c.conversationId);
  const only1030 = s1.filter((id) => !s2.includes(id));
  ok(only1030.length > 0);
  eq([...order3.slice(0, only1030.length)].sort(), [...only1030].sort());
});

it("回す: 別の日・この便より後の控えは数えない", () => {
  const list = buildStaffTodoList(manyDaily(3));
  const pool = list.customers.filter((c) => c.group === 4);
  const old: TodoSnapshot = { messageId: null, sentAt: iso("2026-10-20T19:30:00+09:00"), items: [{ n: 1, key: newArrivalKey("t0", Date.parse("2026-10-20T19:30:00+09:00")), conversationId: "t0", name: "x", label: "x" }] };
  const future: TodoSnapshot = { messageId: null, sentAt: iso("2026-10-21T12:30:00+09:00"), items: [{ n: 1, key: newArrivalKey("t1", AT), conversationId: "t1", name: "x", label: "x" }] };
  eq(rotationOrder(pool, [old, future], AT).map((c) => c.conversationId), ["t0", "t1", "t2"]);
  const today: TodoSnapshot = { messageId: null, sentAt: iso("2026-10-21T10:30:00+09:00"), items: [{ n: 1, key: newArrivalKey("t0", AT), conversationId: "t0", name: "x", label: "x" }] };
  eq(rotationOrder(pool, [today], AT).map((c) => c.conversationId), ["t1", "t2", "t0"]);
});

it("朝の掛け声: その日の最初の便（10:30）だけ一番上に1行", () => {
  const at1030 = Date.parse("2026-10-21T10:30:00+09:00");
  const t1030 = renderStaffTodoList(buildStaffTodoList(manyDaily(2, at1030)))!;
  eq(t1030.split("\n")[0], MORNING_CALL_LINE);
  eq(MORNING_CALL_LINE, "全員に物件出して返信して！！それがしょーへいの今日の全仕事！！");
  ok(t1030.split("\n")[1].startsWith("【やることリスト】"), t1030.slice(0, 100));
  const t1130 = renderStaffTodoList(buildStaffTodoList(manyDaily(2, AT)))!;
  ok(!t1130.includes(MORNING_CALL_LINE) && t1130.startsWith("【やることリスト】"), t1130.slice(0, 100));
  // 回す時も一番上
  const big = composeStaffTodoPost(buildStaffTodoList(manyDaily(80, at1030))).text!;
  eq(big.split("\n")[0], MORNING_CALL_LINE);
  ok(big.length <= TODO_LIST_MAX_CHARS);
});

it("朝の掛け声: その日に最初に送る便に1回だけ（10:30 が送れなければ 11:30・再試行で2回出ない・昨日の控えは数えない）", () => {
  const at = (hm: string) => Date.parse(`2026-10-21T${hm}:00+09:00`);
  const snap = (sentAt: string): TodoSnapshot => ({ messageId: sentAt, sentAt: iso(sentAt), items: [] });
  const first = (hm: string, snaps: TodoSnapshot[]) => composeStaffTodoPost(buildStaffTodoList(manyDaily(2, at(hm))), { snapshots: snaps }).text!.split("\n")[0] === MORNING_CALL_LINE;
  const yday = snap("2026-10-20T20:30:00+09:00");
  eq(first("10:30", [yday]), true);
  eq(first("11:30", [yday]), true); // 10:30 が送れなかった日
  eq(first("10:31", [snap("2026-10-21T10:30:00+09:00"), yday]), false); // 再試行・手動
  eq(first("11:30", [snap("2026-10-21T10:30:00+09:00"), yday]), false);
  eq(first("20:30", [snap("2026-10-21T19:30:00+09:00")]), false);
  // この便より後の控え（preview の at を過去にした時）は数えない
  eq(first("10:30", [snap("2026-10-21T12:30:00+09:00")]), true);
  // 控えが読めない（空）時は 10 時台だけ（毎便に出さない）
  eq(first("10:30", []), true);
  eq(first("11:30", []), false);
});

it("1日10便: ④200人＋AIX の行で回し続けても飢える人はいない・番号は常にその便の行の人だけ・引用した古い便の☑はその便の人・☑でAIXは閉じない", () => {
  const n = 200;
  const hours = ["10:30", "11:30", "12:30", "13:30", "14:30", "15:30", "16:30", "17:30", "18:30", "19:30"];
  const snaps: TodoSnapshot[] = [];
  const posts: Array<{ post: TodoPost; snap: TodoSnapshot; text: string }> = [];
  const seen = new Set<string>();
  const marks: Array<{ item_key: string; conversation_id: string; marked_at: string; via: string }> = [];
  for (const [k, hm] of hours.entries()) {
    const at = Date.parse(`2026-10-21T${hm}:00+09:00`);
    const i = manyDaily(n, at);
    // AIX の行（①③）を持つお客様も混ぜる
    i.conversations = [...i.conversations, conv("x1", "エーアイエックス一"), conv("x2", "エーアイエックス二")];
    i.aixItems = [pending("ax1", "x1", "property_send", "2026-10-21T09:00:00+09:00"), pending("ax2", "x2", "reply", "2026-10-21T09:10:00+09:00")];
    i.marks = [...marks];
    const post = composeStaffTodoPost(buildStaffTodoList(i), { snapshots: [...snaps] });
    const text = post.text!;
    ok(text.length <= TODO_LIST_MAX_CHARS, `${hm} ${text.length}`);
    eq(text.split("\n")[0] === MORNING_CALL_LINE, k === 0);
    const snap = { ...snapOfPost(post, `2026-10-21T${hm}:00+09:00`), messageId: `m${k}` };
    // 文の番号の行 = 控えの同じ番号のお客様（どの番号も別の人に当たらない）
    const lines = text.split("\n");
    for (const it of snap.items) {
      const ls = lines.filter((l) => l.includes(todoNumberMark(it.n))); // 見出し（━ 3. … ━）・「次の便で」の行は丸数字を持たない＝番号の行だけが当たる
      if (ls.length !== 1) throw new Error(`${hm} n=${it.n} ${JSON.stringify(ls)}`);
      ok(ls[0].includes(it.name) || it.conversationId.startsWith("x"), `${hm} ${it.n} ${ls[0]} ≠ ${it.name}`);
    }
    // 出していない④の人は控えに無い
    const shownSet = new Set(shownIds(post));
    ok(snap.items.filter((x) => x.key.startsWith("newarrival:")).every((x) => shownSet.has(x.conversationId)));
    for (const id of shownSet) seen.add(id);
    // この便で☑3 を返した人は次から外れる（3 が新着確認の行なら）
    const r3 = resolveTodoReply(parseTodoReply("☑3")!, snap);
    if (r3.hits.length) marks.push({ item_key: r3.hits[0].key, conversation_id: r3.hits[0].conversationId, marked_at: new Date(at + 60_000).toISOString(), via: TODO_MARK_VIA_NONE });
    snaps.unshift(snap);
    posts.push({ post, snap, text });
  }
  ok(posts[0].post.carried[4] > 100, String(posts[0].post.carried[4])); // 本当に回している
  // 1日で全員出た
  eq(seen.size, n);
  // ☑した人はその後の便に出ない
  for (const m of marks) {
    const after = posts.filter((p) => Date.parse(p.snap.sentAt) > Date.parse(m.marked_at));
    ok(after.every((p) => !shownIds(p.post).includes(m.conversation_id)), m.conversation_id);
  }
  // 古い便を引用した「☑1」は引用した便の1番の人（新しい便の1番ではない）・引用なしは最後の便
  const nowMs = Date.parse("2026-10-21T19:45:00+09:00");
  for (const [k, p] of posts.entries()) {
    const quoted = pickTodoSnapshot(snaps, `m${k}`, nowMs)!;
    eq(quoted.messageId, `m${k}`);
    const daily = p.snap.items.find((x) => x.key.startsWith("newarrival:"))!;
    const r = resolveTodoReply(parseTodoReply(`☑${daily.n}`)!, quoted);
    eq(r.hits.map((h) => h.conversationId), [daily.conversationId]);
    // AIX の行の番号に☑ → 閉じない（「新着確認の行ではありません」）
    for (const ax of p.snap.items.filter((x) => x.key.startsWith("aix:"))) {
      const ra = resolveTodoReply(parseTodoReply(`☑${ax.n}`)!, quoted);
      eq(ra.hits.length, 0);
      eq(ra.unknownNumbers, [ax.n]);
    }
    // 出していない番号（この便の行数より大きい）は当たらない
    const over = p.snap.items.length + 1;
    eq(resolveTodoReply(parseTodoReply(`☑${over}`)!, quoted).hits.length, 0);
  }
  eq(pickTodoSnapshot(snaps, null, nowMs)!.messageId, `m${hours.length - 1}`);
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
  ok(text.includes("━ 5. その他の新着確認 ━") && !text.includes("🌟") && !text.includes("【審査中】"), text);
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
