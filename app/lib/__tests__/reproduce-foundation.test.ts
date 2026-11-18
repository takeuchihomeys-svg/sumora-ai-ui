// 完全再現の土台細分化（2026-11-16）
// 実行: npx tsx app/lib/__tests__/reproduce-foundation.test.ts
import {
  atomsToTaskHints, linkageLine, subdivideReproduceGaps, summarizeAtoms, LAYER_JA,
} from "../reproduce-foundation";
import type { SceneFlow } from "../learn-flow-steps";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 自動の弱所→通常学習→土台→細部に細分化");
{
  const flows: SceneFlow[] = [
    { scene: "station", runs: 5, ops: 20, raw_ops: 22, variants: 2, gap_ms: 500, steps: ["transportation_id", "required_time"] },
    { scene: "cond", runs: 3, ops: 12, raw_ops: 14, variants: 1, gap_ms: 400, steps: ["rental_cost2"] },
  ];
  const atoms = subdivideReproduceGaps({
    reproducePct: 35,
    reproduceRemain: ["カーソル48%", "押した位置20%", "手の形なし"],
    humanLike: {
      ops: 100, changedWithoutClick: 4, changedWithoutClickFields: ["required_time", "rental_cost2"],
      withCursor: 48, withPoint: 20, rows: 100, handCursorClicks: 0,
    },
    challengeFields: ["required_time", "rental_cost2"],
    reclickFields: ["transportation_id"],
    autoFixTop: [{ what: "人が押す欄を自動が押していない", why: "1欄", how: "記録を作り直す" }],
    bundleReflect: { read_count: 1, screen_solid: 70, auto_after: false },
    sceneFlows: flows,
    stoppedScene: "検索を押す",
  });
  ok("見つける層がある", atoms.some((a) => a.layer === "find"), atoms.filter((a) => a.layer === "find").map((a) => a.id));
  ok("学ぶ層がある", atoms.some((a) => a.layer === "learn"));
  ok("土台層がある", atoms.some((a) => a.layer === "foundation"));
  ok("細部層がある", atoms.some((a) => a.layer === "detail"));
  ok("確かめる層がある", atoms.some((a) => a.layer === "verify"));
  ok("required_time に実際の必要が書いてある", atoms.some((a) => a.field === "required_time" && a.need.length > 10));
  ok("手の形の土台がある", atoms.some((a) => a.id === "foundation:hand-cursor"));
  const sum = summarizeAtoms(atoms);
  ok("要約に細分化と件数が入る", /細分化/.test(sum.line) && atoms.length >= 8, sum.line);
  ok("連動の行に自動と通常", /自動/.test(linkageLine(atoms)) && /通常/.test(linkageLine(atoms)), linkageLine(atoms));
  const hints = atomsToTaskHints(atoms);
  ok("photo_learn ヒントが出る", hints.some((h) => h.kind === "photo_learn"), hints);
  ok("build_foundation ヒントが出る", hints.some((h) => h.kind === "build_foundation"));
  ok("LAYER_JA が揃っている", LAYER_JA.find.includes("自動"));
}

console.log("\n■ ② 空でも落ちない");
{
  ok("空入力", subdivideReproduceGaps({}).length === 0);
  ok("要約が空でも行がある", typeof summarizeAtoms([]).line === "string");
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
