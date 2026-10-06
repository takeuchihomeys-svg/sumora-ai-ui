// 引用の枠（画面）と、同じ流れのほかの引用（材料）のテスト
// 実物: Ryoichi kiritsuke（スモラ・2026-10-05 13:55）
//   「ここと」      ← [引用] こちらが送った資料の画像（sent_image_properties: リヴィエール桜之町東 102）
//   「ここを見に行きたいです」← [引用] こちらが送った物件オススメの画像（アトリエール堺寺地町 103）
//   画面は「↩ [引用] [画像]」だけ・生成/AIX には最後の1通（アトリエール）しか渡っていなかった
//
// 実行: npx tsx app/lib/__tests__/quote-preview.test.ts（全 PASS で exit 0）
import { buildQuotePreview, labelsFromSentRows, propertyLabelOf, isMediaPlaceholder } from "../quote-preview";
import { formatOtherQuotesLine, formatQuotedContextBlock, buildQuotedReplyNote, type QuotedContext } from "../quoted-note";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function has(s: string, sub: string) { if (!s.includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)} in ${JSON.stringify(s.slice(0, 300))}`); }
function hasNot(s: string, sub: string) { if (s.includes(sub)) throw new Error(`expected NOT to contain ${JSON.stringify(sub)}`); }

const BASE = "https://wfwsmwxakhyxobytszoq.supabase.co/storage/v1/object/public/property-images/aix/615499ba-4554-4eea-8193-e6077f9a68ed/";
const RIVIERE = `${BASE}1791175543873_7_qg85d.jpg`;
const ATELIER = `${BASE}1791175833486_wn21c.jpg`;

console.log("■ 引用の枠（buildQuotePreview）");
it("★★ こちらが送った資料の画像 → スモラ／写真＋サムネイル＋物件名", () => {
  const p = buildQuotePreview({ sender: "staff", text: "[画像]", imageUrl: RIVIERE, propertyLabel: "リヴィエール桜之町東 102号室" }, { account: "sumora" });
  eq(p.who, "スモラ"); eq(p.kind, "image"); eq(p.snippet, "写真"); eq(p.thumbUrl, RIVIERE);
  eq(p.propertyLabel, "リヴィエール桜之町東 102号室"); eq(p.imageGone, false);
});
it("★★ 物件名が記録に無い画像は物件名を出さない（推測しない）", () => {
  const p = buildQuotePreview({ sender: "staff", text: "[画像]", imageUrl: ATELIER, propertyLabel: null }, { account: "sumora" });
  eq(p.propertyLabel, null); eq(p.thumbUrl, ATELIER);
});
it("★ アカウントは日本語名でも英語キーでも表示名に（イエヤス）", () => {
  eq(buildQuotePreview({ sender: "staff", text: "x", imageUrl: null }, { account: "イエヤス" }).who, "イエヤス");
  eq(buildQuotePreview({ sender: "staff", text: "x", imageUrl: null }, { account: null }).who, "スタッフ");
});
it("★★ お客様の送った画像の書き起こしは枠に出さない（発言ではない）・保存期限切れは保存切れ", () => {
  const p = buildQuotePreview({ sender: "customer", text: "[画像] 賃貸物件 大阪 6万円ペット可", imageUrl: "https://x/y.jpg", imageExpiresAt: "2026-10-01T00:00:00Z" }, { customerName: "Hina", now: Date.parse("2026-10-07T00:00:00Z") });
  eq(p.who, "Hina"); eq(p.snippet, "写真"); eq(p.thumbUrl, null); eq(p.imageGone, true);
});
it("★ 画像の URL が無い「[画像]」も写真（保存切れ）として出す", () => {
  const p = buildQuotePreview({ sender: "staff", text: "[画像]", imageUrl: null }, { account: "sumora" });
  eq(p.kind, "image"); eq(p.imageGone, true);
});
it("★ 動画はサムネイルを出さない（img で読めない）", () => {
  const p = buildQuotePreview({ sender: "staff", text: "[動画]", imageUrl: "https://x/a.mp4" }, { account: "sumora" });
  eq(p.kind, "video"); eq(p.snippet, "動画"); eq(p.thumbUrl, null); eq(p.imageGone, false);
});
it("★ 文の引用は頭40字", () => {
  const p = buildQuotePreview({ sender: "staff", text: "お送りさせて頂きましたお部屋の中でも\nアトリエール堺寺地町 103号室が特にオススメ出来るお部屋となります！！", imageUrl: null }, { account: "sumora" });
  eq(p.kind, "text"); has(p.snippet, "お送りさせて頂きましたお部屋の中でも アトリエール"); has(p.snippet, "…");
});
it("★ 引用先が見つからない時は missing", () => eq(buildQuotePreview(undefined).kind, "missing"));

console.log("■ 物件名（送った時の記録）");
it("★★ sent_image_properties を sent_properties より先に（先の行が勝つ）", () => {
  const m = labelsFromSentRows([
    { image_url: RIVIERE, property_name: "リヴィエール桜之町東", room_no: "102" },
    { image_url: RIVIERE, property_name: "別の束の代表", room_no: "1" },
    { image_url: ATELIER, property_name: "アトリエール堺寺地町", room_no: "103" },
    { image_url: null, property_name: "x", room_no: "1" },
  ]);
  eq(m.get(RIVIERE), "リヴィエール桜之町東 102号室"); eq(m.get(ATELIER), "アトリエール堺寺地町 103号室"); eq(m.size, 2);
});
it("号室の頭の0を外す・号室付きは重ねない・名前なしは null", () => {
  eq(propertyLabelOf("ハイツ", "0203"), "ハイツ 203号室");
  eq(propertyLabelOf("ハイツ", "203号室"), "ハイツ 203号室");
  eq(propertyLabelOf("ハイツ", null), "ハイツ");
  eq(propertyLabelOf("  ", "203"), null);
});
it("isMediaPlaceholder", () => { eq(isMediaPlaceholder("[画像]"), true); eq(isMediaPlaceholder("[画像] 文字"), false); eq(isMediaPlaceholder(null), true); });

console.log("■ 同じ流れのほかの引用（材料）");
const latest: QuotedContext = {
  customerText: "ここを見に行きたいです", quotedSender: "staff", quotedText: null, isImage: true,
  propertyLabel: "アトリエール堺寺地町 103号室", detailLines: [], detailKind: "property",
  otherQuotes: [{ customerText: "ここと", propertyLabel: "リヴィエール桜之町東 102号室", isImage: true, quotedText: null }],
};
it("★★ Ryoichi: 「ここと」の物件も AIX の材料に入る（2件すべて）", () => {
  const b = formatQuotedContextBlock(latest);
  has(b, "アトリエール堺寺地町 103号室");
  has(b, "「ここと」→ 物件資料（リヴィエール桜之町東 102号室）");
  has(b, "リヴィエール桜之町東 102号室・アトリエール堺寺地町 103号室 の2件すべて");
});
it("★★ Ryoichi: 返信生成の材料にも入る", () => {
  const n = buildQuotedReplyNote(latest, { linkOrPhotoRequest: false, estimateAllowed: false });
  has(n, "同じ流れのほかの引用"); has(n, "リヴィエール桜之町東 102号室");
});
it("★ ほかの引用が無ければ今までと同じ（何も足さない）", () => {
  eq(formatOtherQuotesLine({ propertyLabel: "A 1号室" }), "");
  hasNot(formatQuotedContextBlock({ ...latest, otherQuotes: [] }), "同じ流れ");
});
it("★ 物件の分からない画像は「画像」とだけ（名前を作らない）", () => {
  const l = formatOtherQuotesLine({ propertyLabel: "A 1号室", otherQuotes: [{ customerText: "これも", propertyLabel: null, isImage: true, quotedText: null }] });
  has(l, "「これも」→ 画像"); has(l, "これらも合わせた話");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.join("\n")); process.exit(1); }
