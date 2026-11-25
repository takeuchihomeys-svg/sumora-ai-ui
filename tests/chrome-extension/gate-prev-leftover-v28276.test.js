/**
 * 2.8.276 次のお客さんに移る時、前のお客さんの条件が残ったまま検索しない
 *   （2026-11-24 竹内さん「前のお客さんの条件を外して新しいお客さんの条件を入れていなかった／前の条件で検索してしまった」）
 *
 * 関所（_axGateCheck）は旧「次のお客さんが指定した項目」だけを画面と比べていた。
 * 指定しない項目（家賃の上下限・築年・徒歩）に前のお客さんの値が残っても通り、前の条件で検索できた。
 */
"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var ROOT = path.join(__dirname, "..", "..");
function read(p) { return fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n"); }
var ps = read("chrome-extension/page-script.js");

/** 関数1つを本物のソースから切り出して動かす */
function load(names) {
  var code = names.map(function (n) {
    var a = ps.indexOf("  function " + n + "(");
    assert.ok(a >= 0, n + " が見つからない");
    var b = ps.indexOf("\n  }\n", a);
    return ps.slice(a, b + 5);
  }).join("\n");
  var sb = {};
  vm.createContext(sb);
  vm.runInContext(code + "\nthis.__f = { " + names.map(function (n) { return n + ": " + n; }).join(", ") + " };", sb);
  return sb.__f;
}

var results = [];
function t(name, fn) { try { fn(); results.push({ name: name, ok: true }); } catch (e) { results.push({ name: name, ok: false, err: e }); } }

var F = load(["_axLeftoverFields", "_axNoneValueOf"]);
function names(a) { return a.map(function (x) { return x.name; }).join(","); }

t("次のお客さんが家賃の下限を指定しない・画面に前の6万が残っている → 前の条件が残っている", function () {
  var r = F._axLeftoverFields({ rentMin: null, rentMax: "107000", age: null, walk: "15" }, { rent_min: "60000", rent_max: "107000", age: "-1", walk: "15" });
  assert.strictEqual(names(r), "rental_cost1");
  assert.strictEqual(r[0].got, "60000");
});

t("次のお客さんが徒歩を指定しない・画面に前の7分が残っている → 残り", function () {
  var r = F._axLeftoverFields({ rentMin: "80000", rentMax: "107000", age: null, walk: null }, { rent_min: "80000", rent_max: "107000", age: "-1", walk: "7" });
  assert.strictEqual(names(r), "required_time");
});

t("築年・家賃上限も同じ見方で複数返す", function () {
  var r = F._axLeftoverFields({ rentMin: null, rentMax: null, age: null, walk: null }, { rent_min: "60000", rent_max: "80000", age: "10", walk: "7" });
  assert.strictEqual(names(r), "rental_cost1,rental_cost2,structured_date,required_time");
});

t("画面も「指定なし」（-1・空・0）なら残りなし", function () {
  [["-1", "-1", "-1", ""], ["", "", "", ""], ["0", "0", "0", "0"]].forEach(function (v) {
    var r = F._axLeftoverFields({ rentMin: null, rentMax: null, age: null, walk: null }, { rent_min: v[0], rent_max: v[1], age: v[2], walk: v[3] });
    assert.strictEqual(r.length, 0, JSON.stringify(v));
  });
});

t("次のお客さんが指定した項目は、ここでは見ない（値の食い違いは従来の比べが担当）", function () {
  var r = F._axLeftoverFields({ rentMin: "80000", rentMax: "107000", age: "10", walk: "15" }, { rent_min: "60000", rent_max: "80000", age: "5", walk: "7" });
  assert.strictEqual(r.length, 0);
});

t("期待が空・画面が空 → 何も返さない（例外にしない）", function () {
  assert.strictEqual(F._axLeftoverFields(null, { rent_min: "60000" }).length, 0);
  assert.strictEqual(F._axLeftoverFields({ rentMin: null }, null).length, 0);
});

t("_axNoneValueOf: 「指定なし」の option の値を返す", function () {
  var sel = { options: [{ value: "-1", textContent: "下限なし" }, { value: "60000", textContent: "6.0万" }] };
  assert.strictEqual(F._axNoneValueOf(sel), "-1");
  var sel2 = { options: [{ value: "x", textContent: " 指定なし " }, { value: "5", textContent: "5年" }] };
  assert.strictEqual(F._axNoneValueOf(sel2), "x");
  assert.strictEqual(F._axNoneValueOf({ options: [{ value: "5", textContent: "5年" }] }), null);
  assert.strictEqual(F._axNoneValueOf(null), null);
});

t("配線: 関所が残りを見て errors に足す・入れ直しで戻す・4か所の判定すべてで止める側", function () {
  assert.ok(/_axLeftoverFields\(_axExpect, _lfRead\)/.test(ps), "関所が呼ぶ");
  assert.ok(/out\.prevLeftover = _lf/.test(ps) && /'前の条件が残っている（'/.test(ps), "errors に足す");
  assert.ok(/_gate\.prevLeftover && _gate\.prevLeftover\.length/.test(ps) && /_axResetLeftoverField\(lf\)/.test(ps), "入れ直しで指定なしに戻す");
  var hard = ps.match(/s\.indexOf\('前の条件が残っている'\) === 0/g) || [];
  assert.strictEqual(hard.length, 4, "止める側の判定（関所の本線・1800秒・控え保険・長待ち）の4か所: " + hard.length);
  var au = read("chrome-extension/search-audit.js");
  assert.ok(/page:gate_prev_leftover\|page:gate_stop_basic\|/.test(au), "点検の段に残る");
});

t("版: page-script と manifest が同じで 2.8.276 以上", function () {
  var man = JSON.parse(read("chrome-extension/manifest.json"));
  var m = /_AXLX_PAGE_VER = "([\d.]+)"/.exec(ps);
  assert.strictEqual(m && m[1], man.version);
  var p = man.version.split(".").map(Number);
  assert.ok(p[0] > 2 || (p[0] === 2 && (p[1] > 8 || (p[1] === 8 && p[2] >= 276))), man.version);
});

var fail = 0;
results.forEach(function (r) {
  if (r.ok) console.log("  ✓ " + r.name);
  else { fail++; console.log("  ✗ " + r.name + "\n      " + (r.err && r.err.stack ? r.err.stack.split("\n").slice(0, 3).join("\n      ") : r.err)); }
});
console.log("\n" + (results.length - fail) + " 通り / " + fail + " 落ち");
process.exit(fail ? 1 : 0);
