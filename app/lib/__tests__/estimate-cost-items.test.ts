// 2026-11-26 作業員L（台帳 #798 ②・統括役の決め 案A）: 初期費用の内訳（estimate_records.cost_items・items_source）
// 実行: npx tsx app/lib/__tests__/estimate-cost-items.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { costItemsFromNote, costItemsFromText, costItemsForRecord, estimateRecordCostItemsOn } from "../estimate-record-items";
import { costItemsText, estimateItemsOn, estimateRecordsBlock, intakeEstimateLine } from "../estimate-records-block";

// 書く側（AIX の記録から決まった計算で）
const note = "Aハイツ 301 / 初期費用合計: 250,000円 / 割引額: 30,000円 / 一般業者との差額（節約額）: 40,000円 / 家賃: 70,000円 / 高額項目: 礼金140,000円 / クリーニング費用: 33,000円（契約時に必要）";
assert.deepEqual(costItemsFromNote(note), [{ label: "礼金", yen: 140000 }, { label: "クリーニング費用", yen: 33000 }], "高額項目とクリーニング費用・合計や割引や家賃は内訳にしない");
assert.deepEqual(costItemsFromText("お見積もりです\n初期費用: 250,000円\n・礼金：70,000円\n・仲介手数料: 38,500円\n家賃: 70,000円"), [{ label: "礼金", yen: 70000 }, { label: "仲介手数料", yen: 38500 }]);
assert.deepEqual(costItemsForRecord({ index: 0, source: "cost_notes" }, { aixType: "estimate_sheet", generatedText: "", propCostNotes: [note] }, 1)?.source, "cost_notes");
assert.equal(costItemsForRecord({ index: 0, source: "aix_text" }, { aixType: "estimate_sheet", generatedText: "礼金: 70,000円" }, 2), null, "本文の行は物件が1件の時だけ");
assert.equal(costItemsForRecord({ index: 0, source: "aix_no_items" }, { aixType: "estimate_sheet", generatedText: "お送りします" }, 1), null);
assert.equal(estimateRecordCostItemsOn({}), false, "書くのは既定 off（列を当てた後に on）");
// 読む側
assert.equal(estimateItemsOn({}), false, "読むのは既定 off");
assert.equal(costItemsText([{ label: "礼金", yen: 70000 }, { label: "仲介", yen: 77000 }], "cost_notes"), "内訳（記録の分） 仲介 77,000円・礼金 70,000円");
assert.equal(costItemsText([{ label: "敷金", yen: 70000 }], "tool"), "内訳 敷金 70,000円");
assert.equal(costItemsText("壊れた", null), "");
const rows = [{ property_name: "Aハイツ", room_no: "301", initial_cost_yen: 250000, discount_yen: 30000, created_at: "2026-11-20T03:00:00Z", cost_items: [{ label: "礼金", yen: 140000 }], items_source: "cost_notes" }];
assert.ok(!estimateRecordsBlock(rows, 6, {}).includes("内訳"), "off は今と同じ");
assert.match(estimateRecordsBlock(rows, 6, { BRAIN_ESTIMATE_ITEMS: "on" }), /初期費用 250,000円・内訳（記録の分） 礼金 140,000円/);
assert.ok(!intakeEstimateLine(rows, [], Date.parse("2026-11-26T03:00:00Z")).includes("内訳"));
assert.match(intakeEstimateLine(rows, [], Date.parse("2026-11-26T03:00:00Z"), { BRAIN_ESTIMATE_ITEMS: "on" }), /割引 30,000円・内訳（記録の分） 礼金 140,000円/);
// 列（絶対ルール: migrate-schema も同時に）・列は on の時だけ select
const ms = readFileSync(join(__dirname, "../../api/migrate-schema/route.ts"), "utf8");
assert.ok(ms.includes("ALTER TABLE estimate_records ADD COLUMN IF NOT EXISTS cost_items JSONB;") && ms.includes("ALTER TABLE estimate_records ADD COLUMN IF NOT EXISTS items_source TEXT;"));
const core = readFileSync(join(__dirname, "../brain-core.ts"), "utf8");
assert.equal((core.match(/erb\.estimateItemsOn\(\) \? ", cost_items, items_source" : ""/g) ?? []).length, 2, "ブレインと入口の読みは on の時だけ列を読む");
const srv = readFileSync(join(__dirname, "../estimate-profit-server.ts"), "utf8");
assert.ok(/estimateRecordCostItemsOn\(\) \? /.test(srv), "書くのも on の時だけ");
console.log("estimate-cost-items ok 17");
