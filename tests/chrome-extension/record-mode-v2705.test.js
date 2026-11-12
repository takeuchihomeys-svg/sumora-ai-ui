// 実行: node tests/chrome-extension/record-mode-v2705.test.js
// 2026-11-12 竹内さん「画面録画モード等のボタンをつけることができればさらに簡単にできるようになる。
//   画面録画モード押しているときは連続でさつえいされていればちゃんと記録されるので、
//   それで動かすことができればさらに質が高くなる」
//
//   旧: 写真は「人が押した時」「拡張が押した時」「起動1.5秒後」だけ。画面の移り変わりは残らない。
//   → **録画ボタン**を足す。押している間は 2〜4秒ごとに続けて撮る。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bg = read("background.js");
const snap = read("snapshot-popup.js");
const html = read("popup.html");

console.log("■ ① ボタンがある");
{
  ok("小窓に「⏺ 録画」ボタン", /id="snap-rec-mode"/.test(html) && /⏺ 録画/.test(html));
  ok("押すと録画モード（説明に「2〜4秒ごと」）", /2〜4秒ごと/.test(html));
}

console.log("\n■ ② 押している間は連続で撮る");
{
  ok("録画の状態を持つ（_recTimer / _recCount）", /var _recTimer = null;/.test(bg) && /var _recCount = 0;/.test(bg));
  ok("始める（_recStart）", /async function _recStart\(\)/.test(bg));
  ok("止める（_recStop）", /async function _recStop\(why\)/.test(bg));
  ok("2〜4秒ごとに次を撮る（毎回ちがう間隔）", /var gap = 2000 \+ Math\.floor\(Math\.random\(\) \* 2000\);/.test(bg));
  ok("撮る中身は今までと同じ道（_takeShot を直接呼ぶ）", /_takeShot\(\{ type: "axlx-human-shot", site: "record", kind: "rec" \}/.test(bg));
  ok("  ⚠ 自分宛の sendMessage をしない（届かないため）", !/_recordOneShot[\s\S]{0,200}chrome\.runtime\.sendMessage/.test(bg));
}

console.log("\n■ ③ 暴走しない（必ず止まる）");
{
  ok("1回の録画で 400枚まで", /_REC_MAX_SHOTS = 400/.test(bg));
  ok("60分で必ず止まる", /_REC_MAX_MS = 60 \* 60 \* 1000/.test(bg));
  ok("上限・期限で自動停止", /_recStop\(_recCount >= _REC_MAX_SHOTS \? "上限" : "60分"\)/.test(bg));
  ok("止められたら次の周で止まる（storage の値を見る）", /axlx_rec_mode/.test(bg) && /on: false/.test(bg));
  ok("SW が起き直しても続く（止まったまま残らない）", /SW の起き直し → 続けます/.test(bg));
}

console.log("\n■ ④ 小窓から操作できる");
{
  ok("始める・止めるを切り替える", /"axlx-rec-stop" : "axlx-rec-start"/.test(bg) || /on \? "axlx-rec-stop" : "axlx-rec-start"/.test(snap));
  ok("状態を聞く（axlx-rec-status）", /type: "axlx-rec-status"/.test(snap));
  ok("録画中はボタンが赤く脈打つ", /⏹ 録画中/.test(snap) && /axlxPermPulse/.test(snap));
  ok("撮れた枚数を出す", /Number\(res\.count\) \|\| 0/.test(snap));
  ok("5秒ごとに状態を取り直す（別の窓で止めても追いつく）", /setInterval\(refreshRecMode, 5000\)/.test(snap));
}

console.log("\n■ ⑤ 写真の仕組み自体は壊していない");
{
  ok("1枚撮る関数が残っている（_takeShot）", /async function _takeShot\(msg, done\)/.test(bg));
  ok("メッセージの受け口は今まで通り", /if \(msg\.type === "axlx-human-shot"\) \{[\s\S]{0,120}_takeShot\(msg/.test(bg));
  ok("縮小（800px・32%）は今まで通り", /_shrinkShot\(dataUrl, 800, 0\.32\)/.test(bg));
  ok("撮る前に窓を前に出す（v2.7.4）", /chrome\.windows\.update\(tab\.windowId, \{ focused: true \}\)/.test(bg));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
