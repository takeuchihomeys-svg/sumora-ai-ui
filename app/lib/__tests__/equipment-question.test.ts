// お客様の設備の質問（app/lib/equipment-question.ts）のテスト（自己完結ハーネス）
//
// 2026-09-29 竹内（林田尚貴さん「ガスコンロはついてないのですか？」）「この場合はガスコンロ付きかどうか画像分析をおこなう。設備ついていれば設備や間取りにもあるから」
// 文はすべて実物（scripts/audit-equipment-question.ts・365日・広い候補256通を全部読んだ・当たり21通の誤当たり0）。会話は id の先頭8文字で呼ぶ。
// 資料の文字も実物（林田さんに送った メゾン本庄東 203 の資料の画像から写した設備欄・売上サポの 大阪難波Noah 202 の文字層）。
// 実行: npx tsx app/lib/__tests__/equipment-question.test.ts
import {
  detectEquipmentQuestion, pickEquipmentTargets, resolveEquipAnswer, equipAnswerPlan, buildEquipmentAnswerNote, textItemsFromSheetText, parseSheetEquipText,
  mentionsUnknownBuilding, pickupMaterialUsable,
  type SentPropertyLite, type EquipPropertyAnswer,
} from "../equipment-question";
import { parseListingEquipment, readEquipmentItemsFromText } from "../listing-equipment";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const truthy = (a: unknown, m = "") => { if (!a) throw new Error(`expected truthy ${m}`); };
const falsy = (a: unknown, m = "") => { if (a) throw new Error(`expected falsy ${m}`); };

// ── 当てる（実物21通）──
describe("当てる: 送った物件の設備の質問", () => {
  const yes: Array<[string, string, string[]]> = [
    ["b2fc3867", "ガスコンロはついてないのですか？", ["gas_stove"]],
    ["3a9114ae", "エアコンついてないですよね？", ["aircon"]],
    ["fb6de409", "長居ビルはベランダは無しでしょうか? 洗濯物は部屋干しになりますか？", ["balcony"]],
    ["5fa0e206", "WiFiはどんな感じですか？", ["net_free"]],
    ["7df53628", "上記2点お願いします！ 後、2件ともエアコン付いてるんですかね？", ["aircon"]],
    ["42d635a1", "都市ガスがプロパンガスか分かりますか？？", ["city_gas"]],
    ["5e32a1bb", "この物件も考えています。 エアコンは1台だけでしょうか？", ["aircon"]],
    ["cdf07418", "こっちはインターネット無料ですか？", ["net_free"]],
    ["0bc6c43e", "こちらの物件WiFi着いてますでしょうか", ["net_free"]],
    ["b771af1f", "ここはエアコンないですよね！", ["aircon"]],
    ["b48ad2ca", "ルクレはインターネットは付いてないかんじですか？", ["net_free"]],
    ["b6e6f492", "ありがとうございます！ エアコンはついてないですか？", ["aircon"]],
    ["b5c7f58c", "マンション上層階の物件は、エレベーター有りますか？ エレベーターの記載が無い物は、エレベーター無しと言う事ですかね？", ["elevator"]],
    ["aa0e8331", "お世話になってます！ ガリレオ新町なんですが Wi-Fiって完備されてましたか？", ["net_free"]],
    ["db3722a5", "エアコンは2台着いてるんですか？", ["aircon"]],
    ["9280fa49", "LUMINOUSはインターネット料は別途かかりますよね？", ["net_free"]],
    ["9b9b81ba", "洗濯機置く場所外ですか？", ["laundry_in"]],
    ["d25e07d1", "新大阪ハイツは洗濯機置場はベランダですか？", ["laundry_in"]],
    ["5752c0d1", "宅配ボックスの件だけ確認お願いいたします🙂‍↕️", ["delivery_box"]],
    ["5752c0d1", "WiFiについても聞いてて欲しいです🙇‍♂️😓", ["net_free"]],
  ];
  for (const [id, text, topics] of yes) it(`${id} ${text.slice(0, 24)}`, () => eq(detectEquipmentQuestion(text)?.topics, topics));
});

// ── 当てない（実物・探す条件／入居後の困りごと／手続き／感想／取付の相談）──
describe("当てない: 設備の有無の質問ではない", () => {
  const no: Array<[string, string]> = [
    ["57d1c516", "お世話になっております お部屋ミナミ周辺(徒歩15分圏内)で、オートロック、バストイレ別、独立洗面台ワンルームで探せますか？"],
    ["1ab7e49c", "大阪市内でしたら、北区中津が希望です。安くておしゃれで、オートロック完備物件。お願いします。&エレベーター必須です。anny"],
    ["5254182a", "7月1日以降の入居でお願いします！ ガスコンロプレゼントとは頂けるのでしょうか？"],
    ["7df53628", "エアコンないので…すいませんが…"],
    ["7beca4f5", "リフォームというのは 水回りやエアコンだったりの設備が新しくなるということでしょうか？？"],
    ["3befa412", "物件情報ありがとうございます。 内代の物件かなりいいとおもいましたが、3ヶ月の赤ちゃんがいるのでエレベーターがないと移動が大変かなとおもいました。"],
    ["77b29095", "ガスコンロついてないのは厳しいです"],
    ["8b5a777e", "ありがとうございます🙇🏻‍♀️ トイレと洗面所別の物件は高くなってしまいますか？"],
    ["b380d0e3", "コンロのところ少し大きめで広くがいいなって思うんですけど中々ないですよね、、、"],
    ["f193d13d", "調べて画像見たのですが広くて綺麗そうなのですがエレベーターないのできついです😭"],
    ["58ae93f3", "今空いてないとは思うんですが、ここの2階のこの部屋もエアコン取付不可ですかね"],
    ["ae3ffecb", "ありがとうございます🙇‍♂️ リビングにクーラー取り付けられるか分かりますでしょうか？"],
    ["bad8b9a4", "お疲れ様です！ IHが点滅だけしてすぐ消えてしまうんですがどうしたらいいですか？"],
    ["60e6d3ab", "わかりました。 KANOACIAのガスコンロのメーカーと型番わかりますか？ 教えてほしいです！ 汚れ防止のための買いたいので💦"],
    ["5fa0e206", "あと、ガスや電気は指定はありますか？"],
    ["1db7b08d", "洗濯機って何センチで何キロまでとかって分かりますか？"],
    ["331b0338", "阪神本線、阪神なんば線でできるだけ尼崎エリアよりで探してもらえたらうれしいです。 独立洗面がなくてもお風呂トイレ別は可能ですか？"],
    ["74f823d3", "宅配ボックスの番号も教えてほしいです。"],
    ["e68fd1e2", "バルコニーを必要としていないので、丁度いいかもしれなくて。"],
    ["29551794", "【お部屋お探し中！】 （ご希望のお部屋探しご条件） ①【ご入居の時期】⇒7月 ⑧【その他ご要望あれば】⇒バストイレ別・オートロックありますか？"],
  ];
  for (const [id, text] of no) it(`${id} ${text.slice(0, 24)}`, () => falsy(detectEquipmentQuestion(text), JSON.stringify(detectEquipmentQuestion(text))));
});

// ── どの物件の話か（林田さんの実物: 09:00 に物件ピックアップ2件・09:03 に🌟メゾン本庄東 → 09:07 の質問）──
const HAYASHIDA_SENT: SentPropertyLite[] = [
  { property_name: "エステムプラザ梅田・扇町パークランド", room_no: "706", channel: "staff_image", created_at: "2026-09-28T09:33:57.101Z", image_url: "u4" },
  { property_name: "メゾン本庄東", room_no: "203", channel: "recommendation", created_at: "2026-09-28T09:03:08.153Z", image_url: "u3" },
  { property_name: "MSR天満東", room_no: "506", channel: "pickup", created_at: "2026-09-28T09:00:19.548Z", image_url: "u1" },
  { property_name: "メゾン本庄東", room_no: "203", channel: "pickup", created_at: "2026-09-28T09:00:18.014Z", image_url: "u2" },
];
describe("どの物件の話か（決定論）", () => {
  it("林田さん: 直前の🌟メゾン本庄東が先頭・同じまとまりの MSR天満東 も（質問より後に送った物件は見ない）", () => {
    const t = pickEquipmentTargets("ガスコンロはついてないのですか？", HAYASHIDA_SENT, { askedAt: "2026-09-28T09:07:23.630Z" });
    eq(t.map((x) => `${x.property_name}|${x.by}`), ["メゾン本庄東|latest", "MSR天満東|same_batch"]);
  });
  it("名前を出したらその物件だけ", () => {
    const t = pickEquipmentTargets("MSR天満東はガスコンロついてますか？", HAYASHIDA_SENT, { askedAt: "2026-09-28T09:07:23.630Z" });
    eq(t.map((x) => `${x.property_name}|${x.by}`), ["MSR天満東|name"]);
  });
  it("引用した画像の物件だけ", () => {
    const t = pickEquipmentTargets("ここはエアコンありますか？", HAYASHIDA_SENT, { askedAt: "2026-09-28T09:07:23.630Z", quotedImageUrl: "u1" });
    eq(t.map((x) => `${x.property_name}|${x.by}`), ["MSR天満東|quote"]);
  });
  it("14日より前の送付は見ない", () => {
    eq(pickEquipmentTargets("エアコンありますか？", HAYASHIDA_SENT, { askedAt: "2026-10-20T00:00:00Z" }), []);
  });
  // 2026-09-29 反証
  it("送った物件に無い建物名（8/27 ad469d13「プレジオグループでは使用WiFiは統一…」）→ 直前の物件に倒さない", () => {
    eq(pickEquipmentTargets("プレジオグループでは使用WiFiは統一されておられるのでしょうか?", HAYASHIDA_SENT, { askedAt: "2026-09-28T09:07:23.630Z" }), []);
  });
  it("設備・住まいの一般のカタカナ語だけなら直前の物件（林田さん・ガスコンロ／WiFi／オートロック）", () => {
    for (const q of ["ガスコンロはついてないのですか？", "WiFiはどんな感じですか？", "オートロックとエレベーターはありますか？", "インターネットは無料ですか？"]) {
      eq(pickEquipmentTargets(q, HAYASHIDA_SENT, { askedAt: "2026-09-28T09:07:23.630Z" })[0]?.by, "latest");
    }
  });
  it("直前の送付より後にお客様が画像を送っていたら倒さない（お客様が見つけた物件かもしれない）", () => {
    eq(pickEquipmentTargets("ガスコンロはついてますか？", HAYASHIDA_SENT, { askedAt: "2026-09-28T09:07:23.630Z", customerImageAts: ["2026-09-28T09:05:00Z"] }), []);
  });
  it("お客様の画像が直前の送付より前なら今まで通り", () => {
    eq(pickEquipmentTargets("ガスコンロはついてますか？", HAYASHIDA_SENT, { askedAt: "2026-09-28T09:07:23.630Z", customerImageAts: ["2026-09-28T08:00:00Z"] })[0]?.by, "latest");
  });
  it("mentionsUnknownBuilding: 送った名前に含まれる語は数えない", () => {
    falsy(mentionsUnknownBuilding("MSR天満東はガスコンロついてますか？", ["MSR天満東"]));
    truthy(mentionsUnknownBuilding("エスリードはエアコンありますか？", ["メゾン本庄東"]));
  });
  it("号室が無い時の売上サポの資料は建物単位の設備だけ", () => {
    truthy(pickupMaterialUsable(["washbasin"], "203"));
    falsy(pickupMaterialUsable(["washbasin"], null));
    truthy(pickupMaterialUsable(["autolock", "elevator"], null));
    falsy(pickupMaterialUsable(["autolock", "aircon"], ""));
  });
});

// ── 資料から有無を決める ──
// メゾン本庄東 203（林田さんに送った資料の画像から写した設備欄・2026-09-29 の DeepSeek の返事のまま）
const HONJO_EQTEXT = "【キッチン】給湯器・ガスコンロ【水廻り】シャワートイレ【冷暖房】エアコン【放送・通信】光ファイバー・インターネット対応【セキュリティ】管理人（巡回）・防犯カメラ・インターホン（カメラ付き）【その他】専用ごみ置場・エレベーター・ガス（都市ガス）・水道（公営）・排水（公共下水）・バルコニー／ベランダ・照明";
// 大阪難波Noah 202（売上サポ property_pickups id 1726 の文字層の設備欄。竹内さんのスクショの 802 は売上サポに行が無く、同じ建物の 202 で確かめる）
const NOAH_PDF = `物件種目 [住居用] マンション
物件名 大阪難波Noah
号室名 202（2階部分）
所在地
大阪府大阪市浪速区稲荷１丁目10番24号
建築構造 鉄筋コンクリート造 地上11階 総戸数60戸
間取タイプ 1K[洋:6畳]
専有面積 20.99㎡ 開口部方位 西
備 考
設 備
【キッチン】 給湯器・ガスコンロ（2口）・システムキッチン 【水廻り】
トイレ・浴室乾燥機・シャワートイレ・洗髪洗面化粧台・バス・トイレ別 【
冷暖房】 エアコン 【収納】 シューズボックス 【放送・通信】 インターネ
ット対応・ネット使用料不要 【セキュリティ】 オートロック・宅配BOX・管
理人（巡回）・防犯カメラ・インターホン（カメラ付き） 【その他】 エレ
ベーター（1基）・ガス（都市ガス）・水道（公営）・排水（公共下水）・バ
ルコニー／ベランダ・24時間換気システム・フローリング
条 件
【条件】 保証人不要・保証会社利用必須
取引態様：媒介`;

describe("資料から有無を決める（実物の資料）", () => {
  const honjo = textItemsFromSheetText({ see: "", equip_text: HONJO_EQTEXT });
  it("メゾン本庄東: 設備欄に「ガスコンロ」でも listed（付いているとは言い切れない＝実送信は入居後に設置）", () => {
    const a = resolveEquipAnswer("gas_stove", { text: honjo, textLabel: "資料の画像の設備欄" });
    eq(a.verdict, "listed"); eq(a.basis, ["資料の画像の設備欄「ガスコンロ」"]);
  });
  it("MSR天満東: 設備欄が空 → unknown（記載なし＝無いとは限らない・実物は2口のガスコンロ）", () => {
    const a = resolveEquipAnswer("gas_stove", { text: textItemsFromSheetText({ see: "", equip_text: "" }), textLabel: "資料の画像の設備欄" });
    eq(a.verdict, "unknown");
  });
  it("メゾン本庄東: エアコンは設備欄に書いてある → yes", () => eq(resolveEquipAnswer("aircon", { text: honjo }).verdict, "yes"));
  it("メゾン本庄東: インターネット無料は書いていない（「インターネット対応」だけ）→ unknown", () => eq(resolveEquipAnswer("net_free", { text: honjo }).verdict, "unknown"));
  const noah = parseListingEquipment(NOAH_PDF).items;
  it("大阪難波Noah: ガスコンロ（2口）→ listed〔2口〕（コンロは写真で確かめる）", () => {
    const a = resolveEquipAnswer("gas_stove", { text: noah });
    eq([a.verdict, a.detail], ["listed", "2口"]);
  });
  it("大阪難波Noah: 口数を聞かれても listed〔2口〕", () => eq(resolveEquipAnswer("burners", { text: noah }).detail, "2口"));
  it("大阪難波Noah: ネット使用料不要 → yes", () => eq(resolveEquipAnswer("net_free", { text: noah }).verdict, "yes"));
  it("大阪難波Noah: 独立洗面台は「洗髪洗面化粧台（独立の記載なし）」→ unknown（無いとは言わない）", () => {
    const a = resolveEquipAnswer("washbasin", { text: noah });
    eq(a.verdict, "unknown"); truthy(a.basis[0].includes("独立の記載なし"));
  });
  it("バス・トイレ別: 設備欄 ok でも間取り図が同室なら conflict", () => {
    eq(resolveEquipAnswer("bath_toilet", { text: noah, plan: { water: { bath_toilet: "同室" } } }).verdict, "conflict");
  });
  it("間取り図だけで「有る」とは言わない（設備欄に記載なし・図は別）→ unknown", () => {
    eq(resolveEquipAnswer("bath_toilet", { text: honjo, plan: { water: { bath_toilet: "別" } } }).verdict, "unknown");
  });
  it("オール電化と書いてあればガスコンロは no（本文で断言はしない＝confirm）", () => {
    eq(resolveEquipAnswer("gas_stove", { text: readEquipmentItemsFromText("【キッチン】IHクッキングヒーター・オール電化") }).verdict, "no");
  });
  it("資料を読めなかった → unknown", () => eq(resolveEquipAnswer("aircon", { text: null }).verdict, "unknown"));
});

describe("答え方と材料の文", () => {
  const honjo = textItemsFromSheetText({ see: "", equip_text: HONJO_EQTEXT });
  const props = (topics: Array<"gas_stove" | "aircon">): EquipPropertyAnswer[] => [
    { name: "メゾン本庄東", roomNo: "203", by: "latest", materialRead: true, answers: topics.map((t) => resolveEquipAnswer(t, { text: honjo, textLabel: "資料の画像の設備欄" })) },
  ];
  it("林田さん: コンロ → confirm・コンロは写真で確かめる（室内写真を確認した）の案内", () => {
    const plan = equipAnswerPlan(props(["gas_stove"]));
    eq([plan.mode, plan.stoveAsked], ["confirm", true]);
    const note = buildEquipmentAnswerNote(plan);
    truthy(note.includes("メゾン本庄東 203号室（直前にお送りした物件）"));
    truthy(note.includes("有無を断言しない"));
    truthy(note.includes("室内写真を確認した"));
  });
  it("エアコンだけ（設備欄に有る）→ answer・本文で答えてよい", () => {
    const plan = equipAnswerPlan(props(["aircon"]));
    eq(plan.mode, "answer");
    truthy(buildEquipmentAnswerNote(plan).includes("備わったお部屋となります"));
  });
  it("物件が無ければ文は空", () => eq(buildEquipmentAnswerNote(equipAnswerPlan([])), ""));
});

describe("設備欄の文字の読み取りの返事", () => {
  it("そのまま読む・空白は詰める", () => eq(parseSheetEquipText('{"see":"左の表","equip_text":"【キッチン】 給湯器・ガスコンロ\\n【水廻り】"}'), { see: "左の表", equip_text: "【キッチン】 給湯器・ガスコンロ 【水廻り】" }));
  it("欄が空は \"\"（読めた）", () => eq(parseSheetEquipText('{"see":"","equip_text":""}')?.equip_text, ""));
  it("崩れていれば null（読み直し）", () => { eq(parseSheetEquipText("すみません"), null); eq(parseSheetEquipText('{"see":"x"}'), null); });
});

// 2026-09-29 反証: 設備欄・備考の「〇〇なし」を ok（有る）と読み、本文で「備わったお部屋」と答えてよい材料になっていた
describe("否定の書き方（「〇〇なし」を有ると読まない）", () => {
  const st = (text: string, key: Parameters<typeof resolveEquipAnswer>[0]) => resolveEquipAnswer(key, { text: readEquipmentItemsFromText(text) }).verdict;
  it("エアコンなし → no", () => eq(st("設備: エアコンなし、フローリング", "aircon"), "no"));
  it("オートロック無し → no（実物 #1402「※オートロック無しの場合は…キーボックス」）", () => eq(st("※オートロック無しの場合は、キーボックス対応", "autolock"), "no"));
  it("宅配BOXなし → no", () => eq(st("宅配BOXなし", "delivery_box"), "no"));
  it("独立洗面台なし → no", () => eq(st("独立洗面台なし・バストイレ別", "washbasin"), "no"));
  it("追焚なし → no", () => eq(st("追焚なし", "reheating"), "no"));
  it("浴室乾燥機無 → no", () => eq(st("浴室乾燥機無", "bath_dryer"), "no"));
  it("室内洗濯機置場なし → no", () => eq(st("室内洗濯機置場なし", "laundry_in"), "no"));
  it("エアコン(残置) → unknown（前の入居者の物で設備ではない）", () => eq(st("エアコン(残置)", "aircon"), "unknown"));
  it("エアコン（2台） → yes のまま", () => eq(st("エアコン（2台）", "aircon"), "yes"));
  it("否定が隣の語なら当てない（エアコン・浴室乾燥機無 → エアコンは yes）", () => eq(st("エアコン・浴室乾燥機無", "aircon"), "yes"));
  it("インターネット無料は yes のまま（「無料」は否定ではない）", () => eq(st("インターネット無料", "net_free"), "yes"));
  it("否定があれば答えの形は「確認させて頂きます」（本文で答えない）", () => {
    const plan = equipAnswerPlan([{ name: "X", roomNo: "101", by: "name", materialRead: true, answers: [resolveEquipAnswer("aircon", { text: readEquipmentItemsFromText("エアコンなし") })] }]);
    truthy(plan.mode !== "answer", JSON.stringify(plan));
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
