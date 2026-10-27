// 確定の後の別の日の打診（2026-10-28 番 6613）。実物の言い方そのまま（名前は伏せた）
// 実行: npx tsx app/lib/__tests__/viewing-alt-days.test.ts
import { altDaysOfCustomerText, viewingAltDaysEnabled, buildViewingFlowBrainText, EMPTY_VIEWING_FLOW } from "../viewing-flow";
import { viewingInviteToReply } from "../turn-route-guards";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const AT = Date.parse("2026-10-23T03:30:00Z");
const withEnv = (v: string | undefined, fn: () => void) => { const o = process.env.VIEWING_ALT_DAYS_AFTER_CONFIRM; if (v == null) delete process.env.VIEWING_ALT_DAYS_AFTER_CONFIRM; else process.env.VIEWING_ALT_DAYS_AFTER_CONFIRM = v; try { fn(); } finally { if (o == null) delete process.env.VIEWING_ALT_DAYS_AFTER_CONFIRM; else process.env.VIEWING_ALT_DAYS_AFTER_CONFIRM = o; } };

console.log("切替（既定 off）");
it("既定 off・on で入る", () => { eq(viewingAltDaysEnabled({}), false); eq(viewingAltDaysEnabled({ VIEWING_ALT_DAYS_AFTER_CONFIRM: "on" }), true); });

console.log("別の日の打診を読む（番 6613 の実物）");
it("「内見24か25でも可能なんですがいかがでしょうか」→ 10/24・10/25", () => eq(altDaysOfCustomerText("お世話になっております！ 内見24か25でも可能なんですがいかがでしょうか？🥹", AT), ["10/24", "10/25"]));
it("「24は19時までなら大丈夫なのですが」→ 10/24", () => eq(altDaysOfCustomerText("24は19時までなら大丈夫なのですが...🥹", AT), ["10/24"]));
it("「お忙しければ28で構いません」→ 10/28（確定の日と同じなら呼ぶ側で外す）", () => eq(altDaysOfCustomerText("追記です いきなりだったのでお忙しければ28で構いません！", AT), ["10/28"]));
it("実データ: 「20日もしくは19日に内覧したいです」→ 2つ", () => eq(altDaysOfCustomerText("エクセランス梅田西は、初期費用が用意出来るかなのですが、20日もしくは19日に内覧したいです。", AT).sort(), ["11/19", "11/20"], "今日より前の日は翌月"));

console.log("読まない");
it("了承だけ・人数・入居の日は読まない", () => {
  eq(altDaysOfCustomerText("ありがとうございます 大丈夫です！お願いします！", AT), []);
  eq(altDaysOfCustomerText("3人で行きます", AT), []);
  eq(altDaysOfCustomerText("入居は25日か26日で考えています", AT), []);
});

console.log("ブレインの材料・下げる歯止め");
it("材料の行: 確定の後の別の日の打診（決めるのはブレイン・確定の日時を言い切らない）", () => {
  const t = buildViewingFlowBrainText({ ...EMPTY_VIEWING_FLOW, stage: "confirmed", confirmed: true, label: "10/28 17:00", altDaysAfterConfirm: ["10/24", "10/25"] });
  ok(/別の日を打診している（10\/24・10\/25）/.test(t), t); ok(/会話を読んで決める/.test(t), t);
  eq(/別の日を打診/.test(buildViewingFlowBrainText({ ...EMPTY_VIEWING_FLOW, stage: "confirmed", confirmed: true, label: "10/28 17:00" })), false, "無い時は今と同じ");
});
it("off: 決まった内覧の後の「24か25でも可能」はブレインの AIX【内覧調整】を返信に下げる（今まで通り）", () => withEnv(undefined, () => {
  eq(viewingInviteToReply({ text: "内見24か25でも可能なんですがいかがでしょうか？", viewingDecided: true }).yes, true);
}));
it("on: 別の日の打診がある時は下げない（ブレインの判断のまま）・打診が無い追加は今まで通り下げる", () => withEnv("on", () => {
  eq(viewingInviteToReply({ text: "内見24か25でも可能なんですがいかがでしょうか？", viewingDecided: true }).yes, false);
  eq(viewingInviteToReply({ text: "当日もう1件見たいです", viewingDecided: true }).yes, true);
}));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
