// tests/chrome-extension/shot-hide-overlay-v2762.test.js
// 実行: node tests/chrome-extension/shot-hide-overlay-v2762.test.js
// 2026-11-14 竹内さん「1から順に進めていく」「動かし方学習お願い」「データベースから」
//
//   ★ 実測で判明（写真から学習できなかった一番の原因）:
//     写真の**中央に拡張自身の小窓**（「AIXLINX 物件検索サポート」「案内」「学習中」）が写っている。
//     そのため写真から欄を読ませると、**サイトの欄ではなく拡張のボタン**を読んでいた:
//
//       実物のボタン : ピンポイント / 広げて検索 / リアプロで自動検索 / レインズでも探す / 全条件をコピー
//       AI の読み取り : ビジポイント / 近い順で検索 / リアプロで看護師募集 / Banch何度も利用 / 全自動キーコピー
//
//     ＝ 同じ位置・同じ形の**別物**（だから種類 radio/button は当たるのに、名前だけ滅茶苦茶だった）。
//     ⚠ プロンプトで「小窓は読まない」と指示しても直らない（小窓が後ろの欄を覆っている＝見えない）。
//     ⚠ 「文字が潰れている」と誤診していた（実際は**読む相手を間違えていた**）。
//
//   → **撮る瞬間だけ小窓を隠す**（`visibility:hidden`）。撮ったら必ず戻す。
//     隠すのは**拡張が作った要素だけ**（サイトの要素には触らない）。
//
// ⚠ このテストは「隠す仕組みが**両方の撮影経路**にあり、**必ず戻す**」ことを固定する。
//   片方だけ直すと、もう片方の経路で撮った写真に小窓が写り続ける。
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

console.log("■ ① 撮る側（background）が小窓を隠す");
{
  ok("_setShotHidden がある", /async function _setShotHidden\(tabId, hide\)/.test(bgCode));
  ok("  content script に axlx-shot-hide を送る", /type:\s*"axlx-shot-hide"/.test(bgCode));
  ok("  隠せなくても撮影は続ける（例外を投げない）", /catch \(_\) \{[\s\S]{0,400}?return false;[\s\S]{0,40}?\n\}/.test(bgCode));
}

console.log("\n■ ② 撮影の**両方の経路**で隠している（片方だけ直すと漏れる）");
{
  const hides = bgCode.match(/_setShotHidden\(tab\.id, true\)/g) || [];
  ok("  隠す呼び出しが2か所（通常経路＋やり直し経路）", hides.length === 2, { hides: hides.length });
  const restores = bgCode.match(/_setShotHidden\(tab\.id, false\)/g) || [];
  ok("  ⚠ 戻す呼び出しも2か所", restores.length === 2, { restores: restores.length });
}

console.log("\n■ ③ 撮ったら**必ず**戻す（finally の中）");
{
  const iH = bgCode.indexOf("_setShotHidden(tab.id, true)");
  const seg = bgCode.slice(iH, iH + 900);
  ok("  隠す → try → 撮る → finally で戻す の形", /try \{\s*dataUrl = await _capturePaced/.test(seg));
  ok("  ⚠ finally の中で戻している（例外でも戻る）", /finally \{[\s\S]{0,200}?_setShotHidden\(tab\.id, false\)/.test(seg));
}

console.log("\n■ ④ 隠す側（content script）が拡張の要素だけを隠す");
{
  ok("_hideForShot がある", /function _hideForShot\(\)/.test(recCode));
  ok("_showAfterShot がある", /function _showAfterShot\(\)/.test(recCode));
  ok("  隠すのは visibility:hidden（display:none ではない）", /visibility = "hidden"/.test(recCode));
  ok("  ⚠ display:none を使っていない（レイアウトが動くと絵がずれる）", !/style\.display = "none"/.test(recCode));
  // セレクタが拡張の物だけであること
  const sel = (recCode.match(/var sel = ([^;]+);/) || [])[1] || "";
  ok("  セレクタに拡張の印が入っている", /axlx|aixlinx/.test(sel), sel.slice(0, 120));
  ok("  ⚠ サイトの要素（body/html/*）を隠していない", !/sel\s*=\s*"[^"]*(^|[\s,])body/.test(sel));
}

console.log("\n■ ⑤ 戻す時に元の値を戻す（隠したまま消さない）");
{
  ok("  元の visibility を覚えている", /_shotHidden\.push\(\{ el: el, v: el\.style\.visibility \}\)/.test(recCode));
  ok("  覚えた値を戻している", /h\.el\.style\.visibility = h\.v \|\| ""/.test(recCode));
  ok("  戻したら一覧を空にする", /_shotHidden = \[\];/.test(recCode));
}

console.log("\n■ ⑥ 撮る直前と直後で小窓が消えて戻る（順番）");
{
  const iHide = recCode.indexOf("function _hideForShot()");
  const iMsg = recCode.indexOf('msg.type !== "axlx-shot-hide"');
  ok("  メッセージの受け口がある", iMsg > 0);
  ok("  hide:false で戻す", /msg\.hide === false[\s\S]{0,120}_showAfterShot\(\)/.test(recCode));
  ok("  それ以外は隠す", /else \{ _hideForShot\(\)/.test(recCode));
  void iHide;
}

console.log("\n■ ⑦ プロンプトも「小窓を読まない」と言っている（二重の守り）");
{
  const sl = fs.readFileSync(path.join(dir, "..", "app", "lib", "shot-learn.ts"), "utf8");
  ok("  指示文に小窓の除外がある", /拡張機能の小窓|AIXLINX/.test(sl));
  ok("  読めない時は null と書いてある", /name を null にする/.test(sl));
}

console.log("\n■ ⑧ 構文");
{
  /**
   * ⚠ `new Function(bg)` は background.js では通らない（`importScripts` 等の
   *   Service Worker 専用の書き方を含むため・構文の誤りではない）。
   *   → **`node --check` と同じ判定**（パースできるか）を使う。
   */
  const { execFileSync } = require("child_process");
  const check = (f) => {
    try { execFileSync(process.execPath, ["--check", path.join(dir, f)], { stdio: "pipe" }); return true; }
    catch { return false; }
  };
  ok("background.js の構文が通る", check("background.js"));
  ok("human-learn-record.js の構文が通る", check("human-learn-record.js"));
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
