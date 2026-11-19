// 2026-11-15 作業員H: ブレインが route="aix" と決めた番を聞かれた事の確認の約束（check_question）に書き換えない（TWO_STAGE_CHECK_QUESTION_KEEP_AIX・既定 off）
//   元の問題の形（試験 q411・j1115b-sit1 の答案のブレインの依頼）でのテスト。LLM も DB も使わない。
// 実行: npx tsx app/lib/__tests__/check-question-keep-aix.test.ts
import { readFileSync } from "node:fs";
import { checkQuestionKeepAixOn, brainChoseAixForQuestion, checkQuestionBrainRoute } from "../check-question-brain-first";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); } }

ok("既定 on・=off で止める（11/18）", checkQuestionKeepAixOn({}) === true && checkQuestionKeepAixOn({ TWO_STAGE_CHECK_QUESTION_KEEP_AIX: "off" }) === false);
// q411（物件確認した＋御見積書同封の後の「鍵交換代は必須ですか・しなくてもいい」→ 竹内さんは AIX【確認した】）: 当たった答案のブレインの依頼
const q411Hit = { asks: [{ quote: "鍵交換代は必須ですか", kind: "question", route: "aix", answer: null, basis: "staff_only", aix: "property_check_result" }] };
ok("q411（当たった答案）: route=aix の物件確認した → 書き換えない", brainChoseAixForQuestion({ finalAix: "property_check_result", contract: q411Hit }));
// q411 の外れた答案（ブレイン自身が約束）: 今まで通り書き換える
const q411Miss = { asks: [{ quote: "鍵交換代は必須ですか", kind: "question", route: "promise", answer: "管理会社に確認しご連絡", basis: "judgement", aix: "property_check_result" }] };
ok("q411（外れた答案）: ブレインが約束（route=promise）→ 今まで通り", !brainChoseAixForQuestion({ finalAix: "property_check_result", contract: q411Miss }));
// 守り（q177・q092 の形）: aix の欄は物件確認したでも依頼は約束 → 今まで通り
ok("守り: aix の欄だけ物件確認したで依頼が約束 → 今まで通り", !brainChoseAixForQuestion({ finalAix: "property_check_result", contract: { asks: [{ route: "promise", aix: null, answer: "空き状況を確認しご連絡" }] } }));
ok("守り: 依頼に確認の約束が混ざる（route=aix と promise の管理会社確認）→ 今まで通り", !brainChoseAixForQuestion({ finalAix: "property_check_result", contract: { asks: [{ route: "aix", aix: "property_check_result" }, { route: "promise", answer: "管理会社に確認します" }] } }));
ok("ブレインの AIX が無い番は対象外（上の brain-first の受け持ち）", !brainChoseAixForQuestion({ finalAix: null, contract: q411Hit }) && checkQuestionBrainRoute({ rawAix: "property_check_result", contract: q411Hit, promisesPickup: false }) === null);
ok("route=aix の AIX が違うボタン（内覧調整）→ 今まで通り", !brainChoseAixForQuestion({ finalAix: "property_check_result", contract: { asks: [{ route: "aix", aix: "viewing_invite" }] } }));
ok("ピッカー付きの鍵（acknowledge_check/条件）も同じボタンとして読む", brainChoseAixForQuestion({ finalAix: "acknowledge_check", contract: { asks: [{ route: "aix", aix: "acknowledge_check/mgmt_equipment" }] } }));
{
  const bc = readFileSync("app/lib/brain-core.ts", "utf8");
  ok("配線: brain-core が check_question の2段を外して AIX のまま（スイッチの時だけ）", /checkQuestionKeepAixOn\(\) && brainChoseAixForQuestion\(/.test(bc) && /check_question\)\/keep_aix/.test(bc));
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
