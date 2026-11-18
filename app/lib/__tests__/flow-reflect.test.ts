/**
 * 録画流れ→弱い段→自動反映計画（F46）
 */
import {
  findWeakFlowFromRecordings,
  buildFlowReflectCycle,
  autoFlowGapsFromStepsBlob,
} from "../flow-reflect";

function t(name: string, cond: boolean, detail?: unknown) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (!cond && detail != null ? " " + JSON.stringify(detail) : ""));
  if (!cond) process.exitCode = 1;
}

console.log("\n■ flow-reflect F46");
{
  const weak = findWeakFlowFromRecordings({
    sceneFlows: [
      { scene: "area", steps: ["click:所在地絞り込み＋", "click:大阪市北区"] },
      { scene: "station", steps: ["click:駅の設定へ進む"] },
      { scene: "cond", steps: ["change:rental_cost2"] },
      // search 無し
    ],
    sceneMissing: ["search"],
    autoFlowGaps: ["place", "conditions", "search"],
  });
  t("search missing がある", weak.some((w) => w.scene === "search" && w.reason === "missing"), weak);
  t("place の auto_gap がある", weak.some((w) => w.phase === "place" && w.reason === "auto_gap"), weak);
  const plan = buildFlowReflectCycle(weak, { unreadNormal: 20 });
  t("need_auto がある", plan.needs_auto);
  t("cycle に need_auto_run", plan.cycle.some((c) => c.kind === "need_auto_run"), plan.cycle);
  t("cycle に photo_learn", plan.cycle.some((c) => c.kind === "photo_learn"), plan.cycle);
}

{
  const gaps = autoFlowGapsFromStepsBlob("fill_start|flow_done_place|flow_done_conditions");
  t("search が gap", gaps.includes("search"), gaps);
  t("fill_done が gap", gaps.includes("fill_done"), gaps);
  t("place は揃っているので gap でない", !gaps.includes("place"), gaps);
}

console.log("\n■ 弱さなし");
{
  const weak = findWeakFlowFromRecordings({
    sceneFlows: [
      { scene: "area", steps: ["a", "b"] },
      { scene: "station", steps: ["a", "b"] },
      { scene: "cond", steps: ["a", "b"] },
      { scene: "search", steps: ["検索"] },
    ],
    autoFlowGaps: [],
  });
  t("弱さ0", weak.length === 0, weak);
  const plan = buildFlowReflectCycle(weak);
  t("needs_auto false", plan.needs_auto === false);
}
