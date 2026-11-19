// 2.8.125: 見えない町（town_list だけに在る町）をカーソルで外す・押下時間・ラン seed・motion_stats の配線（ソース確認）
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " :: " + d : "")); } }
ok("見えない町: 詳細地域へ進む(next_step_button2)を1回だけカーソルで押す", /townStepTried/.test(ps) && /leftover_town_step/.test(ps) && /enqueueHumanClick\(_nx,/.test(ps));
ok("押下時間: _fireAt が AxlxPointerUi.holdMs を使い mousedown を先に出す", /_PH\.holdMs\(\)/.test(ps) && /_sendDown/.test(ps));
ok("ラン seed: fill 開始で __axlxRunId を置く", /window\.__axlxRunId = String\(_fillCustomerId/.test(ps));
ok("監査: motion_stats を AxlxPointerUi.motionStats() から出す", /_auditStepP\("motion_stats"/.test(ps) && /_PM\.motionStats\(\)/.test(ps));
ok("motion_stats は間引き保護・即送信に入っている", /_PIN = \/\^\([^\/]*\|motion_stats\|/.test(ps) && /_clearKey = \/motion_stats\|/.test(ps));
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
ok("版 2.8.125 以降で page-script と manifest が一致", new RegExp('_AXLX_PAGE_VER = "' + mf.version.replace(/\./g, "\\.") + '"').test(ps) && mf.version.localeCompare("2.8.125", undefined, { numeric: true }) >= 0, mf.version);
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
