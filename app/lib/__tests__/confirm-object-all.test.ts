// 確認の対象を全部返す（2026-11-06 作業員9・弱い所 346・CONFIRM_OBJECT_ALL）
// 実行: npx tsx app/lib/__tests__/confirm-object-all.test.ts
import { findConfirmObject, findConfirmObjects, confirmObjectAllOn } from "../confirmation-context";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
const on = { CONFIRM_OBJECT_ALL: "on" };
const q136 = "ありがとうございます！\nちなみにこちらの物件礼金を調整することは難しいでしょうか？😣\nこちらの物件はすでに内覧済みです！\n続けてすみません…！\nこちら駐車場は敷地内まだ空きありますでしょうか？💦";
t("既定 off", !confirmObjectAllOn({}));
t("off は今まで通り（q136 は募集状況）", findConfirmObject(q136, {}) === "募集状況");
t("on: q136 は駐車場と礼金の調整（竹内さんの 8/23 20:54 と同じ）", findConfirmObject(q136, on) === "駐車場の空き状況と費用・条件交渉の可否", findConfirmObject(q136, on));
t("on: 内覧済みは内覧の可否にしない", !findConfirmObjects(q136).includes("ご内覧可否"));
t("on: 部屋の空きと駐車場 → 駐車場を先・募集状況を後ろ", findConfirmObject("この物件まだ空いてますか？駐車場もありますか", on) === "駐車場の空き状況と募集状況");
t("on: 募集状況と初期費用（竹内さんの 8/20 gm KOHAMA）", findConfirmObject("こちらの物件についても、現在空いているお部屋や初期費用をご確認いただくことは可能でしょうか", on) === "初期費用と募集状況", findConfirmObject("こちらの物件についても、現在空いているお部屋や初期費用をご確認いただくことは可能でしょうか", on));
t("on: 広告の画像の「初期費用2,980円」は拾わない", findConfirmObject("この物件空いてますか？\n【物件の画面（ポータル）】スモラなら初期費用2,980円", on) === "募集状況");
t("on: 申込の記入欄は今まで通りの1つだけ", findConfirmObject("【お申込者様記入欄】ペット 無 駐車場 有", on) === findConfirmObject("【お申込者様記入欄】ペット 無 駐車場 有", {}));
t("on: 最大3つ", findConfirmObjects("入居はいつからですか？ペットは可能ですか？駐車場はありますか？鍵の受け渡しは？初期費用も教えてください").length <= 3);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
