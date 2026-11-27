/**
 * 2.8.326 竹内さん「リセットして押したことを把握できていない／ほかにも把握していない部分がないか」
 *   「まとめてなおす・ちゃんと手順書も反映」:
 *   押した結果（押せた／押せず／遅れて押せた・空の確認・検索を押した・高→低を押せなかった・確かめられなかった押し）を
 *   枠の「押した」行に出す。「いま」は予定（次の動き）から「リセットを押して待っている最中」と言わない。
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
const ap = read("app/lib/action-playbook.ts");

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
  const body = dl.slice(p, p + 2200);
  ok("押した・押せず・空の確認・読めずの系統を言う", /"pressed"/.test(body) && /"not_pressed"/.test(body) && /"empty"/.test(body) && /読めず/.test(body));
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

console.log("■ 6. まとめて直した押し（検索・並べ替え・確かめられなかった押し）も結果を枠へ送る");
{
  ok("page-script に送る関数 _pressNote がある（axlx-press-note）", /function _pressNote\(what, result, detail\)[\s\S]{0,200}from: "axlx-press-note"/.test(pg));
  ok("検索の押した（search_press_ok）を送る", /_auditStepP\("search_press_ok"[\s\S]{0,120}_pressNote\("search", "pressed", ""\)/.test(pg));
  ok("見えない欄の押し（hidden_press）を確かめられずとして送る", /"hidden_press"[\s\S]{0,260}_pressNote\("press", "unverified"/.test(pg));
  ok("カーソルが着かず押した（press_no_arrive）を確かめられずとして送る", /"press_no_arrive"[\s\S]{0,300}_pressNote\("press", "unverified"/.test(pg));
  ok("見えるカーソル無しの押し（press_no_cursor_ui）を確かめられずとして送る", /"press_no_cursor_ui"[\s\S]{0,260}_pressNote\("press", "unverified"/.test(pg));
  ok("bulk-dl は axlx-press-note を window で受けて _setPressNote へ", /e\.data\.from !== "axlx-press-note"[\s\S]{0,200}_setPressNote\(/.test(dl));
  ok("並べ替えの押せた・押せずを枠へ（_setPressNote sort）", /_setPressNote\("sort", "pressed"/.test(dl) && /_setPressNote\("sort", "not_pressed"/.test(dl));
  ok("枠の言葉: 検索・並べ替え・確かめられず の分岐がある", /what === "search" && result === "pressed"/.test(dl) && /what === "sort" && result === "pressed"/.test(dl) && /押したが確かめられず/.test(dl));
  ok("手順書の検索の手に押した結果の言い方（2.8.326）", /検索を押す（押したら枠に「✓検索を押した」/.test(ap));
  ok("手順書の並べ替えの手に押せなかった時の言い方（2.8.326）", /押せなかったら枠に「✗高→低を押せなかった」/.test(ap));
  ok("手順書の作り方の番号が上がっている（31）", /PLAYBOOK_BUILD_V = 31/.test(ap));
}

console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
if (fail) process.exit(1);
