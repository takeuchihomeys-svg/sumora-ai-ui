/** v2.8.252: switch通路切れ→裸main.php飛ばし禁止／管理費stale止め */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8");
var bd = fs.readFileSync(path.join(root, "chrome-extension/batch-guard.js"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
ok("manifest ≥2.8.252", mf.version >= "2.8.252");
ok("KEEPに all_sent（2.8.253）", /dl:all_sent_/.test(fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8")));
ok("KEEPに learn_warm", /learn_warm/.test(fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8")));
ok("isSwitchChannelError", /function isSwitchChannelError/.test(bd));
ok("no_url_soft", /no_url_soft/.test(bd));
ok("switch_channel_retry印", /switch_channel_retry/.test(bg));
ok("lastKnownUrl引数", /_ensureRealproTab\([\s\S]{0,80}lastKnown/.test(bg) || /lastKnownRealproUrl/.test(bg));
ok("管理費は押す直前に取り直す", /_findFeeCb/.test(ps) && /fee_skip/.test(ps));
console.log(n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
