// app/lib/__tests__/brain-msg-window-units.test.ts — 窓を文の通の数で数える（実行: npx tsx app/lib/__tests__/brain-msg-window-units.test.ts）
//   実物の形: 見張り 12370（前8通のうち AIX【物件ピックアップした】の画像5通・お客様の事情はその前）。名前・物件名は伏せた
import { trimByUnits, collapseAixImageBursts, isAixImageMsg, brainMsgWindowUnitsOn, type WinMsg } from "../brain-msg-window";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, d = "") => { if (ok) pass++; else { fail++; console.log(`NG ${n} ${d}`); } };
const at = (i: number) => new Date(Date.UTC(2026, 10, 8, 1, i)).toISOString();
// 古い順: お客様の事情 → こちらの返信 → AIX ピックアップ（文1＋画像5）→ お客様
const oldest: WinMsg[] = [
  { sender: "customer", text: "12月に異動で、会社の上限が8万までなんです", created_at: at(0) },
  { sender: "staff", text: "かしこまりました！！ピックアップしてお送りさせて頂きます😊！！", created_at: at(1) },
  { sender: "staff", text: "お部屋ピックアップさせて頂きました！！", is_aix_generated: true, created_at: at(2) },
  ...[3, 4, 5, 6, 7].map((i) => ({ sender: "staff", text: "[画像]", is_aix_generated: true, created_at: at(i) })),
  { sender: "customer", text: "ありがとうございます！2件目が気になります", created_at: at(8) },
];
const newest = [...oldest].reverse();
t("既定 off", !brainMsgWindowUnitsOn({}) && brainMsgWindowUnitsOn({ BRAIN_MSG_WINDOW_UNITS: "on" }));
t("AIX の画像を見分ける（お客様の画像・文は違う）", isAixImageMsg(oldest[3]) && !isAixImageMsg(oldest[2]) && !isAixImageMsg({ sender: "customer", text: "[画像]", created_at: at(0) }));
// 旧（通の数）なら窓4通で事情が落ちる。新（単位）なら 画像の束=1 で事情まで入る
const four = newest.slice(0, 5);
t("旧の5通の窓では事情が落ちる", !four.some((m) => m.text?.includes("異動")));
const units = trimByUnits(newest, 5);
t("新の5単位の窓では事情が入る", units.some((m) => m.text?.includes("異動")), JSON.stringify(units.map((m) => m.text)));
t("画像の束は全部入る（1単位）", units.filter((m) => isAixImageMsg(m)).length === 5);
const lines = collapseAixImageBursts([...units].reverse(), (m) => `[${m.sender} ${m.created_at.slice(11, 16)}] ${m.text}`, (m) => `[AIX:property_send ${m.created_at.slice(11, 16)}]`);
t("履歴では画像の束を1行に", lines.filter((l) => l.includes("物件の画像 5枚")).length === 1 && lines.length === 5, JSON.stringify(lines));
t("1枚だけの時はそのまま", collapseAixImageBursts([oldest[3]], () => "ONE", () => "HEAD")[0] === "ONE");
console.log(`brain-msg-window-units: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
