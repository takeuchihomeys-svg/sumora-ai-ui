// 確認の「いつ」の線（2026-10-28 竹内さん #26 #28）
// 実行: npx tsx app/lib/__tests__/mgmt-hours-split.test.ts
import { mgmtHoursSplitEnabled, isVacancyConfirmObject, COMPANY_CLOSE_HOUR } from "../mgmt-hours-split";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

it("既定 off・on で入る", () => { eq(mgmtHoursSplitEnabled({}), false); eq(mgmtHoursSplitEnabled({ MGMT_HOURS_SPLIT_1028: "on" }), true); });
it("#28 あかり: 募集状況・空室・空き ＝ 弊社の時間で確かめられる", () => { for (const o of ["募集状況", "2件の募集状況", "空室", "空き状況"]) eq(isVacancyConfirmObject(o), true, o); });
it("#26 Ryoichi: 駐車場・鍵交換・ペット・交渉 ＝ 管理会社の確認（明日）", () => { for (const o of ["駐車場の空き状況", "鍵交換代", "ペット可否", "礼金の交渉", "入居可能日", ""]) eq(isVacancyConfirmObject(o), false, o); });
it("弊社の営業の終わりは 21時（確かめ待ち）", () => eq(COMPANY_CLOSE_HOUR, 21));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
