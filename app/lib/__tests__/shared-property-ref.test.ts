// 2026-09-12 竹内（YUYA 事例）: お客様が送った物件は「お送り頂きました物件」。共有文の駅名・徒歩分・家賃・間取りで呼ばない
// 実行: npx tsx app/lib/__tests__/shared-property-ref.test.ts
import { normalizeSharedPropertyReference, customerSharedProperty } from "../shared-property-ref";
import { applySurfaceFixes } from "../validate-reply";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const YUYA = "阪急神戸本線 十三 徒歩7分\n1R 4万円\n[詳細]\nhttps://myhome.nifty.com/smp/rent/osaka/osakashiyodogawaku/homesf_01162600032704/\n\nニフティ不動産アプリ版はこちら\nhttps://myhome.nifty.com/apps/\n⁣\nここはどうでしょうか？";
const norm = (t: string, c = YUYA) => normalizeSharedPropertyReference(t, c).text;

it("YUYA: 「十三徒歩7分の物件、募集状況確認」→「お送り頂きました物件、募集状況確認」", () =>
  expect(norm("かしこまりました！！\n十三徒歩7分の物件、募集状況確認させて頂きます😊！！\n確認出来次第ご連絡させて頂きます！！"))
    .toBe("かしこまりました！！\nお送り頂きました物件、募集状況確認させて頂きます😊！！\n確認出来次第ご連絡させて頂きます！！"));
it("家賃・間取りで呼んだ「4万円の1Rのお部屋」→「お送り頂きましたお部屋」", () =>
  expect(norm("4万円の1Rのお部屋の募集状況確認させて頂きます！！")).toBe("お送り頂きましたお部屋の募集状況確認させて頂きます！！"));
it("駅名だけ「十三の物件」→ 置き換え（共有文の駅名）", () =>
  expect(norm("十三の物件の募集状況確認させて頂きます！！")).toBe("お送り頂きました物件の募集状況確認させて頂きます！！"));
it("スタッフの実送信「お送り頂きました物件の募集状況確認」はそのまま", () => {
  const t = "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます😊！！\n確認出来次第ご連絡させて頂きます！！";
  expect(norm(t)).toBe(t);
});
it("「新着の物件」「ご希望条件のお部屋」はそのまま", () => {
  const t = "新着の物件もあわせてご希望条件のお部屋ピックアップさせて頂きます！！";
  expect(norm(t)).toBe(t);
});
it("直前が「お送り頂きました」（実文「お送り頂きました園田1LDK3階のお部屋」）→ 描写だけ外し重複させない", () =>
  expect(norm("お送り頂きました園田1LDK3階のお部屋、募集状況確認させて頂きます！！", "園田 徒歩5分\n1LDK 8万円\nhttps://suumo.jp/x/"))
    .toBe("お送り頂きましたお部屋、募集状況確認させて頂きます！！"));
it("同じ文で「お送り頂きありがとうございます」と受けている → 触らない", () => {
  const t = "大国町駅の物件どちらもお送り頂きありがとうございます😊！！";
  expect(norm(t, "大国町 徒歩3分 1K 6万円 https://suumo.jp/y/")).toBe(t);
});
it("「かしこまりました」等のひらがなの語を巻き込まない", () =>
  expect(norm("かしこまりました十三の物件確認させて頂きます")).toBe("かしこまりましたお送り頂きました物件確認させて頂きます"));
it("お客様が物件を送っていない（共有文・URL・画像なし）時は何もしない", () => {
  const t = "十三徒歩7分の物件もピックアップさせて頂きます！！";
  expect(norm(t, "十三周辺で探してほしいです")).toBe(t);
});
it("共有文の形の判定: 徒歩N分＋N万円 / URL / 画像", () => {
  expect(customerSharedProperty("阪急神戸本線 十三 徒歩7分\n1R 4万円")).toBe(true);
  expect(customerSharedProperty("[画像] 間取り")).toBe(true);
  expect(customerSharedProperty("梅田まで電車1本で探してください")).toBe(false);
});
it("後処理の入口（applySurfaceFixes）にお客様の連投を渡すと置き換わる", () =>
  expect(applySurfaceFixes("十三徒歩7分の物件、募集状況確認させて頂きます😊！！", { customerName: "YUYA", customerMessage: YUYA }).text)
    .toBe("お送り頂きました物件、募集状況確認させて頂きます😊！！"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
