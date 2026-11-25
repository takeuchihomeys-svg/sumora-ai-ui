/**
 * 2.8.288 竹内さん「並べ替えの位置把握できていないのか／検索後、時間経過してから並べ替えに移っているか確認と改善」
 *   実測（DB・2026-11-24 09:06 の一括）: rows=67 の一覧が出ていても page_display_need_press が繰り返され、並べ替えへ進まなかった。
 *   2.8.288 は「なぜ進まないか」を次の1回で記録に残す（判定は変えない＝古い一覧の並べ替えを戻さない）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
const ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8").replace(/\r\n/g, "\n");
const man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function fnSrc(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n  }\n");
  return e < 0 ? s : s.slice(0, e + 5);
}

console.log("\n■ 版");
const vOf = (s) => String(s).split(".").map(Number);
const geq288 = (v) => { const a = vOf(v), b = [2, 8, 288]; for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; } return true; };
ok("manifest = page = rules ≥2.8.288（以後の版で入れ替わっても同じ）", geq288(man.version)
  && (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] === man.version
  && (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] === man.version, man.version);

console.log("\n■ 原因の記録（動きは変えない）");
const diag = fnSrc(bd, "  function _pressGateDiag(why) {");
ok("_pressGateDiag がある", diag.length > 0);
ok("need_press の記録がこの関数を使う", /_liveDlStep\("page_display_need_press", _pressGateDiag\(why\)\)/.test(bd));
ok("判定（pressAt が無い→need_press）は据え置き", /if \(!pressAt\) \{[\s\S]{0,200}path: "need_press"/.test(bd));
ok("古い一覧の守り（nav_pending・新旧の文書）は変えていない", /if \(_isNavPending\(\)\) \{[\s\S]{0,400}path: "nav_pending"/.test(bd) && /sameDoc/.test(bd));
ok("記録の中で sessionStorage の値そのものは出さない（有無だけ）", !/getItem\([^)]*\)\s*\+\s*"/.test(diag) && /\? "1" : "0"/.test(diag));

// 実関数を偽の sessionStorage・偽の行で動かす
function run(store, rows, mem) {
  const sandbox = {
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null) },
    tracked: Array.from({ length: rows }, () => ({ btn: { isConnected: true } })),
    _searchGraspedMem: mem,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(diag + "\n__r = _pressGateDiag;", ctx);
  return (fn) => fn(ctx);
}
const r1 = run({}, 67, null)((c) => c.__r("need_press"));
ok("何も無い時: B0 S0 G0 M0 rows=67", /B0 S0 G0 M0 rows=67 need_press/.test(r1), r1);
const r2 = run({ axlx_search_press_baseline: "{\"at\":1}", axlx_search_grasped_sync: "{}" }, 3, { at: 1 })((c) => c.__r("x"));
ok("印がある時は 1 になる", /B1 S0 G1 M1 rows=3 x/.test(r2), r2);
ok("80字を超えない", run({}, 999, null)((c) => c.__r("y".repeat(200))).length <= 80);
ok("sessionStorage が壊れていても落ちない", (() => {
  const ctx = vm.createContext({ sessionStorage: { getItem() { throw new Error("denied"); } }, tracked: [], _searchGraspedMem: null });
  vm.runInContext(diag + "\n__r = _pressGateDiag;", ctx);
  return typeof ctx.__r("z") === "string";
})());

console.log("\n結果: " + pass + " 件OK / " + fail + " 件NG");
if (fail > 0) process.exitCode = 1;
