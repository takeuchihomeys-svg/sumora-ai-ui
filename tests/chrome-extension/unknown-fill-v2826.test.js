// 2.8.126 audit 1533→1535: 番号なしの入力中（人の手動の単発）を一括が壊さない
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "..", "chrome-extension");
const H = require(path.join(root, "customer-handoff.js"));
const rd = (f) => fs.readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " :: " + d : "")); } }
ok("入力中でない → go", H.tabHandoffDecision({ fillRunning: false }, "B", 0) === "go");
ok("同じお客さんの入力中 → go", H.tabHandoffDecision({ fillRunning: true, fillCustomerId: "B" }, "B", 0) === "go");
ok("別のお客さんの入力中 → wait", H.tabHandoffDecision({ fillRunning: true, fillCustomerId: "A" }, "B", 1000) === "wait");
ok("★番号なしの入力中（人の単発）→ 待つ（旧は go で壊した）", H.tabHandoffDecision({ fillRunning: true, fillCustomerId: null }, "B", 1000) === "wait");
ok("番号なしだけは3分で諦めて go（古い印で永久に待たない）", H.tabHandoffDecision({ fillRunning: true, fillCustomerId: null }, "B", 3 * 60 * 1000 + 1) === "go");
ok("別のお客さんの入力中は10分待つ（従来どおり）", H.tabHandoffDecision({ fillRunning: true, fillCustomerId: "A" }, "B", 5 * 60 * 1000) === "wait" && H.tabHandoffDecision({ fillRunning: true, fillCustomerId: "A" }, "B", 10 * 60 * 1000 + 1) === "give_up");
ok("これから始めるお客さんの番号が無い時は従来どおり go", H.tabHandoffDecision({ fillRunning: true, fillCustomerId: null }, "", 0) === "go");
const bg = rd("background.js");
ok("background: 読み直しの前に番号なしの入力中なら見送る（reload_skip_unknown_fill）", /if \(!_probeBeforeReload\.fillCustomerId\) \{[\s\S]{0,300}reload_skip_unknown_fill[\s\S]{0,300}AXLX_OTHER_FILL_RUNNING/.test(bg));
ok("background: 見送りは _ensureRealproTab（読み直し）より前", (() => { const iSkip = bg.indexOf("reload_skip_unknown_fill"); const m = /tab = await _ensureRealproTab\(\s*tab,\s*auditRun,\s*_lastWhy/.exec(bg); /* 2.8.313: 呼びが引数ごとに改行された形に変わった（読み直しの呼び＝やり直しの _ensureRealproTab）。位置の前後を見る */ return iSkip > 0 && !!m && iSkip < m.index; })());
ok("popup が customerId を autofill に載せる", /action: "autofill",[\s\S]{0,400}customerId: \(c && c\.id\) \? String\(c\.id\) : null/.test(rd("popup.js")));
ok("underbar が customerId をページへ転送する", /from: "aixlinx-fill", conditions: e\.data\.conditions, customerId: e\.data\.customerId \|\| null/.test(rd("underbar.js")));
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
