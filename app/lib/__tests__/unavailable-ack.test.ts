// 2026-10-15 軸の直し④: 物件確認した の結果が全部 募集に出ていない時（unavailable-ack.ts）。文は実物（名前・物件名は伏せた）
// 実行: npx tsx app/lib/__tests__/unavailable-ack.test.ts
import { unavailableReportOf, inviteSentenceOf, checkResultAllUnavailable } from "../unavailable-ack";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const YUNA = "〇〇さんお送り頂きました〇〇につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！\n引き続き新着でオススメ出来る条件のお部屋出次第お送りさせて頂きます！！\n何卒よろしくお願い致します！！";
it("63fa0c26 10/09: 募集に出ていない報告だけ", () => eq(unavailableReportOf(YUNA), true));
it("一部募集中の報告は当てない", () => eq(unavailableReportOf("〇〇は募集終了となっておりますが、〇〇は現在募集中となります！！"), false));
it("誘いの1文を見つける", () => eq(!!inviteSentenceOf("はい😊！！\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！"), true));
it("記録: prop_statuses が全部 unavailable", () => {
  eq(checkResultAllUnavailable({ aix_type: "property_check_result", prop_statuses: ["unavailable", "unavailable"] }), true);
  eq(checkResultAllUnavailable({ aix_type: "property_check_result", prop_statuses: ["unavailable", "available"] }), false);
  eq(checkResultAllUnavailable({ aix_type: "property_check_result", check_pattern: "unavailable" }), true);
  eq(checkResultAllUnavailable({ aix_type: "property_check_result", check_pattern: "available", generated_text: YUNA }), true, "記録の文で");
  eq(checkResultAllUnavailable({ aix_type: "property_send", prop_statuses: ["unavailable"] }), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
