// センシティブ案件の検知（app/lib/sensitive-case.ts）
// 実行: npx tsx app/lib/__tests__/sensitive-case.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 材料: 本番のお客様の発言（365日でクレームの語に当たった4通は全部こちらへのクレームではなかった・2026-10-01）。名前は伏せた
import { detectSensitiveCase } from "../sensitive-case";
import { MSG_SEP } from "../reply-context";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(actual: T, exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); }

console.log("こちらへのクレームではない（実物）");
it("今の家で受けた騒音の苦情（初回の条件フォーム・9/30）", () => {
  eq(detectSensitiveCase("⑧【その他ご要望あれば】⇒今住んでいる家が1LDKで家賃8万円です。\n木造の為か、騒音がうるさいとクレームが来て疲れてます。\n騒音等は本当に気をつけたいです。"), null);
});
it("保証会社からの連絡が詐欺かの問い（7/21）", () => {
  eq(detectSensitiveCase("ジェイリース？からショートメールが来たんですけど詐欺ですか？？"), null);
});
it("画像の読み取りの文（差入書の約款の『苦情』・9/05）", () => {
  eq(detectSensitiveCase(`[画像] 差入書\n貸主 殿\n3. 騒音等で近隣から苦情があった場合は…`), null);
  eq(detectSensitiveCase(`ありがとうございます${MSG_SEP}[画像] 物件資料 苦情の窓口: 管理会社`), null);
});

console.log("今までどおり人に回す");
it("こちらへのクレーム", () => {
  eq(detectSensitiveCase("話が違うじゃないですか"), "クレーム");
  eq(detectSensitiveCase("対応がひどいのでクレーム入れます"), "クレーム");
  eq(detectSensitiveCase("納得いかないです"), "クレーム");
  eq(detectSensitiveCase("騙された気分です"), "クレーム");
});
it("審査否決（画像の読み取りでも）", () => {
  eq(detectSensitiveCase("数日前に相談させてもらった件ですが、審査ダメだったみたいなので 物件お願いしたいです"), "審査否決");
  eq(detectSensitiveCase("[画像] 審査結果のお知らせ 否決"), "審査否決");
});
it("キャンセル・リスケ", () => {
  eq(detectSensitiveCase("こちらの内覧はやはりキャンセルでお願いします"), "キャンセル・リスケ");
  eq(detectSensitiveCase("日程変更お願いしたいです"), "キャンセル・リスケ");
  eq(detectSensitiveCase("キャンセル料はかかりますか？"), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
