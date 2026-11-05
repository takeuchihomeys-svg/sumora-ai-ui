// 確認の「いつ」の線（2026-10-28 竹内さん #26 #28）
// 実行: npx tsx app/lib/__tests__/mgmt-hours-split.test.ts
import { mgmtHoursSplitEnabled, isVacancyConfirmObject, COMPANY_CLOSE_HOUR, mgmtNightClosingOn, nightMgmtClosingLine } from "../mgmt-hours-split";

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
it("夜の結び: 20時の礼金と駐車場（q136）→ 明日を入れる", () => { const l = nightMgmtClosingLine({ hour: 20, weekend: false, allowed: true, object: "礼金の調整と駐車場の空き状況", splitOn: true }); eq(!!l && l.includes("本日管理会社営業時間外の為、明日礼金の調整と駐車場の空き状況を確認させて頂き、"), true, String(l)); });
it("夜の結び: 募集状況だけで21時より前は入れない（10/28）", () => eq(nightMgmtClosingLine({ hour: 19, weekend: false, allowed: true, object: "お送り頂いた物件の募集状況", splitOn: true }), null));
it("夜の結び: 募集状況でも21時以降は入れる（10/29 22:05 の竹内さん）", () => eq(!!nightMgmtClosingLine({ hour: 22, weekend: false, allowed: true, object: "お送り頂いた物件の募集状況", splitOn: true }), true));
it("夜の結び: 昼・土日・確認の約束が無い番は入れない", () => { eq(nightMgmtClosingLine({ hour: 14, weekend: false, allowed: true, object: "駐車場", splitOn: true }), null); eq(nightMgmtClosingLine({ hour: 20, weekend: true, allowed: true, object: "駐車場", splitOn: true }), null); eq(nightMgmtClosingLine({ hour: 20, weekend: false, allowed: false, object: "駐車場", splitOn: true }), null); });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
