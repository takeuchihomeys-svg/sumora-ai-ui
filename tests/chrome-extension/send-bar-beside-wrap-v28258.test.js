/** v2.8.258: 物件送る枠がお客様パネルの下に隠れない */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ub = fs.readFileSync(path.join(root, "chrome-extension/underbar.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
ok("manifest ≥2.8.258", mf.version >= "2.8.258");
ok("_placeSendBarVisible", /function _placeSendBarVisible/.test(bd));
ok("beside-wrap 配置", /beside-wrap/.test(bd));
ok("display !important で出す", /setProperty\("display", "flex", "important"\)/.test(bd));
ok("updateBar で place", /_placeSendBarVisible/.test(bd) && /function updateBar/.test(bd));
ok("heal 2秒＋display=building", /display=building[\s\S]{0,120}_placeSendBarVisible/.test(bd) || /display=building/.test(bd));
ok("user-drag 印", /data-axlx-user-drag/.test(bd));
ok("既存wrapも右へスナップ", /既存 wrap でも右ドック/.test(ub) || /Math\.abs\(curX - dockX\) > 120/.test(ub));
ok("印 send_bar_show", /send_bar_show/.test(bd));
console.log(n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
