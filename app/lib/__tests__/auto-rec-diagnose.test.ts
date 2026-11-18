/**
 * npx tsx app/lib/__tests__/auto-rec-diagnose.test.ts
 */
import { diagnoseAutoRecording } from "../auto-rec-diagnose";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : " → " + JSON.stringify(extra))); }
};

console.log("■ 地域↔駅混在");
{
  const d = diagnoseAutoRecording({
    gate: { placeMixed: true, area_ok_by: "both", areaMode: "ward", errors: ["地域と駅が同時"] },
  });
  ok("混在原子", d.atoms.some((a) => a.id === "place_xor_mixed"), d.atoms);
  ok("place.mixed", d.place.mixed);
}

console.log("\n■ 外し忘れ");
{
  const d = diagnoseAutoRecording({
    gate: { extraStation: true, areaMode: "ward", errors: ["所在地検索なのに駅・沿線が残っている"] },
  });
  ok("外し忘れ原子", d.atoms.some((a) => a.id === "place_clear_miss"), d.atoms);
}

console.log("\n■ 押した位置・aim");
{
  const d = diagnoseAutoRecording({
    humanLike: { withPoint: 2, withCursor: 8, rows: 10, changedWithoutClick: 0 },
    aimAri: 0,
    aimNashi: 12,
    learnWarmN: 0,
    visionPhotoOk: false,
    steps: [{ k: "fill_start" }, { k: "cursor_aim", m: "aim無" }],
  });
  ok("point原子", d.atoms.some((a) => a.id === "point_pct_low"));
  ok("aim原子", d.atoms.some((a) => a.id === "aim_all_miss"));
  ok("vision原子", d.atoms.some((a) => a.id === "vision_photo"));
  ok("lineがある", d.line.length > 10, d.line);
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exitCode = 1;
