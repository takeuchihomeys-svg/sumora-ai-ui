// 実行: node tests/chrome-extension/collapse-btn-no-blank-v2718.test.js
// 2026-11-13 竹内さん「∨ で白くなる・展開できなくなる」→ 白い箱の守りは残す
// 2026-11-22 竹内さん「ここおしたらちゃんと折りたたまれるように」→ underbar では親へ collapse
//
//   白い箱の原因: setMiniMode(true) と notifyParent("collapse") の同時実行
//   正しい構造: 折りたたみは親だけ／子は中身を消さない／サイドパネルは一覧に戻る
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
const ub = read("underbar.js");

console.log("■ ① underbar: ∨ は親へ折りたたみ（中身は消さない）");
{
  const seg = (() => {
    const i = pp.indexOf('getElementById("collapse-btn")');
    return i >= 0 ? pp.slice(i, i + 900) : "";
  })();
  ok("collapse-btn の処理がある", seg.length > 0);
  ok("  underbar では notifyParent(\"collapse\")", /notifyParent\("collapse"\)/.test(seg));
  ok("  ⚠ setMiniMode(true) を呼ばない（白い箱の原因）", !/setMiniMode\(true\)/.test(seg));
  ok("  サイドパネルは一覧に戻る", /showView\("view-list"\)/.test(seg));
  ok("  白い箱の理由がコメントにある", /白い箱/.test(seg) || /白い箱/.test(pp));
}

console.log("\n■ ② 親（underbar）: collapse → ミニボタン／1回目を無視しない");
{
  ok("collapse で setSize(false)", /if \(a === "collapse"\) \{[\s\S]{0,120}setSize\(false\)/.test(ub));
  ok("  起動時に ignoreNextCollapse=true を付けない（1回目が効かない原因だった）", !/ignoreNextCollapse\s*=\s*true/.test(ub));
  ok("  開く時に repaint を送る", /send\("repaint"\)/.test(ub));
  ok("  popup が repaint を受けて描き直す", /action === "repaint"/.test(pp));
}

console.log("\n■ ③ ボタンの説明");
{
  ok("title に折りたたむ", /title="[^"]*折りたたむ/.test(html));
  ok("  旧の『縮めません』が消えている", !/縮めません/.test(html));
}

console.log("\n■ ④ mini-mode でも中身は消えない（CSSの二重の守り）");
{
  ok("開いている画面は必ず表示（.view.active）", /body\.mini-mode \.view\.active \{\s*\n\s*display: flex !important;/.test(css));
  ok("開いていない画面だけ隠す", /body\.mini-mode \.view:not\(\.active\)/.test(css));
  ok("旧の「全部の view を消す」が無い", !/body\.mini-mode \.view \{\s*\n\s*display: none/.test(css));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
