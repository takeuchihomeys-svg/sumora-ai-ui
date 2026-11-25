// 2.8.198: 束の人の間隔（floor_ms）で区/selectレーンを寄せる
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../..");
const page = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
const loop = fs.readFileSync(path.join(root, "app/lib/human-like-improve-loop.ts"), "utf8");

function ok(name, cond, detail) {
  if (!cond) {
    console.error("✗", name, detail || "");
    process.exitCode = 1;
  } else console.log("✓", name);
}
function verGe(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

console.log("■ 2.8.198 人間らしさ間隔寄せ");
ok("manifest ≥2.8.198", verGe(man.version, "2.8.198"), man.version);
ok("__axlxLearnGapFloor", /__axlxLearnGapFloor/.test(page) && /floor_ms/.test(page));
ok("_wardGapPlan が束の間隔を使う", /_wardGapPlan[\s\S]{0,400}__axlxLearnGapMs/.test(page));
ok("_selGapPlan が束の間隔を使う", /_selGapPlan[\s\S]{0,400}__axlxLearnGapMs/.test(page));
ok("learnGapPaceFromNormalGaps", /learnGapPaceFromNormalGaps/.test(loop));
ok("evaluateHumanLikeImproveStamp", /evaluateHumanLikeImproveStamp/.test(loop));

if (process.exitCode) process.exit(1);
console.log("human-like-gap-pace-v28198.test OK");
