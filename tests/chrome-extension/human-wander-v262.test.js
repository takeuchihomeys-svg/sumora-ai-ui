// 実行: node tests/chrome-extension/human-wander-v262.test.js
// 2026-11-10 竹内さん「即時クリックではなくて人間が迷いながらマウスもまよったりしながら考えながら入力していく」
//   ① 迷っている間、カーソルがその場で漂う（止まったまま待たない）
//   ② 漂う距離は小さい（画面が暴れない）
//   ③ 迷いの中でも最後は目標の近くへ戻る（そのまま押せる）
//   ④ ITANDI の全クリックが _humanClick を通る（即時クリックを残さない）
//   ⑤ リアプロの迷いもカーソルを漂わせる
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const P = require(path.join(dir, "pointer-ui.js"));
const ps = read("page-script.js");
const ips = read("itandi-page-script.js");

console.log("■ ① 迷っている間カーソルが漂う");
ok("pointer-ui: drift がある", typeof P.drift === "function");
ok("pointer-ui: wander がある", typeof P.wander === "function");
ok("drift は sin で往復する（等速で動かない）", /Math\.sin\(t \* Math\.PI \* 2 \+ ph\) \* amp/.test(read("pointer-ui.js")));
ok("drift は 45〜90ms ごとに位置を更新（なめらか）", /setTimeout\(step, 45 \+ Math\.floor\(Math\.random\(\) \* 45\)\);/.test(read("pointer-ui.js")));

console.log("\n■ ② 漂う距離は小さい");
ok("半径の既定は 18px", /var radius = Number\(o\.radius\) \|\| 18;/.test(read("pointer-ui.js")));
ok("振幅は半径の 35〜100%", /var amp = radius \* \(0\.35 \+ Math\.random\(\) \* 0\.65\);/.test(read("pointer-ui.js")));

console.log("\n■ ③ 迷いの後は目標へ戻る");
ok("drift は最後に元の位置へ戻す", /_pos = start;\s*_place\(start\.x, start\.y\);/.test(read("pointer-ui.js")));
ok("wander は外へ動いてから drift して目標へ戻る", /function wander\(el, ms\)[\s\S]{0,600}moveToEl\(el\)/.test(read("pointer-ui.js")));

console.log("\n■ ④ ITANDI の全クリックが _humanClick を通る");
ok("_humanClick がある", /function _humanClick\(el, opts\)/.test(ips));
ok("サイト操作の .click() 直呼びが残っていない（内部の押す処理を除く）", (() => {
  // 内部の押す処理（_tapAndClick / _humanClick の click、click ヘルパー）は el.click() を持つ＝正しい
  let body = ips.replace(/function _tapAndClick[\s\S]*?\n  \}/, "");
  body = body.replace(/function _humanClick[\s\S]*?\n  \}/, "");
  body = body.replace(/click: function \(el\) \{ el\.click\(\); \},/, "");
  const lines = body.split("\n").filter((l) => /\.click\(\)/.test(l) && !/^\s*(\*|\/\/)/.test(l));
  return lines.length === 0;
})(), ips.split("\n").filter((l) => /\.click\(\)/.test(l) && !/^\s*(\*|\/\/)/.test(l)));
ok("_humanClick は種類で迷い率を変える（選ぶ15%・決定3%）", /kind === "choose" \? 0\.15 : \(kind === "decide" \? 0\.03 : 0\.08\)/.test(ips));
ok("迷う時は drift か wander を使う", /P\.wander\(el, extra\)\.then\(doneClick, doneClick\)/.test(ips) && /P\.drift\(extra\)\.then\(doneClick, doneClick\)/.test(ips));

console.log("\n■ ⑤ リアプロの迷いもカーソルを漂わせる");
ok("_hesitateThen がある", /function _hesitateThen\(el, ms, done\)/.test(ps));
ok("_scheduleClickDrain が迷いの前にカーソルを要素へ動かす", /_hesitateDrift = hesitate > 0 && item\.el && window\.AxlxPointerUi/.test(ps));
ok("迷いの間 drift / wander を呼ぶ", /return \(P\.wander && Math\.random\(\) < 0\.35\) \? P\.wander\(item\.el, hesitate\) : P\.drift\(hesitate\);/.test(ps) && /P\.drift\(ms\)\.then\(done, done\)/.test(ps));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
