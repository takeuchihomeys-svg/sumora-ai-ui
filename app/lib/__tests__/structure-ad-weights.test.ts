// 2026-09-25 竹内「AD 2ヶ月以上最上位の部分弱める。AD は2ヶ月以上だと点数が高い形。AD は1.3倍ほど価値ある」
//              「構造も指定あればちゃんと見る。構造木造NGとかあるのでそこも含めて考える」
// 実行: npx tsx app/lib/__tests__/structure-ad-weights.test.ts
// 条件の文は property_customers の条件欄の実物（構造・種別の34か所・2026-09-25 調査）から、個人を特定できない節だけをそのまま使う。
// 資料の文字は property_pickups の文字層の実物の行（リアプロ id 1・3・2、itandi id 50）の形。
import {
  parseListingEquipment, parseEquipmentWants, matchEquipment, structureTierOf, buildingTypeOf, wantLabel,
} from "../listing-equipment";
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, applyImageFacts, applyEquipmentMatch, equipmentReasonCodes, reasonPoints, reasonJa,
  settleHeldAd, BASE_SCORE, SCORE_MAX, REASON_POINTS,
} from "../property-brain";
import { RANK_PROMPT_PREFIX, buildRankConditions, rankEquipmentLine, rankMaterialLine, rankStructureExcluded, applyRankMarkers } from "../pickup-rank";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}

// ───────── 資料（実物の行の形） ─────────
const RP_WOOD_APT = `RealNetPro
物件種目 [住居用] アパート
物件名 セレニティX A棟
号室名 201（2階部分）
建築構造 木造 地上3階 総戸数12戸
間取タイプ 1LDK
備 考
バス・トイレ別・室内洗濯機置場
設 備
【その他】 自転車置場・ガス(都市ガス)
取引態様 一般媒介`;
const RP_STEEL = `RealNetPro
物件種目 [住居用] マンション
物件名 AbeliaX
号室名 302（3階部分）
建築構造 鉄骨造 地上5階 総戸数19戸
備 考
設 備
【その他】 エレベーター・自転車置場・ガス(都市ガス)・水道(公営)
取引態様 一般媒介`;
const RP_RC = `RealNetPro
物件種目 [住居用] マンション
物件名 ダイレX
号室名 0501（5階部分）
建築構造 鉄筋コンクリート造 地上8階 総戸数32戸
備 考
設 備
【その他】 エレベーター・オートバイ駐輪場・電気・ガス(都市ガス)
取引態様 一般媒介`;
const IT_RC = `仲介
エステムコートX 405 号室
築年数 2008 年 6 月 物件種別 マンション
構造 鉄筋コンクリート 階建 / 総戸数 15 階建 / 180 戸
所在階 4 階 主要採光面 西向き
設備
都市ガス , バス‧トイレ別 , 独立洗面台 , エレベーター , 宅配 BOX
備考
`;
const IT_NOSTRUCT = `仲介
X 202 号室
築年数 2011 年 9 月 物件種別 ー
構造 ー 階建 / 総戸数 12 階建 / ー
所在階 2 階 主要採光面 北向き
設備
都市ガス , バルコニー
備考
`;

console.log("■ エレベーターの読み違い（なし・EV無 を ○ と読まない）");
{
  // 文字層が 40 字未満は「文字なし」扱いなので、実物と同じく表の行を前に置く
  const HEAD = "仲介\nX 301 号室\n築年数 2011 年 9 月 物件種別 マンション\n所在階 3 階 主要採光面 南向き\n";
  const mk = (eq: string) => parseListingEquipment(`${HEAD}設備\n${eq}\n備考\n`).items.elevator;
  t("「エレベーター」→ ok", mk("都市ガス , エレベーター , 宅配 BOX").status === "ok");
  t("「エレベーターなし」→ ng（旧は ok）", mk("都市ガス , エレベーターなし , 宅配 BOX").status === "ng", mk("都市ガス , エレベーターなし"));
  t("「エレベーター無」→ ng", mk("エレベーター無 , 駐輪場").status === "ng");
  t("「エレベーター：なし」→ ng", mk("エレベーター：なし").status === "ng");
  t("備考の「EV無」→ ng", mk("都市ガス\n備考\n3階建・EV無").status === "ng", mk("都市ガス\n備考\n3階建・EV無"));
  t("「EVなし」→ ng", mk("EVなし").status === "ng");
  t("「EV有」→ ok", mk("EV有").status === "ok");
  const rp = parseListingEquipment(`RealNetPro\n物件名 X\n号室名 301\n備 考\n宅配ボックス 暗証番号 ・ エレベータ 各階有\n設 備\n取引態様`).items.elevator;
  t("リアプロ「エレベータ 各階有」→ ok（今まで通り）", rp.status === "ok", rp);
  // 希望「エレベーター付き」× 資料「エレベーターなし」→ ×（保留）
  const m = matchEquipment(parseEquipmentWants({ preferences: "エレベーター付き" }), parseListingEquipment(`${HEAD}設備\nエレベーターなし\n備考\n`));
  t("希望 エレベーター × 資料 なし → ×", m.rows[0]?.result === "ng" && m.rows[0]?.mark === "×", m.rows);
}

console.log("■ 構造の段・物件種別（資料）");
{
  t("鉄筋コンクリート造 → RC(3)", structureTierOf("鉄筋コンクリート造") === 3);
  t("鉄筋コンクリート（itandi）→ 3", structureTierOf("鉄筋コンクリート") === 3);
  t("RC造 → 3", structureTierOf("RC造") === 3);
  t("鉄骨鉄筋コンクリート造 → SRC(4)", structureTierOf("鉄骨鉄筋コンクリート造") === 4);
  t("SRC造 → 4", structureTierOf("SRC造") === 4);
  t("鉄骨造 → 2", structureTierOf("鉄骨造") === 2);
  t("軽量鉄骨造 → 1", structureTierOf("軽量鉄骨造") === 1);
  t("木造 → 0", structureTierOf("木造") === 0);
  t("ALC・その他は決めない", structureTierOf("ALC") == null && structureTierOf("その他") == null);
  t("「[住居用] マンション」→ マンション", buildingTypeOf("マンション") === "マンション");
  const a = parseListingEquipment(RP_WOOD_APT), s = parseListingEquipment(RP_STEEL), r = parseListingEquipment(RP_RC), i = parseListingEquipment(IT_RC), n = parseListingEquipment(IT_NOSTRUCT);
  t("リアプロ 木造・アパート", a.structureTier === 0 && a.buildingType === "アパート", [a.structure, a.structureTier, a.buildingType]);
  t("リアプロ 鉄骨造・マンション", s.structureTier === 2 && s.buildingType === "マンション", [s.structure, s.buildingType]);
  t("リアプロ 鉄筋コンクリート造", r.structureTier === 3);
  t("itandi 物件種別 マンション・構造 鉄筋コンクリート", i.structureTier === 3 && i.buildingType === "マンション", [i.structure, i.buildingType]);
  t("itandi「構造 ー」「物件種別 ー」→ 書いていない（null）", n.structureTier == null && n.buildingType == null, [n.structure, n.buildingType]);
}

console.log("■ 条件欄の構造・種別（実物の34か所の書き方）");
type W = ReturnType<typeof parseEquipmentWants>["wants"][number];
const sw = (c: Parameters<typeof parseEquipmentWants>[0]) => parseEquipmentWants(c).wants.find((w) => w.key === "structure") ?? null;
const bw = (c: Parameters<typeof parseEquipmentWants>[0]) => parseEquipmentWants(c).wants.find((w) => w.key === "bldg_type") ?? null;
{
  const cases: Array<[string, Parameters<typeof parseEquipmentWants>[0], number | null, string | null]> = [
    ["other「木造以外」", { other_requests: "木造以外" }, 1, "木造NG"],
    ["other「木造NG」", { other_requests: "木造NG" }, 1, "木造NG"],
    ["pref「木造以外」＋ng「木造NG」", { preferences: "木造以外", ng_points: "木造NG" }, 1, "木造NG"],
    ["other「鉄筋コンクリート」", { other_requests: "鉄筋コンクリート" }, 3, "RC以上"],
    ["other「鉄筋コンクリート希望」", { other_requests: "鉄筋コンクリート希望" }, 3, "RC以上"],
    ["pref「鉄筋コンクリートだけ」", { preferences: "鉄筋コンクリートだけ" }, 3, "RC以上"],
    ["pref「RC造」", { preferences: "RC造" }, 3, "RC以上"],
    ["pref「鉄筋コンクリート造」＋other「鉄筋コンクリート造を希望」", { preferences: "鉄筋コンクリート造", other_requests: "鉄筋コンクリート造を希望" }, 3, "RC以上"],
    ["欄「RC造　SRC造」", { structure_types: "RC造　SRC造" }, 3, "RC以上"],
    ["pref「鉄骨造」＋欄「鉄骨造　RC造　SRC造」", { preferences: "鉄骨造", structure_types: "鉄骨造　RC造　SRC造" }, 2, "鉄骨以上"],
    ["pref「鉄筋コンクリート・宅配ボックスあり・鉄筋または鉄骨造」", { preferences: "鉄筋コンクリート\n宅配ボックスあり・鉄筋または鉄骨造" }, 2, "鉄骨以上"],
    ["pref「…/フローリング/鉄筋/鉄骨/コンロ2口以上…」", { preferences: "入居2人以上可能/浴室トイレ別/独立洗面台/駐車場あり/都市ガス/オートロック/フローリング/鉄筋/鉄骨/コンロ2口以上/インターネット無料/浴室乾燥付き/2階" }, 2, "鉄骨以上"],
    ["other「木造でもいい」→ 希望にしない", { other_requests: "木造でもいい", additional_conditions: "[7/1 10:00|auto] 希望: 独立洗面台 / その他: 木造でもいい" }, null, null],
    ["ng「木造NG（アパート指定）」＋other「アパート希望」→ 木造NG が優先", { ng_points: "木造NG（アパート指定）", other_requests: "アパート希望" }, 1, "木造NG"],
    ["欄に木造が入る「木造 鉄骨造」→ 制限なし", { structure_types: "木造 鉄骨造" }, null, null],
    ["「コンクリート打ちっぱなし」は構造の希望にしない", { preferences: "コンクリート打ちっぱなし" }, null, null],
  ];
  for (const [name, c, min, label] of cases) {
    const w = sw(c);
    t(`構造: ${name} → ${label ?? "なし"}`, (w?.structureMin ?? null) === min && (w ? wantLabel(w) : null) === label, w);
  }
  const types: Array<[string, Parameters<typeof parseEquipmentWants>[0], string | null]> = [
    ["pref「マンションのみ」", { preferences: "マンションのみ" }, "mansion"],
    ["pref「マンション」＋other「マンション希望」", { preferences: "マンション", other_requests: "マンション希望" }, "mansion"],
    ["pref「マンション・家賃低め・初期費用安い」", { preferences: "マンション・家賃低め・初期費用安い" }, "mansion"],
    ["additional「希望: マンション」", { additional_conditions: "【2026/07/15反映済み】[7/15 12:11] エリア: ミナミ周辺 / 希望: マンション / その他: 家賃は低めの物件" }, "mansion"],
    ["other「3階以上でエレベーターのあるマンション希望」", { other_requests: "3階以上でエレベーターのあるマンション希望" }, "mansion"],
    ["pref「アパート」「アパート希望」", { preferences: "アパート\nアパート希望" }, "apartment"],
    ["other「またはアパートで8〜9万で30㎡」", { other_requests: "またはアパートで8〜9万で30㎡" }, "apartment"],
    ["ng「木造NG（アパート指定）」は種別を読まない＋other「アパート希望」", { ng_points: "木造NG（アパート指定）", other_requests: "アパート希望" }, "apartment"],
  ];
  for (const [name, c, type] of types) {
    const w = bw(c);
    t(`種別: ${name} → ${type}`, (w?.bldgType ?? null) === type, w);
  }
  const f8 = parseEquipmentWants({ other_requests: "3階以上でエレベーターのあるマンション希望" }).wants;
  t("「3階以上でエレベーターのあるマンション希望」→ 3階以上・エレベーター・マンション", f8.some((w) => w.key === "floor" && w.minFloor === 3) && f8.some((w) => w.key === "elevator") && f8.some((w) => w.key === "bldg_type"), f8.map((w: W) => w.key));
  t("構造・種別は「照らせない条件」に残らない", parseEquipmentWants({ other_requests: "木造NG", preferences: "マンションのみ" }).uncovered.length === 0);
}

console.log("■ 構造の照合（○ △ × －）と札");
{
  const rc = parseEquipmentWants({ other_requests: "鉄筋コンクリート希望" });
  const woodNg = parseEquipmentWants({ other_requests: "木造NG" });
  const steel = parseEquipmentWants({ preferences: "鉄骨造", structure_types: "鉄骨造　RC造　SRC造" });
  const row = (w: ReturnType<typeof parseEquipmentWants>, text: string) => matchEquipment(w, parseListingEquipment(text)).rows.find((r) => r.want.key === "structure")!;
  t("RC希望 × RC → ○", row(rc, RP_RC).mark === "○");
  t("RC希望 × 鉄骨 → △（少し低い・一段下）", row(rc, RP_STEEL).mark === "△" && row(rc, RP_STEEL).result === "ok", row(rc, RP_STEEL));
  t("RC希望 × 木造 → ×", row(rc, RP_WOOD_APT).mark === "×");
  t("RC希望 × 構造 ー → －（要確認・0点）", row(rc, IT_NOSTRUCT).mark === "－");
  t("木造NG × 鉄骨 → ○", row(woodNg, RP_STEEL).mark === "○");
  t("木造NG × 木造 → ×", row(woodNg, RP_WOOD_APT).mark === "×");
  t("鉄骨以上 × 鉄骨 → ○・× 木造 → ×", row(steel, RP_STEEL).mark === "○" && row(steel, RP_WOOD_APT).mark === "×");
  const codesNear = equipmentReasonCodes(matchEquipment(rc, parseListingEquipment(RP_STEEL)));
  t("△ は EQUIP_STRUCTURE_NEAR（0点・保留にしない）", codesNear.includes("EQUIP_STRUCTURE_NEAR") && reasonPoints("EQUIP_STRUCTURE_NEAR") === 0, codesNear);
  t("NEAR の日本語", reasonJa("EQUIP_STRUCTURE_NEAR") === "構造が希望より一段下（資料）");
  const mansion = parseEquipmentWants({ preferences: "マンションのみ" });
  const apt = parseEquipmentWants({ other_requests: "アパート希望" });
  const trow = (w: ReturnType<typeof parseEquipmentWants>, text: string) => matchEquipment(w, parseListingEquipment(text)).rows.find((r) => r.want.key === "bldg_type")!;
  t("マンション希望 × マンション → ○", trow(mansion, RP_RC).mark === "○");
  t("マンション希望 × アパート → ×", trow(mansion, RP_WOOD_APT).mark === "×");
  t("マンション希望 × 種別 ー → －", trow(mansion, IT_NOSTRUCT).mark === "－");
  t("アパート希望 × マンション → ○（減点しない）", trow(apt, RP_RC).mark === "○");
  // 判定: × は保留 −10・△ は 0・○ は +3・－ は 0（外す候補にはしない）
  const p = buildCustomerProfile({ rent_max: 90_000, floor_plan: "1LDK", other_requests: "鉄筋コンクリート希望" });
  const S = "【1】X\n80,000円\n1LDK\n敷なし 礼なし\n徒歩5分";
  const jW = judgeProperty(parsePropertyFacts(S), p, 0, { equipment: matchEquipment(rc, parseListingEquipment(RP_WOOD_APT)) });
  const jS = judgeProperty(parsePropertyFacts(S), p, 0, { equipment: matchEquipment(rc, parseListingEquipment(RP_STEEL)) });
  const jR = judgeProperty(parsePropertyFacts(S), p, 0, { equipment: matchEquipment(rc, parseListingEquipment(RP_RC)) });
  const jN = judgeProperty(parsePropertyFacts(S), p, 0, { equipment: matchEquipment(rc, parseListingEquipment(IT_NOSTRUCT)) });
  t("木造 → EQUIP_STRUCTURE_NG・保留（外す候補ではない）", jW.reasonCodes.includes("EQUIP_STRUCTURE_NG") && jW.verdict === "hold", jW.reasonCodes);
  t("RC ＞ 鉄骨 ＞ 木造 の順の点", jR.score > jS.score && jS.score > jW.score, [jR.score, jS.score, jW.score]);
  // 2026-09-25 案B: 鉄骨（一段下＝幅の内側）は書いた条件の数に入り（3つで全部合う +15）、書いていない（要確認）は数えない（2つで半分 +8）→ 差は 7点
  t("書いていない → EQUIP_STRUCTURE_UNLISTED 0点・通す（全部合うの数に入らない分だけ鉄骨より 7点下）", jN.reasonCodes.includes("EQUIP_STRUCTURE_UNLISTED") && jN.verdict === "pass" && jN.score === jS.score - (REASON_POINTS.FIT_ALL - REASON_POINTS.FIT_ALL_HALF), [jN.score, jS.score, jN.reasonCodes]);
  t("ラベル: RC以上・鉄骨以上・木造NG・マンション", [wantLabel(rc.wants[0]), wantLabel(steel.wants.find((w) => w.key === "structure")!), wantLabel(woodNg.wants[0]), wantLabel(mansion.wants[0])].join(",") === "RC以上,鉄骨以上,木造NG,マンション");
}

console.log("■ AD の段（ほかの項目の約1.3倍・2ヶ月以上ははっきり高く）");
{
  const p = buildCustomerProfile({ rent_max: 90_000, floor_plan: "1LDK" });
  const base = "【1】X\n80,000円\n1LDK\n敷なし 礼なし\n徒歩5分";
  const sc = (ad: string) => judgeProperty(parsePropertyFacts(base + (ad ? `\n${ad}` : "")), p);
  const none = sc(""), m1 = sc("AD 1ヶ月"), m15 = sc("AD 1.5ヶ月"), m2 = sc("AD 2ヶ月"), m25 = sc("A D 250%(税込)"), m3 = sc("AD 3ヶ月"), m4 = sc("AD 4ヶ月"), adn = sc("AD なし");
  const d = (j: typeof none) => j.score - none.score;
  t("段（竹内: 150%以上は1.15倍・200%以上は1.3倍）: 1ヶ月 +15 ／1.5ヶ月 +17 ／2ヶ月以上 +20（2.5・3・4ヶ月も +20）", [d(m1), d(m15), d(m2), d(m25), d(m3), d(m4)].join(",") === "15,17,20,20,20,20", [d(m1), d(m15), d(m2), d(m25), d(m3), d(m4)]);
  t("2ヶ月は家賃の上限内（+15）の約1.3倍", Math.abs(d(m2) / REASON_POINTS.RENT_OK - 1.33) < 0.05);
  t("倍率: 1.5ヶ月は1ヶ月の約1.15倍・2ヶ月は約1.3倍（2ヶ月以上は一律）", Math.abs(d(m15) / d(m1) - 1.15) < 0.05 && Math.abs(d(m2) / d(m1) - 1.3) < 0.05 && d(m25) === d(m2) && d(m3) === d(m2));
  t("AD 不明は 0点（一段下げない）・要確認の札", none.reasonCodes.includes("AD_UNKNOWN") && reasonPoints("AD_UNKNOWN") === 0 && reasonJa("AD_UNKNOWN").startsWith("要確認"));
  // 2026-09-25 案B: AD なし −5 → −10（竹内「AD 1未満は点数低く・なかなかお勧めしない」）
  // 保留（利益が出ない）なので、AD 不明の物件に付く全部合う（条件2つ＝半分 +8）も付かない
  t("AD なしは −10＋利益が出ない −10（不明より下・保留・全部合うも外れる）", d(adn) === -20 - REASON_POINTS.FIT_ALL_HALF && none.reasonCodes.includes("FIT_ALL_HALF") && !adn.reasonCodes.some((c) => c.startsWith("FIT_")) && adn.reasonCodes.includes("AD_NONE") && adn.reasonCodes.includes("PROFIT_NEGATIVE"), adn.reasonCodes);
  t("割引をまかなえる（AD_COVERS_DISCOUNT）は 0点の知らせ（段と二重に数えない）", REASON_POINTS.AD_COVERS_DISCOUNT === 0 && m2.reasonCodes.includes("AD_COVERS_DISCOUNT"));
  const low = judgeProperty(parsePropertyFacts("【1】安い\n40,000円\n1LDK\n敷なし 礼なし\n徒歩5分\nAD 1ヶ月"), p);
  t("利益が出ない（AD 40,000 < 割引 42,000）は今まで通り −10 保留", low.reasonCodes.includes("PROFIT_NEGATIVE") && low.verdict === "hold");
  t("円だけの AD 159,999円（家賃 80,000）も2ヶ月の段（割り算の端数で落とさない）", sc("AD 159,999円").reasonCodes.includes("AD_HIGH"));
}

console.log("■ 保留の物件は AD だけで通す物件より上に来ない（_HELD・0点）");
{
  const p = buildCustomerProfile({ rent_max: 80_000, floor_plan: "1K", walk_minutes: 10 });
  // 家賃が上限の1割超（保留）で AD 3ヶ月 vs 条件どおり（通す）で AD 不明
  const hold = judgeProperty(parsePropertyFacts("【1】高いが AD 3ヶ月\n92,000円\n1K\n敷なし 礼なし\n徒歩5分\nAD 3ヶ月"), p);
  const pass = judgeProperty(parsePropertyFacts("【2】条件どおり\n75,000円\n1K\n敷なし 礼なし\n徒歩5分"), p);
  const pass1 = judgeProperty(parsePropertyFacts("【3】条件どおり AD 1ヶ月\n75,000円\n1K\n敷なし 礼なし\n徒歩5分\nAD 1ヶ月"), p);
  t("前提: 保留と通す", hold.verdict === "hold" && pass.verdict === "pass", [hold.verdict, pass.verdict]);
  t("保留（AD 3ヶ月）< 通す（AD 不明）", hold.score < pass.score, [hold.score, pass.score]);
  t("保留（AD 3ヶ月）< 通す（AD 1ヶ月）", hold.score < pass1.score, [hold.score, pass1.score]);
  t("保留の AD は _HELD で残る（見えるが点に入れない）", hold.reasonCodes.includes("AD_HIGH_HELD") && hold.reasonCodes.includes("AD_VERY_HIGH_HELD") && reasonPoints("AD_HIGH_HELD") === 0, hold.reasonCodes);
  t("_HELD の日本語", reasonJa("AD_HIGH_HELD") === "ADが高い（2ヶ月以上）（保留の物件なので点に入れない）");
  t("50＋札の合計＝点（_HELD 込み）", Math.max(0, Math.min(SCORE_MAX, BASE_SCORE + hold.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0))) === hold.score);
  // 実データの形（property_pickups id 35 と 42）: 入居が遅い保留 AD 2.2ヶ月 と 通す AD 1.5ヶ月
  // 画像の × で後から保留になった物件も AD を外す
  const j = judgeProperty(parsePropertyFacts("【4】X\n75,000円\n1K\n敷なし 礼なし\n徒歩5分\nAD 2ヶ月"), buildCustomerProfile({ rent_max: 80_000, floor_plan: "1K", walk_minutes: 10, preferences: "2階以上" }));
  const img = applyImageFacts(j, { floor_2_plus: false });
  t("画像の × で保留 → AD_HIGH が _HELD・点は 50＋合計", img.verdict === "hold" && img.reasonCodes.includes("AD_HIGH_HELD") && img.score === BASE_SCORE + img.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0), [img.score, img.reasonCodes]);
  // 付け直し（applyEquipmentMatch）: 保留の札が無くなれば AD の点を戻す
  const back = applyEquipmentMatch({ reasonCodes: ["RENT_OK", "AD_HIGH_HELD", "EQUIP_ELEVATOR_NG"] }, null);
  t("付け直しで保留の札が無くなれば AD の点に戻す", back.reasonCodes.includes("AD_HIGH") && !back.reasonCodes.includes("AD_HIGH_HELD") && back.verdict === "pass" && back.score === 85, back);
  t("settleHeldAd は AD の段以外に触らない", JSON.stringify(settleHeldAd(["RENT_OK", "AD_NONE", "AD_1M", "AD_COVERS_DISCOUNT"], true)) === JSON.stringify(["RENT_OK", "AD_NONE", "AD_1M_HELD", "AD_COVERS_DISCOUNT"]));
}

console.log("■ 🌟の前置き・条件（AD を最上位にしない・構造と設備の希望を渡す）");
{
  t("「必ず最上位」をやめた", !/必ず最上位/.test(RANK_PROMPT_PREFIX));
  t("「条件が同じくらい合う物件の中で AD の高い方を上に」", /条件が同じくらい合う物件の中で、AD の高い方を上にする/.test(RANK_PROMPT_PREFIX));
  t("AD の記載なしは下げない・AD なしは下に", /AD の記載が無い物件は「分からない」として扱い、下げない/.test(RANK_PROMPT_PREFIX) && /「AD なし」と書いてある物件は報酬ゼロ/.test(RANK_PROMPT_PREFIX));
  t("構造・物件種別の決まりが前置きにある（固定の文）", /木造NG なら木造は選ばない/.test(RANK_PROMPT_PREFIX) && /マンション希望ならマンション/.test(RANK_PROMPT_PREFIX));
  const wants = parseEquipmentWants({ preferences: "2階以上必須、宅配ボックス、オートロック", ng_points: "木造NG", other_requests: "マンション希望" }).wants;
  const line = rankEquipmentLine(wants);
  t("設備・構造の希望の1行", line === "設備・構造の希望: 2階以上［必須］・宅配ボックス・オートロック・構造 木造NG（木造は選ばない）・物件種別 マンション（アパートは選ばない）", line);
  const rcLine = rankEquipmentLine(parseEquipmentWants({ other_requests: "鉄筋コンクリート希望", ng_points: "木造NG" }).wants);
  t("RC希望の行は段の意味まで書く（YUMA テストで木造を2番目に選んだ回があった）", rcLine === "設備・構造の希望: 構造 RC以上（木造は選ばない・鉄骨は少し下）", rcLine);
  const cond = buildRankConditions("予算8万円以内", { summaryLine: "家賃 8万まで｜間取り 1K｜設備 2階以上［必須］・宅配ボックス・構造", equipmentLine: line, lowInitialCost: true });
  t("要約の「設備 …」の欄は専用の行に置き換える（二重に書かない）", cond === `家賃 8万まで｜間取り 1K\n${line}\n初期費用を抑えたい（敷金・礼金0の物件を優先）`, cond);
  t("希望が無ければ行を足さない", buildRankConditions("予算8万円以内", { summaryLine: null, equipmentLine: rankEquipmentLine([]) }) === "予算8万円以内");
  const eqR = parseListingEquipment(RP_RC);
  const mat = rankMaterialLine({ hasText: true, depositMonths: 0, keyMoneyMonths: 0, buildingAgeYears: 5, newBuild: false, moveIn: { kind: "immediate" } }, ["オートロック"], { structure: eqR.structure, buildingType: eqR.buildingType, floor: eqR.floor, elevator: eqR.items.elevator.status });
  t("資料の行に 種別・構造・階・エレベーター", mat === "マンション・構造 鉄筋コンクリート造・5階・エレベーターあり ／ 敷なし・礼なし ／ 築5年 ／ 即入居 ／ 設備: オートロック", mat);
}

console.log("■ 反証レビュー（2026-09-25）: 鉄骨NG・EV（無）・🌟の決定論の外し・画像の後の 50＋合計");
{
  const w1 = parseEquipmentWants({ preferences: "軽量鉄骨NG" }).wants.find((w) => w.key === "structure");
  t("希望欄の「軽量鉄骨NG」→ 鉄骨以上（旧は軽量鉄骨の希望＝軽量鉄骨を ○）", w1?.structureMin === 2 && w1?.structureNoNear === true, w1);
  const facts = (s: string) => parseListingEquipment(`RealNetPro\n物件名 X\n号室名 201\n建築構造 ${s} 地上3階\n設 備\n`);
  const row1 = matchEquipment(parseEquipmentWants({ preferences: "軽量鉄骨NG" }), facts("軽量鉄骨造")).rows.find((r) => r.want.key === "structure");
  t("軽量鉄骨NG に軽量鉄骨 → ×（一段下 △ にしない）", row1?.result === "ng", row1);
  const row1b = matchEquipment(parseEquipmentWants({ preferences: "軽量鉄骨NG" }), facts("鉄骨造")).rows.find((r) => r.want.key === "structure");
  t("軽量鉄骨NG に鉄骨 → ○", row1b?.result === "ok" && row1b?.mark !== "△", row1b);
  const w2 = parseEquipmentWants({ ng_points: "鉄骨" }).wants.find((w) => w.key === "structure");
  t("NG 欄の「鉄骨」→ RC以上（旧は読まなかった）", w2?.structureMin === 3 && w2?.structureNoNear === true, w2);
  const row2 = matchEquipment(parseEquipmentWants({ ng_points: "鉄骨" }), facts("鉄骨造")).rows.find((r) => r.want.key === "structure");
  t("NG 欄の鉄骨に鉄骨造 → ×", row2?.result === "ng", row2);
  const w3 = parseEquipmentWants({ other_requests: "鉄筋コンクリート希望" }).wants.find((w) => w.key === "structure");
  t("鉄筋コンクリート希望は今まで通り（RC以上・鉄骨は △）", w3?.structureMin === 3 && !w3?.structureNoNear, w3);
  t("「木造でもいい」は今まで通り希望にしない", !parseEquipmentWants({ preferences: "木造でもいい" }).wants.some((w) => w.key === "structure"));
  const w4 = parseEquipmentWants({ other_requests: "鉄筋コンクリート希望", preferences: "鉄骨NG" }).wants.find((w) => w.key === "structure");
  t("RC希望＋鉄骨NG → RC以上・鉄骨は × の行（「鉄骨は少し下」と書かない）", w4?.structureMin === 3 && w4?.structureNoNear === true && rankEquipmentLine(w4 ? [w4] : []) === "設備・構造の希望: 構造 RC以上（木造は選ばない）", rankEquipmentLine(w4 ? [w4] : []));

  const HEAD = "RealNetPro\n物件名 X\n号室名 301\n";
  const ev = (eq: string) => parseListingEquipment(`${HEAD}設備\n${eq}\n備考\n`).items.elevator.status;
  t("「エレベーター（無）」→ ng（旧は ok）", ev("都市ガス , エレベーター（無） , 宅配 BOX") === "ng");
  t("「EV：有」→ ok", ev("EV：有 , 駐輪場") === "ok");
  t("「エレベーター（2基）」→ ok のまま", ev("エレベーター（2基）") === "ok");

  const cond = "家賃 8万まで\n設備・構造の希望: 2階以上・構造 木造NG（木造は選ばない）・物件種別 マンション（アパートは選ばない）";
  const mats = ["アパート・構造 木造・2階 ／ 敷なし・礼なし", "マンション・構造 鉄筋コンクリート造・5階 ／ 築5年", null, "構造 鉄骨造・3階", "マンション・構造 軽量鉄骨造・2階"];
  const ex = rankStructureExcluded(cond, mats);
  t("🌟の外し: 木造アパートは外す・RC マンションは残す・資料なしは外さない", ex.has(1) && !ex.has(2) && !ex.has(3) && !ex.has(4) && !ex.has(5), [...ex]);
  const exRc = rankStructureExcluded("設備・構造の希望: 構造 RC以上（木造は選ばない・鉄骨は少し下）", mats);
  t("RC以上: 鉄骨は少し下（外さない）・軽量鉄骨と木造は外す", exRc.has(1) && !exRc.has(2) && !exRc.has(4) && exRc.has(5), [...exRc]);
  t("「できれば」の構造は外さない", rankStructureExcluded("設備・構造の希望: 2階以上 ／ できれば 構造 RC以上（木造は選ばない・鉄骨は少し下）", mats).size === 0);
  t("希望の行が無ければ何も外さない", rankStructureExcluded("家賃 8万まで", mats).size === 0);
  t("applyRankMarkers に外した後の番号を渡すと🌟★は残った先頭", applyRankMarkers(["【1】A", "【2】B"], [2]).join("|") === "【1】A|【2🌟★】B");

  // 画像の後の点: 上限 200 で丸めた後から引かない（50＋合計で付け直す）
  const j = { score: SCORE_MAX, verdict: "pass" as const, reasonCodes: Array.from({ length: 12 }, () => "RENT_OK"), flagCodes: [], reasonsJa: [], imageChecks: ["floor_2_plus"] } as unknown as Parameters<typeof applyImageFacts>[0];
  const img = applyImageFacts(j, { floor_2_plus: false } as Parameters<typeof applyImageFacts>[1]);
  t("素点 230 に画像の × −10 → 200（旧は 190）", img.score === SCORE_MAX, img.score);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
