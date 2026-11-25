// 実行: node tests/chrome-extension/customer-loop-grasp-v28221.test.js
// v2.8.221: 物件取得完了→外す→入れ→検索→並び替え→取得→次客 を1つずつ把握
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const ap = fs.readFileSync(path.join(__dirname, "../../app/lib/action-playbook.ts"), "utf8");
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 120) : "")); }
}

console.log("\n■ 版");
ok("manifest ≥2.8.221", /^2\.8\.(22[1-9]|2[3-9]\d|[3-9]\d{2})$/.test(mf.version) || mf.version >= "2.8.221", mf.version);
ok("page-script ≥2.8.221", /_AXLX_PAGE_VER = "2\.8\.22[1-9]"/.test(ps) || /_AXLX_PAGE_VER = "2\.8\.[3-9]/.test(ps));
ok("PLAYBOOK_BUILD_V=13", /PLAYBOOK_BUILD_V = 13/.test(ap));
ok("AUTO_RULES_REVIEWED_UP_TO ≥2.8.221", /AUTO_RULES_REVIEWED_UP_TO = "2\.8\.22[1-9]"/.test(rules));

console.log("\n■ 手順書一連");
ok("flow_series に clear_then_fill", /id: "clear_then_fill"/.test(ap));
ok("before_clear → clear_then_fill", /next: "clear_then_fill"/.test(ap));

console.log("\n■ 把握配線");
ok("_graspCustomerLoopPhase がある", /function _graspCustomerLoopPhase\(/.test(ps));
ok("loop_phase_grasp / loop_who_grasp 印", /loop_phase_grasp/.test(ps) && /loop_who_grasp/.test(ps));
ok("fill_start で loop 把握", /_graspCustomerLoopPhase\("fill", "fill_start"\)/.test(ps));
ok("clear_then_fill で loop 把握", /_graspCustomerLoopPhase\("clear", "clear_then_fill"\)/.test(ps));
ok("after_search で loop 把握", /_graspCustomerLoopPhase\("search", "after_search"\)/.test(ps));
ok("ready_next で next+loop+handoff", /_graspNextCustomerAndMove\("ready_next"\)/.test(ps) && /_graspCustomerLoopPhase\("handoff"/.test(ps));
ok("bulk-next で currentName も受ける", /__axlxBulkCurrentName/.test(ps) && /bulk_grasp/.test(ps));
ok("手順undefined 防止（Array.isArray）", /if \(!Array\.isArray\(steps\)\) steps = \[\]/.test(ps));

console.log("\n■ 一覧手順×画面");
ok("flow_series から list/next を読む", /flow_series[\s\S]{0,200}fid === "list"/.test(bd) || /fid === "list" \|\| fid === "sort_ad"/.test(bd));
ok("handoff で loop_handoff_grasp", /loop_handoff_grasp/.test(bd));

console.log("\n■ 決まり");
ok("customer_loop_one_by_one", /id: "customer_loop_one_by_one"/.test(rules));
ok("RULES_DONE に載る", /"customer_loop_one_by_one"/.test(ps));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
