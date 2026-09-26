// app/lib/__tests__/search-override-judge.test.ts
// 2026-09-27 竹内「案Aでおこなう」: AIXツールのメモの上書き（その回だけの一時調整）で検索した回は、判定（点・👑・画像で分析の対象・カード）も
//   その上書きで行う（例 登録が 1K のお客様を 1LDK で検索した回は 1LDK を「合っている」扱い）。上書きした項目だけ・書いていない項目は登録のまま。
//   同じまとめに上書きの回と登録の条件の回が混ざった時は、👑 を一番新しい回の物差しの物件だけから選ぶ。
// 実行: npx tsx app/lib/__tests__/search-override-judge.test.ts（全 PASS で exit 0）
import { overlayCustomerForOverride, buildProfileWithOverride, type OverridableCustomer } from "../search-override-judge";
import { overrideRulerKey, overrideJudgeLine, overrideShortLabel, readPickupSearchOverride, type SearchOverride } from "../search-override";
import { pickupOverrideFromCommand, LINK_MAX_AGE_MS } from "../search-override-link";
import { judgeProperty, parsePropertyFacts, buildCustomerProfile } from "../property-brain";
import { parseAreaWant } from "../area-want";
import { pickCustomerBest, sameRulerCandidates, roundBestId, type BestCandidateRow } from "../pickup-best";
import { rankCompleteGroup } from "../pickup-complete";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) => t(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const EMPTY: SearchOverride = { v: 1, location: null, floor_plan: null, rent_max: null, rent_min: null, walk_minutes: null, building_age: null, area_min: null, area_max: null, pet: null, site: null, is_wide: null };
const ov = (p: Partial<SearchOverride>): SearchOverride => ({ ...EMPTY, ...p });
const OV_1LDK = ov({ floor_plan: "1LDK" });
const OV_TAISHO = ov({ location: { mode: "only", stations: ["大正"], lines: [], areas: [] } });
// 登録: 1K・7.5万・西区と大正区・フォームの希望の行に 1K 1DK（formWantPlans）・自由文に「1DKも可」
const REG: OverridableCustomer = {
  rent_max: 75_000, rent_min: 60_000, floor_plan: "1K", walk_minutes: 10, building_age: null as number | null, desired_area: "大阪市西区・大阪市大正区",
  preferences: "1DKも可。バストイレ別", raw_format_text: "【希望の広さ・間取り】⇒1K 1DK", floor_area_min: null as number | null,
};
const P_1K = "【1】A 101号室\n68,000円\n1K\n徒歩5分\nAD 2ヶ月";
const P_1LDK = "【2】B 201号室\n72,000円\n1LDK\n徒歩5分\nAD 2ヶ月";
const has = (codes: string[], c: string) => codes.includes(c);

console.log("── 条件欄に重ねる（overlayCustomerForOverride・元は変えない）");
{
  const before = JSON.stringify(REG);
  const c = overlayCustomerForOverride(REG, ov({ floor_plan: "1LDK", rent_max: 80_000, walk_minutes: 7, pet: true }));
  eq("上書きした項目だけ変わる", [c.floor_plan, c.layout, c.rent_max, c.max_rent, c.walk_minutes, c.pet], ["1LDK", "1LDK", 80_000, 80_000, 7, true]);
  eq("書いていない項目は登録のまま", [c.desired_area, c.rent_min, c.building_age, c.preferences], [REG.desired_area, 60_000, null, REG.preferences]);
  t("元の条件欄は変えない", JSON.stringify(REG) === before);
  eq("上書きが無い（空）→ 元のまま（同じ物）", overlayCustomerForOverride(REG, EMPTY) === REG, true);
  eq("null → 元のまま", overlayCustomerForOverride(REG, null) === REG, true);
  eq("大正駅だけ → 希望エリアは『大正駅』だけ（駅は「駅」を付ける）", overlayCustomerForOverride(REG, OV_TAISHO).desired_area, "大正駅");
  eq("足す → 登録＋茨木駅", overlayCustomerForOverride(REG, ov({ location: { mode: "add", stations: ["茨木"], lines: [], areas: [] } })).desired_area, "大阪市西区・大阪市大正区・茨木駅");
  eq("路線・区もそのまま", overlayCustomerForOverride(REG, ov({ location: { mode: "only", stations: [], lines: ["御堂筋線"], areas: ["大阪市大正区"] } })).desired_area, "御堂筋線・大阪市大正区");
  eq("家賃の上限を下げて登録の下限が上限以上 → 下限は使わない（入力誤りにしない）", overlayCustomerForOverride(REG, ov({ rent_max: 55_000 })).rent_min, null);
  eq("下限も書いてあればそれ", overlayCustomerForOverride(REG, ov({ rent_max: 55_000, rent_min: 45_000 })).rent_min, 45_000);
  const ca = overlayCustomerForOverride(REG, ov({ area_min: 30, area_max: 45 }));
  eq("面積", [ca.floor_area_min, ca.floor_area_max], [30, 45]);
}

console.log("── エリアの照合が同じ重ねた条件を見る（parseAreaWant）");
{
  const w = parseAreaWant(overlayCustomerForOverride(REG, OV_TAISHO).desired_area);
  eq("大正駅だけ → 駅＝大正・区なし", [w.stations.map((s) => s.station), w.wards], [["大正"], []]);
  const w2 = parseAreaWant(overlayCustomerForOverride(REG, ov({ location: { mode: "only", stations: ["茨木"], lines: [], areas: [] } })).desired_area);
  eq("茨木（駅と市が同じ名前）も駅として読む", [w2.stations.map((s) => s.station), w2.wards], [["茨木"], []]);
}

console.log("── 判定（1K で登録・1LDK で検索した回）");
{
  const reg = buildProfileWithOverride(REG, [], [], null, null);
  const o = buildProfileWithOverride(REG, [], [], null, OV_1LDK);
  t("上書きなし＝buildCustomerProfile と同じ", JSON.stringify(reg.profile.floorPlanWant) === JSON.stringify(buildCustomerProfile(REG).floorPlanWant) && !reg.overridden);
  eq("上書きの本命は 1LDK だけ（フォームの 1K 1DK を足さない）", o.profile.floorPlanWant.plans, ["1LDK"]);
  eq("登録の「1DKも可」も使わない", o.profile.floorPlanAlt, null);
  t("overridden", o.overridden);
  const jReg1LDK = judgeProperty(parsePropertyFacts(P_1LDK), reg.profile, 0);
  const jOv1LDK = judgeProperty(parsePropertyFacts(P_1LDK), o.profile, 0);
  const jOv1K = judgeProperty(parsePropertyFacts(P_1K), o.profile, 0);
  t("登録の条件なら 1LDK は間取りが合う札ではない", !has(jReg1LDK.reasonCodes, "FLOOR_PLAN_MATCH"), jReg1LDK.reasonCodes.join(","));
  t("上書きの回は 1LDK が FLOOR_PLAN_MATCH", has(jOv1LDK.reasonCodes, "FLOOR_PLAN_MATCH"), jOv1LDK.reasonCodes.join(","));
  t("上書きの回は 1LDK の点が上がる", jOv1LDK.score > jReg1LDK.score, `${jReg1LDK.score}→${jOv1LDK.score}`);
  t("上書きの回は 1K が合わない側", !has(jOv1K.reasonCodes, "FLOOR_PLAN_MATCH") && jOv1K.score < jOv1LDK.score, jOv1K.reasonCodes.join(","));
  t("家賃・徒歩（書いていない）は登録のまま＝同じ札", has(jOv1LDK.reasonCodes, "RENT_OK") === has(jReg1LDK.reasonCodes, "RENT_OK"));
  eq("画像の希望（バストイレ別）は登録のまま", o.profile.imageWants, reg.profile.imageWants);
}
{
  const o = buildProfileWithOverride(REG, [], [], null, ov({ rent_max: 70_000 }));
  const j = judgeProperty(parsePropertyFacts(P_1LDK), o.profile, 0);
  eq("家賃の上書き → rentMax", o.profile.rentMax, 70_000);
  t("7.2万は上書きの上限 7万を超える（RENT_OK でない）", !has(j.reasonCodes, "RENT_OK"), j.reasonCodes.join(","));
  eq("登録の下限 6万は上限 7万より小さいので残る", o.profile.rentMin, 60_000);
  const o2 = buildProfileWithOverride(REG, [], [], null, ov({ rent_max: 55_000 }));
  t("上限を下限より下げても入力誤り（RENT_MAX_UNRELIABLE）にしない", o2.profile.rentMax === 55_000 && !o2.profile.notes.includes("RENT_MAX_UNRELIABLE"));
  const o3 = buildProfileWithOverride(REG, [], [], null, ov({ walk_minutes: 5, building_age: 15 }));
  eq("徒歩・築年の列 → walkMax・buildingAgeMax・書いた条件（written）も同じ値", [o3.profile.walkMax, o3.profile.buildingAgeMax, o3.profile.written?.walkColumn, o3.profile.written?.ageColumn], [5, 15, true, true]);
  const o4 = buildProfileWithOverride({ ...REG, floor_plan: "1K 30平米以上" }, [], [], null, OV_1LDK);
  eq("間取りの上書きでも広さの下限は登録のまま", o4.profile.sqmMin, 30);
  const o5 = buildProfileWithOverride(REG, [], [], null, ov({ floor_plan: "1LDK", area_min: 35 }));
  eq("面積も書けばそれ", o5.profile.sqmMin, 35);
}

console.log("── 物差しの鍵・カードの1行");
{
  const a = { command_id: "c1", override: ov({ floor_plan: "1LDK", site: "realnetpro", is_wide: false }) };
  const b = { command_id: "c2", override: ov({ floor_plan: "1LDK", site: "itandi", is_wide: true }) };
  eq("サイト・広げては物差しを変えない（リアプロと itandi で同じ上書き＝同じ物差し）", overrideRulerKey(a) === overrideRulerKey(b), true);
  eq("上書きなし＝空の鍵", [overrideRulerKey(null), overrideRulerKey({}), overrideRulerKey({ override: EMPTY })], ["", "", ""]);
  t("違う上書きは違う鍵", overrideRulerKey(a) !== overrideRulerKey({ command_id: null, override: OV_TAISHO }));
  eq("駅の並びは順不同で同じ鍵", overrideRulerKey({ override: ov({ location: { mode: "only", stations: ["大正", "難波"], lines: [], areas: [] } }) }) === overrideRulerKey({ override: ov({ location: { mode: "only", stations: ["難波", "大正"], lines: [], areas: [] } }) }), true);
  eq("カードの1行", overrideJudgeLine({ command_id: "c1", override: ov({ location: { mode: "only", stations: ["大正"], lines: [], areas: [] }, floor_plan: "1LDK" }) }), "この回はメモの条件（大正駅だけ・1LDK）で判定・書いていない条件は登録のまま");
  eq("上書きなしの回は出さない", overrideJudgeLine(null), "");
  eq("短い説明（家賃・徒歩・築年・面積・ペット）", overrideShortLabel(ov({ rent_max: 80_000, rent_min: 60_000, walk_minutes: 10, building_age: 20, area_min: 25, pet: true })), "家賃6万〜8万・徒歩10分・築20年以内・25㎡以上・ペット相談");
  eq("形の違う行は読まない", [readPickupSearchOverride("x"), readPickupSearchOverride({ override: { v: 2 } }), readPickupSearchOverride([])], [null, null, null]);
}

console.log("── コマンドから結ぶ（pickupOverrideFromCommand）");
{
  const now = Date.parse("2026-09-27T12:00:00Z");
  const cmd = { id: "11111111-2222-3333-4444-555555555555", created_at: "2026-09-27T11:50:00Z", customer_ids: ["pc1"], payload: { source: "web_brain", search_override: OV_1LDK } };
  eq("web_brain・同じお客様・新しい → 上書き", pickupOverrideFromCommand(cmd, "pc1", now)?.override.floor_plan, "1LDK");
  eq("コマンドの id を残す", pickupOverrideFromCommand(cmd, "pc1", now)?.command_id, cmd.id);
  eq("別のお客様 → 結ばない", pickupOverrideFromCommand(cmd, "pc2", now), null);
  eq("web_brain でない → 結ばない", pickupOverrideFromCommand({ ...cmd, payload: { source: "aix", search_override: OV_1LDK } }, "pc1", now), null);
  eq("古いコマンド → 結ばない", pickupOverrideFromCommand({ ...cmd, created_at: new Date(now - LINK_MAX_AGE_MS - 1000).toISOString() }, "pc1", now), null);
  eq("上書きが空 → 結ばない", pickupOverrideFromCommand({ ...cmd, payload: { source: "web_brain", search_override: EMPTY } }, "pc1", now), null);
  eq("知らない駅は関所で落ちる（上書きが空になれば結ばない）", pickupOverrideFromCommand({ ...cmd, payload: { source: "web_brain", search_override: ov({ location: { mode: "only", stations: ["ほげほげ"], lines: [], areas: [] } }) } }, "pc1", now), null);
  eq("お客様が分からない → 結ばない", pickupOverrideFromCommand(cmd, null, now), null);
}

console.log("── 👑: 上書きの回と登録の条件の回が混ざった時");
{
  const SO = { command_id: "c1", override: OV_1LDK };
  const row = (id: number, at: string, score: number, so: unknown, verdict = "pass"): BestCandidateRow => ({ id, batch_id: `b${at}`, created_at: at, rank: id, status: "pending", recommended: 0, property_name: `P${id}`, verdict, score, image_analysis: null, search_override: so });
  // 先に登録の条件（1K）で検索 → 後で 1LDK の上書きで検索。登録の回に 150点の 1K がある
  const regRows = [row(1, "2026-09-27T10:00:00Z", 150, null), row(2, "2026-09-27T10:00:00Z", 120, null)];
  const ovRows = [row(3, "2026-09-27T10:05:00Z", 110, SO), row(4, "2026-09-27T10:05:00Z", 130, SO)];
  eq("混ざる → 新しい回（上書き）の物差しの中の一番（130点）。登録の回の 150点とは比べない", pickCustomerBest([...regRows, ...ovRows], { basis: "score", windowHours: 49 })?.id, 4);
  eq("逆の順（上書きの後に登録の条件で検索）→ 登録の回の中の一番", pickCustomerBest([row(1, "2026-09-27T10:10:00Z", 150, null), row(3, "2026-09-27T10:05:00Z", 160, SO)], { basis: "score", windowHours: 49 })?.id, 1);
  eq("物差しが1つ（ふつう）→ 今まで通り点の一番", pickCustomerBest(regRows, { basis: "score" })?.id, 1);
  eq("上書きだけの回 → その中の一番", pickCustomerBest(ovRows, { basis: "score" })?.id, 4);
  eq("新しい物差しの物件が全部外す候補 → 点のある物差し（登録の回）から", pickCustomerBest([...regRows, row(5, "2026-09-27T10:05:00Z", 180, SO, "drop")], { basis: "score", windowHours: 49 })?.id, 1);
  eq("同じ上書きをリアプロと itandi で（サイト違い）→ 同じ物差しで比べる", pickCustomerBest([row(6, "2026-09-27T10:05:00Z", 100, { command_id: "a", override: { ...OV_1LDK, site: "realnetpro" } }), row(7, "2026-09-27T10:06:00Z", 140, { command_id: "b", override: { ...OV_1LDK, site: "itandi" } })], { basis: "score" })?.id, 7);
  eq("sameRulerCandidates: 物差しが1つなら全部", sameRulerCandidates(regRows, () => true).length, 2);
  eq("回の 👑（画面の roundBestId）も同じ決まり", roundBestId([...regRows, ...ovRows], "score", null), 4);
  const rk = rankCompleteGroup([...regRows, ...ovRows], { basis: "score" });
  eq("まとめ: 👑 は上書きの回の一番", rk.bestId, 4);
  eq("まとめの順位: 👑 → 同じ物差し → 別の物差し（点の物差しを交ぜない）", rk.order.map((o) => o.id), [4, 3, 1, 2]);
  const rk2 = rankCompleteGroup(regRows, { basis: "score" });
  eq("物差しが1つのまとめは今まで通り", rk2.order.map((o) => o.id), [1, 2]);
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
