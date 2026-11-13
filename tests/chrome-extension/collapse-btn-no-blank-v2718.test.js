// 実行: node tests/chrome-extension/collapse-btn-no-blank-v2718.test.js
// 2026-11-13 竹内さん「この赤枠のところ（∨）を押したら展開される部分。ここのところちゃんと改善するようにする。
//   ここが展開のところ」「開いた状態から閉じた状態にするときに白くなるバグが起きるし、展開することができなくなる」
//
//   原因は**赤枠のボタン（#collapse-btn）**だった。押すと
//     ① setMiniMode(true)      … この画面の中身を全部隠す（body.mini-mode）
//     ② notifyParent("collapse") … 親が wrap を 100px に縮める
//   を同時にやっていた → 中身が消えて白い箱 → 開き直しても描画が戻らず二度と開かない。
//
//   直し: 押したら「**開いたまま**お客さん一覧に戻る」（縮めない）。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); }
}

const pp = read("popup.js");
const css = read("styles.css");
const html = read("popup.html");

console.log("■ ① 赤枠のボタンは「縮めない・一覧に戻る」");
{
  const seg = (() => {
    const i = pp.indexOf('getElementById("collapse-btn")');
    return i >= 0 ? pp.slice(i, i + 1200) : "";
  })();
  ok("collapse-btn の処理がある", seg.length > 0);
  ok("  ⚠ setMiniMode(true) を**呼ばない**（中身を隠さない）", !/setMiniMode\(true\)/.test(seg));
  ok("  ⚠ notifyParent(\"collapse\") を**呼ばない**（縮めない）", !/notifyParent\("collapse"\)/.test(seg));
  ok("  一覧に戻る（showView(\"view-list\")）", /showView\("view-list"\)/.test(seg));
  ok("  中身は「開いた」にする（setMiniMode(false)）", /setMiniMode\(false\)/.test(seg));
  ok("  親にも「開いたまま」を伝える（expand）", /notifyParent\("expand"\)/.test(seg));
  ok("  失敗しても一覧に戻す（try/catch）", /一覧に戻れません/.test(seg));
  ok("  理由をコメントに残してある", /白い箱/.test(seg) || /二度と展開できない/.test(pp));
}

console.log("\n■ ② ボタンの説明が実態と合っている（押すと何が起きるか分かる）");
{
  ok("title が「お客さん一覧に戻る（縮めません）」", /title="お客さん一覧に戻る（縮めません）"/.test(html));
  ok("  旧の「折りたたむ」が消えている", !/title="一覧に戻る／折りたたむ"/.test(html));
}

console.log("\n■ ③ 万一 mini-mode が付いても中身は消えない（CSSの二重の守り）");
{
  ok("開いている画面は必ず表示（.view.active）", /body\.mini-mode \.view\.active \{\s*\n\s*display: flex !important;/.test(css));
  ok("開いていない画面だけ隠す", /body\.mini-mode \.view:not\(\.active\)/.test(css));
  ok("旧の「全部の view を消す」が無い", !/body\.mini-mode \.view \{\s*\n\s*display: none/.test(css));
}

console.log("\n■ ④ 開く時の描き直し（v2.7.17）と併せて効く");
{
  const ub = read("underbar.js");
  ok("開く時に repaint を送る", /send\("repaint"\)/.test(ub));
  ok("  popup が repaint を受けて描き直す", /action === "repaint"/.test(pp));
  ok("  開いている画面が無ければ一覧を出す", /showView\("view-list"\)/.test(pp));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
