// 1通の計画（2026-10-28 竹内さんの決定）
// 実行: npx tsx app/lib/__tests__/message-plan.test.ts
import { messagePlanOn, normalizeMessagePlan, renderMessagePlanNote, alignPlanWithPriorities, secondMessageFromPlan, planHasNextBusinessDay, partOutOfThisMessage } from "../message-plan";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

// 咲（内覧の日にち決定＋審査の相談）: 待ち合わせ場所＝AIX と、審査の相談＝電話に分ける
const SAKI_PR = [
  { rank: 1, kind: "asked", item: "内覧は土曜日", quote: "土曜日でお願い出来れば", handling: "aix", aix: "meeting_place", reason: "日にち決定" },
  { rank: 2, kind: "asked", item: "審査の相談（職場の案内）", quote: "相談なのですが水商売", handling: "aix", aix: "phone_call", reason: "審査の相談は電話" },
];
const SAKI_RAW = {
  background: "内覧日を決めたうえで、職業の事情で審査が通るか不安",
  parts: [
    { rank: 1, meaning: "日にちの確定", when: "now", who: "aix", relation: "continues_promise", ref: "内覧調整の候補日", include: "in", omit_reason: null, msg: 1 },
    { rank: 2, meaning: "審査の進め方の打ち合わせ", when: "now", who: "reply", relation: "new", ref: null, include: "split", omit_reason: null, msg: 2 },
  ],
  messages: [{ no: 1, who: "aix", aix: "meeting_place", ranks: [1], why: "日にち確定" }, { no: 2, who: "phone", aix: null, ranks: [2], why: "審査の相談" }],
};

it("既定 off・優先順位の段が off なら on にしても off", () => {
  eq(messagePlanOn({}), false);
  eq(messagePlanOn({ BRAIN_MESSAGE_PLAN: "on" }), true);
  eq(messagePlanOn({ BRAIN_MESSAGE_PLAN: "on", BRAIN_PRIORITY_STEP: "off" }), false);
});
it("型の外れた値は既定に・空なら null", () => {
  eq(normalizeMessagePlan(null), null);
  eq(normalizeMessagePlan({}), null);
  const p = normalizeMessagePlan({ background: "x", parts: [{ rank: 1, when: "someday", who: "fax", include: "maybe" }] })!;
  eq([p.parts[0].when, p.parts[0].who, p.parts[0].include, p.parts[0].msg], ["now", "reply", "in", 1]);
});
it("咲: who は handling から写す（phone_call→phone）・2通目は電話", () => {
  const plan = alignPlanWithPriorities(normalizeMessagePlan(SAKI_RAW), SAKI_PR)!;
  eq(plan.parts.map((p) => p.who), ["aix", "phone"]);
  const s = secondMessageFromPlan(plan)!;
  eq([s.who, s.parts.map((p) => p.rank)], ["phone", [2]]);
  ok(partOutOfThisMessage(plan.parts[1]));
  const note = renderMessagePlanNote(SAKI_PR, plan);
  ok(/背景: 内覧日を決めたうえで/.test(note) && /2通目（電話）で送る＝この返信には書かない/.test(note) && /明日一番で」は書かない/.test(note), note);
});
it("てん: ピックアップの約束＋持ち込みの確認は同じ流れで1通（どちらも in）・2通目なし", () => {
  const pr = [
    { rank: 1, kind: "asked", item: "持ち込みの物件の空き", quote: "ここ空いてますか", handling: "confirm", aix: null, reason: "空きはスタッフ" },
    { rank: 2, kind: "asked", item: "他のエリアも", quote: "ミナミも見たい", handling: "confirm", aix: null, reason: "探す約束" },
  ];
  const plan = alignPlanWithPriorities(normalizeMessagePlan({ background: "物件探しの続き", parts: [{ rank: 1, include: "in", when: "now" }, { rank: 2, include: "in", when: "now" }], messages: [{ no: 1, who: "reply", ranks: [1, 2] }] }), pr)!;
  eq(secondMessageFromPlan(plan), null);
  const note = renderMessagePlanNote(pr, plan);
  ok(/1\. 聞かれた事: 「ここ空いてますか」/.test(note) && /2\. 聞かれた事: 「ミナミも見たい」/.test(note), note);
});
it("明日確かめる部品がある時だけ「明日一番」を許す・skip/later は書かない側", () => {
  const pr = [
    { rank: 1, kind: "asked", item: "駐車場の空き", quote: "駐車場空いてますか", handling: "confirm", aix: null, reason: "管理会社" },
    { rank: 2, kind: "convey", item: "前の約束の繰り返し", quote: null, handling: "skip", aix: null, reason: "もう言った" },
  ];
  const plan = alignPlanWithPriorities(normalizeMessagePlan({ background: "b", parts: [{ rank: 1, when: "next_business_day", include: "in" }, { rank: 2, include: "in" }] }), pr)!;
  ok(planHasNextBusinessDay(plan));
  eq(plan.parts[1].include, "omit");
  const note = renderMessagePlanNote(pr, plan);
  ok(/営業時間外のため明日確かめる/.test(note) && !/明日一番で」は書かない/.test(note) && /× 前の約束の繰り返し/.test(note), note);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
