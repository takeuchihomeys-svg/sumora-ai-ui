// 実行: node tests/chrome-extension/select-native-close-v2701.test.js
// 2026-11-11 竹内さん「なんでこのお客さんここでとまってしまったのか。原因見つけて改善する。
//   なんでh.rさん沿線選択されずにとまってしまうのか。
//   なんで賃料等プルダウンのところちゃんとおしてプルダウンのところから選択されるようになっていないのか」
//
//   ★ 真の原因: ネイティブの `<select>` を本物の形でクリックすると **OS が一覧を描く**。
//     その一覧は**拡張からは閉じられない**（blur でも閉じない）。
//     開いたままになると**画面の上に被さり、後続のクリックを全部ブロック**する。
//     → 賃料・更新日を選んだ所で一覧が開きっぱなし → **沿線・駅の選択が永久に進まない**。
//
//   ★ もう1つ: `clickLineButtons` はクリックの**列に積むだけ**（非同期）なのに、
//     すぐ `return true` していたので、**路線が押される前に「駅の設定へ進む」へ進んでいた**。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const ps = read("page-script.js");

console.log("■ ① ネイティブ select は「開くクリック」を送らない（OS の一覧を開かせない）");
{
  ok("select かどうかを見る（_isNativeSelect）", /var _isNativeSelect = \(function \(\) \{[\s\S]{0,160}toUpperCase\(\) === "SELECT"/.test(ps));
  ok("select の時は分けて処理する", /if \(_isNativeSelect\) \{/.test(ps));
  // ネイティブの分岐では mousedown/mouseup/click を送らない
  const iNat = ps.indexOf("if (_isNativeSelect) {");
  const iNonNat = ps.indexOf("// ② 欄を押して開く（人がクリックして一覧を出す）※ サイト独自の一覧の時だけ", iNat);
  const natSeg = ps.slice(iNat, iNonNat);
  ok("  ネイティブの分岐に「開くクリック」が無い", !/fire\("mousedown"/.test(natSeg) && !/fire\("click"\)/.test(natSeg));
  // _showFakeOptions は目当ての行（want）を窓の中心に出すため第2引数を取る（2026-11-16）
  ok("  見える一覧を出す（_showFakeOptions）", /_showFakeOptions\(el, want\)/.test(natSeg));
  ok("  カーソルが目当ての行へ動く（人の形）", /P\.moveToEl\(row\)/.test(natSeg));
  ok("  選んだ行を光らせる（_markFakeRow）", /_markFakeRow\(_dd, want\)/.test(natSeg));
  ok("  値を入れて input を出す", /el\.selectedIndex = want;/.test(natSeg) && /new Event\("input"/.test(natSeg));
  // 選んだ後の「見る間」は 2026-11-18（通常の人の実測に寄せた）で 200ms 中心から 130ms 中心（70〜230ms）に短くなった。間を置いてから change を送る形は同じ
  ok("  選んだ後に見る間 → change", /setTimeout\(function \(\) \{\s*try \{ el\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\); \} catch/.test(natSeg) && /\}, _ln\(130, 0\.35, 70, 230\)\);/.test(natSeg));
  ok("  一覧を消す（_hideFakeOptions）", /_hideFakeOptions\(_dd\)/.test(natSeg));
  ok("  最後に欄から離れる（blur）", /el\.blur\(\)/.test(natSeg));
  ok("拡張が描いた一覧は押せない（pointer-events:none）＝画面を塞がない", /pointer-events:none/.test(ps) && /axlx-fake-dd/.test(ps));
  ok("一覧が残っても8秒で必ず消す（安全弁）", /_armFakeDdSafety/.test(ps) && /8000/.test(ps));
  ok("サイト独自の一覧の時だけ開くクリックを送る", /※ サイト独自の一覧の時だけ/.test(ps) && /fire\("mousedown", \{ buttons: 1 \}\)/.test(ps));
  // 目当ての位置は先に決める（ネイティブでも使う）
  ok("目当ての位置を先に決める（値を先・文字でも探す）", (() => {
    const iWant = ps.indexOf("var want = -1;");
    return iWant > 0 && iWant < iNat && /_wantText/.test(ps.slice(iWant, iNat));
  })());
}

console.log("\n■ ② 路線が本当に入るまで次へ進まない");
{
  ok("路線が入ったかを確かめる（_lineOk）", /var _lineOk = !hasRoutes \? true : \(function \(\)/.test(ps));
  // checked の読み方は htmlFor での箱の取り直しが挟まった（窓 {0,200} を越えた）。見ている物は同じ（label.one_line の checked）
  ok("  見えている label.one_line の checked を見る", /var nowChecked = Array\.prototype\.slice\.call\(document\.querySelectorAll\('label\.one_line'\)\)[\s\S]{0,500}input\[type="checkbox"\]'\);[\s\S]{0,200}return c && c\.checked/.test(ps));
  // 待ちの記録（station_line_wait／station_line_stuck）が増えて if の中が長くなった。ブロックの終わりが return false で、その直後に待ち回数の初期化が来る形
  ok("  入っていなければ同じ段をもう一度（return false）", /if \(!_lineOk\) \{[\s\S]{0,8000}?return false;\s*\}\s*try \{ window\.__axlxLineWaitN = 0; \}/.test(ps));
  ok("  説明が残っている（路線が押される前に進んでいた）", /路線が押される前に次の段/.test(ps));
}

console.log("\n■ ③ 駅の5段階はそのまま（①沿線・駅絞り込み → ②沿線 → ③駅の設定へ進む → ④駅 → ⑤確定してリストへ）");
{
  ok("① 沿線・駅絞り込み", /clickByText\(\['沿線・駅絞り込み＋'/.test(ps));
  ok("② 沿線（clickLineButtons）", /if \(hasRoutes\) clickLineButtons\(cond\.route_ids\)/.test(ps));
  ok("③ 駅の設定へ進む", /clickByText\(\['駅の設定へ進む'/.test(ps));
  ok("④ 駅（selectStationsByName）", /selectStationsByName\(cond\.station_names\)/.test(ps));
  // 確定は共通の _pressConfirmListLikeHuman（「確定してリストへ」を押す）に切り出された（2026-11-17）。closeStationModal はそれを ×（this_window_close）より先に呼ぶ
  ok("⑤ 確定してリストへ（×より先）", /station_confirm/.test(ps) && (() => {
    const iFn = ps.indexOf("function closeStationModal()");
    const seg = ps.slice(iFn, iFn + 4000);
    const iConf = seg.indexOf('_pressConfirmListLikeHuman("駅モーダル確定")');
    const iX = seg.indexOf("this_window_close");
    const iHelper = ps.indexOf("function _pressConfirmListLikeHuman(");
    return iConf > 0 && iConf < iX && iHelper > 0 && /var labels = \["確定してリストへ"/.test(ps.slice(iHelper, iHelper + 200));
  })());
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
