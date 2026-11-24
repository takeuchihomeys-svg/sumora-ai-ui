// v2.8.246 / F65: 強化し続ける（沈黙中aim再warm＋strengthen_loop）
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var sa = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var f64 = fs.readFileSync(path.join(root, "app/lib/root-cause-improve-loop.ts"), "utf8");
var fa = fs.readFileSync(path.join(root, "app/lib/learn-foundation-audit.ts"), "utf8");
var ks = fs.readFileSync(path.join(root, "app/lib/keep-strengthen-loop.ts"), "utf8");
var n = 0;
var fail = 0;
function ok(name, cond, detail) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else {
    fail++;
    console.log("  ✗ " + name + (detail ? " — " + detail : ""));
  }
}

console.log("\n■ 版");
ok("manifest ≥2.8.246", mf.version >= "2.8.246", mf.version);
ok("page ≥2.8.246", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.246");
ok("rules ≥2.8.246", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.246");

console.log("\n■ 強化継続配線");
ok("_driveKeepStrengthen", /function _driveKeepStrengthen\(/.test(ps));
ok("沈黙で keep strengthen", /_driveKeepStrengthen\("silence_tick"\)/.test(ps));
ok("foundation 後も keep", /_driveKeepStrengthen\("foundation:/.test(ps) || /_driveKeepStrengthen\("foundation:"/.test(ps));
ok("strengthen_loop 印", /strengthen_loop/.test(ps));
ok("strengthen_aim_rewarm 印", /strengthen_aim_rewarm/.test(ps));
ok("RULES_DONE keep_strengthen_loop", /"keep_strengthen_loop"/.test(ps));
ok("決まり keep_strengthen_loop", /id: "keep_strengthen_loop"/.test(rules));

console.log("\n■ KEEP / F65 / F64");
ok("KEEP strengthen_loop", /strengthen_loop/.test(sa));
ok("lib keep-strengthen-loop", /KEEP_STRENGTHEN_STAMP_REL/.test(ks));
ok("F65 土台", /F65_keep_strengthen_loop/.test(fa));
ok("F64 症例 keep_strengthen_stalls", /keep_strengthen_stalls/.test(f64));
ok("script keep-strengthen.ts", fs.existsSync(path.join(root, "scripts/keep-strengthen.ts")));

console.log("\n" + n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
