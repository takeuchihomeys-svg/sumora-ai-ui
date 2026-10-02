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
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
