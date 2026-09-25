// 実行: node tests/chrome-extension/itandi-row-parse.test.js
// 本文は 2026-09-24 竹内さんが itandi の一覧でコンソールから取った実物（部屋の段・建物の段の innerText）
const P = require("../../chrome-extension/itandi-row-parse.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }

const ROOM_612 = "募集中\n\n物確不要\n\n3日前\n\n612\n5.7万円\nなし\n8,000円\nなし\nなし\n入力なし\n1K\n20.88㎡\n2026年10月1日\n相談\n13枚\n入力なし\n専任媒介\n可\n\n内見\n\nWEB\n\n0\n\n図面\n\n物件資料\n\n🔍 SUUMO\n\n詳細";
const BLD = "6枚\nエステムコート新大阪Ⅵエキスプレイス\n大阪府大阪市淀川区西宮原１丁目7-46\nJR京都線 新大阪駅 徒歩8分\n大阪メトロ御堂筋線 新大阪駅 徒歩8分\n15階建\n/ 2008年6月\n(築18年)\n株式会社ジージェイマネージメント\n\n募集状況\n\n物確表示\n\n募集条件更新\n\n部屋番号\n\n賃料\n\n管理費\n\n共益費\n\n敷金\n\n礼金\n\n保証金\n\n間取り\n\n専有面積\n\n内見開始日\n\n入居可能時期\n\n間取り図\n\n画像枚数\n\n広告費\n\n取引態様\n\n広告掲載\n\ncheck_box_outline_blank\n" + ROOM_612 + "\n\nBK＝礼金（最大2ヶ月）";
// 画面の2件目（405号室・広告費100%・代理）: 画面の並びどおりに組み立てた物
const ROOM_405 = "募集中\n\n物確不要\n\n5日前\n\n405\n6.7万円\nなし\n入力なし\nなし\n1ヶ月\n入力なし\n1K\n20.8㎡\n2026年10月20日\n2026年11月上旬\n1枚\n100%\n代理\n可\n\n内見\n\nWEB\n\n0\n\n図面\n\n物件資料";
const BLD_405 = "4枚\nエステムコート新大阪Ⅵエキスプレイス\n大阪府大阪市淀川区西宮原1丁目7-46\nJR京都線 新大阪駅 徒歩8分\n阪急宝塚本線 三国駅 徒歩16分\n大阪メトロ御堂筋線 東三国駅 徒歩17分\n15階建\n/ 2008年6月\n(築18年)\n株式会社RENOSY ASSET MANAGEMENT 大阪支社\n\n募集状況\n" + ROOM_405;

console.log("\n■ 部屋の段");
const r1 = P.parseRoomText(ROOM_612);
eq("612: 号室・賃料・管理費+共益費・間取り・㎡", [r1.room, r1.rentYen, r1.adminYen, r1.layout, r1.areaSqm], ["612", 57000, 8000, "1K", 20.88]);
eq("612: 広告費「入力なし」は AD なし", [r1.ad, r1.adMonths, r1.adYen], [null, null, null]);
const r2 = P.parseRoomText(ROOM_405);
eq("405: 号室・賃料・管理費なし・間取り・㎡", [r2.room, r2.rentYen, r2.adminYen, r2.layout, r2.areaSqm], ["405", 67000, 0, "1K", 20.8]);
eq("405: 広告費 100% → AD 1ヶ月", [r2.ad, r2.adMonths], ["AD 1ヶ月", 1]);
eq("250% → 2.5ヶ月", P.parseRoomText("101\n7万円\nなし\nなし\n1LDK\n30㎡\n3枚\n250%\n代理").adMonths, 2.5);
eq("広告費 30,000円 → 円", P.parseRoomText("101\n7万円\nなし\nなし\n1K\n20㎡\n3枚\n30,000円\n代理").adYen, 30000);
eq("「3日前」を号室にしない（号室の欄が空の行）", P.parseRoomText("募集中\n3日前\n5.7万円\nなし\nなし\n1K\n20㎡").room, null);
eq("ワンルーム → 1R", P.parseRoomText("101\n5万円\nなし\nなし\nワンルーム\n18.5㎡").layout, "1R");
eq("2SLDK", P.parseRoomText("101\n12万円\nなし\nなし\n2SLDK\n55.1㎡").layout, "2SLDK");

console.log("\n■ 建物の段");
const b1 = P.parseBuildingText(BLD);
eq("物件名（写真の枚数を飛ばす）", b1.name, "エステムコート新大阪Ⅵエキスプレイス");
eq("所在地", b1.address, "大阪府大阪市淀川区西宮原１丁目7-46");
eq("交通は2行・最短徒歩8分", [b1.stations, b1.walkMin], [["JR京都線 新大阪駅 徒歩8分", "大阪メトロ御堂筋線 新大阪駅 徒歩8分"], 8]);
eq("下の部屋の段の文字を交通に混ぜない", b1.stations.length, 2);
const b2 = P.parseBuildingText(BLD_405);
eq("405 の建物: 交通3行・最短8分", [b2.stations.length, b2.walkMin], [3, 8]);

console.log("\n■ 説明文（サーバーの parsePropertyFacts が読む並び）");
const s = P.buildSummary(2, null, P.merge(r2, b2));
eq("405 の説明文", s, "【2】エステムコート新大阪Ⅵエキスプレイス\n67,000円\n1K 20.8㎡\n405号室\nJR京都線 新大阪駅 徒歩8分\n阪急宝塚本線 三国駅 徒歩16分\n大阪メトロ御堂筋線 東三国駅 徒歩17分\nAD 1ヶ月");
eq("612 の説明文（管理費あり・AD なし）", P.buildSummary(1, null, P.merge(r1, b1)), "【1】エステムコート新大阪Ⅵエキスプレイス\n57,000円 8,000円\n1K 20.88㎡\n612号室\nJR京都線 新大阪駅 徒歩8分\n大阪メトロ御堂筋線 新大阪駅 徒歩8分");
eq("PDF の名前があればそれを使う", P.buildSummary(3, "別名マンション", P.merge(r1, b1)).split("\n")[0], "【3】別名マンション");
eq("何も読めない時は従来どおり「物件N」", P.buildSummary(4, null, {}), "【4】物件4");

console.log("\n■ 候補の記録を太くする（2026-09-25）");
eq("612: 敷金なし・礼金なし → 0・0", [r1.depositMonths, r1.keyMoneyMonths], [0, 0]);
eq("405: 敷金なし・礼金1ヶ月", [r2.depositMonths, r2.keyMoneyMonths], [0, 1]);
eq("敷金が円（50,000円）", P.parseRoomText("101\n6万円\nなし\nなし\n50,000円\nなし\n入力なし\n1K\n20㎡").depositYen, 50000);
eq("敷礼が「入力なし」は分からない（null）", [P.parseRoomText("101\n6万円\nなし\nなし\n入力なし\n入力なし\n入力なし\n1K\n20㎡").depositMonths], [null]);
eq("賃料と間取りの間が6つでない並びは敷礼を読まない", [P.parseRoomText("101\n7万円\nなし\nなし\n1LDK\n30㎡").depositMonths], [null]);
eq("建物: 築年月・築年数・階建", [b1.builtYm, b1.buildingAge, b1.totalFloors], ["2008-06", 18, 15]);
const pool = P.toPoolData(2, null, P.merge(r2, b2), "https://blob.example/x.pdf");
eq("候補の記録: 家賃・管理費・敷礼・間取り・㎡・号室・所在地・交通・徒歩・築・AD・URL", pool, {
  rank: 2, name: "エステムコート新大阪Ⅵエキスプレイス", rent: 67000, admin_fee_yen: 0, deposit_months: 0, key_money_months: 1,
  floor_plan: "1K", area_sqm: 20.8, room_no: "405", address: "大阪府大阪市淀川区西宮原1丁目7-46",
  stations: ["JR京都線 新大阪駅 徒歩8分", "阪急宝塚本線 三国駅 徒歩16分", "大阪メトロ御堂筋線 東三国駅 徒歩17分"],
  walk_minutes: 8, built_ym: "2008-06", building_age: 18, total_floors: 15, ad_months: 1, pdf_url: "https://blob.example/x.pdf",
});
eq("候補の記録: 分からない項目は入れない（null を書かない）", Object.keys(P.toPoolData(4, null, {}, null)), ["rank", "name"]);
eq("候補の記録: PDF の名前を優先", P.toPoolData(3, "別名マンション", P.merge(r1, b1), null).name, "別名マンション");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
