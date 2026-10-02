// app/lib/__tests__/rent-question.test.ts — 2026-10-02 ⑫ 相場の質問の見分けと返信への材料（実行: npx tsx app/lib/__tests__/rent-question.test.ts）
import { customerAsksRentLevel, buildRentMarketNote } from "../rent-question";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
for (const s of ["ペットおっけ、8.5までの家賃で1dkはやっぱりないですよね💦", "旭区の1LDKの家賃相場教えてください。", "この間取りで8万台は中々ないですよね(だよね)多少中心から外れても、、って感じなんですが", "ちなみに14万以下で2LDKないですか？ 中央区と浪速区で"]) t(`相場の質問: ${s.slice(0, 20)}`, customerAsksRentLevel(s));
for (const s of ["①11月以降 ②9万まで ③1LDK ④築5年まで ⑤桜川周辺", "家賃の支払いの案内や火災保険の支払いの仕方がわからないのですが", "こちら空いてますか？", "家賃は少しでもお安く出来ないですか？"]) t(`相場の質問ではない: ${s.slice(0, 20)}`, !customerAsksRentLevel(s));
const note = buildRentMarketNote({ area: "なんば", facts: ["なんばの1DKで8.5万以内（12件）の築年の中央値は38年"], sentences: ["なんば周辺の1DKの家賃相場は8万円から10万円程となります！！"] });
t("材料の文はそのまま渡す", note.includes("「なんば周辺の1DKの家賃相場は8万円から10万円程となります！！」"));
t("事実の数字はお客様に書かない", /ここの数字はお客様に書かない/.test(note));
t("材料が無ければ空", buildRentMarketNote(null) === "");
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
