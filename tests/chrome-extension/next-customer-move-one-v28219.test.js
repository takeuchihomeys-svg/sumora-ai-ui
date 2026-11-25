/**
 * 2.8.219: 次客・次の動きを把握してから進む／条件1つずつ
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const page = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bulk = fs.readFileSync(path.join(root, "bulk-dl.js"), "utf8");
const graspJs = fs.readFileSync(path.join(root, "bulk-panel-grasp.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const rules = fs.readFileSync(
  path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"),
  "utf8"
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function semverOk(v, min) {
  const a = String(v).split(".").map(Number);
  const b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

assert(semverOk(man.version, "2.8.219"), "manifest >= 2.8.219 got " + man.version);
assert(page.includes("2.8.219"), "page ver");
assert(page.includes("function _graspNextCustomerAndMove"), "grasp fn");
assert(page.includes("next_customer_grasp"), "stamp next_customer");
assert(page.includes("next_move_grasp"), "stamp next_move");
assert(page.includes("cond_one_grasp"), "cond_one_grasp");
assert(page.includes("cond_one_ok"), "cond_one_ok");
assert(page.includes("_graspNextCustomerAndMove(\"fill_start\")") || page.includes("_graspNextCustomerAndMove('fill_start')") || /_graspNextCustomerAndMove\(\s*[\"']fill_start/.test(page), "called at fill_start");
assert(page.includes("axlx-bulk-next"), "listen bulk next");
assert(page.includes("next_customer_move_one_by_one"), "RULES_DONE");
assert(rules.includes('id: "next_customer_move_one_by_one"'), "AUTO_RULE");
assert(rules.includes('AUTO_RULES_REVIEWED_UP_TO = "2.8.219"'), "reviewed up to");
assert(bulk.includes("axlx-bulk-next"), "bulk posts next");
assert(graspJs.includes("次の動き:"), "panel nextMove");

/** 純関数: 段→次の動き */
function phaseNextJa(ph) {
  const m = {
    switch: "客切替を把握",
    place: "場所を外す／入れる",
    conditions: "条件を1つずつ入れる",
    search: "検索を押す",
    fill_done: "一連完了を確認",
    ready_next: "次客へ渡す",
  };
  return m[ph] || ph;
}
assert(phaseNextJa("conditions") === "条件を1つずつ入れる", "conditions label");
assert(phaseNextJa("place").indexOf("場所") >= 0, "place label");

/** 条件ラベル */
function condOneLabel(name) {
  const m = { rental_cost1: "賃料下限", rental_cost2: "賃料上限", update_date: "更新日" };
  return m[name] || name;
}
assert(condOneLabel("rental_cost2") === "賃料上限", "rent label");

console.log("next-customer-move-one-v28219: OK");
