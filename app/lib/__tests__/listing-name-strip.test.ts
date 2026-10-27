// 資料の物件名からサイト名・「最新」の付記だけを外す（app/lib/listing-name-strip.ts）— 実物の物件名（建物名は公開の情報）・LLM なし
// 実行: npx tsx app/lib/__tests__/listing-name-strip.test.ts（全 PASS で exit 0）
import { listingNameStripEnabled, stripListingAnnotation, maybeStripListingName, stripListingAnnotationInHeads } from "../listing-name-strip";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

console.log("listing-name-strip");
it("切替は既定 off", () => {
  eq(listingNameStripEnabled({}), false);
  eq(listingNameStripEnabled({ LISTING_NAME_STRIP: "on" }), true);
  eq(maybeStripListingName("ACT正雀(イタンジ最新)", false), "ACT正雀(イタンジ最新)");
  eq(maybeStripListingName("ACT正雀(イタンジ最新)", true), "ACT正雀");
});
it("サイト名・最新のかっこだけ外す（全角も）", () => {
  eq(stripListingAnnotation("ACT正雀(イタンジ最新)"), "ACT正雀");
  eq(stripListingAnnotation("シャンタラム吹田（イタンジ最新）"), "シャンタラム吹田");
  eq(stripListingAnnotation("EIJU Tsukamoto(イタンジ最新)"), "EIJU Tsukamoto");
  eq(stripListingAnnotation("〇〇ハイツ(SUUMO)"), "〇〇ハイツ");
  eq(stripListingAnnotation("〇〇ハイツ(レインズ)"), "〇〇ハイツ");
});
it("旧名・フリガナ・リノベ・地名のかっこは残す", () => {
  eq(stripListingAnnotation("フェルザ今宮戎(旧:Krehl難波南)"), "フェルザ今宮戎(旧:Krehl難波南)");
  eq(stripListingAnnotation("GALLERY谷町(ギャラリー谷町)"), "GALLERY谷町(ギャラリー谷町)");
  eq(stripListingAnnotation("パークモダン新大阪(フルリノベーション)"), "パークモダン新大阪(フルリノベーション)");
  eq(stripListingAnnotation("グランシャリオ(関目)"), "グランシャリオ(関目)");
});
it("全部外れて空になる時・空は元のまま", () => {
  eq(stripListingAnnotation("(イタンジ最新)"), "(イタンジ最新)");
  eq(stripListingAnnotation(""), "");
  eq(stripListingAnnotation(null), null);
});
it("出口: 見出しの行だけ（🌟・【】）・本文の他の行は触らない", () => {
  eq(stripListingAnnotationInHeads("🌟ACT正雀(イタンジ最新) 102号室\n\n（オススメポイント）\n・ACT正雀(イタンジ最新)は新築"),
    { text: "🌟ACT正雀 102号室\n\n（オススメポイント）\n・ACT正雀(イタンジ最新)は新築", changed: true });
  eq(stripListingAnnotationInHeads("【ACT正雀(イタンジ最新) 102号室】").text, "【ACT正雀 102号室】");
  eq(stripListingAnnotationInHeads("🌟ACT正雀（イタンジ最新）102号室").text, "🌟ACT正雀 102号室");
  eq(stripListingAnnotationInHeads("🌟フェルザ今宮戎(旧:Krehl難波南) 302号室").changed, false);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
