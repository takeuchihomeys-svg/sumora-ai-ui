// 実行: node tests/chrome-extension/area-verify-wait-v2785.test.js
//
// 2026-11-15 **実測で見つけた「自動モードが必ず止まる」原因**を固定する。
//
//   点検記録（まりあ・2.7.79・10:49）:
//     page:ward_by_code ×8 → ward_verify_fail「欲しい3区・入った0区・足りない3」
//     → AXLX_AREA_MISMATCH: 地域がそろいません → 中止
//
//   なぜ8回とも「入った0区」だったか:
//     ① `clickWardPrecise` は **キューに積むだけ**（人が押す速さで1つずつ・1区 620〜1400ms＋迷い）
//     ② なのに確認は **620ms 後に1回**だけ（`setTimeout(..., 620)`）
//     ③ 3区なら押し終わるまで **約3〜6秒**（迷いや長い停止が入ればもっと）
//     ④ 押し終わる前に「そろっていない」と判定 → また積む → 8回×620ms≒5秒で打ち切り
//   → **1区も押せていないのに「地域がそろいません」で止まっていた**。
//
//   直し方: 時間で決めるのをやめ、**キューが空になるまで待つ**（whenClickQueueIdle）。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 500) : "")); }
}

const ps = read("page-script.js");
const iWard = ps.indexOf("function doAfterWard()");
const wardFn = ps.slice(iWard, iWard + 6000);

console.log("■ ① 押し終わるまで待つ（時間で決めない）");
{
  ok("doAfterWard がある", iWard > 0);
  ok("キューが空になるまで待つ（whenClickQueueIdle）", /whenClickQueueIdle\(function \(\) \{ setTimeout\(function \(\) \{ _verifyThenConfirm\(n\)/.test(wardFn));
  ok("積んだ後もキューが空になるまで待つ", /whenClickQueueIdle\(function \(\) \{ setTimeout\(function \(\) \{ _verifyThenConfirm\(n \+ 1\)/.test(wardFn));
  ok("⚠ 旧の「620ms で決めつける」が消えている", !/setTimeout\(function \(\) \{ _verifyThenConfirm\(n \+ 1\); \}, 620 \+ Math\.floor/.test(wardFn));
  ok("押している最中は数えない（isClickQueueBusy）", /if \(isClickQueueBusy\(\)\)/.test(wardFn));
}

console.log("\n■ ② 打ち切りは「時間」と「回数」の両方で守る（無限に待たない）");
{
  ok("上限の時間がある（MAX_MS）", /var MAX_MS = 45000;/.test(wardFn));
  ok("押し直しは2回まで（MAX_RETRY）", /var MAX_RETRY = 2;/.test(wardFn));
  ok("上限を超えたら理由を残して止まる（黙って止まらない）", /AXLX_AREA_MISMATCH: ' \+ msg0/.test(wardFn) || /notifyDone\('AXLX_AREA_MISMATCH: ' \+ msg0\)/.test(wardFn));
  ok("何秒待ったかを記録に残す", /Math\.round\(elapsed \/ 1000\) \+ '秒待った/.test(wardFn));
}

console.log("\n■ ③ ⚠ var が使う所より前にある（後ろだと undefined で黙って動かない）");
{
  const iDecl = ps.indexOf("var _wardVerifyStart = 0;");
  const iUse = ps.indexOf("_wardVerifyStart = Date.now();");
  const iRead = ps.indexOf("var t0 = _wardVerifyStart");
  ok("宣言がある", iDecl > 0);
  ok("宣言が使用より前", iDecl < iUse && iDecl < iRead, { iDecl, iUse, iRead });
  ok("doAfterWard の先頭で時刻を入れる", /function doAfterWard\(\) \{[\s\S]{0,400}_wardVerifyStart = Date\.now\(\);/.test(ps));
}

console.log("\n■ ④ 実際の速さで「3区が押し終わる前に打ち切らない」かを確かめる（机上）");
{
  /**
   * キューは1区あたり gap（620〜1400ms）＋迷い＋押した後の間（settle 200〜900ms）。
   * 実測の中央値で見積もる: 1区 ≒ 1000 + 300 + 400 = 1700ms。
   *   旧: 620ms × 8 = 4960ms → **3区（約5100ms）より短い**＝必ず打ち切る。
   *   新: キューが空になるまで待つ（上限 45000ms）→ 3区でも余裕。
   */
  const perWard = 1700, wards = 3, oldBudget = 620 * 8, newBudget = 45000;
  ok("旧の打ち切り（約5秒）は3区の押下（約5.1秒）より短い＝必ず誤判定", oldBudget < perWard * wards, { oldBudget, need: perWard * wards });
  ok("新の上限（45秒）は3区でも足りる（長い停止8〜25秒が1回入っても）", newBudget > perWard * wards + 25000);
}

console.log("\n■ ⑤ 押し直しで二重押し（＝外れる）をしない");
{
  ok("キューが空になってから足す", /if \(isClickQueueBusy\(\)\) \{[\s\S]{0,600}_verifyThenConfirm\(n\);[\s\S]{0,200}\n\s*\}\n\s*_wardVerifyStart = 0;/.test(wardFn));
  ok("余計な区（stale）は外す・足りない区（missing）は足す", /chk\.stale\.forEach/.test(wardFn) && /chk\.missing\.length\) clickWardPrecise/.test(wardFn));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
