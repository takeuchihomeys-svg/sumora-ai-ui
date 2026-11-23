// 申込までの地図の駅ごとの一致と進み（app/lib/route-station-trust.ts）
// 実行: npx tsx app/lib/__tests__/route-station-trust.test.ts（全 PASS で exit 0）
import { stationKeyOf, stationStatsOf, stationMetricRowsOf, weakStationsOf, stationGapsToAdd, stationGapPrefix, type RouteStationRow } from "../route-station-trust";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const R = (o: Partial<RouteStationRow>): RouteStationRow => ({ node: "estimate", branch: null, agree: "push_missed", outcome: "stuck", after: "estimate", ...o });
const rep = (n: number, o: Partial<RouteStationRow>) => Array.from({ length: n }, () => R(o));

ok("駅の名前は P の地図の葉と同じ", stationKeyOf({ node: "estimate", branch: null }) === "estimate" && stationKeyOf({ node: "viewing_scheduled", branch: "screening_concern" }) === "分:screening_concern" && stationKeyOf(null) === null);
const rows = [
  ...rep(3, { outcome: "advanced", agree: "aix_match" }), ...rep(4, { outcome: "engaged" }), ...rep(3, { outcome: "stuck" }), ...rep(3, { outcome: "back" }), ...rep(3, { outcome: "left" }),
  ...rep(6, { node: "proposing", branch: "screening_concern", outcome: "stuck", after: "estimate", afterBranch: null }), ...rep(2, { node: "proposing", branch: "screening_concern", outcome: "stuck", after: null }), ...rep(4, { node: "proposing", branch: "screening_concern", outcome: "left", after: null }),
];
const st = stationStatsOf(rows);
const est = st.find((s) => s.station === "estimate")!;
ok("見積: n16・進み 3（19%）・一致 3", est.n === 16 && est.progress === 3 && est.progressRate === 18.8 && est.map === 3 && est.stuck === 3 && est.left === 3, est);
const scr = st.find((s) => s.station === "分:screening_concern")!;
ok("分かれ道から本線の駅に戻った番は進みに数える（進んだと重ねない）", scr.branch_return === 6 && scr.progress === 6 && scr.stuck === 2 && scr.left === 4, scr);
const mr = stationMetricRowsOf(st);
ok("後の分かれ道の欄が無い番は本線に戻ったと数えない", stationStatsOf(rep(3, { node: "proposing", branch: "x", outcome: "stuck", after: "estimate" }))[0].branch_return === 0);
{
  const v = stationStatsOf([
    R({ node: "viewing_scheduled", outcome: "stuck", at: "2026-10-20T04:18:00Z", detail: "10/28(水)17:00" }), // 内覧の日待ち
    R({ node: "viewing_scheduled", outcome: "stuck", at: "2026-10-29T04:18:00Z", detail: "10/28(水)17:00" }), // 日が過ぎても動かない
    R({ node: "viewing_scheduled", outcome: "stuck", at: "2026-10-20T04:18:00Z", detail: null }), // 日が読めない
  ])[0];
  ok("内覧予定: 内覧の日がまだの止まりは続くに・過ぎた番と読めない番は止まり", v.engaged === 1 && v.stuck === 2, v);
}
ok("毎朝の1枚の名前", mr.some((r) => r.metric === "route:station:estimate:progress" && r.value === 18.8 && r.n === 16) && mr.some((r) => r.metric === "route:station:分:screening_concern:map"));
const weak = weakStationsOf(st, [{ station: "分:screening_concern", n: 12, progressRate: 70 }]);
ok("弱い駅: 下がった駅（前の週 70%→50%）と、止まり＋離れが過半数ではない駅の区別", weak.some((w) => w.station === "分:screening_concern" && w.reasons.some((r) => r.includes("下がった"))) && !weak.some((w) => w.station === "estimate"), weak);
ok("止まり＋離れが過半数なら弱い", weakStationsOf(stationStatsOf(rep(10, { outcome: "left" })))[0]?.reasons[0].includes("過半数"));
ok("n 不足の駅は出さない", weakStationsOf(stationStatsOf(rep(9, { outcome: "left" }))).length === 0);
const adds = stationGapsToAdd(weakStationsOf(stationStatsOf([...rep(10, { outcome: "left" }), ...rep(10, { node: "pickup", outcome: "stuck", after: "pickup" })])), [`${stationGapPrefix("pickup")} 前の行`]);
ok("同じ駅の行が開いていれば足さない・題の頭は駅", adds.length === 1 && adds[0].station === "estimate" && adds[0].title.startsWith(stationGapPrefix("estimate")) && !!adds[0].next);

console.log(`route-station-trust: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
