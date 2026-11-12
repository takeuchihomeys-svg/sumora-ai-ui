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
  ok("押すと録画モード（説明に「1.5〜3.5秒ごと」「最長7分」）", /1\.5〜3\.5秒ごと/.test(html) && /最長7分/.test(html));
}

console.log("\n■ ② 押している間は連続で撮る");
{
  ok("録画の状態を持つ（_recTimer / _recCount）", /var _recTimer = null;/.test(bg) && /var _recCount = 0;/.test(bg));
  ok("始める（_recStart）", /async function _recStart\(\)/.test(bg));
  ok("止める（_recStop）", /async function _recStop\(why\)/.test(bg));
  ok("1.5〜3.5秒ごとに次を撮る（毎回ちがう間隔）", /var gap = _REC_GAP_MIN \+ Math\.floor\(Math\.random\(\) \* \(_REC_GAP_MAX - _REC_GAP_MIN\)\);/.test(bg));
  ok("  間隔の値が 1500〜3500ms", /_REC_GAP_MIN = 1500/.test(bg) && /_REC_GAP_MAX = 3500/.test(bg));
  const gapAvg = (1500 + 3500) / 2;
  ok("  平均 " + gapAvg + "ms → 7分で 約" + Math.floor(7 * 60 * 1000 / gapAvg) + "枚", Math.floor(7 * 60 * 1000 / gapAvg) > 100);
  ok("撮る中身は今までと同じ道（_takeShot を直接呼ぶ）", /_takeShot\(\{ type: "axlx-human-shot", site: "record", kind: "rec", wait_upload: true \}/.test(bg));
  ok("  ⚠ 自分宛の sendMessage をしない（届かないため）", !/_recordOneShot[\s\S]{0,200}chrome\.runtime\.sendMessage/.test(bg));
}

console.log("\n■ ③ 最大 7分で必ず止まる（竹内さん 2026-11-12「最大時間も7分とかでくひりいれといた方が良い」）");
{
  ok("上限時間が 7分（旧 60分）", /_REC_MAX_MS = 7 \* 60 \* 1000/.test(bg));
  ok("  1回の録画で 400枚まで（二重の歯止め）", /_REC_MAX_SHOTS = 400/.test(bg));
  ok("期限で自動停止（理由を「7分」と出す）", /_recStop\(_recCount >= _REC_MAX_SHOTS \? "上限" : "7分"\)/.test(bg));
  ok("残り時間を数える（_recRemainMs）", /function _recRemainMs\(\)/.test(bg));
  ok("残りが少なくなったらそこで止める（7分を超えない）", /if \(left > 0 && gap > left\) gap = left;/.test(bg));
  ok("止められたら次の周で止まる（storage の値を見る）", /axlx_rec_mode/.test(bg) && /on: false/.test(bg));
  ok("SW が起き直しても続く（止まったまま残らない）", /SW の起き直し → 続けます/.test(bg));
  ok("  起き直しの時も7分を超えていたら止める", /if \(Date\.now\(\) - Number\(m\.started_at \|\| 0\) > _REC_MAX_MS\) \{ _recStop\("7分"\)/.test(bg));
}

console.log("\n■ ④ 小窓から操作できる");
{
  ok("始める・止めるを切り替える", /"axlx-rec-stop" : "axlx-rec-start"/.test(bg) || /on \? "axlx-rec-stop" : "axlx-rec-start"/.test(snap));
  ok("状態を聞く（axlx-rec-status）", /type: "axlx-rec-status"/.test(snap));
  ok("録画中はボタンが赤く脈打つ", /⏹ 録画中/.test(snap) && /axlxPermPulse/.test(snap));
  ok("撮れた枚数を出す", /Number\(res\.saved\) \|\| 0/.test(snap));
  ok("残り時間を出す（あと何分）", /あと/.test(snap) && /remain_ms/.test(snap));
  ok("録画中の見出しにも残り時間", /あと" \+ Math\.floor\(left2 \/ 60\)/.test(snap));
  ok("5秒ごとに状態を取り直す（別の窓で止めても追いつく）", /setInterval\(refreshRecMode, 5000\)/.test(snap));
}

console.log("\n■ ⑤ 写真の仕組み自体は壊していない");
{
  ok("1枚撮る関数が残っている（_takeShot）", /async function _takeShot\(msg, done\)/.test(bg));
  ok("メッセージの受け口は今まで通り", /if \(msg\.type === "axlx-human-shot"\) \{[\s\S]{0,120}_takeShot\(msg/.test(bg));
  ok("縮小は今まで通り（もっと小さく 640px・25%）", /_shrinkShot\(dataUrl, SHOT_SEND_SIDE, SHOT_SEND_Q\)/.test(bg));
  ok("撮る前に窓を前に出す（v2.7.4）", /chrome\.windows\.update\(tab\.windowId, \{ focused: true \}\)/.test(bg));
}

console.log("\n■ ⑥ 「撮れた枚数」は**本当に保存できた枚数**（2026-11-12 竹内さん「ちゃんと撮影されてたかな？」）");
{
  ok("保存できた枚数を別に数える（_recSaved / _recFailed）", /var _recSaved = 0;/.test(bg) && /var _recFailed = 0;/.test(bg));
  ok("失敗の理由も残す（_recLastErr）", /var _recLastErr = null;/.test(bg) && /_recLastErr = String/.test(bg));
  ok("録画は**送り終わるまで待つ**（wait_upload）", /wait_upload: true/.test(bg));
  ok("  送れた時だけ saved を増やす", /if \(r && r\.ok\) \{\s*\n\s*_recSaved\+\+;/.test(bg));
  ok("  送れなかったら failed と理由を残す", /_recFailed\+\+;/.test(bg) && /last_error: _recLastErr \|\| null/.test(bg));
  ok("止めた時に「保存◯枚・失敗◯回・理由」を返す", /saved: _recSaved, failed: _recFailed, last_error: _recLastErr/.test(bg));
  ok("小窓に保存枚数と失敗理由を出す", /保存 /.test(snap) && /失敗 /.test(snap));
  ok("⚠ 待つ時も必ず1回だけ返す（二重に sendResponse しない）", (bg.match(/sendResponse\(\{ ok: true, shot_key: key/g) || []).length === 1);
}

console.log("\n■ ⑦ 容量オーバー（ResourceExceeded）で保存0枚にならない（2026-11-12）");
{
  ok("Chrome にフルサイズ画像を入れない（data: dataUrl を書かない）", !/\n\s*data: dataUrl,/.test(bg));
  ok("送る画像を 480px・20% に（かなり小さく）", /SHOT_SEND_SIDE = 480/.test(bg) && /SHOT_SEND_Q = 0\.20/.test(bg));
  ok("  ⚠ 1枚あたりの目安を 10〜25KB と記録", /10〜25KB/.test(bg));
  ok("Chrome に残すのは 320px・15% の小さい物だけ", /SHOT_LOCAL_SIDE = 320/.test(bg) && /SHOT_LOCAL_Q = 0\.15/.test(bg));
  ok("上げられたら**目印だけ**残す（_keepShotMeta）", /async function _keepShotMeta/.test(bg) && /cloud: true/.test(bg));
  ok("上げられなかった時だけ小さい画像を残す（_keepShotLocal）", /async function _keepShotLocal/.test(bg));
  ok("  残せない時は目印だけにする（例外で止めない）", /画像を残せません（目印だけにします）/.test(bg));
  ok("容量で守る（合計1.5MB・15枚・目印は200件）", /SHOT_LOCAL_MAX_BYTES = 1\.5 \* 1000 \* 1000/.test(bg) && /SHOT_LOCAL_MAX_COUNT = 15/.test(bg) && /SHOT_META_MAX_COUNT = 200/.test(bg));
  ok("古い順に消す（_trimShots）", /async function _trimShots/.test(bg) && /b\.at - a\.at/.test(bg));
  ok("起動した時にも掃除する（旧版が溜めた分を空ける）", /起動時: 古い写真を/.test(bg));
  ok("小窓の「写真を片付ける」で今すぐ空けられる", /axlx-shot-trim/.test(bg) && /snap-shot-trim/.test(html) && /photo|片付ける/.test(snap));
  ok("  ⚠ クラウドの写真は消さない", /クラウドの写真は消していません/.test(snap));
  ok("DBに画像を入れる受け皿がある（2026-11-12 竹内さん「データベースに画像入るように」）", /shot_b64/.test(fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "human-motion", "route.ts"), "utf8")));
  ok("  migrate-schema にも同じ列を足してある", /ADD COLUMN IF NOT EXISTS shot_b64/.test(fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "migrate-schema", "route.ts"), "utf8")));
  ok("  列が無い環境でも壊れない（42703 で列を外して入れ直す）", /42703/.test(fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "human-motion", "route.ts"), "utf8")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
