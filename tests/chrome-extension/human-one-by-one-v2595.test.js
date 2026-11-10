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
const bg2 = read("background.js");
/** コメント行を外した「動くコード」だけ（説明文の中の関数名でテストが誤って通る/落ちるのを防ぐ） */
const bdCode = bd.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const H = require(path.join(dir, "human-wait.js"));

console.log("■ ① 印刷用PDFを押したら、その1件をその場で送る");
ok("押した合図（axlx-pdf-captured）を受けて1件送る", /if \(!msg \|\| msg\.type !== "axlx-pdf-captured"\) return;[\s\S]{0,1200}sendOnePdfNow\(item\);/.test(bdCode));
ok("押した1件だけをチェック（他の行は外す・_selectOnly）", /function _selectOnly\(item\) \{[\s\S]{0,300}t\.cb !== item\.cb && t\.cb\.checked\) t\.cb\.checked = false;/.test(bdCode));
ok("その1件だけを組にして送る（urls が1件）", /urls: AxlxSendPairing\.pluck\(send, "url"\)/.test(bdCode));
ok("同じ行を二度送らない（_onePdfSent）", /if \(_onePdfSent\[url\]\) return;/.test(bdCode) && /_onePdfSent\[url\] = true;/.test(bdCode));
ok("1件ずつ（送信中・確認中は次の押下を受け付けない＝溜めない）", /if \(_pdfBusy\) \{[\s\S]{0,300}return;/.test(bdCode) && /_pdfBusy = true;/.test(bdCode));
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

console.log("\n■ ⑦ ひとつずつ押す形（押した分を溜めて自動で続けない）");
ok("押した分を溜める待ち行列を持たない（押したらその1件だけ）", !/_pdfQueue/.test(bdCode) && !/_pumpPdfQueue/.test(bdCode));
ok("送信中・確認中は次の押下を受け付けない（_pdfBusy）", /if \(_pdfBusy\) \{/.test(bdCode) && /_pdfBusy = true;/.test(bdCode) && /_pdfBusy = false;/.test(bdCode));
ok("受け付けない時は枠の1行で知らせる", /_nudge\("⏳ いま1件を送っています。終わってから次を押してください"\)/.test(bdCode));
ok("1件終わったら押せる状態に戻る（_idleAfterOne）と知らせる", /function _idleAfterOne\(item\)/.test(bdCode) && /✅ 送りました。次の物件を押してください/.test(bdCode));
ok("組は押した行そのものから作る（他の行にチェックを奪われて no-item にならない）", /function _buildOneItem\(btn\)/.test(bdCode));
ok("ブレインの判定も1件だけ（全件を毎回呼ばない）", /function _judgeOneBrain\(customerId, one, cb\)/.test(bd) && /items: \[\{ summary: one\.summary, data: jd, url: one\.url/.test(bd));

console.log("\n■ ⑧ 送信の直列（background でも同時に走らせない）");
ok("送信は1本の待ち行列（_enqueueLineSend）", /function _enqueueLineSend\(job\)/.test(bg2) && /_enqueueLineSend\(async \(\) => \{/.test(bg2));
ok("1件の送信に 300秒の上限（超えたら次へ）", /300000/.test(bg2) && /1件の送信が 300秒 を超えた/.test(bg2));

console.log("\n■ ⑨ 資料に一度目を通してから次の物件へ（人の動き）");
ok("送れた1件は「資料を見る間」を置いてから押せる状態に戻る（_lookAtDocThenGo）", /function _lookAtDocThenGo\(item, goNext\)/.test(bd) && /_lookAtDocThenGo\(item, function \(\) \{ _idleAfterOne\(item\); \}\)/.test(bd));
ok("見る間は人の間（中央値 3.5秒・1.8〜13秒・たまに長く見る）", /logNormalDelay\(3500, 0\.4\)/.test(bd) && /if \(base < 1800\) base = 1800;/.test(bd) && /if \(base > 13000\) base = 13000;/.test(bd));
ok("見る間は札を「👀 確認中…」にする（画面で分かる）", /👀 確認中…/.test(bd) && /👀 資料を確認中…/.test(bd));
ok("「👀 見た → 次へ」で人の判断で先へ進める（押さなくても自動で次へ）", /axlx-look-next-btn/.test(bd) && /_lookWait\.skip\("skip"\)/.test(bd));
ok("見る間が終わったら選択を外して押せる状態に戻る（人がそうする形）", /function _idleAfterOne\(item\)[\s\S]{0,600}item\.cb\.checked = false; updateBar\(\);/.test(bd));
ok("送れなかった1件は見る物が無いのですぐ押せる状態に戻る", /if \(!ok\) \{ _idleAfterOne\(item\); return; \}/.test(bd));
ok("点検に残す（look_doc・look_skip）", /_tmark\("look_doc"/.test(bd) && /_tmark\("look_skip"/.test(bd));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
