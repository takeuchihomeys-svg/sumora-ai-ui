// 実行: node tests/chrome-extension/press-with-pointer-v2663.test.js
// 2026-11-11 竹内さん「ちゃんと画面確認しながら動くことができていなかった。押すべきボタンを押せていなかった」:
//   ① 更新日・賃料・面積は「押して開く → 展開された中で選ぶ → 閉じる」までやる（一押しで終わらない）
//   ② 地域・駅のモーダルの「進む」は、カーソルを動かして押し、**押し終わって画面が変わるまで**次へ進まない
//   ③ 検索ボタンもカーソルを動かして押す（その場でクリックしない）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const ps = read("page-script.js"), ips = read("itandi-page-script.js");

console.log("■ ① プルダウンは「開く→中で選ぶ→閉じる」（一押しで終わらない）");
{
  // 開いた一覧の中を1つずつ動かす（selectedIndex も実際に動かす＝画面で選ばれていく）
  ok("一覧の中を1つずつ動かす（selectedIndex を動かす）", /el\.selectedIndex = nxt;/.test(ps));
  ok("目当ての位置で止める（selectedIndex = want）", /el\.selectedIndex = want;/.test(ps));
  // 選んだ後に一覧を閉じる（blur＋外側の押下）。⚠ Enter は送らない（form が送信されてトップページへ飛ぶ）
  ok("選んだ後に一覧を閉じる（blur）", /if \(el\.blur\) el\.blur\(\);/.test(ps));
  ok("外側を触って閉じる（mousedown→mouseup・click は出さない）", /_outside\.dispatchEvent\(new MouseEvent\("mousedown"/.test(ps) && /_outside\.dispatchEvent\(new MouseEvent\("mouseup"/.test(ps));
  ok("Enter を送らない（form 送信でトップへ飛ぶのを防ぐ）", !/key: "Enter", keyCode: 13/.test(ps) && /Enter は送らない/.test(ps));
  // 閉じたのを見届けてから change（順序が大事：change → 値の確定だと開いたまま終わる）
  const iClose = ps.indexOf("if (el.blur) el.blur();");
  const iChange = ps.indexOf('dispatchEvent(new Event("change", { bubbles: true }))', iClose);
  ok("閉じてから change を出す（順序）", iClose > 0 && iChange > iClose);
  // 選んだ後に画面の値を見て、違えば1回入れ直す
  ok("選んだ後に画面の値を見る（_verifySel）", /function _verifySel\(el, target\)/.test(ps));
  ok("違えば入れ直して点検に残す（sel_mismatch）", /_audit\.sel_mismatch\.push\(\{ name: el\.name/.test(ps));
  ok("chooseSelectLikeHuman の最後に確かめを通す", /openThenChoose\(\)\.then\(function \(\) \{ return _verifySel\(el, target\); \}\)/.test(ps));
}

console.log("\n■ ② 地域・駅の「進む」はカーソルを動かして押し、押し終わるまで次へ進まない");
{
  // clickByText はその場で click しない（カーソルを動かしてから押す）
  const cbt = ps.slice(ps.indexOf("function clickByText(candidates)"), ps.indexOf("var _lastPressGapMs = 0;"));
  ok("clickByText はカーソルを動かしてから押す（_humanPointerClick）", /_humanPointerClick\(hit, function \(\) \{ try \{ hit\.click\(\); \}/.test(cbt));
  ok("clickByText はその場で els[i].click() をしない", !/els\[i\]\.click\(\); return true;/.test(cbt));
  // 押している最中は「押せた」と返さない（次の段が先に動かない）
  ok("押している最中を数える（_pressBusy）", /var _pressBusy = 0;/.test(ps) && /_pressBusy\+\+;/.test(ps));
  // 「駅の設定へ進む」は押した印→押し終わる→次へ
  ok("「駅の設定へ進む」は押した印を持つ（_stationNextPressed）", /var _stationNextPressed = false;/.test(ps));
  ok("押し終わるまで次へ進まない（_pressBusy > 0 なら false）", /if \(_stationNextPressed\) \{\s*if \(_pressBusy > 0\) return false;/.test(ps));
  ok("駅ページに移っていなければもう一度押す", /_stationNextPressed = false;\s*\/\/ まだ路線の一覧のまま/.test(ps));
  // 「詳細な地域の設定へ進む」
  ok("「詳細な地域の設定へ進む」も押した直後は待つ（_nextPressedAt）", /_nextPressedAt = Date.now\(\);/.test(ps) && /Date\.now\(\) - _nextPressedAt < 900/.test(ps));
  ok("カーソル移動中は押し直さない（_pressBusy > 0 なら false）", /if \(isY && _pressBusy > 0\) return false;/.test(ps));
  // simulateClick もカーソルを動かす
  const sim = ps.slice(ps.indexOf("function simulateClick(el)"), ps.indexOf("// 市区郡ラベルを安全にクリック"));
  ok("simulateClick もカーソルを動かしてから押す", /P\.moveToEl\(el\)\.then\(function \(\)/.test(sim));
  ok("同じ要素を押している最中は重ねない（_axPressing）", /if \(_axPressing === el\) \{ return; \}/.test(sim));
}

console.log("\n■ ③ 検索ボタンもカーソルを動かして押す");
{
  const cs = ps.slice(ps.indexOf("function clickSearch()"), ps.indexOf("function clickSearch()") + 14000);
  ok("検索はカーソルを動かして押す（_humanPointerClick）", /_humanPointerClick\(btn, function \(\) \{ try \{ btn\.click\(\); \}/.test(cs) || /_pressSearchBtn = function \(btn\)[\s\S]{0,1200}_humanPointerClick/.test(cs));
  ok("その場で .click() しない（goDivs[i].click() が無い）", !/goDivs\[i\]\.click\(\)/.test(cs));
  ok("押す前に画面を送る（見えてから押す）", /_scrollIntoViewSoft\(btn\)/.test(cs));
  ok("押した場所と時刻を点検に残す（search_press）", /_audit\.search_press = \{/.test(cs) && /pointer/.test(cs));
}

console.log("\n■ ④ ITANDI も押し終わるのを待つ");
{
  ok("clickBtn は押したか（true/false）をすぐ返す", /function clickBtn\(text\) \{\s*var el = _findBtn\(text\);\s*if \(!el\) return false;\s*_humanClick\(el\);\s*return true;/.test(ips));
  ok("押し終わる Promise を返す clickBtnThen がある", /function clickBtnThen\(text\)/.test(ips));
  ok("「確定」は押し終わってから次へ（clickBtnThen）", /var _c = clickBtnThen\("確定"\);/.test(ips));
  ok("確定の後は押し終わってから onDone", /_c\.then\(_afterOk, _afterOk\)/.test(ips));
  ok("検索も押し終わってから完了の合図", /_pressP\.then\(_afterPress, _afterPress\)/.test(ips));
  ok("_findBtn で探すだけ（|| で繋ぐ所が壊れない）", /function _findBtn\(text\)/.test(ips) && /clickBtn\("所在地で絞り込む"\) \|\| clickBtn\("所在地を絞り込む"\)/.test(ips));
}

console.log("\n■ ⑤ 守るべき決定は変えていない");
{
  ok("スクロールは block:nearest（真ん中へ寄せない）", !/block: "center"/.test(ps));
  ok("_scrollIntoViewSoft は既存の _ensureInView に任せる（二重に持たない）", /function _scrollIntoViewSoft\(el\) \{[\s\S]{0,400}_ensureInView\(el\)/.test(ps));
  ok("一斉クリックをしていない（forEach で即 click しない）", !/\.forEach\(function\s*\([^)]*\)\s*\{\s*[a-zA-Z_$][\w$.]*\.click\(\);\s*\}\)/.test(ps));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
