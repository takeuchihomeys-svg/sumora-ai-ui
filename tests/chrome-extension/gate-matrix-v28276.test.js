/**
 * 2.8.276 関所（_axGateCheck）を本物のソースのまま偽の画面で動かす網羅試験
 *   （2026-11-24 竹内さん「これで漏れないのか／テストして徹底的に確認」）
 *
 * 前のお客さんの値が画面に残った形を組み合わせ、
 *   ・残りを「前の条件が残っている」として見つけるか（見逃し0）
 *   ・正常なお客さん・既定値の欄は見つけないか（誤検知0）
 *   ・止める側の判定（止める文の先頭）に入るか
 * を確かめる。画面は最小の偽物（select／input／checkbox を name で引くだけ）。
 */
"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var ps = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "page-script.js"), "utf8").replace(/\r\n/g, "\n");
function fn(n) {
  var a = ps.indexOf("  function " + n + "(");
  assert.ok(a >= 0, n + " が無い");
  return ps.slice(a, ps.indexOf("\n  }\n", a) + 5);
}

// ── 偽の画面 ───────────────────────────────────────────
function opt(v, t) { return { value: v, textContent: t }; }
var RENT = [opt("-1", "下限なし"), opt("60000", "6.0万"), opt("80000", "8.0万"), opt("107000", "10.7万")];
var AGE = [opt("-1", "指定なし"), opt("5", "5年以内"), opt("10", "10年以内")];
function mkSelect(opts, idx) { return { tag: "select", options: opts, selectedIndex: idx, get value() { return opts[this.selectedIndex].value; } }; }

function makeDom(o) {
  o = o || {};
  var selects = {
    rental_cost1: mkSelect(RENT, o.rentMinIdx || 0),
    rental_cost2: mkSelect(RENT, o.rentMaxIdx || 0),
    structured_date: mkSelect(AGE, o.ageIdx || 0),
    update_date: mkSelect([opt("", "指定なし"), opt("1", "1日以内")], o.updIdx || 0),
  };
  if (o.defaultOddValue) selects.structured_date = mkSelect([opt("x", "なし"), opt("5", "5年")], 0);
  if (o.walkSelect) selects.required_time = mkSelect([opt("", "指定なし"), opt("5", "5分"), opt("10", "10分")], o.walkSelect.idx);
  var inputs = {};
  if (!o.walkSelect) inputs.required_time = { value: o.walk == null ? "" : String(o.walk) };
  var checks = { "room_layout_id[]": o.layouts || [], "station_id[]": o.stations || [], "route_id[]": [], "city_code[]": o.wards || [], "town_code[]": [] };
  var allLay = ["1", "2", "3", "4", "5"];
  return {
    querySelector: function (css) {
      var m = /^(select|input)\[name="([^"]+)"\]$/.exec(css);
      if (!m) return null;
      return (m[1] === "select" ? selects : inputs)[m[2]] || null;
    },
    querySelectorAll: function (css) {
      var m = /^input\[name="([^"]+)"\](:checked)?$/.exec(css);
      if (!m) return [];
      var base = m[1] === "room_layout_id[]" && !m[2] ? allLay : (checks[m[1]] || []);
      return base.map(function (v) { return { value: String(v) }; });
    },
  };
}

function gateOf(expect, dom, extra) {
  var sb = { _axExpect: expect, _axPlaceReady: true, _pickedCounts: function () { return { ward: 0, station: 0 }; },
    _findShikireiCheckbox: function () { return { checked: true }; }, _audit: null, _auditStepP: function () {},
    location: { search: "" }, URLSearchParams: URLSearchParams, document: dom };
  Object.assign(sb, extra || {});
  vm.createContext(sb);
  vm.runInContext(["_axLeftoverFields", "_axNoneValueOf", "_axGateCheck"].map(fn).join("\n") + "\nthis.__g = _axGateCheck;", sb);
  // vm の配列は別の世界の物なので JSON を通して普通の物にする（deepStrictEqual 用）
  return JSON.parse(JSON.stringify(sb.__g()));
}

// なおき相当: 家賃 8.0〜10.7万・徒歩15・間取り2LDK(値 "3")・駅モード
function nextCust(over) {
  return Object.assign({ layoutVals: ["3"], floorPlan: "2LDK", rentMax: "107000", rentMin: "80000", updateDays: null, age: null, walk: "15", shikirei: false, areaMode: "station", areaText: "南堀江" }, over || {});
}
var okDom = { rentMinIdx: 2, rentMaxIdx: 3, walk: "15", layouts: ["3"], stations: ["s1"] };

var results = [];
function t(name, f) { try { f(); results.push({ name: name, ok: true }); } catch (e) { results.push({ name: name, ok: false, err: e }); } }
function leftoverMsgs(g) { return g.errors.filter(function (m) { return m.indexOf("前の条件が残っている") === 0; }); }
function isHard(m) { return m.indexOf("場所") === 0 || m.indexOf("間取り") === 0 || m.indexOf("敷金") === 0 || m.indexOf("礼金") >= 0 || m.indexOf("前の条件が残っている") === 0; }

t("正常: 次のお客さんの条件がそのまま入っている → 誤検知0・errors 0", function () {
  var g = gateOf(nextCust(), makeDom(okDom));
  assert.deepStrictEqual(g.errors, [], g.errors.join(" / "));
});

t("前客の家賃下限（6万）が残り・次のお客さんは下限なし → 見つける・止める側", function () {
  var g = gateOf(nextCust({ rentMin: null }), makeDom({ rentMinIdx: 1, rentMaxIdx: 3, walk: "15", layouts: ["3"], stations: ["s1"] }));
  var m = leftoverMsgs(g);
  assert.strictEqual(m.length, 1, g.errors.join(" / "));
  assert.ok(/家賃の下限/.test(m[0]) && isHard(m[0]));
  assert.strictEqual(g.prevLeftover[0].name, "rental_cost1");
});

t("前客の家賃上限が残り・築年も残り・徒歩も残り → 3つ全部見つける", function () {
  var g = gateOf(nextCust({ rentMin: null, rentMax: null, walk: null }), makeDom({ rentMinIdx: 1, rentMaxIdx: 3, ageIdx: 2, walk: "7", layouts: ["3"], stations: ["s1"] }));
  assert.deepStrictEqual(g.prevLeftover.map(function (f) { return f.name; }), ["rental_cost1", "rental_cost2", "structured_date", "required_time"]);
});

t("徒歩が select の画面でも、前客の徒歩が残れば見つける", function () {
  var g = gateOf(nextCust({ walk: null }), makeDom({ rentMinIdx: 2, rentMaxIdx: 3, walkSelect: { idx: 2 }, layouts: ["3"], stations: ["s1"] }));
  assert.deepStrictEqual(g.prevLeftover.map(function (f) { return f.name; }), ["required_time"]);
});

t("誤検知0: 既定（先頭=指定なし）なら、値が変な文字でも残りとしない", function () {
  var g = gateOf(nextCust({ rentMin: null, rentMax: null, walk: null }), makeDom({ defaultOddValue: true, layouts: ["3"], stations: ["s1"] }));
  assert.strictEqual(leftoverMsgs(g).length, 0, g.errors.join(" / "));
});

t("誤検知0: 更新日（既定が付く欄）は残りとして見ない", function () {
  var g = gateOf(nextCust({ rentMin: null, rentMax: null, walk: null }), makeDom({ updIdx: 1, layouts: ["3"], stations: ["s1"] }));
  assert.strictEqual(leftoverMsgs(g).length, 0, g.errors.join(" / "));
});

t("誤検知0: 次のお客さんが指定した項目の食い違いは『前の条件が残っている』ではなく従来の文で出る", function () {
  var g = gateOf(nextCust(), makeDom({ rentMinIdx: 1, rentMaxIdx: 3, walk: "15", layouts: ["3"], stations: ["s1"] }));
  assert.strictEqual(leftoverMsgs(g).length, 0);
  assert.ok(g.errors.some(function (m) { return /家賃の下限が画面と違う/.test(m); }), g.errors.join(" / "));
});

t("間取りに前客分が残る → 従来どおり extraLayout（止める側）", function () {
  var g = gateOf(nextCust(), makeDom({ rentMinIdx: 2, rentMaxIdx: 3, walk: "15", layouts: ["3", "1"], stations: ["s1"] }));
  assert.ok(g.extraLayout && g.errors.some(function (m) { return m.indexOf("間取り") === 0; }), g.errors.join(" / "));
});

t("駅の客なのに前客の区が残る → 従来どおり extraWard", function () {
  var g = gateOf(nextCust(), makeDom({ rentMinIdx: 2, rentMaxIdx: 3, walk: "15", layouts: ["3"], stations: ["s1"], wards: ["27127"] }));
  assert.ok(g.placeMixed || g.extraWard, JSON.stringify(g.errors));
});

t("場所が空 → 従来どおり場所なし（止める側）", function () {
  var g = gateOf(nextCust(), makeDom({ rentMinIdx: 2, rentMaxIdx: 3, walk: "15", layouts: ["3"] }));
  assert.ok(g.missingArea && g.errors.some(function (m) { return m.indexOf("場所") === 0; }));
});

t("組み合わせ: 全部そろっていて残りだけ → errors は残りの1件だけ", function () {
  var g = gateOf(nextCust({ walk: null }), makeDom({ rentMinIdx: 2, rentMaxIdx: 3, walk: "7", layouts: ["3"], stations: ["s1"] }));
  assert.strictEqual(g.errors.length, 1, g.errors.join(" / "));
  assert.strictEqual(leftoverMsgs(g).length, 1);
});

t("_axExpect が空 → 何も言わない（clickSearch 側が『準備前は押さない』で止める前提）", function () {
  var g = gateOf(null, makeDom(okDom));
  assert.deepStrictEqual(g.errors, []);
  assert.ok(/if \(!_axExpect\) \{[\s\S]{0,400}search_block_early/.test(ps), "clickSearch は _axExpect が無ければ押さない");
});

t("前客の残り: 4つの止める判定すべてが『前の条件が残っている』を止める側に入れている", function () {
  var n = (ps.match(/s\.indexOf\('前の条件が残っている'\) === 0/g) || []).length;
  assert.strictEqual(n, 4);
});

t("全探索: 前客の値（家賃下限・上限・築年・徒歩）が残る全16通り × 次のお客さんが指定なし → 毎回その分だけ見つける", function () {
  for (var mask = 0; mask < 16; mask++) {
    var dom = makeDom({ rentMinIdx: mask & 1 ? 1 : 0, rentMaxIdx: mask & 2 ? 3 : 0, ageIdx: mask & 4 ? 2 : 0, walk: mask & 8 ? "7" : "", layouts: ["3"], stations: ["s1"] });
    var g = gateOf(nextCust({ rentMin: null, rentMax: null, walk: null }), dom);
    var want = ((mask & 1) ? 1 : 0) + ((mask & 2) ? 1 : 0) + ((mask & 4) ? 1 : 0) + ((mask & 8) ? 1 : 0);
    var got = g.prevLeftover ? g.prevLeftover.length : 0;
    assert.strictEqual(got, want, "mask=" + mask + " 期待" + want + "／実際" + got);
  }
});

var fail = 0;
results.forEach(function (r) {
  if (r.ok) console.log("  ✓ " + r.name);
  else { fail++; console.log("  ✗ " + r.name + "\n      " + (r.err && r.err.stack ? r.err.stack.split("\n").slice(0, 3).join("\n      ") : r.err)); }
});
console.log("\n" + (results.length - fail) + " 通り / " + fail + " 落ち");
process.exit(fail ? 1 : 0);
