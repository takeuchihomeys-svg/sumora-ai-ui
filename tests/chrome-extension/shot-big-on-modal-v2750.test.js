// tests/chrome-extension/shot-big-on-modal-v2750.test.js
// 実行: node tests/chrome-extension/shot-big-on-modal-v2750.test.js
// 2026-11-14 竹内さん「３にする」（小窓が開いた時だけ大きく撮る）
//
//   ⚠ 実測: 480x244 では **欄の文字が読めない**。Vision が `{"screen":"modal","fields":[]}` を返し、
//     欄が0個だった（写真から欄の種類を学べない）。
//   ⚠ 全部大きく撮ると容量が約6倍（7,968枚で約500MB）。
//   → **小窓（プルダウン・地域選択）が開いている時だけ**大きく撮る（1280px・JPEG45%）。
//     学びたい瞬間はそこなので、費用と容量を抑えつつ一番効く所を残せる。
//
// 決まり（このテストで固定する）:
//   ① 小窓・選択肢が開いている時だけ大きい（1280px）
//   ② それ以外は今まで通り小さい（480px）＝容量を守る
//   ③ **判断できなければ小さい**（fail-safe）
//   ④ どの写真が大きかったかを残す（後から確かめられる）
//   ⑤ 大きく撮る条件は1か所（_shouldShotBig）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bg = read("background.js");
const rec = read("human-learn-record.js");
const bgCode = bg.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
const recCode = rec.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① 大きい時の設定（1280px・JPEG45%）");
{
  ok("SHOT_BIG_SIDE = 1280", /var SHOT_BIG_SIDE = 1280;/.test(bgCode));
  ok("SHOT_BIG_Q = 0.45", /var SHOT_BIG_Q = 0\.45;/.test(bgCode));
  ok("  ⚠ 小さい時（480px）は変えていない", /var SHOT_SEND_SIDE = 480;/.test(bgCode));
  ok("  ⚠ 小さい時（JPEG20%）も変えていない", /var SHOT_SEND_Q = 0\.20;/.test(bgCode));
}

console.log("\n■ ② 大きく撮る条件は1か所（_shouldShotBig）");
{
  ok("関数がある", /function _shouldShotBig\(msg\)/.test(bgCode));
  ok("  小窓（modal）で大きく", /opened === "modal"/.test(bgCode));
  ok("  選択肢（options）で大きく", /opened === "options"/.test(bgCode));
  ok("  プルダウン系の欄名でも大きく", /rental_cost|transportation|room_layout/.test(bgCode));
  ok("  ⚠ 迷ったら小さい（return false）", /return false;\s*\} catch \(_\) \{ return false; \}/.test(bgCode) || /\/\/ ③ 拡張が「この写真は大きく」と言ってきた[\s\S]{0,200}?return false;/.test(bg));
  ok("  撮影で使う", /const _big = _shouldShotBig\(msg\)/.test(bgCode));
  ok("  ⚠ 大きさを切り替えている", /_big \? SHOT_BIG_SIDE : SHOT_SEND_SIDE/.test(bgCode));
}

console.log("\n■ ③ ページ側が「何が開いているか」を調べて送る（背景はDOMを持てない）");
{
  ok("_openedKind がある", /var _openedKind = function/.test(recCode));
  ok("  options を判定する（select の size / サイト独自の一覧）", /return "options"/.test(recCode) && /selectBox|select_box|dropdown/.test(recCode));
  ok("  modal を判定する", /return "modal"/.test(recCode) && /this_window/.test(recCode));
  ok("  result / form も見る", /return "result"/.test(recCode) && /return "form"/.test(recCode));
  ok("  ⚠ 判定できなければ none（小さいまま）", /return "none";/.test(recCode));
  ok("  撮影の依頼に opened を載せる", /opened: _openedKind\(\)/.test(recCode));
  ok("  ⚠ 文字・入力値を読まない（要素があるかだけ）", !/\.value|textContent/.test(recCode.slice(recCode.indexOf("var _openedKind"), recCode.indexOf("var _openedKind") + 2000)));
}

console.log("\n■ ④ どの写真が大きかったかを残す（後から確かめられる）");
{
  ok("shot_meta に big を残す", /big: !!_big/.test(bgCode));
  ok("  opened も残す", /opened: String\(msg\.opened/.test(bgCode));
  ok("  ログにも出す", /大きく撮る（小窓\/プルダウン）/.test(bg));
}

console.log("\n■ ⑤ 実際に判定が動く（_shouldShotBig を写して確かめる）");
{
  // background.js は ESM なので、関数の本体だけを取り出して評価する
  const m = bg.match(/function _shouldShotBig\(msg\) \{[\s\S]*?\n\}/);
  ok("関数の本体を取り出せる", !!m);
  if (m) {
    const fn = new Function("msg", m[0].replace(/^function _shouldShotBig\(msg\) \{/, "").replace(/\}$/, ""));
    ok("  modal → 大きい", fn({ opened: "modal" }) === true);
    ok("  options → 大きい", fn({ opened: "options" }) === true);
    ok("  none → 小さい", fn({ opened: "none" }) === false);
    ok("  何も無し → 小さい", fn({}) === false);
    ok("  null → 小さい", fn(null) === false);
    ok("  プルダウンの欄名 → 大きい", fn({ what: "rental_cost2" }) === true);
    ok("  普通のボタン → 小さい", fn({ what: "検索", opened: "none" }) === false);
    ok("  big:true → 大きい（将来の余地）", fn({ big: true }) === true);
  }
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
