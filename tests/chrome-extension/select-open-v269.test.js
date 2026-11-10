// 実行: node tests/chrome-extension/select-open-v269.test.js
// 2026-11-10 竹内さん「あと選択してちゃんとその画面おすように／家賃のところも押したらいきなり入力されているが
//   押したら家賃の部分を選択する形で動くように。このように動くようにすればちゃんと人間らしい動きとなる」
//   ① プルダウンは「値を代入」ではなく「押して開いて選ぶ」
//   ② 開く → 一覧を見る → 候補へ移る（矢印キー＋カーソル）→ 確定 → 閉じたのを見届ける
//   ③ クリックは「狙いを定める間」→ 押す → 反応を見る間
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ps = read("page-script.js");

console.log("■ ① プルダウンは押して開いて選ぶ");
ok("chooseSelectLikeHuman がある", /function chooseSelectLikeHuman\(el, val\)/.test(ps));
ok("queueSelVal が chooseSelectLikeHuman を使う", /_enqueueWithEl\(el, function \(\) \{ return chooseSelectLikeHuman\(el, val\); \}/.test(ps));

console.log("\n■ ② 開く→見る→移る→確定→閉じを見届ける");
ok("欄を押して開く（mousedown/mouseup/click）", /fire\("mousedown", \{ buttons: 1 \}\);\s*fire\("mouseup"\);\s*fire\("click"\);/.test(ps));
ok("開いた一覧を見る間（500〜1500ms）", /_ln\(900, 0\.4, 500, 1500\)/.test(ps));
ok("候補へ移る（矢印キー）", /new KeyboardEvent\("keydown", \{ key: k/.test(ps));
ok("カーソルも一覧の方向へ動く", /P\.moveTo\(r\.left \+ r\.width \* 0\.5, r\.top \+ r\.height \* 0\.5 \+ dir \* \(18 \+ i2 \* 6\)\)/.test(ps));
ok("確定して change を出す", /el\.value = target;[\s\S]{0,200}dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/.test(ps));
ok("閉じたのを見届ける（180〜600ms）", /_ln\(320, 0\.4, 180, 600\)/.test(ps));

console.log("\n■ ③ クリックも「狙いを定める→押す→反応を見る」");
ok("押す前に狙いを定める間（90〜250ms）", /var aim = 90 \+ Math\.floor\(Math\.random\(\) \* 160\);/.test(ps));
ok("押した後に反応を見る間", /setTimeout\(function \(\) \{\}, 120 \+ Math\.floor\(Math\.random\(\) \* 180\)\)/.test(ps));
ok("キューも押した後に間を置いてから次へ", /var settle = 140 \+ Math\.floor\(Math\.random\(\) \* 220\);/.test(ps));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
