/**
 * 2.8.316 竹内さん（2026-11-27）「並べ替えやリセットや検索のあとなどはラグあるので時間猶予いれる」:
 *   ① 並べ替え（高→低）を押した後に 5〜9 秒の猶予（_lagGraceMs）を置いてから一覧へ（bulk-dl）
 *   ② リセットで空を確かめた後にも同じ猶予を置いてから次の段へ（background）
 *   ③ 猶予は固定の数字の待ちにせず、毎回揺らす（5000〜9000ms の範囲）
 *   ④ 検索後の待ち（30〜36秒）とリセットの待ち（30〜34秒）は既にあるので、ここでは増やさない（二重に足さない）
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const bd = rd("chrome-extension/bulk-dl.js");
const bg = rd("chrome-extension/background.js");
const rules = rd("app/lib/auto-procedure-rules.ts");
const sa = rd("chrome-extension/search-audit.js");
const man = JSON.parse(rd("chrome-extension/manifest.json"));

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }

console.log("\n■ 版");
ok("manifest 2.8.316", man.version === "2.8.316", man.version);
ok("page 2.8.316", /_AXLX_PAGE_VER = "2\.8\.316"/.test(rd("chrome-extension/page-script.js")));
ok("itandi page 2.8.316", /_AXLX_ITANDI_PAGE_VER = "2\.8\.316"/.test(rd("chrome-extension/itandi-page-script.js")));
ok("rules 2.8.316", /AUTO_RULES_REVIEWED_UP_TO = "2\.8\.316"/.test(rules));
ok("itandi rules 2.8.316", /ITANDI_RULES_REVIEWED_UP_TO = "2\.8\.316"/.test(rd("app/lib/auto-itandi-rules.ts")));

console.log("\n■ ③ 猶予の関数（bulk-dl・実行して範囲を確かめる）");
const i0 = bd.indexOf("function _lagGraceMs() {");
ok("bulk-dl に _lagGraceMs がある", i0 > 0);
const fnSrc = bd.slice(i0, bd.indexOf("\n  }\n", i0) + 5);
const ctx = { Math: Object.create(Math) };
vm.createContext(ctx);
vm.runInContext("var LAG_GRACE_MIN_MS = 5000, LAG_GRACE_MAX_MS = 9000;\n" + fnSrc + "\nthis._lagGraceMs = _lagGraceMs;", ctx);
let mn = Infinity, mx = -Infinity; const seen = new Set();
for (let i = 0; i < 2000; i++) { const v = ctx._lagGraceMs(); mn = Math.min(mn, v); mx = Math.max(mx, v); seen.add(v); }
ok("猶予は 5000 以上", mn >= 5000, mn);
ok("猶予は 9000 未満（上限 9000 は含まない）", mx < 9000, mx);
ok("毎回揺れる（同じ値だけにならない）", seen.size > 50, seen.size);

console.log("\n■ 同じ幅の猶予が background にもある");
const bi = bg.indexOf("function _lagGraceMs() {");
ok("background に _lagGraceMs がある", bi > 0);
const bgCtx = {};
vm.createContext(bgCtx);
const bgSrc = bg.slice(bg.indexOf("var LAG_GRACE_MIN_MS_BG"), bi + 200);
vm.runInContext(bgSrc.slice(0, bgSrc.indexOf("\n}\n") + 3) + "\nthis._lagGraceMs = _lagGraceMs;", bgCtx);
let bmn = Infinity, bmx = -Infinity;
for (let i = 0; i < 1000; i++) { const v = bgCtx._lagGraceMs(); bmn = Math.min(bmn, v); bmx = Math.max(bmx, v); }
ok("background 猶予は 5000〜8999", bmn >= 5000 && bmx < 9000, [bmn, bmx]);

console.log("\n■ ① 並べ替えの後");
const sortIdx = bd.indexOf("sort_lag_grace");
ok("並べ替えの後に sort_lag_grace を残す", sortIdx > 0);
const sortWin = bd.slice(Math.max(0, sortIdx - 400), sortIdx + 300);
ok("step の待ちは 1200 + 猶予（固定 1200 だけにしない）", /step\(1200 \+ _lagG, function \(\) \{ done\(true\); \}\);/.test(sortWin), sortWin.slice(-200));
ok("従来の固定 step(1200, done(true)) は残っていない", !/step\(1200, function \(\) \{ done\(true\); \}\);/.test(bd));

console.log("\n■ ② リセットの後");
const rIdx = bg.indexOf('_stamp("reset_lag_grace"');
ok("reset_lag_grace を残す", rIdx > 0);
const rWin = bg.slice(rIdx - 400, rIdx + 200);
ok("空の確認の後・成功を返す前に猶予を置く", /await _sleep\(_lagR\);\s*return \{ ok: true, left: 0, reset: true/.test(rWin), rWin.slice(-200));
ok("猶予は _lagGraceMs を通す（固定の数字ではない）", /var _lagR = _lagGraceMs\(\);/.test(rWin));
ok("空でない時（従来の外し）には猶予を足さない", !/reset_not_empty[\s\S]{0,10}reset_lag_grace/.test(bg));

console.log("\n■ ④ 監査の段の名前・規則");
ok("search-audit RULE_STEP に reset_lag_grace", /RULE_STEP = .*\|reset_lag_grace\|/.test(sa));
ok("規則（rules）に並べ替えの猶予（lag_grace_after_sort）", /id: "lag_grace_after_sort"/.test(rules) && /marker: "_lagGraceMs"/.test(rules) && /file: "bulk-dl\.js"/.test(rules));
ok("規則（rules）にリセットの猶予（lag_grace_after_reset）", /id: "lag_grace_after_reset"/.test(rules) && /file: "background\.js"/.test(rules));
ok("並べ替えの猶予の確認は dl:sort_lag_grace", /mustHaveAny: \["dl:sort_lag_grace"\]/.test(rules));
ok("リセットの猶予の確認は reset_lag_grace", /mustHaveAny: \["reset_lag_grace"\]/.test(rules));

console.log("\n■ ⑤ 二重に足していない（検索後・リセットの既存の待ちはそのまま）");
ok("検索後の待ち 30〜36秒は変えていない", /SORT_AFTER_SEARCH_MIN_MS = 30000/.test(bd) && /SORT_AFTER_SEARCH_MAX_MS = 36000/.test(bd));
ok("リセット後の settle 30〜34秒は変えていない", /RESET_SETTLE_MIN_MS = 30000/.test(rd("chrome-extension/background.js")) || /RESET_SETTLE_MIN_MS = 30000/.test(bg));

console.log("\n" + (fail === 0 ? "✓ 全部通過" : "✗ " + fail + " 件失敗") + "（" + (pass + fail) + " 項目）");
if (fail) process.exitCode = 1;
