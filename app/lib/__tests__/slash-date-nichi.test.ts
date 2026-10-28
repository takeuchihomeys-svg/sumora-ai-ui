// 実行: npx tsx app/lib/__tests__/slash-date-nichi.test.ts — #16（10/28 竹内さん）の実物
import { fixSlashDateNichi } from "../slash-date-nichi";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
console.log("slash-date-nichi");
it("かずき: 11/2日は何卒 → 11/2は何卒", () => eq(fixSlashDateNichi("はい😊！！11/2日は何卒よろしくお願い致します！！").text, "はい😊！！11/2は何卒よろしくお願い致します！！"));
it("咲: 10/24日12:00 → 10/24 12:00", () => eq(fixSlashDateNichi("10/24日12:00よりご案内させて頂きます").text, "10/24 12:00よりご案内させて頂きます"));
it("日割・日分・日程 は触らない", () => { for (const s of ["11/2日割家賃", "10/1日分", "11/2日程"]) eq(fixSlashDateNichi(s).fixed.length, 0); });
it("日以降・日までに・日当日 は日付の日＝外す", () => { eq(fixSlashDateNichi("10/13日以降での平日").text, "10/13以降での平日"); eq(fixSlashDateNichi("9/17日までにお送り").text, "9/17までにお送り"); eq(fixSlashDateNichi("10/17日当日は").text, "10/17当日は"); });
it("月日の形・曜日つきは触らない", () => { eq(fixSlashDateNichi("11月2日は何卒").fixed.length, 0); eq(fixSlashDateNichi("11/2(月)は何卒").fixed.length, 0); });
it("年の入った日付・ありえない日付は触らない", () => { eq(fixSlashDateNichi("2026/11/2日").fixed.length, 0); eq(fixSlashDateNichi("13/40日").fixed.length, 0); });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
