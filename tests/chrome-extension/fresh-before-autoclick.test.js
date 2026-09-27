// 2026-09-27 v2.5.30: 自動の検索は、押す前に登録の条件の読み直し（fetchFreshCustomer）が欄に入るのを待つ／
//   件数の分からない完了（送信エラー等）を「0件」とグループに言わない。
// YUMA の実検索（search_audits 22）で、アプリで条件を変えた直後のブレインの検索が古い条件（西区・大正区・7.5万・1K/1DK・築30年）で
//   入力され、送信エラーの後に「🔍【物件0件】」が出た（34件は送れていた）。
// 実行: node tests/chrome-extension/fresh-before-autoclick.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

(async () => {
  const popup = read("popup.js");
  const bg = read("background.js");

  console.log("■ ① 読み直しを約束で持つ（3サイト）");
  const opens = popup.match(/_freshPreloadPromise = fetchFreshCustomer\(/g) || [];
  ok("itandi・リアプロ・レインズの3か所で読み直しを約束にする", opens.length === 3);
  ok("旧: 約束にしない読み直し（fetchFreshCustomer(...).then を捨てる形）が残っていない", !/\n\s+fetchFreshCustomer\([^)]*\)\.then\(fresh =>/.test(popup));
  ok("openInstructions の頭で前の約束を消す", /selectedSite = siteKey;\r?\n\s+_freshPreloadPromise = null;/.test(popup));
  const reloads = popup.match(/_withRestoreSuppressed\(_supAtOpen_(it|rp|rn), \(\) => \{\r?\n\s+preloadAdjForm/g) || [];
  ok("読み直しの後の欄の作り直しは、開いた時の「復元しない」を守る（3か所）", reloads.length === 3);

  console.log("\n■ ② 自動で押す経路は押す前に待つ（background の切替・underbar の中継）");
  const waits = popup.match(/if \(!\(await _awaitFreshPreload\(6000\)\)\) console\.warn/g) || [];
  ok("2つの受け口（runtime.onMessage／postMessage）で待つ", waits.length === 2);
  for (const [label, open] of [["runtime.onMessage", "try { openInstructions(msg.site); }"], ["postMessage", "try { openInstructions(e.data.site); }"]]) {
    const i = popup.indexOf(open), w = popup.indexOf("await _awaitFreshPreload(6000)", i), click = popup.indexOf("aBtn.click()", i);
    ok(`${label}: 開く → 待つ → 押す の順`, i > 0 && w > i && click > w);
    const mode = popup.indexOf("btn-mode-station", i);
    ok(`${label}: 待つのは地域/駅の軸を押すより前（読み直しの作り直しで軸が戻らない）`, w < mode);
  }

  console.log("\n■ ③ 待ち方（関数を取り出して動かす）");
  const grab = (name) => { const s = popup.indexOf(name); let d = 0, j = popup.indexOf("{", s); for (; j < popup.length; j++) { if (popup[j] === "{") d++; else if (popup[j] === "}") { d--; if (d === 0) break; } } return popup.slice(s, j + 1); };
  const ctx = { setTimeout, Promise, _adjRestoreSuppressed: false, _freshPreloadPromise: null, log: [] };
  vm.createContext(ctx);
  vm.runInContext("var _adjRestoreSuppressed = false; var _freshPreloadPromise = null;\n" + grab("function _withRestoreSuppressed(") + "\n" + grab("async function _awaitFreshPreload("), ctx);
  ok("約束が無い時はすぐ false（今まで通り押す）", (await vm.runInContext("_awaitFreshPreload(50)", ctx)) === false);
  vm.runInContext("_freshPreloadPromise = new Promise((r) => setTimeout(r, 30))", ctx);
  ok("読み直しが終われば true", (await vm.runInContext("_awaitFreshPreload(1000)", ctx)) === true);
  vm.runInContext("_freshPreloadPromise = new Promise(() => {})", ctx);
  const t0 = Date.now();
  ok("読み直しが返らない時は期限で false（止まらない）", (await vm.runInContext("_awaitFreshPreload(80)", ctx)) === false && Date.now() - t0 < 1000);
  vm.runInContext("_freshPreloadPromise = Promise.reject(new Error('x'))", ctx);
  ok("読み直しの失敗は false（投げない）", (await vm.runInContext("_awaitFreshPreload(200)", ctx)) === false);
  ok("復元しないの印は中で立ち、終わったら元に戻る", vm.runInContext("var seen; _withRestoreSuppressed(true, () => { seen = _adjRestoreSuppressed; }); [seen, _adjRestoreSuppressed].join()", ctx) === "true,false");
  ok("印を立てない時は変えない", vm.runInContext("var seen2; _withRestoreSuppressed(false, () => { seen2 = _adjRestoreSuppressed; }); String(seen2)", ctx) === "false");
  ok("中で投げても印は元に戻る", vm.runInContext("try { _withRestoreSuppressed(true, () => { throw new Error('y'); }); } catch (_) {} String(_adjRestoreSuppressed)", ctx) === "false");

  console.log("\n■ ④ 件数の分からない完了を「0件」と言わない（background）");
  ok("件数が無い完了は countUnknown", /_scrapeLastOutcome\.countUnknown = !\(batchDone && batchDone\.propertyCount != null\);/.test(bg));
  ok("1パスの0件の知らせは件数が分かる時だけ", /if \(_propCount === 0 && !_scrapeLastOutcome\.countUnknown && !\(batchDone && batchDone\.timedOut\)/.test(bg));
  ok("2パス（both）の集計も件数の分からないパスがあれば0件と言わない", /_totalPassCount === 0 && _passCountUnknown === 0 && customer\.customer_name/.test(bg) && /_scrapeLastOutcome\.countUnknown\) _passCountUnknown\+\+/.test(bg));
  const bulk = read("bulk-dl.js");
  ok("bulk-dl の送信エラーは件数を付けない（＝分からない）のまま", /audit: _auditResult\(state, \{ send_error: String\(errMsg2\)/.test(bulk) && !/propertyCount: state\.sentCount \|\| 0, audit: _auditResult\(state, \{ send_error/.test(bulk));

  console.log("\n■ ⑤ 版");
  const manifest = JSON.parse(read("manifest.json"));
  ok("manifest の版 2.5.30 以上", manifest.version.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0) >= 2005030);
  const { execFileSync } = require("child_process");
  for (const f of ["popup.js", "background.js"]) { let good = true; try { execFileSync(process.execPath, ["--check", path.join(EXT, f)], { stdio: "pipe" }); } catch (_) { good = false; } ok(`node --check ${f}`, good); }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
