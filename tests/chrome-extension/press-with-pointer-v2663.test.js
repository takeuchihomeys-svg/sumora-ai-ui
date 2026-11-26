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
  // 2026-11-11 竹内さん「家賃も大量に連続でえらばれてる」→ 1つずつ動かすのをやめ、**目当てを直接選ぶ**
  ok("目当ての値を直接選ぶ（途中の値を選ばない）", /el\.selectedIndex = want;/.test(ps) && !/el\.selectedIndex = nxt;/.test(ps));
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
  // 2026-11-20〜: 確かめは _verifyOrRetry に包んだ（違えばもう1回開いて選び直し→それでも違う時だけ _verifySel で直す）。最後に必ず通る点は同じ
  ok("chooseSelectLikeHuman の最後に確かめを通す", /openThenChoose\(\)\.then\(_verifyOrRetry\)/.test(ps) && /var _verifyOrRetry = function \(\) \{[\s\S]{0,300}_verifySel\(el, target\)/.test(ps));
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
  // 2026-11-19〜: 場面理解（_understandStationScene）で沿線一覧のままなら押し直す（押してから1.8秒は切り替わりを待つ）。DOM の form 残りでも同じ
  ok("駅ページに移っていなければもう一度押す", /_uGo\.screen === "line_list"[\s\S]{0,1800}_stationNextPressed = false;\s*return false;/.test(ps) && /!document\.querySelectorAll\('input\[name="station_id\[\]"\]'\)\.length\) \{\s*_stationNextPressed = false;/.test(ps));
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
  // clickSearch は長くなった（検索を押す本体 _pressSearchBtn は関数の中ほど）ので、行数に依存しない窓にする
  const csStart = ps.indexOf("function clickSearch()");
  const cs = ps.slice(csStart, csStart + 60000);
  const pressFn = ps.slice(ps.indexOf("var _pressSearchBtn = function (btn)"), ps.indexOf("var _pressSearchBtn = function (btn)") + 9000);
  ok("検索はカーソルを動かして押す（_humanPointerClick）", /enqueueHumanClick\(btn, function \(el\) \{[\s\S]{0,400}el\.click\(\);/.test(pressFn) && /_humanPointerClick\(btn, function \(\) \{[\s\S]{0,300}btn\.click\(\);/.test(pressFn) && /_auditStepP\('search_cursor'/.test(pressFn));
  ok("その場で .click() しない（goDivs[i].click() が無い）", !/goDivs\[i\]\.click\(\)/.test(cs));
  ok("押す前に画面を送る（見えてから押す）", /_scrollIntoViewSoft\(btn\)/.test(pressFn) && /search_wait_view/.test(pressFn));
  ok("押した場所と時刻を点検に残す（search_press）", /_audit\.search_press = \{/.test(pressFn) && /_audit\.search_press\.pointer = /.test(pressFn));
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
// 2.8.313 退役: 「スクロールは block:nearest だけ・block:"center" を使わない」は、2.8.27（築年の見切れ→SELECT は中央）・2.8.68（駅・区・確定も中央寄り）・
//   2026-11-18/20（検索ボタンが画面外なら中央へ送ってから押す）で意図して置き換わった（page-script.js _ensureInView のコメント・memory/dept_search_tool.md 2.8.27/2.8.68）。
//   残っている本来の決まり（画面に入っていれば動かさない・直近 900ms は連続で動かさない＝押すたびに往復しない）は下の項目で守る。
  ok("画面に入っていればスクロールしない・900ms以内は続けて動かさない（_ensureInView）",
    /function _ensureInView\(el\) \{[\s\S]{0,600}if \(r\.top >= margin && r\.bottom <= vh - margin\) return 0;[\s\S]{0,400}if \(_lastScrollAt && now - _lastScrollAt < 900\) return/.test(ps));
  ok("_scrollIntoViewSoft は既存の _ensureInView に任せる（二重に持たない）", /function _scrollIntoViewSoft\(el\) \{[\s\S]{0,400}_ensureInView\(el\)/.test(ps));
  ok("一斉クリックをしていない（forEach で即 click しない）", !/\.forEach\(function\s*\([^)]*\)\s*\{\s*[a-zA-Z_$][\w$.]*\.click\(\);\s*\}\)/.test(ps));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
