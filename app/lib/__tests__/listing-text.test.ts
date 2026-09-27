// listing-text（資料の文字層で LINE の説明文の抜けを補う純関数）のテスト
// 実行: npx tsx app/lib/__tests__/listing-text.test.ts
// 文字層は 2026-09-24 の実物（property_pickups 50 の itandi の PDF・35 のリアプロの PDF）の形。物件の情報だけ（お客様の情報は無い）
import { parseListingText, fillSummaryFromListing, isPlaceholderName, sameListingName, roomKey, roomForSummary } from "../listing-text";
import { parseSummaryHead, summaryHeadRoomVerbatim } from "../sent-property-filter";
import { buildPickupRows, parseAdFromPages, agentPagesText } from "../property-pickups";

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
  // 2026-09-27 竹内「資料の文字を変えず・抜かず」: 号室は資料の文字のまま（旧は「0404」→「404」）
  t("リアプロ: 号室（資料の文字のまま 0404）と駅を足す・賃料の行は1つのまま", lines[0].endsWith(" 0404号室") && lines.some((l) => /恵美須町」徒歩5分/.test(l)) && lines.filter((l) => /78,000/.test(l)).length === 1 && rp.conflicts.length === 0, rp);
  const head = parseSummaryHead(rp.summary);
  t("送付済みの照合の号室は今まで通り 0 を外した 404（sent_properties の照合は変えない）", head?.roomNo === "404" && head?.propertyName === "エステムコート難波Ⅶビヨンド", head);
  t("売上サポ・AIX に渡す号室は資料の文字のまま 0404", summaryHeadRoomVerbatim(rp.summary) === "0404");
}

console.log("── 2026-09-27 号室を資料の文字のまま（実物: property_pickups 618 の「005B」・61 の itandi「3A」・693 の「0206」）");
{
  const rp005b = parseListingText(REALPRO_TEXT.replace("号室名 0404（4階部分）", "号室名 005B（地下部分）"));
  t("資料の号室「005B」: 照合用の roomNo は null・roomLabel は 005B", rp005b.roomNo === null && rp005b.roomLabel === "005B", rp005b);
  t("説明文に書く号室は 005B", roomForSummary(rp005b) === "005B");
  const s = fillSummaryFromListing("【2】エステムコート難波Ⅶビヨンド\n78,000円 10,000円\n1K 21.81㎡\nAD 1ヶ月", rp005b);
  t("★ 旧は号室を落としていた → 1行目に「005B号室」", s.summary.split("\n")[0] === "【2】エステムコート難波Ⅶビヨンド 005B号室" && s.filled.includes("room"), s);
  const h = parseSummaryHead(s.summary);
  t("★ 名前に号室が残らない（旧は名前が「… 005B号室」・号室が空）", h?.propertyName === "エステムコート難波Ⅶビヨンド" && h?.roomNo === "005B", h);
  t("号室（そのまま）= 005B", summaryHeadRoomVerbatim(s.summary) === "005B");
  const rp0206 = parseListingText(REALPRO_TEXT.replace("号室名 0404（4階部分）", "号室名 0206（2階部分）"));
  const s2 = fillSummaryFromListing("【1】エステムコート難波Ⅶビヨンド\n78,000円 10,000円\nAD 1ヶ月", rp0206);
  t("「0206」は先頭の 0 を残す", s2.summary.split("\n")[0].endsWith(" 0206号室"), s2.summary);
  // itandi の説明文（号室が独立した行）: 英字付き・先頭の 0 も文字のまま1行目へ移す
  const it = parseListingText(IT_TEXT);
  const s3 = fillSummaryFromListing("【4】エステムコート新大阪Ⅵエキスプレイス\n67,000円\n3A号室\nAD 1ヶ月", it);
  t("★ itandi の「3A号室」の行を1行目へ（旧は移さず、1行目に資料の 405 を足して2つになった）", s3.summary.split("\n")[0] === "【4】エステムコート新大阪Ⅵエキスプレイス 3A号室" && !s3.summary.split("\n").slice(1).some((l) => /号室/.test(l)), s3.summary);
  t("資料（405）と違うので食い違いを返す", s3.conflicts.some((c) => c.startsWith("room:3A")), s3.conflicts);
  const s4 = fillSummaryFromListing("【5】エステムコート新大阪Ⅵエキスプレイス\n67,000円\n0405号室\nAD 1ヶ月", it);
  t("「0405号室」の行は文字のまま移し、資料の 405 と同じ部屋（食い違いにしない）", s4.summary.split("\n")[0].endsWith(" 0405号室") && !s4.conflicts.some((c) => c.startsWith("room:")), s4);
  t("照合の鍵: 0206＝206・005A≠005B・全角も同じ", roomKey("0206") === roomKey("206") && roomKey("005A") !== roomKey("005B") && roomKey("００５Ｂ") === roomKey("005B"));
  t("名前の末尾の「5F」は号室にしない（号室の字が無い英字付き）", parseSummaryHead("【1】ルクス本町 5F\n5.8万円")?.roomNo === "" && summaryHeadRoomVerbatim("【1】ルクス本町 5F\n5.8万円") === null);
  // 売上サポの行（property_pickups.room_no）
  const rows = buildPickupRows({ batchId: "b", propertyCustomerId: null, conversationId: null, customerName: null, site: "realpro" },
    [{ summary: s.summary, pdfUrl: null, pdfBlobUrl: null, pdfText: null, judgment: null } as never, { summary: s2.summary, pdfUrl: null, pdfBlobUrl: null, pdfText: null, judgment: null } as never]);
  t("★ property_pickups.room_no は資料の文字のまま（005B・0206）", rows[0].room_no === "005B" && rows[1].room_no === "0206" && rows[0].property_name === "エステムコート難波Ⅶビヨンド", rows.map((r) => [r.property_name, r.room_no]));
}

console.log("── 2026-09-27 AD は元付業者のページ（偶数）から（奇数＝弊社帯）");
{
  const p1 = "物件名 X\n賃料 70,000 円\n弊社の帯 AD 3ヶ月キャンペーン"; // 弊社帯に AD らしい字があっても当てない
  const p2 = "元付 〇〇不動産\nA D 100%(税込)";
  t("2ページ: 偶数（元付）の AD 1ヶ月", parseAdFromPages([p1, p2], `${p1}\n${p2}`).adMonths === 1);
  t("4ページ（2物件分）: 2・4ページだけ", agentPagesText(["a", "b", "c", "d"]) === "b\nd");
  t("1ページしか無い資料は全体から（itandi 等）", parseAdFromPages(["広告費 1ヶ月"], "広告費 1ヶ月").adMonths === 1);
  t("ページごとの文字が無い時は全体から（今まで通り）", parseAdFromPages(null, p2).adMonths === 1);
  t("元付のページに AD が無ければ不明（弊社帯の字で埋めない）", parseAdFromPages([p1, "元付 〇〇不動産"], `${p1}\n元付`).adMonths === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
