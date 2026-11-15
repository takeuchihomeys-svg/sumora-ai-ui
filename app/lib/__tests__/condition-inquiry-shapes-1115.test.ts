// app/lib/__tests__/condition-inquiry-shapes-1115.test.ts — 2026-11-15 作業員K
//   実行: npx tsx app/lib/__tests__/condition-inquiry-shapes-1115.test.ts
//   実物（30日のお客様の発言で off→on で種類が変わった4通は全部「物件の質問」）と、止めてはいけない条件の言い方
import { classifyConditionTurn, gateExtractedConditions, inquiryShapes1115On } from "../condition-source-gate";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const kind = (s: string) => classifyConditionTurn(s).kind;

t("既定 on・off で戻す", inquiryShapes1115On({}) && !inquiryShapes1115On({ CONDITION_INQUIRY_SHAPES_1115: "off" }));
process.env.CONDITION_INQUIRY_SHAPES_1115 = "off";
t("off: 部屋の札は今まで通り条件", kind("Ｆ ａｓｅｃｉａ Ｒｕｍｉｎａ（3階/304/1LDK/30.58m²） こちらもお願いします！立て続けで申し訳ありません") === "condition");
process.env.CONDITION_INQUIRY_SHAPES_1115 = "on";
for (const s of [
  "Ｆ ａｓｅｃｉａ Ｒｕｍｉｎａ（3階/304/1LDK/30.58m²） こちらもお願いします！立て続けで申し訳ありません",
  "ルディシアコートの初期費用知りたいです！",
  "こちらも過去気になっていた物件です、 ①ジーメゾン角田ラシード 3階建 ②クリエオーレ吉田下島 3階建",
]) t(`on: 物件の質問 → property_inquiry「${s.slice(0, 20)}」`, kind(s) === "property_inquiry");
for (const s of ["1LDK/35㎡以上で探してます", "（1LDK/40㎡以上）が希望です", "3階/2階以上でお願いします", "家賃8万円/1K/25㎡くらい", "初期費用を知りたいです、できれば15万以内", "出来れば35㎡超えてれば嬉しいです"]) {
  t(`on: 条件は止めない「${s}」`, kind(s) !== "property_inquiry");
}
const g = gateExtractedConditions({ other_requests: "ルディシアコートの初期費用を知りたい・初期費用を抑えられる物件希望・過去気になっていた物件: ジーメゾン角田ラシード" }, classifyConditionTurn("初期費用おさえたいです"), { other_requests: "築年数は綺麗なら可" });
t("on: その他の物件の質問の節だけ落とす", g.extracted.other_requests === "初期費用を抑えられる物件希望" && g.dropped.length === 2);
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
