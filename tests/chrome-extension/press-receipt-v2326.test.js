/**
 * 2.8.326 竹内さん「リセットして押したことを把握できていない／ほかにも把握していない部分がないか」:
 *   押した結果（押せた／押せず／遅れて押せた・空の確認）を背景が枠へ送り、枠の「押した」行に出す。
 *   「いま」は予定（次の動き）から「リセットを押して待っている最中」と言わない（押す前は「リセットを押す最中」）。
 * node tests/chrome-extension/press-receipt-v2326.test.js
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); }
}

const bg = read("chrome-extension/background.js");
const dl = read("chrome-extension/bulk-dl.js");
const pg = read("chrome-extension/page-script.js");
const bgr = read("chrome-extension/bulk-panel-grasp.js");

console.log("■ 1. 背景は押した結果を枠へ送る（押せた・押せず・遅れて・空の確認）");
{
  ok("送る関数 _bulkPressShow がある", /function _bulkPressShow\(what, result, detail\)/.test(bg));
  ok("送る型は axlx-bulk-press（realpro/itandi のタブへ）", /type: "axlx-bulk-press"/.test(bg) && /realnetpro\.com\/\*/.test(bg));
  ok("押した（pressed）を送る", /_bulkPressShow\("reset", "pressed"/.test(bg));
  ok("押せず（not_pressed）を送る", /_bulkPressShow\("reset", "not_pressed"/.test(bg));
  ok("遅れて押した（pressed_late）を送る", /_bulkPressShow\("reset", "pressed_late"/.test(bg));
  ok("空の確認（reset_check）を送る", /_bulkPressShow\("reset_check", _ver \? \(_ver\.empty/.test(bg));
}

console.log("■ 2. 枠は押した結果を「押した」行に出す");
{
  ok("枠の押した行（#axlx-press）が把握の下にある", /id="axlx-grasp"[\s\S]{0,260}id="axlx-press"/.test(dl));
  ok("押した行は最初は隠す", /id="axlx-press" style="display:none;/.test(dl));
  ok("axlx-bulk-press を受けて _setPressNote へ", /msg\.type === "axlx-bulk-press"[\s\S]{0,160}_setPressNote\(/.test(dl));
  const p = dl.indexOf("function _setPressNote(");
  const body = dl.slice(p, p + 1400);
  ok("押した・押せず・空の確認・読めずの4系統を言う", /"pressed"/.test(body) && /"not_pressed"/.test(body) && /"empty"/.test(body) && /読めず/.test(body));
  ok("押せずは赤（#fca5a5）・残りが見えたは黄（#fde68a）で分ける", /#fca5a5/.test(body) && /#fde68a/.test(body));
}

console.log("■ 3. 「いま」は予定から『押して待っている』と言わない");
{
  ok("地図の reset の言葉は「リセットを押す最中」（生成物も同じ）", /reset: \{ now: "リセットを押す最中"/.test(bgr));
  ok("「押して待っている最中」は拡張の生成部分に残っていない", !/押して待っている最中/.test(bgr) && !/押して待っている最中/.test(pg));
  ok("判定は「リセットを押」で見る（予定の動きの言葉でも押す段として扱う）", /\/リセットを押\/\.test\(act\)/.test(bgr));
}

console.log("■ 4. 押した後の待ちは地図の言葉のまま（2.8.325 の枠の待ち行）");
{
  ok("押した後の待ち（reset_settle）が背景から出る", /_bulkWaitShow\("reset_settle", _settleMs\)/.test(bg));
}

console.log("■ 5. 押した行は次の押しで書き換わる（古い跡は次の押しで上書き）");
{
  ok("押した行は新しい押しで書き換わる（textContent を置き換え）", /el\.textContent = t;/.test(dl));
}

console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
if (fail) process.exit(1);
