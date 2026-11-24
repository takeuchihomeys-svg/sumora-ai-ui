// 2.8.156（2026-11-22 竹内さん「スタッフモードは選択したお客さんをAIXのように検索して物件ダウンロードまで完了」）
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
function eq(name, a, b) {
  const good = JSON.stringify(a) === JSON.stringify(b);
  ok(name, good, good ? undefined : "got " + JSON.stringify(a) + " want " + JSON.stringify(b));
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

console.log("■ 2.8.156 スタッフ＝選んだ客だけ自動検索〜送付");
{
  const man = JSON.parse(read("manifest.json"));
  ok("manifest ≥2.8.156", verGe(man.version, "2.8.156"), man.version);
  ok("_AXLX_PAGE_VER ≥2.8.156", verGe((read("page-script.js").match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.156"));
}

console.log("\n■ mode-core: スタッフは選んだ客の自動を開き、一括は閉じる");
{
  const b = M.behavior("staff", false);
  const e = M.effectiveBehavior("staff", false);
  eq("behavior.aiCustomerSearch", b.aiCustomerSearch, true);
  eq("effective.aiCustomerSearch", e.aiCustomerSearch, true);
  eq("effective.autoSend", e.autoSend, true);
  eq("effective.claimCommands", e.claimCommands, false);
  eq("effective.claimAix", e.claimAix, false);
  eq("effective.runAutoSchedule", e.runAutoSchedule, false);
  eq("effective.claimBrainCommands", e.claimBrainCommands, false);
  ok("通常は aiCustomerSearch 閉じ", M.effectiveBehavior("normal", false).aiCustomerSearch === false);
  ok("AIX は従来どおり開く", M.effectiveBehavior("ai", false).aiCustomerSearch === true);
}

console.log("\n■ 案内OFF・自動押し（スタッフ）");
{
  const rg = read("realpro-guide.js");
  const ig = read("itandi-guide.js");
  const bd = read("bulk-dl.js");
  const ib = read("itandi-bulk-dl.js");
  ok("realpro-guide: スタッフなら autoModeOf true", /if \(staffOn\) return true;/.test(rg));
  ok("itandi-guide: スタッフなら autoModeOf true", /if \(staffOn\) return true;/.test(ig));
  ok("bulk-dl: スタッフなら _readAutoMode true", /if \(staffOn\) return true;[\s\S]{0,80}chosen && \(\!\!s\.aixMode/.test(bd));
  ok("itandi-bulk-dl: スタッフなら _readAutoMode true", /if \(staffOn\) return true;/.test(ib));
  ok("bulk-dl: autoPressPdfs はスタッフで止めない", !/スタッフモードでは自動で押しません/.test(bd));
  ok("bulk-dl: _maybeAutoPressOnLoad は _autoModeOn 関所", /if \(_autoPdfRun \|\| !_autoModeOn\) return;/.test(bd));
}

console.log("\n■ popup: スタッフも条件画面はボタン待ち（2.8.159・自動 click しない）");
{
  const pj = read("popup.js");
  const html = read("popup.html");
  ok("スタッフ or AIX で案内関数を呼ぶ（realpro）", /\(_aiCustomerModeOn \|\| _staffModeOn\)/.test(pj) && /_maybeAiCustomerAutoSearch\(autofillBtn/.test(pj));
  ok("スタッフでも btn.click しない", !/スタッフモード: 選んだお客様[\s\S]{0,500}btn\.click\(\)/.test(pj));
  ok("AIX／スタッフともボタン待ち案内", /ボタンを押してから検索します/.test(pj));
  ok("_isAutoModeNow に staff", /m === \"staff\"/.test(pj) && /function _isAutoModeNow/.test(pj));
  ok("HTML にスタッフ（選んだお客さん）", /スタッフ（選んだお客さん）/.test(html));
  ok("HTML に staff option は1つ", (html.match(/<option value=\"staff\">/g) || []).length === 1);
}

console.log("\n結果: pass=" + pass + " fail=" + fail);
process.exit(fail ? 1 : 0);
