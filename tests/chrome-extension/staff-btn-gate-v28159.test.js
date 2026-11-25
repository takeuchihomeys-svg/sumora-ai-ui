// 2.8.159（2026-11-22 竹内さん「スタッフモードの部分も…ボタン押さなくても自動で…検索はじまってしまう。ここまちゃんとボタン押して検索はじまるようにする」）
// スタッフも AIX と同じく条件画面はボタン待ち。押したあとの送付自動は残す。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
const M = require(path.join(dir, "mode-core.js"));

let pass = 0, fail = 0;
function ok(name, c, extra) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + String(extra).slice(0, 240) : "")); }
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

console.log("■ 2.8.159 スタッフも条件画面はボタン押してから検索");
{
  const man = JSON.parse(read("manifest.json"));
  const pj = read("popup.js");
  ok("manifest ≥2.8.159", verGe(man.version, "2.8.159"), man.version);
  ok("_AXLX_PAGE_VER ≥2.8.159", verGe((read("page-script.js").match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.159"));
  ok("AIX または スタッフで案内", /_waitBtn = !!_aiCustomerModeOn \|\| !!_staffModeOn/.test(pj));
  ok("スタッフでも btn.click しない", !/スタッフモード: 選んだお客様[\s\S]{0,500}btn\.click\(\)/.test(pj));
  ok("_maybeAiCustomerAutoSearch 内に btn.click が無い", !/function _maybeAiCustomerAutoSearch[\s\S]*?^\}/m.test(pj) || !/function _maybeAiCustomerAutoSearch[\s\S]{0,1200}?btn\.click\(\)/.test(pj));
  ok("ボタン待ちの案内文", /ボタンを押してから検索します/.test(pj) && /開いただけでは検索しません/.test(pj));
  ok("スタッフ／AIX どちらも案内ログ", /_modeJa \+ \"モード: 条件画面を開きました\"/.test(pj) || /スタッフ\" : \"AIX\"/.test(pj));
  ok("押したあとの送付自動は残す（staff autoSend）", M.effectiveBehavior("staff", false).autoSend === true);
  ok("一括・自動便はスタッフで閉じたまま", M.effectiveBehavior("staff", false).claimCommands === false);
  ok("bulk-dl はスタッフで自動押し可（押したあと）", /if \(staffOn\) return true;/.test(read("bulk-dl.js")));
}

console.log("\n結果: pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
