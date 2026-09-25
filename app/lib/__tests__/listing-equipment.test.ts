// 物件資料の文字層から「所在階・設備」を決定論で読む・お客様の設備の希望と照らす（純関数）のテスト
// 実行: npx tsx app/lib/__tests__/listing-equipment.test.ts
// 文字は 2026-09-24 の実物（property_pickups の pdf_blob_url の1ページ目の文字層）の抜粋をそのまま使う（康熙部首の字・「‧」・行の割れも元のまま）。
// 会社の電話・保証会社の文は外してある。お客様の名前・電話番号は無い
import {
  floorFromRoom, isBasementRoom, parseListingEquipment, mergeBuildingEquipment, parseEquipmentWants, matchEquipment,
  formatEquipmentMatch, buildEquipmentAskPrompt, EQUIPMENT_ASK_SYSTEM, BUILDING_KEYS, type ListingEquipment,
} from "../listing-equipment";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}

// ───────── 実物の抜粋（itandi・HONOKA さんの回 id 50〜67） ─────────
const IT58 = `仲介
エステムコート新⼤阪 Ⅵ エキスプレイス 907 号室
画像情報なし
所在地 ⼤阪府⼤阪市淀川区⻄宮原１丁⽬ 7-46
MAP
交通
⼤阪メトロ御堂筋線 新⼤阪駅 徒歩 8 分
賃料 60,000 円 管理費‧共益費 8,000 円
間取り 1K 専有⾯積 20.8 ㎡
構造 鉄筋コンクリート 階建 / 総⼾数 15 階建 / 180 ⼾
所在階 9 階 主要採光⾯ 東向き
駐⾞場 ー 駐⾞場代 ー
設備
⽔道公営 , 都市ガス , 排⽔下⽔ , バス‧トイレ別 , 暖房便座 , 浴室乾燥機 , 独⽴洗⾯台 , 室内
洗濯機置場 , システムキッチン , ２⼝コンロ , ガスコンロ , エアコン , 収納スペース ,
シューズボックス , インターネット無料 , オートロック , モニタ付インターホン , ディンプ
ルキー , ダブルロックキー , エレベーター , 駐輪場 , バイク置き場 , 分譲タイプ , 宅配 BOX,
敷地内ごみ置き場 , ペット相談 , ペット対応 , 防犯カメラ
備考
ー`;
const IT51 = `仲介
プレサンス新⼤阪ザ‧シティ 104 号室
所在地 ⼤阪府⼤阪市東淀川区東中島 4 丁⽬ 1-39
交通
JR 京都線 新⼤阪駅 徒歩 5 分
構造 鉄筋コンクリート 階建 / 総⼾数 15 階建 / ー
所在階 1 階 主要採光⾯ 南東向き
駐⾞場 ー 駐⾞場代 ー
設備
都市ガス , バス‧トイレ別 , 独⽴洗⾯台 , 室内洗濯機置場 , 洗濯機置場 , シ
ステムキッチン , ２⼝コンロ , エアコン , 収納スペース , シューズボック
ス , オートロック , モニタ付インターホン , 防犯カメラ , 24 時間セキュリ
ティー , フローリング , バルコニー , 分譲タイプ , 敷地内ごみ置き場 , 外国
籍可
備考
‧個⼈申込の場合、「電⼦契約くん」でご契約いただきます。`;
const IT65 = `仲介
エスティライフ新⼤阪第 2 106 号室
所在地 ⼤阪府⼤阪市東淀川区東中島５丁⽬ 28-2
構造 鉄筋コンクリート 階建 / 総⼾数 3 階建 / 29 ⼾
所在階 1 階 主要採光⾯ 南向き
駐⾞場 なし 駐⾞場代 なし
設備
排⽔下⽔ , 専⽤バス , バス‧トイレ別 , 温⽔洗浄便座 , シャワー , 浴室乾燥
機 , 独⽴洗⾯台 , 室内洗濯機置場 , システムキッチン , オール電化 , ２⼝コ
ンロ , ガスコンロ , 給湯 , エアコン , シューズボックス , オートロック , モニ
タ付インターホン , フローリング , バルコニー , 駐輪場 , 単⾝限定 , 保証⼈
不要
備考
ー`;
const IT50 = `仲介
エステムコート新⼤阪 Ⅵ エキスプレイス 405 号室
所在地 ⼤阪府⼤阪市淀川区⻄宮原 1 丁⽬ 7-46
構造 鉄筋コンクリート 階建 / 総⼾数 15 階建 / ー
所在階 4 階 主要採光⾯ ⻄向き
駐⾞場 ー 駐⾞場代 ー
設備
都市ガス , バス‧トイレ別 , 独⽴洗⾯台 , 室内洗濯機置場 , 洗濯機置場 , シ
ステムキッチン , ２⼝コンロ , エアコン , 収納スペース , シューズボック
ス , オートロック , モニタ付インターホン , 防犯カメラ , フローリング , バ
ルコニー , 分譲タイプ , 敷地内ごみ置き場 , ペット相談 , ペット対応 , 外国
籍可
備考
‧ペット備考 成獣の状態で概ね体⻑ 50 センチ ( ⾸から尾の付け根迄 ) 程度
の⽝‧猫で⼀住⼾ 2 匹以内とする。`;
const IT55 = `仲介
エステムコート新⼤阪 Ⅵ エキスプレイス 710 号室
所在地 ⼤阪府⼤阪市淀川区⻄宮原１丁⽬ 7-46
構造 鉄筋コンクリート 階建 / 総⼾数 15 階建 / 108 ⼾
所在階 7 階 主要採光⾯ ー
駐⾞場 ー 駐⾞場代 ー
設備
⽔道公営 , 都市ガス , 専⽤バス , 専⽤トイレ , バス‧トイレ別 , 洗濯機置場 ,
カウンターキッチン , オートロック , モニタ付インターホン , 防犯カメラ ,
外国籍可 , 保証⼈不要
備考
申込、内⾒予約はいえらぶ BB よりお願い致します。`;
const IT64 = `仲介
エスティライフ新⼤阪第 2 309 号室
画像情報なし
所在地 ⼤阪府⼤阪市東淀川区東中島５丁⽬ 28-2
構造 鉄筋コンクリート 階建 / 総⼾数 3 階建 / 30 ⼾
所在階 3 階 主要採光⾯ ー
駐⾞場 なし 駐⾞場代 なし
設備
⽔道公営 , 排⽔下⽔ , 専⽤バス , バス‧トイレ別 , 温⽔洗浄便座 , シャワー , 浴室乾燥
機 , 室内洗濯機置場 , システムキッチン , オール電化 , エアコン , シューズボックス ,
オートロック , モニタ付インターホン , 防犯カメラ , バルコニー , 駐輪場 , バイク置
き場 , 最上階 , 分譲タイプ , 宅配 BOX, 敷地内ごみ置き場 , 保証⼈不要
備考
【駐輪場、バイク置場、駐⾞場付きの物件について】⾦額、空き状況等
は、建物管理会社へお問い合わせください。`;
const IT53 = `仲介
プレサンス新⼤阪クレスタ 709 号室
構造 鉄筋コンクリート 階建 / 総⼾数 15 階建 / 124 ⼾
所在階 7 階 主要採光⾯ ー
駐⾞場 空きなし 敷地内 駐⾞場代 なし
設備
⽔道公営 , 都市ガス , 排⽔下⽔ , 専⽤バス , バス‧トイレ別 , シャワー , 室内洗濯
機置場 , システムキッチン , エアコン , シューズボックス , インターネット無
料 , オートロック , モニタ付インターホン , 防犯カメラ , エレベーター , バルコ
ニー , 駐輪場 , 分譲タイプ , 宅配 BOX, 敷地内ごみ置き場 , 外国籍可 , 保証⼈不
要
備考
【駐輪場、バイク置場、駐⾞場付きの物件について】⾦額、空き状況等
は、建物管理会社へお問い合わせください。`;
const IT62 = `仲介
アドバンス新⼤阪ウエストゲート 506 号室
構造 鉄筋コンクリート 階建 / 総⼾数 12 階建 / 88 ⼾
所在階 5 階 主要採光⾯ 東向き
駐⾞場 空きあり 敷地内 駐⾞場代 ー
設備
⽔道公営 , 都市ガス , バス‧トイレ別 , 温⽔洗浄便座 , シャワー , 浴室乾燥機 , 独⽴洗⾯台 , 三⾯鏡付
き洗⾯化粧台 , システムキッチン , ガスコンロ可 , ２⼝コンロ , エアコン , シューズボックス , BS 端
⼦ , CATV, CS, インターネット対応 , インターネット無料 , オートロック , モニタ付インターホン ,
ディンプルキー , 防犯カメラ , 24 時間セキュリティー , 保証⼈不要 , エレベーター , 駐輪場 , バイク
置き場 , 宅配 BOX, 敷地内ごみ置き場 , 24 時間ゴミ出し可
備考
550 円 ( 税込 ) （毎⽉）`;

// ───────── 実物の抜粋（リアプロ） ─────────
const RP_HEAD = (name: string, room: string, struct: string, dir = "") => `出力日:2026/09/24 18:01:19 / 次回更新予定日:2026/10/08 ※掲載情報は随時更新される場合がございます。 Powered by RealNetPro co.,ltd.
※ この資料は物件の概略紹介資料になります。写真、間取図面、設備、概要などが現況と異なる場合は現況優先となります。
物件種目 [住居用] マンション
物件名 ${name}
号室名 ${room}
建築構造 ${struct}
間取タイプ 1K
専有面積 25.62㎡ 開口部方位${dir}`;
// id 36 スプランディッド難波WEST: 「エレベータ 各階有」「宅配ボックス 暗証番号」
const RP36 = `${RP_HEAD("スプランディッド難波WEST", "0303（3階部分）", "鉄筋コンクリート造 地上15階 総戸数56戸", " 東")}
町内会費
駐車場
備 考
宅配ボックス 暗証番号 ・ エレベータ 各階有 ・ 冷暖房 全室設置済
設 備
【キッチン】 給湯器（ガス）・ガスコンロ・システムキッチン 【水廻り】
風呂・バス・トイレ別・洗濯機置場（室内） 【収納】 シューズボックス 【
放送・通信】 ネット使用料不要 【セキュリティ】 オートロック・宅配BOX
【その他】 エレベーター・オートバイ駐輪場・自転車置場・バルコニー／ベ
ランダ
条 件
【条件】 ペット相談・保証会社利用必須
取引態様：媒介`;
// id 37 エスリード難波AGREA 1303: 「2F以上」「洗面所独立」「オ\nートロック」
const RP37 = `${RP_HEAD("エスリード難波AGREA", "1303（13階部分）", "鉄筋コンクリート造 地上15階 総戸数98戸", " 北")}
エスリード建物管理株式会社 駐車場
備 考
眺望良好・前面棟無・5階建以上・2F以上・クッションフロア・インターネッ
ト専用線各部屋配線済み・ガスキッチン・シャワー・脱衣所・暖房便座・洗
面化粧台・洗面所・洗面所独立・洗面所にドア・クロゼット・人感照明セン
サー・セキュリティ有り・カードキー・ドアタッチキー・電子ロック・電子キ
ー・当社管理物件
設 備
【キッチン】 給湯器（ガス）・ガスコンロ 【水廻り】 風呂・トイレ・洗
面台・浴室乾燥機・シャワートイレ・バス・トイレ別・洗濯機置場（室内）
【冷暖房】 エアコン 【収納】 シューズボックス 【放送・通信】 ＢＳ・Ｃ
Ｓ・ケーブルTV・ネット使用料不要・高速ネット対応 【セキュリティ】 オ
ートロック・宅配BOX・防犯カメラ・インターホン（カメラ付き） 【その他
】 専用ごみ置場・エレベーター・ガス（都市ガス）・排水（公共下水）・24
時間換気システム・フローリング
条 件
【条件】 ペット相談・保証人不要・保証会社利用必須
取引態様：媒介`;
// id 43 エスリード難波AGREA 905: 「風呂（ユニットバス）」と「バス・ト\nイレ別」が両方
const RP43 = `${RP_HEAD("エスリード難波AGREA", "905（9階部分）", "鉄筋コンクリート造 地上15階 総戸数98戸", " 北")}
備 考
5階建以上・インターネット専用線各部屋配線済み・暖房便座・洗面所・洗面
所独立・洗面所にドア・クロゼット・カードキー・ドアタッチキー・電子ロッ
ク・電子キー
設 備
【水廻り】 風呂（ユニットバス）・浴室乾燥機・シャワートイレ・バス・ト
イレ別・洗濯機置場（室内） 【冷暖房】 エアコン 【放送・通信】 ＢＳ・
ＣＳ・ネット使用料不要 【セキュリティ】 オートロック・宅配BOX・防犯カ
メラ・インターホン（カメラ付き） 【その他】 専用ごみ置場・エレベータ
ー・ガス（都市ガス）・排水（公共下水）・フローリング
条 件
【条件】 ペット相談・保証人不要・保証会社利用必須
取引態様：媒介`;
// id 3 Abelia: 「洗面台（独立）」「角部屋」「ペット可」「駐車場情報:なし」・鉄骨造
const RP3 = `${RP_HEAD("Abelia(アベリア)", "301号室（3階部分）", "鉄骨造 地上5階 総戸数19戸", " 北")}
町内会費
なし
なし 駐車場情報:なし自転車置場:有
駐車場
備 考
クリーニング特約有 短期違約金有 ペット可(小型犬か猫どちらか1匹迄)
インターネット無料
●ペット飼育可 / 事務所使用不可
設 備
【位置】 角部屋 【キッチン】 IHクッキングヒーター（3口以上）・システ
ムキッチン・カウンターキッチン 【水廻り】 洗面台（独立）・浴室乾燥機
・シャワートイレ・バス・トイレ別・洗濯機置場（室内） 【冷暖房】 エア
コン（冷暖房） 【収納】 シューズボックス 【放送・通信】 光ファイバー
【セキュリティ】 オートロック・管理人（巡回）・インターホン（カメラ
付き） 【その他】 エレベーター・自転車置場・ガス（都市ガス）・水道（公
営）・排水（公共下水）・バルコニー／ベランダ
条 件
【条件】 ペット相談・保証人不要・保証会社利用必須
取引態様：媒介
特記事項：
ペット飼育時賃料2,000円アップ`;
// id 38 エスリード難波AGREA 1107: 「角住戸(角地)」
const RP38 = RP37.replace("1303（13階部分）", "1107（11階部分）").replace("5階建以上・2F以上", "5階建以上・角住戸(角地)・2F以上");
// id 34 エグゼ難波南VI: 「敷地内駐車場／空きなし」「洗髪洗面化粧台」（独立とは書いていない）
const RP34 = `${RP_HEAD("エグゼ難波南VI", "0403（4階部分）", "鉄筋コンクリート造 地上12階 総戸数44戸", " 北")}
町内会費
敷地内駐車場／空きなし 駐車場
備 考
屋根構造: 陸屋根、■Refaシャワーヘッド標準設置 ■フリーレント1ヶ月
■ペット相談可 ■連帯保証人不要 ■敷金礼金
設 備
【キッチン】 給湯器 【水廻り】 洗面台・浴室乾燥機・洗髪洗面化粧台・バ
ス・トイレ別・洗濯機置場（室内） 【冷暖房】 エアコン 【収納】 シューズ
ボックス 【セキュリティ】 オートロック・宅配BOX・防犯カメラ 【その他
】 エレベーター・オートバイ駐輪場・自転車置場・電気・ガス（都市ガス）・
バルコニー／ベランダ・照明・フローリング
条 件
【条件】 ペット相談・外国人契約可能・保証会社利用必須
取引態様：媒介`;
// 竹内さんが貼った HR FRONT REGAL ドームウエストの設備欄（号室名 0901（9階部分）・地上10階）
const RP_HR = `${RP_HEAD("HR FRONT REGAL ドームウエスト", "0901（9階部分）", "鉄筋コンクリート造 地上10階")}
備 考
設 備
【キッチン】IHクッキングヒーター【水廻り】トイレ・シャワートイレ・洗髪洗面化粧台・バス・トイレ別・洗濯機置場（室内）【冷暖房】エアコン【収納】シューズボックス【放送・通信】ネット使用料不要【セキュリティ】オートロック・宅配BOX・管理人（日勤）・インターホン（カメラ付き）【その他】エレベーター・自転車置場
条 件
【条件】 保証会社利用必須
取引態様：媒介`;

// ───────── 号室 → 階 ─────────
console.log("■ 号室から階");
{
  const cases: Array<[string | null, number | null]> = [
    ["202", 2], ["301", 3], ["1001", 10], ["0901", 9], ["1512", 15], ["405", 4], ["907", 9], ["104", 1], ["3A", 3],
    ["1F-2", 1], ["3F", 3], ["B101", null], ["B-02", null], ["地下101", null], ["12", null], ["5", null], ["", null], [null, null],
    ["301号室", 3], ["０９０１", 9], ["A棟301", 3], ["A-203", 2], ["0303", 3],
  ];
  for (const [room, want] of cases) { const got = floorFromRoom(room); t(`floorFromRoom(${JSON.stringify(room)}) = ${want}`, got === want, got); }
  t("B101 は地下", isBasementRoom("B101") && !isBasementRoom("B棟101") && !isBasementRoom("101"));
}

// ───────── itandi ─────────
console.log("■ itandi の設備欄");
const f58 = parseListingEquipment(IT58);
{
  t("#58 形は itandi・名前と号室", f58.format === "itandi" && f58.room === "907" && /エステムコート新大阪/.test(f58.name ?? ""), [f58.format, f58.name, f58.room]);
  t("#58 所在階 9（表から）・15階建", f58.floor === 9 && f58.floorSource === "所在階" && f58.totalFloors === 15 && f58.roomFloor === 9, [f58.floor, f58.floorSource, f58.totalFloors]);
  for (const k of ["elevator", "delivery_box", "autolock", "net_free", "bath_toilet", "washbasin", "laundry_in", "floor2", "system_kitchen", "burner2", "shoebox"] as const)
    t(`#58 ${k} ok`, f58.items[k].status === "ok", f58.items[k]);
  t("#58 宅配 BOX の空白を吸収（根拠は「宅配BOX」）", f58.items.delivery_box.evidence === "宅配BOX", f58.items.delivery_box);
  t("#58 行をまたいだ「室内\\n洗濯機置場」も読む", f58.items.laundry_in.evidence === "室内洗濯機置場", f58.items.laundry_in);
  t("#58 ペット相談", f58.items.pet.status === "ok" && f58.items.pet.detail === "相談", f58.items.pet);
  t("#58 駐車場「ー」は unlisted", f58.items.parking.status === "unlisted", f58.items.parking);
  t("#58 東向き → 南向きは ng（向きの欄がある）", f58.items.south.status === "ng" && f58.items.south.evidence === "主要採光面 東向き", f58.items.south);
}
{
  const f51 = parseListingEquipment(IT51);
  t("#51 所在階 1 → 2階以上 ng（根拠「所在階 1階」）", f51.floor === 1 && f51.items.floor2.status === "ng" && f51.items.floor2.evidence === "所在階 1階", f51.items.floor2);
  t("#51 エレベーターは書いていない → unlisted（15階建でも ng にしない）", f51.items.elevator.status === "unlisted");
  t("#51 南東向き → 南向き ok", f51.items.south.status === "ok");
  const f65 = parseListingEquipment(IT65);
  t("#65 所在階 1 → 2階以上 ng", f65.floor === 1 && f65.items.floor2.status === "ng");
  t("#65 駐車場 なし → ng（なし）", f65.items.parking.status === "ng" && f65.items.parking.detail === "なし", f65.items.parking);
  t("#65 単身限定 → 二人入居 ng", f65.items.two_person.status === "ng" && f65.items.two_person.evidence === "単身限定", f65.items.two_person);
  t("#65 保証⼈\\n不要 → 保証人不要 ok", f65.items.no_guarantor.status === "ok");
}
{
  const f55 = parseListingEquipment(IT55);
  t("#55 独立洗面は書いていない → unlisted", f55.items.washbasin.status === "unlisted", f55.items.washbasin);
  t("#55 場所の無い「洗濯機置場」→ 室内洗濯機置場 unlisted（手がかり付き）", f55.items.laundry_in.status === "unlisted" && !!f55.items.laundry_in.hint, f55.items.laundry_in);
  t("#55 カウンターキッチン ok", f55.items.counter_kitchen.status === "ok");
  t("#55 採光面「ー」→ 南向き unlisted", f55.items.south.status === "unlisted", f55.items.south);
}
{
  const f64 = parseListingEquipment(IT64);
  t("#64 3階建でエレベーターの記載なし → unlisted（ng にしない）", f64.totalFloors === 3 && f64.items.elevator.status === "unlisted", [f64.totalFloors, f64.items.elevator]);
  t("#64 最上階 ok", f64.items.top_floor.status === "ok");
  t("#64 オール電化 → ガスコンロ ng", f64.items.gas_stove.status === "ng" && f64.items.gas_stove.evidence === "オール電化");
  t("#64 備考の「駐車場付きの物件について」を空きと読まない（表の「駐車場 なし」で ng）", f64.items.parking.status === "ng" && f64.items.parking.detail === "なし", f64.items.parking);
  const f53 = parseListingEquipment(IT53);
  t("#53 駐車場 空きなし → ng", f53.items.parking.status === "ng" && f53.items.parking.detail === "空きなし" && f53.items.parking.evidence === "駐車場空きなし", f53.items.parking);
  const f62 = parseListingEquipment(IT62);
  t("#62 駐車場 空きあり → ok", f62.items.parking.status === "ok" && f62.items.parking.detail === "空きあり", f62.items.parking);
  t("#62 インターネット対応 と 無料 → net_free ok（根拠は無料の方）", f62.items.net_free.status === "ok" && f62.items.net_free.evidence === "インターネット無料", f62.items.net_free);
  t("#62 24時間ゴミ出し ok", f62.items.garbage24.status === "ok");
}

console.log("■ 同じ建物で補う（#50 ＋ #58）");
{
  const f50 = parseListingEquipment(IT50);
  t("#50 単体ではエレベーター・宅配・ネット無料は unlisted", ["elevator", "delivery_box", "net_free"].every((k) => f50.items[k as "elevator"].status === "unlisted"));
  t("#50 と #58 は同じ建物の鍵（Ⅵ の空白・康熙部首の揺れを吸収）", !!f50.buildingKey && f50.buildingKey === f58.buildingKey, [f50.buildingKey, f58.buildingKey]);
  const f51 = parseListingEquipment(IT51);
  const merged = mergeBuildingEquipment([{ id: 50, facts: f50 }, { id: 58, facts: f58 }, { id: 51, facts: f51 }]);
  const m50 = merged[0].facts;
  t("#50 のエレベーター・宅配・ネット無料を ○〔建〕で補う", ["elevator", "delivery_box", "net_free"].every((k) => m50.items[k as "elevator"].status === "ok" && m50.items[k as "elevator"].fromBuilding), m50.items);
  t("補った根拠に元の部屋（#58・907号室）", /#58・907号室/.test(m50.items.elevator.evidence ?? ""), m50.items.elevator);
  t("部屋単位（ペット・角部屋・洗面）は補わない", !m50.items.corner.fromBuilding && m50.items.corner.status === "unlisted");
  t("補うのは建物の5キーだけ", BUILDING_KEYS.length === 5 && BUILDING_KEYS.includes("parking"));
  t("別の建物（#51）は補わない", merged[2].facts.items.elevator.status === "unlisted");
  t("元の facts は書き換えない", f50.items.elevator.status === "unlisted");
  t("#58 は変わらない（同じ物を返す）", merged[1].facts === f58);
}

console.log("■ 同じ建物の補いで別の建物に補わない（反証レビュー 2026-09-24）");
{
  // 名前が一般名（「物件」）・名前が読めない・番地の無い所在地・同名で所在地が違う
  const body = (head: string, addr: string, setsubi: string) => `仲介\n${head}\n所在地 ${addr}\n交通\n徒歩 5 分\n所在階 3 階 主要採光⾯ 南向き\n設備\n${setsubi}\n備考\nー`;
  const gA = parseListingEquipment(body("物件 301 号室", "大阪府大阪市淀川区西宮原1丁目 7-46", "エレベーター , 宅配 BOX , 都市ガス , エアコン"));
  const gB = parseListingEquipment(body("物件 205 号室", "大阪府大阪市淀川区東三国5丁目 2-17", "都市ガス , エアコン , フローリング"));
  t("一般名「物件」は名前の鍵にしない（番地の所在地を使う）", gA.buildingKey !== gB.buildingKey && /^@/.test(gA.buildingKey ?? ""), [gA.buildingKey, gB.buildingKey]);
  const mg = mergeBuildingEquipment([{ id: 1, facts: gA }, { id: 2, facts: gB }]);
  t("一般名どうし・所在地が違う → 補わない", mg[1].facts.items.elevator.status === "unlisted" && mg[1].facts.items.delivery_box.status === "unlisted");

  const nA = parseListingEquipment(body("物件 301 号室", "大阪府大阪市淀川区西中島4丁目", "エレベーター , 宅配 BOX , 都市ガス , エアコン"));
  const nB = parseListingEquipment(body("物件 205 号室", "大阪府大阪市淀川区西中島4丁目", "都市ガス , エアコン , フローリング"));
  t("番地の無い所在地は鍵にしない", nA.buildingKey === null && nB.buildingKey === null, [nA.buildingKey, nB.buildingKey]);
  const mn = mergeBuildingEquipment([{ id: 1, facts: nA }, { id: 2, facts: nB }]);
  t("同じ丁目の一般名の2部屋 → 補わない", mn[1].facts.items.elevator.status === "unlisted");

  const sA = parseListingEquipment(body("サンハイツ 301 号室", "大阪府大阪市淀川区西宮原1丁目 7-46", "エレベーター , 宅配 BOX , 都市ガス"));
  const sB = parseListingEquipment(body("サンハイツ 205 号室", "大阪府大阪市平野区加美東4丁目 2-13", "都市ガス , エアコン"));
  t("同名でも番地の所在地が違えば別の建物 → 補わない", sA.buildingKey === sB.buildingKey && mergeBuildingEquipment([{ id: 1, facts: sA }, { id: 2, facts: sB }])[1].facts.items.elevator.status === "unlisted");
  const sC = parseListingEquipment(body("サンハイツ 205 号室", "大阪府大阪市淀川区西宮原 1 丁目 7-46", "都市ガス , エアコン"));
  const ms = mergeBuildingEquipment([{ id: 1, facts: sA }, { id: 2, facts: sC }]);
  t("同名・同じ番地（空白の揺れ）→ 補う", ms[1].facts.items.elevator.status === "ok" && !!ms[1].facts.items.elevator.fromBuilding, ms[1].facts.items.elevator);
  const ml = mergeBuildingEquipment([{ id: "【1】", facts: sA }, { id: 2, facts: sC }]);
  t("根拠の名前が文字なら # を付けない（【1】）", /（【1】・301号室）/.test(ml[1].facts.items.elevator.evidence ?? ""), ml[1].facts.items.elevator.evidence);
}

// ───────── リアプロ ─────────
console.log("■ リアプロの備考・設備・条件欄");
{
  const f36 = parseListingEquipment(RP36);
  t("#36 形は realpro・号室 0303・3階部分", f36.format === "realpro" && f36.room === "0303" && f36.floor === 3 && f36.floorSource === "階部分", [f36.format, f36.room, f36.floor]);
  t("#36 エレベーター ok（備考「エレベータ 各階有」か設備「エレベーター」）", f36.items.elevator.status === "ok" && /エレベータ/.test(f36.items.elevator.evidence ?? ""), f36.items.elevator);
  t("#36 宅配ボックス 暗証番号 → ok", f36.items.delivery_box.status === "ok");
  t("#36 冷暖房 全室設置済 → エアコン ok", f36.items.aircon.status === "ok");
  t("#36 地上15階", f36.totalFloors === 15);
  t("#36 「エレベータ 各階有」だけでも ok", parseListingEquipment(RP36.replace("エレベーター・オートバイ", "オートバイ")).items.elevator.evidence === "エレベータ各階有");
  const f37 = parseListingEquipment(RP37);
  t("#37 「オ\\nートロック」→ オートロック ok", f37.items.autolock.status === "ok");
  t("#37 「洗面所独立」→ 独立洗面 ok", f37.items.washbasin.status === "ok" && f37.items.washbasin.evidence === "洗面所独立", f37.items.washbasin);
  t("#37 13階部分", f37.floor === 13 && f37.roomFloor === 13);
  t("#37 階が無くても「2F以上」で 2階以上 ok", parseListingEquipment(RP37.replace("1303（13階部分）", "")).items.floor2.status === "ok");
  const f43 = parseListingEquipment(RP43);
  t("#43 「風呂（ユニットバス）」＋「バス・ト\\nイレ別」→ バス・トイレ別 ok（3点ユニットと読まない）", f43.items.bath_toilet.status === "ok", f43.items.bath_toilet);
  t("#43 「風呂（ユニットバス）」だけでも ng にしない", parseListingEquipment(RP43.replace("バス・ト\nイレ別・", "")).items.bath_toilet.status === "unlisted");
  t("#43 「洗面\\n所独立」→ ok", f43.items.washbasin.status === "ok");
  const f3 = parseListingEquipment(RP3);
  t("#3 「洗面台（独立）」→ ok", f3.items.washbasin.status === "ok" && f3.items.washbasin.evidence === "洗面台(独立)", f3.items.washbasin);
  t("#3 角部屋 ok", f3.items.corner.status === "ok");
  t("#3 ペット可（可）", f3.items.pet.status === "ok" && f3.items.pet.detail === "可", f3.items.pet);
  t("#3 駐車場情報:なし → ng", f3.items.parking.status === "ng" && f3.items.parking.evidence === "駐車場情報:なし", f3.items.parking);
  t("#3 鉄骨造 → 鉄筋コンクリート ng・木造以外 ok", f3.items.rc.status === "ng" && f3.items.not_wood.status === "ok");
  t("#3 IH（3口以上）→ IH ok・2口以上 ok", f3.items.ih.status === "ok" && f3.items.burner2.status === "ok");
  t("#3 特記事項は読まない（範囲は取引態様まで）", !/特記/.test(f3.items.pet.evidence ?? ""));
  const f38 = parseListingEquipment(RP38);
  t("#38 「角住戸(角地)」→ 角部屋 ok", f38.items.corner.status === "ok" && /角住戸/.test(f38.items.corner.evidence ?? ""), f38.items.corner);
  const f34 = parseListingEquipment(RP34);
  t("#34 敷地内駐車場／空きなし → ng", f34.items.parking.status === "ng" && f34.items.parking.detail === "空きなし", f34.items.parking);
  t("#34 洗髪洗面化粧台は独立と読まない（unlisted・手がかり）", f34.items.washbasin.status === "unlisted" && /洗髪洗面化粧台/.test(f34.items.washbasin.hint ?? ""), f34.items.washbasin);
  t("#34 号室 0403 → 4階", f34.floor === 4 && f34.roomFloor === 4);
  const hr = parseListingEquipment(RP_HR);
  t("HR FRONT REGAL: 0901（9階部分）→ 9階・地上10階", hr.floor === 9 && hr.totalFloors === 10 && hr.roomFloor === 9, [hr.floor, hr.totalFloors]);
  for (const k of ["elevator", "delivery_box", "autolock", "net_free", "bath_toilet", "laundry_in", "aircon", "shoebox", "washlet", "ih", "monitor_intercom", "bike_parking"] as const)
    t(`HR FRONT REGAL: ${k} ok`, hr.items[k].status === "ok", hr.items[k]);
  t("HR FRONT REGAL: 独立洗面は unlisted（洗髪洗面化粧台）", hr.items.washbasin.status === "unlisted");
  t("HR FRONT REGAL: 向きの欄が空 → 南向き unlisted", hr.items.south.status === "unlisted");
  t("HR FRONT REGAL: ペットは書いていない → unlisted", hr.items.pet.status === "unlisted");
}
{
  // はっきりした ng の言い方（実物に無い形は最小の文で）
  const ng = parseListingEquipment(`物件名 テスト\n号室名 101（1階部分）\n設 備\n【水廻り】 3点ユニット・洗濯機置場（屋外）\n条 件\n【条件】 ペット不可\n取引態様：媒介\n${"・".repeat(30)}`);
  t("3点ユニット → バス・トイレ別 ng", ng.items.bath_toilet.status === "ng");
  t("洗濯機置場（屋外）→ 室内洗濯機置場 ng", ng.items.laundry_in.status === "ng");
  t("ペット不可 → ng（不可）", ng.items.pet.status === "ng" && ng.items.pet.detail === "不可");
  t("1階部分 → 2階以上 ng", ng.items.floor2.status === "ng");
  const neg = parseListingEquipment(`物件名 テスト\n号室名 301（3階部分）\n設 備\n【条件】 犬猫不可\n取引態様：媒介\n${"・".repeat(30)}`);
  t("「犬猫不可」を「猫…可」と読まない", neg.items.pet.status !== "ok", neg.items.pet);
  const b = parseListingEquipment(`物件名 テスト\n号室名 B101\n設 備\n【セキュリティ】 オートロック\n取引態様：媒介\n${"・".repeat(30)}`);
  t("号室 B101 → 地下・2階以上 ng", b.basement && b.floor === null && b.items.floor2.status === "ng", [b.basement, b.floor, b.items.floor2]);
  const fromRoom = parseListingEquipment(`物件名 テスト\n号室名 502\n設 備\n【セキュリティ】 オートロック\n取引態様：媒介\n${"・".repeat(30)}`);
  t("階の欄が無ければ号室から（502 → 5階・出どころ「号室」）", fromRoom.floor === 5 && fromRoom.floorSource === "号室" && /推定/.test(fromRoom.items.floor2.evidence ?? ""), [fromRoom.floor, fromRoom.floorSource]);
  t("文字が無い → hasText false・全部 unlisted", (() => { const e = parseListingEquipment(""); return !e.hasText && e.items.elevator.status === "unlisted"; })());
}

// ───────── お客様の希望 ─────────
console.log("■ お客様の希望（条件欄）");
{
  // HONOKA さん（b5e25ca4…）の preferences（実物）
  const w = parseEquipmentWants({ preferences: "2階以上、エレベーター付き、宅配box付き、独立洗面台、風呂トイレ別", pet: false });
  const keys = w.wants.map((x) => x.key).sort();
  t("HONOKA さん: 5つの希望", JSON.stringify(keys) === JSON.stringify(["bath_toilet", "delivery_box", "elevator", "floor2", "washbasin"]), w.wants);
  t("HONOKA さん: uncovered 0", w.uncovered.length === 0, w.uncovered);
  t("HONOKA さん: 全部 must", w.wants.every((x) => x.mode === "must"));
  // #58 は5つとも ok・#51 / #65 は 2階以上 ×
  const m58 = matchEquipment(w, f58);
  t("#58 は5条件 ok", m58.ok === 5 && m58.ng === 0, formatEquipmentMatch(m58));
  const m51 = matchEquipment(w, parseListingEquipment(IT51));
  t("#51 は 2階以上 ×・エレベーター／宅配 －", m51.rows.find((r) => r.want.key === "floor2")?.mark === "×" && m51.rows.find((r) => r.want.key === "elevator")?.mark === "－", formatEquipmentMatch(m51));
  const m65 = matchEquipment(w, parseListingEquipment(IT65));
  t("#65 は 2階以上 ×", m65.rows.find((r) => r.want.key === "floor2")?.result === "ng", formatEquipmentMatch(m65));
  // 建物で補った #50 は ○〔建〕
  const merged = mergeBuildingEquipment([{ id: 50, facts: parseListingEquipment(IT50) }, { id: 58, facts: f58 }]);
  const m50 = matchEquipment(w, merged[0].facts);
  t("#50 はエレベーター・宅配が ○〔建〕", m50.rows.filter((r) => r.mark === "○〔建〕").length === 2 && m50.ok === 5, formatEquipmentMatch(m50));
  const m55 = matchEquipment(w, parseListingEquipment(IT55));
  t("#55 の独立洗面は －（書いていない）", m55.rows.find((r) => r.want.key === "washbasin")?.mark === "－", formatEquipmentMatch(m55));
  t("表示の1行", formatEquipmentMatch(m58) === "2階以上○ エレベーター○ 宅配ボックス○ 独立洗面台○ バス・トイレ別○", formatEquipmentMatch(m58));
}
{
  const w1 = parseEquipmentWants({ other_requests: "バストイレ別・オートロック" });
  t("「バストイレ別・オートロック」→ 2つ", w1.wants.map((x) => x.key).join(",") === "bath_toilet,autolock", w1.wants);
  const w2 = parseEquipmentWants({ preferences: "木造以外、全室洋室（和室なし）、敷金0円、礼金0円、バス・トイレ別、エアコンあり、独立洗面台など設備が充実" });
  const k2 = w2.wants.map((x) => x.key);
  t("「バス・トイレ別」を「・」で割らない", k2.includes("bath_toilet") && !w2.uncovered.some((u) => u.text === "バス"), w2);
  // 2026-09-25 構造は段で持つ（木造以外＝軽量鉄骨以上）
  t("木造以外 → 構造 軽量鉄骨以上（木造NG）", w2.wants.some((x) => x.key === "structure" && x.structureMin === 1 && x.woodNgOnly === true), w2.wants);
  t("敷金・礼金は handledElsewhere", w2.handledElsewhere.some((h) => /敷金/.test(h.text)));
  t("「全室洋室（和室なし）」は uncovered", w2.uncovered.some((u) => /和室/.test(u.text)), w2.uncovered);
  const w3 = parseEquipmentWants({ preferences: "トイレ風呂別、カウンターキッチン、音が通りにくい部屋", ng_points: "3階未満NG" });
  t("3階未満NG → 3階以上", w3.wants.some((x) => x.key === "floor" && x.minFloor === 3), w3.wants);
  t("音が通りにくい部屋 → uncovered", w3.uncovered.some((u) => /音/.test(u.text)));
  const w4 = parseEquipmentWants({ preferences: "ペット可（7階以下のみ）", ng_points: "8階以上" });
  t("7階以下・8階以上NG → 上限 7", w4.wants.filter((x) => x.key === "floor").every((x) => x.maxFloor === 7) && w4.wants.some((x) => x.key === "pet"), w4.wants);
  const w5 = parseEquipmentWants({ ng_points: "西天満より北のエリア・ペット可NG[必須]" });
  const pet = w5.wants.find((x) => x.key === "pet");
  t("「ペット可NG[必須]」→ ペット ng・必須", pet?.mode === "ng" && pet.strong, w5.wants);
  const w6 = parseEquipmentWants({ ng_points: "1階不可", preferences: "エレベーター付き、バス・トイレ別、独立洗面台あり、室内洗濯機置き場、宅配ボックスあり" });
  t("1階不可 → 2階以上", w6.wants.some((x) => x.key === "floor2" && x.minFloor === 2));
  t("室内洗濯機置き場 → laundry_in", w6.wants.some((x) => x.key === "laundry_in"));
  const w7 = parseEquipmentWants({ preferences: "ユニットバス可、室内洗濯機" });
  t("「ユニットバス可」は希望にしない（受け入れ）", !w7.wants.some((x) => x.key === "bath_toilet") && !w7.uncovered.length, w7);
  const w8 = parseEquipmentWants({ other_requests: "1階か2階（子供の転落事故防止と足音対策）" });
  t("1階か2階 → 1〜2階", w8.wants.some((x) => x.key === "floor" && x.minFloor === 1 && x.maxFloor === 2), w8.wants);
  const w9 = parseEquipmentWants({ other_requests: "駐車場あれば欲しいです" });
  t("駐車場あれば → soft", w9.wants[0]?.key === "parking" && w9.wants[0].soft);
  const w10 = parseEquipmentWants({ pet: true });
  t("pet=true → ペット must", w10.wants.length === 1 && w10.wants[0].key === "pet" && w10.wants[0].field === "pet");
  const w11 = parseEquipmentWants({ additional_conditions: "[8/31 16:55|format] 正式条件フォーマット受信 → 物件を検索してください / [8/31 18:17|auto] こだわり: ペット可[必須]" });
  t("additional_conditions の「こだわり: ペット可[必須]」だけ拾う", w11.wants.length === 1 && w11.wants[0].key === "pet" && w11.wants[0].strong && !w11.uncovered.length, w11);
  const w12 = parseEquipmentWants({ preferences: "エアコン付き、浴室暖房付き、駐車場または近隣に駐車場がある", ng_points: "1階NG" });
  t("浴室暖房 → bath_dryer・1階NG → 2階以上", w12.wants.some((x) => x.key === "bath_dryer") && w12.wants.some((x) => x.key === "floor2"));
  // ペット相談は △
  const mp = matchEquipment(parseEquipmentWants({ preferences: "ペット可" }), f58);
  t("ペット相談の物件は △", mp.rows[0].mark === "△" && mp.rows[0].result === "ok", mp.rows);
  // ペット可NG のお客様に #3（ペット可）は ×
  const mn = matchEquipment(w5, parseListingEquipment(RP3));
  t("ペット可NG のお客様に ペット可の物件 → ×・strongNg", mn.rows.find((r) => r.want.key === "pet")?.result === "ng" && mn.strongNg, mn.rows);
  // 3階以上 × 2階
  const m3 = matchEquipment(w3, parseListingEquipment(IT51));
  t("3階以上の希望に 1階 → ×", m3.rows.find((r) => r.want.key === "floor")?.result === "ng");
}

console.log("■ 聞く時の前置き（キャッシュ）");
{
  const a = buildEquipmentAskPrompt({ clauses: ["音が通りにくい部屋"], listingText: IT58, facts: f58 });
  const b = buildEquipmentAskPrompt({ clauses: ["全室洋室（和室なし）"], listingText: RP3, facts: parseListingEquipment(RP3) });
  t("system は物件が違っても同じ（固定の前置き）", a.system === b.system && a.system === EQUIPMENT_ASK_SYSTEM);
  t("system に物件名・お客様の言葉・日付が無い", !/エステムコート|Abelia|音が通り|和室|20\d\d/.test(EQUIPMENT_ASK_SYSTEM));
  t("user の先頭は決まった事実 → 資料の文字 → 希望の順", /^【決まった事実】/.test(a.user) && a.user.indexOf("【資料の文字】") < a.user.indexOf("【確かめる希望】"));
  t("user に Q1 と所在階", /Q1: 音が通りにくい部屋/.test(a.user) && /"所在階":9/.test(a.user), a.user.slice(0, 200));
  t("資料の文字は NFKC 済み（康熙部首が残らない）", !/⼤|⽴/.test(a.user));
}

console.log(`\n結果: ${passed} OK / ${failed} NG`);
if (failed) process.exit(1);
