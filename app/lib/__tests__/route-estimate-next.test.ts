// app/lib/__tests__/route-estimate-next.test.ts — #804 見積の駅の次の一手を返信へ（ROUTE_ESTIMATE_NEXT_REPLY）
import assert from "node:assert/strict";
import { withEstimateNextReply, routeEstimateNextOn, ESTIMATE_NEXT_REPLY } from "../route-estimate-next";
import { locateApplyRoute, buildApplyRouteBrainText, type ApplyRouteLocation } from "../apply-route-map";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log("  OK  " + name); } catch (e) { fail++; console.log("  NG  " + name + "\n      " + (e as Error).message); } };
const est: ApplyRouteLocation = { node: "estimate", branch: null, next: { label: "ご内覧のご案内（候補日）", aix: ["viewing_invite"] } as ApplyRouteLocation["next"], wayBack: null, aim: ["申込へ誘う"], evidence: [] };
const ar = { text: buildApplyRouteBrainText(est), loc: est };

t("既定 off", () => { assert.equal(routeEstimateNextOn({}), false); assert.equal(routeEstimateNextOn({ ROUTE_ESTIMATE_NEXT_REPLY: "on" }), true); });
t("off は同じ物（文も1文字も変わらない）", () => { const r = withEstimateNextReply(ar, false); assert.equal(r.changed, false); assert.equal(r.text, ar.text); assert.equal(r.loc, ar.loc); });
t("on・見積の駅: 次の一手が返信に・合う AIX なし・日程は AIX【内覧日調整】の但し", () => {
  const r = withEstimateNextReply(ar, true);
  assert.equal(r.changed, true);
  assert.deepEqual(r.loc!.next!.aix, []);
  assert.equal(r.loc!.next!.label, ESTIMATE_NEXT_REPLY.label);
  assert.match(r.text, /返信で答える/);
  assert.doesNotMatch(r.text, /合う AIX: viewing_invite/);
});
t("決まり 59b45146 と食い違わない: 返信で候補日を伺う とは書かない", () => { assert.doesNotMatch(ESTIMATE_NEXT_REPLY.label, /返信で(?:内覧の)?候補日を伺/); assert.match(ESTIMATE_NEXT_REPLY.label, /お気に召されましたらご案内させて頂きます/); });
t("見積の駅でない・分かれ道は替えない", () => {
  const p = { ...est, node: "viewing_arrange" as ApplyRouteLocation["node"] };
  assert.equal(withEstimateNextReply({ text: "x", loc: p }, true).changed, false);
  const b = { ...est, branch: "cost_over" as unknown as ApplyRouteLocation["branch"] };
  assert.equal(withEstimateNextReply({ text: "x", loc: b }, true).changed, false);
  assert.equal(withEstimateNextReply({ text: "", loc: null }, true).changed, false);
});
void locateApplyRoute;
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
