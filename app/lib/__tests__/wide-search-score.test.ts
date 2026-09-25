// 2026-09-25 竹内「広げて検索した場合も、お客さんの希望の駅の方が点数少し大きくするように。隣の駅だからって点数が大幅に低くなるようにしない。
//   これは家賃とかでもそう。判断基準、広げて検索の部分（拡張ツール）のところも理解してスコアリングの判定を精密に強化」
// 実行: npx tsx app/lib/__tests__/wide-search-score.test.ts
// 拡張の広げ方（chrome-extension/resolution-core.js resolveConditionsLocal・popup.js・page-script.js）:
//   家賃 上限＋5,000円（10万円以下）／＋10,000円（10万円超）・築年 ＋5年・LDK の希望に同じ部屋数の DK・駅は同じ路線の前後1駅・難波の3区
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, reasonPoints, reasonJa, isWideFloorPlan, normalizeFloorPlanWant, wideRentBuffer,
  BASE_SCORE, SCORE_MAX, REASON_POINTS, HOLD_REASON_CODES, DROP_REASON_CODES,
} from "../property-brain";
import { parseAreaWant, buildPropertyLocation, matchArea, adjacentStations, stopsBetween } from "../area-want";
import { buildReasonView } from "../pickup-review-order";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info === undefined ? "" : JSON.stringify(info)); }
};
const S = (rent: string, plan: string, extra = "") => `【1】テスト\n${rent}\n${plan}\n${extra}`;

console.log("■ 家賃: 上限内 +15 ／ 広げた検索の幅 +10 ／ 幅の外 1.10 まで 0 ／ 1.10 超は保留");
{
  t("幅は 10万円以下 5,000円・10万円超 10,000円（拡張と同じ算術）", wideRentBuffer(80_000) === 5_000 && wideRentBuffer(100_000) === 5_000 && wideRentBuffer(100_001) === 10_000);
  const p = buildCustomerProfile({ rent_max: 80_000 });
  const code = (s: string) => judgeProperty(parsePropertyFacts(S(s, "1K")), p).reasonCodes.find((c) => c.startsWith("RENT_"));
  t("80,000円 → RENT_OK", code("80,000円") === "RENT_OK");
  t("75,000円＋管理費10,000円＝85,000円（上限＋5千円）→ RENT_WIDE", code("75,000円 10,000円") === "RENT_WIDE");
  t("家賃だけ上限内（78,000円）＋管理費9,000円＝87,000（1.09）→ RENT_WIDE（拡張のピンポイントでも拾う）", code("78,000円 9,000円") === "RENT_WIDE");
  // 反証レビュー 2026-09-25: 家賃だけ 83,000円（上限＋5千円以内＝広げた検索で拾う）＋管理費3,000円＝86,000円 は、高い 87,000円（上の行）が +10 なのに 0点だった
  t("家賃 83,000円＋管理費3,000円＝86,000円（家賃は上限＋5千円以内・1.10 以内）→ RENT_WIDE", code("83,000円 3,000円") === "RENT_WIDE");
  t("家賃 86,000円・管理費なし（家賃が幅の外・1.10 以内）→ RENT_SLIGHTLY_OVER", code("86,000円") === "RENT_SLIGHTLY_OVER");
  // 2026-09-25 任務B: 比が 1.10 を超えても、超過が上限＋1万円以内なら保留にしない（🌟の超過は 1万円以内が 80%）
  t("家賃 85,000円＋管理費5,000円＝90,000円（1.125・＋1万円ちょうど）→ RENT_SLIGHTLY_OVER（保留にしない）", code("85,000円 5,000円") === "RENT_SLIGHTLY_OVER");
  t("家賃 80,000円＋管理費10,500円＝90,500円（1.13・＋1万500円）→ 保留 RENT_OVER_110", code("80,000円 10,500円") === "RENT_OVER_110");
  const p2 = buildCustomerProfile({ rent_max: 120_000 });
  t("上限12万: 129,000円（＋1万円の幅）→ RENT_WIDE", judgeProperty(parsePropertyFacts(S("129,000円", "1LDK")), p2).reasonCodes.includes("RENT_WIDE"));
  const ok = judgeProperty(parsePropertyFacts(S("80,000円", "1K")), p);
  const wide = judgeProperty(parsePropertyFacts(S("75,000円 10,000円", "1K")), p);
  t("上限内と幅の中の差は 5点だけ（旧 15点）・どちらも保留にしない", ok.score - wide.score === 5 && wide.verdict === "pass", [ok.score, wide.score, wide.verdict]);
}

console.log("■ 間取り: 本命 +15 ／ LDK→同じ部屋数の DK（広げた検索の型）+8 ／ 近い +5");
{
  t("1LDK の希望に 1DK は広げた検索の型", isWideFloorPlan(normalizeFloorPlanWant("1LDK"), "1DK"));
  t("1LDK以上 の希望にも 1DK は広げた検索の型", isWideFloorPlan(normalizeFloorPlanWant("1LDK以上"), "1DK"));
  t("2LDK の希望に 1DK は違う（部屋数が違う）", !isWideFloorPlan(normalizeFloorPlanWant("2LDK"), "1DK"));
  t("1DK の希望に 1K は広げた検索の型ではない", !isWideFloorPlan(normalizeFloorPlanWant("1DK"), "1K"));
  const p = buildCustomerProfile({ rent_max: 90_000, floor_plan: "1LDK" });
  const m = judgeProperty(parsePropertyFacts(S("80,000円", "1LDK")), p);
  const w = judgeProperty(parsePropertyFacts(S("80,000円", "1DK")), p);
  t("1DK → FLOOR_PLAN_WIDE・本命との差 7点（旧 近い +5 で差10）", w.reasonCodes.includes("FLOOR_PLAN_WIDE") && m.score - w.score === 7, [m.score, w.score, w.reasonCodes]);
  const alt = judgeProperty(parsePropertyFacts(S("80,000円", "1DK")), buildCustomerProfile({ rent_max: 90_000, floor_plan: "1LDK（1DKも可）" }));
  t("「1DKも可」と書いてある時は ALT（お客様の言葉が先）", alt.reasonCodes.includes("FLOOR_PLAN_ALT_MATCH") && !alt.reasonCodes.includes("FLOOR_PLAN_WIDE"));
}

console.log("■ 築年 ＋5年まで +2 ／ 広さ −5㎡まで −3（どちらも保留にしない）");
{
  const p = buildCustomerProfile({ rent_max: 90_000, building_age: 10 });
  const c = (age: number) => judgeProperty(parsePropertyFacts(S("80,000円", "1K", `築${age}年`)), p);
  t("築10年 → OK・築15年 → WIDE（保留なし）・築16年 → OVER（保留）", c(10).reasonCodes.includes("BUILDING_AGE_OK") && c(15).reasonCodes.includes("BUILDING_AGE_WIDE") && c(15).verdict === "pass" && c(16).flagCodes.includes("BUILDING_AGE_OVER"));
  t("築年: 希望内と幅の中の差は 3点", c(10).score - c(15).score === 3, [c(10).score, c(15).score]);
  const q = buildCustomerProfile({ rent_max: 90_000, floor_area_min: 25 });
  const a = (sqm: number) => judgeProperty(parsePropertyFacts(S("80,000円", `1K ${sqm}㎡`)), q);
  t("25㎡の希望: 23㎡ 0点（9割以上）・21㎡ SQM_WIDE −3（情報）・19㎡ 保留", a(23).reasonCodes.includes("SQM_SLIGHTLY_UNDER") && a(21).reasonCodes.includes("SQM_WIDE") && a(21).verdict === "pass" && a(19).flagCodes.includes("SQM_UNDER"));
}

console.log("■ 駅: 希望 +10 ／ 隣（広げた検索の駅）+8 ／ 2駅 +6 ／ 範囲の外は距離のまま");
{
  t("東三国の隣は 江坂・新大阪（写した辞書の順の誤りを直した並び）", adjacentStations("東三国").sort().join(",") === ["新大阪", "江坂"].sort().join(","));
  t("東三国〜西中島南方 は御堂筋線で2駅", stopsBetween("東三国", "西中島南方")?.stops === 2);
  const want = parseAreaWant("東三国");
  const at = (st: string, walk = 6) => matchArea(want, buildPropertyLocation(`【1】A\n${st}駅 徒歩${walk}分`, null));
  t("東三国 → AREA_STATION_MATCH", at("東三国")?.code === "AREA_STATION_MATCH");
  t("新大阪 → AREA_STATION_WIDE（広げた検索の駅）", at("新大阪")?.code === "AREA_STATION_WIDE" && (at("新大阪")?.why ?? "").includes("広げた検索の駅"));
  t("西中島南方 → AREA_STATION_2STOPS", at("西中島南方")?.code === "AREA_STATION_2STOPS");
  t("梅田（御堂筋線で5駅）→ 距離の札のまま（広げた検索の範囲の外）", !["AREA_STATION_MATCH", "AREA_STATION_WIDE", "AREA_STATION_2STOPS"].includes(at("梅田")?.code ?? ""));
  t("隣でも徒歩18分の駅は広げた検索の駅にしない", at("新大阪", 18)?.code !== "AREA_STATION_WIDE");
  const p = buildCustomerProfile({ rent_max: 90_000 });
  const f = parsePropertyFacts(S("80,000円", "1K"));
  const jm = judgeProperty(f, p, 0, { locationCodes: ["AREA_STATION_MATCH"] });
  const jw = judgeProperty(f, p, 0, { locationCodes: ["AREA_STATION_WIDE"] });
  t("希望の駅と隣の駅の差は 2点（旧 +10 と 2km 以内 +5 で差5）", jm.score - jw.score === 2, [jm.score, jw.score]);
  t("希望の駅が隣の駅より上（同じ条件なら）", jm.score > jw.score);
  // 反証レビュー 2026-09-25: 駅のまとまり（梅田＝大阪・西梅田・北新地 等）は希望の駅。前は JR大阪 +5（距離）で、隣の中津 +8 より低かった
  const um = (st: string) => matchArea(parseAreaWant("梅田"), buildPropertyLocation(`【1】A\n${st}駅 徒歩5分`, null))?.code;
  t("梅田の希望に 大阪・西梅田・北新地・東梅田 → AREA_STATION_MATCH", ["大阪", "西梅田", "北新地", "東梅田"].every((s) => um(s) === "AREA_STATION_MATCH"), ["大阪", "西梅田", "北新地", "東梅田"].map(um));
  t("梅田の希望に 中津・中崎町（まとまりの駅の隣）→ AREA_STATION_WIDE", um("中津") === "AREA_STATION_WIDE" && um("中崎町") === "AREA_STATION_WIDE");
  t("天王寺の希望に 大阪阿部野橋 → AREA_STATION_MATCH", matchArea(parseAreaWant("天王寺"), buildPropertyLocation("【1】A\n大阪阿部野橋駅 徒歩5分", null))?.code === "AREA_STATION_MATCH");
  // 環状線は輪（大阪…天満 が両端）
  t("環状線: 天満〜大阪 は隣（輪を閉じる）", stopsBetween("天満", "大阪")?.stops === 1);
  t("天満の希望に大阪の物件 → AREA_STATION_WIDE", matchArea(parseAreaWant("天満"), buildPropertyLocation("【1】A\n大阪駅 徒歩5分", null))?.code === "AREA_STATION_WIDE");
}

console.log("■ 難波・心斎橋の3区（拡張が地域の広げて検索でまとめて足す）");
{
  const loc = buildPropertyLocation("【1】A", "所在地 大阪府大阪市西区北堀江1丁目\n交通\n長堀鶴見緑地線「西大橋」徒歩3分");
  t("中央区の希望に西区 → AREA_WARD_WIDE", matchArea(parseAreaWant("中央区"), loc)?.code === "AREA_WARD_WIDE");
  t("北区の希望に西区 → 3区の外（AREA_WARD_WIDE にしない）", matchArea(parseAreaWant("北区"), loc)?.code !== "AREA_WARD_WIDE");
}

console.log("■ 点の表・上限・保留");
{
  const WIDE = ["RENT_WIDE", "FLOOR_PLAN_WIDE", "BUILDING_AGE_WIDE", "SQM_WIDE", "AREA_STATION_WIDE", "AREA_STATION_2STOPS", "AREA_WARD_WIDE"];
  t("広げた検索の札は全部 点の表と日本語がある", WIDE.every((c) => c in REASON_POINTS && reasonJa(c) !== c));
  t("広げた検索の札は保留・外す候補にしない", WIDE.every((c) => !HOLD_REASON_CODES.has(c) && !DROP_REASON_CODES.has(c)));
  t("希望どおり ＞ 広げた検索の幅（駅・家賃・間取り・築年）",
    REASON_POINTS.AREA_STATION_MATCH > REASON_POINTS.AREA_STATION_WIDE && REASON_POINTS.AREA_STATION_WIDE > REASON_POINTS.AREA_STATION_2STOPS
    && REASON_POINTS.RENT_OK > REASON_POINTS.RENT_WIDE && REASON_POINTS.RENT_WIDE > REASON_POINTS.RENT_SLIGHTLY_OVER
    && REASON_POINTS.FLOOR_PLAN_MATCH > REASON_POINTS.FLOOR_PLAN_WIDE && REASON_POINTS.FLOOR_PLAN_WIDE > REASON_POINTS.FLOOR_PLAN_NEAR
    && REASON_POINTS.BUILDING_AGE_OK > REASON_POINTS.BUILDING_AGE_WIDE && REASON_POINTS.SQM_SLIGHTLY_UNDER > REASON_POINTS.SQM_WIDE && REASON_POINTS.SQM_WIDE > REASON_POINTS.SQM_UNDER);
  // 条件が全部合う物件（家賃・敷礼0・間取り・広さ・徒歩・築年・希望の駅）で AD の差が上限で消えない
  const p = buildCustomerProfile({ rent_max: 90_000, floor_plan: "1LDK", floor_area_min: 30, walk_minutes: 10, building_age: 10, other_requests: "初期費用を抑えたい" });
  const full = (ad: string) => judgeProperty(parsePropertyFacts(`【1】A\n80,000円\n1LDK 35㎡\n敷なし 礼なし\n徒歩5分\n築3年\n${ad}`), p, 0, { locationCodes: ["AREA_STATION_MATCH", "COMMUTE_OK"] });
  const s1 = full("AD 1ヶ月").score, s2 = full("AD 2ヶ月").score, s3 = full("AD 3ヶ月").score, s0 = full("").score;
  t(`全部合う物件で AD の差が残る（AD不明 ${s0} ＜ 1ヶ月 ${s1} ＜ 2ヶ月 ${s2} ＜ 3ヶ月 ${s3}・上限 ${SCORE_MAX}）`, s0 < s1 && s1 < s2 && s2 === s3 && s3 < SCORE_MAX && s0 > 130);
  const j = full("AD 2ヶ月");
  t("50＋合計＝score（上限の内側）", BASE_SCORE + j.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0) === j.score);
  const v = buildReasonView({ reason_codes: ["AREA_STATION_WIDE", "RENT_WIDE", "FLOOR_PLAN_WIDE"] });
  t("売上サポの札に「広げた検索の駅」「広げた家賃の幅」が出る", v.plus.some((c) => c.label.includes("広げた検索の駅")) && v.plus.some((c) => c.label.includes("広げた家賃の幅")), v.plus.map((c) => c.label));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
