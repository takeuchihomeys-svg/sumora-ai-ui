// npx tsx app/lib/__tests__/situation-timeline.test.ts
// 2026-11-15 作業員L: 時系列の帳面（時の言葉を言った日を基準に直す・カレンダーの予定の読み方）と送った物件の件数の切れの直し（SENT_PROPS_FULL）
import assert from "node:assert/strict";
import { resolveTimeWords, readCalendarEvents, buildTimeline, timelineBlock, situationTimelineOn, mdLabel } from "../situation-timeline";
import { buildSentPropsText, sentPropsFullOn, type SentProp } from "../sent-props-text";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const jst = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h - 9);
const said = jst(2026, 11, 13); // 金曜

t("既定（時系列の帳面 on・送った物件 count）", () => { assert.equal(situationTimelineOn({}), true); assert.equal(situationTimelineOn({ BRAIN_SITUATION_TIMELINE: "off" }), false); assert.equal(sentPropsFullOn({}), true); assert.equal(sentPropsFullMode({}), "count"); assert.equal(sentPropsFullOn({ SENT_PROPS_FULL: "off" }), false); });
t("時の言葉: 来週・再来週・週末・月末・来月・N月下旬・N月N日・明日・N日・給料日", () => {
  const w = (s: string) => resolveTimeWords(s, said).map((x) => `${x.word}=${x.label}`);
  assert.deepEqual(w("来週から動けます"), ["来週=11/16（月）〜11/22（日）"]);
  assert.deepEqual(w("再来週なら"), ["再来週=11/23（月）〜11/29（日）"]);
  assert.deepEqual(w("週末に見たい"), ["週末=11/14（土）〜11/15（日）"]);
  assert.deepEqual(w("月末に退去"), ["月末=11/26（木）〜11/30（月）"]);
  assert.deepEqual(w("来月頭に入居"), ["来月頭=12/1（火）〜12/5（土）"]);
  assert.deepEqual(w("1月下旬に引越し"), ["1月下旬=1/21（木）〜1/31（日）"]);
  assert.deepEqual(w("12月20日に退去"), ["12月20日=12/20（日）"]);
  assert.deepEqual(w("明日連絡します"), ["明日=11/14（土）"]);
  assert.deepEqual(w("20日なら空いてます"), ["20日=11/20（金）"]);
  assert.deepEqual(w("給料日の後で"), ["給料日=日付は人による（確かめないと決まらない）"]);
  assert.deepEqual(w("2日程度"), []);
});
t("カレンダー: 時刻がある予定は種類を問わず内覧・終日は約束と連絡（内覧調整も終日なら約束）", () => {
  const r = readCalendarEvents([
    { title: "YUMAさん 内覧調整", event_type: "viewing", all_day: true, start_at: "2026-11-14T00:00:00Z", is_done: false },
    { title: "YUMAさん 内覧", event_type: "other", all_day: false, start_at: "2026-11-16T05:00:00Z", is_done: false },
    { title: "電話", event_type: "phone", all_day: false, start_at: "2026-11-10T05:00:00Z", is_done: true },
  ]);
  assert.deepEqual(r.map((x) => `${x.kind}:${x.type}:${x.title}`), ["viewing:phone:電話", "promise:viewing:内覧調整", "viewing:other:内覧"]);
});
t("時系列の帳面の塊（事実だけ・名前は出さない）", () => {
  const rec = buildTimeline({ customerMsgs: [{ text: "来週から動けます", atMs: said }], calendar: [{ title: "YUMAさん 内覧", event_type: "other", all_day: false, start_at: "2026-11-16T05:00:00Z", is_done: false }], nowMs: said });
  const b = timelineBlock(rec, said);
  assert.match(b, /【時系列の帳面/);
  assert.match(b, /「来週」（11\/13（金）に言った）→ 11\/16（月）〜11\/22（日）/);
  assert.match(b, /11\/16（月） 14:00（これから・その他・内覧）/);
  assert.ok(!/YUMA/.test(b));
  assert.equal(timelineBlock(buildTimeline({ customerMsgs: [], calendar: [], nowMs: said }), said), "");
  assert.equal(mdLabel(said), "11/13（金）");
});
const prop = (i: number): SentProp => ({ property_name: `物件${i}`, room_no: `${100 + i}`, sent_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), rent: null, recruitment_status: null, applicant_rank: null, customer_reaction: null });
t("送った物件: SENT_PROPS_FULL の時は件数は全部・詳しい行は新しい順に N 件・前は短い1行", () => {
  const ps = Array.from({ length: 25 }, (_, i) => prop(i));
  const off = buildSentPropsText(ps);
  assert.match(off, /【すでに送付済みの物件（25件）】/);
  assert.ok(!/それより前に送った物件/.test(off));
  const on = buildSentPropsText(ps, { detailN: 20 });
  assert.match(on, /【すでに送付済みの物件（25件）】/);
  assert.match(on, /▼それより前に送った物件（5件）: 物件4 104（11\/1）、物件3 103/);
  assert.match(on, /- 物件24 124/);
  assert.ok(!/- 物件4 104/.test(on));
});
console.log(`${n} tests ok`);

// ── 約束と果たした通の結び付け（PROMISE_CLOSE_LINK）
import { linkPromiseClosures, promiseClosedOf, promiseCloseLinkOn } from "../promise-close-link";
t("約束の結び付け: 物件が合う約束を全部（重ねた約束も）・名前が合わない約束は閉じない・名前の無い約束は閉じる", () => {
  assert.equal(promiseCloseLinkOn({}), true); assert.equal(promiseCloseLinkOn({ PROMISE_CLOSE_LINK: "off" }), false);
  const rows = [
    { id: 1, kind: "confirmation_promised", status: "promised", sent_at: "2026-11-10T01:00:00Z", detail: { propertyNames: ["Aマンション 101号室"] } },
    { id: 2, kind: "confirmation_promised", status: "promised", sent_at: "2026-11-10T02:00:00Z", detail: { propertyNames: ["Aマンション"] } },
    { id: 3, kind: "confirmation_promised", status: "promised", sent_at: "2026-11-10T03:00:00Z", detail: { propertyNames: ["Bハイツ"] } },
    { id: 4, kind: "pickup_declared", status: "promised", sent_at: "2026-11-10T01:00:00Z", detail: {} },
  ];
  const l = linkPromiseClosures(rows, [
    { kind: "confirmation_reported", status: "done", sent_at: "2026-11-10T05:00:00Z", aix_type: "property_check_result", detail: { propertyNames: ["Aマンション"] } },
    { kind: "properties_sent", status: "done", sent_at: "2026-11-10T06:00:00Z", detail: { propertyNames: ["Cレジデンス"] } },
  ]);
  assert.deepEqual(l.map((x) => `${x.promiseId}:${x.closedBy.how}`), ["1:same_object", "2:same_object", "4:unnamed"]);
  assert.equal(promiseClosedOf({ detail: { closed_by: l[0].closedBy } }), true);
  assert.equal(promiseClosedOf({ detail: {} }), false);
});
console.log("promise-close-link ok");

// ── AIX要対応の閉じ方（AIX_ITEM_CLOSE_STRICT）
import { aixItemCloseDecision, aixItemCloseStrictOn } from "../aix-item-close-rule";
t("AIX要対応: 同じ AIX・同じ要件を果たす組だけ閉じる（見積は同封の時だけ）・他は待ちのまま", () => {
  assert.equal(aixItemCloseStrictOn({}), false);
  assert.equal(aixItemCloseDecision("property_check", "property_check_result").close, true);
  assert.equal(aixItemCloseDecision("property_send", "property_recommendation").close, true);
  assert.equal(aixItemCloseDecision("viewing_invite", "meeting_place").close, true);
  assert.equal(aixItemCloseDecision("estimate_sheet", "property_check_result", { estimateSent: true }).close, true);
  assert.equal(aixItemCloseDecision("estimate_sheet", "property_check_result").close, false);
  assert.equal(aixItemCloseDecision("property_check_result", "property_recommendation").close, false);
  assert.match(aixItemCloseDecision("viewing_invite", "phone_call").why, /果たしたか確かめる/);
});
console.log("aix-item-close ok");
t("時系列の帳面: 問いの文の日付は入れない（q092「ここは最短11月中旬でしょうか？」は物件の入居日の問い）", () => {
  const rec = buildTimeline({ customerMsgs: [{ text: "見てきました。\nここは最短11月中旬でしょうか？", atMs: said }, { text: "10月後半くらいに入れるところとかありますか？", atMs: said }, { text: "来週から動けます", atMs: said }], calendar: [], nowMs: said });
  assert.deepEqual(rec.words.map((w) => w.word), ["来週"]);
});
console.log("timeline-question ok");

// ── 今の状況の記録（BRAIN_SITUATION_NOW）
import { buildSituationNow, situationNowOn, situationNowDigest, factIdOf } from "../situation-now";
t("今の状況の記録: 送った事・確認した事・前の項目（答えたか）・開いている約束・要件と送った所まで・食い違い（id 付き）", () => {
  assert.equal(situationNowOn({}), false);
  const facts = [
    { sent_at: "2026-11-10T01:00:00Z", origin: "staff_text", kind: "confirmation_promised", status: "promised", detail: { object: "募集状況" } },
    { sent_at: "2026-11-10T02:00:00Z", origin: "aix", aix_type: "property_send", kind: "properties_sent", status: "done", detail: { propertyNames: ["Aマンション 101"] } },
    { sent_at: "2026-11-10T03:00:00Z", origin: "staff_text", kind: "pickup_declared", status: "promised", detail: {} },
    { sent_at: "2026-11-10T04:00:00Z", origin: "aix", aix_type: "property_send", kind: "properties_sent", status: "done", detail: {} },
  ];
  const aix = [{ aix_type: "property_check_result", line_message_id: "L1", sent_at: "2026-11-10T05:00:00Z", created_at: "2026-11-10T05:00:00Z", check_pattern: "availability", property_names: ["Aマンション"], prop_statuses: ["available"] }];
  const exchange = { ours: [{ key: "q.move_in", kind: "question", label: "入居の時期を聞いた", purpose: "", expect: "answer", dueHours: 24, text: "ご入居はいつ頃をご希望でしょうか", at: "2026-11-10T06:00:00Z" }], theirs: [], open: [{ kind: "our_question_unanswered", what: "", at: "2026-11-10T06:00:00Z", overdue: false }] } as never;
  const s = buildSituationNow({ facts, aix, exchange, nowMs: Date.parse("2026-11-11T01:00:00Z"),
    asks: { items: [{ id: "q1", quote: "空いてますか" }], progress: { sentUpTo: 0, answered: [], promised: [], remaining: ["q1"] }, msgs: [{ no: 1, slot: "aix", aix: "property_check_result" }] } });
  assert.deepEqual(s.sent!.map((x) => x.sent_id), [factIdOf(facts[1]), factIdOf(facts[3])]);
  assert.equal(s.checked![0].check_id, "aix:L1"); assert.equal(s.checked![0].what, "vacancy"); assert.equal(s.checked![0].told, true);
  assert.equal(s.our_items![0].item_id, "2026-11-10T06:00:00Z#0"); assert.equal(s.our_items![0].answered, false);
  // 確認の約束は後に確認の報告が無い＝開いたまま・ピックアップの約束は後に送付＝閉じた
  assert.deepEqual(s.promises_open!.map((p) => p.kind), ["confirmation_promised"]);
  assert.deepEqual(s.asks, { done: [], promised: [], open: ["q1"] });
  assert.deepEqual(s.this_turn, { sent_up_to: 0, remaining: [{ no: 1, slot: "aix", aix: "property_check_result" }] });
  assert.deepEqual(situationNowDigest(s), { tw: 0, tv: 0, se: 2, ch: 1, oi: 1, ou: 1, po: 1, ao: 1, cf: 0 });
});
console.log("situation-now ok");
import { sentPropsFullMode } from "../sent-props-text";
t("送った物件 count: 見出しは全部の件数・詳しい行は新しい順に20件・それより前の行は出さない", () => {
  assert.equal(sentPropsFullMode({ SENT_PROPS_FULL: "count" }), "count");
  const ps = Array.from({ length: 25 }, (_, i) => prop(i));
  const c = buildSentPropsText(ps, { detailN: 20, olderLine: false });
  assert.match(c, /【すでに送付済みの物件（25件）】/);
  assert.ok(!/それより前に送った物件/.test(c));
  assert.match(c, /- 物件24 124/); assert.ok(!/- 物件4 104/.test(c));
});
console.log("sent-count ok");
