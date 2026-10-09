// 2026-10-09 約束の並び（promise-queue.ts）と2段のまとめた約束（two-stage multiPromise）。こちらの文・お客様の連投は実物（名前・物件名は伏せた）
// 実行: npx tsx app/lib/__tests__/promise-queue.test.ts
import { promisesInStaffText, buildPromiseQueue, nextPromiseAix, keepPromiseQueueItem, promiseQueueNote, PROMISE_QUEUE_NOTE_PREFIX, type QueueMsg, type QueueAixLog } from "../promise-queue";
import { resolveTwoStage } from "../two-stage";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`expected ${JSON.stringify(s.slice(0, 300))} to contain ${JSON.stringify(sub)}`); }
function not(s: string, sub: string) { if (s.includes(sub)) throw new Error(`expected not to contain ${JSON.stringify(sub)}`); }
// 既定 off（2026-10-09）の物を on にして確かめる
process.env.PROMISE_QUEUE = "on"; process.env.TWO_STAGE_MULTI_PROMISE = "on";
const kinds = (t: string) => promisesInStaffText(t, "2026-10-01T00:00:00.000Z").map((p) => p.kind).sort();

console.log("promisesInStaffText（竹内さんのまとめた約束）");
it("db3722 募集状況の確認＋御見積書（あわせて）", () => eq(kinds("かしこまりました！！\nウェルスクエア〇〇308号室の募集状況確認させて頂きます！！\n確認出来次第、敷金礼金無しの最大限割引させて頂いた初期費用の御見積書もあわせてお送りさせて頂きます😌！！"), ["check", "estimate"]));
it("ed7695 募集状況と初期費用まとめて確認＝確認＋見積", () => eq(kinds("かしこまりました！！\nお送り頂きましたお部屋の募集状況と初期費用まとめて確認させて頂きます😊！！\n確認出来次第お送りさせて頂きます！！"), ["check", "estimate"]));
it("ac7c7f 募集状況＋御見積書をご用意", () => eq(kinds("かしこまりました！！\nお送り頂きました物件の募集状況を確認させて頂きます！！\n他社様の28万円より抑えられるよう、最大限割引して御見積書をご用意いたします😊！！"), ["check", "estimate"]));
it("b3bae3 募集状況＋あわせてピックアップ", () => eq(kinds("募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！\nあわせて、ペット可・1DK・家賃8.5万円以内のお部屋もピックアップしてお送りさせて頂きます😌！！"), ["check", "pickup"]));
it("288d47 「初期費用御見積し送らせて頂きます」も見積の約束", () => eq(kinds("かしこまりました！！\n最大限割引しました初期費用御見積し送らせて頂きます😊！！"), ["estimate"]));
it("f29676 日程調整の約束＝内覧の日程", () => eq(kinds("かしこまりました！！\n日程調整させて頂き確認後明日午前中にご連絡させて頂きます😊！！"), ["viewing_check"]));
it("749c55 室内写真撮影しお送り", () => eq(kinds("現在まだ審査進捗がない状況となります！！\n月曜日に室内写真撮影しお送りさせて頂きます！！"), ["photo"]));
it("2c434b 「お時間厳しい場合…撮影しお送り」（条件つき）は約束にしない", () => eq(kinds("彼氏様お時間厳しい場合室内撮影写真と動画撮影しお送りさせて頂きます！！"), []));
it("報告だけ（約束なし）", () => eq(kinds("こちら〇〇の室内写真となります😊！！\nお手隙の際にご査収ください！！"), []));

console.log("buildPromiseQueue / nextPromiseAix（1本送ったら次）");
const T0 = "2026-10-05T01:00:00.000Z";
const msgs: QueueMsg[] = [
  { sender: "customer", text: "ここ空いてますか？\nあと初期費用も知りたいです\nhttps://suumo.jp/chintai/bc_1/", createdAt: T0 },
  { sender: "staff", text: "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます！！\nあわせて、ご内覧のお日にちも調整させて頂きます！！", createdAt: "2026-10-05T01:05:00.000Z" },
];
it("約束の直後: 次は 物件確認した・残り 内覧", () => {
  const q = buildPromiseQueue(msgs, [], Date.parse("2026-10-05T01:06:00.000Z"));
  const nx = nextPromiseAix(q, { nowMs: Date.parse("2026-10-05T01:06:00.000Z") });
  eq(nx?.next.action, "property_check_result"); eq(nx?.rest.map((s) => s.action), ["viewing_invite"]);
});
it("物件確認した（御見積書同封）を送った後: 次は 内覧日調整", () => {
  const logs: QueueAixLog[] = [{ aixType: "property_check_result", sentAt: "2026-10-05T03:00:00.000Z", estimateSent: true, text: "募集中となります！！最大限割引させて頂いた御見積書となります" }];
  const nx = nextPromiseAix(buildPromiseQueue(msgs, logs, Date.parse("2026-10-05T03:01:00.000Z")), { nowMs: Date.parse("2026-10-05T03:01:00.000Z") });
  eq(nx?.next.action, "viewing_invite"); eq(nx?.rest.length, 0);
});
it("内覧日調整も送った後: 何も残らない", () => {
  const logs: QueueAixLog[] = [{ aixType: "property_check_result", sentAt: "2026-10-05T03:00:00.000Z" }, { aixType: "viewing_invite", sentAt: "2026-10-05T03:10:00.000Z" }];
  eq(nextPromiseAix(buildPromiseQueue(msgs, logs, Date.parse("2026-10-05T03:11:00.000Z")), { nowMs: Date.parse("2026-10-05T03:11:00.000Z") }), null);
});
it("確認＋見積の約束: 見積書を先に送っても確認は済み（空いていた結果を伝えた）", () => {
  const m2: QueueMsg[] = [{ sender: "staff", text: "〇〇の募集状況確認させて頂き、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！", createdAt: T0 }];
  const q = buildPromiseQueue(m2, [{ aixType: "estimate_sheet", sentAt: "2026-10-05T05:00:00.000Z" }], Date.parse("2026-10-05T05:01:00.000Z"));
  eq(nextPromiseAix(q, { nowMs: Date.parse("2026-10-05T05:01:00.000Z") }), null);
});
it("募集終了の結果 → 見積・内覧の約束はやめる（次の要対応にしない）", () => {
  const m2: QueueMsg[] = [{ sender: "staff", text: "お送り頂きました物件の募集状況確認させて頂きます！！\n確認出来次第、最大限割引させて頂いた初期費用の御見積書もあわせてお送りさせて頂きます！！", createdAt: T0 }];
  const q = buildPromiseQueue(m2, [{ aixType: "property_check_result", sentAt: "2026-10-05T05:00:00.000Z", text: "確認させて頂きましたところ、既に募集終了となっておりました！！" }], Date.parse("2026-10-05T05:01:00.000Z"));
  eq(q.find((s) => s.kind === "estimate")?.status, "dropped");
  eq(nextPromiseAix(q, { nowMs: Date.parse("2026-10-05T05:01:00.000Z") }), null);
});
it("手打ちで御見積書を送った（estimate_sent）→ 見積の約束は済み", () => {
  const m2: QueueMsg[] = [
    { sender: "staff", text: "最大限割引させていただいた初期費用の御見積書を作成しお送りさせて頂きます！！", createdAt: T0 },
    { sender: "staff", text: "こちら〇〇の最大限割引させて頂いた初期費用の御見積書となります😊！！", createdAt: "2026-10-05T02:00:00.000Z" },
  ];
  eq(buildPromiseQueue(m2, [], Date.parse("2026-10-05T02:01:00.000Z")).find((s) => s.kind === "estimate")?.status, "done");
});
it("探し続ける約束（お部屋探し継続・新着出次第）は次の要対応にしない", () => {
  const m2: QueueMsg[] = [{ sender: "staff", text: "引き続きお部屋探し継続させていただきます！！", createdAt: T0 }];
  eq(nextPromiseAix(buildPromiseQueue(m2, [], Date.parse(T0) + 60_000), { nowMs: Date.parse(T0) + 60_000 }), null);
});
it("72時間を過ぎた約束は次の要対応にしない", () => {
  eq(nextPromiseAix(buildPromiseQueue(msgs, [], Date.parse(T0) + 80 * 3600_000), { nowMs: Date.parse(T0) + 80 * 3600_000 }), null);
});
it("要対応の印と取り下げない線", () => {
  const nx = nextPromiseAix(buildPromiseQueue(msgs, [], Date.parse(T0) + 600_000), { nowMs: Date.parse(T0) + 600_000 })!;
  const note = promiseQueueNote(nx.next, nx.rest);
  has(note, PROMISE_QUEUE_NOTE_PREFIX); has(note, "物件確認した"); has(note, "残り: 内覧の確認・日程");
  eq(keepPromiseQueueItem({ resolution_note: note, created_at: T0 }, Date.parse(T0) + 3600_000), true);
  eq(keepPromiseQueueItem({ resolution_note: note, created_at: T0 }, Date.parse(T0) + 80 * 3600_000), false);
  eq(keepPromiseQueueItem({ resolution_note: null, created_at: T0 }, Date.parse(T0) + 3600_000), false);
  eq(keepPromiseQueueItem({ resolution_note: note, created_at: T0 }, Date.parse(T0) + 3600_000, { PROMISE_QUEUE: "" }), false);
});

console.log("resolveTwoStage（同じ連投の別の依頼もまとめて約束）");
const base = { finalAix: "property_check_result", decisionSource: "llm", pickupReady: false, postApply: false } as const;
it("空き（主）＋内覧＋他の物件 → 内覧の日程・ピックアップをあわせて約束", () => {
  const v = resolveTwoStage({ ...base, customerText: "こちらまだ空いてますか？\n空いていたら内覧したいです\n他にも似たような物件ありますか？", ackOnly: false })!;
  has(v.direction, "あわせて"); has(v.direction, "ご内覧のお日にち"); has(v.direction, "ピックアップ");
  eq(v.extraPromises, ["viewing", "pickup"]);
});
it("持ち込み＋空き＋費用（brought_both）は今まで通り（足さない）", () => {
  const v = resolveTwoStage({ ...base, customerText: "https://suumo.jp/chintai/bc_1/\nここ空いてますか？初期費用いくらですか？", brought: { ask: "both", count: 1 } })!;
  eq(v.extraPromises, undefined); has(v.source, "brought_both");
});
it("依頼が1つ（空きだけ）は足さない", () => {
  const v = resolveTwoStage({ ...base, customerText: "こちらまだ空いてますか？" })!;
  eq(v.extraPromises, undefined); not(v.direction, "まとめて約束");
});
it("ピックアップの約束（主）＋空き＋見積（物件が無い番の費用は足さない）", () => {
  const v = resolveTwoStage({ ...base, finalAix: "property_send", customerText: "このURLの物件空いてますか？\nあと初期費用っていくらくらいですか？", ackOnly: false })!;
  eq(v.kind, "pickup"); eq(v.extraPromises, ["check"]);
});
it("既定（TWO_STAGE_MULTI_PROMISE が on でない）は足さない", () => {
  process.env.TWO_STAGE_MULTI_PROMISE = "";
  try { eq(resolveTwoStage({ ...base, customerText: "こちらまだ空いてますか？\n空いていたら内覧したいです\n他にも似たような物件ありますか？" })!.extraPromises, undefined); }
  finally { process.env.TWO_STAGE_MULTI_PROMISE = "on"; }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  - " + f); process.exit(1); }
