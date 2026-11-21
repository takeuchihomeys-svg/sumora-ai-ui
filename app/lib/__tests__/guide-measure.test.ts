// npx tsx app/lib/__tests__/guide-measure.test.ts
// 2026-11-18 作業員L: 誘導の物差し（竹内さん本人の番・一手の前と後の駅・進んだ／止まった／戻った／離れた）
import assert from "node:assert/strict";
import { guideTurnsOf, guideTable, reactionTable, closeKindOf, nodeOfStage } from "../../../scripts/lib/guide-measure";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h)).toISOString();

t("締めの型", () => {
  assert.equal(closeKindOf("お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます"), "invite_viewing");
  assert.equal(closeKindOf("お申込みでお部屋抑えさせていただきます"), "invite_apply");
  assert.equal(closeKindOf("確認出来次第ご連絡させて頂きます"), "promise");
  assert.equal(nodeOfStage("estimate_sent"), "estimate");
});
t("番ごと: 返事の後の駅で 進んだ・止まった・離れた（48時間）・申込以降は外す・AIX の番は AIX の種類", () => {
  const msgs = [
    { sender: "customer", text: "見積お願いします", created_at: at(0) },
    { sender: "staff", text: "かしこまりました", created_at: at(1), staff_writer: "takeuchi" },
    { sender: "customer", text: "内覧したいです", created_at: at(3) },
    { sender: "staff", text: "ご都合よろしいお日にちございますでしょうか？", created_at: at(4), staff_writer: "takeuchi" },
    { sender: "customer", text: "ありがとうございます", created_at: at(5) },
    { sender: "staff", text: "ごゆっくりご検討ください", created_at: at(6), staff_writer: "employee" },
    { sender: "customer", text: "検討します", created_at: at(7) },
    { sender: "staff", text: "お気軽にご連絡ください", created_at: at(8), staff_writer: "takeuchi" },
  ];
  const aix = [{ aix_type: "estimate_sheet", sent_at: at(2), created_at: at(2) }];
  const ds = [{ created_at: at(0.5), stage: "interested" }, { created_at: at(3.5), stage: "estimate_sent" }, { created_at: at(5.5), stage: "viewing_arranging" }, { created_at: at(7.5), stage: "viewing_arranging" }];
  const r = guideTurnsOf("c1", msgs, aix, ds);
  assert.deepEqual(r.map((x) => `${x.act}:${x.before}->${x.after}:${x.outcome}:${x.reply}`), [
    "aix:estimate_sheet:interested->estimate:advanced:proceed",
    "reply:ask_schedule:estimate->viewing_arrange:advanced:thanks",
    "reply:wait:viewing_arrange->viewing_arrange:left:silent",
  ]);
  const tab = guideTable(r);
  assert.equal(tab.get("interested|aix:estimate_sheet|*")!.advanced, 1);
  assert.equal(tab.get("interested|aix:estimate_sheet|*")!.few, true);
  assert.deepEqual(reactionTable(r).get("reply:wait"), { silent: 1 });
  const applying = guideTurnsOf("c2", msgs.slice(0, 3), [], [{ created_at: at(0.5), stage: "applying" }]);
  assert.equal(applying.length, 0);
});
console.log(`${n} tests ok`);

import { estimateRecordsBlock, estimateRecordsBlockOn } from "../estimate-records-block";
t("送った御見積書の記録: 新しい順・同じ物件の出し直しは前の金額も・名前の無い行は落とす", () => {
  assert.equal(estimateRecordsBlockOn({}), true); // 2026-11-21 既定 on
  assert.equal(estimateRecordsBlockOn({ BRAIN_ESTIMATE_RECORDS: "off" }), false);
  const b = estimateRecordsBlock([
    { property_name: "Aマンション", room_no: "101号室", initial_cost_yen: 180000, created_at: "2026-11-10T03:00:00Z" },
    { property_name: "Aマンション", room_no: "101", initial_cost_yen: 220000, created_at: "2026-11-08T03:00:00Z" },
    { property_name: "Bハイツ", room_no: null, initial_cost_yen: "150,000", created_at: "2026-11-09T03:00:00Z" },
    { property_name: "", room_no: "1", initial_cost_yen: 1, created_at: "2026-11-09T03:00:00Z" },
  ]);
  assert.match(b, /- Aマンション 101号室: 11\/10送付・初期費用 180,000円（前の見積: 11\/8 220,000円）/);
  assert.match(b, /- Bハイツ: 11\/9送付・初期費用 150,000円/);
  assert.equal(estimateRecordsBlock([]), "");
});
console.log("estimate-records ok");

import { matchCompanyFacts } from "../company-facts";
import { estimateSentFlagOf } from "../estimate-sent-flag";
t("キャンセルの網: 申込の段の「辞退」だけ当てる（申込の前の物件のお断りは当てない）・既定 off", () => {
  const had = process.env.COMPANY_FACT_CANCEL_WIDE;
  try {
    delete process.env.COMPANY_FACT_CANCEL_WIDE;
    assert.ok(!matchCompanyFacts("申込を辞退したいです", { applying: true }).some((f) => f.id === "cancel"));
    process.env.COMPANY_FACT_CANCEL_WIDE = "on";
    assert.ok(matchCompanyFacts("申込を辞退したいです", { applying: true }).some((f) => f.id === "cancel"));
    assert.ok(!matchCompanyFacts("この物件はお断りして他を探したいです", { applying: false }).some((f) => f.id === "cancel"));
    assert.ok(matchCompanyFacts("キャンセル料はかかりますか", {}).some((f) => f.id === "cancel"));
  } finally { if (had === undefined) delete process.env.COMPANY_FACT_CANCEL_WIDE; else process.env.COMPANY_FACT_CANCEL_WIDE = had; }
});
t("見積書の AIX の印（AIX_ESTIMATE_SHEET_FLAG・既定 on）", () => {
  assert.equal(estimateSentFlagOf("estimate_sheet", null, {}), true); assert.equal(estimateSentFlagOf("estimate_sheet", null, { AIX_ESTIMATE_SHEET_FLAG: "off" }), false);
  assert.equal(estimateSentFlagOf("estimate_sheet", null, { AIX_ESTIMATE_SHEET_FLAG: "on" }), true);
  assert.equal(estimateSentFlagOf("property_check_result", true, {}), true);
  assert.equal(estimateSentFlagOf("property_send", null, { AIX_ESTIMATE_SHEET_FLAG: "on" }), false);
});
console.log("cancel-estflag ok");
import { cancelWideOnlyHit, companyFactCancelWideMode } from "../company-facts";
t("キャンセルの網の shadow: 既定 shadow・申込の段で広げた網だけに当たった時だけ記録", () => {
  assert.equal(companyFactCancelWideMode({}), "shadow");
  assert.equal(cancelWideOnlyHit("申込を辞退したいです", true), true);
  assert.equal(cancelWideOnlyHit("申込を辞退したいです", false), false);
  assert.equal(cancelWideOnlyHit("キャンセル料はかかりますか", true), false); // 今の網に当たる＝記録しない
});
console.log("cancel-shadow ok");
// 2026-11-21 作業員L（#414 の掘り・統括役の決め）: 物件提案中に送った物件へ質問が返る番は「止まった」でなく engaged
t("提案中に質問が返る番は engaged（止まったと分ける）", () => {
  const msgs = [
    { sender: "customer", text: "他にもありますか", created_at: at(1) },
    { sender: "staff", text: "ご条件でピックアップしてお送りさせて頂きます！！", created_at: at(2), staff_writer: "takeuchi", is_aix_generated: false },
    { sender: "customer", text: "この部屋は駐車場ありますか？", created_at: at(5) },
  ];
  const ds = [{ created_at: at(1.5), stage: "proposing" }, { created_at: at(5.5), stage: "proposing" }];
  const [g] = guideTurnsOf("c1", msgs, [], ds);
  assert.equal(g.outcome, "engaged");
  const [s] = guideTurnsOf("c2", [...msgs.slice(0, 2), { sender: "customer", text: "了解です", created_at: at(5) }], [], ds);
  assert.equal(s.outcome, "stuck");
  assert.equal(guideTable([g]).get("proposing|reply:promise|*")?.engaged, 1);
});
console.log("guide-engaged ok");
