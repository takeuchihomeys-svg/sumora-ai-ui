// 出し切りの後・持ち込みの物件＋足した条件（2026-10-28 竹内さん #24 ロト）
// 実行: npx tsx app/lib/__tests__/exhausted-brought-both.test.ts
import { exhaustedConditionTurnLine, exhaustedTodayNote, exhaustedBroughtBothEnabled } from "../ack-exhausted-reply";
import { searchExhausted, exhaustedMaterialLine } from "../search-exhausted";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const ON = { EXHAUSTED_BROUGHT_BOTH: "on" };

it("既定 on・off の時は今までの文のまま", () => {
  eq(exhaustedBroughtBothEnabled({}), true);
  const OFF = { EXHAUSTED_BROUGHT_BOTH: "off" };
  ok(/出し切りの締めにしない/.test(exhaustedConditionTurnLine(OFF)));
  eq(exhaustedTodayNote("2026-10-25T23:31:06Z", Date.parse("2026-10-26T04:31:42Z"), OFF), "");
});
it("on: 持ち込みの約束を先に＋足した条件は新着で（改めてピックアップしない）", () => {
  const t = exhaustedConditionTurnLine(ON);
  ok(/先に書く/.test(t) && /新着で募集に出次第/.test(t) && /改めてピックアップする約束にしない/.test(t) && !/出し切りの締めにしない/.test(t), t);
});
it("ロト: 印は 10/26 08:31 JST・今の番は同じ日 13:31 → 今日の注", () => {
  const n = exhaustedTodayNote("2026-10-25T23:31:06Z", Date.parse("2026-10-26T04:31:42Z"), ON);
  ok(/今日 08:31/.test(n), n);
});
it("前の日の印には今日の注を付けない", () => eq(exhaustedTodayNote("2026-10-24T23:31:06Z", Date.parse("2026-10-26T04:31:42Z"), ON), ""));

it("ロト: 最後の印が AIX の物件の送付（文なし）でも、on なら出し切ったと言った文を引く（全力サポートと書かない）", () => {
  const msgs = [
    { sender: "staff", text: "御堂筋線沿線全域からご条件に近いお部屋全てピックアップさせて頂きました！！", createdAt: "2026-10-25T23:25:22.397Z" },
    { sender: "customer", text: "出来ればカウンターキッチンが良くて、、", createdAt: "2026-10-26T03:48:11.388Z" },
  ];
  const o = { conditionChangedThisTurn: false, pickupReady: null, deliveredAixAt: ["2026-10-25T23:31:06Z"] };
  process.env.EXHAUSTED_LABEL_STRONG_TEXT = "off";
  ok(/全力サポート】）を送り/.test(exhaustedMaterialLine(searchExhausted(msgs, o))), "off は今まで通り");
  process.env.EXHAUSTED_LABEL_STRONG_TEXT = "on";
  const r = searchExhausted(msgs, o);
  eq(r.markerAt, "2026-10-25T23:31:06Z");
  ok(/御堂筋線沿線全域/.test(exhaustedMaterialLine(r)) && !/全力サポート】）を送り/.test(exhaustedMaterialLine(r)), exhaustedMaterialLine(r));
  process.env.EXHAUSTED_LABEL_STRONG_TEXT = "";
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
