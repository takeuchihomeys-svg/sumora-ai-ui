// 実行: node tests/chrome-extension/human-one-by-one-v2595.test.js
// 2026-11-10 竹内さん「リアプロの一気に選択されてしまうのでなくて1つ1つ行っていく形で。
//   チェックボックスはこの印刷用PDFのところの部分のことだから、印刷用PDF押したら、チェックボックス押して物件検索がされるように、
//   印刷用PDFで出た資料をそのまま売り上げ番長におくられるようにすれば1つずつおこなったのとおなじかたちにできるようになる」
//
// 固定する形（2026-11-10 の作り直し後）:
//   ① 印刷用PDFを押したら、その1件だけチェックが入り、その場で売上番長へ送る（20秒まとめて待たない）
//   ② 一括の道でも「先に全行チェック」をしない（全行へ checked=true を一斉に入れない）
//   ③ 1件ずつは _oneByOneStart（選ぶ → 送る → 次を選ぶ）で、画面は常に1件だけ
//   ④ 押す前に画面へ入れてカーソルを動かす（bulk-dl.js の中で完結している＝page-script の関数を呼ばない）
//   ⑤ 送らない行（送付済み・前回の検索より古い）は「チェックを触らずに」判定する（_rowSkipReason）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const bd = read("bulk-dl.js");
/** コメント行を外した「動くコード」だけ（説明文の中の関数名でテストが誤って通る/落ちるのを防ぐ） */
const bdCode = bd.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const H = require(path.join(dir, "human-wait.js"));

console.log("■ ① 印刷用PDFを押したら、その1件をその場で送る");
ok("押した合図（axlx-pdf-captured）を受けて1件送る", /if \(!msg \|\| msg\.type !== "axlx-pdf-captured"\) return;[\s\S]{0,1200}sendOnePdfNow\(item\);/.test(bdCode));
ok("押した1件だけをチェック（他の行は外す）", /function sendOnePdfNow\(item\) \{[\s\S]{0,900}tracked\.forEach\(function \(t\) \{ if \(t\.cb && t\.cb !== item\.cb && t\.cb\.checked\) t\.cb\.checked = false; \}\)/.test(bd));
ok("その1件だけを組にして送る（urls が1件）", /function sendOnePdfNow[\s\S]{0,2600}urls: AxlxSendPairing\.pluck\(one, "url"\)/.test(bd));
ok("同じ行を二度送らない（_onePdfSent）", /_onePdfSent\[url\] = true;/.test(bd) && /if \(!url \|\| _onePdfSent\[url\]\) return;/.test(bd));
ok("押した順に1件ずつ（前の1件が終わってから・Promise の鎖）", /_onePdfChain = _onePdfChain\.then/.test(bd));
ok("押した行を URL で当てる（id だけでも当てる・見つからなければ行を作り直して1回だけ探す）", /function _urlKey\(u\)/.test(bd) && /function _rescanRows\(\)/.test(bd) && /_rescanRows\(\); \} catch \(_\) \{\}\s*item = _findItemByUrl\(msg\.url\)/.test(bd));
ok("行を作り直しても押した1件のチェックは残す", /cb\.checked = !!keep\[_urlKey\(btn\.href\)\]/.test(bd));
ok("20秒まとめて送る道はもう使わない（scheduleForward の呼び出しが無い）", !/scheduleForward\(\)/.test(bd));

console.log("\n■ ② 先に全行チェックをしない");
ok("全行を一斉に checked=true にしない（poll の tracked.forEach が無い）",
  !/tracked\.forEach\(function \(t\) \{ t\.cb\.checked = true; \}\);/.test(bdCode));
ok("旧の _afterSelect（全行チェック→選別）が残っていない", !/function _afterSelect\(_sk0\)/.test(bdCode));
ok("旧の _humanCheckAll（全行を押して最後は全部チェック）が残っていない", !/function _humanCheckAll\(/.test(bdCode));

console.log("\n■ ③ 1件ずつ（選ぶ→送る→次を選ぶ）");
ok("_oneByOneStart がある", /function _oneByOneStart\(state, list, index, doneCb\)/.test(bd));
ok("選ぶのは1行だけ（前の行のチェックを外す）", /function _oneByOneStart[\s\S]{0,600}if \(t\.cb && t\.cb !== item\.cb && t\.cb\.checked\) t\.cb\.checked = false;/.test(bd));
ok("送り終わってから次の行（_doSendOne の next → 次の _oneByOneStart）", /_doSendOne\(item, state, function \(\) \{[\s\S]{0,400}_oneByOneStart\(state, list, index \+ 1, doneCb\)/.test(bd));
ok("チェックが入るまで待ってから送る（最大8秒＝16回×500ms）", /var waitChecked = function \(n\) \{[\s\S]{0,200}item\.cb\.checked \|\| n >= 16/.test(bdCode));

console.log("\n■ ④ 押す前の人の動き（bulk-dl.js の中で完結）");
ok("cursor を動かしてから押す（_humanClickCb）", /function _humanClickCb\(cb\)/.test(bd) && /P\.moveToEl\(cb\)/.test(bd));
ok("page-script の enqueueHumanClick / _clickEl を呼んでいない（参照エラーで止まっていた）", !/enqueueHumanClick\(/.test(bdCode) && !/\b_clickEl\(/.test(bdCode));
ok("押す前に画面へ入れる（scrollIntoView）", /_humanClickCb[\s\S]{0,300}scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/.test(bd));

console.log("\n■ ⑤ 送らない行はチェックを触らずに判定");
ok("_rowSkipReason がある（送付済み・前回より古い）", /function _rowSkipReason\(state, item\)/.test(bd));
ok("_rowSkipReason はチェックを変えない", !/function _rowSkipReason[\s\S]{0,1400}\.checked = /.test(bd));
ok("_selectAllowed は「先にチェック→外す」でなく、通った行だけを送る", /function _selectAllowed\(cand\)[\s\S]{0,900}allowed\.push\(t\)/.test(bd) && /_doSend\(allowed\.map/.test(bd));
ok("送付済みの判定は今までの物差し（AxlxSentSkip）と同じ", /function _rowSkipReason[\s\S]{0,900}SK\.isSentRoom\(idx, card\.name, room\)/.test(bd));
ok("前回の検索より古い行の判定も今まで通り（state.updateStop）", /function _rowSkipReason[\s\S]{0,1400}at >= stop\.index\) return "old"/.test(bd));

console.log("\n■ ⑥ 間は対数正規・たまに一息（機械的な等間隔にしない）");
(() => {
  const xs = Array.from({ length: 300 }, () => H.logNormalDelay(220, 0.32));
  const uniq = new Set(xs).size;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  ok("logNormalDelay: 毎回ちがう値になる", uniq > 80, { uniq });
  ok("logNormalDelay: ばらつく（CV > 0.2）", sd / mean > 0.2, { cv: (sd / mean).toFixed(2) });
})();
ok("次の行までの間は対数正規＋12%で一息", /logNormalDelay\(1500, 0\.45\)/.test(bd) && /Math\.random\(\) < 0\.12\) nextGap \+=/.test(bd));
ok("押してから送るまでの間も対数正規（_humanGapThen）", /function _humanGapThen\(\)[\s\S]{0,400}logNormalDelay\(1000, 0\.4\)/.test(bd));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
