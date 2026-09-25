// app/lib/__tests__/property-brain.test.ts
// 物件検索ブレイン（app/lib/property-brain.ts）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/property-brain.test.ts
//
// 実物は 2026-09-23 の実データから:
//   - 間取りの希望文（property_customers.floor_plan の上位40種）: 「1LDK以上」「2LDK〜」「1K.1DK.1LDK」「1LDKか2LDK」「30平米以上」…
//   - 実送信の形: 1LDK 希望に 1DK が 1,465件・2LDK・3LDK 希望に 1K が 512件（＝ drop にしてはいけない）
//   - 見積書の本文: 「初期費用さらに\n🌟26,500円割引させて頂き\n初期費用：208,110円」
//   - フォームの自由文: 「初期費用はできるだけ安く」「敷金礼金の負担がさらに増えてもよい」「初期費用はまだ考えていない」
import {
  parsePropertyFacts, normalizeFloorPlanWant, matchFloorPlan, detectWantsLowInitialCost, parseDiscountYen,
  buildCustomerProfile, judgeProperty, applyImageFacts, formatBrainNoteLine, computeAdYen, DEFAULT_DISCOUNT_YEN,
  normalizeBuildingName, detectImageWants,
} from "../property-brain";
import { parseImageFacts } from "../property-brain-image";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

// 拡張 buildPropertySummary の形（bulk-dl.js:529-588）
const SUMMARY_A = "【3】エスリード新北野\n58,000円\n1K\n敷なし 礼なし\n十三駅 徒歩5分\nAD 2ヶ月";
const SUMMARY_B = "【1】プレサンス芦原橋ヴィブラス\n7.2万円 管理費 5,000円\n1LDK\n敷1ヶ月 礼1ヶ月\n芦原橋駅 徒歩8分\nAD 1ヶ月";
const SUMMARY_C = "【7】貴志ビル\n¥65,000\n1DK\n大国町駅 徒歩12分";          // 敷礼・AD なし（不明）
const SUMMARY_D = "【2】アドバンス大阪グロウスⅡ\n60,000円\n1K\n敷0.5ヶ月 礼なし\n徒歩3分\nAD 100,000円";

console.log("── 説明文 → 事実（表の文字が正）");
{
  const a = parsePropertyFacts(SUMMARY_A);
  t("名前と番号", a.name === "エスリード新北野" && a.rank === 3);
  t("家賃 58,000円", a.rentYen === 58_000);
  t("間取り 1K", a.floorPlan === "1K");
  t("敷なし礼なし = 0/0", a.depositMonths === 0 && a.keyMoneyMonths === 0);
  t("徒歩5分", a.walkMinutes === 5);
  t("AD 2ヶ月", a.adMonths === 2 && a.adYen === null);
  t("AD円 = 家賃×2", computeAdYen(a) === 116_000);

  const b = parsePropertyFacts(SUMMARY_B);
  t("7.2万円 → 72,000", b.rentYen === 72_000);
  t("管理費 5,000円", b.adminFeeYen === 5_000);
  t("敷1礼1", b.depositMonths === 1 && b.keyMoneyMonths === 1);
  t("AD 1ヶ月", b.adMonths === 1);

  const c = parsePropertyFacts(SUMMARY_C);
  t("¥65,000", c.rentYen === 65_000);
  t("敷礼が無い行は null（不明・減点しない）", c.depositMonths === null && c.keyMoneyMonths === null);
  t("AD 無しは null", c.adMonths === null && computeAdYen(c) === null);

  const d = parsePropertyFacts(SUMMARY_D);
  t("敷0.5ヶ月（小数）", d.depositMonths === 0.5 && d.keyMoneyMonths === 0);
  t("AD 100,000円（円形式）", d.adYen === 100_000 && d.adMonths === null && computeAdYen(d) === 100_000);
  t("徒歩だけの行でも読める", d.walkMinutes === 3);

  // data（buildPropertyData）があれば補う。itandi の変換ミス（AD 30,000円 → 30ヶ月）は捨てる
  const e = parsePropertyFacts("【1】物件\n1K", { rent: 55_000, ad_months: 30, walk_minutes: 4 });
  t("data で家賃・徒歩を補う", e.rentYen === 55_000 && e.walkMinutes === 4);
  t("ad_months=30 はありえない値として捨てる", e.adMonths === null);
}

console.log("── 間取りの希望文（実データの上位40種）を範囲・集合に正規化");
{
  const w1 = normalizeFloorPlanWant("1LDK以上");
  t("1LDK以上: 1LDK・2DK・2LDK は一致", matchFloorPlan(w1, "1LDK") === "match" && matchFloorPlan(w1, "2DK") === "match" && matchFloorPlan(w1, "2LDK") === "match");
  t("1LDK以上: 1DK は near（部屋数が同じ・実送信 1,465件）", matchFloorPlan(w1, "1DK") === "near");
  t("1LDK以上: 1K も near（drop にしない）", matchFloorPlan(w1, "1K") === "near");

  const w2 = normalizeFloorPlanWant("2LDK〜");
  t("2LDK〜: 3LDK 一致・1K は mismatch（hold 止まり）", matchFloorPlan(w2, "3LDK") === "match" && matchFloorPlan(w2, "1K") === "mismatch");

  const w3 = normalizeFloorPlanWant("1K.1DK.1LDK");
  t("1K.1DK.1LDK: 3つとも一致", ["1K", "1DK", "1LDK"].every((p) => matchFloorPlan(w3, p) === "match"));
  t("1K.1DK.1LDK: 2LDK は mismatch", matchFloorPlan(w3, "2LDK") === "mismatch");

  const w4 = normalizeFloorPlanWant("1LDKか2LDK");
  t("1LDKか2LDK", matchFloorPlan(w4, "2LDK") === "match" && matchFloorPlan(w4, "2DK") === "near");

  const w5 = normalizeFloorPlanWant("1LDK　2DK 2LDK");
  t("全角空白区切り", w5.plans.length === 3 && matchFloorPlan(w5, "2DK") === "match");

  const w6 = normalizeFloorPlanWant("1DK〜2K");
  t("1DK〜2K は範囲: 1LDK 一致・2LDK は上限超（near）", matchFloorPlan(w6, "1LDK") === "match" && matchFloorPlan(w6, "2LDK") === "near");

  const w7 = normalizeFloorPlanWant("30平米以上");
  t("30平米以上: 間取りは any・sqmMin=30", w7.any && w7.sqmMin === 30 && matchFloorPlan(w7, "1K") === "unknown");

  const w8 = normalizeFloorPlanWant("希望なし");
  t("希望なし → any", w8.any && matchFloorPlan(w8, "3LDK") === "unknown");

  const w9 = normalizeFloorPlanWant("1K(7畳)以上");
  t("1K(7畳)以上 → 1K が下限", w9.minRank != null && matchFloorPlan(w9, "1LDK") === "match");

  const w10 = normalizeFloorPlanWant("ワンルーム");
  t("ワンルーム → 1R", w10.plans.includes("1R") && matchFloorPlan(w10, "1K") === "near");

  const w11 = normalizeFloorPlanWant("3LDK(厳しければ2LDK)");
  // 2026-09-25 竹内「1DKも可の場合、1DKも入れるが評価は希望の間取りの方が少し高め」: 「厳しければ」の型は本命でなく alt（FLOOR_PLAN_ALT_MATCH）
  t("3LDK(厳しければ2LDK): 3LDK が本命・2LDK は alt", matchFloorPlan(w11, "3LDK") === "match" && matchFloorPlan(w11, "2LDK") !== "match" && JSON.stringify(w11.alt) === JSON.stringify(["2LDK"]));
}

console.log("── 初期費用を抑えたい（フォームの自由文・実物）");
{
  t("「初期費用はできるだけ安く」", detectWantsLowInitialCost({ preferences: "初期費用はできるだけ安く" }));
  t("「兎に角初期費用抑えた物件でお願いします」", detectWantsLowInitialCost({ other_requests: "兎に角初期費用抑えた物件でお願いします" }));
  t("「デザイナーズ…敷金礼金無料」", detectWantsLowInitialCost({ preferences: "デザイナーズ、階数が高くて見晴らしがいい物件、敷金礼金無料" }));
  t("「敷金礼金の負担がさらに増えてもよい」は抑えたいではない", !detectWantsLowInitialCost({ other_requests: "敷金礼金の負担がさらに増えてもよいので、もっと多くの候補物件を見たい", initial_cost_limit: 0 }));
  t("「初期費用はまだ考えていない」は抑えたいではない", !detectWantsLowInitialCost({ other_requests: "初期費用はまだ考えていない" }));
  t("initial_cost_limit 150,000 は抑えたい", detectWantsLowInitialCost({ initial_cost_limit: 150_000 }));
  t("initial_cost_limit 200,000 だけでは抑えたいにしない", !detectWantsLowInitialCost({ initial_cost_limit: 200_000 }));
  t("initial_cost_limit 0 は未入力扱い", !detectWantsLowInitialCost({ initial_cost_limit: 0 }));
}

console.log("── 割引額（AIX【見積書送る】の本文・実物）");
{
  t("🌟26,500円割引", parseDiscountYen("【アコード中之島 1402号室】\n\n初期費用さらに\n🌟26,500円割引させて頂き\n初期費用：208,110円") === 26_500);
  t("88,500円割引", parseDiscountYen("初期費用さらに\n🌟88,500円割引させて頂き\n初期費用：150,000円（") === 88_500);
  t("割引が無い本文は null", parseDiscountYen("初期費用：150,000円") === null);
  t("既定値は実測の中央値 42,000", DEFAULT_DISCOUNT_YEN === 42_000);
}

console.log("── プロフィール（条件＋過去の傾向）");
{
  const p = buildCustomerProfile({ rent_max: 70_000, rent_min: 50_000, floor_plan: "1K", walk_minutes: 10, preferences: "初期費用はなるべく抑えたい" },
    [{ property_name: "【5】エスリード新北野", rent: 58_000 }, { property_name: "ロハス江坂", rent: 62_000 }, { property_name: "貴志ビル", rent: null }]);
  t("rent_max・walk", p.rentMax === 70_000 && p.walkMax === 10);
  t("送付済み建物は【N】を落として持つ", p.history.sentBuildings.has(normalizeBuildingName("エスリード新北野")));
  t("家賃比の中央値", p.history.rentRatioMedian != null && Math.abs(p.history.rentRatioMedian - 0.857) < 0.01);
  t("抑えたい（フォーム）", p.wantsLowInitialCost && p.lowInitialCostSource === "form");
  t("3件以上送っていれば confidence high", p.confidence === "high");

  // rent_max 22,000 < rent_min 50,000（実データのフォーム入力誤り）→ 上限を使わない
  const bad = buildCustomerProfile({ rent_max: 22_000, rent_min: 50_000 });
  t("rent_max < rent_min は使わない（notes に RENT_MAX_UNRELIABLE）", bad.rentMax === null && bad.notes.includes("RENT_MAX_UNRELIABLE") && bad.confidence === "low");

  // フォームに無くても「敷礼0円」を過半で選んで送っている人は抑えたい人
  const hist = buildCustomerProfile({ rent_max: 80_000 }, [], [
    { selling_points: ["敷礼0円", "ネット無料"], selection_label: "selected" },
    { selling_points: ["敷礼0円"], selection_label: "selected" },
    { selling_points: ["角部屋"], selection_label: "selected" },
    { selling_points: ["敷礼0円"], selection_label: "not_selected" },   // not_selected は数えない
  ]);
  t("選定パターンの過半が敷礼0円 → history から抑えたい", hist.wantsLowInitialCost && hist.lowInitialCostSource === "history");

  t("割引は実物があればそれ・無ければ既定", buildCustomerProfile({}, [], [], 26_500).discountYen === 26_500 && buildCustomerProfile({}).discountYen === 42_000);
  t("画像でしか分からない希望を拾う", detectImageWants({ preferences: "バストイレ別・独立洗面所必須", ng_points: "1階・2階NG[必須]" }).join(",") === "bath_toilet_separate,separate_washstand,floor_2_plus");
}

console.log("── 判定（決定論・drop は実送信でほぼ0の形だけ）");
{
  const low = buildCustomerProfile({ rent_max: 70_000, floor_plan: "1K", walk_minutes: 10, preferences: "初期費用はなるべく抑えたい" });
  const a = judgeProperty(parsePropertyFacts(SUMMARY_A), low);
  t("敷礼0・1K・徒歩5・AD2ヶ月 → pass", a.verdict === "pass", a.reasonCodes.join(","));
  t("利益 = AD 116,000 − 42,000", a.profitYen === 74_000);
  t("理由に ZERO_ZERO_MATCH・AD_HIGH", a.reasonCodes.includes("ZERO_ZERO_MATCH") && a.reasonCodes.includes("AD_HIGH"));
  // 2026-09-24 竹内「AD の価値をもっと上げる。2ヶ月以上（200%以上）なら追加で点数を上げる」
  {
    const p = buildCustomerProfile({ rent_max: 90_000, floor_plan: "1LDK" });
    const base = "【1】X\n80,000円\n1LDK\n敷なし 礼なし\n徒歩5分";
    const none = judgeProperty(parsePropertyFacts(base), p);
    const ad1 = judgeProperty(parsePropertyFacts(base + "\nAD 1ヶ月"), p);
    const ad2 = judgeProperty(parsePropertyFacts(base + "\nAD 2ヶ月"), p);
    const ad25 = judgeProperty(parsePropertyFacts(base + "\nAD 2.5ヶ月"), p);
    const ad3 = judgeProperty(parsePropertyFacts(base + "\nAD 3ヶ月"), p);
    const adYen2 = judgeProperty(parsePropertyFacts(base + "\nAD 160,000円"), p);
    t("★ AD なし < 1ヶ月 < 2ヶ月 < 3ヶ月 の順に点が上がる", none.score < ad1.score && ad1.score < ad2.score && ad2.score < ad3.score, JSON.stringify([none.score, ad1.score, ad2.score, ad3.score]));
    t("★ 2ヶ月は1ヶ月より 15 以上高い（報酬の重み・1ヶ月 +5 → 2ヶ月 +20）", ad2.score - ad1.score >= 15, JSON.stringify([ad1.score, ad2.score]));
    t("★ 2.5ヶ月（250%）も AD_HIGH", ad25.reasonCodes.includes("AD_HIGH") && !ad25.reasonCodes.includes("AD_VERY_HIGH"));
    t("★ 円だけの AD 160,000（家賃 80,000）は2ヶ月扱い", adYen2.reasonCodes.includes("AD_HIGH") && adYen2.score === ad2.score, JSON.stringify([adYen2.score, ad2.score]));
    t("★ 理由の日本語に AD が出る", ad2.reasonsJa.includes("ADが高い（2ヶ月以上）") && ad1.reasonsJa.includes("AD 1ヶ月"));
    // AD が高くても条件の hold は覆らない
    const overAd = judgeProperty(parsePropertyFacts("【1】高い\n85,000円\n1K\n敷なし 礼なし\n徒歩5分\nAD 3ヶ月"), low);
    t("★ AD 3ヶ月でも家賃比 1.21 は hold のまま", overAd.verdict === "hold");
  }

  const b = judgeProperty(parsePropertyFacts(SUMMARY_B), low);
  t("敷1礼1（抑えたい人）・1LDK・家賃 77,000/70,000=1.10 → hold（drop ではない）", b.verdict === "hold" && b.reasonCodes.includes("INITIAL_COST_NOT_ZERO"), b.reasonCodes.join(","));
  // 2026-09-25 反証レビュー: 家賃だけ 72,000円は上限7万＋5千円の幅の中（拡張の広げた検索が拾う）・管理費込み 1.10 以内 → RENT_WIDE（旧 RENT_SLIGHTLY_OVER）
  t("家賃 1.10 ちょうど（家賃だけ上限＋5千円以内）は RENT_WIDE", b.reasonCodes.includes("RENT_WIDE"), b.reasonCodes.join(","));
  t("AD 1ヶ月 72,000 − 42,000 = 30,000 ≥ 0", b.profitYen === 30_000);

  const c = judgeProperty(parsePropertyFacts(SUMMARY_C), low);
  t("敷礼・AD が不明でも減点しない（1DK は near）→ pass", c.verdict === "pass" && c.missing.includes("deposit_key_money") && c.missing.includes("ad"), c.reasonCodes.join(","));

  // 家賃比 1.30 超だけ drop 候補（それでも影の運用では落とさない）
  const over = judgeProperty(parsePropertyFacts("【1】高い物件\n95,000円\n1K\n敷なし 礼なし\n徒歩5分\nAD 2ヶ月"), low);
  t("家賃比 1.36 → drop 候補 RENT_OVER_130", over.verdict === "drop" && over.reasonCodes.includes("RENT_OVER_130"));
  const over2 = judgeProperty(parsePropertyFacts("【1】少し高い\n85,000円\n1K\n敷なし 礼なし\n徒歩5分\nAD 2ヶ月"), low);
  t("家賃比 1.21 → hold（RENT_OVER_110）", over2.verdict === "hold" && over2.reasonCodes.includes("RENT_OVER_110"));

  // 上限が信用できない人は家賃で減点しない
  const bad = buildCustomerProfile({ rent_max: 22_000, rent_min: 50_000, floor_plan: "1K" });
  const nb = judgeProperty(parsePropertyFacts(SUMMARY_A), bad);
  t("rent_max が使えない時は家賃で落とさない", nb.verdict === "pass" && nb.reasonCodes.includes("RENT_MAX_UNRELIABLE"));

  // 実送信の形: 2LDK・3LDK 希望に 1K（512件）→ hold であって drop ではない
  const fam = buildCustomerProfile({ rent_max: 120_000, floor_plan: "2LDK・3LDK" });
  const mis = judgeProperty(parsePropertyFacts(SUMMARY_A), fam);
  t("2LDK・3LDK 希望に 1K → hold（FLOOR_PLAN_MISMATCH）・drop にしない", mis.verdict === "hold" && mis.reasonCodes.includes("FLOOR_PLAN_MISMATCH"));

  // 送付済みの建物は drop 候補
  const sentP = buildCustomerProfile({ rent_max: 70_000, floor_plan: "1K" }, [{ property_name: "【2】エスリード新北野", rent: 58_000 }]);
  const dup = judgeProperty(parsePropertyFacts(SUMMARY_A), sentP);
  t("送付済み建物 → ALREADY_SENT で drop 候補", dup.verdict === "drop" && dup.reasonCodes.includes("ALREADY_SENT"));

  // 利益: AD 1ヶ月 × 家賃 40,000 = 40,000 < 割引 42,000 → hold
  const cheap = judgeProperty(parsePropertyFacts("【1】安い\n40,000円\n1K\n敷なし 礼なし\n徒歩5分\nAD 1ヶ月"), buildCustomerProfile({ rent_max: 70_000, floor_plan: "1K" }));
  t("AD より割引が大きい → PROFIT_NEGATIVE で hold", cheap.verdict === "hold" && cheap.profitYen === -2_000);
  const bigDisc = judgeProperty(parsePropertyFacts(SUMMARY_A), buildCustomerProfile({ rent_max: 70_000, floor_plan: "1K" }, [], [], 150_000));
  t("このお客様の割引 150,000 なら AD 116,000 でも利益は負", bigDisc.profitYen === -34_000 && bigDisc.verdict === "hold");

  // 徒歩・築年
  const walk = judgeProperty(parsePropertyFacts("【1】遠い\n60,000円\n1K\n敷なし 礼なし\n徒歩16分\nAD 2ヶ月"), low);
  t("徒歩 16 > 10×1.5 → WALK_OVER で hold", walk.verdict === "hold" && walk.reasonCodes.includes("WALK_OVER"));
  const age = judgeProperty(parsePropertyFacts("【1】古い\n60,000円\n1K\n敷なし 礼なし\n徒歩5分 築25年\nAD 2ヶ月"), buildCustomerProfile({ rent_max: 70_000, building_age: 10 }));
  t("築25年 > 10+3 → BUILDING_AGE_OVER で hold", age.verdict === "hold" && age.reasonCodes.includes("BUILDING_AGE_OVER"));

  // 家賃比が「このお客様に送ってきた家賃帯」より高め
  const usual = buildCustomerProfile({ rent_max: 100_000, floor_plan: "1K" }, [{ property_name: "A", rent: 60_000 }, { property_name: "B", rent: 62_000 }, { property_name: "C", rent: 64_000 }]);
  const hi = judgeProperty(parsePropertyFacts("【1】上限ギリ\n98,000円\n1K\n敷なし 礼なし\n徒歩5分\nAD 2ヶ月"), usual);
  t("中央値 0.62 に対し 0.98 → RENT_ABOVE_USUAL（減点のみ・pass）", hi.reasonCodes.includes("RENT_ABOVE_USUAL") && hi.verdict === "pass");
}

console.log("── 画像の有無（DeepSeek の答えの読み方・判定への足し方）");
{
  const keys = ["bath_toilet_separate", "separate_washstand"] as const;
  t("JSON だけ", JSON.stringify(parseImageFacts('{"bath_toilet_separate": true, "separate_washstand": false}', [...keys])) === JSON.stringify({ bath_toilet_separate: true, separate_washstand: false }));
  t("前後に文が付いても読む", parseImageFacts('判断しました。\n{"bath_toilet_separate": true, "separate_washstand": null}\n以上', [...keys])?.bath_toilet_separate === true);
  t("0文字・全部 null は失敗（null）", parseImageFacts("", [...keys]) === null && parseImageFacts('{"bath_toilet_separate": null}', [...keys]) === null);
  t("知らないキーは無視", parseImageFacts('{"rent": 58000, "bath_toilet_separate": false}', [...keys])?.separate_washstand === null);

  const p = buildCustomerProfile({ rent_max: 70_000, floor_plan: "1K", preferences: "バストイレ別" });
  const j = judgeProperty(parsePropertyFacts(SUMMARY_A), p);
  t("画像で確かめたい希望が imageChecks に入る", j.imageChecks.includes("bath_toilet_separate"));
  const ng = applyImageFacts(j, { bath_toilet_separate: false });
  t("バストイレ別でない → hold（落とさない）", ng.verdict === "hold" && ng.reasonCodes.includes("IMAGE_BATH_TOILET_SEPARATE_NG"));
  const ok = applyImageFacts(j, { bath_toilet_separate: true });
  t("バストイレ別 → 加点・pass のまま（100点で頭打ち）", ok.verdict === "pass" && ok.score >= j.score && ok.reasonCodes.includes("IMAGE_BATH_TOILET_SEPARATE_OK"));
  t("読めなかった（null）は何も変えない", applyImageFacts(j, null).score === j.score && applyImageFacts(j, { bath_toilet_separate: null }).score === j.score);
}

console.log("── LINE 末尾の1ブロック");
{
  const low = buildCustomerProfile({ rent_max: 70_000, floor_plan: "1K", walk_minutes: 10, preferences: "初期費用はなるべく抑えたい" });
  const js = [SUMMARY_A, SUMMARY_B, "【3】高い物件\n95,000円\n1K\n敷なし 礼なし\n徒歩5分\nAD 2ヶ月"].map((s, i) => judgeProperty(parsePropertyFacts(s), low, i));
  const shadow = formatBrainNoteLine(js, false);
  t("影の運用: 「外す候補」と書く", shadow.startsWith("🧠 ブレイン判定 3件（通す1・保留1・外す候補1）") && shadow.includes("外す候補: 高い物件（家賃が上限を3割超）"));
  const real = formatBrainNoteLine(js, true);
  t("落とす運用: 「ブレインが見送った」と書く", real.includes("外した1") && real.includes("ブレインが見送った: 高い物件"));
  t("空なら空", formatBrainNoteLine([], true) === "");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
