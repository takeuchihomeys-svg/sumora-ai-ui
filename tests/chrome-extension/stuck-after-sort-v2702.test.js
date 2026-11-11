// 実行: node tests/chrome-extension/stuck-after-sort-v2702.test.js
// 2026-11-11 竹内さん「並べ替えした後物件選択するところでとまってしまった。ここ何かバグが起きているのではないか」
//
//   症状（写真）: 一覧は出ている（大阪 5棟）のに、枠が「0件を選択中」のまま動かない。チェックも1つも入らない。
//
//   原因は3つ（どれか1つでも起きると「物件を選ぶところで止まる」）:
//     ① 並べ替えの後の「条件が効いているか」の判定が**厳しすぎた**
//        → 並べ替えの後はページが読み直され、URL に条件が無く・検索の欄は畳まれ（既定に戻り）・区/駅の小窓は閉じている。
//          旧の判定はその3つしか見ていなかったので**必ず false** → 「条件が消えている可能性」で**静かに止まった**。
//     ② その判定が**1回だけ**だった（`_adSortChecked`）
//        → 読み直し直後は欄がまだ描かれておらず、1回目だけ見ると必ず外れる。見直さないので永久に止まる。
//     ③ 並べ替えで一覧の行が**作り直される**
//        → `tracked` の古い要素は `isConnected=false` になり、`_autoPressNext` が全部飛ばして0件で終わる。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bd = read("bulk-dl.js");

console.log("■ ① 条件が効いているかを「結果の見出しの文字」でも見る（並べ替えの後は欄が畳まれる）");
{
  ok("賃料の条件の文字を見る（家賃 ～10.5万）", /\(家賃\|賃料\)\\s\*\[:：\]\?/.test(bd));
  ok("徒歩の条件の文字を見る（徒歩15分）", /徒歩\\s\*\[0-9\]\{1,3\}\\s\*分/.test(bd));
  ok("間取りの条件の文字を見る（2LDK-3LDK）", /0-9SLDK/.test(bd));
  ok("更新日の条件の文字を見る（更新1日内）", /更新\\s\*\[0-9\]\{1,3\}\\s\*日以内/.test(bd));
  ok("築年の条件の文字を見る（築20年以内）", /築\\s\*\[0-9\]\{1,3\}\\s\*年/.test(bd));
  ok("**2つ以上そろえば**条件つきの一覧とみなす（1つの取りこぼしで止まらない）", /_cond >= 2/.test(bd));
  ok("検索した時の印（AxlxSearchStamp）も見る", /AxlxSearchStamp\.read/.test(bd));
  ok("  ＜今のお客様の物で3時間以内＞だけ使う", /st\.cid && Date\.now\(\)/.test(bd) && /3 \* 60 \* 60 \* 1000/.test(bd));
  ok("全件と分かる時は必ず押さない（安全側は残す）", /全件/.test(bd) && /return false;/.test(bd));
}

console.log("\n■ ② 1回で諦めない（時間で区切って見直す）");
{
  ok("何度も見直す（_adSortChecking で二重に積まない）", /var _adSortChecking = false;/.test(bd));
  ok("  待ってから見直す（1400ms 後にもう一度）", /setTimeout\(function \(\) \{\s*\n\s*_adSortChecking = false;/.test(bd));
  ok("  見直すのは25秒まで（永久に止まらない・永久に待たない）", /_AD_SORT_GRACE_MS = 25000/.test(bd));
  ok("  回数ではなく**時間**で数える（描き直しで回数が尽きない）", /_elapsed < _AD_SORT_GRACE_MS/.test(bd));
  ok("止まったままにしない（見直し中は枠に出す）", /並べ替えの後に条件を確かめています/.test(bd));
}

console.log("\n■ ③ 読めなかった時は黙って止まらない（理由＋もう一度ためす）");
{
  ok("理由を枠に出す（_blockedAfterSortNote）", /function _blockedAfterSortNote\(\)/.test(bd));
  ok("  「自動では押しません」と出す", /自動では押しません/.test(bd));
  ok("  **人が押せる「もう一度ためす」**がある", /axlx-blocked-retry/.test(bd) && /もう一度ためす/.test(bd));
  ok("  押したら印を消して、もう一度試す", /_adSortBlocked = false;/.test(bd) && /_maybeAutoPressOnLoad\(\);/.test(bd));
}

console.log("\n■ ④ 並べ替えで行が入れ替わっても止まらない");
{
  ok("押し始める直前に一覧を作り直す", /_autoPdfRunPending = function \(\) \{\s*\n\s*try \{ _rescanRows\(\); \}/.test(bd));
  ok("候補が0件になったら一度作り直す（古い要素を掴んだまま進まない）", /行が画面から入れ替わった → 一覧を作り直します/.test(bd));
  ok("  画面に残っている行だけを候補にする（isConnected）", /t\.btn\.isConnected && AxlxSendPairing\.isHttpUrl/.test(bd));
  ok("押せる行が無い時は理由を出す（黙って0件で終わらない）", /押せる行が見つかりません/.test(bd));
  ok("見直しのたびに何度も並べ替えない（_adSortDone）", /if \(_adSortDone\) _allowAd = false;/.test(bd));
}

console.log("\n■ ⑤ 全物件を送らない安全弁は残っている");
{
  ok("並べ替えはメニュー操作（読み込み直さない）", /function _sortByAdLikeHuman\(done\)/.test(bd) && !/location\.href = _adLink\.href;/.test(bd));
  ok("並べ替えできなければ押さない", /並べ替えができませんでした。自動では押しません/.test(bd));
  ok("自動モード・スタッフモードの関所はそのまま", /if \(_autoPdfRun \|\| !_autoModeOn \|\| _staffModeOn\) return;/.test(bd));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
