// 申込までの地図の駅ごとの信頼（app/lib/route-station-trust.ts）
// 実行: npx tsx app/lib/__tests__/route-station-trust.test.ts（全 PASS で exit 0）
import { stationKeyOf, stationStatsOf, trustedStationsOf, routeTrustAllows, weakStationsOf, stationGapsToAdd, routeToBriefByTrustOn, stationGapPrefix } from "../route-station-trust";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const rep = (station: string, n: number, map: number, brain: number) => Array.from({ length: n }, (_, i) => ({ station, mapMatch: i < map, brainMatch: i < brain }));

ok("駅の名前は P の地図の葉と同じ", stationKeyOf({ node: "estimate", branch: null }) === "estimate" && stationKeyOf({ node: "viewing_scheduled", branch: "screening_concern" }) === "分:screening_concern" && stationKeyOf(null) === null);
const stats = stationStatsOf([...rep("estimate", 16, 6, 10), ...rep("inquiry", 15, 13, 9), ...rep("viewed", 3, 3, 0)]);
ok("駅ごとの数", stats.find((s) => s.station === "estimate")!.mapRate === 37.5 && stats.find((s) => s.station === "inquiry")!.brain === 9);
const trusted = trustedStationsOf(stats);
ok("地図が上回り n が足りる駅だけ信頼（見積は負け・内覧後は n 不足）", trusted.has("inquiry") && !trusted.has("estimate") && !trusted.has("viewed"));
ok("同点は渡さない", !trustedStationsOf(stationStatsOf(rep("x", 10, 5, 5))).has("x"));
ok("既定 off は今まで通り渡す（印 off）", routeTrustAllows("estimate", trusted, {}).allow && routeTrustAllows("estimate", trusted, {}).mark === "off" && !routeToBriefByTrustOn({}));
const ON = { ROUTE_TO_BRIEF_BY_TRUST: "on" };
ok("on: 信頼の駅は渡す・それ以外は参考の印だけ", routeTrustAllows("inquiry", trusted, ON).mark === "trusted" && !routeTrustAllows("estimate", trusted, ON).allow && routeTrustAllows("estimate", trusted, ON).mark === "reference" && !routeTrustAllows(null, trusted, ON).allow);
// 弱い駅
const prev = stationStatsOf([...rep("inquiry", 15, 14, 9), ...rep("estimate", 12, 6, 6)]);
const weak = weakStationsOf(stats, prev);
ok("下がった駅・負けている駅を出す（n 不足の駅は出さない）", weak.some((w) => w.station === "estimate" && w.reasons.some((r) => r.includes("負けている"))) && weak.some((w) => w.station === "inquiry" && w.reasons.some((r) => r.includes("下がった"))) && !weak.some((w) => w.station === "viewed"), weak);
ok("負けの大きい順", weak[0].station === "estimate");
const adds = stationGapsToAdd(weak, [`${stationGapPrefix("inquiry")} 前に足した行`]);
ok("同じ駅の行が開いていれば足さない・題の頭は駅", adds.length === 1 && adds[0].station === "estimate" && adds[0].title.startsWith(stationGapPrefix("estimate")) && adds[0].owner === "作業員A");

console.log(`route-station-trust: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
