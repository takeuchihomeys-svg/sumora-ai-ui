// v2.8.111 竹内さん（2026-11-18 22:51）「R.さんで上書きされ、R.さんの条件の物件が平田さんに送られている可能性」
// 「検索を押す際 画面が切れていた。画面に出てから検索を押す」
// 実行: node tests/chrome-extension/customer-no-mix-v2811.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const ps = fs.readFileSync(path.join(root, "chrome-extension", "page-script.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}

// fillRealpro の「入力中の別客」の分岐を切り出す
const i0 = ps.indexOf("if (_diffCust) {");
const seg = i0 >= 0 ? ps.slice(i0, i0 + 1600) : "";
const elseIdx = seg.indexOf("} else {");
const diffBranch = elseIdx > 0 ? seg.slice(0, elseIdx) : seg;

console.log("■ 別のお客さんの入力中は上書きしない（fillRealpro）");
ok("分岐が見つかる", i0 >= 0);
ok("前客を閉じる（_abortFillForNextCustomer）を呼ばない", !/_abortFillForNextCustomer\(/.test(diffBranch), diffBranch.slice(0, 200));
ok("印を前客に戻す（_fillCustomerId = _runCid）", /_fillCustomerId = _runCid;/.test(diffBranch));
ok("次客を断ったと知らせる（busy_other_customer の gate）", /gateKind: "busy_other_customer"/.test(diffBranch));
ok("断った後は return（入力に進まない）", /return;\s*$/m.test(diffBranch.replace(/\s+$/, "") + "\n") || /return;/.test(diffBranch));
ok("_abortFillForNextCustomer の関数自体は残す（他の経路が使うかも）", /function _abortFillForNextCustomer/.test(ps));

console.log("■ 検索は画面に出てから押す（clickSearch の _pressSearchBtn）");
ok("画面外なら出るまで待つ仕組み（search_wait_view）", /search_wait_view/.test(ps));
ok("待つ回数の上限が6回", /btn\.__axSearchViewTries <= 6/.test(ps));
// 2026-11-20 以降: 待ち時間は固定300msでなく人の速さ（520〜900ms）。呼び直す動きは同じ
ok("待った後に同じ関数を呼び直す（人の速さの待ち）", /search_wait_view[\s\S]{0,300}setTimeout\(function \(\) \{ _pressSearchBtn\(btn\); \}, 520 \+ Math\.floor\(Math\.random\(\) \* 380\)\);/.test(ps));
ok("画面内に出たら回数を戻す", /btn\.__axSearchViewTries = 0;/.test(ps));

console.log(`\n結果: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
