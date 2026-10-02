// app/lib/__tests__/meeting-promise.test.ts — 2026-10-02 ⑫ 21巡（待ち合わせまで行く流れの実物）
//   実行: npx tsx app/lib/__tests__/meeting-promise.test.ts
import { meetingPromisePending } from "../meeting-promise";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const promise = { sender: "staff", text: "かしこまりました！！\n9/24日13:00からはよろしくお願いいたします😊！！\n\n芝犬の飼育可能か含め待ち合わせ場所追ってご連絡させていただきます！！" };
t("約束の後のお客様の返事 → 約束が残っている", meetingPromisePending([promise, { sender: "customer", text: "かしこまりました！ありがとうございます🙇‍♂️" }]));
t("約束の後に別の連絡（飼育規定）があっても残っている", meetingPromisePending([promise, { sender: "customer", text: "了解です" }, { sender: "staff", text: "3部屋それぞれのペット飼育規定確認させていただき" }, { sender: "customer", text: "ギリギリですが大丈夫です！！！" }]));
t("待ち合わせ場所を送った後 → 残っていない", !meetingPromisePending([promise, { sender: "staff", text: "待ち合わせ場所は〒550-0013 大阪市西区新町1丁目2-3 です！！" }, { sender: "customer", text: "ありがとうございます" }]));
t("最後がこちら → 対象外", !meetingPromisePending([promise]));
t("約束が無い → 対象外", !meetingPromisePending([{ sender: "staff", text: "内覧のご案内させて頂きます" }, { sender: "customer", text: "お願いします" }]));
// 2026-10-02 竹内さんの訂正「内覧日決まったら 1件目の内覧場所を集合場所とする」: 待ち合わせ場所を後で送る約束は手本にせず自動で送らない
import("../example-hygiene").then(async ({ isUsableExampleText }) => {
  const { canAutoReply } = await import("../auto-reply-policy");
  const forms = [
    "かしこまりました！！\n9/24日13:00からはよろしくお願いいたします😊！！\n芝犬の飼育可能か含め待ち合わせ場所追ってご連絡させていただきます！！",
    "はい！！\n12:00から大丈夫です！！\n待ち合わせ場所改めてお送りさせていただきます😊！！",
    "かしこまりました😊！！お部屋ご案内させて頂きます！！空室状況確認しお待ち合わせ場所とあわせてご連絡させて頂きます！！",
  ];
  for (const f of forms) {
    t(`手本にしない: ${f.slice(0, 20)}`, !isUsableExampleText(f));
    const v = canAutoReply({ autoSendEnabled: true, lastSender: "customer", replyMode: "auto_reply", suggestedAixAction: null, draft: f, draftHasBlock: false, status: "viewing", hasPendingScheduled: false });
    t(`自動で送らない: ${f.slice(0, 20)}`, !v.ok && v.reason === "meeting_place_promise");
  }
  const meet = "かしこまりました！！\n10/6（火）ご案内させて頂きます！！\n\n10/6 15:00に安立荘(アンリュウソウ) 203号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！";
  t("待ち合わせの案内そのものは手本のまま", isUsableExampleText(meet));
  console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
});
