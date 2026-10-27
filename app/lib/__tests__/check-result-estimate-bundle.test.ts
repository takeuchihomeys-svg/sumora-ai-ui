// AIX【物件確認した】の見積書の同封（物件ごとのセット）と、ピッカーと文の食い違い — 実物の文でのテスト
// 実行: npx tsx app/lib/__tests__/check-result-estimate-bundle.test.ts
// 2026-10-13 竹内さん（くれあ・未桜）
import {
  composeSingleEstimateCostText, bundleEstimateName, buildCheckResultSendPlan, describeSendPlan,
  shouldUseEstimateBundle, checkResultEstimateBundleOn, circled, CHECK_RESULT_MAX_PROPS, checkPatternTakesEstimate, checkAltEstimateOn,
} from "../check-result-estimate-bundle";
import { buildEstimateMessage, calcSavings } from "../estimate-body";
import { estimateExplain } from "../estimate-explain";
import {
  ensureAppliedTalk, findPickerTalkMismatch, alternativeSingleLine, splitBuildingRoom, cmAvailableResultDesc, APPLIED_SINGLE_LINE,
} from "../check-result-status-lines";

let pass = 0, fail = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

console.log("① 費用の文は AIX【見積書送る】（1枚）と同じ");
{
  // 実送信（かぁな 9/11・竹内さん）:【Alivis緑橋 114号室】初期費用さらに🌟85,000円割引… 初期費用：146,030円 … 184,870円節約
  const est = { property_name: "Alivis緑橋", room_number: "114", rent: 70000, management_fee: 8000, total: 146030, discount: 85000, commission: 0, commission_tax: 0, cleaning_fee: 0 };
  const got = composeSingleEstimateCostText(est, { accountName: "スモラ", account: "sumora" }).text;
  // 旧 route.ts の estimate_sheet（1枚）と同じ組み立て
  const savings = calcSavings({ rent: 70000, commission: 0, commissionTax: 0, discount: 85000 });
  const old = buildEstimateMessage([{ propertyName: "Alivis緑橋", roomNumber: "114", total: 146030, discount: 85000, savings, accountName: "スモラ" }]);
  const ex = estimateExplain({ account: "sumora", discountYen: 85000, commissionYen: 0, cleaningFeeYen: null });
  const oldFull = ex.cardLine ? `${old}\n\n${ex.cardLine}` : old;
  t("旧の1枚の文と1字も違わない", got === oldFull, { got, oldFull });
  t("見出しは①なしの【物件名 号室】", got.startsWith("【Alivis緑橋 114号室】\n\n初期費用さらに\n🌟85,000円割引させて頂き\n初期費用：146,030円"), got);
  t("日割の注記で終わる（費用の事情の行が無い時）", got.endsWith("※ご入居日によって日割家賃が発生致します。"), got);
  // 割引 0円・仲介手数料が一般の額 → 費用の事情の1行（10/06 ⑫）も同じ
  const r = composeSingleEstimateCostText({ property_name: "カーサピエント", room_number: "203", rent: 60000, total: 220000, discount: 0, commission: 30000, commission_tax: 3000 }, { accountName: "スモラ", account: "sumora" });
  t("割引0円・報酬が出ない物件は札の1行が付く", !!r.cardLine && r.text.endsWith(r.cardLine!), r);
  t("読み取れない時は受け皿の1文", composeSingleEstimateCostText({}, { accountName: "スモラ", account: "sumora" }).text.startsWith("最大限割引した初期費用の御見積書をお送りさせて頂きます！！"));
  // 物件名はスタッフの入れた名前を優先・号室の二重を避ける
  const nm = bundleEstimateName("レジュールアッシュ難波MINAMI 402号室", "レジュールアッシュ難波MINAMI", "402");
  t("スタッフの物件名に号室があれば足さない", nm.propertyName === "レジュールアッシュ難波MINAMI 402号室" && nm.roomNumber === "", nm);
  const nm2 = bundleEstimateName("グランルージュ谷町六丁目", "グランルージュ谷町六丁目", "1002");
  t("スタッフの物件名に号室が無ければ読み取りの号室", nm2.roomNumber === "1002", nm2);
  const nm3 = bundleEstimateName("物件①", "ラクラス本町東", "1001");
  t("仮の名前なら読み取りの名前（【見積書送る】と同じ）", nm3.propertyName === "ラクラス本町東" && nm3.roomNumber === "1001", nm3);
  const withName = composeSingleEstimateCostText({ total: 212480, discount: 88000, rent: 80000 }, { accountName: "スモラ", account: "sumora", ...bundleEstimateName("ラクラス本町東 1001号室", "", "") }).text;
  t("スタッフの名前で【ラクラス本町東 1001号室】", withName.startsWith("【ラクラス本町東 1001号室】"), withName);
}

console.log("② 送る並び（物件ごとに［資料・見積書 → 費用の文］→ 最後に確認の結果）");
{
  // 実送信 S 9/13 の6件・かぁな 9/11 の形
  const props = [
    { name: "スプランディット本町グラン 1604号室", docCount: 1, hasEstimate: true, costText: "【スプランディット本町グラン 1604号室】…" },
    { name: "ラクラス本町東 1001号室", docCount: 2, hasEstimate: true, costText: "【ラクラス本町東 1001号室】…" },
  ];
  const plan = buildCheckResultSendPlan(props);
  t("並び: 画像①→文①→画像②→文②→本文", plan.map((s) => s.id).join(",") === "p0:images,p0:cost,p1:images,p1:cost,main", plan);
  const lines = describeSendPlan(plan, props);
  t("画面の並び（5行）", lines.length === 5 && lines[0] === "1. スプランディット本町グラン 1604号室: 物件資料＋見積書の画像" && lines[2].includes("物件資料2枚＋見積書") && lines[4] === "5. 確認の結果の文（下の本文）", lines);
  // 持っている物だけ
  const plan2 = buildCheckResultSendPlan([
    { name: "A 101号室", docCount: 1, hasEstimate: false, costText: "" },   // 見積書なし → 資料だけ
    { name: "B 202号室", docCount: 0, hasEstimate: true, costText: "【B 202号室】…" },   // 資料なし → 見積書＋文
    { name: "C 303号室", docCount: 0, hasEstimate: false, costText: "" },   // 何も無い → 飛ばす
  ]);
  t("見積書の無い物件は資料だけ・資料の無い物件は見積書＋文・何も無い物件は飛ばす", plan2.map((s) => s.id).join(",") === "p0:images,p1:images,p1:cost,main", plan2);
  t("資料の無い物件の画像は見積書だけ", plan2[1].kind === "images" && plan2[1].docCount === 0 && plan2[1].hasEstimate, plan2[1]);
  t("費用の文を空にした物件はその文を送らない", buildCheckResultSendPlan([{ name: "A", docCount: 1, hasEstimate: true, costText: "  " }]).map((s) => s.id).join(",") === "p0:images,main");
  // いつセットで送るか
  t("見積書が1件以上・物件あった・on の時だけ", shouldUseEstimateBundle({ on: true, pattern: "available", estimateCount: 1 })
    && !shouldUseEstimateBundle({ on: true, pattern: "available", estimateCount: 0 })
    && !shouldUseEstimateBundle({ on: false, pattern: "available", estimateCount: 2 })
    && !shouldUseEstimateBundle({ on: true, pattern: "alternative", estimateCount: 1 }));
  t("戻す環境変数 off で止まる・既定は on", checkResultEstimateBundleOn("off") === false && checkResultEstimateBundleOn("OFF") === false && checkResultEstimateBundleOn(undefined) === true && checkResultEstimateBundleOn("") === true);
  t("10件まで（①〜⑩）", CHECK_RESULT_MAX_PROPS === 10 && circled(9) === "⑩" && circled(10) === "11.");
}

console.log("③ ピッカーと文（未桜 10/09・みこと 9/26）");
{
  // 未桜 10/09 の下書き（会話を合わせる）そのまま・ピッカーは「申込あり」
  const MIO = "未桜さんご連絡お待たせしました！！\n\nレジュールアッシュ難波MINAMIの募集状況確認させて頂きました！！\n現在募集中のお部屋となっております😊\n\n最大限割引しました初期費用の御見積書同封させて頂きました！！\nお手隙の際にご査収ください😌！！";
  const inp = { statuses: ["unavailable"], names: ["レジュールアッシュ難波MINAMI"], propertyCount: 1 };
  t("食い違いを見つける", findPickerTalkMismatch(MIO, inp) !== null);
  const fixed = ensureAppliedTalk(MIO, inp);
  t("申込の説明を足す（募集中の行の直後）", fixed.added && fixed.text.includes(`現在募集中のお部屋となっております😊\n${APPLIED_SINGLE_LINE}`), fixed.text);
  t("足した後は食い違い 0", findPickerTalkMismatch(fixed.text, inp) === null);
  t("元の語は1つも消さない", MIO.split("\n").every((l) => fixed.text.split("\n").includes(l)));
  // 既に番手を書いている（スタッフの送った文・Moe 10/04）には足さない
  const SENT = "未桜さんお待たせしました！！\n\nレジュールアッシュ難波MINAMIの募集状況確認させて頂きました！！\n現在1番手でお申込が入っており、2番手以降でお申込可能となります！！";
  t("番手を書いた文はそのまま", !ensureAppliedTalk(SENT, inp).added && findPickerTalkMismatch(SENT, inp) === null);
  const MOE = "ジュネーゼグラン難波ミラージュ205号室は現在募集中のお部屋となっております！！\nこちらは既に1番手のお申込が入っているお部屋のため、2番手以降でのお申込となります！！";
  t("Moe 10/04 の文はそのまま", !ensureAppliedTalk(MOE, inp).added);
  // 申込ありが無ければ何もしない
  t("全部空室なら何もしない", !ensureAppliedTalk(MIO, { statuses: ["available"], names: ["x"], propertyCount: 1 }).added);
  // 複数のうち1件が申込あり → 名指し（application-status-note の実送信の形）
  const multi = ensureAppliedTalk("お送り頂きました物件の中で\n・A 101号室\n・B 202号室\nこちら1件現在募集中となります！！", { statuses: ["available", "unavailable"], names: ["A 101号室", "B 202号室"], propertyCount: 2 });
  t("複数は物件名で名指し", multi.added && multi.text.includes("B 202号室はお申込がはいっておりますので、"), multi.text);
  // 別の部屋（みこと 9/26 のスタッフの直しの形）
  t("別の部屋の1件の行", alternativeSingleLine("レジュールアッシュPREMIUM TWIN II 206号室") === "レジュールアッシュPREMIUM TWIN II 別のお部屋ですが206号室現在募集中となります！！", alternativeSingleLine("レジュールアッシュPREMIUM TWIN II 206号室"));
  t("号室が無い名前", alternativeSingleLine("ザ・コッチ神戸") === "ザ・コッチ神戸 別のお部屋ですが現在募集中となります！！");
  t("号室の分け方（0103号室）", splitBuildingRoom("ジーメゾン高石千代田 0103号室").room === "0103号室");
  const MIKOTO = "みことさんお送りいただきました物件の中で\nレジュールアッシュPREMIUM TWIN II 206号室現在募集中となります！！";
  t("別の部屋なのに別が無い下書きを見つける", findPickerTalkMismatch(MIKOTO, { statuses: ["alternative"], names: ["レジュールアッシュPREMIUM TWIN II 206号室"], propertyCount: 1 }) !== null);
  t("会話を合わせるの確認結果: 全部申込ありなら募集中とだけ書かせない", cmAvailableResultDesc(["unavailable"], 1).includes("2番手") && !cmAvailableResultDesc(["available"], 1).includes("2番手"));
  // 物件なかった（unavailable＝募集終了）には使わない＝呼び出し側が check_pattern を見る。ここは物件あった専用
}

console.log(`\n${pass} OK / ${fail} NG`);

// 2026-10-27 P1 82027521: 別の部屋が募集してた でも見積書の同封の文・申込の状況（NEXT_PUBLIC_CHECK_ALT_ESTIMATE=on の時だけ）
t("別の部屋: スイッチ on の時だけ見積の束", shouldUseEstimateBundle({ on: true, pattern: "alternative", estimateCount: 1, altOn: true })
  && !shouldUseEstimateBundle({ on: true, pattern: "alternative", estimateCount: 1, altOn: false })
  && !shouldUseEstimateBundle({ on: true, pattern: "alternative", estimateCount: 0, altOn: true }));
t("見積・申込の行を出す結果: 物件あった は常に・別の部屋 は on の時だけ・物件なし は出さない", checkPatternTakesEstimate("available", false) && checkPatternTakesEstimate("alternative", true)
  && !checkPatternTakesEstimate("alternative", false) && !checkPatternTakesEstimate("unavailable", true));
t("スイッチの既定は off", !checkAltEstimateOn({}) && checkAltEstimateOn({ NEXT_PUBLIC_CHECK_ALT_ESTIMATE: "on" }));
if (fail > 0) process.exit(1);
