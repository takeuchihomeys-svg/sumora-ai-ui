// 2026-10-02 ⑯ 「なんば・梅田に出やすい」「タクシーでそこまでかからない」（osaka-area-profile.ts）・照合（area-want.matchAnchors）・
//   家賃の相場の文（area-rent-explain.ts）・条件の記録の家賃（line-webhook-text.buildConditionNote）のテスト（LLM なし）
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/relative-area.test.ts
// 文は property_customers の desired_area・条件欄の実物の言い回し（名前は無い）
import { readRelativeArea, readRideAsks, extLines, buildAreaPlan, RELATIVE_AREA_RULE, WARD_NOTES, wardAccessFacts } from "../osaka-area-profile";
import { parseAreaWant, customerAreaPlan, parseCommuteWants, buildPropertyLocation, matchArea, matchCommute, locationReasonCodes } from "../area-want";
import { REASON_POINTS, reasonJa } from "../property-brain";
import { buildRentMarket, rentBand, planGroupOf, wantedPlanGroups, roundManDown, roundManUp, RENT_EXPLAIN_RULE, type RentObs } from "../area-rent-explain";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info ?? ""); } };
const anchorsOf = (a: string, f?: string) => readRelativeArea(a, f).anchors.map((x) => x.station).join(",");

console.log("■ 竹内さんの決定（2026-10-02）");
t("出やすい＝電車15分・乗換なし／タクシー＝直線5km", RELATIVE_AREA_RULE.softMinutes === 15 && RELATIVE_AREA_RULE.softMaxTransfers === 0 && RELATIVE_AREA_RULE.taxiKm === 5);
t("区の特徴の文はまだ無い（竹内さんが書く欄）", Object.keys(WARD_NOTES).length === 0);

console.log("■ 地点の読み（実物の言い回し）");
const MATSUURA_AREA = "なんば・梅田に出やすいエリア";
const MATSUURA_OTHER = "ブラックのため審査がゆるいところがいい。タクシーで帰宅してもそこまでかからない距離感希望。初期費用は高すぎなければOK。";
t("松浦さん: なんば・梅田（中黒の並び）", anchorsOf(MATSUURA_AREA) === "なんば,梅田");
t("松浦さん: 条件欄のタクシー → 5km", readRelativeArea(MATSUURA_AREA, MATSUURA_OTHER).taxiKm === 5);
t("フォームの原文「なんば、梅田に出やすくて、タクシーとかで帰ってもそこまでかからんところ」", anchorsOf("なんば、梅田に出やすくて、タクシーとかで帰ってもそこまでかからんところ。") === "なんば,梅田" && readRelativeArea("なんば、梅田に出やすくて、タクシーとかで帰ってもそこまでかからんところ。").taxiKm === 5);
t("梅田か難波にアクセス良い地域", anchorsOf("梅田か難波にアクセス良い地域") === "梅田,なんば");
t("「淡路など梅田アクセス良好」は梅田だけ（など は並びでない）", anchorsOf("天満天六周辺、梅田、東梅田、天満、淡路など梅田アクセス良好な地域") === "梅田");
t("大阪駅へのアクセス重視 → 梅田（まとまり）", anchorsOf("大阪市内（大阪駅へのアクセス重視）") === "梅田");
t("北新地にアクセスがいい → 梅田（まとまり）", anchorsOf("北新地にアクセスがいい（出来ればミナミも）") === "梅田");
t("ミナミ・キタに出やすい → なんば・梅田", anchorsOf("ミナミ・キタに出やすいところ") === "なんば,梅田");
t("環状線が通っていて便利 → 地点なし", anchorsOf("環状線が通っていて便利な駅") === "");
t("分の指定がある言い方は読まない（通勤の COMMUTE_RE が読む）", anchorsOf("難波駅・梅田駅まで電車で30分以内で行ける距離") === "");
t("「ミナミからタクシーで10分」は分の指定あり＝5km にしない", readRelativeArea("浪速区、中央区、ミナミからタクシーで10分くらい").taxiKm === null);
t("「ほぼタクシー移動のため駅徒歩分数は重視しない」はタクシーの距離の希望ではない", readRelativeArea("北区、中央区、西区", "ほぼタクシー移動のため駅徒歩分数は重視しない").taxiKm === null);

console.log("■ 検索の範囲（area_plan・決定論）");
const plan = buildAreaPlan(readRelativeArea(MATSUURA_AREA, MATSUURA_OTHER));
const wards = new Set(plan?.wards.map((w) => w.ward));
const sts = new Set(plan?.stations.map((s) => s.station));
t("松浦さん: 竹内さんの挙げた区（浪速・大正・西・北・福島・中央）が全部入る", ["大阪市浪速区", "大阪市大正区", "大阪市西区", "大阪市北区", "大阪市福島区", "大阪市中央区"].every((w) => wards.has(w)), [...wards]);
t("淀川区（十三・西中島南方）が入る（竹内さんの決定③）", wards.has("大阪市淀川区") && sts.has("十三") && sts.has("西中島南方"));
t("尼崎（梅田まで10分だが直線7.7km）はタクシーの目安で外れる", !sts.has("尼崎"));
t("江坂（梅田まで11分・直線6km）はタクシーの目安で外れる", !sts.has("江坂"));
t("基準の駅そのもの（なんば・梅田・大阪・北新地）は入る", ["なんば", "梅田", "大阪", "北新地"].every((s) => sts.has(s)));
t("乗り換えが要る駅（谷町九丁目→梅田は乗換・なんばには3分）は なんば で入る", sts.has("谷町九丁目"));
t("summary に線と区", !!plan && /電車15分以内・乗り換えなし/.test(plan.summary) && /直線5km以内/.test(plan.summary));
t("区の到達の事実（特徴の文は無いので書かない）", !!plan && wardAccessFacts(plan, 3).length === 3 && wardAccessFacts(plan, 3).every((l) => !/｜/.test(l)));
const planNoTaxi = buildAreaPlan(readRelativeArea("梅田か難波にアクセス良い地域"));
t("タクシーの希望が無い人は尼崎（梅田まで10分）も入る（線どおり）", !!planNoTaxi && planNoTaxi.stations.some((s) => s.station === "尼崎"));
t("具体的な駅がある人は条件欄の「出やすい」で広げない", customerAreaPlan("淀屋橋、中之島、本町", "北新地に通いやすい") === null);
t("住む駅がある人（凛さん）は「本町と京都に行きやすい」で検索を広げない", customerAreaPlan("弁天町駅、森ノ宮駅、大国町駅（本町駅と京都に行きやすいところ）") === null);
t("「大阪市内（大阪駅へのアクセス重視）」は範囲＋梅田に出やすい駅", customerAreaPlan("大阪市内（大阪駅へのアクセス重視）")?.anchors[0]?.station === "梅田");
t("松浦さんの行（desired_area＋条件欄）", customerAreaPlan(MATSUURA_AREA, MATSUURA_OTHER)?.rule.taxiKm === 5);
t("desired_area に地点が無い人は条件欄の「出やすい」を読む", customerAreaPlan("", "なんば、梅田へのアクセスが良い物件を希望")?.anchors.length === 2);

console.log("■ 照合（area-want.matchAnchors）");
const want = parseAreaWant(MATSUURA_AREA, MATSUURA_OTHER);
t("なんば は住む駅にしない（基準の駅）", want.stations.length === 0 && want.anchors.length === 2 && want.taxiKm === 5);
const locOf = (summary: string) => buildPropertyLocation(summary, null);
// 実物（property_pickups 9/30 の松浦さんの行の交通）
const umeda = locOf("【7】エスリードレジデンス梅田デュオ\n79,000円\n1DK\n御堂筋線「中津」徒歩7分");
const namba = locOf("【5】エスリードレジデンス大阪難波\n77,000円\n1DK\n関西本線「なんば」徒歩5分");
const ebisu = locOf("【10】アーバンフラッツ難波東\n78,000円\n1DK\n堺筋線「恵美須町」徒歩1分");
const taisho = locOf("【19】グランパシフィック桜川WEST\n69,000円\n1DK\n大阪環状線「大正」徒歩6分");
const esaka = locOf("【1】テスト江坂\n80,000円\n1DK\n御堂筋線「江坂」徒歩5分");
const kadoma = locOf("【1】Ciel Court門真南\n80,000円\n1LDK\n大阪メトロ長堀鶴見緑地線「門真南」徒歩6分");
t("梅田側（中津 徒歩7分）: 旧 AREA_FAR −3 → AREA_ANCHOR_REACH", matchArea(want, umeda)?.code === "AREA_ANCHOR_REACH", matchArea(want, umeda));
t("なんば 徒歩5分 → AREA_ANCHOR_REACH", matchArea(want, namba)?.code === "AREA_ANCHOR_REACH");
t("恵美須町（なんばへ乗換なし）→ 出られる", /AREA_ANCHOR_REACH/.test(matchArea(want, ebisu)?.code ?? ""), matchArea(want, ebisu));
t("大正（梅田へ環状線12分）→ 一部に出られる", matchArea(want, taisho)?.code === "AREA_ANCHOR_REACH_SOME" || matchArea(want, taisho)?.code === "AREA_ANCHOR_REACH", matchArea(want, taisho));
t("江坂（梅田11分だが直線6km）→ タクシーの目安を超える（0点）", matchArea(want, esaka)?.code === "AREA_ANCHOR_TAXI_OVER", matchArea(want, esaka));
t("門真南 → 出られない（−3・情報）", matchArea(want, kadoma)?.code === "AREA_ANCHOR_FAR", matchArea(want, kadoma));
t("理由の文に円を書かない", [umeda, namba, ebisu, taisho, esaka, kadoma].every((l) => !/円/.test(matchArea(want, l)?.why ?? "")));
t("点: 出られる +10・一部 +8・タクシー内 +5・タクシー超え 0・外 −3", REASON_POINTS.AREA_ANCHOR_REACH === 10 && REASON_POINTS.AREA_ANCHOR_REACH_SOME === 8 && REASON_POINTS.AREA_ANCHOR_TAXI === 5 && REASON_POINTS.AREA_ANCHOR_TAXI_OVER === 0 && REASON_POINTS.AREA_ANCHOR_FAR === -3);
t("札の日本語がある", ["AREA_ANCHOR_REACH", "AREA_ANCHOR_REACH_SOME", "AREA_ANCHOR_TAXI", "AREA_ANCHOR_TAXI_OVER", "AREA_ANCHOR_FAR"].every((c) => reasonJa(c) !== c));
const cw = parseCommuteWants({ desired_area: MATSUURA_AREA, other_requests: MATSUURA_OTHER });
t("通勤の目的地: なんば も（旧は梅田だけ）", cw.some((w) => w.target === "なんば") && cw.some((w) => w.target === "梅田"), cw);
t("札の並び（エリア＋通勤の情報）", locationReasonCodes(matchArea(want, umeda), matchCommute(cw, umeda)).join(",").startsWith("AREA_ANCHOR_REACH,COMMUTE_INFO"));

console.log("■ 既存の読みを壊さない");
const rin = parseAreaWant("弁天町駅、森ノ宮駅、大国町駅（本町駅と京都に行きやすいところ）");
t("凛さん: 住む駅（弁天町・森ノ宮・大国町）は駅のまま・本町と京都は基準の駅", ["弁天町", "森ノ宮", "大国町"].every((s) => rin.stations.some((x) => x.station === s)) && !rin.stations.some((x) => x.station === "本町"), rin.stations);
t("凛さん: 弁天町の物件は希望の駅（基準の駅の照合を先にしない）", matchArea(rin, locOf("【1】A\n70,000円\n1K\n中央線「弁天町」徒歩3分"))?.code === "AREA_STATION_MATCH");
t("「大国町」だけの人は今まで通り", matchArea(parseAreaWant("大国町"), namba)?.code !== undefined && parseAreaWant("大国町").anchors.length === 0);
t("「北区、中央区、西区」の人は区の照合のまま", matchArea(parseAreaWant("北区、中央区、西区"), umeda)?.code === "AREA_WARD_MATCH");
t("「大阪市内（大阪駅へのアクセス重視）」: 梅田に出られる物件は +10", matchArea(parseAreaWant("大阪市内（大阪駅へのアクセス重視）"), umeda)?.code === "AREA_ANCHOR_REACH");
t("「大阪市内（大阪駅へのアクセス重視）」: 出られない市内の物件は大阪市内の範囲（−3 にしない）", matchArea(parseAreaWant("大阪市内（大阪駅へのアクセス重視）"), locOf("【1】A\n60,000円\n1K\n谷町線「喜連瓜破」徒歩5分"))?.code === "AREA_REGION_MATCH");

console.log("■ 1本・乗り換えなし・直通・乗り継ぎ（2026-10-02 竹内さん・実物の言い回し）");
{
  const R = (x: string) => readRideAsks(x).anchors.map((a) => `${a.station}|${a.minutes ?? "-"}|${a.maxTransfers}`).join(",");
  t("「梅田、中津まで電車1本で行けるところ…できれば15分から２０分以内くらい」→ 梅田・中津・20分・乗換なし", R("梅田、中津まで電車1本で行けるところがいいです。できれば15分から２０分以内くらいの場所がいいです。") === "梅田|20|0,中津|20|0");
  t("「難波か梅田まで電車一本」→ 沿線ぜんぶ", R("難波か梅田まで電車一本") === "なんば|-|0,梅田|-|0");
  t("「梅田まで1本で行ける線」→ 沿線ぜんぶ", R("梅田まで1本で行ける線") === "梅田|-|0");
  t("フォームの「⑤梅田まで1本で行ける線 ⑥10分以内」の⑥（駅徒歩）を分にしない", R("⑤梅田まで1本で行ける線 ⑥10分以内 ⑦20万位内") === "梅田|-|0");
  t("「難波まで1本10-15分以内」→ 15分", R("難波まで1本10-15分以内") === "なんば|15|0");
  t("「梅田まで30分以内で乗り継ぎ一回」→ 30分・1回", R("梅田まで30分以内で乗り継ぎ一回とかでいける場所") === "梅田|30|1");
  t("「乗り継ぎ2回以内で梅田まで30分以内」→ 30分・2回", R("乗り継ぎ2回以内で梅田まで30分以内でも大丈夫です") === "梅田|30|2");
  t("「野田阪神駅・住之江駅へ乗り換え1回で行けるところ」（分なし）は作らない", R("野田阪神駅・住之江駅へ乗り換え1回で行けるところ") === "");
  t("「梅田まで乗り換えなし」「梅田まで乗り継ぎなし」「本町まで直通」", R("梅田まで乗り換えなし") === "梅田|-|0" && R("梅田まで乗り継ぎなし") === "梅田|-|0" && R("本町まで直通") === "本町|-|0");
  t("「なんばに乗換なしで行ける所」", R("なんばに乗換なしで行ける所") === "なんば|-|0");
  t("「梅田まで乗換なしで20分以内」→ 20分", R("梅田まで乗換なしで20分以内") === "梅田|20|0");
  t("電話の「関西直通の固定番号」は電車ではない", R("③勤務先TEL （関西直通の固定番号）") === "");
  t("駅徒歩の分は拾わない（「梅田まで1本・駅徒歩10分以内」）", R("梅田まで1本、駅徒歩10分以内") === "梅田|-|0");
  const whole = buildAreaPlan(readRideAsks("梅田まで乗り換えなし"))!;
  const wl = new Set(whole.lines);
  t("沿線ぜんぶ＝路線ごとに全駅（mode=lines）", whole.mode === "lines");
  t("各社の沿線: 御堂筋・谷町・四つ橋・阪急3線・阪神・環状・JR京都/神戸/東西/おおさか東", ["大阪市高速軌道御堂筋線", "大阪市高速軌道谷町線", "大阪市高速軌道四つ橋線", "阪急電鉄神戸線", "阪急電鉄宝塚線", "阪急電鉄京都線", "阪神電鉄本線", "大阪環状線", "東海道本線", "JR東西線", "おおさか東線", "JR神戸線"].every((l) => wl.has(l)), whole.lines);
  t("直通の運転も（北急・学研都市線）", wl.has("北大阪急行南北線") && wl.has("片町線"));
  t("梅田に乗り換えなしで着かない路線は入らない（堺筋線・千日前線・南海）", !wl.has("大阪市高速軌道堺筋線") && !wl.has("大阪市高速軌道千日前線") && !wl.has("南海電鉄南海本線"));
  t("拡張の路線名に直す（JR神戸線→東海道本線・JR宝塚線→福知山線）", extLines(["JR神戸線", "JR宝塚線", "大阪環状線"]).join(",") === "東海道本線,福知山線,大阪環状線");
  const m20 = buildAreaPlan(readRideAsks("梅田まで乗換なしで20分以内"))!;
  const m20s = new Set(m20.stations.map((s) => s.station));
  t("分あり＝駅を1つずつ（mode=stations）・20分以内だけ", m20.mode === "stations" && m20.stations.every((s) => (s.reach[0]?.minutes ?? 99) <= 20));
  t("20分・乗換なし: 十三・中津・天王寺（御堂筋）・谷町九丁目（谷町線で東梅田）は入り、恵美須町（堺筋線＝乗換が要る）は入らない", m20s.has("十三") && m20s.has("中津") && m20s.has("天王寺") && m20s.has("谷町九丁目") && !m20s.has("恵美須町"));
  const mido = buildAreaPlan(readRideAsks("御堂筋線で梅田まで1本"))!;
  t("「御堂筋線で梅田まで1本」→ 御堂筋線（と北急の直通）だけ", mido.lines.every((l) => /御堂筋|北大阪急行/.test(l)) && mido.stations.some((s) => s.station === "なかもず"));
  const lineOnly = readRideAsks("御堂筋線で1本の場所とかありますか？");
  t("「御堂筋線で1本の場所」（目的の駅なし）→ 御堂筋線の駅ぜんぶ", (lineOnly.rideLines ?? []).includes("大阪市高速軌道御堂筋線") && buildAreaPlan(lineOnly)?.mode === "lines");
  t("「乗り継ぎ2回・30分」は 240駅まで（分の短い順）", (buildAreaPlan(readRideAsks("乗り継ぎ2回以内で梅田まで30分以内"))?.stations.length ?? 0) <= 240);
  t("я さん（「難波周辺」＋条件欄「難波まで1本10-15分以内」）→ なんば 15分・乗換なし", customerAreaPlan("難波周辺", "難波まで1本10-15分以内")?.anchors[0]?.minutes === 15);
  t("みくさん（「梅田まで電車1本・大阪市都島区・…」区が書いてある）は今まで通り（範囲を作らない）", customerAreaPlan("梅田まで電車1本・大阪市都島区・大阪市福島区", null) === null);
  const rw = parseAreaWant("梅田まで乗り換えなし");
  t("照合: 阪急宝塚線の豊中（梅田に乗換なし）→ 出られる", matchArea(rw, locOf("【1】A\n70,000円\n1K\n阪急宝塚線「豊中」徒歩5分"))?.code === "AREA_ANCHOR_REACH");
  t("照合: 堺筋線の恵美須町（梅田に乗換が要る）→ 出られない", matchArea(rw, locOf("【1】A\n70,000円\n1K\n堺筋線「恵美須町」徒歩3分"))?.code === "AREA_ANCHOR_FAR");
}

console.log("■ 家賃の相場（area-rent-explain・期間で切らない・10件以上・0.5万で丸める）");
t("決めた線", RENT_EXPLAIN_RULE.minCount === 10 && RENT_EXPLAIN_RULE.roundMan === 0.5);
t("間取りのまとまり", planGroupOf("1R") === "1K" && planGroupOf("1SLDK") === "1LDK" && planGroupOf("2K") === "2DK" && planGroupOf("ワンルーム") === "1K");
t("希望の間取りの欄「1DK・1K」→ 1DK が先", wantedPlanGroups("1DK・1K").join(",") === "1DK,1K");
t("丸め: 72,500 → 7 ／ 83,000 → 8.5", roundManDown(72500) === 7 && roundManUp(83000) === 8.5);
const W = ["大阪市浪速区", "大阪市中央区"];
const mk = (ward: string, plan: string, rents: number[]): RentObs[] => rents.map((r) => ({ ward, plan_group: plan, rent_total: r, pet: null }));
const obs: RentObs[] = [
  ...mk("大阪市浪速区", "1DK", [92000, 95000, 98000, 101000, 104000, 107000, 110000, 113000, 116000, 120000, 83000]),
  ...mk("大阪市浪速区", "1K", [68000, 70000, 72000, 74000, 75000, 76000, 78000, 80000, 82000, 85000]),
  ...mk("大阪市北区", "1DK", [80000]),
];
const b = rentBand(obs, W, "1DK", 85000);
t("区をまとめて数える（北区は入れない）・予算以内の件数", !!b && b.n === 11 && b.nWithinBudget === 1);
const rm = buildRentMarket(obs, { wards: W, floorPlan: "1DK", rentMax: 85000, pet: true, label: "なんば・梅田" });
t("文1（スタッフの型）: 「◯◯周辺の1DKの家賃相場は◯万円から◯万円程となります！！」", !!rm && /^なんば・梅田周辺の1DKの家賃相場は[0-9.]+万円から[0-9.]+万円程となります！！$/.test(rm.sentences[0] ?? ""), rm?.sentences);
t("文2（スタッフの型）: 予算が1Kの相場に入る時「8.5万円ですと1Kの家賃相場程ですので、…」", !!rm && rm.sentences[1] === "8.5万円ですと1Kの家賃相場程ですので、間取りやご希望のエリア広げれましたら追加でオススメできるお部屋ピックアップ可能です😊！！", rm?.sentences);
t("ペット可の件数は事実に出すが相場は言わない", !!rm && rm.facts.some((f) => /ペット可/.test(f) && /言わない/.test(f)));
const few = buildRentMarket(obs, { wards: ["大阪市北区"], floorPlan: "1DK", rentMax: 85000 });
t("10件未満はお客様への文を作らない", !!few && few.sentences.length === 0 && few.facts.some((f) => /10件未満/.test(f)));
t("文に円の金額（円単位）を書かない・お客様と呼ばない", !!rm && rm.sentences.every((s) => !/[0-9],[0-9]{3}円/.test(s) && !/お客様/.test(s)));

console.log("■ 条件の記録の家賃（8.5万を「8万」にしない）");
(async () => {
  try {
    const { buildConditionNote, manYen } = await import("../line-webhook-text");
    t("manYen: 85000→8.5・80000→8・72500→7.25", manYen(85000) === "8.5" && manYen(80000) === "8" && manYen(72500) === "7.25");
    t("松浦さん 10/2 の記録: 「家賃: 〜8.5万」", buildConditionNote({ floor_plan: "1DK", rent_max: 85000, preferences: "ペット可" }).includes("家賃: 〜8.5万"));
    t("下限つき: 7.5万〜8.5万", buildConditionNote({ rent_min: 75000, rent_max: 85000 }).includes("家賃: 7.5万〜8.5万"));
  } catch (e) {
    fail++; console.log("  NG  line-webhook-text を読めない（--env-file=.env.local で実行）", e instanceof Error ? e.message : e);
  }
  console.log(`\n結果: ${pass} OK / ${fail} NG`);
  if (fail) process.exit(1);
})();
