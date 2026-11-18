/**
 * 人間細部ループ＋動作間ギャップ
 * npx tsx app/lib/__tests__/human-detail-loop.test.ts
 */
import { buildHumanDetailLoop } from "../human-detail-loop";
import { gapsFromOps } from "../human-nearness";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : " → " + JSON.stringify(extra))); }
};

console.log("■ gapsFromOps は動作間だけ");
{
  const gs = gapsFromOps([
    { k: "click", f: "a", g: 1200 },
    { k: "change", f: "a", g: 40 },
    { k: "click", f: "b", g: 900 },
    { k: "diag", f: "", g: 10 },
    { k: "tap", f: "c", g: 80 },
  ]);
  ok("change/diag を除く", gs.length === 3, gs);
  ok("短い change を短間隔に混ぜない", !gs.includes(40) && !gs.includes(10), gs);
}

console.log("\n■ 人間細部ループ 5段");
{
  const weak = buildHumanDetailLoop({
    pointPct: 35,
    cursorPct: 81,
    aimAri: 0,
    aimNashi: 17,
    learnWarmN: 0,
    shortGapPct: 50,
    nearnessAllowed: false,
    visionPhotoOk: false,
    fireAtPointWired: true,
    extVersion: "2.8.87",
    changedWithoutClick: 2,
    autoAfterBundle: false,
  });
  ok("5段ある", weak.steps.length === 5);
  ok("弱所で止まる", weak.bottleneck_n === 1, weak.bottleneck);
  ok("原子が出る", weak.atoms.length >= 2, weak.atoms.map((a) => a.id));
  ok("度の線に60", /60/.test(weak.degree_line), weak.degree_line);

  const good = buildHumanDetailLoop({
    pointPct: 70,
    cursorPct: 90,
    aimAri: 10,
    aimNashi: 2,
    learnWarmN: 3,
    shortGapPct: 8,
    nearnessAllowed: true,
    nearnessScore: 80,
    visionPhotoOk: true,
    fireAtPointWired: true,
    extVersion: "2.8.87",
    changedWithoutClick: 0,
    autoAfterBundle: true,
  });
  ok("全部✓なら bottleneck なし", good.bottleneck_n == null, good.line);
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exitCode = 1;
