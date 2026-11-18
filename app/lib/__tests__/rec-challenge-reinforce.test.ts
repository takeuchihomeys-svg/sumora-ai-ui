/**
 * 録画→課題→学習→仕組み補強
 * 実行: npx tsx app/lib/__tests__/rec-challenge-reinforce.test.ts
 */
import { buildRecChallengeReinforce, findMechGaps } from "../rec-challenge-reinforce";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log("  ✓", name);
  else {
    failed++;
    console.log("  ✗", name, detail || "");
  }
}

console.log("rec-challenge-reinforce");

{
  const weak = buildRecChallengeReinforce({
    pointPct: 14,
    cursorPct: 70,
    aimAri: 0,
    aimNashi: 21,
    learnWarmN: 0,
    shortGapPct: 44.8,
    nearnessAllowed: false,
    nearnessScore: 28,
    visionPhotoOk: true,
    fireAtPointWired: true,
    extVersion: "2.8.90",
    readCount: 0,
    screenSolid: 96,
    screenAll: 96,
    unreadNormal: 0,
    imageButNotPressed: 2116,
    autoAfterBundle: false,
    reflectOk: 0,
    humanLike: { withPoint: 14, withCursor: 70, rows: 100, changedWithoutClick: 0 },
  });
  ok("8段階ある（⑥学び方含む）", weak.steps.length === 8, String(weak.steps.length));
  ok("課題発見で止まるか読込関所へ", (weak.bottleneck_n ?? 0) >= 1);
  ok("仕組みギャップに束読込", weak.mech_gaps.some((g) => g.id === "mech:bundle_read"));
  ok("次手に再読込か自動", weak.tasks.some((t) => t.kind === "need_ext_reload" || t.kind === "need_auto_run"));
  ok("行に止が出る", /止:/.test(weak.line), weak.line.slice(0, 120));
  ok("学び方強化がある", weak.method.upgrades.length >= 1 || weak.continue_loop);
  ok("完全ループ継続", weak.continue_loop === true);
}

{
  const gaps = findMechGaps({
    pointPct: 14,
    aimAri: 0,
    aimNashi: 10,
    readCount: 0,
    nearnessAllowed: false,
    extVersion: "2.8.90",
    fireAtPointWired: true,
  });
  ok("aimと読込の仕組みが出る", gaps.some((g) => g.id === "mech:learn_warm_aim") && gaps.some((g) => g.id === "mech:bundle_read"));
  ok("2.8.90なら gap_floor は coded", gaps.find((g) => g.id === "mech:gap_floor")?.coded === true);
}

{
  const good = buildRecChallengeReinforce({
    pointPct: 65,
    cursorPct: 75,
    aimAri: 8,
    aimNashi: 2,
    learnWarmN: 3,
    shortGapPct: 8,
    nearnessAllowed: true,
    nearnessScore: 72,
    visionPhotoOk: true,
    fireAtPointWired: true,
    extVersion: "2.8.90",
    readCount: 5,
    screenSolid: 40,
    screenAll: 40,
    unreadNormal: 0,
    autoAfterBundle: true,
    reflectOk: 2,
    flowHit: 1,
    humanLike: { withPoint: 65, withCursor: 75, rows: 100, changedWithoutClick: 0 },
  });
  ok("揃えば完了線", /完了/.test(good.line) || good.bottleneck_n == null, good.line.slice(0, 140));
}

if (failed) {
  console.log("FAILED", failed);
  process.exit(1);
}
console.log("OK");
