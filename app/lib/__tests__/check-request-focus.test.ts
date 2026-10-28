// app/lib/__tests__/check-request-focus.test.ts — 物件確認した に「この確認で頼まれた事」を渡す（実物: ayaka 10/24〜10/26）
import { checkRequestFocus, checkRequestFocusOn } from "../check-request-focus";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
const hist = [
  { sender: "staff", text: "お世話になっております！！\nお送り頂きました2件の募集状況確認いたしました！！\n〇〇は現在募集中となります！！" },
  { sender: "customer", text: "【賃貸マンション】\nProsper豊中南 304\nhttps://www.homes.co.jp/chintai/b-1354840135485/\nby LIFULL HOME'S" },
  { sender: "customer", text: "こんにちは！\nここは上の階空いてたりしますか？" },
  { sender: "staff", text: "お世話になっております！！\nお送り頂きありがとうございます！！\n\nお送り頂きましたお部屋、管理会社に募集状況確認させて頂きます！！" },
  { sender: "customer", text: "【賃貸マンション】\nアーバンパーク淡路\nhttps://www.homes.co.jp/chintai/b-1404450062684/" },
  { sender: "customer", text: "これも上の階があれば嬉しいです(嬉しい)" },
  { sender: "staff", text: "かしこまりました！！\n\nソルテラス関目高殿駅前・阪急千里線下新庄駅徒歩4分・アーバンパーク淡路の3件、上の階の空き状況も含めて管理会社に募集状況確認させて頂きます！！" },
  { sender: "customer", text: "[スタンプ]" },
];
t("既定 off", checkRequestFocusOn({}) === false && checkRequestFocusOn({ CHECK_REQUEST_FOCUS: "on" }));
const r = checkRequestFocus(hist);
t("上の階を拾う", r.keys.includes("上の階のお部屋"), r);
t("お客様の言葉と約束", /上の階空いてたり/.test(r.quote ?? "") && /上の階の空き状況も含めて/.test(r.promise ?? ""), r);
t("答え方の行（募集終了とまとめない）", /上の階のお部屋募集に出ていない状況/.test(r.line) && /言い切らない/.test(r.line), r.line);
t("前の確認の結果より前の頼みは拾わない", checkRequestFocus([{ sender: "customer", text: "上の階ありますか" }, { sender: "staff", text: "お送り頂きました物件の募集状況確認いたしました！！募集中となります！！" }, { sender: "customer", text: "ありがとうございます" }]).line === "");
t("頼みが無ければ空", checkRequestFocus([{ sender: "customer", text: "空きありますか？" }]).line === "");
t("登録のご希望の階", /2階以上/.test(checkRequestFocus([{ sender: "customer", text: "空きありますか？" }], { conditions: "エリア: 淀川区 / その他: 2階以上" }).line));
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
