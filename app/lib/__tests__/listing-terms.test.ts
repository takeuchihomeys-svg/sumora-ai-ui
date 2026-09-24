// 物件資料の文字層から「募集の条件」（敷礼・築年・入居時期・契約・更新料・フリーレント・入居の条件・面積）を決定論で読む（純関数）のテスト
// 実行: npx tsx app/lib/__tests__/listing-terms.test.ts
// 文字は 2026-09-25 の実物（property_pickups の pdf_blob_url の1ページ目の文字層）の抜粋をそのまま使う（康熙部首の字・「‧」・行の割れも元のまま）。
// 会社の電話・保証会社の文の一部は外してある。お客様の名前・電話番号は無い
import {
  parseListingTerms, termsToBrainData, moveInAvailableFrom, compareMoveIn, formatListingTerms, CONDITION_KEYS,
} from "../listing-terms";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}
const TODAY = "2026-09-25";
const P = (s: string) => parseListingTerms(s, { today: TODAY });

// ───────── itandi（id 50・60・61・59） ─────────
const IT50 = `仲介
エステムコート新⼤阪 Ⅵ エキスプレイス 405 号室
所在地 ⼤阪府⼤阪市淀川区⻄宮原 1 丁⽬ 7-46
MAP
交通
JR 京都線 新⼤阪駅 徒歩 8 分
賃料 67,000 円 管理費‧共益費 なし
間取り 1K 専有⾯積 20.8 ㎡
敷⾦ / 礼⾦ / 保証⾦ なし / 1 ヶ⽉ / ー 敷引償却 ー
築年数 2008 年 6 ⽉ 物件種別 マンション
構造 鉄筋コンクリート 階建 / 総⼾数 15 階建 / ー
所在階 4 階 主要採光⾯ ⻄向き
現況 居住中 ⼊居可能時期 2026 年 11 ⽉上旬
契約期間 2 年間（普通借家） 解約予告 1 ヶ⽉前
駐⾞場 ー 駐⾞場代 ー
保険加⼊ 加⼊要 2 年間 22,000 円 更新料 新賃料 1 ヶ⽉
保証会社
利⽤必須 , 全保連株式会社 , 初回保証料 : 総賃料の 50% 〜 ( 年間保証
料 :15,000 円 ) 引落⼿数料 :330 円 / ⽉
設備
都市ガス , バス‧トイレ別 , 独⽴洗⾯台 , 室内洗濯機置場 , 洗濯機置場 , シ
ステムキッチン , ２⼝コンロ , エアコン , 収納スペース , シューズボック
ス , オートロック , モニタ付インターホン , 防犯カメラ , フローリング , バ
ルコニー , 分譲タイプ , 敷地内ごみ置き場 , ペット相談 , ペット対応 , 外国
籍可
備考
‧ペット備考 成獣の状態で概ね体⻑ 50 センチ ( ⾸から尾の付け根迄 ) 程度
の⽝‧猫で⼀住⼾ 2 匹以内とする。`;

const IT60 = `賃料 58,000 円 管理費‧共益費 7,000 円
間取り 1K 専有⾯積 20.88 ㎡
敷⾦ / 礼⾦ / 保証⾦ なし / 1 ヶ⽉ / ー 敷引償却 ー
築年数 2008 年 6 ⽉ 物件種別 マンション
構造 鉄筋コンクリート 階建 / 総⼾数 15 階建 / ー
所在階 4 階 主要採光⾯ 南向き
現況 居住中 ⼊居可能時期 相談
契約期間 2 年間（普通借家） 解約予告 ー
駐⾞場 空きなし 敷地内 駐⾞場代 なし
保険加⼊ なし 更新料 1 ヶ⽉
設備
⽔道公営 , 都市ガス , 排⽔下⽔ , 専⽤バス , バス‧トイレ別 , 温⽔洗浄便座 , シャワー , 浴室
乾燥機 , 独⽴洗⾯台 , 室内洗濯機置場 , システムキッチン , ２⼝コンロ , ガスコンロ , エア
コン , シューズボックス , オートロック , モニタ付インターホン , 防犯カメラ , フローリン
グ , エレベーター , バルコニー , 駐輪場 , 宅配 BOX, 敷地内ごみ置き場 , 単⾝限定 , 保証⼈不
要
備考
短期違約⾦あり（ 1 年未満解約、 1 ヶ⽉分）、解約予告 2 か⽉前 ⼤⼿法⼈
契約の場合、礼⾦ 1 ヶ⽉積み増しとなります。`;

const IT61 = `賃料 58,000 円 管理費‧共益費 5,000 円
間取り 1K 専有⾯積 19.15 ㎡
敷⾦ / 礼⾦ / 保証⾦ なし / なし / ー 敷引償却 ー
築年数 2017 年 9 ⽉ 物件種別 マンション
構造 鉄筋コンクリート 階建 / 総⼾数 6 階建 / 15 ⼾
所在階 3 階 主要採光⾯ 北向き
現況 ー ⼊居可能時期 2026 年 9 ⽉下旬
契約期間 2 年間（普通借家） 解約予告 2 ヶ⽉前
駐⾞場 ー 駐⾞場代 ー
保険加⼊ 加⼊要 2 年間 20,000 円 更新料 新賃料 1 ヶ⽉
保証会社
要保証会社加⼊ , エポスカード ROOMiD, 初回保証料：総賃料の 50 ％ ⽉額保証料：総
賃料の 1.5 ％ ※ 外国籍の申込者様は敷⾦ 2 ヶ⽉。保証会社 GTN （初回保証料 100 ％ ⽉額保
証料 2 ％）
設備
都市ガス , バス‧トイレ別 , 独⽴洗⾯台 , 室内洗濯機置場 , エアコン , オー
トロック , 事務所使⽤不可 , エレベーター
備考
‧更新料：新賃料の 1 ヶ⽉
分‧楽器不可‧掲載画像は反転⼜は類似物件写真の場合有`;

const IT59 = `賃料 60,000 円 管理費‧共益費 なし
間取り 1K 専有⾯積 20.8 ㎡
敷⾦ / 礼⾦ / 保証⾦ なし / なし / なし 敷引償却 ー
築年数 2008 年 6 ⽉ 物件種別 マンション
所在階 3 階 主要採光⾯ ⻄向き
現況 ー ⼊居可能時期 ー
契約期間 ー 解約予告 ー
駐⾞場 ー 駐⾞場代 ー
保険加⼊ ー 更新料 ー
設備
バス‧トイレ別 , 独⽴洗⾯台 , 室内洗濯機置場 , ２⼝コンロ , 給湯 , エアコン , シューズ
ボックス , バルコニー , 分譲タイプ , シェアハウス , ペット相談 , ⼆⼈
⼊居可 , 外国籍可 , 保証⼈不要 , 都市ガス
備考
込）契約時 ※ 20 ㎡以下は⼀律 30,800 円∕新築物件のみ退去時【短期解約違約⾦】 1 年未満の解約
は家賃‧共益費の 2 ヶ⽉分`;

// ───────── リアプロ（id 2・40・45・34・1） ─────────
const RP2 = `物件種目 [住居用] マンション
物件名 ダイレ・エヌ
号室名 102（1階部分）
建築構造 鉄筋コンクリート造 地上8階 総戸数32戸
間取タイプ 1LDK[LDK11.1x洋5.4]
専有面積 39.23㎡ 開口部方位 東
築年 2021年01月
現況/入居時期 退去予定 / 相談
賃料
80,000 円
共益費・管理費 10,500円
敷金 なし
礼金 2ヶ月
保証金 なし 償却・敷引 なし
更新料 旧賃料の1ヶ月
契約期間 普通借家 2年間
町内会費
なし 駐車場
条 件
【条件】 ペット相談・外国人契約可能・2人入居可能・保証会社利用必須
取引態様：媒介
特記事項：
その他費用について: ■退去時クリーニング費用:66,000円(税込) ■更新料:旧賃料の1ヶ月 ■小型犬1匹飼育相談可(賃料3,000円又は礼金50,000円アップ) ■短期
解約違約金(1年未満の解約時:賃料の1ヶ月分)
楽器使用 不可・事務所 不可・飲食店 不可・学生 不可・単身 可`;

const RP40 = `築年 2025年09月
現況/入居時期 退去予定 / 2026年10月15日
賃料
77,000 円
共益費・管理費 8,000円
敷金 なし
礼金 85,000円
保証金 なし 償却・敷引 なし
更新料 85,000円
契約期間 普通借家 2年間
条 件
【条件】 ペット相談・保証人不要・保証会社利用必須
取引態様：媒介
特記事項：
・1年未満は総賃料の2ヶ月分、1年以上2年未満は総賃料の1ヶ月分の短期解約違約金有り ・更新料:旧総賃料1ヶ月 ・礼金0円の場合でも、法人契約は礼金(総賃料
の1ヶ月分)要`;

const RP45 = `物件名 X
号室名 0301（3階部分）
専有面積 23.76㎡ 開口部方位 西
築年 2023年02月
現況/入居時期 空室 / 即入
賃料
75,200 円
共益費・管理費 6,800円
敷金 なし
礼金 なし
保証金 なし 償却・敷引 なし
更新料 15,000円
契約期間 普通借家 2年間
備 考
★ペット飼育可:小型犬・猫合計2匹まで
礼金1ヶ月もしくは家賃3,000円UP(※3,000円UPを選択した場合は、退去時クリ
ーニング代が33,000円(税込)追加です。)
条 件
【条件】 ペット相談（小型犬、猫可）・保証人不要
取引態様：媒介
特記事項：
・法人契約可・保証会社：エルズサポート 初回保証料:総賃料の60%、年額1万円、引落手数料月額550円 ※法人契約相談可(礼金1ヵ月増額)`;

const RP34 = `号室名 0403（4階部分）
専有面積 25.62㎡ 開口部方位 北
築年 2020年06月
現況/入居時期 退去予定 / 2026年12月01日
賃料
75,000 円
共益費・管理費 10,000円
敷金 なし
礼金 なし
保証金 なし 償却・敷引 なし
更新料 75,000円
契約期間 2年間
町内会費
敷地内駐車場／空きなし 駐車場
備 考
屋根構造: 陸屋根、■Refaシャワーヘッド標準設置 ■フリーレント1ヶ月
■ペット相談可 ■連帯保証人不要 ■敷金礼金
条 件
【条件】 ペット相談・外国人契約可能・保証会社利用必須`;

const RP1 = `号室名 303（3階部分）
専有面積 35.19㎡ 開口部方位
築年 2024年12月
現況/入居時期 退去予定(10/31) / 相談
賃料
75,000 円
共益費・管理費 5,000円
敷金 なし
礼金 なし
保証金 なし 償却・敷引 なし
更新料 なし
契約期間 普通借家 2年間`;

console.log("■ itandi");
{
  const r = P(IT50);
  t("IT50 形は itandi", r.format === "itandi", r.format);
  t("IT50 敷0・礼1・保証金ー＝0", r.depositMonths === 0 && r.keyMoneyMonths === 1 && r.guaranteeDeposit === 0, [r.depositMonths, r.keyMoneyMonths, r.guaranteeDeposit]);
  t("IT50 敷引償却ー＝0", r.amortization === 0, r.amortization);
  t("IT50 築2008年6月・18年", r.builtYear === 2008 && r.builtMonth === 6 && r.buildingAgeYears === 18 && !r.newBuild, [r.builtYear, r.builtMonth, r.buildingAgeYears]);
  t("IT50 入居 2026-11 上旬・居住中", r.moveIn.kind === "date" && r.moveIn.date === "2026-11" && r.moveIn.part === "上旬" && r.moveIn.current === "occupied", r.moveIn);
  t("IT50 普通借家 2年", r.contract.kind === "normal" && r.contract.years === 2, r.contract);
  t("IT50 更新料 新賃料 1ヶ月", r.renewalFee.kind === "months" && r.renewalFee.months === 1 && r.renewalFee.basis === "新賃料", r.renewalFee);
  t("IT50 外国籍可（行をまたぐ「外国\\n籍可」）", r.conditions.foreigner.status === "ok", r.conditions.foreigner);
  t("IT50 楽器・学生は unlisted", r.conditions.instrument.status === "unlisted" && r.conditions.student.status === "unlisted");
  t("IT50 面積 20.8", r.areaSqm === 20.8, r.areaSqm);
  t("IT50 フリーレントなし＝null", r.freeRent === null);
  t("IT50 判定に渡す形", JSON.stringify(termsToBrainData(r)) === JSON.stringify({ deposit_months: 0, key_money_months: 1, building_age: 18 }), termsToBrainData(r));
}
{
  const r = P(IT60);
  t("IT60 入居 相談・居住中", r.moveIn.kind === "consult" && r.moveIn.current === "occupied", r.moveIn);
  t("IT60 更新料 1ヶ月（「保険加入 なし 更新料 1 ヶ月」の同じ行）", r.renewalFee.kind === "months" && r.renewalFee.months === 1, r.renewalFee);
  t("IT60 単身限定 → 単身 ok・二人入居 ng・singleOnlyRestricted", r.conditions.singleOnly.status === "ok" && r.conditions.twoPerson.status === "ng" && r.singleOnlyRestricted, [r.conditions.singleOnly, r.conditions.twoPerson]);
  t("IT60 大手法人契約は礼金積み増し → 法人 consult（行の割れ）", r.conditions.corporate.status === "consult", r.conditions.corporate);
  t("IT60 敷0 礼1", r.depositMonths === 0 && r.keyMoneyMonths === 1);
}
{
  const r = P(IT61);
  t("IT61 敷0 礼0（保証会社欄の「外国籍の申込者様は敷金2ヶ月」を敷金にしない）", r.depositMonths === 0 && r.keyMoneyMonths === 0, [r.depositMonths, r.keyMoneyMonths]);
  t("IT61 外国籍は条件付き → consult", r.conditions.foreigner.status === "consult", r.conditions.foreigner);
  t("IT61 楽器不可（‧区切り）", r.conditions.instrument.status === "ng" && /楽器不可/.test(r.conditions.instrument.evidence ?? ""), r.conditions.instrument);
  t("IT61 事務所使用不可", r.conditions.office.status === "ng", r.conditions.office);
  t("IT61 入居 2026-09 下旬・現況ー＝null", r.moveIn.kind === "date" && r.moveIn.date === "2026-09" && r.moveIn.part === "下旬" && r.moveIn.current === null, r.moveIn);
  t("IT61 築2017年9月＝9年", r.buildingAgeYears === 9, r.buildingAgeYears);
}
{
  const r = P(IT59);
  t("IT59 敷礼保 なし/なし/なし", r.depositMonths === 0 && r.keyMoneyMonths === 0 && r.guaranteeDeposit === 0);
  t("IT59 入居時期 ー → unknown（なしとは読まない）", r.moveIn.kind === "unknown" && r.moveIn.current === null, r.moveIn);
  t("IT59 契約期間 ー → unknown", r.contract.kind === "unknown" && r.contract.years === undefined, r.contract);
  t("IT59 更新料 ー → blank（0 とは言わない）", r.renewalFee.kind === "blank", r.renewalFee);
  t("IT59 「新築物件のみ退去時」は新築の札ではない", r.newBuild === false, r.evidence.newBuild);
  t("IT59 二人入居可（「⼆⼈\\n⼊居可」）", r.conditions.twoPerson.status === "ok", r.conditions.twoPerson);
}

console.log("■ リアプロ");
{
  const r = P(RP2);
  t("RP2 形は realpro", r.format === "realpro", r.format);
  t("RP2 敷0 礼2 保0 償却0", r.depositMonths === 0 && r.keyMoneyMonths === 2 && r.guaranteeDeposit === 0 && r.amortization === 0, [r.depositMonths, r.keyMoneyMonths, r.guaranteeDeposit, r.amortization]);
  t("RP2 築2021年1月＝5年", r.builtYear === 2021 && r.builtMonth === 1 && r.buildingAgeYears === 5, [r.builtYear, r.buildingAgeYears]);
  t("RP2 入居 退去予定 / 相談", r.moveIn.kind === "consult" && r.moveIn.current === "leaving", r.moveIn);
  t("RP2 普通借家 2年", r.contract.kind === "normal" && r.contract.years === 2, r.contract);
  t("RP2 更新料 旧賃料の1ヶ月", r.renewalFee.kind === "months" && r.renewalFee.months === 1 && r.renewalFee.basis === "旧賃料", r.renewalFee);
  const c = r.conditions;
  t("RP2 楽器× 事務所× 学生× 単身○ 外国籍○ 二人入居○",
    c.instrument.status === "ng" && c.office.status === "ng" && c.student.status === "ng" && c.singleOnly.status === "ok" && c.foreigner.status === "ok" && c.twoPerson.status === "ok",
    Object.fromEntries(CONDITION_KEYS.map((k) => [k, c[k].status])));
  t("RP2 法人・ルームシェア・子供は unlisted", c.corporate.status === "unlisted" && c.roomShare.status === "unlisted" && c.children.status === "unlisted");
  t("RP2 面積 39.23", r.areaSqm === 39.23);
}
{
  const r = P(RP40);
  t("RP40 礼金 85,000円 → 総賃料（77,000＋8,000）の1ヶ月", r.keyMoneyMonths === 1 && r.keyMoneyYen === 85_000, [r.keyMoneyMonths, r.keyMoneyYen]);
  t("RP40 更新料 85,000円", r.renewalFee.kind === "yen" && r.renewalFee.yen === 85_000, r.renewalFee);
  t("RP40 入居 2026-10-15（中旬）・退去予定", r.moveIn.kind === "date" && r.moveIn.date === "2026-10" && r.moveIn.day === 15 && r.moveIn.part === "中旬" && r.moveIn.current === "leaving", r.moveIn);
  t("RP40 築2025年9月＝1年・新築ではない（12か月ちょうど）", r.buildingAgeYears === 1 && !r.newBuild, [r.buildingAgeYears, r.newBuild]);
  t("RP40 法人契約は礼金要 → consult", r.conditions.corporate.status === "consult", r.conditions.corporate);
}
{
  const r = P(RP45);
  t("RP45 空室 / 即入 → immediate・vacant", r.moveIn.kind === "immediate" && r.moveIn.current === "vacant", r.moveIn);
  t("RP45 敷0 礼0（備考のペットの「礼金1ヶ月もしくは…」を礼金にしない）", r.depositMonths === 0 && r.keyMoneyMonths === 0, [r.depositMonths, r.keyMoneyMonths]);
  t("RP45 法人契約可（相談可より ok が先）", r.conditions.corporate.status === "ok", r.conditions.corporate);
  t("RP45 更新料 15,000円", r.renewalFee.kind === "yen" && r.renewalFee.yen === 15_000);
}
{
  const r = P(RP34);
  t("RP34 フリーレント1ヶ月", r.freeRent?.months === 1, r.freeRent);
  t("RP34 契約期間 2年間（種類なし）→ unknown・2年", r.contract.kind === "unknown" && r.contract.years === 2, r.contract);
  t("RP34 入居 2026-12-01", r.moveIn.kind === "date" && r.moveIn.date === "2026-12" && r.moveIn.day === 1 && r.moveIn.part === "上旬", r.moveIn);
  t("RP34 敷0 礼0（表から・備考の「■敷金礼金」は使わない）", r.depositMonths === 0 && r.keyMoneyMonths === 0 && r.depositSource === "表");
}
{
  const r = P(RP1);
  t("RP1 退去予定(10/31) の「/」で割らない → 相談・退去 10-31", r.moveIn.kind === "consult" && r.moveIn.current === "leaving" && r.moveIn.vacateMonthDay === "10-31", r.moveIn);
  t("RP1 更新料 なし", r.renewalFee.kind === "none");
  t("RP1 築2024年12月 → 1年・新築ではない", r.buildingAgeYears === 1 && r.newBuild === false, [r.buildingAgeYears, r.newBuild]);
}

console.log("■ 揺れ・書いていない・ありえない値");
{
  const r = P(`物件名 テスト
号室名 101（1階部分）
賃料
80,000 円
共益費・管理費 なし
専有面積 30㎡
間取タイプ 1K
築年 2026年03月`);
  t("敷金・礼金の行が無い → null（なしとは読まない）", r.depositMonths === null && r.keyMoneyMonths === null && r.depositSource === null, [r.depositMonths, r.keyMoneyMonths]);
  t("築年 2026年3月 → 0年・新築（12か月以内）", r.buildingAgeYears === 0 && r.newBuild, [r.buildingAgeYears, r.newBuild]);
  t("入居時期の行が無い → unknown", r.moveIn.kind === "unknown" && r.moveIn.raw === null);
  t("更新料の行が無い → unlisted", r.renewalFee.kind === "unlisted");
  t("条件は全部 unlisted", CONDITION_KEYS.every((k) => r.conditions[k].status === "unlisted"));
}
{
  const r = P(`物件名 テスト
号室名 201
賃料
70,000 円
敷金 30ヶ月
礼金 1ヶ月（償却）
契約期間 定期借家 3年間
築年 1890年04月
更新料 12ヶ月
現況/入居時期 空室 / 即入`);
  t("敷金 30ヶ月 はありえない → null", r.depositMonths === null, r.depositMonths);
  t("礼金 1ヶ月（償却）→ 1", r.keyMoneyMonths === 1, r.keyMoneyMonths);
  t("定期借家 3年", r.contract.kind === "fixed" && r.contract.years === 3, r.contract);
  t("築 1890年 はありえない → null", r.builtYear === null && r.buildingAgeYears === null);
  t("更新料 12ヶ月 はありえない → unlisted", r.renewalFee.kind === "unlisted", r.renewalFee);
}
{
  const r = P(`物件名 テスト
号室名 301
賃料
100,000 円
敷金 1ヶ月（償却）
礼金 0
保証金 なし 償却・敷引 1ヶ月
築年 新築
現況/入居時期
空室 / 2027年1月下旬`);
  t("敷金 1ヶ月（償却）→ 1・償却の印", r.depositMonths === 1 && r.depositAmortized === true, [r.depositMonths, r.depositAmortized]);
  t("礼金 0 → 0", r.keyMoneyMonths === 0);
  t("償却・敷引 1ヶ月", r.amortization === 1);
  t("築年 新築 → 新築・0年", r.newBuild && r.buildingAgeYears === 0, [r.newBuild, r.buildingAgeYears]);
  t("入居時期の値が次の行に割れる → 2027-01 下旬", r.moveIn.kind === "date" && r.moveIn.date === "2027-01" && r.moveIn.part === "下旬", r.moveIn);
}
{
  const r = P(`敷⾦ / 礼⾦ / 保証⾦ 100,000 円 / 5 万円 / ー 敷引償却 ー
賃料 50,000 円 管理費‧共益費 なし
築年数 2019 年 3 ⽉ 物件種別 マンション
所在階 2 階 主要採光⾯ 南向き
現況 空き ⼊居可能時期 即⼊居可
契約期間 2 年間（定期借家）`);
  t("itandi の円（10万円＝2ヶ月・5万円＝1ヶ月）", r.depositMonths === 2 && r.keyMoneyMonths === 1 && r.depositYen === 100_000 && r.keyMoneyYen === 50_000, [r.depositMonths, r.keyMoneyMonths]);
  t("即入居可 → immediate・空き", r.moveIn.kind === "immediate" && r.moveIn.current === "vacant", r.moveIn);
  t("2 年間（定期借家）→ fixed", r.contract.kind === "fixed" && r.contract.years === 2, r.contract);
}
{
  const r = P(`敷⾦ / 礼⾦ / 保証⾦ なし / 1 ヶ
⽉ / ー 敷引償却 ー
賃料 60,000 円 管理費‧共益費 なし
所在階 3 階 主要採光⾯ 南向き`);
  t("itandi の3つ並びが次の行に割れても読む", r.depositMonths === 0 && r.keyMoneyMonths === 1 && r.guaranteeDeposit === 0, [r.depositMonths, r.keyMoneyMonths, r.guaranteeDeposit]);
}
{
  const r = P(`物件名 テスト
号室名 101
賃料
60,000 円
敷金 500,000円
礼金 なし`);
  t("敷金 500,000円（賃料の8.3倍）はありえない → null", r.depositMonths === null, r.depositMonths);
  t("礼金 なし → 0", r.keyMoneyMonths === 0);
}
{
  const r = P(`物件名 テスト
号室名 101
間取タイプ 1K
専有面積 20㎡
備 考
■敷金礼金0円 ■ネット無料`);
  t("表が無い時だけ備考の「敷金礼金0円」→ 0/0（source=備考）", r.depositMonths === 0 && r.keyMoneyMonths === 0 && r.depositSource === "備考", [r.depositMonths, r.depositSource]);
}
{
  const r = P(`物件名 テスト
号室名 101
賃料
60,000 円
特記事項：
二人入居 不可・ペット 不可・ルームシェア 不可・事務所 不可・子供 不可・単身 可・楽器 相談・学生 可・外国籍 不可・法人 不可`);
  const c = r.conditions;
  t("特記の並び（字の間の空白）を全部読む",
    c.twoPerson.status === "ng" && c.roomShare.status === "ng" && c.office.status === "ng" && c.children.status === "ng" && c.singleOnly.status === "ok"
      && c.instrument.status === "consult" && c.student.status === "ok" && c.foreigner.status === "ng" && c.corporate.status === "ng",
    Object.fromEntries(CONDITION_KEYS.map((k) => [k, c[k].status])));
  t("単身 可 は単身限定ではない", r.singleOnlyRestricted === false);
}
{
  t("空・短い文字 → hasText false・全部 null", (() => { const r = P("ー"); return !r.hasText && r.depositMonths === null && r.builtYear === null; })());
  t("null でも投げない", (() => { try { parseListingTerms(null); return true; } catch { return false; } })());
}

console.log("■ 入居時期を照らす");
{
  const it50 = P(IT50);
  t("上旬＝1日", moveInAvailableFrom(it50.moveIn) === "2026-11-01", moveInAvailableFrom(it50.moveIn));
  t("希望 11/10 までに → ok（上旬）", compareMoveIn(it50.moveIn, "2026-11-10") === "ok");
  t("希望 10/10 までに → late（11/1 は 14 日超）", compareMoveIn(it50.moveIn, "2026-10-10") === "late");
  t("希望 10/20 までに → ok（12日の差は猶予内）", compareMoveIn(it50.moveIn, "2026-10-20") === "ok");
  const rp45 = P(RP45);
  t("即入 → 基準日", moveInAvailableFrom(rp45.moveIn, { today: TODAY }) === TODAY, moveInAvailableFrom(rp45.moveIn, { today: TODAY }));
  t("相談 → unknown（0点の要確認）", compareMoveIn(P(IT60).moveIn, "2026-10-01") === "unknown");
  t("希望日なし → unknown", compareMoveIn(it50.moveIn, null) === "unknown");
  t("年の無い「1月上旬」は来年", (() => { const r = P("物件名 X\n号室名 1\n現況/入居時期 退去予定 / 1月上旬\n賃料\n50,000 円\n敷金 なし\n礼金 なし"); return r.moveIn.date === "2027-01"; })());
}

console.log("■ 1行の表示");
t("formatListingTerms", /敷0 礼1 保0 築2008年6月\(18年\) 入居:2026-11上旬\(occupied\) normal2 更新1ヶ月 20\.8㎡ 外国籍○/.test(formatListingTerms(P(IT50))), formatListingTerms(P(IT50)));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
