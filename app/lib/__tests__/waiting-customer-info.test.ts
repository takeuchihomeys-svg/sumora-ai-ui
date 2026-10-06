// app/lib/__tests__/waiting-customer-info.test.ts — 2026-10-06 ⑫ 竹内さん「ここは移動の連絡まちの状況」（末桜 10/02 の実物）
//   実行: npx tsx app/lib/__tests__/waiting-customer-info.test.ts
import { waitingOnCustomerInfo } from "../waiting-customer-info";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const staff1 = { sender: "staff", text: "かしこまりました！！\n内覧のキャンセル承りました😊\n移動先が確定されましたら、いつでもお気軽にご連絡ください😌！！" };
const staff2 = { sender: "staff", text: "かしこまりました！！\n\n10/4の内覧をキャンセルさせて頂きます！！\n\n移動先が分かりましたら新しいエリアでもお部屋探しさせていただきますのでお気軽にお知らせください😊！！" };
t("実物: 移動先が分かりましたら…お知らせください → お詫び＋お願い は連絡待ち", waitingOnCustomerInfo([staff1, staff2, { sender: "customer", text: "すみません、お願いします😢" }]).waiting);
t("確定されましたら…ご連絡ください → ありがとうございます は連絡待ち", waitingOnCustomerInfo([staff1, { sender: "customer", text: "ありがとうございます！" }]).waiting);
t("お客様が新しい情報（エリア）を送った → 待ちではない", !waitingOnCustomerInfo([staff2, { sender: "customer", text: "移動先が梅田になりました！梅田周辺でお願いします" }]).waiting);
t("お客様が質問した → 待ちではない", !waitingOnCustomerInfo([staff2, { sender: "customer", text: "すみません、ちなみに今の物件はもう無理ですか？" }]).waiting);
t("ただの締め（ご不明点ございましたらお気軽に）→ この状態ではない", !waitingOnCustomerInfo([{ sender: "staff", text: "ご不明点ございましたらお気軽にご連絡ください😊！！" }, { sender: "customer", text: "ありがとうございます" }]).waiting);
t("最後がこちら → 対象外", !waitingOnCustomerInfo([staff2]).waiting);
console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
