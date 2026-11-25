import {
  isFalseSortPointKey,
  isRealSortPointKey,
  evaluateSortUnderstandGate,
  pickSortRunsToLearn,
  stripFalseSortPoints,
  tallySortRuns,
  harvestSortPointsFromOps,
} from "../sort-sequence-learn";

function ok(name: string, cond: boolean, detail?: string) {
  if (!cond) throw new Error(`FAIL ${name}${detail ? ": " + detail : ""}`);
  console.log("ok", name);
}

ok("棟戸並べ替えは誤認", isFalseSortPointKey("左の大阪36棟46戸並べ替え｜div.main_table"));
ok("sort_detail は誤認でない", !isFalseSortPointKey("sort_detail"));
ok("高→低 は誤認でない", !isFalseSortPointKey("高→低"));

const stripped = stripFalseSortPoints({
  "左の大阪1棟1戸並べ替え更新｜div.main_table": { x: 0.1, y: 0.2, n: 2 },
  sort_detail: { x: 0.26, y: 0.33, n: 3 },
  "高→低": { x: 0.26, y: 0.33, n: 3 },
});
ok("誤認を除去", stripped.removed.length === 1 && !stripped.points["左の大阪1棟1戸並べ替え更新｜div.main_table"]);
ok("本物は残る", !!stripped.points.sort_detail && !!stripped.points["高→低"]);

const runs = tallySortRuns([
  {
    mode: "normal",
    shot_key: "2026/normal/run_aaa/x.jpg",
    shot_taken: true,
    shot_ops: [{ f: "sort_detail", k: "click" }],
    shot_learn: null,
  },
  {
    mode: "normal",
    shot_key: "2026/normal/run_bbb/x.jpg",
    shot_taken: true,
    shot_ops: [{ f: "左の大阪1棟並べ替え｜div.main_table", k: "click" }],
    shot_learn: null,
  },
]);
ok("本物ランを数える", runs.some((r) => r.run_id.includes("aaa") && r.hasRealSort));
ok("棟のみは本物でない", runs.some((r) => r.run_id.includes("bbb") && !r.hasRealSort));

const picked = pickSortRunsToLearn(
  [
    { run_id: "run_mwrkvjeo_ug84", n: 6, withShot: 6, learned: 0, withScene: 0, unlearnedShot: 6, realShot: 2, realUnlearned: 2, hasRealSort: true, hits: ["sort_detail"] },
    { run_id: "run_other", n: 10, withShot: 10, learned: 0, withScene: 0, unlearnedShot: 10, realShot: 3, realUnlearned: 3, hasRealSort: true, hits: ["高→低"] },
  ],
  ["mwrkvjeo_ug84"],
  2,
);
ok("名指しラン優先", picked[0].run_id.includes("mwrkvjeo_ug84"));

const gateNg = evaluateSortUnderstandGate({
  points: { "左の大阪並べ替え｜div.main_table": { x: 0.1, y: 0.2, n: 2 } },
  runs: picked,
});
ok("誤認だけだと未理解", !gateNg.ok);

const gateOk = evaluateSortUnderstandGate({
  points: { sort_detail: { x: 0.2, y: 0.3, n: 2 }, "高→低": { x: 0.2, y: 0.3, n: 2 } },
  runs: [{ ...picked[0], unlearnedShot: 5, realUnlearned: 0, realShot: 2, learned: 1 }],
});
ok("本物points＋本物未読0で理解（棟戸未読は無視）", gateOk.ok, gateOk.line);

ok("左の高→低｜span.sort_detail は本物", isRealSortPointKey("左の高→低｜span.sort_detail"));
const harvested = harvestSortPointsFromOps([
  {
    mode: "normal",
    shot_ops: [{ f: "左の高→低｜span.sort_detail", k: "click", x: 0.16, y: 0.27, w: "button" }],
  },
]);
ok("ops収穫で sort_detail が付く", harvested.sort_detail?.x === 0.16 && harvested["高→低"]?.y === 0.27);

console.log("all ok");
