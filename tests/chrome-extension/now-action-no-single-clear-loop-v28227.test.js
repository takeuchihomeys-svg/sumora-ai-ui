// 実行: node tests/chrome-extension/now-action-no-single-clear-loop-v28227.test.js
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bp = fs.readFileSync(path.join(root, "bulk-panel-grasp.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 140) : "")); }
}

console.log("\n■ 版");
// 2.8.313: 版の固定が 2.8.2xx だけを通す書き方で、2.8.3xx で赤になっていた → 数の大小で比べる
const _ge = (v, m) => { const a = String(v).split(".").map(Number), b = m.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; } return true; };
ok("manifest ≥2.8.227", _ge(mf.version, "2.8.227"), mf.version);
ok("page ≥2.8.227", _ge((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.227"));
ok("rules ≥2.8.227", _ge((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.227"));

console.log("\n■ 1客で全部外しループしない");
ok("_shouldForceClear 本体は ForceClear 旗だけ", /function _shouldForceClearPrevPlace\([\s\S]{0,350}__axlxForceClearAllPlace[\s\S]{0,120}return false/.test(ps));
ok("本体に _axAutoPicking return true が無い", !/function _shouldForceClearPrevPlace\([\s\S]{0,400}if \(window\._axAutoPicking\) return true/.test(ps));
ok("ForceClearAllPlace は客切替時だけ", /客切替: 前の地域/.test(ps) && /place_keep/.test(ps));
ok("NeedClear も条件付き", /_needForcePlace/.test(ps));

console.log("\n■ いまの行動=外す／入れ");
ok("_publishNowAction", /function _publishNowAction\(/.test(ps));
ok("外している最中", /外している最中/.test(ps) && /外している最中/.test(bp));
ok("axlx-now-action", /axlx-now-action/.test(ps) && /axlx-now-action/.test(bd));
ok("clear_then_fill 後は fill 段", /clear_then_fill→入れ/.test(ps));
ok("決まり now_action_clear_then_fill", /id: "now_action_clear_then_fill"/.test(rules));
ok("RULES_DONE", /"now_action_clear_then_fill"/.test(ps));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
