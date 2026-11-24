/**
 * 2.8.279 竹内さん「拡張ツールひらいているとき重すぎる／原因見つけて改善するようにする」の試験。
 *
 * 見つけた原因（コード＋DB の段 estate_stuck_recover・page_display_need_press・send_bar_dock）:
 *   ① 一覧を人が見ているだけでも、2秒の見回りが4.5秒ごとに「立て直し」→ 並べ替えの起動 → 行の読み直し
 *   ② 行の読み直し（_rescanRows）が毎回すべてのチェック欄を消して作り直す → 案内の見張りが一覧を読み直す
 *   ③ 印刷用PDF探し（findPrintBtns）がページの全部の文字をたどる
 *   ④ 送るボタンの枠を2秒ごとに同じ位置へ書き直し、そのたび点検へ送る
 *   ⑤ ページの変化のたびにその場で印刷用PDF を探す
 *
 *   P1 findPrintBtns: リンク・ボタンだけを見る／文書順／隠れた物は除く／入れ子は内側
 *   P2 _rescanRows: 同じ行なら作り直さない・行が変わった時だけ作り直す・チェックは残す
 *   P3 立て直しは待っている自動の仕事がある時だけ・続けて効かなければ30秒ごと
 *   P4 送るボタンの枠は置き場所が変わった時だけ書く・記録する
 *   P5 ページの変化の見張りは0.3秒にまとめる
 *   P6 重さの報告: background が chrome_extension_feedback へ送る（本物の受け手を模擬で動かす）
 *   P7 版
 */
"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var ROOT = path.join(__dirname, "..", "..");
var DL = fs.readFileSync(path.join(ROOT, "chrome-extension", "bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
var results = [];
async function scenario(name, fn) {
  try { await fn(); results.push({ name: name, ok: true }); }
  catch (e) { results.push({ name: name, ok: false, err: e }); }
}
function slice(src, a, b) {
  var i = src.indexOf(a);
  if (i < 0) throw new Error("見つからない: " + a);
  var j = src.indexOf(b, i + a.length);
  if (j < 0) throw new Error("終わりが見つからない: " + b);
  return src.slice(i, j);
}

// ── 小さな偽の画面 ────────────────────────────────
function makeDoc() {
  var stats = { created: 0, removed: 0 };
  function El(tag, text, opts) {
    this.tagName = String(tag).toUpperCase();
    this._text = text || "";
    this.children = [];
    this.parentNode = null;
    this.hidden = !!(opts && opts.hidden);
    this.className = (opts && opts.cls) || "";
    this.style = { cssText: "" };
    this.checked = false;
    this.href = (opts && opts.href) || "";
    var self = this;
    this.classList = { contains: function (c) { return String(self.className).split(/\s+/).indexOf(c) >= 0; } };
  }
  El.prototype.append = function (c) { c.parentNode = this; this.children.push(c); return c; };
  El.prototype.insertBefore = function (c, ref) { c.parentNode = this; var i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; };
  El.prototype.remove = function () { if (!this.parentNode) return; stats.removed++; var p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; };
  El.prototype.addEventListener = function () {};
  Object.defineProperty(El.prototype, "textContent", { get: function () { return this._text + this.children.map(function (c) { return c.textContent; }).join(""); } });
  Object.defineProperty(El.prototype, "isConnected", { get: function () { var n = this; while (n.parentNode) n = n.parentNode; return n === body; } });
  Object.defineProperty(El.prototype, "offsetParent", { get: function () { for (var n = this; n; n = n.parentNode) if (n.hidden) return null; return this.isConnected ? body : null; } });
  Object.defineProperty(El.prototype, "previousSibling", { get: function () { if (!this.parentNode) return null; var s = this.parentNode.children; var i = s.indexOf(this); return i > 0 ? s[i - 1] : null; } });
  function walk(root, out) { root.children.forEach(function (c) { out.push(c); walk(c, out); }); return out; }
  function match(el, sel) {
    return sel.split(",").map(function (s) { return s.trim(); }).some(function (s) {
      if (s.charAt(0) === ".") return el.classList.contains(s.slice(1));
      return el.tagName === s.toUpperCase();
    });
  }
  El.prototype.querySelectorAll = function (sel) { return walk(this, []).filter(function (e) { return match(e, sel); }); };
  El.prototype.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
  var body = new El("body");
  var doc = {
    body: body,
    createElement: function (t) { stats.created++; return new El(t); },
    querySelectorAll: function (s) { return body.querySelectorAll(s); },
  };
  return { doc: doc, El: El, body: body, stats: stats };
}
function row(D, label, opts) {
  var tr = D.body.append(new D.El("div", "", opts));
  var td = tr.append(new D.El("span", "部屋 " + label));
  var a = td.append(new D.El("a", "", { href: "https://x/print?id=" + label }));
  a.append(new D.El("span", "印刷用PDF"));
  return a;
}

function loadFns(D) {
  var code = slice(DL, "  function findPrintBtns() {", "\n  // 建物名から")
    + "\n" + slice(DL, "  function _rescanRows() {", "\n  /**\n   * ★ 2026-11-22b");
  var sb = {
    document: D.doc, tracked: [], _perfC: { find: 0, rebuild: 0, live: 0 }, _autoModeOn: false,
    updateBar: function () { sb.__updates = (sb.__updates || 0) + 1; },
    _urlKey: function (u) { return String(u); }, _reapplySentMarksIfAny: function () {},
    Set: Set,
  };
  vm.createContext(sb);
  vm.runInContext(code + "\n;globalThis.F = findPrintBtns; globalThis.R = _rescanRows;", sb);
  return sb;
}

(async function main() {
  await scenario("P1 findPrintBtns: リンク・ボタンだけ・文書順・隠れた物を除く・入れ子は内側", async function () {
    var D = makeDoc();
    var a1 = row(D, "101");
    row(D, "102", { hidden: true });
    var a3 = row(D, "103");
    D.body.append(new D.El("div", "印刷用PDF の説明（リンクではない）"));
    var outer = D.body.append(new D.El("a", ""));
    var inner = outer.append(new D.El("button", "印刷用PDF"));
    var sb = loadFns(D);
    var got = sb.F();
    assert.strictEqual(got.length, 3, "数: " + got.length);
    assert.ok(got[0] === a1 && got[1] === a3 && got[2] === inner, "文書順・隠れた行を除く・入れ子は内側");
    assert.strictEqual(sb._perfC.find, 1, "探した回数を数える");
    assert.ok(!/createTreeWalker/.test(slice(DL, "  function findPrintBtns() {", "\n  // 建物名から")), "全部の文字をたどらない");
  });

  await scenario("P2 _rescanRows: 同じ行なら作り直さない・変わった時だけ・チェックは残す", async function () {
    var D = makeDoc();
    row(D, "201"); row(D, "202"); row(D, "203");
    var sb = loadFns(D);
    sb.R();
    assert.strictEqual(sb.tracked.length, 3);
    assert.strictEqual(D.stats.created, 3, "初回は3つ作る");
    sb.tracked[1].cb.checked = true;
    var c0 = D.stats.created, r0 = D.stats.removed, u0 = sb.__updates;
    for (var i = 0; i < 20; i++) sb.R();
    assert.strictEqual(D.stats.created, c0, "同じ行なら1つも作らない: " + (D.stats.created - c0));
    assert.strictEqual(D.stats.removed, r0, "同じ行なら1つも消さない");
    assert.strictEqual(sb.__updates, u0, "枠の描き直しも呼ばない");
    assert.strictEqual(sb._perfC.rebuild, 1, "作り直しは初回の1回だけ: " + sb._perfC.rebuild);
    row(D, "204");
    sb.R();
    assert.strictEqual(sb.tracked.length, 4, "行が増えたら作り直す");
    assert.strictEqual(sb.tracked[1].cb.checked, true, "押してあったチェックは残す");
    assert.strictEqual(sb._perfC.rebuild, 2);
  });

  await scenario("P3 立て直しは待っている自動の仕事がある時だけ・効かなければ30秒ごと", async function () {
    var seg = slice(DL, "var _pendWork = false;", "} else {\n                window.__axlxEstateStuckAt = 0;");
    assert.ok(/_autoSendArmed \|\| _hasSearchPendingSync\(\)/.test(seg), "待っている仕事の判定");
    assert.ok(/_nR > 0 && !_busy && _pendWork/.test(seg), "仕事が無ければ立て直さない");
    assert.ok(/_stuckN < 6 \? 4500 : 30000/.test(seg), "6回の後は30秒ごと");
    assert.ok(/window\.__axlxEstateStuckN = 0;/.test(DL), "仕事が無くなれば数え直す");
  });

  await scenario("P4 送るボタンの枠は置き場所が変わった時だけ書く・記録する", async function () {
    var seg = slice(DL, "  function _placeSendBarVisible() {", "\n  function dockRpBar() {");
    assert.ok(/bar\.__axlxDockSig === _dockSig/.test(seg), "同じ置き場所なら戻る");
    assert.ok(/mode === "1" && bar\.__axlxDockSig === "right"/.test(seg), "右端に居れば書き直さない");
    assert.ok(/String\(bar\.style\.zIndex\) !== "2147483647"/.test(seg), "重なり順も同じなら書かない");
  });

  await scenario("P5 ページの変化の見張りは0.3秒にまとめる", async function () {
    var seg = slice(DL, "  var _obsCheckTimer = null;", "\n  function start() {");
    assert.ok(/if \(injectTimer \|\| _obsCheckTimer\) return;/.test(seg));
    assert.ok(/}, 300\);/.test(seg));
    var first = seg.indexOf("findPrintBtns()"), timer = seg.indexOf("_obsCheckTimer = setTimeout");
    assert.ok(timer >= 0 && first > timer, "数えるのはまとめた後");
  });

  await scenario("P6 重さの報告: background が chrome_extension_feedback へ送る（本物の受け手）", async function () {
    var sim = require("./lib/bulk-sim.js");
    var w = sim.createWorld({ customers: [] });
    w.startSw();
    await w.run(10);
    await w.pageSend({ type: "axlx-perf-report", text: "[perf] v2.8.279 realpro 一覧 止まり12回 計3400ms" });
    await w.run(10);
    var f = (w.fetches || []).filter(function (x) { return /chrome-extension-feedback/.test(x.url); });
    assert.strictEqual(f.length, 1, "1本送る: " + JSON.stringify(w.fetches));
    var b = JSON.parse(f[0].body);
    assert.strictEqual(b.category, "other");
    assert.strictEqual(b.site, "realpro");
    assert.ok(/^\[perf\]/.test(b.content));
    assert.ok(/axlx-perf-report/.test(DL) && /600000/.test(slice(DL, "  (function _axlxDlPerf() {", "  function _liveDlStep(")), "画面側は重い時だけ10分に1回まで");
  });

  await scenario("P7 版が揃っている", async function () {
    var man = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome-extension", "manifest.json"), "utf8"));
    var ps = fs.readFileSync(path.join(ROOT, "chrome-extension", "page-script.js"), "utf8");
    var rules = fs.readFileSync(path.join(ROOT, "app", "lib", "auto-procedure-rules.ts"), "utf8");
    assert.ok(/^2\.8\.(279|2[89]\d|[3-9]\d\d)$/.test(man.version), "manifest >= 2.8.279 got " + man.version);
    assert.ok(/_AXLX_PAGE_VER = "2\.8\.(279|2[89]\d|[3-9]\d\d)"/.test(ps));
    assert.ok(/AUTO_RULES_REVIEWED_UP_TO = "2\.8\.(279|2[89]\d|[3-9]\d\d)"/.test(rules));
  });

  var fail = 0;
  results.forEach(function (r) {
    if (r.ok) console.log("  ✓ " + r.name);
    else { fail++; console.log("  ✗ " + r.name + "\n      " + (r.err && r.err.stack ? r.err.stack.split("\n").slice(0, 4).join("\n      ") : r.err)); }
  });
  console.log("\n" + (results.length - fail) + " 通り / " + fail + " 落ち");
  process.exit(fail ? 1 : 0);
})();
