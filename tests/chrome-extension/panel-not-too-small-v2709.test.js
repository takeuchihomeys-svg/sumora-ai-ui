// 実行: node tests/chrome-extension/panel-not-too-small-v2709.test.js
// 2026-11-12 竹内さん「また拡張ツールたまにちいさくなって中の画面がかなり小さくなり、
//   お客さんリスト確認できない時がある。この点もふくめて改善するようにする」
//
//   原因は3つあった:
//     ① `showView("view-list")` が **お客さん一覧を開くと 100px のボタンに縮める**指示を出していた
//        （`mini = (id === "view-list")`）。一覧が見えないまま小さくなるのはこれ。
//     ② 前回ドラッグで小さくした**幅が保存され**、次のページでも小さいまま開いていた（最小 300px）。
//     ③ 区切りのドラッグで、画面が小さいと `maxH` が下限を下回り**中身が潰れる**高さにできた。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const ub = read("underbar.js");
const pp = read("popup.js");
const css = read("styles.css");

console.log("■ ① お客さん一覧を開いても縮めない（一番の原因）");
{
  ok("旧の `mini = (id === \"view-list\")` が無い", !/const mini = id === "view-list";/.test(pp));
  ok("どの画面でも自動では縮めない（真っ白を起こさない）", /setMiniMode\(false\);\s*\n\s*notifyParent\("expand"\);/.test(pp));
  ok("  縮むのは人が「たたむ」を押した時だけ", /MINI_VIEWS|wantMini/.test(pp) === false);
  ok("  理由をコメントに残してある（詳細・リアプロのボタンが真っ白になった）", /真っ白/.test(pp) && /リアプロのボタン/.test(pp));
}

console.log("\n■ ② 小さすぎる幅を保存しない・復元しない");
{
  ok("読める最小の幅が 420（旧 300）", /const MIN_W   = 420/.test(ub));
  ok("保存する時に下限で丸める", /panelW: Math\.max\(MIN_W, panelW\),/.test(ub));
  ok("復元する時も下限で丸める（画面の90%も上限）", /Math\.max\(MIN_W, Math\.min\(Number\(saved\.panelW\) \|\| INIT_W/.test(ub));
  ok("CSS の body も 420px 未満にしない", /min-width: 420px;/.test(css));
}

console.log("\n■ ③ 画面が小さくても中身を潰さない");
{
  ok("読める最小の高さが 480（旧 340）", /const MIN_H   = 480/.test(ub));
  ok("clampHeight が「読める高さ」を計算する", /MIN_H_READ/.test(ub));
  ok("  入りきらない時は**上に寄せて**高さを確保する", /wantTop/.test(ub) && /newTop/.test(ub));
  ok("リサイズでも下限を守る（maxH が下限を下回っても潰さない）", /Math\.max\(minHRead, maxH\)/.test(ub));
  ok("幅も画面に収める", /const maxW = Math\.max\(MIN_W, window\.innerWidth - 20\)/.test(ub));
  ok("窓の大きさが変わったら置き直す（resize）", /window\.addEventListener\("resize"/.test(ub));
}

console.log("\n■ ④ 一覧そのものが潰れない（CSS）");
{
  ok("一覧はスクロールで全部見られる（min-height 120）", /#customer-list \{[^}]*min-height: 120px/.test(css));
  ok("  横に潰れない（min-width: 0 で flex の縮小を抑える）", /min-height: 200px;/.test(css) && /min-width: 0;/.test(css));
  ok("お客さん一覧のミニモード（100x100）は残っている（検索中は使う）", /body\.mini-mode #app \{/.test(css));
  ok("mini-mode でも**開いている画面は消さない**（真っ白防止）", /body\.mini-mode \.view:not\(\.active\)/.test(css));
  ok("  旧の「全部の view を消す」が無い", !/body\.mini-mode \.view \{\s*\n\s*display: none/.test(css));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
