// 実行: node tests/chrome-extension/post-send-clear-grasp-v28223.test.js
// v2.8.223: 客完了→次へで送付後外しを実行し把握する（skippedを偽OKにしない）
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 140) : "")); }
}

console.log("\n■ 版");
// 2.8.313: 版の固定が 2.8.22x だけを通す書き方で、以後の版で赤になっていた → 数の大小で比べる
const _ge = (v, m) => { const a = String(v).split(".").map(Number), b = m.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; } return true; };
ok("manifest ≥2.8.223", _ge(mf.version, "2.8.223"), mf.version);
ok("page ≥2.8.223", _ge((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.223"));
ok("AUTO_RULES ≥2.8.223", _ge((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.223"));

console.log("\n■ 偽OK禁止");
ok("skipped を _psOk=false", /else if \(_psRes\.skipped\) _psOk = false/.test(bg));
ok("post_send_clear_gap 印", /post_send_clear_gap/.test(bg) && /post_send_clear_gap/.test(ps));
ok("未完了で ForceClear 注入", /__axlxForceClearAllPlace = true/.test(bg) && /__axlxPostSendClearGap/.test(bg));

console.log("\n■ 把握");
ok("post_send 開始で guide_clear_grasp は無い（2.8.328: 送付後の外しを消した）", !/送付後外し把握/.test(ps));
ok("post_send で loop clear は無い（2.8.328）", !/_graspCustomerLoopPhase\("clear", "post_send_clear"\)/.test(ps));
ok("fill_start_gap で強制外す把握", /fill_start_gap/.test(ps) && /post_send_gap/.test(ps));

console.log("\n■ 決まり・通し");
ok("post_send_clear_grasp 決まり", /id: "post_send_clear_grasp"/.test(rules));
ok("RULES_DONE に載る", /"post_send_clear_grasp"/.test(ps));
// 2.8.313: 「KEEP_STEP から200文字以内」の窓は、段の名前が増えて正規表現が長くなり（400文字目）届かなくなっていた。行ごとに見る。
const _lineOf = (name) => (sa.split("\n").find((l) => l.indexOf("var " + name + " = /") >= 0) || "");
ok("KEEP/RULE に gap", _lineOf("KEEP_STEP").includes("post_send_clear_gap") && _lineOf("RULE_STEP").includes("post_send_clear_gap"));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
