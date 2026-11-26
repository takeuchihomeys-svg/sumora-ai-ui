// 実行: node tests/chrome-extension/loop-clear-grasp-chain-v28224.test.js
// v2.8.224: ループ上の外す把握チェーン（取得完了→外す→leftover→clear_then_fill→送付後）
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bd = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, d) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (d !== undefined ? "  " + String(d).slice(0, 120) : "")); }
}

// 版は「その版以上」で見る（固定すると次の版で赤になる）
function vge(v, min) {
  const a = String(v || "0").split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
  return true;
}

console.log("\n■ 版");
ok("manifest ≥2.8.224", vge(mf.version, "2.8.224"), mf.version);
ok("page ≥2.8.224", vge((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.224"));
ok("rules ≥2.8.224", vge((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.224"));

console.log("\n■ ループチェーン（外す把握）");
ok("1 取得完了 list_done（bulk）", /_graspCustomerLoopPhase\("list_done", "bulk_done→外す"\)/.test(ps));
ok("2 bulk を fill と誤らない", !/_graspCustomerLoopPhase\("fill", "bulk_grasp"\)/.test(ps));
ok("3 bulk nextMove=外す", /nextMove: "前客の選択を1つずつ外す"/.test(bd));
ok("4 leftover_scan で clear 段", /_graspCustomerLoopPhase\("clear", "leftover_scan"\)/.test(ps));
// 今の形: 外しの段そのものは clear_stage:／leftover_scan で "clear"、外し完了の移行（clear_then_fill）では "fill" へ進めて把握する
ok("5 clear_then_fill で外し→入れの移行を把握（clear 段は clear_stage: が持つ）", /_graspCustomerLoopPhase\("fill", "clear_then_fill→入れ"\)/.test(ps) && /_graspCustomerLoopPhase\("clear", "clear_stage:"/.test(ps));
ok("6 post_send で clear 段", /_graspCustomerLoopPhase\("clear", "post_send_clear"\)/.test(ps));
ok("7 series_done 後 next_move=外す", /前客の選択を1つずつ外す/.test(bg) && /loop_advance/.test(bg));
ok("8 skipped 偽OK禁止", /else if \(_psRes\.skipped\) _psOk = false/.test(bg));
ok("9 post_send_clear_gap", /post_send_clear_gap/.test(bg) && /post_send_clear_gap/.test(ps));

console.log("\n■ 決まり");
ok("post_send_clear_grasp since 224", /since: "2\.8\.224"/.test(rules) && /id: "post_send_clear_grasp"/.test(rules));
ok("verify に loop_phase / leftover", /"page:loop_phase_grasp"/.test(rules) && /"page:leftover_scan"/.test(rules));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
