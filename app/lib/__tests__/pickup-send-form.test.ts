// app/lib/__tests__/pickup-send-form.test.ts — 物件ピックアップした の竹内さんの型（#17 ロト・#39/#40 前田）
import { customerAreaAsk, pickupSendFormNote, pickupSendForm1028On } from "../pickup-focus";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
t("既定 off", pickupSendForm1028On({}) === false && pickupSendForm1028On({ PICKUP_SEND_FORM_1028: "on" }));
t("御堂筋沿線の問い", customerAreaAsk(["ありがとうございます", "御堂筋沿線で無いですか？"]) === "御堂筋沿線", customerAreaAsk(["御堂筋沿線で無いですか？"]));
t("〇〇線沿い", customerAreaAsk(["谷町線沿いでお願いします"]) === "谷町線沿い");
t("問いが無い", customerAreaAsk(["よろしくお願いします"]) === null);
const n = pickupSendFormNote({ recentCustomerTexts: ["御堂筋沿線で無いですか？"] });
t("その言葉で答える・駅名を並べない", /御堂筋沿線全域から/.test(n) && /駅名を並べない/.test(n), n);
t("お詫び・ご納得の前置きを書かない", /ご納得頂けるまで/.test(n) && /書かない/.test(n));
t("合わない点を正直に先に", /御座いませんが/.test(n));
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
