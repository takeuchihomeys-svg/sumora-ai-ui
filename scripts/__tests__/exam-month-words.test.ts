// scripts/__tests__/exam-month-words.test.ts — 月だけの言い方の見張り
//   実行: npx tsx scripts/__tests__/exam-month-words.test.ts
import { monthWordKinds } from "../lib/exam-month-words";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("10月入居は入居", monthWordKinds("10月入居希望です").join() === "入居");
t("来月引っ越しは入居", monthWordKinds("来月引っ越し予定").join() === "入居");
t("11月に給料が入るは支払い", monthWordKinds("11月に給料が入るので").join() === "支払い");
t("日付付きは数えない", monthWordKinds("11月25日に給料が入ります・10月5日入居").length === 0);
t("関係ない月は数えない", monthWordKinds("10月は忙しいです").length === 0);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
