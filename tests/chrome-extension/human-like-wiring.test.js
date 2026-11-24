// 人間らしさの配線（間隔・カーソル・一息・待ち）が拡張に残っているか
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../..");
const page = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
const wait = fs.readFileSync(path.join(root, "chrome-extension/human-wait.js"), "utf8");
const loop = fs.readFileSync(path.join(root, "app/lib/ext-test-improve-loop.ts"), "utf8");
const audit = fs.readFileSync(path.join(root, "app/lib/human-like-audit.ts"), "utf8");
const near = fs.readFileSync(path.join(root, "app/lib/human-nearness.ts"), "utf8");

function ok(name, cond, detail) {
  if (!cond) {
    console.error("✗", name, detail || "");
    process.exitCode = 1;
  } else console.log("✓", name);
}

console.log("■ 人間らしさ配線");
ok("human-wait logNormalDelay", /logNormalDelay/.test(wait) && /AxlxHumanWait/.test(wait));
ok("page が logNormalDelay を使う", /logNormalDelay/.test(page) && /AxlxHumanWait/.test(page));
ok("一息・休憩の言葉がコードに残る", /一息/.test(page) || /createPacer|siteGapMs|customerGapMs/.test(page));
ok("カーソル移動の待ち", /mousemove|pointer|_moveMs|humanPointer|cursor/.test(page));
ok("auditHumanLike / judgeHumanLikePass", /auditHumanLike/.test(audit) && /judgeHumanLikePass/.test(audit));
ok("HUMAN_LIKE_PASS", /HUMAN_LIKE_PASS/.test(audit));
ok("human-nearness 許可線", /NEARNESS_ALLOW/.test(near) && /computeHumanNearness/.test(near));
ok("gapsFromOps は click/tap/key のみ", /click.*tap.*key|PRESS_KINDS/.test(near));
ok("F58 に human_like_audit", /human_like_audit/.test(loop));
ok("F58 に human_nearness", /human_nearness/.test(loop));
ok("F58 に human_like_wiring", /human_like_wiring/.test(loop));
ok("F58 に human_like_improve_loop", /human_like_improve_loop/.test(loop));

if (process.exitCode) process.exit(1);
console.log("human-like-wiring.test OK");
