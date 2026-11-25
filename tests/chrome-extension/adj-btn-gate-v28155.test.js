// 2.8.155（2026-11-22 竹内さん「ここでボタン押してから検索するようにする。このページに移行した瞬間に途中で検索はじまってしまう」）
// 条件画面（adj）を開いただけでは検索を始めない。🔍ボタン押下／自動便の automated だけが開始。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
function ok(name, c, extra) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + String(extra).slice(0, 200) : "")); }
}
function verGe(v, want) {
  const a = String(v || "").split(".").map(Number);
  const b = String(want || "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

console.log("■ 2.8.155 条件画面はボタン押してから検索");
{
  const pj = read("popup.js");
  const man = JSON.parse(read("manifest.json"));
  ok("manifest ≥2.8.155", verGe(man.version, "2.8.155"), man.version);
  ok("_AXLX_PAGE_VER ≥2.8.155", verGe((read("page-script.js").match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.155"));
  ok("_maybeAiCustomerAutoSearch が残っている（案内用）", /function _maybeAiCustomerAutoSearch\(btn, customer, site\)/.test(pj));
  ok("条件画面オープン後に案内を呼ぶ（realpro）", /_maybeAiCustomerAutoSearch\(autofillBtn, c0, \"realpro\"\)/.test(pj));
  ok("条件画面オープン後に案内を呼ぶ（itandi）", /_maybeAiCustomerAutoSearch\(_itBtn, selectedCustomer, \"itandi\"\)/.test(pj));
  // AIX／スタッフともボタン待ち（2.8.159）
  ok("AIX／スタッフともボタン待ちの案内", /ボタンを押してから検索します/.test(pj));
  ok("条件画面では btn.click しない（_maybeAiCustomerAutoSearch）", !/function _maybeAiCustomerAutoSearch[\s\S]{0,1200}?btn\.click\(\)/.test(pj));
  ok("ボタン待ちの案内文がある", /ボタンを押して/.test(pj));
  ok("2026-11-22 の決定コメントがある", /ボタン押してから検索/.test(pj));
  ok("onclick は残っている（人が押す道）", /autofillBtn\.onclick = async \(\) => \{/.test(pj));
  ok("自動便の automated クリック道は残っている", /aBtn\.dataset\.automated = \"1\"/.test(pj) && /aBtn\.click\(\)/.test(pj));
}

console.log("\n結果: pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
