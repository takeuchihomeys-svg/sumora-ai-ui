// app/lib/__tests__/proposal-range.test.ts — このお客様に広げて提案してよい範囲（純関数）
// 実行: npx tsx app/lib/__tests__/proposal-range.test.ts
// 2026-10-13 竹内「お客さんに広げて提案できるところの範囲」。線は scripts/audit-proposal-range.ts（実送信 120日）
import { decideProposalRange, brainRecentOfDigest, proposalRangeCodes, wideSqmMargin, netExtrasFor, proposalRangeLine, DEFAULT_PROPOSAL_RANGE } from "../proposal-range";
import { proposalMaterialsOf } from "../proposal-range-server";
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, isFewerRoomWideLdk, normalizeFloorPlanWant, HOLD_REASON_CODES, REASON_POINTS, reasonJa } from "../property-brain";
import { parseAreaWant } from "../area-want";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info === undefined ? "" : JSON.stringify(info)); } };
const S = (rent: string, plan: string, extra = "") => `【1】テスト\n${rent}\n${plan}\n${extra}`;

const R = (state: string | null, gap: string | null = null, solve: string | null = null) => ({ state, gapPoint: gap, gapSolve: solve });
console.log("■ 段: 保留は残り続ける記録だけ・加点は続いている判断と記録");
{
  t("材料なし → standard・理由なし・画面の1行なし", decideProposalRange({}).level === "standard" && proposalRangeLine(decideProposalRange({})) == null);
  t("エリアは必ず（requirement_strength）→ tight", decideProposalRange({ areaStrength: "must" }).level === "tight");
  // 重要1: 決め手の条件の「駅近」（closer）・決め手の残りの「立地・駅」は徒歩の話＝場所の段にしない
  t("決め手の条件が駅近（closer）→ tight にしない", decideProposalRange({ closingKinds: ["closer"] }).level === "standard");
  t("ブレインの決め手の残りが立地・駅が続いても tight にしない", decideProposalRange({ brainRecent: [R("迷い", "立地・駅", "c"), R("迷い", "立地・駅", "c"), R("迷い", "立地・駅", "c")] }).level === "standard");
  // 重要2: 1通だけのブレインの判断では段を変えない（次の「ありがとう」で消える判断に保留・加点を付けない）
  t("ブレイン: 急いでいるが1回だけ → standard", decideProposalRange({ brainRecent: [R("急いでいる"), R("普通の依頼")] }).level === "standard");
  t("ブレイン: 急いでいるが直近で2回 → broad", decideProposalRange({ brainRecent: [R("普通の依頼"), R("急いでいる"), R("急いでいる")] }).level === "broad");
  t("ブレイン: 安くしたいが続いても家賃の保留は付けない（rentOver のまま）", (() => { const r = decideProposalRange({ brainRecent: [R("安くしたい", "家賃", "c"), R("安くしたい", "家賃", "c")] }); return r.level === "broad" && r.rentOver; })());
  t("決め手の残りが初期費用でも見積で解く（b）なら broad にしない", decideProposalRange({ brainRecent: [R("迷い", "初期費用", "b"), R("迷い", "初期費用", "b")] }).level === "standard");
  t("決め手の条件（家賃を下げる）→ broad（加点だけ）・家賃の保留は付けない", (() => { const r = decideProposalRange({ closingKinds: ["rent_lower"] }); return r.level === "broad" && r.rentOver; })());
  t("家賃が必ず（requirement_strength）→ 家賃の上限は超えない", !decideProposalRange({ rentStrength: "must" }).rentOver);
  t("エリアはできれば → broad", decideProposalRange({ areaStrength: "nice" }).level === "broad");
  const both = decideProposalRange({ areaStrength: "must", brainRecent: [R("急いでいる"), R("急いでいる")] });
  t("tight と broad の両方 → tight（場所を守る）・理由に両方", both.level === "tight" && both.reasons.some((r) => /場所を守る/.test(r)), both.reasons);
  t("気に入った部屋の駅が希望の外 → broad", decideProposalRange({ favoriteStations: ["園田"] }, { wantStations: ["十三"] }).level === "broad");
  t("気に入った部屋の「駅」が駅の表に無い語（付近のコンビニ）→ standard", decideProposalRange({ favoriteStations: ["付近のコンビニ"] }, { wantStations: ["十三"] }).level === "standard");
  t("気に入った部屋の駅が希望の駅 → standard", decideProposalRange({ favoriteStations: ["十三"] }, { wantStations: ["十三"] }).level === "standard");
  t("築年・広さは今は広げてよいのまま（残り続ける記録が無い）", decideProposalRange({ closingKinds: ["newer", "wider"] }).ageWide && decideProposalRange({ closingKinds: ["wider"] }).sizeWide);
}

console.log("■ 材料（要望の強さ・決め手の条件・brain_decision_logs の digest.ms）");
{
  t("digest.ms を読む", JSON.stringify(brainRecentOfDigest("安くしたい||費用で迷う|家賃:c")) === JSON.stringify({ state: "安くしたい", gapPoint: "家賃", gapSolve: "c" }));
  t("digest.ms が無い → null", brainRecentOfDigest(null) == null && brainRecentOfDigest("") == null);
  const m = proposalMaterialsOf(JSON.stringify({ area: { strength: "nice" }, rent_max: { strength: "must" } }), null, [{ ms: "急いでいる|||" }, { ms: null }, { ms: "急いでいる|||" }]);
  t("エリア・家賃の強さとブレインの直近の判断を読む", m.areaStrength === "nice" && m.rentStrength === "must" && m.brainRecent?.length === 2, m);
  t("材料なしでも投げない", proposalMaterialsOf(null, null).areaStrength === null);
  t("最新の1通の判断（suggested_aix_meta）は材料の型に無い", !("brainState" in proposalMaterialsOf(null, null)));
}

console.log("■ 判定の札");
{
  const tight = decideProposalRange({ areaStrength: "must" });
  const broad = decideProposalRange({ areaStrength: "nice" });
  t("tight: 隣の区・4km → 保留の札", proposalRangeCodes(tight, ["AREA_CLOSE"]).includes("PROPOSAL_AREA_OUT") && HOLD_REASON_CODES.has("PROPOSAL_AREA_OUT"));
  t("tight: 絶対のエリアの外（AREA_MUST_NG）が付いた物には足さない（二重に下げない）", proposalRangeCodes(tight, ["AREA_FAR", "AREA_MUST_NG"]).length === 0);
  t("tight: 2駅・2km → 情報の減点", proposalRangeCodes(tight, ["AREA_NEAR"]).includes("PROPOSAL_AREA_EDGE") && !HOLD_REASON_CODES.has("PROPOSAL_AREA_EDGE"));
  t("broad: 遠い物件の −3 を戻す（+3）", proposalRangeCodes(broad, ["AREA_FAR"]).includes("PROPOSAL_AREA_WIDE_OK") && REASON_POINTS.AREA_FAR + REASON_POINTS.PROPOSAL_AREA_WIDE_OK === 0);
  t("standard: 何も足さない（今までの点）", proposalRangeCodes(DEFAULT_PROPOSAL_RANGE, ["AREA_FAR", "RENT_WIDE", "BUILDING_AGE_WIDE"]).length === 0);
  const rentTight = decideProposalRange({ rentStrength: "must" });
  t("家賃が必ず: 上限超え（RENT_WIDE）→ 保留の札", proposalRangeCodes(rentTight, ["RENT_WIDE"]).includes("PROPOSAL_RENT_OUT"));
  t("範囲 null → 何も足さない", proposalRangeCodes(null, ["AREA_FAR"]).length === 0);
  t("札の日本語がある", /提案/.test(reasonJa("PROPOSAL_AREA_OUT")) && /広い LDK/.test(reasonJa("FLOOR_PLAN_FEWER_ROOM_WIDE")));
}

console.log("■ 判定（judgeProperty）に通す");
{
  const p = buildCustomerProfile({ rent_max: 80_000 });
  const j = (opts: Parameters<typeof judgeProperty>[3]) => judgeProperty(parsePropertyFacts(S("80,000円", "1K")), p, 0, opts);
  const tightJ = j({ locationCodes: ["AREA_CLOSE"], proposalRange: decideProposalRange({ areaStrength: "must" }) });
  t("tight の隣の区は保留", tightJ.verdict === "hold" && tightJ.flagCodes.includes("PROPOSAL_AREA_OUT"), tightJ.flagCodes);
  const noneJ = j({ locationCodes: ["AREA_CLOSE"] });
  t("範囲を渡さなければ今まで通り（隣の区は +2 で通す）", noneJ.verdict === "pass" && !noneJ.reasonCodes.some((c) => c.startsWith("PROPOSAL_")));
  const broadJ = j({ locationCodes: ["AREA_FAR"], proposalRange: decideProposalRange({ areaStrength: "nice" }) });
  t("broad の遠い物件は −3 を戻した点", broadJ.score === noneJ.score - REASON_POINTS.AREA_CLOSE + REASON_POINTS.AREA_FAR + 3 || broadJ.reasonCodes.includes("PROPOSAL_AREA_WIDE_OK"), [broadJ.score, noneJ.score]);
  const rentJ = judgeProperty(parsePropertyFacts(S("75,000円 10,000円", "1K")), p, 0, { proposalRange: decideProposalRange({ rentStrength: "must" }) });
  t("家賃が必ずの人の上限超え（RENT_WIDE）は保留", rentJ.verdict === "hold" && rentJ.flagCodes.includes("PROPOSAL_RENT_OUT"), rentJ.flagCodes);
}

console.log("■ 広さ: 30㎡以上の希望は −10㎡まで（実送信 −5〜−10㎡ 32部屋 刺さり 19%＝希望以上 17%）");
{
  t("幅: 30㎡以上 10・未満 5・広さが決め手 5", wideSqmMargin(40) === 10 && wideSqmMargin(30) === 10 && wideSqmMargin(25) === 5 && wideSqmMargin(40, false) === 5);
  const q = buildCustomerProfile({ rent_max: 100_000, floor_area_min: 40 });
  const a = (sqm: number, opts = {}) => judgeProperty(parsePropertyFacts(S("90,000円", `1LDK ${sqm}㎡`)), q, 0, opts);
  t("40㎡の希望: 32㎡ → SQM_WIDE（通す側）", a(32).reasonCodes.includes("SQM_WIDE") && !a(32).flagCodes.includes("SQM_UNDER"), a(32).reasonCodes);
  t("40㎡の希望: 29㎡ → 保留（−10㎡超）", a(29).flagCodes.includes("SQM_UNDER"));
  t("広さが決め手のお客様: 32㎡ → 保留（今までの −5㎡）", a(32, { proposalRange: { ...DEFAULT_PROPOSAL_RANGE, sizeWide: false } }).flagCodes.includes("SQM_UNDER"));
  const q2 = buildCustomerProfile({ rent_max: 100_000, floor_area_min: 25 });
  t("25㎡の希望: 19㎡ は今まで通り保留（30㎡未満は −5㎡）", judgeProperty(parsePropertyFacts(S("80,000円", "1K 19㎡")), q2).flagCodes.includes("SQM_UNDER"));
}

console.log("■ 間取り: 2LDK 希望の 30㎡以上の 1LDK は保留にしない（実送信 39部屋 刺さり 33%）");
{
  const w = normalizeFloorPlanWant("2LDK");
  t("2LDK 希望・1LDK 32㎡ → 広い1LDK", isFewerRoomWideLdk(w, "1LDK", 32, null));
  t("2LDK 希望・1LDK 28㎡ → 当てない", !isFewerRoomWideLdk(w, "1LDK", 28, null));
  t("2LDK 希望・1LDK 面積が読めない → 当てない", !isFewerRoomWideLdk(w, "1LDK", null, null));
  t("広さの希望 45㎡ の人は 1LDK 40㎡ を当てない", !isFewerRoomWideLdk(w, "1LDK", 40, 45));
  t("2LDK以上 の希望も当てる", isFewerRoomWideLdk(normalizeFloorPlanWant("2LDK以上"), "1LDK", 35, null));
  t("3LDK 希望の 2LDK は当てない（実送信が少ない）", !isFewerRoomWideLdk(normalizeFloorPlanWant("3LDK"), "2LDK", 60, null));
  t("1LDK 希望の 1K は当てない", !isFewerRoomWideLdk(normalizeFloorPlanWant("1LDK"), "1K", 35, null));
  const p = buildCustomerProfile({ rent_max: 140_000, floor_plan: "2LDK" });
  const jj = judgeProperty(parsePropertyFacts(S("120,000円", "1LDK 36.43㎡")), p);
  t("判定: 2LDK 希望の 1LDK 36㎡ → FLOOR_PLAN_FEWER_ROOM_WIDE・保留にしない", jj.reasonCodes.includes("FLOOR_PLAN_FEWER_ROOM_WIDE") && !jj.flagCodes.includes("FLOOR_PLAN_MISMATCH"), jj.reasonCodes);
  const jk = judgeProperty(parsePropertyFacts(S("120,000円", "1LDK 36.43㎡")), p, 0, { proposalRange: { ...DEFAULT_PROPOSAL_RANGE, sizeWide: false } });
  t("広さが決め手のお客様は今まで通り保留", jk.flagCodes.includes("FLOOR_PLAN_MISMATCH"), jk.flagCodes);
}

console.log("■ 案（未接続）: 検索の網の駅");
{
  const ex = netExtrasFor(parseAreaWant("十三", null), "standard");
  t("十三・standard: 2駅（園田）や 2km の駅を足す・十三そのものは足さない", ex.stations.length > 0 && !ex.stations.includes("十三"), ex.stations.slice(0, 8));
  t("tight は何も足さない", netExtrasFor(parseAreaWant("十三", null), "tight").stations.length === 0);
  const wd = netExtrasFor(parseAreaWant("大阪市浪速区", null), "standard");
  t("区の希望・standard: 隣の区を足す（4つまで）", wd.wards.length > 0 && wd.wards.length <= 4, wd.wards);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
