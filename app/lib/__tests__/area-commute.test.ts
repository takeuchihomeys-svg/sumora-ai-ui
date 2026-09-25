// 2026-09-25 売上サポの判定の穴埋め（家賃下限・間取りの「も可」・広さ・築浅・エリア・通勤・条件の要約・自動の読み取りの対象）のテスト
// 実行: npx tsx app/lib/__tests__/area-commute.test.ts
// 条件の文は property_customers の desired_area・条件欄の実物の言い回し（名前・電話・番地は無い／番地は例の形だけ）
import { createHash } from "node:crypto";
import {
  normStation, stationPoint, distanceKm, LINES, STATION_COORDS, stationCount, wardsInText, townsInText, wardOfAddress, stationsInText, insideLoop,
} from "../osaka-geo";
import { shortestRoute } from "../transit-route";
import { parseAreaWant, parseCommuteWants, buildPropertyLocation, matchArea, matchCommute, locationReasonCodes, formatLocationLine } from "../area-want";
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, normalizeFloorPlanWant, parseFloorPlanAlt, reasonPoints, reasonJa, BASE_SCORE, REASON_POINTS, HOLD_REASON_CODES, SCORE_MAX,
} from "../property-brain";
import { buildConditionSummary, parseSummaryResponse, maskClause, SUMMARY_SYSTEM_PROMPT, formatSummaryLine, uncheckableLabels } from "../condition-summary";
import { strongFeatures, rowNeedsImage, pickAutoTargets, type AutoRow } from "../pickup-auto-targets";
import type { ImageWant } from "../image-wants";

/** SUMMARY_SYSTEM_PROMPT の sha256 の先頭（前置きキャッシュの見張り） */
const SUMMARY_PROMPT_HASH = "4c6628329a3a";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

console.log("■ 駅・区の位置（osaka-geo）");
{
  const c = stationCount();
  t(`全部の駅に座標がある（${c.withCoords}/${c.stations}・按分 ${c.interpolated}）`, c.withCoords === c.stations && c.stations >= 490);
  t("天六 → 天神橋筋六丁目", normStation("天六") === "天神橋筋六丁目");
  t("谷町9丁目 → 谷町九丁目", normStation("谷町9丁目") === "谷町九丁目");
  t("JR難波・大阪難波 → なんば", normStation("JR難波") === "なんば" && normStation("大阪難波駅") === "なんば");
  t("阪急淡路駅 → 淡路", normStation("阪急淡路駅") === "淡路");
  t("八戸の里 → 八戸ノ里・三宮 → 三ノ宮・大阪梅田 → 梅田", normStation("八戸の里") === "八戸ノ里" && normStation("三宮") === "三ノ宮" && normStation("大阪梅田") === "梅田");
  t("御堂筋線は 江坂→東三国→新大阪→西中島南方（拡張の並びの誤りを直した）", LINES["大阪市高速軌道御堂筋線"].slice(0, 4).join(",") === "江坂,東三国,新大阪,西中島南方");
  t("中央線に森ノ宮がある", LINES["大阪市高速軌道中央線"].includes("森ノ宮"));
  t("能勢電の平野は大阪市の平野と別の駅", LINES["能勢電鉄妙見線"].includes("平野(能勢)") && !LINES["能勢電鉄妙見線"].includes("平野"));
  let far = 0;
  for (const [line, st] of Object.entries(LINES)) for (let i = 1; i < st.length; i++) {
    const a = STATION_COORDS.get(st[i - 1]), b = STATION_COORDS.get(st[i]);
    if (a && b && distanceKm(a, b) > 6 && !/京都線|JR神戸線/.test(line)) far++;
  }
  t("隣の駅が 6km を超えて離れていない（座標の打ち間違いの見張り）", far === 0);
  const d = distanceKm(stationPoint("梅田")!, stationPoint("なんば")!);
  t(`梅田〜なんば 約4km（${d.toFixed(1)}km）`, d > 3.5 && d < 4.5);
  t("本町・心斎橋は環状線の内側・十三は外", insideLoop(stationPoint("本町")!) && insideLoop(stationPoint("心斎橋")!) && !insideLoop(stationPoint("十三")!));
  t("住所 → 区（大阪市浪速区日本橋東1丁目）", wardOfAddress("大阪府大阪市浪速区日本橋東1丁目") === "大阪市浪速区");
  t("住所 → 市（兵庫県尼崎市）", wardOfAddress("兵庫県尼崎市東難波町") === "尼崎市");
  t("「東大阪」は東大阪市（大阪駅にしない）", wardsInText("東大阪、太子橋").some((w) => w.ward === "東大阪市") && !stationsInText("東大阪、太子橋").some((s) => s.station === "大阪"));
  t("「太子橋」は太子橋今市（南河内郡太子町にしない）", stationsInText("太子橋、清水").some((s) => s.station === "太子橋今市") && !wardsInText("太子橋、清水").some((w) => /太子町/.test(w.ward)));
  t("「生野」「住之江」（区を付けない）は区", wardsInText("天王寺・生野・住之江").map((w) => w.ward).join(",") === "大阪市生野区,大阪市住之江区");
  t("町名「喜連西」→ 平野区", townsInText("喜連西周辺").some((x) => x.ward === "大阪市平野区"));
  t("1字の駅（堺）は「堺駅」の時だけ", stationsInText("七道駅・堺駅").some((s) => s.station === "堺") && !stationsInText("堺筋本町").some((s) => s.station === "堺"));
}

console.log("■ 路線のつながり（transit-route）");
{
  const r1 = shortestRoute("恵美須町", "梅田");
  t(`恵美須町→梅田 乗換1回以内・25分以内（${r1?.minutes}分・乗換${r1?.transfers}）`, !!r1 && r1.transfers <= 1 && r1.minutes <= 25);
  const r2 = shortestRoute("十三", "梅田");
  t(`十三→梅田 1駅・乗換なし（${r2?.minutes}分）`, !!r2 && r2.stops === 1 && r2.transfers === 0);
  const r3 = shortestRoute("千里中央", "本町");
  t("千里中央→本町 北急と御堂筋線は直通（乗換0）", !!r3 && r3.transfers === 0);
  const r4 = shortestRoute("住道", "北新地");
  t("住道→北新地 学研都市線と東西線は直通（乗換0）", !!r4 && r4.transfers === 0);
  const r5 = shortestRoute("堺東", "なんば");
  t(`堺東→なんば 30分以内（距離から出す・${r5?.minutes}分）`, !!r5 && r5.minutes <= 30);
  t("知らない駅は null", shortestRoute("大和小泉", "梅田") === null);
  t("同じ駅は 0分", shortestRoute("梅田", "大阪")?.minutes === 0);
}

console.log("■ エリア・通勤の希望を読む（area-want）");
{
  const w1 = parseAreaWant("塚本駅・梅田駅・新大阪駅・生野区・鶴橋・東大阪市");
  t("駅と区と市を分ける", w1.stations.map((s) => s.station).join(",") === "塚本,梅田,新大阪,鶴橋" && w1.wards.includes("大阪市生野区") && w1.wards.includes("東大阪市"));
  t("「東大阪市」で大阪市内の範囲にしない", !w1.regions.some((r) => r.kind === "osaka_city"));
  const w2 = parseAreaWant("鶴見区.今福鶴見駅、横堤駅", "日本橋から電車30分以内、鶴見区以外も検討可能");
  t("「鶴見区以外も検討可能」は除外ではない", w2.exclude.wards.length === 0);
  t("「今福鶴見」は駅（町名の今福にしない）", w2.stations.some((s) => s.station === "今福鶴見"));
  const w3 = parseAreaWant("新大阪〜大国町、阿波座、本町駅から30分圏内");
  t("「新大阪〜大国町」は間の駅も入れる", ["新大阪", "西中島南方", "梅田", "なんば", "大国町"].every((x) => w3.stations.some((s) => s.station === x)));
  t("「本町駅から30分圏内」は通勤（本町まで30分）", parseCommuteWants({ desired_area: "新大阪〜大国町、阿波座、本町駅から30分圏内" }).some((c) => c.target === "本町" && c.minutes === 30));
  const w4 = parseAreaWant("大阪府大阪市淀川区木川西3丁目811");
  t("住所の書き方は区だけ（町名の「川西」を駅にしない）", w4.wards.join(",") === "大阪市淀川区" && w4.stations.length === 0);
  const w5 = parseAreaWant("神戸三宮から5km圏内");
  t("「神戸三宮から5km圏内」→ 三ノ宮・半径5km", w5.stations[0]?.station === "三ノ宮" && w5.stations[0]?.radiusKm === 5 && w5.wards.length === 0);
  const w6 = parseAreaWant("堺筋本町駅から車で15分圏内");
  t("「車で15分圏内」→ 半径 6km", w6.stations[0]?.station === "堺筋本町" && w6.stations[0]?.radiusKm === 6);
  const w7 = parseAreaWant("大阪市内（環状線エリア）");
  t("大阪市内・環状線の内側", w7.regions.map((r) => r.kind).join(",") === "osaka_city,loop");
  const w8 = parseAreaWant("御堂筋線のあびこ駅、西田辺、昭和町駅周辺");
  t("路線（御堂筋線）＋駅＋「周辺」は半径 2km", w8.lines[0]?.word === "御堂筋線" && w8.stations.find((s) => s.station === "昭和町")?.radiusKm === 2);
  const w9 = parseAreaWant("南巽・北巽・野田阪神");
  t("「野田阪神」の阪神は路線にしない", w9.lines.length === 0 && w9.stations.some((s) => s.station === "野田阪神"));
  const w10 = parseAreaWant("治安が悪くなく帰る手段が多い地域");
  t("読めない語は unread（照らせない条件）", !w10.any && w10.unread.length === 1);
  const w11 = parseAreaWant("阿倍野以外");
  t("「◯◯以外」は除外", w11.exclude.stations.includes("阿倍野"));

  const c1 = parseCommuteWants({ desired_area: "東大阪、太子橋、清水、梅田まで電車30分" });
  t("「梅田まで電車30分」（電車の「車」を車にしない）", c1.length === 1 && c1[0].target === "梅田" && c1[0].minutes === 30);
  const c2 = parseCommuteWants({ commute_station: "難波駅・梅田駅", commute_minutes: 40 });
  t("列の通勤駅は駅ごと・分は共通", c2.map((x) => `${x.target}:${x.minutes}`).join(",") === "なんば:40,梅田:40");
  const c3 = parseCommuteWants({ desired_area: "梅田、新大阪まで車で10分ほどで行ける距離" });
  t("「車で10分」は通勤にしない", c3.length === 0);
  const c4 = parseCommuteWants({ desired_area: "北新地にアクセスがいい（出来ればミナミも）" });
  t("「北新地にアクセスがいい」は分の無い通勤", c4.length === 1 && c4[0].target === "北新地" && c4[0].minutes == null);
}

console.log("■ 物件の場所と照らす");
{
  const pdfText = "物件名 テストレジデンス\n所在地 大阪府大阪市浪速区恵美須西1丁目\n交通\n堺筋線「恵美須町」徒歩5分\n御堂筋線「動物園前」徒歩9分\n賃料\n75,000 円";
  const loc = buildPropertyLocation("【1】テストレジデンス\n75,000円\n1K 25.62㎡", pdfText);
  t("交通の駅（徒歩の短い順）と所在地の区", loc.stations[0]?.station === "恵美須町" && loc.stations[0]?.walk === 5 && loc.ward === "大阪市浪速区" && loc.wardSource === "address");
  const m = (area: string, free?: string) => matchArea(parseAreaWant(area, free), loc);
  t("希望の駅そのもの → AREA_STATION_MATCH", m("恵美須町・大国町")?.code === "AREA_STATION_MATCH");
  t("希望の区 → AREA_WARD_MATCH", m("浪速区")?.code === "AREA_WARD_MATCH");
  t("希望の路線（堺筋線）→ AREA_LINE_MATCH", m("堺筋線沿い")?.code === "AREA_LINE_MATCH");
  // 2026-09-25: 動物園前（徒歩9分）は大国町の隣（御堂筋線）＝拡張の広げて検索の駅 → 距離の AREA_NEAR ではなく AREA_STATION_WIDE +8
  const wide = m("大国町");
  t(`大国町の隣の駅（動物園前）→ AREA_STATION_WIDE（${wide?.why}）`, wide?.code === "AREA_STATION_WIDE" && (wide?.why ?? "").includes("動物園前") && (wide?.why ?? "").includes("御堂筋線"));
  t("日本橋の隣（恵美須町・堺筋線）→ AREA_STATION_WIDE", m("日本橋")?.code === "AREA_STATION_WIDE");
  t("なんばから御堂筋線で2駅（動物園前）→ AREA_STATION_2STOPS", m("なんば")?.code === "AREA_STATION_2STOPS");
  t("希望の区（浪速区）は2駅より上（+8）", m("浪速区・なんば")?.code === "AREA_WARD_MATCH");
  t("西区の希望に浪速区 → 難波・心斎橋の3区 AREA_WARD_WIDE", m("西区")?.code === "AREA_WARD_WIDE");
  const near = m("今宮");
  t(`今宮から 2km 以内（同じ路線ではない）→ AREA_NEAR（${near?.km}km）`, near?.code === "AREA_NEAR" && (near?.km ?? 9) < 2);
  t("徒歩15分を超える駅は隣でも広げた検索の駅にしない", matchArea(parseAreaWant("大国町"), buildPropertyLocation("【1】A", "交通\n御堂筋線「動物園前」徒歩18分"))?.code !== "AREA_STATION_WIDE");
  t("隣の区（西成区）→ AREA_CLOSE か近い", ["AREA_CLOSE", "AREA_NEAR"].includes(m("西成区")?.code ?? ""));
  const far = m("茨木市");
  t(`茨木市 → AREA_FAR（${far?.why}）`, far?.code === "AREA_FAR");
  t("大阪市内 → AREA_REGION_MATCH", m("大阪市内")?.code === "AREA_REGION_MATCH");
  t("「恵美須町以外」→ AREA_EXCLUDED", m("恵美須町以外")?.code === "AREA_EXCLUDED");
  t("希望が読めない → 札なし", m("治安が良い所") === null);
  t("場所が読めない物件 → AREA_UNKNOWN", matchArea(parseAreaWant("大国町"), buildPropertyLocation("【1】物件\nAD 1ヶ月", null))?.code === "AREA_UNKNOWN");
  const cm = matchCommute(parseCommuteWants({ desired_area: "梅田まで電車30分" }), loc);
  t(`梅田まで30分以内 → COMMUTE_OK（${cm[0]?.why}）`, cm[0]?.code === "COMMUTE_OK" && (cm[0]?.minutes ?? 99) <= 30);
  const cm2 = matchCommute(parseCommuteWants({ desired_area: "北加賀屋駅まで10分以内" }), loc);
  t(`北加賀屋まで10分 → COMMUTE_OVER（情報・保留にしない）（${cm2[0]?.minutes}分）`, cm2[0]?.code === "COMMUTE_OVER" && !HOLD_REASON_CODES.has("COMMUTE_OVER"));
  const cm3 = matchCommute(parseCommuteWants({ desired_area: "梅田まで電車30分" }), buildPropertyLocation("【1】物件", null));
  t("最寄り駅が読めない → COMMUTE_UNKNOWN", cm3[0]?.code === "COMMUTE_UNKNOWN");
  const line = formatLocationLine(loc, near, cm);
  t(`画面の1行（${line}）`, line.startsWith("📍 恵美須町 徒歩5分・浪速区") && line.includes("梅田まで約"));
  t("札は エリア1つ＋通勤1つ", locationReasonCodes(near, cm).join(",") === "AREA_NEAR,COMMUTE_OK");
}

console.log("■ 家賃下限・間取りの「も可」・広さ・築浅（property-brain）");
{
  const S = (rent: string, plan: string, extra = "") => `【1】テスト\n${rent}\n${plan}\n敷なし 礼なし\n徒歩5分\nAD 2ヶ月${extra}`;
  const p1 = buildCustomerProfile({ rent_max: 80_000, rent_min: 60_000, floor_plan: "1LDK" });
  t("下限は上限より小さい時だけ使う", p1.rentMin === 60_000 && buildCustomerProfile({ rent_max: 50_000, rent_min: 60_000 }).rentMin === null);
  const j1 = judgeProperty(parsePropertyFacts(S("45,000円", "1LDK")), p1);
  t("下限の85%未満 → RENT_BELOW_MIN（−3・保留にしない）", j1.reasonCodes.includes("RENT_BELOW_MIN") && !j1.flagCodes.includes("RENT_BELOW_MIN"));
  const j2 = judgeProperty(parsePropertyFacts(S("55,000円", "1LDK")), p1);
  t("下限の85%以上（55,000/60,000）は札なし", !j2.reasonCodes.includes("RENT_BELOW_MIN"));

  const w = normalizeFloorPlanWant("1LDK（1DKも可）");
  t("列の「1DKも可」は alt（本命は 1LDK だけ）", w.plans.join(",") === "1LDK" && (w.alt ?? []).join(",") === "1DK");
  const p2 = buildCustomerProfile({ rent_max: 90_000, floor_plan: "1LDK（1DKも可）" });
  const jm = judgeProperty(parsePropertyFacts(S("80,000円", "1LDK")), p2);
  const ja = judgeProperty(parsePropertyFacts(S("80,000円", "1DK")), p2);
  t("本命 1LDK +15 ＞ も可 1DK +8", jm.reasonCodes.includes("FLOOR_PLAN_MATCH") && ja.reasonCodes.includes("FLOOR_PLAN_ALT_MATCH") && jm.score - ja.score === 7);
  const p3 = buildCustomerProfile({ rent_max: 90_000, floor_plan: "1LDK", other_requests: "1DKでも大丈夫です" });
  t("自由文の「1DKでも大丈夫」も alt", (p3.floorPlanAlt?.plans ?? []).join(",") === "1DK");
  const p4 = buildCustomerProfile({ rent_max: 90_000, floor_plan: "1LDK", raw_format_text: "間取り: 1LDK or 2K" });
  t("フォームの「1LDK or 2K」→ 2K が alt", (p4.floorPlanAlt?.plans ?? []).join(",") === "2K");
  t("「今1Kに住んでいて」は alt にしない", parseFloorPlanAlt({ other_requests: "今1Kに住んでいて狭い" }, normalizeFloorPlanWant("1LDK")) === null);
  t("「1Kは嫌」は alt にしない", parseFloorPlanAlt({ other_requests: "1Kは嫌、1DKも可" }, normalizeFloorPlanWant("1LDK"))?.plans.join(",") === "1DK");

  const p5 = buildCustomerProfile({ rent_max: 90_000, floor_area_min: 30 });
  const sqOk = judgeProperty(parsePropertyFacts(S("80,000円", "1LDK 31.2㎡")), p5);
  const sqWide = judgeProperty(parsePropertyFacts(S("80,000円", "1K 25.0㎡")), p5);
  const sqUnder = judgeProperty(parsePropertyFacts(S("80,000円", "1K 24.5㎡")), p5);
  const sqNone = judgeProperty(parsePropertyFacts(S("80,000円", "1K")), p5);
  t("広さ: 以上 +3・−5㎡まで（広げた検索の幅）は −3 の情報・それより下は保留・読めない時は要確認",
    sqOk.reasonCodes.includes("SQM_OK") && sqWide.reasonCodes.includes("SQM_WIDE") && !sqWide.flagCodes.includes("SQM_WIDE")
    && sqUnder.flagCodes.includes("SQM_UNDER") && sqUnder.verdict === "hold" && sqNone.reasonCodes.includes("SQM_UNKNOWN"));
  const p6 = buildCustomerProfile({ rent_max: 90_000, preferences: "築浅が良い" });
  t("築浅（築年の列が空）→ 目安10年", p6.ageTextMax?.years === 10);
  const a1 = judgeProperty(parsePropertyFacts(S("80,000円", "1K", "\n築5年")), p6);
  const a2 = judgeProperty(parsePropertyFacts(S("80,000円", "1K", "\n築30年")), p6);
  t("築浅に合う +3・古い 0点（保留にしない）", a1.reasonCodes.includes("BUILDING_AGE_TEXT_OK") && a2.reasonCodes.includes("BUILDING_AGE_TEXT_OVER") && a2.verdict !== "hold");
  t("「新築じゃなくても」は読まない", buildCustomerProfile({ preferences: "新築じゃなくても大丈夫" }).ageTextMax == null);
  // 2026-09-25 全件監査で見つけた読み違いの直し（実物の言い回し）
  t("条件の記録の古い「間取り:」は使わない（最後の1つだけ）", parseFloorPlanAlt({ additional_conditions: "[6/24 23:54] 間取り: 1LDK / 家賃: 〜10万\n[6/30 15:58] 間取り: 1DK / その他: 条件を1LDKから1DKに変更\n[7/23 23:11] 間取り: 1LDK" }, normalizeFloorPlanWant("1LDK")) === null);
  t("最後の記録の「間取り: 1DK・1LDK」は も可", parseFloorPlanAlt({ additional_conditions: "[8/29 15:06|auto] 間取り: 1DK・1LDK / 広さ: 35㎡以上" }, normalizeFloorPlanWant("1LDK"))?.plans.join(",") === "1DK");
  t("フォームの質問の例「間取り(1K、1LDKなど)」は読まない", parseFloorPlanAlt({ raw_format_text: "4間取り(1K、1LDKなど)\n1LDK" }, normalizeFloorPlanWant("1LDK")) === null);
  t("フォームの「希望の間取り ⇒1K 1DK 1LDK」は本命", buildCustomerProfile({ floor_plan: "1K", raw_format_text: "【希望の広さ・間取り】⇒1K 1DK 1LDK" }).floorPlanWant.plans.join(",") === "1K,1DK,1LDK");
  t("自由文の「25平米」→ 広さの下限（「以下」は読まない）", buildCustomerProfile({ preferences: "25平米くらいは欲しい" }).sqmMin === 25 && buildCustomerProfile({ preferences: "40㎡以下" }).sqmMin == null);
}

console.log("■ 点の表（REASON_POINTS）と 50＋合計＝score（新しい札）");
{
  const p = buildCustomerProfile({ rent_max: 80_000, rent_min: 70_000, floor_plan: "1LDK（1DKも可）", floor_area_min: 30, preferences: "築浅" });
  const cases: Array<[string, string[]]> = [
    ["【1】A\n50,000円\n1DK 25㎡\n敷なし 礼なし\n徒歩5分\n築3年\nAD 2ヶ月", ["AREA_STATION_MATCH", "COMMUTE_OK"]],
    ["【2】B\n78,000円\n1LDK 32㎡\n敷1ヶ月 礼なし\n徒歩5分\n築20年\nAD 1ヶ月", ["AREA_FAR", "AREA_DIRECTION_NG", "COMMUTE_OVER"]],
    ["【3】C\n78,000円\n1LDK\n敷なし 礼なし\nAD 3ヶ月", ["AREA_EXCLUDED", "COMMUTE_UNKNOWN"]],
    ["【4】D\n60,000円\n1LDK 28㎡\n敷なし 礼なし\nAD 2ヶ月", ["AREA_NEAR", "COMMUTE_SLIGHTLY_OVER"]],
    ["【5】E\n60,000円\n1DK\n敷なし 礼なし", ["AREA_WARD_MATCH", "COMMUTE_INFO"]],
    ["【6】F\n60,000円\n2LDK", ["AREA_LINE_MATCH"]],
    ["【7】G\n60,000円\n1LDK", ["AREA_REGION_MATCH"]],
    ["【8】H\n60,000円\n1LDK", ["AREA_CLOSE", "AREA_UNKNOWN"]],
  ];
  for (const [s, loc] of cases) {
    const j = judgeProperty(parsePropertyFacts(s), p, 0, { locationCodes: loc });
    const raw = Math.max(0, Math.min(SCORE_MAX, BASE_SCORE + j.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0)));
    t(`${s.split("\n")[0]} ${j.reasonCodes.filter((c) => /^(AREA|COMMUTE|SQM|FLOOR|RENT_BELOW|BUILDING_AGE_TEXT)/.test(c)).join(",")} → ${j.score}`, raw === j.score);
  }
  const ex = judgeProperty(parsePropertyFacts(cases[2][0]), p, 0, { locationCodes: ["AREA_EXCLUDED"] });
  t("AREA_EXCLUDED は保留（外す候補にはしない）", ex.verdict === "hold" && ex.flagCodes.includes("AREA_EXCLUDED"));
  const fr = judgeProperty(parsePropertyFacts("【9】I\n60,000円\n1LDK\n敷なし 礼なし\n徒歩5分\nAD 2ヶ月"), buildCustomerProfile({ rent_max: 80_000, floor_plan: "1LDK" }), 0, { locationCodes: ["AREA_FAR"] });
  t("AREA_FAR は保留にしない（検索を広げたのは意図）", fr.verdict === "pass" && !fr.flagCodes.includes("AREA_FAR") && fr.reasonsJa.includes(reasonJa("AREA_FAR")));
  const newCodes = Object.keys(REASON_POINTS).filter((c) => /^(AREA|COMMUTE|SQM|FLOOR_PLAN_ALT|RENT_BELOW|BUILDING_AGE_TEXT)/.test(c));
  t(`新しい札は全部に日本語がある（${newCodes.length}個）`, newCodes.every((c) => reasonJa(c) !== c));
  t("locationCodes に知らない札が来ても足さない", !judgeProperty(parsePropertyFacts("【1】A\n60,000円"), p, 0, { locationCodes: ["RENT_OK", "X"] }).reasonCodes.includes("X"));
}

console.log("■ 条件の要約（condition-summary）");
{
  const s = buildConditionSummary({
    rent_max: 80_000, rent_min: 60_000, floor_plan: "1LDK（1DKも可）", walk_minutes: 10, desired_area: "大国町・浪速区・梅田まで電車30分",
    preferences: "宅配BOX必須、白基調のお部屋、治安が良い所", ng_points: "1階", other_requests: "タバコは吸いません",
  });
  const line = formatSummaryLine(s.items);
  t(`決定論の要約（${line}）`, /家賃 6万〜8万/.test(line) && /間取り 1LDK/.test(line) && /1DKも可/.test(line) && /エリア 大国町・浪速区/.test(line) && /通勤 梅田まで30分/.test(line) && /宅配ボックス/.test(line));
  t("読めない節（白基調）は unread", s.unread.some((x) => /白基調/.test(x)));
  t("喫煙（タバコ）は照らせない条件に出さない", ![...s.unread, ...s.unchecked].some((x) => /タバコ/.test(x)));
  const u = uncheckableLabels(s);
  t(`照らせない条件に種類の目印（${u.join("／")}）`, u.some((x) => /^内装: /.test(x)));
  const ai = parseSummaryResponse('{"items":[{"i":1,"kind":"内装","mode":"soft","label":"白基調の内装"},{"i":9,"kind":"内装","mode":"soft","label":"範囲外"},{"i":2,"kind":"喫煙","mode":"must","label":"x"}]}', 2);
  t("DeepSeek の答えは番号・種類を確かめて取る", ai.length === 1 && ai[0].label === "白基調の内装" && ai[0].by === "ai");
  t("形が崩れていれば空", parseSummaryResponse("すみません", 2).length === 0);
  t("番地・電話・メールを伏せる", maskClause("中央区1-2-3 090-1234-5678 a@b.jp").indexOf("1-2-3") < 0 && !/090/.test(maskClause("090-1234-5678")) && !/@/.test(maskClause("a@b.jp")));
  const h = createHash("sha256").update(SUMMARY_SYSTEM_PROMPT).digest("hex").slice(0, 12);
  t(`固定の前置きは変わっていない（変えたら版 CONDITION_SUMMARY_VERSION も上げる）: ${h}`, h === SUMMARY_PROMPT_HASH);
}

console.log("■ 自動の読み取りの対象（pickup-auto-targets）");
{
  const W = (text: string): ImageWant => ({ id: "W1", source: "条件", text, topics: [], ng: false, must: false });
  t("WIC・対面キッチンは強い設備", strongFeatures([W("WIC が欲しい"), W("対面キッチン")]).sort().join(",") === "counter_kitchen,wic");
  t("宅配BOX だけは強い設備なし（DeepSeek 0回）", strongFeatures([W("宅配BOX")]).length === 0);
  const eqDecided = { match: [{ key: "walk_in_closet", label: "WIC", mode: "must" as const, strong: false, result: "ok" as const, mark: "○", why: "" }] };
  t("設備欄で WIC が決まった物件は読まない", !rowNeedsImage(["wic"], eqDecided));
  t("部屋の配置は設備欄では決まらない＝読む", rowNeedsImage(["wic", "layout"], eqDecided));
  const R = (id: number, rank: number, extra: Partial<AutoRow> = {}): AutoRow => ({ id, rank, site: "realpro", pdf_url: null, pdf_blob_url: "https://x/p.pdf", pdf_text: null, summary_text: "", trim_image_url: null, page_image_url: null, pdf_has_text: true, image_analysis: null, verdict: "pass", equipment: null, ...extra });
  const rows = [R(1, 1), R(2, 2, { verdict: "drop" }), R(3, 3, { image_analysis: { match: 50 } }), R(4, 4, { pdf_blob_url: null }), R(5, 5, { equipment: eqDecided as unknown as AutoRow["equipment"] }), ...Array.from({ length: 25 }, (_, k) => R(10 + k, 10 + k))];
  const pk = pickAutoTargets(rows, ["wic"]);
  t("外す候補・保存済み・資料なし・設備欄で決まった物は読まない", ["外す候補", "保存済み", "資料なし", "設備欄で決まった"].every((why) => pk.skipped.some((s) => s.why === why)));
  t("最大 20件", pk.targets.length === 20 && pk.skipped.some((s) => s.why === "上限"));
}

console.log("■ 「◯◯より南は避けたい」＝その向きを避ける（2026-09-25 YUMA で南の希望と読んでいた）");
{
  const loc = (s: string) => buildPropertyLocation(s, null);
  const avoid = parseAreaWant("新大阪・なんば", "梅田まで30分以内、難波より南は避けたい");
  t("避けたい → 反対の向き（north）で持ち、言い方は元のまま", avoid.directions.length === 1 && avoid.directions[0].dir === "north" && avoid.directions[0].label === "なんばより南は避けたい");
  const north = matchArea(avoid, loc("【1】A\n御堂筋線 新大阪駅 徒歩5分\n65,000円"));
  t("新大阪（北）には札を付けない", !!north && north.code !== "AREA_DIRECTION_NG" && !north.directionNg);
  const south = matchArea(avoid, loc("【1】B\nJR大阪環状線 天王寺駅 徒歩5分\n65,000円"));
  t("天王寺（南）に「なんばより南は避けたいに当たる」", !!south && /なんばより南は避けたいに当たる/.test(south.directionNg ?? south.why));
  const want = parseAreaWant("西中島南方より北のエリア", null);
  t("「より北のエリア」は今まで通り north（避ける言い方ではない）", want.directions[0]?.dir === "north" && want.directions[0]?.label === "西中島南方より北");
  const ng = parseAreaWant("", "梅田より南はNG");
  t("「より南はNG」も避ける", ng.directions[0]?.dir === "north");
  t("要約に「なんばより南は避けたい」", /なんばより南は避けたい/.test(formatSummaryLine(buildConditionSummary({ desired_area: "新大阪・なんば", other_requests: "難波より南は避けたい" }).items)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
