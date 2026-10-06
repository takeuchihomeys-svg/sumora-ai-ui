// 2026-10-06e 竹内さんの答え（2軸の監査の質問）のテスト
//   1「あっている」: 保留の理由が初期費用だけ（INITIAL_COST_NOT_ZERO）で AD が線（2）以上の行は🌟（👑）の候補に入れる
//   2「だいじょうぶ」: AD が書かれていない部屋は同じ建物の別の部屋の AD でみなす（building-ad-assume.ts）
// 実行: npx tsx app/lib/__tests__/star-soft-hold-building-ad.test.ts
// 行の形は本番の property_pickups（#2293 エスリード弁天町桜通レジデンス 706・ディアコート曽根 302 の札の形）。お客様の情報は無い
import { pickCustomerBest, bestRuleTag, type BestCandidateRow } from "../pickup-best";
import { STAR_FIT_RULE_TAG } from "../recommend-star-rank";
import { initialCostOnlyHold, starOpenRow, SOFT_HOLD_AD_LINE, SOFT_HOLD_STAR_REASON } from "../star-rank-pickup";
import { sameBuildingAdOf, buildingAdSummaryLine, buildingAdKey, agentLicenseOf, licenseNosOf, isBuildingAdAssumedBy, buildingAdReasonJa, adMonthsOfFacts, buildingAdSourceOfPickupRow, BUILDING_AD_NAME, BUILDING_AD_RULE } from "../building-ad-assume";
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, reasonPoints, reasonJa } from "../property-brain";
import { assumedAdAgentInLine } from "../agent-ad-assume";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ""}`); }
}
const AT = "2026-10-04T03:00:00Z";
type Opt = { score: number; codes: string[]; verdict?: string; sqm?: number; age?: number; st?: string; dep?: number; key?: number };
const row = (id: number, o: Opt): BestCandidateRow => ({
  id, batch_id: "B1", created_at: AT, rank: id, status: "pending", recommended: 0, property_name: `物件${id}`, room_no: `${id}01`,
  verdict: o.verdict ?? "pass", score: o.score, reason_codes: o.codes,
  summary_text: `【${id}】物件${id} ${id}01号室\n70,000円 5,000円\n1LDK${o.sqm != null ? ` ${o.sqm}㎡` : ""}\n阪急宝塚本線「曽根」徒歩5分`,
  ad_yen: null,
  terms: { buildingAge: o.age ?? null, deposit: o.dep ?? 0, keyMoney: o.key ?? 0, evidence: {} },
  equipment: { facts: o.st ? { structure: { s: "ok", d: o.st } } : {}, match: [] },
});

console.log("■ 1. 保留の理由が初期費用だけ（INITIAL_COST_NOT_ZERO）");
{
  // ディアコート曽根 302 の札の形（初期費用だけの保留・AD2 は保留なので _HELD）
  const soft = { verdict: "hold", score: 99, reason_codes: ["RENT_OK", "INITIAL_COST_NOT_ZERO", "FLOOR_PLAN_MATCH", "AD_HIGH_HELD", "BUILDING_AGE_OK"] };
  t("初期費用だけの保留 → true", initialCostOnlyHold(soft));
  // #2293 エスリード弁天町桜通レジデンス 706: 初期費用＋定期借家（CONTRACT_FIXED）＝他の保留もある
  t("定期借家（CONTRACT_FIXED）もある → false（他の保留は今まで通り候補にしない）", !initialCostOnlyHold({ ...soft, reason_codes: [...soft.reason_codes, "CONTRACT_FIXED"] }));
  t("設備の ×（EQUIP_*_NG）もある → false", !initialCostOnlyHold({ ...soft, reason_codes: [...soft.reason_codes, "EQUIP_AUTOLOCK_NG"] }));
  t("家賃超え（RENT_OVER_110）もある → false", !initialCostOnlyHold({ ...soft, reason_codes: [...soft.reason_codes, "RENT_OVER_110"] }));
  t("点が低すぎる（初期費用の減点を戻しても 40点未満）→ false", !initialCostOnlyHold({ ...soft, score: 20 }));
  t("通す行・外す候補は対象外（false）", !initialCostOnlyHold({ ...soft, verdict: "pass" }) && !initialCostOnlyHold({ ...soft, verdict: "drop" }));
  t("線は 2（データで選んだ・audit-star-soft-hold.ts: 1.5 と 2 は🌟の一致が同じ・誤って入る行は 2 の方が少ない 13 対 23）", SOFT_HOLD_AD_LINE === 2);
  t("AD2 の初期費用だけの保留 → 候補", starOpenRow(soft));
  t("AD1.5 の初期費用だけの保留 → 候補にしない（線の下）", !starOpenRow({ ...soft, reason_codes: ["INITIAL_COST_NOT_ZERO", "AD_1_5M_HELD"] }));
  t("AD 不明の初期費用だけの保留 → 候補にしない", !starOpenRow({ ...soft, reason_codes: ["INITIAL_COST_NOT_ZERO", "AD_UNKNOWN"] }));
  t("線 null（06d の決め方）→ 保留は入れない", !starOpenRow(soft, null));
  t("通す行は線に関わらず候補", starOpenRow({ verdict: "pass", reason_codes: [], score: 100 }, null));
}

console.log("■ 1. 👑（pickCustomerBest）");
{
  // 1LDK以上の希望＋初期費用の希望。通すは AD1.5・古い／保留（初期費用だけ）は AD2・広い・新しい・RC（10/04 ディアコート曽根の回の形）
  const pass1 = row(1, { score: 120, codes: ["RENT_OK", "ZERO_ZERO_MATCH", "FLOOR_PLAN_MATCH", "AD_1_5M"], sqm: 30, age: 28, st: "鉄骨" });
  const soft2 = row(2, { score: 99, codes: ["RENT_OK", "INITIAL_COST_NOT_ZERO", "FLOOR_PLAN_MATCH", "AD_HIGH_HELD"], verdict: "hold", sqm: 40, age: 3, st: "RC", key: 1 });
  const other3 = row(3, { score: 120, codes: ["RENT_OK", "INITIAL_COST_NOT_ZERO", "CONTRACT_FIXED", "FLOOR_PLAN_MATCH", "AD_VERY_HIGH_HELD"], verdict: "hold", sqm: 45, age: 1, st: "RC", key: 1 });
  const sit = { zero: true, spacious: false, newBuild: false, stationNear: false, floorHigh: false, moveInUrgent: false, equipKeys: [], household: true };
  const rows = [pass1, soft2, other3];
  const e = pickCustomerBest(rows, { basis: "score", situation: sit });
  const d = pickCustomerBest(rows, { basis: "score", situation: sit, softHoldAdLine: null });
  t("06e: 初期費用だけの保留・AD2 で合い方が上 → 👑", e?.id === 2, e);
  t("06e: 理由に「敷礼ありだが AD が高い」", (e?.star_reasons ?? []).includes(SOFT_HOLD_STAR_REASON), e?.star_reasons);
  t("06e: 他の保留（定期借家）は AD3 で広くても候補にしない", e?.id !== 3);
  t("06d（線 null）: 通すがあるので保留は候補にしない → 通すの 1", d?.id === 1, d);
  t("決まりの版は 06e 以降", STAR_FIT_RULE_TAG >= "star-fit@2026-10-06e" && e?.rule === STAR_FIT_RULE_TAG && bestRuleTag("score") === STAR_FIT_RULE_TAG);
  // 線の下（AD1.5）の初期費用だけの保留は入れない
  const soft15 = { ...soft2, reason_codes: ["RENT_OK", "INITIAL_COST_NOT_ZERO", "FLOOR_PLAN_MATCH", "AD_1_5M_HELD"] };
  t("AD1.5 の初期費用だけの保留は 👑 にしない（線 2）", pickCustomerBest([pass1, soft15, other3], { basis: "score", situation: sit })?.id === 1);
  // 通すが無い時: 初期費用だけの保留（AD2）が候補になり、他の保留より先
  const onlyHolds = pickCustomerBest([soft2, other3], { basis: "score", situation: sit });
  t("通すが無い時は初期費用だけの保留（AD2）だけで決める（他の保留は外れる）", onlyHolds?.id === 2, onlyHolds);
  t("legacy（STAR_RANK_MODE=off）は今まで通り（合計の1位）", pickCustomerBest(rows, { basis: "score", starMode: "legacy" })?.id === 1);
}

console.log("■ 2. 同じ建物の別の部屋の AD でみなす");
{
  const at = "2026-09-30T03:00:00Z";
  const src = (room: string, ad: number | null, o: Partial<{ name: string; agent: string | null; at: string; assumed: boolean }> = {}) => ({ name: o.name ?? "S-RESIDENCE日本橋Qualier", room, adMonths: ad, agent: o.agent ?? "大臣7032", at: o.at ?? at, assumed: o.assumed ?? false });
  const tgt = { name: "S-RESIDENCE日本橋Qualier", room: "1506", agent: "大臣7032", at };
  // 実物（2026-09-30 S-RESIDENCE日本橋Qualier 1506・AD 不明）: 同じ建物の 1403=AD2・1101=AD1 → 低い方の 1
  const a = sameBuildingAdOf(tgt, [src("1403", 2), src("1101", 1)]);
  t("部屋ごとに違う（1〜2）→ 低い方（1）・元の部屋を残す", a?.adMonths === 1 && a?.min === 1 && a?.max === 2 && a?.from.length === 2, a);
  t("同じ号室の行は使わない（同じ資料なら同じく AD が無い）", sameBuildingAdOf(tgt, [src("1506", 2)]) === null);
  t("元付（免許番号）が違う行は使わない", sameBuildingAdOf(tgt, [src("1403", 2, { agent: "大臣10826" })]) === null);
  t("元付が読めない行は使う（比べない）", sameBuildingAdOf(tgt, [src("1403", 2, { agent: null })])?.adMonths === 2);
  t("みなしの行（アズ・スタット・同じ建物）は元にしない", sameBuildingAdOf(tgt, [src("1403", 2, { assumed: true })]) === null);
  t("30日より前の行は使わない", sameBuildingAdOf(tgt, [src("1403", 2, { at: "2026-08-20T00:00:00Z" })]) === null);
  t("一番低い値が AD1 未満（AD なし・0.5）なら補わない（不明のまま）", sameBuildingAdOf(tgt, [src("1403", 2), src("1101", 0.5)]) === null && sameBuildingAdOf(tgt, [src("1403", 0)]) === null);
  t("別の建物は使わない", sameBuildingAdOf(tgt, [src("1403", 2, { name: "S-RESIDENCE難波Briller" })]) === null);
  t("濁点だけ違う名前は同じ建物（カーサピエント／カーサビエント）", buildingAdKey("カーサピエント") === buildingAdKey("カーサビエント")
    && sameBuildingAdOf({ ...tgt, name: "カーサピエント" }, [src("203", 1.5, { name: "カーサビエント" })])?.adMonths === 1.5);
  t("一般名（物件）は比べない", buildingAdKey("物件") === "" && sameBuildingAdOf({ ...tgt, name: "物件" }, [src("203", 2, { name: "物件" })]) === null);
  t("同じ部屋の何回分もの行は一番新しい値（1部屋として数える）", sameBuildingAdOf(tgt, [src("1403", 1.5, { at: "2026-09-25T00:00:00Z" }), src("1403", 2, { at: "2026-09-29T00:00:00Z" })])?.from.length === 1);
  t("決まり: 30日・一番低い・元付を見る・AD1未満は補わない", BUILDING_AD_RULE.maxDays === 30 && BUILDING_AD_RULE.pick === "min" && BUILDING_AD_RULE.requireSameAgent && BUILDING_AD_RULE.minAd === 1);

  // 元付の見分け（資料の文字層の実物の形: 1ページ目＝弊社帯・2ページ目＝元付）
  const pdf = "蓮産業株式会社\n⼤阪府知事免許 (01) 第 064549 号\n…\n株式会社 RENOSY ASSET MANAGEMENT ⼤阪⽀社\n国⼟交通⼤⾂免許 (02) 第 009817 号\n取引態様 代理\n広告費 100 ％";
  t("免許番号を読む（弊社帯→元付の順・頭の0を外す）", JSON.stringify(licenseNosOf(pdf)) === JSON.stringify(["知事64549", "大臣9817"]), licenseNosOf(pdf));
  t("元付は弊社帯を除いた免許番号", agentLicenseOf(pdf) === "大臣9817" && agentLicenseOf("⼤阪府知事免許 (01) 第 064549 号") === null);
  t("元付のページだけの文字なら最初の免許", agentLicenseOf("国土交通大臣免許(2)第8096号", { agentPagesOnly: true }) === "大臣8096");

  // 判定（説明文の行・札）
  const line = buildingAdSummaryLine({ adMonths: 1.5 });
  t("行「AD 1.5ヶ月（同じ建物の別の部屋・記載なしのため150%とみなす）」", line === "AD 1.5ヶ月（同じ建物の別の部屋・記載なしのため150%とみなす）" && assumedAdAgentInLine(line) === BUILDING_AD_NAME && isBuildingAdAssumedBy(BUILDING_AD_NAME));
  const p = buildCustomerProfile({ rent_max: 90_000, floor_plan: "1K" });
  const SUM = "【3】S-RESIDENCE日本橋Qualier 1506号室\n78,000円 8,000円\n1K 25.2㎡\n御堂筋線「なんば」徒歩6分";
  const f = parsePropertyFacts(`${SUM}\n${line}`);
  const j = judgeProperty(f, p);
  t("読み: 1.5ヶ月・みなしの名前", f.adMonths === 1.5 && f.adAssumedBy === BUILDING_AD_NAME, f);
  t("札は AD_ASSUMED_BUILDING（アズ・スタットの AD_ASSUMED_AGENT ではない）＋段 AD_1_5M", j.reasonCodes.includes("AD_ASSUMED_BUILDING") && !j.reasonCodes.includes("AD_ASSUMED_AGENT") && j.reasonCodes.includes("AD_1_5M"), j.reasonCodes);
  t("印は 0点・日本語で分かる", reasonPoints("AD_ASSUMED_BUILDING") === 0 && /同じ建物の別の部屋/.test(reasonJa("AD_ASSUMED_BUILDING")) && j.reasonsJa.some((x) => /同じ建物の別の部屋/.test(x)), j.reasonsJa);
  // 本番の配線（property-pickups-server）は facts を直に書き換える
  const f2 = parsePropertyFacts(SUM); f2.adMonths = 2; f2.adAssumedBy = BUILDING_AD_NAME;
  t("facts を直に書き換えても同じ札", judgeProperty(f2, p).reasonCodes.includes("AD_ASSUMED_BUILDING"));
  t("理由の一文（低い方を使った事が分かる）", buildingAdReasonJa(a!) === "AD 100%とみなした（同じ建物の別の部屋 1403・1101・資料に記載なし・部屋ごとに 1〜2ヶ月の低い方）", buildingAdReasonJa(a!));
  t("facts の AD（月数・無ければ円÷家賃）", adMonthsOfFacts({ adMonths: 2 }) === 2 && adMonthsOfFacts({ adYen: 120000, rentYen: 80000 }) === 1.5 && adMonthsOfFacts({}) === null);
  t("売上サポの行 → 元（みなしの札の行は assumed）", buildingAdSourceOfPickupRow({ property_name: "A", room_no: "101", reason_codes: ["AD_ASSUMED_AGENT", "AD_HIGH"] }).assumed === true
    && buildingAdSourceOfPickupRow({ property_name: "A", room_no: "101", reason_codes: ["AD_1_5M"] }).adMonths === 1.5);
}

console.log(`\n${passed} OK / ${failed} NG`);
if (failed) process.exit(1);
