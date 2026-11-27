// app/lib/__tests__/route-move-in-later-split.test.ts — #737 入居時期が先の次の一手を入居までの日数で2つに（竹内さんの決定 11/28・110日）
import assert from "node:assert/strict";
import { withMoveInLaterSplit, routeMoveInLaterSplitOn, moveInLaterNextOf, MOVE_IN_SEARCH_NOW_NEXT, MOVE_IN_TELL_WHEN_NEXT } from "../route-move-in-later-split";
import { MOVE_IN_SEARCH_NOW_DAYS } from "../time-map";
import { buildApplyRouteBrainText, type ApplyRouteLocation } from "../apply-route-map";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log("  OK  " + name); } catch (e) { fail++; console.log("  NG  " + name + "\n      " + (e as Error).message); } };
const loc: ApplyRouteLocation = { node: "hearing", branch: "move_in_later", next: { label: "申込の時期を逆算して伝え、再開の時期を約束する", aix: [] } as ApplyRouteLocation["next"], wayBack: null, aim: ["関係をつなぐ"], evidence: [] } as ApplyRouteLocation;
const ar = { text: buildApplyRouteBrainText(loc), loc };

t("線は1か所（110日）", () => assert.equal(MOVE_IN_SEARCH_NOW_DAYS, 110));
t("既定 off", () => { assert.equal(routeMoveInLaterSplitOn({}), false); assert.equal(routeMoveInLaterSplitOn({ ROUTE_MOVE_IN_LATER_SPLIT: "on" }), true); });
t("off は同じ物", () => { const r = withMoveInLaterSplit(ar, false, 40); assert.equal(r.mark, 0); assert.equal(r.text, ar.text); });
t("竹内さんの番の日数で: 34〜108日は今から探す・112〜157日は時期の約束・分からないは今から探す", () => {
  for (const d of [34, 38, 41, 57, 61, 108, 110]) assert.equal(moveInLaterNextOf(d), MOVE_IN_SEARCH_NOW_NEXT, String(d));
  for (const d of [111, 112, 113, 157]) assert.equal(moveInLaterNextOf(d), MOVE_IN_TELL_WHEN_NEXT, String(d));
  assert.equal(moveInLaterNextOf(null), MOVE_IN_SEARCH_NOW_NEXT);
});
t("on: 今から探すは物件ピックアップした・時期の約束は AIX なし・印 1/2", () => {
  const a = withMoveInLaterSplit(ar, true, 40); assert.equal(a.mark, 1); assert.deepEqual(a.loc!.next!.aix, ["property_send"]); assert.match(a.text, /今から探してお送りする約束/);
  const b = withMoveInLaterSplit(ar, true, 150); assert.equal(b.mark, 2); assert.deepEqual(b.loc!.next!.aix, []); assert.match(b.text, /探し始める時期を約束/);
});
t("分かれ道が move_in_later でない時は替えない", () => {
  assert.equal(withMoveInLaterSplit({ text: "x", loc: { ...loc, branch: null } }, true, 40).mark, 0);
  assert.equal(withMoveInLaterSplit({ text: "", loc: null }, true, 40).mark, 0);
});
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
