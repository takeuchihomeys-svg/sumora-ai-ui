// npx tsx app/lib/__tests__/compose-value-slots.test.ts
import assert from "node:assert/strict";
import { readValues, topConditionKind, appealValuePlan, answerSourceOf, applyStrengthFromFacts, valueSlotsNote, decideClosing, closingNote, composeValueSlotsOn, composeClosingTableOn, type ClosingInput } from "../compose-value-slots";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

// 竹内さんの実送信の資料の形（値は架空の物件・文は写さない）
const MAT = "賃料: 62,000円 管理費: 5,000円\n敷金: なし 礼金: なし\n1K 洋室8.5帖 25.3㎡\n2023年3月築\n地下鉄御堂筋線 江坂駅 徒歩6分\nオートロック・宅配ボックス・独立洗面台\nインターネット無料\n5階\n保証会社: 日本セーフティ";

t("値を材料から決まった計算で読む（家賃は管理費込に足す・階も読むが訴求には出さない）", () => {
  const v = readValues(MAT);
  assert.equal(v.rent, "家賃管理費込67,000円");
  assert.equal(v.shikirei, "敷金礼金なし");
  assert.equal(v.new, "2023年3月築");
  assert.equal(v.walk, "江坂駅徒歩6分");
  assert.match(v.area ?? "", /洋室8.5帖・25.3㎡/);
  assert.equal(v.floor, "5階");
  assert.equal(v.net, "インターネット無料");
});

t("訴求: お客様の一番のこだわりを先に・1文 3個まで・階は入れない", () => {
  const p = appealValuePlan({ materialText: MAT, topText: "広めのお部屋がいいです" });
  assert.equal(p.values[0].kind, "area");
  assert.ok(p.sentences.every((s) => s.length <= 3));
  assert.ok(!p.values.some((v) => v.kind === "floor"));
  assert.ok(p.omit.some((o) => o.kind === "floor"));
  const q = appealValuePlan({ materialText: MAT, topText: null });
  assert.deepEqual(q.values.slice(0, 2).map((v) => v.kind), ["shikirei", "new"]);
  assert.equal(topConditionKind("駅から近くて家賃は7万まで"), "walk");
});

t("答えの出所で書き方を決める（info-kind の名前）", () => {
  assert.equal(answerSourceOf({ basis: "material", route: "reply" }), "material");
  assert.equal(answerSourceOf({ basis: "company_fact", route: "reply" }), "company_fact");
  assert.equal(answerSourceOf({ basis: "material", route: "promise" }), "staff_only");
  assert.equal(answerSourceOf({ basis: "judgement", route: "reply" }), null);
});

t("申込の誘い: 抑える理由の事実が無ければ door に倒す", () => {
  assert.equal(applyStrengthFromFacts("2023年築・敷礼なし", "strong").strength, "door");
  const r = applyStrengthFromFacts("残り1部屋のみ・キャンセル料はかかりません", "strong");
  assert.equal(r.strength, "strong");
  assert.deepEqual(r.facts, ["1部屋のみ", "キャンセル料"]);
});

const base: ClosingInput = { scene: "property_share", dest: "viewing", strength: "invite", hook: "hooked", propertyState: "viewable", sentThisTurn: false, considering: false, urgent: false, sentenceCount: 3, lastRole: "trust" };
t("締めの決め表", () => {
  assert.deepEqual([decideClosing(base).invite, decideClosing(base).sign], ["viewing", "none"]);
  assert.equal(decideClosing({ ...base, hook: "not_hooked" }).invite, "none");
  assert.deepEqual([decideClosing({ ...base, considering: true }).invite, decideClosing({ ...base, considering: true }).sign], ["none", "kigaru"]);
  assert.equal(decideClosing({ ...base, propertyState: "vacating" }).invite, "none");
  assert.equal(decideClosing({ ...base, propertyState: "vacating", urgent: true }).invite, "apply");
  assert.equal(decideClosing({ ...base, dest: "keep_send", strength: "none", lastRole: "keep", firstContact: true }).sign, "nanitozo");
  assert.equal(decideClosing({ ...base, dest: "keep_send", strength: "none", sentenceCount: 6, customerAsked: true }).sign, "none");
  assert.equal(decideClosing({ ...base, dest: "answer_only", strength: "none", lastRole: "answer", sentenceCount: 2 }).sign, "none");
  assert.equal(decideClosing({ ...base, dest: "answer_only", strength: "none", sentThisTurn: true }).sign, "receipt");
});

t("既定 off は何も足さない・on で1行", () => {
  assert.equal(composeValueSlotsOn({}), false);
  assert.equal(composeClosingTableOn({}), false);
  assert.equal(valueSlotsNote({ appeal: appealValuePlan({ materialText: MAT }) }, {}), "");
  assert.equal(closingNote(decideClosing(base), {}), "");
  assert.match(valueSlotsNote({ appeal: appealValuePlan({ materialText: MAT }) }, { COMPOSE_VALUE_SLOTS: "on" }), /推す値.*1文目: 敷金礼金なし/);
  assert.match(closingNote(decideClosing(base), { COMPOSE_CLOSING_TABLE: "on" }), /^- 締め: 内覧の誘い/);
});

console.log(`compose-value-slots: ${n} pass`);
