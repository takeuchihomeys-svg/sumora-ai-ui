// 他社の見積書の表の形（2026-11-21 作業員G・ESTIMATE_TABLE_PARSE・既定 off）
// 実行: npx tsx app/lib/__tests__/estimate-table-parse.test.ts
import { estimateFactsFromTranscript, estimateTableParseOn } from "../customer-image-link";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
// 実物の形（数字・見出しだけ。物件名・会社名・宛名は作り物）
const table = ["概算見積書", "テスト様", "物件名: テストレジデンス", "初期費用詳細内訳", "項目名 | 金額", "賃料(当月)| 106,000円", "管理費・共益費(当月)| 15,000円", "敷金 | 0円", "礼金 | 0円", "仲介会社関連費用 | 96,800円", "鍵作業費用(税込) | 0円", "家賃保証(2年)| 17,080円", "初期費用詳細合計額: 135,780円", "テスト不動産"].join("\n");
const plain = ["御見積書", "株式会社テスト不動産", "敷金 0", "礼金 70,000", "仲介手数料 77,000", "保証会社 35,000", "合計 250,000"].join("\n");
t("既定 on（11/21）・=off で止める", estimateTableParseOn({}) && !estimateTableParseOn({ ESTIMATE_TABLE_PARSE: "off" }));
process.env.ESTIMATE_TABLE_PARSE = "off";
t("off: 表の形は今まで通り取れない", estimateFactsFromTranscript(table) === null);
const p0 = JSON.stringify(estimateFactsFromTranscript(plain));
process.env.ESTIMATE_TABLE_PARSE = "on";
const e = estimateFactsFromTranscript(table);
t("on: 表の形の内訳と合計額", !!e && e.items.deposit === 0 && e.items.key_money === 0 && e.items.brokerage === 96800 && e.items.guarantee === 17080 && e.items.total === 135780, e);
t("on: 今取れている形は変わらない", JSON.stringify(estimateFactsFromTranscript(plain)) === p0);
t("on: 契約条件の紙（見積の語なし）は見積書にしない", estimateFactsFromTranscript(["物件名 テスト", "<契約条件>", "敷 金 58,000", "礼 金 58,000", "家 賃 62,000"].join("\n")) === null);
delete process.env.ESTIMATE_TABLE_PARSE;
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
