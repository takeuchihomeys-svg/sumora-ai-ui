import {
  countParallelizableWork,
  recommendWorkerScale,
  WORKER_SCALE_CAP,
} from "../supervisor-worker-scale";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

{
  const p = countParallelizableWork({
    sitesParallel: 0,
    learningTasksN: 1,
    foundationGapsN: 0,
    weakN: 0,
    unreadNormal: 0,
  });
  assert(p === 0 || p === 1, `薄い材料は並列小さい got=${p}`);
}

{
  const r = recommendWorkerScale({
    weakN: 10,
    unreadNormal: 25,
    learningTasksN: 5,
    foundationGapsN: 2,
    sitesParallel: 2,
    currentWorkers: 1,
  });
  assert(r.recommend >= 3, `負荷大は推奨≥3 got=${r.recommend}`);
  assert(r.cap === WORKER_SCALE_CAP, `硬上限 got=${r.cap}`);
}

{
  const r = recommendWorkerScale({
    weakN: 1,
    unreadNormal: 2,
    learningTasksN: 1,
    foundationGapsN: 0,
    sitesParallel: 1,
    currentWorkers: 1,
    reloadOnlyBottleneck: true,
  });
  assert(r.recommend === 1, `再読込1手は1 got=${r.recommend}`);
}

{
  const r = recommendWorkerScale({
    weakN: 20,
    unreadNormal: 50,
    learningTasksN: 8,
    foundationGapsN: 4,
    sitesParallel: 3,
    currentWorkers: 1,
  });
  assert(r.recommend <= WORKER_SCALE_CAP, `硬上限超え禁止 got=${r.recommend}`);
}

console.log("supervisor-worker-scale.test.ts: ok");
