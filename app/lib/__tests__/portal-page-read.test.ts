// 2026-10-14 竹内さん「SUUMO を送ってきた時に中身を読む…読めていない所をつなぐ」— portal-page-read.ts / portal-listing-match.ts
// 実行: npx tsx app/lib/__tests__/portal-page-read.test.ts
import { parseSuumoPage, portalSiteOf, portalUrlsIn } from "../portal-page-read";
import { readListingClues, matchListing, portalFormOf, cluesFromPickupSummary } from "../portal-listing-match";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}
// 2026-10-14 に開いたページの形（中身を短くした写し）
const BUILDING = `<title>【SUUMO】ジュネーゼグラン難波ミラージュ（(株)AivyAivy不動産 難波店提供）／大阪府大阪市浪速区元町１／ＪＲ難波駅の賃貸・部屋探し情報（100527049653） | 賃貸マンション・賃貸アパート</title>
<div class="property_view_main-emphasis"> 6.21万円</div> <div class="property_data-title">管理費・共益費</div> <div class="property_data-body"> 9900円</div>
<div class="property_data-title">間取り</div> <div class="property_data-body"> 1K</div> <div class="property_data-title">専有面積</div> <div class="property_data-body"> 23.8m<sup>2</sup></div>
<div class="property_view_detail-text">ＪＲ関西本線/ＪＲ難波駅 歩4分</div><div class="property_view_detail-text">地下鉄御堂筋線/なんば駅 歩6分</div>`;
const NO_NAME = `<title>【SUUMO】1LDK/3階/37.26m2／静岡県静岡市葵区西門町／静岡駅の賃貸・部屋探し情報（000105850020） | 賃貸マンション・賃貸アパート</title>
<span class="property_view_note-emphasis">6.9万円</span> <span>管理費・共益費:&nbsp;6000円</span>
<th class="property_view_table-title">駅徒歩</th> <td colspan="3" class="property_view_table-body"> <div class="property_view_table-read">ＪＲ東海道本線/静岡駅 歩11分</div></td>
<th class="property_view_table-title">間取り</th> <td class="property_view_table-body">1LDK</td> <th class="property_view_table-title">専有面積</th> <td class="property_view_table-body">37.26m<sup>2</sup></td>
<th class="property_view_table-title">階</th> <td class="property_view_table-body">3階</td>`;

console.log("■ SUUMO のページ");
const a = parseSuumoPage("https://suumo.jp/chintai/bc_100527049653/", BUILDING);
t("建物の掲載: 名前（提供の会社の括弧は外す）", a.name === "ジュネーゼグラン難波ミラージュ", a);
t("建物の掲載: 家賃・管理費・間取り・広さ・駅", a.rentYen === 62100 && a.adminYen === 9900 && a.madori === "1K" && a.areaSqm === 23.8 && a.station === "難波" && a.walk === 4, a);
t("建物の掲載: 所在地", a.address === "大阪府大阪市浪速区元町1", a.address);
const b = parseSuumoPage("https://suumo.jp/chintai/jnc_000105850020/", NO_NAME);
t("名前の無い掲載: 名前は作らない", b.name === null && b.status === "ok", b);
t("名前の無い掲載: 家賃・管理費・間取り・階・駅", b.rentYen === 69000 && b.adminYen === 6000 && b.madori === "1LDK" && b.floor === 3 && b.station === "静岡" && b.walk === 11, b);
t("404 は掲載終了", parseSuumoPage("u", "", 404).status === "expired");
t("エラーのページも掲載終了", parseSuumoPage("u", "<title>エラー｜SUUMO(スーモ)</title>", 200).status === "expired");
t("SUUMO の1件のページだけ開く", portalSiteOf("https://suumo.jp/chintai/bc_1/") === "suumo" && portalSiteOf("https://suumo.jp/chintai/osaka/") === "other" && portalSiteOf("https://line.me/x") === null);
t("発言の中の URL", portalUrlsIn("ここどうですか https://suumo.jp/chintai/jnc_000107699982/ by SUUMO").length === 1);

console.log("■ 物件名の無い共有文を手がかりで結ぶ（1つに決まる時だけ）");
const share = "地下鉄堺筋線 恵美須町 徒歩5分\n1R 5.2万円\n[詳細]\nhttps://myhome.nifty.com/rent/osaka/x";
const c = readListingClues(share);
t("手がかり: 駅・徒歩・家賃・間取り", c.station === "恵美須町" && c.walk === 5 && c.rentYen === 52000 && c.madori === "1R", c);
t("形: 物件名の無い共有文", portalFormOf(share, 0) === "no_name_share");
t("形: SUUMO の共有文（物件名つき）", portalFormOf("プルス新北野 3階\nhttps://suumo.jp/chintai/bc_1/\nby SUUMO", 1) === "suumo_named");
t("形: URL だけ", portalFormOf("https://suumo.jp/chintai/bc_1/", 0) === "url_only");
const pk = cluesFromPickupSummary("【4】サンプル恵美須 202号室\n52,000円 5,000円\n1R 20.5㎡\n堺筋線「恵美須町」徒歩5分");
t("売上サポの説明文の手がかり", pk.rentYen === 52000 && pk.madori === "1R" && pk.station === "恵美須町" && pk.walk === 5, pk);
const one = matchListing(c, [{ name: "サンプル恵美須", room: "202", ...pk, source: "pickup" }], {});
t("1つなら結ぶ", one.match?.name === "サンプル恵美須", one);
const two = matchListing(c, [{ name: "サンプル恵美須", room: "202", ...pk, source: "pickup" }, { name: "別の建物", room: "101", ...pk, source: "pickup" }], {});
t("2つなら結ばない", two.match === null && two.hits === 2, two);
const diff = matchListing(c, [{ name: "サンプル恵美須", room: "202", ...pk, rentYen: 55000, source: "pickup" }], {});
t("家賃が違えば別", diff.match === null, diff);
t("戻す PORTAL_LISTING_MATCH=off", matchListing(c, [{ name: "サンプル恵美須", room: "202", ...pk, source: "pickup" }], { PORTAL_LISTING_MATCH: "off" }).match === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
