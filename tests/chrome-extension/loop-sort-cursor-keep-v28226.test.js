// 実行: node tests/chrome-extension/loop-sort-cursor-keep-v28226.test.js
// v2.8.226: ループ次の動き・並べ替え把握・完了タスク一覧・マウス中心やり直し禁止
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const pu = fs.readFileSync(path.join(root, "pointer-ui.js"), "utf8");
const sa = fs.readFileSync(path.join(root, "search-audit.js"), "utf8");
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
ok("manifest ≥2.8.226", _ge(mf.version, "2.8.226"), mf.version);
ok("page ≥2.8.226", _ge((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.226"));
ok("rules ≥2.8.226", _ge((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.226"));

console.log("\n■ ループ・次の動き・タスク一覧");
ok("_AX_CUSTOMER_LOOP に sort", /id: "sort"/.test(ps) && /label: "並べ替え"/.test(ps));
ok("loop_task_list 印", /loop_task_list/.test(ps));
ok("把握時に next_move_grasp", /_auditStepP\(\s*"next_move_grasp"[\s\S]{0,40}loop:/.test(ps) || /next_move_grasp", "次の動き=" \+ nextLabel \+ " loop:/.test(ps));
ok("bulk→page 把握依頼", /axlx-loop-phase-req/.test(bd) && /axlx-loop-phase-req/.test(ps));
ok("sort開始で loop grasp", /_requestLoopGrasp\("sort"/.test(bd));
ok("sort完了で list grasp", /_requestLoopGrasp\("list"/.test(bd));
ok("決まり loop_sort_grasp", /id: "loop_sort_grasp_and_cursor_keep"/.test(rules));
ok("RULES_DONE に載る", /"loop_sort_grasp_and_cursor_keep"/.test(ps));

console.log("\n■ マウス中心やり直し禁止");
ok("cancelMove が座標保持", /cancelMove:[\s\S]{0,400}_savePos/.test(pu));
ok("飛行中 cancel で _release", /anim\.cancelled\)[\s\S]{0,200}_release\(\)/.test(pu));
ok("見えるカーソルなら scatter しない", /cursor_resume/.test(ps) && /visiblePosition/.test(ps));
ok("abort で pointer_cancel", /pointer_cancel/.test(bd));

console.log("\n■ KEEP/RULE");
ok("KEEP loop_task_list", /loop_task_list/.test(sa));
ok("KEEP cursor_resume|pointer_cancel", /cursor_resume/.test(sa) && /pointer_cancel/.test(sa));
ok("KEEP dl:loop_phase_req", /dl:loop_phase_req/.test(sa));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
