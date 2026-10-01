// 実行: node tests/chrome-extension/fill-gate.test.js
// v2.5.50（2026-09-30 竹内「なんで 2LDK でピックアップするとお客さんに伝えているのに、1K でピックアップしているのか」）
//   c さん（2LDK・14万・中央区／浪速区）: popup が「顧客が見つからない」→ 代わりの直接入力 → 間取りが1つも入らないまま検索 → 1K・1DK を50件。
//   ① 検索を押す前の関所（入れるはずの間取りが画面に無ければ1回入れ直し、だめなら検索しない）
//   ② 止めた合図（gate）は content.js が error で中継・bulk-dl は構えない ③ popup は一覧を取り直してから探す
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
function ok(name, c) { c ? pass++ : fail++; console.log((c ? "  ✓ " : "  ✗ ") + name); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
const ps = read("page-script.js"), ct = read("content.js"), bd = read("bulk-dl.js"), pp = read("popup.js"), bg = read("batch-guard.js");
const G = require("../../chrome-extension/batch-guard.js");

console.log("\n■ 検索を押す前の関所（page-script.js）");
{
  const cs = ps.slice(ps.indexOf("function clickSearch()"), ps.indexOf("function clickSearch()") + 2600);
  ok("clickSearch が関所（_axGateMissing）を検索の前に見る", cs.indexOf("_axGateMissing()") > 0 && cs.indexOf("_axGateMissing()") < cs.indexOf("div.go_search"));
  ok("1回だけ入れ直す（gate_retry・間取りをもう一度入れる）", /_axGateRetried = true;[\s\S]{0,200}setCheckboxes\("room_layout_id\[\]", _axExpect\.layoutVals\)/.test(cs));
  ok("だめなら検索せず、gate 付きで fill-done を返す", /notifyDone\('AXLX_FILL_INCOMPLETE: ' \+ gateMiss, true\);\s*return;/.test(cs));
  ok("止めた時は検索のボタンを押さない（return が go_search より前）", cs.indexOf("AXLX_FILL_INCOMPLETE") < cs.indexOf("goDivs[i].click()"));
  ok("関所の材料は入れるはずの間取りがある時だけ置く", /if \(vals\.length\) \{\s*setCheckboxes\("room_layout_id\[\]", vals\);\s*_axExpect = \{ layoutVals: vals\.slice\(\)/.test(ps));
  ok("お客様ごとに材料を置き直す（fillRealpro の最初で消す）", /_axExpect = null; _axGateRetried = false;/.test(ps));
  ok("画面でチェックの付いた間取りを数える", /input\[name="room_layout_id\[\]"\]:checked/.test(ps));
  ok("notifyDone が gate を載せる", /function notifyDone\(errMsg, gate\)[\s\S]{0,500}if \(gate\) msg\.gate = true;/.test(ps));
  ok("全角の間取り（２K）を半角にそろえてから読む", /var fpStr = String\(cond\.floor_plan\)\.replace\(\/\[Ａ-Ｚａ-ｚ０-９\]\/g/.test(ps));
}

console.log("\n■ 止めた合図の通り道");
{
  ok("content.js: gate の時だけ error で中継（ふだんは pageError のまま）", /error: e\.data\.gate \? \(e\.data\.error \|\| "AXLX_FILL_INCOMPLETE"\) : null/.test(ct) && /pageError: e\.data\.error \|\| null/.test(ct));
  const h = bd.slice(bd.indexOf('if (!e.data || e.data.from !== "aixlinx-fill-done") return;'));
  ok("bulk-dl.js: gate の合図では構えない（armed にしない）", h.indexOf("if (e.data.gate)") > 0 && h.indexOf("if (e.data.gate)") < h.indexOf("_autoSendArmed = true"));
  ok("失敗の知らせに理由が出る", /検索していません/.test(G.failureNotice({ customerName: "c", site: "realnetpro", error: "page-script側エラー（スキップ）: AXLX_FILL_INCOMPLETE: 間取り（2LDK）が画面に入っていない" }) || ""));
}

console.log("\n■ popup: 一覧に居ないお客様は取り直してから探す");
{
  const fn = pp.slice(pp.indexOf("async function _openAndClickAutofill(d, o)"), pp.indexOf("async function _openAndClickAutofill(d, o)") + 2200);
  ok("見つからなければ loadCustomers(true) で取り直してもう1回探す", /if \(!c && d\.customerId\) \{[\s\S]{0,200}await loadCustomers\(true\)/.test(fn));
  ok("取り直しても居なければ customer-not-found", /reason: "customer-not-found"/.test(fn));
  const mf = JSON.parse(read("manifest.json"));
  ok("manifest の版 2.5.57", mf.version === "2.5.57");
}

console.log("\n■ v2.5.57 ITANDI の広げて検索は築年数も＋5年（リアプロと同じ）");
{
  const it = pp.slice(pp.indexOf("rent_max:        itandiEffectiveRentMax,"), pp.indexOf("rent_max:        itandiEffectiveRentMax,") + 1200);
  ok("ITANDI の条件: 広げての時だけ築年数を＋5年", it.includes('return searchMode === "wide" ? baseAge + 5 : baseAge;'));
  ok("築年数の希望が無い人は指定なしのまま", it.includes("if (!baseAge) return null;"));
  ok("リアプロは今まで通り＋5年", pp.includes('searchMode === "wide" ? adjC.building_age + 5 : adjC.building_age'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
