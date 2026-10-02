// app/lib/__tests__/double-confirm-contact.test.ts
// 2026-10-02 「確認しご連絡」と「確認出来次第ご連絡」が1通に2回（⑫の再生・本番の AI の下書き4通）の回帰テスト
// 実行: npx tsx app/lib/__tests__/double-confirm-contact.test.ts
import { dropDoubleConfirmContact } from "../double-confirm-contact";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} -- ${extra}`); } }

const a = dropDoubleConfirmContact("はい！！\n最新の空き状況を確認しご連絡させて頂きます！！\n確認出来次第ご連絡させて頂きます！！");
t("⑫の実物: 2回目の行を落とす", a.text === "はい！！\n最新の空き状況を確認しご連絡させて頂きます！！", a.text);
const b = dropDoubleConfirmContact("はるかさん、お送り頂きありがとうございます😊！！\n確認しご連絡させて頂きます😊！！確認出来次第ご連絡させて頂きます😌！！");
t("本番の下書き: 同じ行の2回目を落とす", b.text === "はるかさん、お送り頂きありがとうございます😊！！\n確認しご連絡させて頂きます😊！！", b.text);
const c = dropDoubleConfirmContact("恋さんお世話になっております！！\n\n確認しご連絡させて頂きます😊！！\n\n確認出来次第ご連絡させて頂きます😊！！");
t("本番の下書き: 空行の後の2回目を落とす", c.text === "恋さんお世話になっております！！\n\n確認しご連絡させて頂きます😊！！", c.text);
const keep1 = "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます😊！！\n確認出来次第ご連絡させて頂きます！！";
t("スタッフの形（確認させて頂きます＋確認出来次第）は変えない", dropDoubleConfirmContact(keep1).removed.length === 0);
const keep2 = "内容を確認しご連絡させて頂きます😊！！\n本日、管理会社の営業開始後に確認し、確認出来次第ご連絡させて頂きます！！";
t("中身のある文（営業開始後に確認し、確認出来次第）は落とさない", dropDoubleConfirmContact(keep2).removed.length === 0);
const keep3 = "確認しご連絡させて頂きます！！\n確認出来次第ご連絡させて頂きますので、何卒よろしくお願い致します！！";
t("「ので、何卒」に続く形は落とさない", dropDoubleConfirmContact(keep3).removed.length === 0);

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
