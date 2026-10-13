// 2026-10-13 竹内さん「AIX の物件名の当たり率を上げる直しを進めてよい」— 区切り1 照合（property-name-loose.ts）
// 実行: npx tsx app/lib/__tests__/property-name-loose.test.ts
import { matchLoose, isSameLoose, brainNameMatchesAny, splitBrainNames, parseLoose, looseMatchEnabled } from "../property-name-loose";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}
const same = (a: string, b: string) => isSameLoose(matchLoose(a, b));

console.log("■ 同じ物件（60日の外れの実物）");
const SAME: Array<[string, string]> = [
  ["エレガンス藤井寺 1-C", "エレガンス藤井寺 103号室"],
  ["サウスパーク 3階", "サウスパーク 3-C"],
  ["エスポワール21 B棟 B-102", "エスポワール21 B棟 102号室"],
  ["T-SPACE（東住吉区） 00101", "T-SPACE（東住吉区） 00101号室"],
  ["ハイツ秋桜2階8号室", "ハイツ秋桜 8号室"],
  ["富士林プラザ15番館1303", "富士林プラザ15番館"],
  ["アモーレ本町 WEST 7階", "アモーレ本町ウエスト 702号室"],
  ["マンション富士 18号室", "マンション冨士"],
  ["CRESTAPP野田204", "CRESTTAPP野田"],
  ["メイワール木川中里413号室", "メイウール木川中里 413号室"],
  ["コンフォリアリブ博労町一丁目", "コンフォリア・リヴ博労町一丁目Q 406号室"],
  ["ラヴィータ西橘田603号室", "ラ ヴィータ西梅田 603号室"],
  ["プレサンスOSAKA DOMECITYビーッ 708号室", "プレサンスOSAKA DOMECITYビーツ 708号室"],
  ["サンライト阿倍野8 202号室", "サンライトあべの8 202号室"],
  ["ドリームネオポリス桜ノ宮404", "ドリームネオポリス桜ノ宮"],
  ["セレニテ難波プリエ 0611", "セレニテ難波プリエ 611号室"],
  ["レジュールアッシュ難波MINAMI", "レジュールアッシュ難波MINAMI"],
  ["ハイムMK", "ハイムM&K 306号室"],
  ["プレサンス戸原橋ヴィプラス0201", "プレサンス芦原橋ヴィブラス 201号室"],
  ["エステムプラザ雑賀WESTⅢ 703", "エステムプラザ難波WESTⅢ 703号室"],
];
for (const [a, b] of SAME) t(`${a} ＝ ${b}`, same(a, b), { m: matchLoose(a, b), a: parseLoose(a), b: parseLoose(b) });

console.log("■ 別の物件・別の部屋に合わせない");
const DIFF: Array<[string, string]> = [
  ["フォーリアライズ本町レクス 301号室", "フォーリアライズ本町レクス 1401号室"],
  ["サンハイツ園部 303", "サンハイツ園部 404号室"],
  ["レジュールアッシュPREMIUM TWIN-I 3階", "レジュールアッシュPREMIUM TWIN II 206号室"],
  ["プレサンス難波WEST 0205", "プレサンス難波EAST 205号室"],
  ["ラヴィータ西梅田 603号室", "ラヴィータ東梅田 603号室"],
  ["エステムコート難波IVアトリ", "エステムコート難波Vアトリ"],
  ["クリエオーレ一津屋II 103号室", "クリエオーレ津屋 103号室"],
  ["レジュールアッシュ難波MINAMI", "Alivis新町 802号室"],
  ["プラーレビ南船場 0706号室", "ブラービ南船場 0607号室"],
  ["スプランディッド難波キャトル 803号室", "スプランディッド難波キャトル 904号室"],
  ["メゾンベルクレール中津 605号室", "ブリリアンマンション 705号室"],
  ["サンハイツ", "サンハイム"],
  ["エスリード大阪城EAST 506号室", "エスリード大阪城WEST 506号室"],
  ["アモーレ本町 WEST 7階", "アモーレ本町ウエスト 302号室"],
  // 2026-10-13 レビュー: 同じシリーズで地名だけ違う建物（設計知見 abce93ff）
  ["エステムコート梅田", "エステムコート難波"],
  ["プレサンスロジェ梅田", "プレサンスロジェ福島"],
  ["エスリードレジデンス梅田", "エスリードレジデンス福島"],
  ["ファーストフィオーレ江坂", "ファーストフィオーレ堺筋"],
  ["セレニテ谷町", "セレニテ本町"],
  ["ミラージュパレス本町", "ミラージュパレス谷町"],
  ["プレサンス大阪", "プレサンス新大阪"],
  ["プレサンス天満", "プレサンス天満橋"],
  ["グランカリテ大阪", "グランカリテ大阪城"],
  ["スプランディッド堀江", "スプランディッド難波 403号室"],
  ["スプランディッド堀江", "スプランディッド難波キャトル 803号室"],
];
for (const [a, b] of DIFF) t(`${a} ≠ ${b}`, !same(a, b), { m: matchLoose(a, b), a: parseLoose(a), b: parseLoose(b) });

console.log("■ ブレインの名前の並び");
t("「ミラージュパレス本町Depart1302・スプランディッド本町グラン1003」のどちらか", brainNameMatchesAny("ミラージュパレス本町Depart1302・スプランディッド本町グラン1003", ["スプランディッド本町グラン 1003号室"]));
t("「ハイツカトレアB・ハイムMK」の片方（ハイツカトレア B 202号室）", brainNameMatchesAny("ハイツカトレアB・ハイムMK", ["ハイツカトレア B 202号室"]));
t("「リブリ・スカイブルー ライズ 202、エイペックス神戸みなと元町CoastLin」→ リブリ…", brainNameMatchesAny("リブリ・スカイブルー ライズ 202、エイペックス神戸みなと元町CoastLin", ["エイベックス神戸みなと元町コーストライン 502号室", "リブリ・スカイブルーライズ 202号室"]));
t("建物名の中の「・」はそのまま（コンフォリア・リヴ）", brainNameMatchesAny("コンフォリア・リヴ博労町一丁目Q 406号室", ["コンフォリアリブ博労町一丁目Q 406号室"]));
t("並びのどれにも合わない", !brainNameMatchesAny("ハイツカトレアB・ハイムMK", ["エスリード弁天町パークプレイス 303号室"]));
t("splitBrainNames: 「、」で分ける", JSON.stringify(splitBrainNames("リブリ・スカイブルー ライズ 202、エイペックス神戸みなと元町")) === JSON.stringify(["リブリ・スカイブルー ライズ 202", "エイペックス神戸みなと元町"]));
t("splitBrainNames: 号室つきの「・」は分ける", JSON.stringify(splitBrainNames("ミラージュパレス本町Depart1302・スプランディッド本町グラン1003")) === JSON.stringify(["ミラージュパレス本町Depart1302", "スプランディッド本町グラン1003"]));
t("splitBrainNames: 「／」も分ける", splitBrainNames("ラクラス阿倍野元町 0507／エクセレンス新今宮1202").length === 2);
t("splitBrainNames: 建物名の中の「・」は分けない（コンフォリア・リヴ博労町一丁目Q 406号室）", splitBrainNames("コンフォリア・リヴ博労町一丁目Q 406号室").length === 1);
t("splitBrainNames: 1件はそのまま", splitBrainNames("コンフォリア・リヴ博労町一丁目Q").length === 1);
t("画面用: NEXT_PUBLIC_PROPERTY_NAME_LOOSE_MATCH=off でも止まる", !looseMatchEnabled({ NEXT_PUBLIC_PROPERTY_NAME_LOOSE_MATCH: "off" }));
t("既定の env は process.env.NEXT_PUBLIC_PROPERTY_NAME_LOOSE_MATCH を名指しで読む（画面でビルド時に埋まる）", /process\.env\.NEXT_PUBLIC_PROPERTY_NAME_LOOSE_MATCH/.test(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "property-name-loose.ts"), "utf8")));
t("PROPERTY_NAME_LOOSE_MATCH=off", !looseMatchEnabled({ PROPERTY_NAME_LOOSE_MATCH: "off" }) && looseMatchEnabled({}));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
