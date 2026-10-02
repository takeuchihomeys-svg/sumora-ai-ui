// app/lib/__tests__/fabricated-customer-words.test.ts
// 2026-10-02 最終チェックの1回目がお客様自身の言葉の復唱を「捏造」とした穴の回帰テスト（実物: d416295c 9/23・ac7c7fd3 10/02・⑫の再生）
// 実行: npx tsx app/lib/__tests__/fabricated-customer-words.test.ts
import { evidenceFromCustomer, isCustomerEchoFabrication } from "../fabricated-customer-words";

let pass = 0, fail = 0;
function t(name: string, cond: boolean) { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } }

const cust1 = "娘の一人暮らし用の賃貸マンションを探しています。\n【希望条件】\n・西九条駅から徒歩3分以内\n・家賃＋管理費で月7万円程度\n・女性の一人暮らし";
t("d416295c: 西九条駅・7万円の復唱 → 外す", isCustomerEchoFabrication("FABRICATED_PROPERTY", "西九条駅から徒歩3分以内・家賃管理費込み7万円程度", [cust1]));
t("ac7c7fd3: 管理費込み10万まで → 外す", isCustomerEchoFabrication("FABRICATED_AMOUNT", "管理費込み10万まで", ["②【ご希望の家賃（◯万円〜◯万円）】⇒管理費込み10万まで"]));
t("⑫: 家賃6万まで（登録は5〜8万）→ 外す", isCustomerEchoFabrication("FABRICATED_AMOUNT", "家賃6万円以内", ["やっぱり家賃6万までにしたいです"]));
t("652d039f: フォームの「⇒9-12」と下書きの「家賃9〜12万円」→ 外す", isCustomerEchoFabrication("FABRICATED_AMOUNT", "家賃9〜12万円", ["（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒10月下旬\n②【ご希望の家賃（◯万円〜◯万円）】⇒9-12\n③【希望の広さ・間取り】⇒32-45"]));
t("フォームの他の欄の数（広さ 32-45）は家賃にしない", !isCustomerEchoFabrication("FABRICATED_AMOUNT", "家賃32〜45万円", ["②【ご希望の家賃（◯万円〜◯万円）】⇒9-12\n③【希望の広さ・間取り】⇒32-45"]));
t("70,000円 と 7万 は同じ", evidenceFromCustomer("家賃70,000円", ["7万くらいで"]));
t("別の金額は残す（8万）", !isCustomerEchoFabrication("FABRICATED_AMOUNT", "家賃8万円台の物件もご紹介できます", ["家賃6万まで"]));
t("号室の写し間違いは残す（503 と 502）", !isCustomerEchoFabrication("FABRICATED_PROPERTY", "エクセレント目黒503号室", ["エクセレント目黒502号室が気になります"]));
t("お客様が言っていない駅は残す", !isCustomerEchoFabrication("FABRICATED_PROPERTY", "梅田駅から徒歩5分", ["難波駅の近くがいいです"]));
t("金額も名前も取れない引用は外さない", !isCustomerEchoFabrication("FABRICATED_AMOUNT", "最大限割引させて頂きます", ["安くしてほしい"]));
t("空き状況・日付は対象外", !isCustomerEchoFabrication("FABRICATED_AVAILABILITY", "西九条駅", [cust1]));

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
