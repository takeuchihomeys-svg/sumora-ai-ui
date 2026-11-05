// 実行: npx tsx app/lib/__tests__/decisions-1103.test.ts
import { closedThanksLine, layoutAskLine, farOtherFirstLine, ackPositiveApplyLine, closedThanksNoReplyOn, layoutAskTemporaryOn, farOtherFirstOn, ackPositiveApplyOn, guarantorWordingLine, guarantorWordingOn } from "../decisions-1103";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }

it("既定 off", () => { ok(!closedThanksNoReplyOn({}) && !layoutAskTemporaryOn({}) && !farOtherFirstOn({})); ok(ackPositiveApplyOn({}) && !ackPositiveApplyOn({ BRAIN_ACK_POSITIVE_APPLY: "off" }), "No.21 は 11/06 から既定 on"); });
it("No.15 締めの後のよろしくだけ", () => {
  ok(closedThanksLine("よろしくお願いします🙇‍♀️", "ご都合よろしいお日にちにお部屋ご案内させて頂きます！！何卒よろしくお願い致します！！") !== "");
  ok(closedThanksLine("ありがとうございます！", "お手隙の際にご査収ください！！") !== "");
  ok(closedThanksLine("よろしくお願いします。駐車場はありますか？", "何卒よろしくお願い致します！！") === "");
  ok(closedThanksLine("よろしくお願いします", "物件をお送りさせて頂きます") === "");
});
it("No.17 間取りを聞いただけ", () => {
  ok(layoutAskLine("1LDKのお部屋もありますか？") !== "");
  ok(layoutAskLine("2LDKで探してもらえますか？") === "");
  ok(layoutAskLine("ありがとうございます") === "");
});
it("No.19 遠い・他の候補", () => { ok(farOtherFirstLine("ちょっと場所が遠いですね") !== ""); ok(farOtherFirstLine("他の物件も見たいです") !== ""); ok(farOtherFirstLine("ここ気になります") === ""); });
it("No.21 前向きな一言", () => {
  ok(ackPositiveApplyLine({ turnText: "今日はありがとうございました！とても良かったです", afterViewing: true, afterEstimate: false }) !== "");
  ok(ackPositiveApplyLine({ turnText: "ありがとうございました", afterViewing: true, afterEstimate: false }) === "");
  ok(ackPositiveApplyLine({ turnText: "とても良かったです", afterViewing: false, afterEstimate: false }) === "");
  ok(ackPositiveApplyLine({ turnText: "良かったです。いつ入居できますか？", afterViewing: true, afterEstimate: false }) === "");
});
it("No.20 保証会社の言い方", () => {
  ok(!guarantorWordingOn({}));
  ok(guarantorWordingLine("審査に通るか不安です").includes("別の保証会社でも審査できる"));
  ok(guarantorWordingLine("保証会社はどこですか？") !== "");
  ok(guarantorWordingLine("駐車場はありますか") === "");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
