// app/lib/__tests__/room-photo-material.test.ts — 2026-10-07 5巡目「室内写真の依頼で手元に室内イメージがあれば AIX を直接」
// 実行: npx tsx app/lib/__tests__/room-photo-material.test.ts（実物は scripts/audit-photo-material-at-hand.ts の番）
import { photoMaterialAtHand, photoTargetsFromThread, namesInStaffText, interiorSentNames } from "../room-photo-material";
import { buildingKeyOf } from "../customer-state";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

const fb8 = [ // fb8ab8d5 09-06: 新着の🌟ララプレイス難波シェール（こちらが送った）→ スタッフは suumo の室内イメージを直接
  { sender: "staff", text: "[画像]", createdAt: "2026-09-06T07:14:00Z", isImage: true },
  { sender: "staff", text: "🌟ララプレイス難波シェール 402号室\n（オススメポイント）\n・家賃62,000円", createdAt: "2026-09-06T07:14:10Z" },
];
t("こちらが送った物件 → 手元にある", photoMaterialAtHand({ before: fb8, requestText: "こちらの物件お部屋の写真などありますか？？", targetRooms: [{ name: "ララプレイス難波シェール 402号室", sentByUs: true }] }).atHand);
// 63fa0c26 10/07 ゆなまる: お客様が先にポータルの画面を送ったシャーメゾン ソレイユ → スタッフは撮影の約束
t("お客様の持ち込み（後で見積の画像を送っていても）→ 手元にない",
  !photoMaterialAtHand({ before: fb8, requestText: "この部屋の中って写真もらう事とかってできますか？", targetRooms: [{ name: "シャーメゾン ソレイユ 202号室", sentByUs: true, broughtByCustomer: true }] }).atHand);
// ad97cd40 09-16: 建築中のお部屋（同じ行に物件名と建築中）
t("建築中の行がある物件 → 手元にない",
  !photoMaterialAtHand({ before: [{ sender: "staff", text: "アービングNeo岸里玉出は建築中のお部屋となり、内覧会が 9/18日", createdAt: "2026-09-16T09:00:00Z" }], requestText: "写真お願いできますか？", targetRooms: [{ name: "アービングNeo岸里玉出 302号室", sentByUs: true }] }).atHand);
t("別の行の「内覧会」では建築中にしない",
  photoMaterialAtHand({ before: [{ sender: "staff", text: "グリーンヒルズ 503号室\n別のマンションの内覧会は18日", createdAt: "2026-09-16T09:00:00Z" }], requestText: "ここ部屋の写真あります？", targetRooms: [{ name: "グリーンヒルズ 503号室", sentByUs: true }] }).atHand);
t("複数の物件はどれか1つでも無ければ手元にない",
  !photoMaterialAtHand({ before: [], requestText: "3つの物件を室内写真を見たいです", targetRooms: [{ name: "ライオンズマンション日本橋 215号室", sentByUs: false, broughtByCustomer: true }, { name: "PLAZA船越 301号室", sentByUs: true }] }).atHand);
t("頼まれた物件が分からない → 手元にない", !photoMaterialAtHand({ before: [], requestText: "部屋の写真をお願い致します。" }).atHand);
// 室内イメージを送った物件の名前を拾う（d46290ff 09-30 の送付の形）
const sent = [
  { sender: "staff", text: "[画像]", createdAt: "2026-09-30T07:27:05Z", isImage: true },
  { sender: "staff", text: "（室内イメージ）\nhttps://www.homes.co.jp/chintai/b-1034540271988/", createdAt: "2026-09-30T07:27:06Z" },
  { sender: "staff", text: "🌟ステラ豊中庄内 202号室\n\n敷金・礼金なしの新築のお部屋で", createdAt: "2026-09-30T07:27:07Z" },
];
t("室内イメージの直後の🌟の物件を拾う", interiorSentNames(sent).some((k) => k.includes("ステラ豊中庄内")), JSON.stringify(interiorSentNames(sent)));
t("室内イメージを送った物件 → 手元にある（持ち込みでも送り直せる）",
  photoMaterialAtHand({ before: sent, requestText: "ここの室内写真もう一回もらえますか", targetRooms: [{ name: "ステラ豊中庄内 202号室", sentByUs: false }] }).atHand);
t("名前の拾い: 【】の見出し", namesInStaffText("【エスフィールド 202号室】\n\n初期費用さらに").includes(buildingKeyOf("エスフィールド")));
// 台帳から頼まれた物件（今の番の物件が無い時は直前に動きのあった物件）
const state = {
  rooms: [
    { key: "a#202", names: ["シャーメゾン ソレイユ 202号室"], sentByUs: true, events: [{ at: "2026-10-06T10:31:00Z", kind: "customer_shared" }, { at: "2026-10-07T01:48:00Z", kind: "estimate" }] },
    { key: "b#202", names: ["Avantio Anhelo 202号室"], sentByUs: true, events: [{ at: "2026-10-06T08:41:00Z", kind: "sent" }] },
  ],
  turnTargets: [] as Array<{ roomKey: string; display: string; at: string }>,
};
const tg = photoTargetsFromThread(state, "2026-10-07T01:49:00Z");
t("台帳: 直前に動きのあった物件だけ・持ち込みの印", tg.length === 1 && tg[0].name.startsWith("シャーメゾン") && tg[0].broughtByCustomer === true, JSON.stringify(tg));
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
