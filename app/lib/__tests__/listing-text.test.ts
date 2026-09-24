// listing-text（資料の文字層で LINE の説明文の抜けを補う純関数）のテスト
// 実行: npx tsx app/lib/__tests__/listing-text.test.ts
// 文字層は 2026-09-24 の実物（property_pickups 50 の itandi の PDF・35 のリアプロの PDF）の形。物件の情報だけ（お客様の情報は無い）
import { parseListingText, fillSummaryFromListing, isPlaceholderName, sameListingName } from "../listing-text";
import { parseSummaryHead } from "../sent-property-filter";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}

// itandi の文字層（字の間の空白・康熙部首の ⼤ U+2F24・「‧」・㎡ がそのまま入る）
const IT_TEXT = [
  "エステムコート新⼤阪 Ⅵ エキスプレイス 405 号室",
  "賃料 67,000 円 管理費‧共益費 なし",
  "間取り 1K 専有⾯積 20.8 ㎡",
  "交通",
  "JR 京都線 新⼤阪駅 徒歩 8 分",
  "御堂筋線 東三国駅 徒歩 12 分",
  "所在地 大阪府大阪市淀川区",
].join("\n");

const REALPRO_TEXT = [
  "物件名 エステムコート難波Ⅶビヨンド",
  "号室名 0404（4階部分）",
  "間取タイプ 1K[洋室7帖]",
  "専有面積 21.81㎡",
  "賃料",
  "78,000 円",
  "共益費・管理費 10,000円",
  "交通",
  "堺筋線「恵美須町」徒歩5分",
  "Powered by RealNetPro co.,ltd.",
].join("\n");

{
  const f = parseListingText(IT_TEXT);
  t("itandi: 形・名前（空白を詰め・NFKC）・号室", f.format === "itandi" && f.name === "エステムコート新大阪VIエキスプレイス" && f.roomNo === "405", f);
  t("itandi: 賃料・管理費なし＝0・間取り・面積", f.rentYen === 67000 && f.adminFeeYen === 0 && f.madori === "1K" && f.areaSqm === 20.8, f);
  t("itandi: 最短の徒歩の駅", f.nearest?.station?.replace(/駅$/, "") === "新大阪" && f.nearest?.walk === 8, f.nearest);
  const r = parseListingText(REALPRO_TEXT);
  t("リアプロ: 名前・号室（先頭の 0 を外す）・賃料・管理費", r.format === "realpro" && r.roomNo === "404" && r.rentYen === 78000 && r.adminFeeYen === 10000, r);
}

{
  t("一般名: 物件・物件3・空は一般名", isPlaceholderName("物件") && isPlaceholderName("物件3") && isPlaceholderName("") && !isPlaceholderName("エステムコート新大阪"));
  t("同じ名前: Ⅵ／VI・★ は同じ", sameListingName("★エステムコート新大阪Ⅵエキスプレイス", "エステムコート新大阪VIエキスプレイス"));
  t("同じ名前: SOUTH／NORTH は別", !sameListingName("エスリード新大阪SOUTH", "エスリード新大阪NORTH"));
}

{
  // 拡張が名前を取れなかった旧の itandi の説明文（「【1】物件」＋AD）
  const f = parseListingText(IT_TEXT);
  const r = fillSummaryFromListing("【1】物件\nAD 1ヶ月", f);
  const lines = r.summary.split("\n");
  t("一般名は資料の名前に差し替え・号室も足す", lines[0] === "【1】エステムコート新大阪VIエキスプレイス 405号室", lines);
  t("賃料・間取り・駅は AD の行の前に入れる（AD は最後の行のまま）", lines[lines.length - 1] === "AD 1ヶ月" && lines.includes("67,000円 管理費なし") && lines.includes("1K 20.8㎡") && lines.some((l) => /新大阪」徒歩8分/.test(l)), lines);
  const head = parseSummaryHead(r.summary);
  t("送付済みの照合が名前と号室を読める", head?.propertyName === "エステムコート新大阪VIエキスプレイス" && head?.roomNo === "405", head);
}

{
  // 反証 2026-09-25: 拡張 v2.5.16 の itandi の説明文は号室を独立した行に書く → 1行目へ移す（2回出さない）
  const f = parseListingText(IT_TEXT);
  const s = "【2】エステムコート新大阪Ⅵエキスプレイス\n67,000円\n1K 20.8㎡\n405号室\nJR京都線「新大阪」徒歩8分\nAD 1ヶ月";
  const r = fillSummaryFromListing(s, f);
  const lines = r.summary.split("\n");
  t("★ 独立した号室の行は1行目へ移し、2回出さない", lines[0] === "【2】エステムコート新大阪Ⅵエキスプレイス 405号室" && lines.filter((l) => /405/.test(l)).length === 1, lines);
  t("★ 移した後も送付済みの照合が号室を読める", parseSummaryHead(r.summary)?.roomNo === "405", parseSummaryHead(r.summary));
  t("★ 説明文にある賃料・間取り・駅は足さない（同じ行を2回出さない）", lines.filter((l) => /67,000/.test(l)).length === 1 && lines.filter((l) => /徒歩/.test(l)).length === 1, lines);
  const r2 = fillSummaryFromListing(s.replace("405号室", "406号室"), f);
  t("★ 号室が資料と違えば説明文の値のまま・食い違いを返す", r2.summary.split("\n")[0].endsWith("406号室") && r2.conflicts.some((c) => c.startsWith("room:")), r2);
}

{
  // 名前の違う PDF（組の取り違え）は何も補わない
  const f = parseListingText(IT_TEXT);
  const s = "【1】エスリード新大阪SOUTH\nAD 1ヶ月";
  const r = fillSummaryFromListing(s, f);
  t("名前が違う資料では補わない（skipped）", r.skipped && r.summary === s && r.filled.length === 0, r);
  // リアプロ（号室・駅が無い説明文）: 号室と駅だけ足し、賃料は変えない
  const rp = fillSummaryFromListing("【3】エステムコート難波Ⅶビヨンド\n78,000円 10,000円\n1K 21.81㎡\nAD 1ヶ月", parseListingText(REALPRO_TEXT));
  const lines = rp.summary.split("\n");
  t("リアプロ: 号室と駅を足す・賃料の行は1つのまま", lines[0].endsWith(" 404号室") && lines.some((l) => /恵美須町」徒歩5分/.test(l)) && lines.filter((l) => /78,000/.test(l)).length === 1 && rp.conflicts.length === 0, rp);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
