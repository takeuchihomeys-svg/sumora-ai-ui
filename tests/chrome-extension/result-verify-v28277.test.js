/**
 * 2.8.277 結果ページの見出し照合（result-verify.js）
 *   前客の条件で検索した一覧を見つける／正常な一覧・読めない見出しでは止めない（誤検知0）
 */
"use strict";
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var RV = require("../../chrome-extension/result-verify.js");

var results = [];
function t(name, f) { try { f(); results.push({ name: name, ok: true }); } catch (e) { results.push({ name: name, ok: false, err: e }); } }

// なおき: 8〜10.7万・徒歩15・築指定なし / 大村: 6〜8万・徒歩7・築7
var NAOKI = { rentMin: "80000", rentMax: "107000", walk: "15", age: null, updateDays: "1" };
var OMURA = { rentMin: "60000", rentMax: "80000", walk: "7", age: "7", updateDays: "1" };
var ROWS = " 部屋名 更新日 Luxe新大阪2 住所：大阪市淀川区 沿線：御堂筋線「新大阪」徒歩10分 賃料 85,000円 ";

t("なおきの条件どおりの見出し → ok", function () {
  var r = RV.verify("大阪 36棟 46戸 並べ替え 家賃 8万～10.7万 / 徒歩15分 / 2LDK-3LDK / 更新1日以内" + ROWS, NAOKI);
  assert.strictEqual(r.verdict, "ok", JSON.stringify(r.diffs));
});

t("前客（大村 6〜8万・徒歩7・築7）の見出しで、なおきの検索結果として来た → mismatch（家賃・徒歩・築年）", function () {
  var r = RV.verify("大阪 36棟 46戸 家賃 6万～8万 / 徒歩7分 / 築7年以内 / 更新1日以内" + ROWS, NAOKI);
  assert.strictEqual(r.verdict, "mismatch");
  assert.ok(r.diffs.some(function (d) { return /家賃の上限が違う/.test(d); }), r.diffs.join(","));
  assert.ok(r.diffs.some(function (d) { return /家賃の下限が違う/.test(d); }));
  assert.ok(r.diffs.some(function (d) { return /徒歩が違う/.test(d); }));
  assert.ok(r.diffs.some(function (d) { return /築年が残っている/.test(d); }), r.diffs.join(","));
});

t("次の客が家賃・徒歩を指定しないのに、前客の値が見出しに残る → mismatch（希望に無い）", function () {
  var r = RV.verify("大阪 50棟 70戸 家賃 ～8万 / 徒歩7分" + ROWS, { rentMin: null, rentMax: null, walk: null });
  assert.strictEqual(r.verdict, "mismatch");
  assert.strictEqual(r.diffs.length, 2, r.diffs.join(","));
});

t("全件（16387棟）→ full（条件が効いていない）", function () {
  var r = RV.verify("大阪 16387 棟 38966 戸 並べ替え 表示棟数" + ROWS, NAOKI);
  assert.strictEqual(r.verdict, "full");
});

t("誤検知0: 一覧の行の『徒歩10分』『賃料85,000円』を見出しとして拾わない", function () {
  var r = RV.verify("大阪 36棟 46戸 並べ替え" + ROWS + " 徒歩3分 家賃 5万～6万", NAOKI);
  assert.strictEqual(r.verdict, "unknown", JSON.stringify(r.parsed));
  assert.strictEqual(r.diffs.length, 0);
});

t("誤検知0: 見出しから何も読めない → unknown（止める根拠にしない）", function () {
  var r = RV.verify("大阪 36棟 46戸 並べ替え", NAOKI);
  assert.strictEqual(r.verdict, "unknown");
  var r2 = RV.verify("", NAOKI);
  assert.strictEqual(r2.verdict, "unknown");
});

t("丸め: 希望10.7万 → 画面は10.5万／徒歩12 → 15 は許す（刻みの誤差）", function () {
  var r = RV.verify("大阪 20棟 30戸 家賃 8万～11万 / 徒歩15分" + ROWS, { rentMin: "80000", rentMax: "107000", walk: "12" });
  assert.strictEqual(r.verdict, "ok", r.diffs.join(","));
});

t("家賃が円表記・全角数字・カンマでも読める", function () {
  var r = RV.verify("大阪 20棟 30戸 家賃 ８０，０００円～１０７，０００円 / 徒歩１５分" + ROWS, NAOKI);
  assert.strictEqual(r.verdict, "ok", JSON.stringify(r.parsed));
  assert.strictEqual(r.parsed.rentMin, 80000);
  assert.strictEqual(r.parsed.rentMax, 107000);
});

t("上限だけ・下限だけ・『下限なし～』", function () {
  assert.strictEqual(RV.parseHead("家賃 ～10.5万 / 徒歩15分" + ROWS).rentMax, 105000);
  assert.strictEqual(RV.parseHead("家賃 ～10.5万 / 徒歩15分" + ROWS).rentMin, null);
  assert.strictEqual(RV.parseHead("賃料 8万～ / 更新1日以内" + ROWS).rentMin, 80000);
  assert.strictEqual(RV.parseHead("家賃 下限なし～10万" + ROWS).rentMax, 100000);
  assert.strictEqual(RV.parseHead("家賃 10万以下" + ROWS).rentMax, 100000);
});

t("brief は80字以内", function () {
  var r = RV.verify("大阪 36棟 46戸 家賃 6万～8万 / 徒歩7分 / 築7年以内 / 更新1日以内" + ROWS, NAOKI);
  assert.ok(RV.brief(r).length <= 80, RV.brief(r));
});

// ── 配線（ソースの形） ─────────────────────────
var ext = path.join(__dirname, "..", "..", "chrome-extension");
var read = function (f) { return fs.readFileSync(path.join(ext, f), "utf8").replace(/\r\n/g, "\n"); };
t("manifest: result-verify.js が bulk-dl.js より前で読み込まれる", function () {
  var m = read("manifest.json");
  var i = m.indexOf('"result-verify.js"');
  assert.ok(i > 0, "manifest に無い");
  assert.ok(i < m.indexOf('"bulk-dl.js"', i - 400), "bulk-dl.js より後ろ");
});
t("search-audit.js: 点検の段の残し方に result_verify と leftover_ が入っている", function () {
  var s = read("search-audit.js");
  assert.ok(/dl:result_verify/.test(s) && /page:leftover_/.test(s));
});
t("page-script.js: 検索を押す時に希望を sessionStorage へ残す", function () {
  var s = read("page-script.js");
  assert.ok(/axlx_result_expect/.test(s));
});
t("bulk-dl.js: 結果ページで照合する（記録・警告）", function () {
  var s = read("bulk-dl.js");
  assert.ok(/_resultVerifyOnce/.test(s) && /AxlxResultVerify/.test(s) && /result_verify/.test(s));
});

var fail = 0;
results.forEach(function (r) {
  if (r.ok) console.log("  ✓ " + r.name);
  else { fail++; console.log("  ✗ " + r.name + "\n      " + (r.err && r.err.stack ? r.err.stack.split("\n").slice(0, 3).join("\n      ") : r.err)); }
});
console.log("\n" + (results.length - fail) + " 通り / " + fail + " 落ち");
process.exit(fail ? 1 : 0);
