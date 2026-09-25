// 2026-09-25 竹内「候補の記憶を太くする。会話を見たりオススメしている部分を見ればギャップが分かる」
// 実行: npx tsx app/lib/__tests__/candidate-facts.test.ts
// 文字は実物（リアプロの説明文＝property_brain_judgments の summary_text・itandi の建物の段＝拡張のテストと同じ・🌟の本文＝2026-09-24〜25 の送信）。
// お客様の呼び名は「〇〇さん」に置き換えてある（個人情報なし）
import {
  enrichCandidate, parseFactsFromText, parseStations, parseAddress, wardOf, parseBuilt, ageFromBuiltYm, floorFromRoomNo, roomFromName,
  sameBuildingName, nameSimilarity, fillMissing, coverageOf, clipRawForStorage, yenAll, bestBuildingMatch, factsFromImageRead, type CandidateFacts,
} from "../candidate-facts";
import { starHeadOf, appealTopics, customerWants, factTopics, compareRound, maskPersonal, isUsableCustomerText } from "../recommendation-gaps";
import { fillPoolFromPickups, factsFromPickup } from "../recommendation-snapshot-server";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("\n■ 金額・駅・所在地・築年");
t("「65,000円 10,000円」→ 2つ", eq(yenAll("65,000円 10,000円"), [65000, 10000]));
t("「5.7万円」", eq(yenAll("5.7万円"), [57000]));
const st = parseStations("JR京都線 新大阪駅 徒歩8分\n大阪メトロ御堂筋線 新大阪駅 徒歩8分\n阪急宝塚本線 三国駅 徒歩16分");
t("交通3行", eq(st, [{ line: "JR京都線", station: "新大阪", walk: 8 }, { line: "大阪メトロ御堂筋線", station: "新大阪", walk: 8 }, { line: "阪急宝塚本線", station: "三国", walk: 16 }]), st);
const st2 = parseStations("阪急京都本線「十三」徒歩4分と駅近で、通勤にもかなり便利な立地です！！");
t("🌟の本文の「阪急京都本線「十三」徒歩4分」", eq(st2, [{ line: "阪急京都本線", station: "十三", walk: 4 }]), st2);
const st3 = parseStations("十三駅徒歩4分の敷金礼金なしで〇〇さんにかなりオススメ");
t("「十三駅徒歩4分」", eq(st3.map((s) => [s.station, s.walk]), [["十三", 4]]), st3);
t("バス停は駅にしない", parseStations("○○バス停 徒歩3分").length === 0, parseStations("○○バス停 徒歩3分"));
t("所在地（府から）", parseAddress("6枚\nエステムコート\n大阪府大阪市淀川区西宮原１丁目7-46\nJR京都線") === "大阪府大阪市淀川区西宮原1丁目7-46");
t("所在地（ラベル）", parseAddress("住所: 大阪市浪速区難波中3丁目") === "大阪市浪速区難波中3丁目");
t("名前だけの行は所在地にしない", parseAddress("エステムコート難波Ⅶビヨンド") === null);
t("区: 大阪市淀川区 → 淀川区", wardOf("大阪府大阪市淀川区西宮原1丁目") === "淀川区");
t("市: 豊中市", wardOf("大阪府豊中市蛍池東町") === "豊中市");
t("築年月: itandi の「/ 2008年6月」", parseBuilt("15階建\n/ 2008年6月\n(築18年)").ym === "2008-06");
t("入居日（2026年10月1日）は築年にしない", parseBuilt("2026年10月1日\n相談").ym === null);
t("築年数 2008-06 → 2026-09 で 18", ageFromBuiltYm("2008-06", "2026-09-25") === 18);
t("新築 → 0", parseBuilt("新築・敷金礼金なし").age === 0);
t("号室→階: 202→2・1001→10・0901→9・B101→分からない", eq([floorFromRoomNo("202"), floorFromRoomNo("1001"), floorFromRoomNo("0901"), floorFromRoomNo("B101")], [2, 10, 9, null]));
t("名前の号室: 「グランコート 201号室」「パレス城北 401」", eq([roomFromName("グランコート 201号室"), roomFromName("パレス城北 401")], ["201", "401"]));

console.log("\n■ 建物名の照合（画像の読み取りの崩れ・線 0.75）");
t("スプランディッド難波WEST ≒ スプランディッド雑賀WEST（難波↔雑賀の読み違い）", sameBuildingName("スプランディッド難波WEST", "スプランディッド雑賀WEST"), nameSimilarity("スプランディッド難波WEST", "スプランディッド雑賀WEST"));
t("朝日プラザ桑津第2 ≒ 朝日プラザ美津第2", sameBuildingName("朝日プラザ桑津第2", "朝日プラザ美津第2"), nameSimilarity("朝日プラザ桑津第2", "朝日プラザ美津第2"));
t("読みの括弧を落とす", sameBuildingName("オーサムハウス城東(オーサムハウスジョウトウ)", "オーサムハウス城東"));
t("別の建物は別", !sameBuildingName("エスリード難波AGREA", "スプランディッド難波WEST"), nameSimilarity("エスリード難波AGREA", "スプランディッド難波WEST"));
// 同じシリーズの別の建物（0.6 だと当たっていた実物）
t("ハーモニーテラス今林 ≠ 田島（0.71）", !sameBuildingName("ハーモニーテラス今林", "ハーモニーテラス田島"), nameSimilarity("ハーモニーテラス今林", "ハーモニーテラス田島"));
t("アドバンス大阪セレーネ ≠ グロウ（0.67）", !sameBuildingName("アドバンス大阪セレーネ", "アドバンス大阪グロウ"));
t("エステムコート難波Ⅶビヨンド ≠ 難波WEST（0.61）", !sameBuildingName("エステムコート難波Ⅶビヨンド", "エステムコート難波WEST"));
const list = [{ n: "ハーモニーテラス田島", r: "" }, { n: "ハーモニーテラス今林", r: "305" }, { n: "ハーモニーテラス今林", r: "202" }];
t("一番近い物・号室が同じ物を選ぶ", bestBuildingMatch("ハーモニーテラス今林", "202", list, (x) => x.n, (x) => x.r) === list[2]);
t("号室が両方分かって違えば外す", bestBuildingMatch("ハーモニーテラス今林", "999", list, (x) => x.n, (x) => x.r) === null);

console.log("\n■ リアプロの説明文（実物）");
const rp = parseFactsFromText("【1】レシオスなんばVOGUE\n65,000円 10,000円\n1K 22.62㎡\nAD 1ヶ月");
t("家賃・管理費・間取り・㎡・AD", eq([rp.rent, rp.admin_fee_yen, rp.floor_plan, rp.area_sqm, rp.ad_months], [65000, 10000, "1K", 22.62, 1]), rp);
const rp2 = parseFactsFromText("【1】エステムコート難波Ⅶビヨンド\n78,000円 7,000円\n1K 21.81㎡\nAD 171,600円");
t("AD 円", rp2.ad_yen === 171600 && rp2.ad_months == null, rp2);
t("1行目の名前（【N】）からは読まない", parseFactsFromText("【3】2LDKハウス\n5万円").floor_plan == null);
t("敷1ヶ月 礼なし", eq([parseFactsFromText("【1】x\n敷1ヶ月 礼なし").deposit_months, parseFactsFromText("【1】x\n敷1ヶ月 礼なし").key_money_months], [1, 0]));
t("敷金礼金なし → 0・0", eq(((f) => [f.deposit_months, f.key_money_months])(parseFactsFromText("新築・敷金礼金なし・家賃管理費込75,000円")), [0, 0]));

console.log("\n■ 1件を太くする（拡張の値が最優先・管理費＝家賃は読み違い）");
const realproRaw = { name: "わいわいハウス平野", rank: 1, rent: 98000, ad_months: 2.5, read_mode: "header", floor_plan: "2DK", admin_fee_yen: 98000,
  cells: ["わいわいハウス平野", "98,000円 5,000円", "2DK 40.5㎡", "250%"], bld_text: "住所 大阪府大阪市平野区平野本町1丁目\n沿線 大阪メトロ谷町線 平野駅 徒歩6分\n築年月 2019年3月" };
const e1 = enrichCandidate(realproRaw, { now: "2026-09-25" });
t("管理費＝家賃は捨ててセルの2つ目で読み直す", e1.admin_fee_yen === 5000 && e1.src?.admin_fee_fix === "eq_rent_dropped" && e1.src?.admin_fee_yen === "text:cells", e1);
t("拡張の家賃・AD はそのまま（ext）", e1.rent === 98000 && e1.ad_months === 2.5 && e1.src?.rent === "ext");
t("建物の段から 駅・徒歩・所在地・区・築", eq([e1.station, e1.walk_minutes, e1.ward, e1.built_ym, e1.building_age], ["平野", 6, "平野区", "2019-03", 7]), e1);
t("セルから㎡", e1.area_sqm === 40.5);
t("facts_v=2", e1.facts_v === 2);
const itRaw = { rank: 2, name: "エステムコート新大阪Ⅵエキスプレイス", rent: 67000, admin_fee_yen: 0, deposit_months: 0, key_money_months: 1, floor_plan: "1K", area_sqm: 20.8, room_no: "405",
  address: "大阪府大阪市淀川区西宮原1丁目7-46", stations: ["JR京都線 新大阪駅 徒歩8分", "阪急宝塚本線 三国駅 徒歩16分"], walk_minutes: 8, built_ym: "2008-06", building_age: 18, total_floors: 15, ad_months: 1 };
const e2 = enrichCandidate(itRaw, { now: "2026-09-25" });
t("itandi: 交通の文字 → 駅の形・最寄り・区・号室から階", eq([e2.stations?.length, e2.station, e2.ward, e2.floor], [2, "新大阪", "淀川区", 4]), e2);
t("itandi: 敷金0（なし）を 0 のまま（null にしない）", e2.deposit_months === 0 && e2.key_money_months === 1);
const old = enrichCandidate({ name: "物件3", rank: 3 });
t("何も無い古い形でも落ちない", old.name === "物件3" && old.rent == null && old.facts_v === 2);
const clipped = clipRawForStorage(enrichCandidate({ name: "x", rank: 1, cells: Array.from({ length: 60 }, () => "あ".repeat(300)) }));
t("保存用に切り詰める（40セル×120字）", Array.isArray(clipped.cells) && (clipped.cells as string[]).length === 40 && (clipped.cells as string[])[0].length === 120);

console.log("\n■ 埋める・数える");
const tgt: CandidateFacts = { name: "a", rent: 70000, equipment: ["オートロック"] };
const filled = fillMissing(tgt, { rent: 80000, deposit_months: 0, equipment: ["オートロック", "宅配ボックス"] }, "pickup");
t("値がある項目は上書きしない・空いている所だけ・設備は和集合", tgt.rent === 70000 && tgt.deposit_months === 0 && eq(tgt.equipment, ["オートロック", "宅配ボックス"]) && eq(filled, ["deposit_months", "equipment"]), tgt);
const cov = coverageOf([e1, e2, old]);
t("カバー率: 家賃 2/3・徒歩 2/3", Math.abs(cov.rent - 2 / 3) < 1e-9 && Math.abs(cov.walk_minutes - 2 / 3) < 1e-9, cov);

console.log("\n■ 売上サポの行から埋める（拡張の回と同じ時刻の batch）");
const pk = { id: 1, batch_id: "b1", created_at: "2026-09-25T03:49:00Z", rank: 1, property_name: "わいわいハウス平野", room_no: "203",
  summary_text: "【1🌟★】わいわいハウス平野\n98,000円 5,000円\n2DK 40.5㎡\nAD 2.5ヶ月", pdf_text: "", recommended: 1, pdf_blob_url: "https://blob.example/1.pdf" };
const fp = factsFromPickup(pk, "2026-09-25");
t("🌟★・号室・資料URL", fp.star === "🌟★" && fp.room_no === "203" && fp.pdf_url === "https://blob.example/1.pdf", fp);
const pool = fillPoolFromPickups({ sent_at: "2026-09-25T03:47:36Z", candidates: [{ name: "わいわいハウス平野", rank: 1, rent: 98000 }, { name: "マンション津坂", rank: 2 }] }, [pk, { ...pk, id: 2, batch_id: "old", created_at: "2026-09-20T00:00:00Z" }]);
t("近い batch だけ使う・順位＋名前で結ぶ", pool.batch === "b1" && pool.filled === 1 && pool.candidates[0].star === "🌟★" && pool.candidates[0].floor === 2 && pool.candidates[1].star == null, pool);

console.log("\n■ 送った画像1枚の読み取り → 画像ごとの値（2026-09-25 YUMA の実物の応答の形）");
const img = factsFromImageRead({ propertyName: "エステムコート新大阪VIエキスブレイス", roomNumber: "710", rent: 58000, adminFee: 10000, deposit: 0, keyMoney: 0, floorPlan: "1K", areaSqm: 20.88, station: "新大阪駅", walkMinutes: 5, built: "2008年6月", ad: "", status: "open" }, "2026-09-25");
t("家賃・管理費・敷礼0・間取り・㎡・駅と徒歩・築年月・号室から階・募集状況", eq(img, { rent: 58000, admin_fee_yen: 10000, deposit_months: 0, key_money_months: 0, floor_plan: "1K", area_sqm: 20.88, stations: [{ line: null, station: "新大阪", walk: 5 }], station: "新大阪", walk_minutes: 5, built_ym: "2008-06", building_age: 18, room_no: "710", floor: 7, status: "open" }), img);
const img2 = factsFromImageRead({ deposit: 1, keyMoney: 108000, ad: "100%", rent: 500, areaSqm: 2 });
t("敷金 1 は月数・礼金 108000 は円・AD 100%→1ヶ月・範囲外の家賃と㎡は捨てる", eq(img2, { deposit_months: 1, key_money_yen: 108000, ad_months: 1 }), img2);
t("読めない項目は入れない", eq(factsFromImageRead({ propertyName: "x", roomNumber: "" }), {}));

console.log("\n■ 🌟の本文（訴求）とお客様の希望");
const STAR1 = "🌟ハーモニーテラス今林 202\n\n新築・敷金礼金なし・家賃管理費込75,000円の〇〇さんにかなりオススメ出来るお部屋となります！！\n\nリビング8.6帖・洋室3.5帖の1LDK（専有面積30.22㎡）で、独立洗面台や浴室乾燥機、室内洗濯機置場も完備されており暮らしやすさもばっちりです！！\n\nスマートロック・オートロック・宅配BOXなどセキュリティ面も充実しております！！\n\n敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！空室のため即入居可能です！！";
const STAR2 = "🌟グランコート 201号室\n\n十三駅徒歩4分の敷金礼金なしで〇〇さんにかなりオススメ出来るお部屋となります！！\n\n家賃77,000円・管理費3,000円（合計80,000円）の1LDK、リビング6.97帖・洋室6帖の2部屋でゆとりのある間取りとなっております！！阪急京都本線「十三」徒歩4分と駅近で、通勤にもかなり便利な立地です！！\n\n独立洗面台付きで朝の身支度もしやすく、商店街や飲食店も近く生活しやすい環境です！！\n\n敷金礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n\n独立系保証会社で審査となり審査通過しやすいお部屋となります！！";
t("1行目: 名前と号室", eq(starHeadOf(STAR1), { name: "ハーモニーテラス今林", room: "202" }) && eq(starHeadOf(STAR2), { name: "グランコート", room: "201" }), [starHeadOf(STAR1), starHeadOf(STAR2)]);
t("🌟で始まらない本文は null", starHeadOf("ハーモニーテラス今林") === null);
const ap1 = appealTopics(STAR1);
t("訴求: 新築・敷礼0・初期費用・家賃・広さ・独立洗面台・浴室乾燥・室内洗濯機・オートロック・宅配・セキュリティ・入居時期", ["new_build", "zero_deposit", "low_initial", "rent", "spacious", "washbasin", "bath_dryer", "laundry_in", "autolock", "delivery_box", "security", "move_in"].every((k) => ap1.includes(k as never)), ap1);
const ap2 = appealTopics(STAR2);
t("訴求: 駅近・通勤・間取り（2部屋）・審査・周辺環境", ["station_near", "commute", "layout", "screening", "surroundings"].every((k) => ap2.includes(k as never)), ap2);
t("1行目の物件名は訴求に数えない（「今林」「グランコート」）", !appealTopics("🌟新築マンション 101\n\nお手隙の際にご確認ください").includes("new_build"));
const w = customerWants({ conditions: { initial_cost_limit: 300000, walk_minutes: 10, preferences: "バストイレ別、2階以上" }, messages: ["オートロックがあると嬉しいです", "https://example.com/bukken"] });
t("希望: 条件欄（初期費用・駅近）・自由文（バストイレ別・2階以上）・発言（オートロック）・URL は使わない", eq(w.map((x) => `${x.key}:${x.from}`), ["low_initial:conditions", "station_near:conditions", "bath_toilet:free_text", "floor2:free_text", "autolock:messages"]), w);
t("貼った物件の長文は発言に使わない", !isUsableCustomerText("賃料 70,000円 間取り 1K 所在地 大阪市…".padEnd(260, "あ")));

console.log("\n■ 事実の話題とギャップ");
const ft = factTopics({ deposit_months: 0, key_money_months: 0, walk_minutes: 4, building_age: 0, floor: 2, equipment: ["オートロック", "独立洗面台"] }, { walkMax: 10 });
t("事実: 敷礼0・駅近・築浅・2階以上・設備", ["zero_deposit", "station_near", "new_build", "floor2", "autolock", "washbasin"].every((k) => ft.yes.includes(k as never)) && ft.no.length === 0, ft);
const ft2 = factTopics({ deposit_months: null, key_money_months: 1 }, {});
t("礼金1ヶ月なら敷礼0ではない（no）・値が無ければ blind", ft2.no.includes("zero_deposit") && !ft2.yes.includes("station_near") && !ft2.no.includes("station_near"), ft2);
const g = compareRound({
  starText: STAR2,
  wants: w,
  candidates: [
    { facts: { name: "グランコート", deposit_months: 0, key_money_months: 0, walk_minutes: 4 }, isStar: true, score: 60 },
    { facts: { name: "他の物件", deposit_months: 1, key_money_months: 1, walk_minutes: 3, equipment: ["オートロック"] }, isStar: false, score: 75 },
    { facts: { name: "三件目" }, isStar: false, score: 50 },
  ],
});
t("🌟は2位・ブレインの一番との差は 敷礼0（🌟だけ）とオートロック（一番だけ）", g.starPos === 2 && eq(g.top?.starOnly, ["zero_deposit"]) && eq(g.top?.topOnly, ["autolock"]), g);
t("求めたのに訴求していない: バストイレ別・2階以上・オートロック", ["bath_toilet", "floor2", "autolock"].every((k) => g.wantedNotAppealed.includes(k as never)), g.wantedNotAppealed);
t("訴求したが🌟の値で見えない話題（独立洗面台）", g.appealBlind.includes("washbasin") && g.appealSeen.includes("zero_deposit"), [g.appealSeen, g.appealBlind]);
t("呼び名・電話番号を伏せる", maskPersonal("慶次さんに 090-1234-5678") === "〇〇さんに ***", maskPersonal("慶次さんに 090-1234-5678"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
