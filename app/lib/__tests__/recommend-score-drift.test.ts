// app/lib/__tests__/recommend-score-drift.test.ts
// スタッフが送った物件 × 採点のズレ（recommend-score-drift.ts）の回帰テスト。
// 実行: npx tsx app/lib/__tests__/recommend-score-drift.test.ts
//
// 材料は実物: 売上サポの回 cg_715d7562_1702（2026-09-28）の保存の札（👑 エスリード難波VALORE 404・183点／同じ回の
//   レオンコンフォート難波クレア 503・180点）と、実際に送った🌟の本文（モノトーン難波 1002・Luxe難波西2 1009。お客様の呼び名は伏せた）。
import {
  codeFamily, codeState, familiesOf, familyOk, crownOf, roundOutcome, customerStrength, appealVsScore, familyDrift, topicFactDrift,
  summarizeRounds, strengthLevelOf, topicFamily,
  type DriftRound, type DriftCand,
} from "../recommend-score-drift";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

// 実物の札（property_pickups の reason_codes そのまま）
const ESLEAD_404 = ["RENT_OK", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "WALK_OK", "BUILDING_AGE_OK", "AD_HIGH", "FREE_RENT_MATCH", "EQUIP_BLDG_TYPE_OK", "AREA_STATION_MATCH", "AGE_COL_W5", "SEARCH_PINPOINT", "FIT_ALL"];
const LEON_503 = ["RENT_OK", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "WALK_OK", "BUILDING_AGE_OK", "AD_ASSUMED_AGENT", "AD_HIGH", "EQUIP_BLDG_TYPE_OK", "AREA_STATION_MATCH", "AGE_COL_W5", "SEARCH_PINPOINT", "FIT_ALL"];
// 同じ日の保存の札（都島北通りマンション 0405・保留）
const TOJIMA_0405 = ["RENT_WIDE", "RENT_ABOVE_USUAL", "INITIAL_COST_NOT_ZERO", "FLOOR_PLAN_MATCH", "AD_1M_HELD", "AREA_WARD_MATCH"];

const STAR_MONOTONE = "🌟モノトーン難波 1002号室\n\n（オススメポイント）\n・家賃78,000円・管理費10,000円（合計88,000円）\n・1K 26.63㎡　（9帖・ロフト付）\n・大阪メトロ谷町線「四天王寺前夕陽ヶ丘」徒歩8分・千日前線「日本橋」徒歩11分\n・2018年2月築\n・独立洗面台・浴室乾燥機・ロフト付き\n・オートロック・モニタ付インターホン完備";
const STAR_LUXE = "🌟Luxe難波西2 1009\n\n芦原橋駅徒歩3分・敷金礼金なしのお部屋で、〇〇さんにかなりオススメ出来るお部屋となります！！\n\n家賃69,500円・管理費10,000円の家賃管理費込79,500円、洋室7.6帖・専有面積25.73㎡の広々としたお部屋と2面開きの大容量のクローゼットが備わった1Kのお部屋です！！\n\n敷金・礼金なしのため初期費用をかなり抑えてご入居頂けます！！\n\n2019年1月築（築7年）で室内も綺麗な状態、エアコン・オートロック・宅配BOX・防犯カメラなども備わっております！！";

console.log("■ 札 → 条件の種類・状態");
{
  t("設備の必須 ○ → equip:bath_toilet・ok", codeFamily("EQUIP_BATH_TOILET_MUST_OK") === "equip:bath_toilet" && codeState("EQUIP_BATH_TOILET_MUST_OK") === "ok");
  t("画像の札は設備の家族に寄せる（IMAGE_BATH_TOILET_SEPARATE_NG → equip:bath_toilet・ng）", codeFamily("IMAGE_BATH_TOILET_SEPARATE_NG") === "equip:bath_toilet" && codeState("IMAGE_BATH_TOILET_SEPARATE_NG") === "ng");
  t("IMAGE_SEPARATE_WASHSTAND_OK → equip:washbasin", codeFamily("IMAGE_SEPARATE_WASHSTAND_OK") === "equip:washbasin");
  t("書いていない設備（_UNLISTED）は分からない", codeState("EQUIP_WASHBASIN_UNLISTED") === "unknown" && codeState("EQUIP_PET_ASK") === "unknown");
  t("AD の段: 2ヶ月以上 ok・保留の 0点（_HELD）も ok・1ヶ月は中・1ヶ月未満 ng・不明は分からない",
    codeState("AD_HIGH") === "ok" && codeState("AD_HIGH_HELD") === "ok" && codeState("AD_1M_HELD") === "mid" && codeState("AD_UNDER_1M") === "ng" && codeState("AD_UNKNOWN") === "unknown");
  t("広げた幅の中は中（RENT_WIDE・AREA_STATION_WIDE）", codeState("RENT_WIDE") === "mid" && codeState("AREA_STATION_WIDE") === "mid");
  t("0点でも名前で読む（BUILDING_AGE_TEXT_OK は ok・BUILDING_AGE_TEXT_OVER は ng）", codeState("BUILDING_AGE_TEXT_OK") === "ok" && codeState("BUILDING_AGE_TEXT_OVER") === "ng");
  const f = familiesOf(LEON_503);
  t("実物: レオンコンフォート 503 の AD は ok・20点（アズ・スタットのみなし 0点＋2ヶ月以上 20点）", f.ad?.state === "ok" && f.ad.points === 20, JSON.stringify(f.ad));
  t("実物: 全部合う（FIT_ALL）・ピンポイント・送付済みは条件の種類に数えない", !("fit" in f) && !("pinpoint" in f));
  const g = familiesOf(TOJIMA_0405);
  t("実物: 都島北通り 0405 は家賃 ng（幅の中＋いつもより高い）・初期費用 ng・AD は中で 0点（保留）",
    g.rent?.state === "ng" && g.rent.points === 5 && g.initial_cost?.state === "ng" && g.ad?.state === "mid" && g.ad.points === 0, JSON.stringify(g));
  t("familyOk: 分からない・無いは null", familyOk(undefined) === null && familyOk(familiesOf(["AD_UNKNOWN"]).ad) === null);
}

console.log("■ 1回の結果（👑 と🌟）");
const cand = (key: string, score: number | null, codes: string[], o: Partial<DriftCand> = {}): DriftCand => ({ key, score, codes, chosen: false, ...o });
{
  // 実物の回: 👑 エスリード 404（183点）・🌟は別の物（ここではレオンコンフォート 503 を🌟にして差を見る）
  const round: DriftRound = {
    id: "pickup:cg_715d7562_1702", source: "pickup", at: "2026-09-28T01:00:00Z", customerKey: "3db9db75",
    cands: [
      cand("エスリード難波VALORE 404", 183, ESLEAD_404, { crown: true, rank: 1, chosen: true }),
      cand("レオンコンフォート難波クレア 503", 180, LEON_503, { rank: 3, chosen: true, star: true }),
      cand("都島北通りマンション 0405", 63, TOJIMA_0405, { rank: 15 }),
    ],
  };
  const o = roundOutcome(round);
  t("🌟がある回は比べる相手が🌟（👑 も送っていても 👑 を選んだことにしない）", o.mainKey === "レオンコンフォート難波クレア 503" && o.crownChosen === false);
  t("点の差 3・点の順位 2・保存の順位 3", o.gap === 3 && o.chosenPos === 2 && o.chosenStoredRank === 3, JSON.stringify(o));
  t("差がついた札: 👑 だけ FREE_RENT_MATCH・🌟だけ AD_ASSUMED_AGENT", o.crownOnlyCodes.join() === "FREE_RENT_MATCH" && o.chosenOnlyCodes.join() === "AD_ASSUMED_AGENT");
  const d = o.diffs.find((x) => x.family === "initial_cost");
  t("条件の種類: 初期費用で −3（両方読めている＝重み）", !!d && d.delta === -3 && d.kind === "weight" && o.diffs.length === 1, JSON.stringify(o.diffs));
  // 🌟が無く、送った物に 👑 がある → 👑 を選んだ
  const r2: DriftRound = { ...round, cands: round.cands.map((c) => ({ ...c, star: false })) };
  t("🌟が無い回は送った物に 👑 があれば 👑 を選んだ", roundOutcome(r2).crownChosen === true && roundOutcome(r2).mainKey === "エスリード難波VALORE 404");
}
{
  // 材料の欠け: 選んだ物は AD 不明・間取りの札なし、👑 は AD 2ヶ月・間取り一致（🌟の回の付け直しでよく出る形）
  const round: DriftRound = {
    id: "snap:1", source: "snapshot", at: "2026-09-21T00:00:00Z", customerKey: "x",
    cands: [cand("A", 105, ["AD_HIGH", "FLOOR_PLAN_MATCH", "RENT_OK"]), cand("B", 50, ["AD_UNKNOWN"], { chosen: true, star: true }), cand("C", 60, ["AD_1M"])],
  };
  const o = roundOutcome(round);
  t("👑 は点の単独1位（印が無い回）", o.crownKey === "A" && o.crownChosen === false && o.gap === 55);
  t("片方が読めていない差は材料の欠け（AD・間取り・家賃）", o.diffs.length === 3 && o.diffs.every((x) => x.kind === "material"), JSON.stringify(o.diffs));
  t("1位が同点なら 👑 なし", crownOf({ cands: [cand("A", 70, []), cand("B", 70, []), cand("C", 60, [])] }) === null);
  const tied = roundOutcome({ ...round, cands: [cand("A", 50, []), cand("B", 50, [], { chosen: true })] });
  t("全部同点の回は比べられない（👑 なし）", tied.allTied && tied.crownChosen === null);
}

console.log("■ こだわりの強さ");
{
  const s = customerStrength({
    conditions: { rent_max: 80000, floor_plan: "1K", desired_area: "浪速区", preferences: "敷金礼金なしで初期費用を抑えたい\nバストイレ別は絶対", ng_points: "1階、ユニットバス" },
    messages: ["家賃8万以内でお願いします", "https://suumo.jp/chintai/xxx 家賃8万", "初期費用はどのくらいですか"],
    history: [{ changed_field: "rent_max" }, { changed_field: "rent_max" }, { changed_field: "desired_area" }],
  });
  t("強い言い方の行（バストイレ別は絶対）→ バス・トイレ別 strong", strengthLevelOf(s, "equip:bath_toilet") === "strong", JSON.stringify(s.byFamily["equip:bath_toilet"]));
  t("初期費用: 自由文＋発言1回 → stated（強い言い方なし）", strengthLevelOf(s, "initial_cost") === "stated", JSON.stringify(s.byFamily.initial_cost));
  t("家賃: 条件欄＋発言＋言い直し2回 → strong（URL の発言は数えない）", strengthLevelOf(s, "rent") === "strong" && s.byFamily.rent.signals.includes("発言 1回"), JSON.stringify(s.byFamily.rent));
  t("NG 欄は全部の行が強い（1階 → 2階以上 strong）", strengthLevelOf(s, "equip:floor2") === "strong");
  t("書いていない条件は none", strengthLevelOf(s, "pet") === "none");
  t("指数: NG 2・強い行 1・言い直し 3・strong の種類で『強い』", s.ngCount === 2 && s.emphasisCount === 1 && s.restatements === 3 && s.klass === "強い", JSON.stringify({ ...s, byFamily: undefined }));
  // 実物の NG 欄の書き方（項目そのものが嫌な物）
  const ng = customerStrength({ conditions: { ng_points: "1階NG\n木造NG(アパート指定)\n敷礼なし\n独立洗面なし\n4階以下NG[必須]\nカウンターキッチン不可(壁式カウンターなら可)" } });
  t("NG 欄の実物: 1階NG→2階以上・木造NG→構造・敷礼なし→初期費用・独立洗面なし→独立洗面台 が strong",
    ["equip:floor2", "equip:structure", "initial_cost", "equip:washbasin"].every((f) => strengthLevelOf(ng, f) === "strong"), JSON.stringify(Object.keys(ng.byFamily)));
  t("カウンターキッチンは対面キッチンの種類（ガスコンロに寄せない）", strengthLevelOf(ng, "equip:counter_kitchen") === "strong" && strengthLevelOf(ng, "equip:gas_stove") === "none");
  const w = customerStrength({ conditions: { rent_max: 70000 }, messages: [], history: [] });
  t("家賃の上限だけのお客様は弱い", w.klass === "弱い" && strengthLevelOf(w, "rent") === "stated");
}

console.log("■ 訴求（実物の🌟の本文）と採点");
{
  const a = appealVsScore(STAR_MONOTONE, ["RENT_OK", "WALK_OK", "INITIAL_COST_NOT_ZERO", "AD_HIGH_HELD"]);
  t("モノトーン難波: 訴求は家賃・駅近・広さ・独立洗面台・オートロック・浴室乾燥機", ["rent", "station_near", "spacious", "washbasin", "autolock", "bath_dryer"].every((k) => a.topics.includes(k as never)), a.topics.join());
  t("設備の訴求は採点に種類があるが札が無い＝材料なし", ["washbasin", "autolock", "bath_dryer"].every((k) => a.blindTopics.includes(k as never)) && a.noFamilyTopics.length === 0, JSON.stringify(a));
  t("家賃・駅近は採点が見ていた", a.scoredFamilies.includes("rent") && a.scoredFamilies.includes("walk"));
  const b = appealVsScore(STAR_LUXE, LEON_503);
  t("Luxe難波西2: 防犯カメラ（セキュリティ）・クローゼット（収納）は採点に種類が無い", b.noFamilyTopics.includes("security") && b.noFamilyTopics.includes("storage"), JSON.stringify(b));
  t("話題 → 種類（審査・周辺環境は null）", topicFamily("bath_toilet") === "equip:bath_toilet" && topicFamily("screening") === null && topicFamily("surroundings") === null);
}

console.log("■ 条件の種類 × 強さの率");
{
  // バス・トイレ別が必須のお客様: スタッフは毎回それを満たす物を選ぶが、👑 は AD の高い満たさない物（点で +5 では足りない形）
  const mk = (i: number): DriftRound => ({
    id: `r${i}`, source: "pickup", at: `2026-09-2${i}T00:00:00Z`, customerKey: `c${i}`,
    cands: [
      cand("AD高い・BT別なし", 160, ["RENT_OK", "AD_HIGH", "EQUIP_BATH_TOILET_MUST_NG"], { crown: true }),
      cand("BT別あり", 150, ["RENT_OK", "AD_1M", "EQUIP_BATH_TOILET_MUST_OK"], { chosen: true, star: true }),
      cand("その他", 120, ["RENT_OK", "AD_1M", "EQUIP_BATH_TOILET_MUST_NG"]),
    ],
  });
  const rounds = [1, 2, 3, 4].map(mk);
  const rows = familyDrift(rounds, (r, f) => (f === "equip:bath_toilet" ? "strong" : "none"));
  const bt = rows.find((r) => r.family === "equip:bath_toilet" && r.level === "strong")!;
  t("必須の設備: 選んだ物 100%・候補全体 33%・👑 0% → 足りない候補", bt.chosenOk === 1 && bt.poolOk === 0.333 && bt.crownOk === 0 && bt.verdict === "足りない候補", JSON.stringify(bt));
  t("入れ替わるのに要った点の中央値 10（160−150）・スタッフが取った 4回", bt.flipGapMedian === 10 && bt.chosenAdv === 4 && bt.flipRounds === 4);
  const ad = rows.find((r) => r.family === "ad" && r.level === "all")!;
  t("AD: 点が 👑 に付いた 4回・選んだ物の満たす率は候補全体より低い → 強すぎる候補（材料だけ・直すのは竹内さん）", ad.crownAdv === 4 && ad.verdict === "強すぎる候補", JSON.stringify(ad));
  t("回が3回未満は材料不足", familyDrift(rounds.slice(0, 2)).every((r) => r.verdict === "材料不足"));
  const s = summarizeRounds(rounds);
  t("まとめ: 4回・👑 を選んだ 0・🌟の点の順位はいつも2位", s.comparable === 4 && s.crownChosen === 0 && s.top1 === 0 && s.top3 === 4 && s.relRank === 0.5, JSON.stringify(s));
  t("まとめ: 👑 だけの札の上位に AD_HIGH", s.crownOnlyTop.some(([k, n]) => k === "AD_HIGH" && n === 4));
  // 材料の欠けは重みのズレに数えない
  const mat: DriftRound = { id: "m", source: "snapshot", at: "2026-09-01T00:00:00Z", customerKey: "m", cands: [cand("A", 90, ["AD_HIGH", "RENT_OK"]), cand("B", 50, ["AD_UNKNOWN", "RENT_OK"], { chosen: true, star: true }), cand("C", 70, ["AD_1M", "RENT_OK"])] };
  const mr = familyDrift([mat]).find((r) => r.family === "ad" && r.level === "all")!;
  t("選んだ物の AD が不明 → 材料の欠けで 👑 に付いた 1・重みの差 0", mr.materialCrownAdv === 1 && mr.crownAdv === 0 && mr.chosenAdv === 0, JSON.stringify(mr));
}

console.log("■ 物件の値で見る（設備の語）");
{
  const mk = (i: number): DriftRound => ({
    id: `f${i}`, source: "snapshot", at: "2026-09-01T00:00:00Z", customerKey: "f",
    cands: [
      cand("A", 80, [], { crown: true, facts: { yes: ["internet"], no: [] } }),
      cand("B", 70, [], { chosen: true, star: true, facts: { yes: ["autolock", "washbasin"], no: [] } }),
      cand("C", 60, [], { facts: null }),
    ],
  });
  const rows = topicFactDrift([1, 2, 3].map(mk), (_r, t) => (t === "autolock" ? "strong" : "none"));
  const al = rows.find((r) => r.topic === "autolock" && r.level === "strong")!;
  t("設備の語がある候補で、語が無い＝満たさない（オートロック: 選んだ物 100%・全体 50%・👑 0%）→ スタッフが揃える", al.chosenHas === 1 && al.poolHas === 0.5 && al.crownHas === 0 && al.verdict === "スタッフが揃える", JSON.stringify(al));
  t("値の無い候補（facts なし）は数えない", rows.every((r) => r.rounds === 3));
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
