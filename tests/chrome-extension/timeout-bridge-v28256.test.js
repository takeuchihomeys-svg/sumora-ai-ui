/** v2.8.256: タイムアウト／長時間 → 録画 → 強化 → 次へ橋渡し */
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var sa = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8");
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var n = 0, fail = 0;
function ok(name, cond) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else { fail++; console.log("  ✗ " + name); }
}
ok("manifest ≥2.8.256", mf.version >= "2.8.256");
ok("page ver ≥2.8.256", /_AXLX_PAGE_VER = "2\.8\.(25[6-9]|2[6-9]\d|[3-9]\d{2})"/.test(ps) || (function () {
  var m = ps.match(/_AXLX_PAGE_VER = "([^"]+)"/);
  return m && m[1] >= "2.8.256";
})());
ok("_bridgeTimeoutRecordStrengthen", /function _bridgeTimeoutRecordStrengthen/.test(ps));
ok("印 timeout_bridge_on / next", /timeout_bridge_on/.test(ps) && /timeout_bridge_next/.test(ps));
ok("沈黙経路で bridge 呼び出し", /_bridgeTimeoutRecordStrengthen\(phase, why, d\)/.test(ps));
ok("list 固着 → bridge_sort_or_press", /bridge_sort_or_press/.test(ps) && /axlx-timeout-bridge-next/.test(ps));
ok("bulk が timeout-bridge 受信", /axlx-timeout-bridge-next/.test(bd) && /timeout_bridge_recv/.test(bd));
ok("bulk kick sort / customer_done", /timeout_bridge_kick/.test(bd) && /_kickSortAfterSearch\("timeout_bridge"\)/.test(bd));
ok("RULES_DONE に timeout_record_strengthen_bridge", /timeout_record_strengthen_bridge/.test(ps));
ok("AUTO_RULES に同 id", /id: "timeout_record_strengthen_bridge"/.test(rules));
ok("REVIEWED_UP_TO ≥2.8.256", (function () {
  var m = rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/);
  return m && m[1] >= "2.8.256";
})());
ok("KEEP に timeout_bridge_", /timeout_bridge_/.test(sa) && /KEEP_STEP/.test(sa));
ok("RULE に timeout_bridge_", /dl:timeout_bridge_/.test(sa));
console.log(n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
