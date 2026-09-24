// 売上サポのピックアップに「資料の設備欄 × お客様の条件」を組み込む部分（純関数）のテスト
// 実行: npx tsx app/lib/__tests__/pickup-equipment.test.ts
// 文字は 2026-09-24 の実物（property_pickups id 50〜67・itandi の1ページ目の文字層）の抜粋の形（康熙部首の字・「‧」・行の割れも元のまま）。
// 会社の電話・保証会社の文は外してある。お客様の名前・電話番号は無い
import { buildBatchEquipment, matchFromSummary, floorLabel, toPickupEquipment } from "../pickup-equipment";
import { parseEquipmentWants, matchEquipment, parseListingEquipment } from "../listing-equipment";
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, applyImageFacts, applyEquipmentMatch, equipmentReasonCodes,
  reasonPoints, reasonJa, BASE_SCORE, EQUIP_CAP_CODE, type CustomerLike,
} from "../property-brain";
import { buildReasonView, formatScoreBreakdown } from "../pickup-review-order";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}

// ───────── 実物の形（itandi） ─────────
// 同じ建物の 1512号室には「エレベーター・宅配 BOX」がある／405号室の設備欄には無い（→ 〔建〕で補う）
const IT_1512 = `仲介
エステムコート新⼤阪 Ⅵ エキスプレイス 1512 号室
所在地 ⼤阪府⼤阪市淀川区⻄宮原１丁⽬ 7-46
構造 鉄筋コンクリート 階建 / 総⼾数 15 階建 / 180 ⼾
所在階 15 階 主要採光⾯ 東向き
駐⾞場 ー 駐⾞場代 ー
設備
都市ガス , バス‧トイレ別 , 室内洗濯機置場 , システムキッチン , エレベーター , 宅配 BOX, 敷地内ごみ置き場
備考
ー`;
const IT_405 = `仲介
エステムコート新⼤阪 Ⅵ エキスプレイス 405 号室
所在地 ⼤阪府⼤阪市淀川区⻄宮原１丁⽬ 7-46
構造 鉄筋コンクリート 階建 / 総⼾数 15 階建 / 180 ⼾
所在階 4 階 主要採光⾯ ⻄向き
駐⾞場 空きなし 敷地内 駐⾞場代 なし
設備
都市ガス , バス‧トイレ別 , 独⽴洗⾯台 , 室内
洗濯機置場 , システムキッチン , オートロック
備考
ー`;
const IT_104 = `仲介
プレサンス新⼤阪ザ‧シティ 104 号室
所在地 ⼤阪府⼤阪市東淀川区東中島 4 丁⽬ 1-39
構造 鉄筋コンクリート 階建 / 総⼾数 15 階建 / ー
所在階 1 階 主要採光⾯ 南東向き
駐⾞場 ー 駐⾞場代 ー
設備
都市ガス , バス‧トイレ別 , 独⽴洗⾯台 , 室内洗濯機置場 , シ
ステムキッチン , ペット不可
備考
ー`;
// HONOKA さんの条件欄（preferences）の形
const HONOKA_COND = { preferences: "2階以上、エレベーター付き、宅配box付き、独立洗面台、風呂トイレ別", ng_points: null, other_requests: "駅からの距離はもう少し近い方が理想", additional_conditions: null, pet: false };

console.log("■ 1回分の照合（同じ建物で補う・号室から階）");
{
  const b = buildBatchEquipment([{ key: 1, pdfText: IT_405 }, { key: 2, pdfText: IT_104 }, { key: "d9", pdfText: IT_1512 }, { key: 3, pdfText: null }], HONOKA_COND);
  t("希望は5つ（2階以上・エレベーター・宅配ボックス・独立洗面台・バス・トイレ別）", b.wants.wants.map((w) => w.key).join(",") === "floor2,elevator,delivery_box,washbasin,bath_toilet", b.wants.wants.map((w) => w.key));
  const r405 = b.rows.find((r) => r.key === 1)!;
  t("405号室: 1行が全部○（エレベーター・宅配ボックスは〔建〕）", r405.saved.line === "2階以上○ エレベーター○〔建〕 宅配ボックス○〔建〕 独立洗面台○ バス・トイレ別○", r405.saved.line);
  t("〔建〕の根拠は落とした部屋（d9・1512号室）", /1512号室/.test(r405.saved.match.find((m) => m.key === "delivery_box")!.why), r405.saved.match);
  t("所在階 4階（所在階）", floorLabel(r405.saved) === "4階（所在階）");
  const r104 = b.rows.find((r) => r.key === 2)!;
  t("104号室: 1階で 2階以上×・別の建物なので〔建〕で補わない", /^2階以上× エレベーター－ 宅配ボックス－/.test(r104.saved.line), r104.saved.line);
  const none = b.rows.find((r) => r.key === 3)!;
  t("文字層なし: 全部－（点は動かない）", none.match.ng === 0 && none.match.ok === 0 && none.match.unlisted === 5, none.match);
  t("保存の形: 記載のあった設備だけ（35項目全部は持たない）", Object.keys(r405.saved.facts).length < 20 && r405.saved.facts.delivery_box?.fb === true, Object.keys(r405.saved.facts));
  t("保存の形: 照らせない条件は空（HONOKA さんの条件は全部照らせる）", r405.saved.uncovered.length === 0, r405.saved.uncovered);
  t("保存の形は JSON で往復できる", JSON.stringify(JSON.parse(JSON.stringify(r405.saved))) === JSON.stringify(r405.saved));
}

console.log("■ 照らせない条件・所在階の言い方");
{
  const w = parseEquipmentWants({ preferences: "防音性の高い部屋、宅配ボックス" });
  const f = parseListingEquipment(IT_405);
  const s = toPickupEquipment(f, matchEquipment(w, f), w);
  t("防音は照らせない条件に出る", s.uncovered.some((u) => /防音/.test(u)), s.uncovered);
  t("号室から推した階は「（号室から推定）」", floorLabel({ floor: 5, floorSource: "号室", basement: false }) === "5階（号室から推定）");
  t("リアプロの階部分", floorLabel({ floor: 9, floorSource: "階部分", basement: false }) === "9階（階部分）");
  t("地下", floorLabel({ floor: null, floorSource: null, basement: true }) === "地下");
  t("階が無ければ null", floorLabel({ floor: null, floorSource: null, basement: false }) == null && floorLabel(null) == null);
}

console.log("■ 理由コード（○ +3 で合計 +15 まで・× −10・－ 0・必須 × は上限20）");
{
  const f = parseListingEquipment(IT_405);
  const many = parseEquipmentWants({ preferences: "2階以上、独立洗面台、バストイレ別、室内洗濯機置場、システムキッチン、都市ガス、オートロック" });
  const codes = equipmentReasonCodes(matchEquipment(many, f));
  const okPts = codes.filter((c) => /_OK$/.test(c)).reduce((a, c) => a + reasonPoints(c), 0);
  t("○が7つでも加点は +15 まで（残りは _OK_MAX で 0点）", okPts === 15 && codes.filter((c) => c.endsWith("_OK_MAX")).length === 2, codes);
  t("_OK_MAX は 0点", reasonPoints("EQUIP_CITY_GAS_OK_MAX") === 0);
  t("× は −10", reasonPoints("EQUIP_FLOOR2_NG") === -10);
  t("－ は 0点", reasonPoints("EQUIP_DELIVERY_BOX_UNLISTED") === 0);
  t("札: 要確認: 宅配ボックス", reasonJa("EQUIP_DELIVERY_BOX_UNLISTED") === "要確認: 宅配ボックス");
  t("札: 2階以上×（資料）", reasonJa("EQUIP_FLOOR2_NG") === "2階以上×（資料）");
  t("札: 宅配ボックス○（資料）・加点は上限", reasonJa("EQUIP_DELIVERY_BOX_OK") === "宅配ボックス○（資料）" && /上限/.test(reasonJa("EQUIP_DELIVERY_BOX_OK_MAX")));
  t("札: 階の範囲（FLOOR）", reasonJa("EQUIP_FLOOR_NG") === "階の希望×（資料）");
  t("知らないコードはそのまま", reasonJa("XYZ") === "XYZ");
  const strong = parseEquipmentWants({ preferences: "2階以上必須、宅配ボックス" });
  const sc = equipmentReasonCodes(matchEquipment(strong, parseListingEquipment(IT_104)));
  t("必須の × は上限の印（EQUIP_MUST_NG_CAP）", sc.includes("EQUIP_FLOOR2_NG") && sc.includes(EQUIP_CAP_CODE), sc);
  const pet = equipmentReasonCodes(matchEquipment(parseEquipmentWants({ pet: true }), parseListingEquipment(`仲介\nX 301 号室\n所在階 3 階 主要採光⾯ 南向き\n設備\nバス‧トイレ別 , ペット相談\n備考\nー`)));
  t("ペット相談（△）は _ASK で 0点", pet.includes("EQUIP_PET_ASK") && reasonPoints("EQUIP_PET_ASK") === 0, pet);
  t("照合なしはコードなし", equipmentReasonCodes(null).length === 0);
}

console.log("■ judgeProperty に組み込む（50＋合計＝score・drop にしない・画像で二重に数えない）");
const cust: CustomerLike = { rent_max: 70_000, walk_minutes: 10, building_age: 20, ...HONOKA_COND, preferences: HONOKA_COND.preferences };
const sum405 = "【1】エステムコート新大阪Ⅵエキスプレイス 405号室\n67,000円 管理費なし\n1K 20.8㎡\n徒歩8分\nAD 1ヶ月";
{
  const p = buildCustomerProfile(cust, []);
  t("プロフィールの画像の希望（2階以上・独立洗面・バストイレ別）", p.imageWants.includes("floor_2_plus") && p.imageWants.includes("separate_washstand") && p.imageWants.includes("bath_toilet_separate"), p.imageWants);
  const b = buildBatchEquipment([{ key: 1, pdfText: IT_405 }, { key: 2, pdfText: IT_104 }, { key: 3, pdfText: IT_1512 }], cust);
  const j405 = judgeProperty(parsePropertyFacts(sum405), p, 0, { equipment: b.rows[0].match });
  const base = judgeProperty(parsePropertyFacts(sum405), p, 0);
  t("405号室: ○5つで +15", j405.score === Math.min(130, base.score + 15), [base.score, j405.score, j405.reasonCodes]);
  t("50＋合計＝score", BASE_SCORE + j405.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0) === j405.score);
  t("設備欄で決まった希望は画像で確かめ直さない（imageChecks から外す）", !j405.imageChecks.includes("floor_2_plus") && !j405.imageChecks.includes("bath_toilet_separate") && !j405.imageChecks.includes("separate_washstand"), j405.imageChecks);
  t("設備欄が無ければ今まで通り画像で確かめる", base.imageChecks.includes("floor_2_plus"));
  t("○ は reasons_ja の良い点に出る", j405.reasonsJa.includes("宅配ボックス○（資料）"), j405.reasonsJa);
  const j104 = judgeProperty(parsePropertyFacts("【2】プレサンス新大阪ザ・シティ 104号室\n66,000円\n1K\n徒歩5分\nAD 2ヶ月"), p, 1, { equipment: b.rows[1].match });
  t("104号室（1階）: × で保留・外す候補にはしない", j104.verdict === "hold" && j104.flagCodes.includes("EQUIP_FLOOR2_NG"), [j104.verdict, j104.flagCodes]);
  t("－ は 0点の要確認（札）", j104.reasonCodes.includes("EQUIP_ELEVATOR_UNLISTED") && j104.reasonCodes.includes("EQUIP_DELIVERY_BOX_UNLISTED"));
  // 画像で分析と同じ: 必須の × は上限20
  const strongP = buildCustomerProfile({ ...cust, preferences: "2階以上必須、宅配box付き" }, []);
  const sw = parseEquipmentWants({ preferences: "2階以上必須、宅配box付き" });
  const js = judgeProperty(parsePropertyFacts("【2】X 104号室\n60,000円\n1K\n徒歩5分\nAD 3ヶ月"), strongP, 1, { equipment: matchEquipment(sw, parseListingEquipment(IT_104)) });
  t("必須の × は上限 20・保留", js.score === 20 && js.verdict === "hold", [js.score, js.reasonCodes]);
  const withImg = applyImageFacts({ ...js, imageChecks: ["storage"] }, { storage: true });
  t("画像の加点でも上限 20 を越えない", withImg.score === 20, withImg.score);
  const v = buildReasonView({ reason_codes: js.reasonCodes, reasons_ja: js.reasonsJa });
  t("点の内訳は「上限・下限で 20」を出す", /上限・下限で 20/.test(formatScoreBreakdown(v, js.score)), formatScoreBreakdown(v, js.score));
  t("札: 上限の印は知らせ（0点）", v.minus.some((c) => c.code === EQUIP_CAP_CODE && c.tone === "info"), v.minus);
  t("札: 要確認: エレベーター（知らせ）", buildReasonView({ reason_codes: j104.reasonCodes, reasons_ja: j104.reasonsJa }).minus.some((c) => c.label === "要確認: エレベーター" && c.tone === "info"));
}

console.log("■ ペット: 設備欄で決まれば PET_NG（説明文の語）は使わない");
{
  const p = buildCustomerProfile({ rent_max: 70_000, pet: true }, []);
  const sumNg = "【1】X 104号室\n60,000円\n1K\nペット不可";
  const noEq = judgeProperty(parsePropertyFacts(sumNg), p, 0);
  t("設備欄が無い時は今まで通り PET_NG", noEq.reasonCodes.includes("PET_NG"));
  const m = matchEquipment(parseEquipmentWants({ pet: true }), parseListingEquipment(IT_104));
  const withEq = judgeProperty(parsePropertyFacts(sumNg), p, 0, { equipment: m });
  t("設備欄で不可 → EQUIP_PET_NG だけ（二重に数えない）", withEq.reasonCodes.includes("EQUIP_PET_NG") && !withEq.reasonCodes.includes("PET_NG"), withEq.reasonCodes);
  const unl = matchEquipment(parseEquipmentWants({ pet: true }), parseListingEquipment(IT_405));
  const withUnl = judgeProperty(parsePropertyFacts(sumNg), p, 0, { equipment: unl });
  t("設備欄に記載なし → 説明文の PET_NG を残す", withUnl.reasonCodes.includes("PET_NG") && withUnl.reasonCodes.includes("EQUIP_PET_UNLISTED"), withUnl.reasonCodes);
}

console.log("■ 保存済みの判定に付け直す（applyEquipmentMatch）");
{
  // id 50 の形: 家賃・徒歩・AD と画像（2階以上・バストイレ別・独立洗面）のコード
  const stored = ["RENT_OK", "INITIAL_COST_UNKNOWN", "WALK_OK", "AD_COVERS_DISCOUNT", "AD_1M", "IMAGE_BATH_TOILET_SEPARATE_OK", "IMAGE_SEPARATE_WASHSTAND_OK", "IMAGE_FLOOR_2_PLUS_OK"];
  t("前提: 保存の点は 105", BASE_SCORE + stored.reduce((a, c) => a + reasonPoints(c), 0) === 105);
  const b = buildBatchEquipment([{ key: 1, pdfText: IT_405 }, { key: 3, pdfText: IT_1512 }], HONOKA_COND);
  const r = applyEquipmentMatch({ reasonCodes: stored }, b.rows[0].match);
  t("家賃・徒歩・AD のコードは残る", ["RENT_OK", "WALK_OK", "AD_COVERS_DISCOUNT", "AD_1M"].every((c) => r.reasonCodes.includes(c)), r.reasonCodes);
  t("設備欄で決まった画像のコードは外す（二重に数えない）", !r.reasonCodes.some((c) => c.startsWith("IMAGE_")), r.reasonCodes);
  t("点: 50＋15＋10＋10＋5＋15 = 105", r.score === 105 && r.verdict === "pass", [r.score, r.reasonCodes]);
  const again = applyEquipmentMatch({ reasonCodes: r.reasonCodes }, b.rows[0].match);
  t("2回付け直しても同じ（冪等）", JSON.stringify(again) === JSON.stringify(r));
  const hold = applyEquipmentMatch({ reasonCodes: ["RENT_OK", "PROFIT_NEGATIVE"] }, null);
  t("照合なしでも hold のコードは hold", hold.verdict === "hold" && hold.score === 55);
  const drop = applyEquipmentMatch({ reasonCodes: ["ALREADY_SENT", "RENT_OK"] }, b.rows[0].match);
  t("drop のコードは drop のまま", drop.verdict === "drop");
  // judgeProperty の結果と一致する（同じ材料なら）
  const p = buildCustomerProfile(cust, []);
  const j = judgeProperty(parsePropertyFacts(sum405), p, 0, { equipment: b.rows[0].match });
  const re = applyEquipmentMatch({ reasonCodes: judgeProperty(parsePropertyFacts(sum405), p, 0).reasonCodes }, b.rows[0].match);
  t("judgeProperty と付け直しの点・verdict・コードが一致", re.score === j.score && re.verdict === j.verdict && JSON.stringify(re.reasonCodes) === JSON.stringify(j.reasonCodes), [re, j.score, j.reasonCodes]);
}

console.log("■ 拡張の判定（PDF なし・説明文から読めた分だけ）");
{
  const w = parseEquipmentWants(HONOKA_COND);
  const m = matchFromSummary(sum405, w);
  t("号室 405 → 2階以上○（号室から）だけ・記載なしは付けない", !!m && m.rows.length === 1 && m.rows[0].want.key === "floor2" && m.rows[0].result === "ok" && /号室/.test(m.rows[0].why), m);
  const m1 = matchFromSummary("【2】プレサンス新大阪ザ・シティ 104号室\n66,000円 管理費なし\n1K 22㎡\n徒歩5分\nAD 2ヶ月", w);
  t("号室 104 → 2階以上×", !!m1 && m1.ng === 1, m1);
  t("号室も設備も無ければ null", matchFromSummary("【1】物件\nAD 1ヶ月", w) == null);
  t("希望が無ければ null", matchFromSummary(sum405, parseEquipmentWants({})) == null);
}

console.log("■ 反証レビュー（2026-09-24）");
{
  // ① 記載なし（－）だけでは点も verdict も動かない（減点・保留・外す候補にならない）
  const p = buildCustomerProfile({ rent_max: 70_000, preferences: "宅配box付き、エレベーター付き、独立洗面台" }, []);
  const sum = "【1】X 405号室\n60,000円\n1K\n徒歩5分\nAD 2ヶ月";
  const noText = buildBatchEquipment([{ key: 1, pdfText: null }], { preferences: "宅配box付き、エレベーター付き、独立洗面台" });
  const base = judgeProperty(parsePropertyFacts(sum), p, 0);
  const unl = judgeProperty(parsePropertyFacts(sum), p, 0, { equipment: noText.rows[0].match });
  t("① 記載なしだけ: 点・verdict・flagCodes は照合なしと同じ", unl.score === base.score && unl.verdict === base.verdict && JSON.stringify(unl.flagCodes) === JSON.stringify(base.flagCodes), [unl.score, base.score, unl.verdict, unl.flagCodes]);
  t("① 記載なしのコードは要確認の札（0点）", unl.reasonCodes.filter((c) => /_UNLISTED$/.test(c)).length === 3 && unl.reasonCodes.filter((c) => /_UNLISTED$/.test(c)).every((c) => reasonPoints(c) === 0));
  const re = applyEquipmentMatch({ reasonCodes: base.reasonCodes }, noText.rows[0].match);
  t("① 付け直しでも記載なしは点・verdict が動かない", re.score === base.score && re.verdict === base.verdict, [re.score, re.verdict]);
  const v = buildReasonView({ reason_codes: unl.reasonCodes, reasons_ja: unl.reasonsJa });
  t("① 札は info（外す・減点ではない）", v.minus.filter((c) => /_UNLISTED$/.test(c.code)).every((c) => c.tone === "info" && c.points === 0));

  // ② 「無いほうがよい」希望（ロフトNG）のコードは逆の意味に読めない
  const w = parseEquipmentWants({ ng_points: "ロフト" });
  const noLoft = matchEquipment(w, parseListingEquipment(IT_405));
  const hasLoft = matchEquipment(w, parseListingEquipment(IT_405.replace("オートロック", "オートロック , ロフト")));
  const cNo = equipmentReasonCodes(noLoft), cHas = equipmentReasonCodes(hasLoft);
  t("② ロフトNG・記載なし → EQUIP_LOFT_NOT_UNLISTED", cNo.includes("EQUIP_LOFT_NOT_UNLISTED"), cNo);
  t("② ロフトNG・ロフトあり → EQUIP_LOFT_NOT_NG「ロフトNG×（資料）」", cHas.includes("EQUIP_LOFT_NOT_NG") && reasonJa("EQUIP_LOFT_NOT_NG") === "ロフトNG×（資料）", [cHas, reasonJa("EQUIP_LOFT_NOT_NG")]);
  t("② NOT の点も _NG −10・_OK +3", reasonPoints("EQUIP_LOFT_NOT_NG") === -10 && reasonPoints("EQUIP_LOFT_NOT_OK") === 3);

  // ③ 必須の × で上限20の後に画像の × が来ても、50＋合計（上限20）と一致する
  const strongP = buildCustomerProfile({ rent_max: 70_000, preferences: "2階以上必須", floor_plan: "1K", walk_max: 10 } as CustomerLike, []);
  const sw = parseEquipmentWants({ preferences: "2階以上必須" });
  const j = judgeProperty(parsePropertyFacts("【2】X 104号室\n60,000円\n1K\n徒歩5分\nAD 3ヶ月"), strongP, 1, { equipment: matchEquipment(sw, parseListingEquipment(IT_104)) });
  const img = applyImageFacts({ ...j, imageChecks: ["storage"] }, { storage: false });
  const raw = BASE_SCORE + img.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0);
  t("③ 上限20の行に画像の × → min(50＋合計, 20)", img.reasonCodes.includes(EQUIP_CAP_CODE) && img.score === Math.min(Math.max(0, Math.min(130, raw)), 20), [img.score, raw, img.reasonCodes]);
  t("③ drop にはならない", img.verdict === "hold");

  // ④ 同じ回の一般名の別の建物に補わない（名前「物件」・所在地の番地が違う）
  const g = (room: string, addr: string, setsubi: string) => `仲介\n物件 ${room} 号室\n所在地 ${addr}\n所在階 3 階 主要採光⾯ 南向き\n設備\n${setsubi}\n備考\nー`;
  const gb = buildBatchEquipment([
    { key: 1, pdfText: g("301", "大阪府大阪市淀川区西宮原1丁目 7-46", "エレベーター , 宅配 BOX , 都市ガス , 独立洗面台"), label: "【1】" },
    { key: 2, pdfText: g("205", "大阪府大阪市淀川区東三国5丁目 2-17", "都市ガス , 独立洗面台"), label: "【2】" },
  ], { preferences: "エレベーター付き、宅配box付き" });
  t("④ 一般名の別の建物には〔建〕を付けない", gb.rows[1].match.rows.every((r) => r.result === "unlisted" && !r.fromBuilding), gb.rows[1].saved.line);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
