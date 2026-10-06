// app/lib/__tests__/closing-target.test.ts — 決め手の条件（純関数）。本文は本番の会話の文そのまま（名前は伏せた所あり）
// 実行: npx tsx app/lib/__tests__/closing-target.test.ts
import {
  readClosingGaps, favoriteFromStarText, buildClosingTarget, closingTargetFromConversation, closingSearchOverride, closingTargetCodes,
  fitOf, candidateFromStarText, isStarNameLine, buildClosingTargetBrainNote, scopeOfGap, fillFavoriteFromPickup,
} from "../closing-target";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };
const kinds = (s: string) => readClosingGaps(s).map((g) => g.kind).join(",");

// ── 発言の型（当たる物） ──
t("H0N0KA. 家賃もう少し下がったり → 家賃", kinds("よいです！！！\nすきです！！！\n\nただ家賃もう少し下がったりしないですよね、、、🥲🥲🥲") === "rent_lower");
t("ゆいと カウンターキッチンのとこは少ない → 設備", kinds("カウンターキッチンのとこは少ないですかね？") === "equipment");
t("カウンターキッチンの鍵", readClosingGaps("カウンターキッチンのとこは少ないですかね？")[0]?.equipment?.[0]?.key === "counter_kitchen");
t("ガスコンロついてないのは厳しい → 設備", kinds("ガスコンロついてないのは厳しいです") === "equipment");
t("エレベーターがないと大変 → 設備", kinds("内代の物件かなりいいとおもいましたが、3ヶ月の赤ちゃんがいるのでエレベーターがないと移動が大変かなとおもいました。").includes("equipment"));
t("収納少ないので → 設備（収納）", readClosingGaps("ごめんなさい収納少ないので一旦なしで😭😭")[0]?.equipment?.[0]?.key === "storage");
t("駐車場有りの物件で探して → 設備", kinds("申し遅れたのですが駐車場有りの物件で探していて、他にオススメの物件あれば教えていただきたいです🙇‍♀️") === "equipment");
t("8万は高いです → 家賃", kinds("8万は高いです💦") === "rent_lower");
t("とても良いのですが家賃が少し高く → 家賃", kinds("とても良いのですが、家賃が少し高くなってしまいますね") === "rent_lower");
t("初期費用が高くて → 初期費用", kinds("とても嬉しい物件なのですが初期費用が高くて...( ; ; )") === "initial_cost");
t("敷金礼金なしの物件は少ない → 初期費用", kinds("敷金礼金なしの物件は大国町、なんば、桜川駅付近には少ないですか？😢") === "initial_cost");
t("2人で住むには少し狭く → 広さ", kinds("ご紹介いただいた物件を確認しましたが、2人で住むには少し狭く感じました。") === "wider");
t("もう少し広いと嬉しい → 広さ", kinds("もう少し広いと嬉しいです") === "wider");
t("駅から遠いし → 駅近", kinds("駅から遠いしドゥーエが基準になると見劣りしてしまって、、、すいません。") === "closer");
t("もう少し築浅 → 築年", kinds("もう少し築浅ないてすか？") === "newer");
t("最低5階 → 階（数字あり）", readClosingGaps("できたら最低5階はほしいです🥲")[0]?.explicit?.floorMin === 5);
t("木造は避けたい → 静かさ", kinds("木造は避けたいので、鉄骨造またはRC（鉄筋コンクリート造）の物件で探していただけると助かります。") === "quiet");

// ── 当たらない物（監査で目で読んで外した形） ──
t("ここ駐車場ありますか（物件確認）", kinds("ここ駐車場と駐輪場ありますか？？") === "");
t("インターネットは付いてないかんじですか（物件確認）", kinds("ルクレはインターネットは付いてないかんじですか？") === "");
t("平野区とかは家賃高いですか（相場）", kinds("平野区とかは家賃高いですか？") === "");
t("家賃上げて良いので（上げる）", !kinds("もう少し家賃上げて良いので、\n新大阪、東三国でありそうですか？😭😭").includes("rent_lower"));
t("家賃は6万円以下が嬉しい（以下が）", kinds("家賃は6万円以下が嬉しいです！") === "");
t("初期費用もう少し安くお願い（見積の値引き）", kinds("初期費用もう少し安くお願いします") === "");
t("初期費用が結構安くて（ほめ）", kinds("初期費用が結構安くて10万いなかいぐらいと言われたのですがほんとにそれぐらいの金額ですか？") === "");
t("初期費用も抑えて頂いており（お礼）", kinds("すごくいい物件で初期費用もめちゃくちゃ抑えて頂いており、嬉しいです！") === "");
t("家賃、初期費用共に最高（ほめ）", !kinds("家賃、初期費用共に最高ですがやはり職場が石橋なので石橋付近が望ましいです。").includes("initial_cost"));
t("また新しい物件があれば（新着）", kinds("また新しい物件があれば送ってもらえるとありがたいです！") === "");
t("WIC広めがありがたい（収納の広さ）", kinds("WIC広めがありがたいです") === "");
t("お風呂が狭い（部屋の広さではない）", kinds("お風呂が狭いと赤ちゃんのお風呂入れるのが難しいなって思っちゃって...💦") === "");
t("とても広いお部屋ですが（ほめ）", !kinds("とても広いお部屋ですが、平野区というのが気になります").includes("wider"));
t("カウンターキッチンでなくてもいい（受け入れ）", kinds("最悪カウンターキッチンでなくてもいいのであんな感じの家がいいかもです") === "");
t("特に希望しておりません（受け入れ）", kinds("独立洗面台、宅配BOXは特に希望しておりません、その設備に関してはどちらでも大丈夫です") === "");
t("駅から遠いんですがこれ調べて（持ち込み）", kinds("駅から遠いんですが、これ調べてもらいたいです。") === "");
t("重複家賃を抑えたい", kinds("なるべく重複家賃を抑えにおさえたいので、格安で狙いたいです。") === "");
t("値下げ交渉（申込の際）", !kinds("ダメ元でも大丈夫ですので申し込みの際オーナーさんに即決はするので家賃などの値下げ交渉できるか聞いていただけませんか？").includes("rent_lower"));
t("物件の画像の書き起こし（【キッチン】）", kinds("【位置】角部屋 【キッチン】ガスコンロ・システムキッチン") === "");

// ── 🌟の本文 ──
const STAR_H = "（室内イメージ）\nhttps://suumo.jp/chintai/bc_100511079938/\n\n🌟パウスフラッツ新大阪 1002\n\n1件新着でHONOKAさんにオススメ出来るお部屋が募集に出ました！！\n\n（オススメポイント）\n・家賃86,000円・管理費9,200円（合計95,200円）\n・間取り：1LDK（リビング7.0帖・洋室2.0帖）\n・御堂筋線「新大阪」徒歩5分・東海道線「新大阪」徒歩8分\n・2023年6月築で築年数浅く、室内状態の良いお部屋です！！\n・独立洗面台・浴室乾燥機・ウォークインクローゼット";
const fav = favoriteFromStarText(STAR_H, "2026-10-04T23:19:04Z", "2026-10-05T00:00:00Z")!;
t("🌟は2行目以降でも読む（室内イメージが先）", fav?.name === "パウスフラッツ新大阪" && fav.room === "1002");
t("合計（管理費込み）", fav.total === 95200);
t("駅と徒歩", fav.walk === 5 && fav.stations.some((s) => s.station === "新大阪"));
t("見積書・申込フォーマットの🌟は物件名ではない", !isStarNameLine("🌟60,000円割引させて頂き") && !isStarNameLine("🌟最大限割引しました初期費用の御見積書同封させて頂きました！！") && !isStarNameLine("🌟年収420万円"));
const filled = fillFavoriteFromPickup(fav, { summary_text: "【1】バウスフラッツ新大阪 1002号室\n86,000円 9,200円\n1DK 24.43㎡\n御堂筋線「新大阪」徒歩5分", terms: { buildingAge: 3, deposit: 0, keyMoney: 1 }, location: { stations: [{ line: "阪急京都線", station: "南方", walk: 11 }] } });
t("売上サポの行で広さ・敷礼を埋める", filled.areaSqm === 24.43 && filled.zeroInitial === false && filled.sources.includes("売上サポの行"));

// ── 像（H0N0KA.） ──
const curH = { rent_max: 95000, floor_plan: "1DK 1LDK", floor_area_min: 25, walk_minutes: 10, building_age: 20, desired_area: "新大阪、東三国", area_mode: "station" };
const tH = buildClosingTarget({ gaps: readClosingGaps("ただ家賃もう少し下がったりしないですよね"), favorite: filled, current: curH, text: "よいです！！！すきです！！！ただ家賃もう少し下がったりしないですよね" })!;
t("家賃: 9.52万 −5千 → 9.0万（千円で切り下げ）", tH.want.rentMaxTotal === 90000);
t("広さ: 24.43㎡の9割 → 21㎡", tH.want.areaMin === 21);
t("間取り: 気に入った部屋＋登録", JSON.stringify(tH.want.floorPlans) === JSON.stringify(["1LDK", "1DK"]));
t("家賃は一時の意図（登録しない）", tH.scope === "temporary" && tH.registerHints.length === 0);
t("気に入った上で（ほめ言葉あり）", tH.liked && tH.rationale.includes("気に入った上で"));
const ovH = closingSearchOverride(tH, curH)!;
t("検索の上書き: 家賃 9万・広さ21・間取りは登録と同じなので入れない", ovH.rent_max === 90000 && ovH.area_min === 21 && ovH.floor_plan === null);
// 江坂 203（9万・1DK・駅は江坂）＝一番の点は合うが場所の目安（新大阪・南方・東三国）の外
const STAR_E = "🌟ファーストフィオーレ江坂垂水町Ⅱ 203号室\n\n（オススメポイント）\n・家賃80,000円・共益費10,000円（合計90,000円）\n・間取り：1DK（ダイニング5.5帖、洋室3.7帖）\n・北大阪急行電鉄「江坂」徒歩12分";
t("江坂 203 は一番の点は合う（場所の外）", fitOf(tH, candidateFromStarText(STAR_E)!).fit === "main_ok");
const STAR_OK = "🌟サンプル新大阪 501\n・家賃78,000円・管理費10,000円（合計88,000円）\n・間取り：1DK（25.1㎡）\n・御堂筋線「新大阪」徒歩6分";
t("新大阪 8.8万 1DK は決め手に合う", fitOf(tH, candidateFromStarText(STAR_OK)!).fit === "fit");
t("判定の札: 合う → CLOSING_FIT", closingTargetCodes({ rentYen: 78000, adminFeeYen: 10000, floorPlan: "1DK", areaSqm: 25.1, walkMinutes: 6, buildingAge: 5, depositMonths: 0, keyMoneyMonths: 0, rawText: "御堂筋線「新大阪」徒歩6分" }, { target: tH }).includes("CLOSING_FIT"));
t("判定の札: 9.5万 → 一番の点が外れ", closingTargetCodes({ rentYen: 86000, adminFeeYen: 9200, floorPlan: "1DK", areaSqm: 24.4, walkMinutes: 5, buildingAge: 3, depositMonths: 0, keyMoneyMonths: 1, rawText: "新大阪 徒歩5分" }, { target: tH }).includes("CLOSING_MAIN_MISS"));

// ── 像（ゆいと） ──
const curY = { rent_max: 90000, floor_plan: "1LDK", floor_area_min: 30, walk_minutes: 15, building_age: 20, desired_area: "豊中", preferences: "将来的にペット飼いたい", area_mode: "ward" };
const STAR_D = "🌟ディアコート曽根 302号室\n\n（オススメポイント）\n・家賃83,000円・管理費5,000円（合計88,000円）\n・間取り：1LDK（リビング8.4帖、洋室5.7帖）\n・曽根駅徒歩14分\n・2024年4月築";
const STAR_C = "🌟カーサ・クラシオンF 102号室\n\n\n（オススメポイント）\n・家賃76,000円・管理費4,000円（合計80,000円）\n・間取り：1LDK（リビング11.5帖、洋室5帖）\n・阪急宝塚本線「神崎川」徒歩14分\n・2021年11月築で築年数浅く\n・ペット飼育可能\n・カウンターキッチン付き";
const msgsY = [
  { sender: "staff", text: STAR_D, created_at: "2026-10-04T03:52:08Z" },
  { sender: "customer", text: "カウンターキッチンのとこは少ないですかね？", created_at: "2026-10-05T02:48:06Z" },
  { sender: "staff", text: STAR_C, created_at: "2026-10-05T04:01:13Z" },
];
const stY0 = closingTargetFromConversation({ messages: msgsY, current: curY, now: "2026-10-05T03:00:00Z" })!;
t("ゆいと: 発言の直後はまだ見つかっていない", stY0.status === "active" && stY0.target.kind === "equipment");
t("ゆいと: 設備は登録してよい型（こだわりにカウンターキッチン）", stY0.target.scope === "permanent" && stY0.target.registerHints[0]?.value === "カウンターキッチン");
t("ゆいと: 設備はサイトで絞れない＝検索の上書きなし", closingSearchOverride(stY0.target, curY) === null);
const stY1 = closingTargetFromConversation({ messages: msgsY, current: curY, now: "2026-10-07T00:00:00Z" })!;
t("ゆいと: カーサ・クラシオンF（カウンターキッチン付き）を送った → found", stY1.status === "found" && stY1.sentAfter[0]?.name === "カーサ・クラシオンF");
t("ブレインの材料に状態と像", /決め手の条件/.test(buildClosingTargetBrainNote(stY1)) && /像に合う/.test(buildClosingTargetBrainNote(stY1)));
t("21日より古い発言は使わない", closingTargetFromConversation({ messages: msgsY, current: curY, now: "2026-11-01T00:00:00Z" }) === null);
t("設備の札（資料の文字層で読む）", closingTargetCodes({ rentYen: 76000, adminFeeYen: 4000, floorPlan: "1LDK", walkMinutes: 14, buildingAge: 4, depositMonths: null, keyMoneyMonths: null, rawText: "" }, { target: stY0.target, equipmentText: "設備 カウンターキッチン システムキッチン" }).includes("CLOSING_FIT"));

// ── 型ごとの方針 ──
t("数字のある階は登録してよい", scopeOfGap(readClosingGaps("できたら最低5階はほしいです")[0]) === "permanent");
t("比べの広さは一時の意図", scopeOfGap(readClosingGaps("もう少し広いと嬉しいです")[0]) === "temporary");

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
