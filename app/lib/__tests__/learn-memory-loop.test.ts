/**
 * 記憶→改善ループ
 * 実行: npx tsx app/lib/__tests__/learn-memory-loop.test.ts
 */
import { buildLearnMemoryLoop } from "../learn-memory-loop";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log("  ✓", name);
  else { failed++; console.log("  ✗", name, detail || ""); }
}

console.log("learn-memory-loop");
{
  const bad = buildLearnMemoryLoop({
    supervisorLogN: 5,
    hasProLog: true,
    improvementN: 0,
    logMemoryN: 0,
    continueLoop: true,
    lastSaveSkippedSameBundle: true,
  });
  ok("同束スキップで止まる", bad.bottleneck_n === 1, bad.line);
}
{
  const mid = buildLearnMemoryLoop({
    supervisorLogN: 5,
    hasProLog: true,
    improvementN: 0,
    logMemoryN: 2,
    continueLoop: true,
    beforePointPct: 14,
    afterPointPct: 14,
    beforeReadCount: 0,
    afterReadCount: 0,
  });
  ok("強化記録0で止まる", mid.steps.some((s) => s.id === "improvement_saved" && !s.ok));
}
{
  const good = buildLearnMemoryLoop({
    supervisorLogN: 10,
    hasProLog: true,
    improvementN: 3,
    logMemoryN: 2,
    continueLoop: false,
    beforePointPct: 14,
    afterPointPct: 40,
    beforeReadCount: 0,
    afterReadCount: 2,
  });
  ok("揃えば完了", good.bottleneck_n == null, good.line);
}

if (failed) { console.log("FAILED", failed); process.exit(1); }
console.log("OK");
