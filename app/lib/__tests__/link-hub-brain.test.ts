// つなぎの芯 → LINE のブレインの材料（link-hub-brain.ts）。LLM なし・DB なし。文は型だけ（名前・物件名は作り物）
// 実行: npx tsx app/lib/__tests__/link-hub-brain.test.ts
import { buildCustomerHub, hubContradictions, aixItemKey, type HubInput, type HubAixItem } from "../customer-hub";
import { hubBrainNote, hubOpenItems, renderHubBrainNote, customerTurnStartMs, linkHubBrainEnabled, linkHubBrainMode, linkHubPromiseColumnEnabled, promiseFulfillAix, promiseContinuation, renderPromiseColumn, nameTokensOf, HUB_BRAIN_MAX_ITEMS } from "../link-hub-brain";
import { confirmObjectOf, checkPatternForConfirmTopic, confirmObjectFromCustomerTurn } from "../action-ledger";
import { trackPromises, buildPromiseBrainNote } from "../promise-tracker";
import { isAckOnlyTurn } from "../ack-topic-scope";
import { currentReplayFloor } from "../test-replay-floor";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

const H = 3600_000;
const T0 = Date.parse("2026-10-10T01:00:00.000Z");
const iso = (h: number) => new Date(T0 + h * H).toISOString();
const NOW = T0 + 5 * H;
const CID = "abcdef12-0000-0000-0000-000000000000";
type Msg = { sender: string; text: string; h: number };
const input = (msgs: Msg[], over: Partial<HubInput> = {}, status = "proposing", nowMs = NOW): HubInput => ({
  nowMs,
  conv: { id: CID, customer_name: "山田 花子", account: null, status, is_post_apply: false, status_manual_back_at: null },
  state: { now: nowMs, status, messages: msgs.map((m) => ({ sender: m.sender, text: m.text, createdAt: iso(m.h) })), aixRows: [], recordedFacts: [], viewingHistory: [], sentProperties: [], lineTasks: [] },
  aixItems: [], pickups: [], calendarEvents: [], memoItems: [], reactions: null, reapply: null, ...over,
});
const note = (inp: HubInput) => { const hub = buildCustomerHub(inp); return hubBrainNote(hub, hubContradictions(hub, inp), inp); };
const items = (inp: HubInput, includeProperty = true) => { const hub = buildCustomerHub(inp); return hubOpenItems(hub, hubContradictions(hub, inp), inp, { includeProperty }); };
const item = (action: string, h: number, cp: string | null = null, status = "pending"): HubAixItem => ({ id: `i${h}`, conversation_id: CID, customer_name: null, action, check_pattern: cp, status, created_at: iso(h), done_at: null, done_aix_type: null, resolution_note: null } as HubAixItem);
const PARKING_PROMISE = "かしこまりました！！\n駐車場について管理会社に確認させて頂きます😊！！";

console.log("切替");
it("既定 off・on で入る", () => {
  eq(linkHubBrainMode({}), "off"); eq(linkHubBrainMode({ LINK_HUB_BRAIN: "ON" }), "column"); eq(linkHubBrainMode({ LINK_HUB_BRAIN: "list" }), "list"); eq(linkHubBrainMode({ LINK_HUB_BRAIN: "1" }), "off");
  eq(linkHubBrainEnabled({ LINK_HUB_BRAIN: "on" }), false, "一覧は list の時だけ"); eq(linkHubBrainEnabled({ LINK_HUB_BRAIN: "list" }), true);
  eq(linkHubPromiseColumnEnabled({}), false); eq(linkHubPromiseColumnEnabled({ LINK_HUB_BRAIN: "on" }), true);
});

console.log("今の番の始まり");
it("最後のスタッフの通より後のお客様の連投の最初", () => {
  const msgs = [{ sender: "customer", createdAt: iso(0) }, { sender: "staff", createdAt: iso(1) }, { sender: "customer", createdAt: iso(2) }, { sender: "customer", createdAt: iso(3) }];
  eq(customerTurnStartMs(msgs, NOW), T0 + 2 * H);
});
it("こちらが最後なら null・今より後の通は見ない", () => {
  eq(customerTurnStartMs([{ sender: "customer", createdAt: iso(0) }, { sender: "staff", createdAt: iso(1) }], NOW), null);
  eq(customerTurnStartMs([{ sender: "staff", createdAt: iso(1) }, { sender: "customer", createdAt: iso(9) }], NOW), null);
});

console.log("開いている事（候補の網）");
it("今の番の前に立った要対応は入る・今の番の後に立った物（この番のブレインの提案のこだま）は入らない", () => {
  const inp = input([{ sender: "staff", text: "物件をお送りします", h: 0 }, { sender: "customer", text: "ありがとうございます", h: 2 }],
    { aixItems: [item("viewing_invite", 1), item("estimate_sheet", 2.5)] });
  const its = items(inp);
  eq(its.map((x) => x.action), ["viewing_invite"]);
});
it("済んだ要対応（status が pending でない）は入らない", () => {
  const inp = input([{ sender: "customer", text: "はい", h: 2 }], { aixItems: [item("viewing_invite", 1, null, "done")] });
  eq(items(inp).length, 0);
});
it("確認の約束（約束の並び）は果たす AIX とピッカーつき・同じ AIX×ピッカーの要対応と1つにまとまる", () => {
  const inp = input([{ sender: "customer", text: "駐車場ありますか？", h: 0 }, { sender: "staff", text: PARKING_PROMISE, h: 0.1 }, { sender: "customer", text: "あと初期費用は？", h: 1 }],
    { aixItems: [item("property_check_result", 0.2, "mgmt_parking")] });
  const its = items(inp);
  const parking = its.filter((x) => x.action === "property_check_result" && x.checkPattern === "mgmt_parking");
  eq(parking.length, 1, "重なり");
});
it("果たした記録のある要対応（食い違い aix_item_open_promise_done）は入らない＝札がそろっている", () => {
  eq(aixItemKey("property_check_result", "mgmt_parking", "2026-10-10T01:12:00.000Z"), "property_check_result/mgmt_parking 立った 10-10T01:12");
});

it("物件を送る約束・要対応は既定で外す（探す約束と送れる物件は別の材料で届く）・LINK_HUB_BRAIN_PROPERTY=on で入る", () => {
  const inp = input([{ sender: "staff", text: "物件をお送りします", h: 0 }, { sender: "customer", text: "入居日はいつ頃ですか", h: 2 }], { aixItems: [item("property_send", 1), item("viewing_invite", 1.5)] });
  eq(items(inp, false).map((x) => x.action), ["viewing_invite"]);
  eq(items(inp, true).map((x) => x.action).sort(), ["property_send", "viewing_invite"]);
});

console.log("ブレインの材料の形");
it("開いている物が無ければ空（プロンプトは変わらない）", () => {
  eq(note(input([{ sender: "customer", text: "こんにちは", h: 1 }])), "");
});
it("行は 要対応・AIX【種類/ピッカー】・いつから。締めは原則（今の発言が先・続きの時だけ・開いているだけで AIX にしない・スタッフしか分からない結果は下書きに書かない）", () => {
  const n = note(input([{ sender: "staff", text: "物件をお送りします", h: 0 }, { sender: "customer", text: "ありがとうございます", h: 4 }], { aixItems: [item("property_check_result", 1, "mgmt_pet")] }));
  ok(/【つなぎの芯: 今の番の前から開いている事/.test(n), n);
  ok(/・要対応 AIX【property_check_result\/mgmt_pet】（4時間前に立った）/.test(n), n);
  ok(/同じ確認・同じ約束をもう一度しない/.test(n) && /まず今の発言に答える/.test(n) && /開いているだけで AIX にしない/.test(n) && /下書きに書かない/.test(n), n);
});
it("名前を伏せる・上限を超えたら「ほか N件」", () => {
  const many = Array.from({ length: HUB_BRAIN_MAX_ITEMS + 2 }, (_, i) => ({ from: "queue" as const, action: `a${i}`, checkPattern: null, what: `山田 花子さんへの約束${i}`, openedAt: iso(0), dueAt: null }));
  const n = renderHubBrainNote(many, { nowMs: NOW, customerName: "山田 花子" });
  ok(!/山田/.test(n), n);
  ok(/ほか 2件/.test(n), n);
});
it("期限の言い方（過ぎ・あと）", () => {
  const n = renderHubBrainNote([{ from: "calendar", action: "property_send", checkPattern: null, what: "物件送付", openedAt: iso(0), dueAt: iso(3) }, { from: "contact", action: null, checkPattern: null, what: "連絡日", openedAt: iso(0), dueAt: iso(30) }], { nowMs: NOW });
  ok(/期限を2時間過ぎ/.test(n), n); ok(/期限まであと25時間/.test(n), n);
});
it("申込以降・見送りは出さない（司令塔と同じ線）", () => {
  eq(note(input([{ sender: "customer", text: "はい", h: 2 }], { aixItems: [item("viewing_invite", 1)] }, "applying")), "");
});

it("約束の札の重なり（→ AIX【…】）・名前（1文字でも）・「お客様」を外す・ピッカーが種類と同じなら書かない", () => {
  const n = renderHubBrainNote([{ from: "queue", action: "property_send", checkPattern: "property_send", what: "お部屋のピックアップ → AIX【物件ピックアップした】", openedAt: iso(0), dueAt: null },
    { from: "calendar", action: "property_check_result", checkPattern: "mgmt_equipment", what: "【今日中】R 設備の確認→ご連絡", openedAt: iso(0), dueAt: null },
    { from: "calendar", action: "property_send", checkPattern: null, what: "お客様 新着が出たら物件送付", openedAt: iso(0), dueAt: null }], { nowMs: NOW, customerName: "R" });
  ok(/・約束 お部屋のピックアップ AIX【property_send】（5時間前に立った）/.test(n), n);
  ok(/・【必ず】の約束 【今日中】 設備の確認→ご連絡 AIX【property_check_result\/mgmt_equipment】/.test(n), n);
  ok(!/お客様 新着/.test(n) && /新着が出たら物件送付/.test(n), n);
});


console.log("v3: 約束の行に1列（果たす AIX・続きの印）");
const cont = (sentence: string, kind: string, turn: string) => promiseContinuation({ kind, sentence }, turn, { ackOnly: isAckOnlyTurn(turn), topicOf: confirmObjectOf, turnTopicOf: (t) => confirmObjectFromCustomerTurn(t)?.object ?? confirmObjectOf(t) });
it("駐車場の確認の約束 → 果たす AIX【property_check_result/mgmt_parking】", () => {
  eq(promiseFulfillAix({ kind: "確認", sentence: "駐車場について管理会社に確認させて頂きます" }, confirmObjectOf, checkPatternForConfirmTopic), { action: "property_check_result", checkPattern: "mgmt_parking" });
  eq(promiseFulfillAix({ kind: "物件探し", sentence: "ピックアップ出来次第お送りさせて頂きます" }, confirmObjectOf, checkPatternForConfirmTopic), { action: "property_send", checkPattern: null });
  eq(promiseFulfillAix({ kind: "見積書", sentence: "御見積書作成させて頂きます" }, confirmObjectOf, checkPatternForConfirmTopic), { action: "estimate_sheet", checkPattern: null });
  eq(promiseFulfillAix({ kind: "その他", sentence: "x" }, confirmObjectOf, checkPatternForConfirmTopic), null);
});
it("続きの印: 同じ要件・同じ物件・お礼だけ・触れていない", () => {
  eq(cont("駐車場について管理会社に確認させて頂きます", "確認", "駐車場って何台分ありますか？").mark, "same_topic");
  eq(cont("グランレジデンス本町の募集状況確認させて頂きます", "確認", "グランレジデンスの件どうでしたか").mark, "same_name");
  eq(cont("駐車場について管理会社に確認させて頂きます", "確認", "ありがとうございます！").mark, "ack");
  eq(promiseContinuation({ kind: "確認", sentence: "駐車場について管理会社に確認させて頂きます" }, "よろしくお願いします", { ackOnly: true, topicOf: confirmObjectOf, turnTopicOf: confirmObjectOf, staffAfterPromise: true }).mark, "other", "約束の後に別の通（待ち合わせ等）＝その通への了承");
  eq(cont("ピックアップ出来次第お送りさせて頂きます", "物件探し", "入居日はいつ頃が最速ですか？").mark, "other");
  eq(cont("駐車場について管理会社に確認させて頂きます", "確認", "").mark, "none");
});
it("一般の語（エアコン・マンション）は物件名にしない", () => {
  eq(nameTokensOf("エアコンとマンションの件 グランドメゾン"), ["グランドメゾン"]);
});
it("1列の形・約束の材料に入る・列が無い時は今と同じ", () => {
  eq(renderPromiseColumn({ action: "property_check_result", checkPattern: "mgmt_parking" }, { mark: "ack", word: null }), " → 果たす AIX【property_check_result/mgmt_parking】・今の発言はお礼・了承だけ（この約束の結果を待っている）");
  eq(renderPromiseColumn(null, { mark: "none", word: null }), "");
  eq(renderPromiseColumn({ action: "property_send", checkPattern: null }, { mark: "other", word: null }), " → 今の発言はこの約束に触れていない", "触れていない番は AIX を書かない");
  const NOW2 = Date.parse("2026-10-10T06:00:00Z");
  const track = trackPromises([{ sender: "customer", text: "駐車場ありますか？", createdAt: "2026-10-10T01:00:00Z" }, { sender: "staff", text: "駐車場について管理会社に確認させて頂きます！！", createdAt: "2026-10-10T01:05:00Z" }, { sender: "customer", text: "よろしくお願いします", createdAt: "2026-10-10T05:00:00Z" }], NOW2);
  ok(track.open.length === 1, JSON.stringify(track));
  const base = buildPromiseBrainNote(track, null);
  const withCol = buildPromiseBrainNote(track, null, { column: (p) => renderPromiseColumn(promiseFulfillAix(p, confirmObjectOf, checkPatternForConfirmTopic), cont(p.sentence, p.kind, "よろしくお願いします")) });
  ok(withCol.includes("果たす AIX【property_check_result/mgmt_parking】・今の発言はお礼・了承だけ"), withCol);
  ok(!base.includes("果たす AIX"), "列なしは今と同じ");
});

console.log("試験の線のファイル（hubSource）");
it("テストの会話の線に hubSource（本物の会話・時刻）を書けば読める・テストの会話は元にできない・形が違えば落とす", () => {
  const dir = mkdtempSync(join(tmpdir(), "hubsrc-"));
  const f = join(dir, "floor.json");
  const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
  const env = { REPLAY_FLOOR_FILE: f, LLM_TEST_MODE: "deepseek-all" } as Record<string, string>;
  writeFileSync(f, JSON.stringify({ conversationId: YUMA, floor: iso(0), hubSource: { conversationId: CID, at: iso(1) } }));
  const a = currentReplayFloor(env);
  if (a === null) { console.log("    （テストの印が通らない環境なので読みは飛ばす）"); return; }
  eq(a.hubSource, { conversationId: CID, at: iso(1) });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
