// app/lib/__tests__/check-promise-flow.test.ts — 確認の約束の流れの場面（竹内さんの4つの決め 11/25）
//   実行: npx tsx app/lib/__tests__/check-promise-flow.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPromiseFlowOf, checkPromiseFlowLine, brainCheckPromiseFlowOn } from "../check-promise-flow";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const T0 = Date.parse("2026-11-01T03:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const base = [
  { sender: "customer", text: "こちら空いてますか https://suumo.jp/chintai/bc_1/", createdAt: at(0) },
  { sender: "staff", text: "お送り頂きました物件の募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", createdAt: at(5) },
];
const f1 = checkPromiseFlowOf([...base, { sender: "customer", text: "ありがとうございます！", createdAt: at(10) }], [], T0 + 11 * 60_000);
t("① 確認の約束の後のお礼だけ → ack_wait", f1.scene === "ack_wait" && f1.checkPromised && !f1.resultSent && f1.brought24h);
const f1b = checkPromiseFlowOf([...base, { sender: "customer", text: "ありがとうございます！", createdAt: at(10) }], [{ aix_type: "property_check_result", sent_at: at(8) }], T0 + 11 * 60_000);
t("① 結果を送った後のお礼は当たらない", f1b.scene === null && f1b.resultSent);
const f2 = checkPromiseFlowOf([...base, { sender: "customer", text: "ちなみに駐車場はありますか？", createdAt: at(10) }], [], T0 + 11 * 60_000);
t("② 確認の約束の後の問い → question_after_promise", f2.scene === "question_after_promise");
const f3 = checkPromiseFlowOf([{ sender: "staff", text: "よろしくお願い致します！！", createdAt: at(-30) }, { sender: "customer", text: "この物件ありますか https://suumo.jp/chintai/bc_2/", createdAt: at(0) }], [], T0 + 60_000);
t("③ 物件を送ってきて約束なし → brought_no_promise", f3.scene === "brought_no_promise" && !f3.checkPromised);
const f4 = checkPromiseFlowOf([...base, { sender: "customer", text: "ありがとうございます。お手数をおかけしてすみません。", createdAt: at(10) }], [], T0 + 11 * 60_000);
t("④ 了承に一言足した → ack_plus", f4.scene === "ack_plus");
const f5 = checkPromiseFlowOf([{ sender: "staff", text: "確認させて頂きます！！", createdAt: at(5) }, { sender: "customer", text: "ありがとうございます！", createdAt: at(10) }], [], T0 + 11 * 60_000);
t("物件を送ってきていない会話は当たらない", f5.scene === null && !f5.brought24h);
t("材料の1行: 当たらない時は空・当たる時は竹内さんの決め", checkPromiseFlowLine(f5) === "" && checkPromiseFlowLine(f1).includes("竹内さんの決め 11/25") && checkPromiseFlowLine(f1).includes("property_check_result"));
t("スイッチ: 既定 off", !brainCheckPromiseFlowOn({}) && brainCheckPromiseFlowOn({ BRAIN_CHECK_PROMISE_FLOW: "on" }));
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: brain-core はスイッチの時だけ材料に入れる", bc.includes("cpf.brainCheckPromiseFlowOn() && !isPostApplyStatus(convStatus)") && bc.includes("materialMarks.check_promise_flow"));
console.log(`check-promise-flow: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
