// 2026-10-01 竹内（YUMA「住所: 大阪府大阪市北区天満3丁目」）: 待ち合わせ場所の住所は番地まで。無い時はスタッフが確かめる
// 実行: npx tsx app/lib/__tests__/meeting-address.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  hasBanchi, meetingAddressProblem, meetingTextAddressProblem, addressLineInText,
  materialAddressFromPdfText, supplementMeetingAddress, pickupMatchesName, normalizeRadicals,
  MEETING_ADDRESS_NO_BANCHI_MESSAGE,
} from "../meeting-address";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
  };
}

// 実物（スタッフの実送信の「住所:」の行・そのまま）＝ 番地あり
const SENT_OK = [
  "〒541-0052 大阪府大阪市中央区安土町1丁目6-3",
  "〒599-8265 大阪府堺市中区八田西町2-11-11",
  "和泉市山荘町3-10-16",
  "堺市南区野々井121-4",
  "大阪市中央区松屋町住吉4番3",
  "大阪府堺市中区毛穴町96-1",
  "大阪府堺市北区東菅野町1丁目203号",
  "大阪府大阪市中央区本町橋8-1",
  "大阪府大阪市城東区鴫野西4丁目18番13号",
  "大阪府大阪市天王寺区国分町12番9号",
  "大阪府大阪市西区南堀江２丁目1-15",
  "大阪府大阪市西区土佐堀１丁目１−３２ 日宝 リバービル 1F",
  "大阪府池田市井口堂3丁目10-22-A",
  "大阪府池田市建石町4番24-A",
  "大阪府大阪市西区九条１丁目19-10",
  "四條畷市岡山３丁目1-5にお伺いさせていただきます！！",
  "尼崎市武庫之荘8-7-22",
];
// 実物（物件資料 pdf_text の所在地・字のまま）＝ 番地あり
const MATERIAL_OK = [
  "⼤阪府吹⽥市⼭⽥東１丁⽬ -34",
  "⼤阪府⼤阪市中央区⽟造２丁⽬ 25",
  "⼤阪府⼤阪市城東区新喜多東 2 丁⽬ 9 番 18 号",
  "⼤阪府⼤阪市淀川区東三国 4 丁⽬ 193",
  "大阪府和泉市桑原町284",
  "大阪府堺市北区百舌鳥梅町２丁439",
  "大阪府大阪市中央区上町A-2",
  "大阪府大阪市中央区内久宝寺町２丁目7-(1)",
  "大阪府大阪市北区堂島２丁目4",
  "大阪府貝塚市小瀬340",
  "大阪府大阪市福島区玉川３丁目1番20",
  "大阪府堺市堺区海山町４丁168-8",
  "大阪府大阪市北区神山町1-27",
];
// 番地なし（止める）
const NG = [
  "大阪府大阪市北区天満3丁目",            // YUMA 9/30 の実物
  "⼤阪府⼤阪市北区天満３丁⽬",           // 資料 2670 の実物
  "⼤阪府⼤阪市中央区本町橋",
  "⼤阪府東⼤阪市友井４丁⽬",
  "大阪府大阪市中央区谷町２丁目(住居表示未定)",
  "大阪府大阪市平野区喜連３丁目丁目",
  "大阪府和泉市池上町３丁目詳細未定",
  "大阪府大阪市北区",
  "レオパレス天満",
  "大阪府大阪市北区天満3丁目 レオパレス天満 107号室",
  "〒530-0043 大阪府大阪市北区天満3丁目",
  "大阪府大阪市北区天満3丁目 2F",
];

for (const a of SENT_OK) it(`実送信は番地あり: ${a}`, () => expect(hasBanchi(a)).toBe(true));
for (const a of MATERIAL_OK) it(`資料は番地あり: ${a}`, () => expect(hasBanchi(a)).toBe(true));
for (const a of NG) it(`番地なし: ${a}`, () => expect(hasBanchi(a)).toBe(false));

it("住所が空なら今の動きのまま（止めない）", () => {
  expect(meetingAddressProblem("")).toBe(null);
  expect(meetingAddressProblem("   ")).toBe(null);
  expect(meetingAddressProblem(undefined)).toBe(null);
});
it("番地なしは理由を返す", () => expect(meetingAddressProblem("大阪府大阪市北区天満3丁目")).toBe(MEETING_ADDRESS_NO_BANCHI_MESSAGE));
it("番地ありは通す", () => expect(meetingAddressProblem("大阪府大阪市北区天満3丁目1-27")).toBe(null));

const YUMA_TEXT = "かしこまりました！！\n10/2（金）ご案内させて頂きます！！\n\n10/2 14:00にレオパレス天満 107号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: 大阪府大阪市北区天満3丁目";
it("YUMA の本文（実物）は送信で止める", () => expect(meetingTextAddressProblem(YUMA_TEXT)).toBe(MEETING_ADDRESS_NO_BANCHI_MESSAGE));
it("本文から住所の行を取る", () => expect(addressLineInText(YUMA_TEXT)).toBe("大阪府大阪市北区天満3丁目"));
it("住所の行が無い本文は通す", () => expect(meetingTextAddressProblem("10/2 14:00にレオパレス天満 107号室\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！")).toBe(null));
it("番地まである本文は通す", () => expect(meetingTextAddressProblem("6/6 11:00にエステムコート大阪WEST\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: 大阪府大阪市西区九条１丁目19-10")).toBe(null));

it("部首の字だけ直す（全角数字は字のまま）", () => expect(normalizeRadicals("⼤阪府⼤阪市北区天満３丁⽬")).toBe("大阪府大阪市北区天満３丁目"));
it("資料 2670（ITANDI）の所在地は丁目まで", () => {
  const pdf = "が優先になります。\n所在地 ⼤阪府⼤阪市北区天満３丁⽬\nMAP\n交通\nJR 東⻄線 ⼤阪天満宮駅 徒歩 7 分";
  expect(materialAddressFromPdfText(pdf)).toBe("大阪府大阪市北区天満３丁目");
});
it("リアプロの所在地は次の行でも取る", () => {
  expect(materialAddressFromPdfText("物件概要\n所在地\n大阪府大阪市浪速区稲荷１丁目10番24号\n交通")).toBe("大阪府大阪市浪速区稲荷１丁目10番24号");
});
it("ITANDI の空白入りの所在地は空白を詰める", () => {
  expect(materialAddressFromPdfText("所在地 ⼤阪府⼤阪市城東区新喜多東 2 丁⽬ 9 番 18 号\nMAP")).toBe("大阪府大阪市城東区新喜多東2丁目9番18号");
});
it("所在地の次が「交通」なら取らない", () => expect(materialAddressFromPdfText("所在地\n交通\nJR")).toBe(""));

it("丁目までの読み取りを資料の番地で補う（字のまま）", () => {
  expect(supplementMeetingAddress("大阪府大阪市北区天満3丁目", ["大阪府大阪市北区天満３丁目1-27"])).toBe("大阪府大阪市北区天満３丁目1-27");
});
it("資料にも番地が無ければ補わない（スタッフが確かめる）", () => {
  expect(supplementMeetingAddress("大阪府大阪市北区天満3丁目", ["大阪府大阪市北区天満３丁目"])).toBe(null);
});
it("別の町の住所では補わない", () => {
  expect(supplementMeetingAddress("大阪府大阪市北区天満3丁目", ["大阪府大阪市北区神山町1-27"])).toBe(null);
});
it("番地の違う候補が2つなら決めない", () => {
  expect(supplementMeetingAddress("大阪府大阪市北区天満3丁目", ["大阪府大阪市北区天満3丁目1-27", "大阪府大阪市北区天満3丁目2-5"])).toBe(null);
});
it("同じ番地が2行（全角半角違い）なら1つとして補う", () => {
  expect(supplementMeetingAddress("", ["大阪府大阪市北区天満３丁目1-27", "大阪府大阪市北区天満3丁目1-27"])).toBe("大阪府大阪市北区天満３丁目1-27");
});
it("読み取りが既に番地まである時は触らない", () => {
  expect(supplementMeetingAddress("大阪府大阪市北区天満3丁目1-27", ["大阪府大阪市北区天満3丁目9-9"])).toBe(null);
});
it("読み取りに府が無くても頭がそろえば補う", () => {
  expect(supplementMeetingAddress("大阪市北区天満3丁目", ["大阪府大阪市北区天満3丁目1-27"])).toBe("大阪府大阪市北区天満3丁目1-27");
});

it("物件名の照合: 号室付きの読み取りと行の物件名", () => expect(pickupMatchesName("レオパレス天満", "レオパレス天満 107号室")).toBe(true));
it("物件名の照合: 別の物件は違う", () => expect(pickupMatchesName("レオパレス天満", "エステムコート大阪WEST")).toBe(false));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(" - " + f); process.exit(1); }
