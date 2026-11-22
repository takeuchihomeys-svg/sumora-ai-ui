// ポータルの画面の見出しから物件名（2026-11-18 作業員H・OWN_PROPERTY_PORTAL_TITLE・既定 off）
// 実行: npx tsx app/lib/__tests__/own-property-portal-title.test.ts
import { extractScreenshotProperty, portalTitleName, portalTitleProperty, matchOwnProperty, ownPropertyPortalTitleOn } from "../own-property-match";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
// 実物（直近10日の読み取り文・電話やお客様の名前は含まない画面の文字だけ）
const suumo1 = "[画像] 【物件の画面（ポータル）】 着信/通知音量 suumo スーモ 最近みた物件 お気に入り メニュー ザ・タワー大阪(1LDK/9階/55.1m²)の賃貸住宅情報 2/20 [Floor plan image showing 1LDK layout]";
const suumo2 = "[画像] 【物件の画面（ポータル）】 20:56 suumo.jp SUUMO スーモ 最近みた物件 ♡4 お気に入り メニュー 第二福井マンション(2LDK/2階/65m²)の賃貸住宅情報｜エイブルネットワーク関大前店";
const suumo3 = "[画像] 【物件の画面（ポータル）】 セイバリーレイン(1LDK/1階/42.06m²)の賃貸住宅情報 2/20 玄関(SB) 洋室 6帖";
const homes = "[画像] 【物件の画面（ポータル）】 13:01 賃貸アパート シエーナ魚崎 9万円／管理費等5,000円 敷 無 礼 無 初期費用の目安を確認する";
const ours = ["[画像] 【物件の資料】", "物件名：アイボリーフロント雑賀WEST", "号室名：803（8階部分）"].join("\n");
t("既定 on（11/21）・=off で止める", ownPropertyPortalTitleOn({}) && !ownPropertyPortalTitleOn({ OWN_PROPERTY_PORTAL_TITLE: "off" }));
t("SUUMO の見出し（画面の文字が前にある）", portalTitleName(suumo1) === "ザ・タワー大阪", portalTitleName(suumo1));
t("SUUMO の見出し（店名の続き）", portalTitleName(suumo2) === "第二福井マンション", portalTitleName(suumo2));
t("SUUMO の見出し（先頭）", portalTitleName(suumo3) === "セイバリーレイン", portalTitleName(suumo3));
t("HOME'S の種別＋名前＋家賃", portalTitleName(homes) === "シエーナ魚崎", portalTitleName(homes));
t("名前の無いポータルの画面は取らない", portalTitleName("[画像] 【物件の画面（ポータル）】 賃貸 6.2万円（13階建/5階） 管理費等：8,000円") === null);
// 2026-11-21 作業員G: 180日 1,267通の on/off で増えた 48通のうち 23通が物件名でなかった形（画面の文字だけ・人の名前なし）
const P = "[画像] 【物件の画面（ポータル）】 ";
const cases: Array<[string, string, { name: string; room: string | null } | null]> = [
  ["SUUMO が名前を伏せた見出し（駅 間取り 階）", P + "14:49 suumo SUUMO スーモ 最近みた物件 お気に入り 6 メニュー 桜川 1K 6階(1K/6階/21.37m²)の賃貸住宅情報｜TSUBAKI不動産(株)提供 1/18", null],
  ["SUUMO が名前を伏せた見出し（先頭）", P + "新大阪 1LDK 9階(1LDK/9階/50.7m²) の賃貸住宅情報 | ピタットハウス新大阪", null],
  ["名前に空白（英字の短い語）", P + "JS House(1LDK/2階/41.05m²)の賃貸住宅情報 | アパマンショップ", { name: "JS House", room: null }],
  ["名前に空白（棟の記号）", P + "**物件情報:** - 大辛ロイヤル A3(1LDK/9階/37.82m²)の賃貸住宅情報", { name: "大辛ロイヤル A3", room: null }],
  ["「！」で終わる画面の文字で止める", P + "suumo アプリならプッシュ通知で新着物件を見逃さない！ facile vaieur(1SLDK/5階/45m²)の賃貸住宅情報", { name: "facile vaieur", room: null }],
  ["書き起こしの見出しで止める", P + "# テキスト書き起こし **ページタイトル** ガーデンレジデンス田川(1LDK/4階/45㎡)の賃貸住宅情報｜ホームメイト", { name: "ガーデンレジデンス田川", room: null }],
  ["HOME'S 名前が種別の前・特典あり", P + "LINEMO 20:39 56% サムティ福島VIVIENTE 賃貸マンション 特典あり 6.7万円／管理費等 8,000円 敷 無 礼 無", { name: "サムティ福島VIVIENTE", room: null }],
  ["HOME'S 名前が種別の前（2語）", P + "レジュールアッシュ梅田 WESTGATE 賃貸マンション 特典あり 6.9万円／管理費等6,000円", { name: "レジュールアッシュ梅田 WESTGATE", room: null }],
  ["HOME'S 名前を伏せた画面（駅の文字）", P + "LINEMO 20:38 58% 賃貸マンション JR大阪環状線 野田駅 徒歩7分 5.9万円／管理費等10,000円", null],
  ["HOME'S 特典あり＋名前＋号室", P + "16:33 5G 77 LDK (12.5帖) 洋室 (6.0帖) バルコニー 2/27 賃貸マンション 特典あり ラクラス本町東 1001 15.9万円／管理費等15,000円", { name: "ラクラス本町東", room: "1001" }],
  ["HOME'S 括弧の付録の号室", P + "17:03 LIFULL HOME'S 賃貸マンション BRAVE常盤町Ⅱ（13階/1301/1LDK/41.54㎡） 18.2万円／管理費等 12,000円", { name: "BRAVE常盤町II", room: "1301" }],
  ["HOME'S 名前に号室がくっつく", P + "16:27 5G 79 Bath room Hall Ent. Toilet 賃貸マンション 特典あり スプランディッド安土町1108 16.5万円／管理費等", { name: "スプランディッド安土町", room: "1108" }],
  ["HOME'S 号室＋種別の前（間取りの語で止める）", P + "16:26 5G 85 LDK 13.98㎡ AR PS PS グラン・デパール 602 賃貸マンション 特典あり 15万円", { name: "グラン・デパール", room: "602" }],
  ["HOME'S の PC の見出し", P + "物件詳細 賃貸マンション エステムコートみなと元町・THE・FIRSTの賃貸物件情報（1K/10階） 10階｜1K｜26.75㎡｜築12年 7.2万円／管理費", { name: "エステムコートみなと元町・THE・FIRST", room: null }],
];
for (const [label, text, want] of cases) {
  const got = portalTitleProperty(text);
  t(label, want === null ? got === null : !!got && got.name === want.name && got.room === want.room && got.via === "portal_title", got);
}
// ポータルの画面から取った物は号室まで同じでも same_room と言い切らない（H-14 ①・実物 3890f691 は店が募集状況を確認した）
const sentA = [{ name: "スプランディッド安土町", room: "1108", sentAt: "2026-09-10T10:00:00Z" }];
t("ポータルの画面＝同じ号室でも same_building", matchOwnProperty({ name: "スプランディッド安土町", room: "1108", via: "portal_title" }, sentA).kind === "same_building");
t("こちらの資料の形＝今まで通り same_room", matchOwnProperty({ name: "スプランディッド安土町", room: "1108" }, sentA).kind === "same_room");
const prev = process.env.OWN_PROPERTY_PORTAL_TITLE;
process.env.OWN_PROPERTY_PORTAL_TITLE = "on";
const a = extractScreenshotProperty(suumo1);
t("on: 取り出し（号室は分からない＝null）", !!a && a.name === "ザ・タワー大阪" && a.room === null, a);
const b = extractScreenshotProperty(ours);
t("on: 見出しの形（物件名：）は今まで通り先", !!b && b.name === "アイボリーフロント雑賀WEST" && b.room === "803", b);
process.env.OWN_PROPERTY_PORTAL_TITLE = "off";
t("off: 今まで通り取らない", extractScreenshotProperty(suumo1) === null);
if (prev === undefined) delete process.env.OWN_PROPERTY_PORTAL_TITLE; else process.env.OWN_PROPERTY_PORTAL_TITLE = prev;
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
