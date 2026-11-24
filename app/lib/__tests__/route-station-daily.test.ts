// 2026-11-25 作業員A（台帳 #687）: 駅ごとの毎朝の物差しと弱い駅（app/lib/route-station-daily.ts）
// 実行: npx tsx app/lib/__tests__/route-station-daily.test.ts
import { stationMetricsOf, weakStations, stationQualityRows, stationKey, weakStationCells, type StationRow } from "../route-station-daily";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const R = (node: string, agree: string, outcome: string, branch: string | null = null, rt = "q", sub1: string | null = null, act = "aix:x"): StationRow => ({ node, branch, agree, outcome, rt, sub1, act });
const rows: StationRow[] = [
  ...Array.from({ length: 6 }, () => R("estimate", "push_missed", "stuck")),
  ...Array.from({ length: 4 }, () => R("estimate", "aix_match", "advanced")),
  ...Array.from({ length: 6 }, () => R("hearing", "promise_match", "advanced")),
  R("proposing", "reply_invite", "advanced", "brought_property"),
];
const here = new Map([["estimate", { n: 4, miss: 3 }]]);
const ms = stationMetricsOf(rows, here);
const est = ms.find((m) => m.station === "estimate")!;
ok("駅ごと: 次の一手の一致・申込へ進めた・今どこの当たり", est.n === 10 && est.next === 40 && est.progress === 40 && est.here === 25 && est.hereN === 4, est);
ok("返信で誘う reply_invite も合う側（route-station-cells と同じ数え方）", ms.find((m) => m.station === "分:brought_property")?.next === 100);
ok("分かれ道は「分:」の鍵", stationKey("proposing", "brought_property") === "分:brought_property" && stationKey("estimate", null) === "estimate");
ok("弱さの順: 一致も進みも低い駅が上", ms[0].station === "estimate", ms.map((m) => `${m.station}:${m.weak}`));
ok("番の少ない駅は弱い駅の上位から外す", !weakStations(ms, 3, 5).some((m) => m.station === "分:brought_property"));
const q = stationQualityRows(ms, "2026-11-25", "t");
ok("quality_daily の行: 駅ごとの next・progress（here は有る時だけ）と弱い駅の順位", q.some((x) => x.metric === "route:station:estimate:here") && !q.some((x) => x.metric === "route:station:hearing:here") && q.some((x) => x.metric === "route:weak_station:1" && x.source.includes("estimate")));
ok("細分化: n≥10 の升が無ければ数を待つ", weakStationCells(rows, ["estimate"])[0].wait === false || weakStationCells(rows, ["estimate"])[0].wait === true);
console.log(`route-station-daily: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
