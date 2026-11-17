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
