// app/lib/__tests__/property-key.test.ts — 物件・お部屋の1つの鍵
//   実行: npx tsx app/lib/__tests__/property-key.test.ts
import { unifiedRoomKey, propertyKey, propertyKeyMode, unifiedRoomOr } from "../property-key";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}  → ${String((globalThis as { last?: unknown }).last)}`); } };
const R = (s: string | null) => unifiedRoomKey(s);
t("0403・403号室・４０３ は同じ", R("0403") === "403" && R("403号室") === "403" && R("４０３") === "403" && R("403号") === "403");
t("英字は落とさない（A0205 と B0205 は別）", R("A0205") === "A205" && R("B0205") === "B205");
t("005A と 005B は別・頭の0は外す", R("005A") === "5A" && R("005B") === "5B");
t("ハイフンを揃える", R("B－0101") === "B-101" && R("B-101") === "B-101");
t("全部 0 は潰さない（0 は 0）", R("000") === "0");
t("数字が無い・長い・読めない物は null", R("角部屋") === null && R("123456789") === null && R("") === null && R(null) === null && R("3階") === null);
t("間取りは号室にしない・頭の間取りと階は外す", R("1LDK") === null && R("1K") === null && R("2SLDK") === null && R("1R") === null && R("1K 202") === "202" && R("1階 102") === "102");
t("小文字の英字は大文字", R("a101") === "A101");
t("鍵: 建物の表記ゆれと号室", propertyKey("【1🌟】セレニティ 照ヶ丘", "0303号室") === propertyKey("セレニティ照ヶ丘", "303"));
t("号室が無ければ建物だけ", !String(propertyKey("セレニティ照ヶ丘", null)).includes("|"));
t("建物が短すぎれば null", propertyKey("A", "101") === null);
t("既定は shadow（記録だけ）", propertyKeyMode({}) === "shadow" && propertyKeyMode({ PROPERTY_KEY_UNIFIED: "on" }) === "on" && propertyKeyMode({ PROPERTY_KEY_UNIFIED: "off" }) === "off");
t("shadow は古い答えのまま", unifiedRoomOr("t", "A0205", "205") === "205");
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
