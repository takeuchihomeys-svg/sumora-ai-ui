// 確認の「いつ」の線（2026-10-28 竹内さん #26 #28）
// 実行: npx tsx app/lib/__tests__/mgmt-hours-split.test.ts
import { mgmtHoursSplitEnabled, isVacancyConfirmObject, COMPANY_CLOSE_HOUR, mgmtNightClosingOn, nightMgmtClosingLine, mgmtNightBrainNoteOn, nightMgmtBrainNote, mgmtNightPickerNoteOn, nightPickerLine, mgmtNightFcTomorrowOn, mgmtNightFcTomorrowNote } from "../mgmt-hours-split";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

it("既定 on・off で止める（2026-11-05）", () => { eq(mgmtHoursSplitEnabled({}), true); eq(mgmtHoursSplitEnabled({ MGMT_HOURS_SPLIT_1028: "on" }), true); eq(mgmtHoursSplitEnabled({ MGMT_HOURS_SPLIT_1028: "off" }), false); });
it("#28 あかり: 募集状況・空室・空き ＝ 弊社の時間で確かめられる", () => { for (const o of ["募集状況", "2件の募集状況", "空室", "空き状況"]) eq(isVacancyConfirmObject(o), true, o); });
it("#26 Ryoichi: 駐車場・鍵交換・ペット・交渉 ＝ 管理会社の確認（明日）", () => { for (const o of ["駐車場の空き状況", "鍵交換代", "ペット可否", "礼金の交渉", "入居可能日", ""]) eq(isVacancyConfirmObject(o), false, o); });
it("弊社の営業の終わりは 21時（確かめ待ち）", () => eq(COMPANY_CLOSE_HOUR, 21));

// 2026-11-05 作業員9（弱い所 324・q136＝8/23 20:38 の番）: 夜の管理会社への確認の結びに「明日」
it("夜の結び: 既定 off", () => { eq(mgmtNightClosingOn({}), false); eq(mgmtNightClosingOn({ MGMT_NIGHT_CLOSING: "on" }), true); });
it("夜の結び: 20時の礼金と駐車場（q136）→ 明日を入れる", () => { const l = nightMgmtClosingLine({ hour: 20, saturday: false, allowed: true, object: "礼金の調整と駐車場の空き状況", splitOn: true }); eq(!!l && l.includes("礼金の調整と駐車場の空き状況につきまして、本日管理会社営業時間外の為明日確認させて頂き、") && l.includes("別々の文に書かない"), true, String(l)); });
it("夜の結び: 募集状況だけで21時より前は入れない（10/28）", () => eq(nightMgmtClosingLine({ hour: 19, saturday: false, allowed: true, object: "お送り頂いた物件の募集状況", splitOn: true }), null));
it("夜の結び: 募集状況でも21時以降は入れる（10/29 22:05 の竹内さん）", () => eq(!!nightMgmtClosingLine({ hour: 22, saturday: false, allowed: true, object: "お送り頂いた物件の募集状況", splitOn: true }), true));
it("夜の結び: 昼・土日・確認の約束が無い番は入れない", () => { eq(nightMgmtClosingLine({ hour: 14, saturday: false, allowed: true, object: "駐車場", splitOn: true }), null); eq(nightMgmtClosingLine({ hour: 20, saturday: true, allowed: true, object: "駐車場", splitOn: true }), null); eq(nightMgmtClosingLine({ hour: 20, saturday: false, allowed: false, object: "駐車場", splitOn: true }), null); });

it("夜の結び: object が募集状況でもお客様が礼金・駐車場を聞いたら管理会社への確認（試験 q136 の実物）", () => { const l = nightMgmtClosingLine({ hour: 20, saturday: false, allowed: true, object: "募集状況", splitOn: true, topicText: "ちなみにこちらの物件礼金を調整することは難しいでしょうか？ 駐車場は敷地内まだ空きありますでしょうか？" }); eq(!!l && l.includes("〇〇につきまして、本日管理会社営業時間外の為明日確認させて頂き、"), true, String(l)); });
it("夜の結び: 募集状況だけを聞いた番は21時前は入れない（お客様の発言で見ても）", () => eq(nightMgmtClosingLine({ hour: 19, saturday: false, allowed: true, object: "募集状況", splitOn: true, topicText: "上記2件の空き状況を教えてください" }), null));

// 2026-11-06 弱い所 345: ブレインの材料の1行
it("ブレインの材料: 既定 on・off で止める（11/06）", () => { eq(mgmtNightBrainNoteOn({}), true); eq(mgmtNightBrainNoteOn({ MGMT_NIGHT_BRAIN_NOTE: "off" }), false); eq(mgmtNightBrainNoteOn({ MGMT_NIGHT_BRAIN_NOTE: "on" }), true); });
it("ブレインの材料: 20時の礼金と駐車場（q136 の実物）→ 出す", () => { const n = nightMgmtBrainNote({ hour: 20, customerText: "ちなみにこちらの物件礼金を調整することは難しいでしょうか？ 駐車場は敷地内まだ空きありますでしょうか？" }); eq(n.includes("確認の約束の返信") && n.includes("礼金"), true, n); });
it("ブレインの材料: 昼・募集状況だけは出さない・日曜の夜は出す（8/23 は日曜）", () => { eq(nightMgmtBrainNote({ hour: 14, customerText: "駐車場は空いてますか" }), ""); eq(nightMgmtBrainNote({ hour: 20, customerText: "駐車場は空いてますか" }).includes("駐車"), true); eq(nightMgmtBrainNote({ hour: 20, customerText: "上記2件の空き状況を教えてください" }), ""); });

// 2026-11-06 案A: 今夜はまだ押せないピッカー
it("ピッカーの1行: 既定 on・off で止める（11/06）", () => { eq(mgmtNightPickerNoteOn({}), true); eq(mgmtNightPickerNoteOn({ MGMT_NIGHT_PICKER_NOTE: "off" }), false); eq(mgmtNightPickerNoteOn({ MGMT_NIGHT_PICKER_NOTE: "on" }), true); });
it("ピッカーの1行: q136（礼金と駐車場）→ mgmt_parking・mgmt_initial_cost", () => { const l = nightPickerLine("ちなみにこちらの物件礼金を調整することは難しいでしょうか？ 駐車場は敷地内まだ空きありますでしょうか？"); eq(l.includes("mgmt_parking") && l.includes("mgmt_initial_cost") && l.includes("two_stage=check"), true, l); });
it("ピッカーの1行: 管理会社の話題が無ければ空", () => eq(nightPickerLine("上記2件の空き状況を教えてください"), ""));

// 2026-11-06 最終チェックの夜の1行
it("最終チェックの夜の1行: 既定 off", () => { eq(mgmtNightFcTomorrowOn({}), false); eq(mgmtNightFcTomorrowNote({ hour: 20, customerText: "駐車場は空いてますか" }, {}), ""); });
it("最終チェックの夜の1行: on・20時の礼金と駐車場 → 出す", () => { const n = mgmtNightFcTomorrowNote({ hour: 20, customerText: "ちなみにこちらの物件礼金を調整することは難しいでしょうか？ 駐車場は敷地内まだ空きありますでしょうか？" }, { MGMT_NIGHT_FC_TOMORROW: "on" }); eq(n.includes("AIX_BOUNDARY_PROMISE にしない") && n.includes("礼金"), true, n); });
it("最終チェックの夜の1行: on でも昼・募集状況だけは出さない", () => { const on = { MGMT_NIGHT_FC_TOMORROW: "on" }; eq(mgmtNightFcTomorrowNote({ hour: 14, customerText: "駐車場は空いてますか" }, on), ""); eq(mgmtNightFcTomorrowNote({ hour: 20, customerText: "上記2件の空き状況を教えてください" }, on), ""); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
