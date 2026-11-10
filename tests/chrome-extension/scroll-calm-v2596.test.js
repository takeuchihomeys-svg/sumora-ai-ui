// 実行: node tests/chrome-extension/scroll-calm-v2596.test.js
// 2026-11-10 竹内さん「今物件検索の動き見てるけど画面無駄に上下しまくりすぎている実際のスタッフはそこまで上下しまくらないし
//   その上下の時間もはやすぎるから実際の人間がするように。また駅も一気に選択してしまう部分がのこっている」
//   ① スクロールは最小の移動（真ん中へ寄せない）
//   ② 画面の外の時だけ動かす・連続で動かさない
//   ③ 動かしたら終わるまで待ってから押す
//   ④ 駅は1つずつ人の速さ（320〜900ms・20駅ごとに一息）
//   ⑤ 見張り（fill-done）の長さが駅を選ぶ時間に足りる
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ps = read("page-script.js");
const ips = read("itandi-page-script.js");
const bg = read("background.js");

console.log("■ ① スクロールは最小の移動（真ん中へ寄せない）");
ok("リアプロ: block:\"nearest\"（center を使わない）", /block: "nearest", inline: "nearest"/.test(ps) && !/block: "center"/.test(ps));
ok("ITANDI: smoothScrollTo も block:\"nearest\"", /function smoothScrollTo[\s\S]{0,300}block: "nearest"/.test(ips));
ok("ITANDI: tick のスクロールも真ん中へ寄せない", !/scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/.test(ips));

console.log("\n■ ② 画面の外の時だけ・連続で動かさない");
ok("リアプロ: 画面に入っていれば何もしない（margin 付き）", /var margin = 60;/.test(ps) && /if \(r\.top >= margin && r\.bottom <= vh - margin\) return 0;/.test(ps));
ok("リアプロ: 直近 900ms 以内ならスクロールしない", /if \(_lastScrollAt && now - _lastScrollAt < 900\) return 350 \+ Math\.floor\(Math\.random\(\) \* 450\);/.test(ps));
ok("ITANDI: 同じ形（_ensureInViewSoft）", /function _ensureInViewSoft\(el\)/.test(ips) && /now - _lastScrollAt < 900/.test(ips));

console.log("\n■ ③ 動かしたら終わるまで待ってから押す");
ok("リアプロ: 待ち時間を返す（距離に比例 250〜700ms）", /Math\.min\(700, Math\.max\(250, Math\.round\(Math\.abs\(dist\) \* 1\.2\)\)\)/.test(ps));
ok("リアプロ: 待ってから押す（setTimeout の中でクリック）", /if \(_viewWait > 0\) \{\s*setTimeout\(function \(\) \{/.test(ps));
ok("ITANDI: tick の待ちにスクロールの時間を足す", /var _vw = _ensureInViewSoft\(el\);/.test(ips) && /\}, wait \+ _vw\);/.test(ips));

console.log("\n■ ④ 駅は1つずつ人の速さ（20〜45ms はもう無い）");
ok("駅の全選択が 20〜45ms ではない", !/enqueueHumanClick\(inp, _clickIfUnchecked, 20, 45\)/.test(ps));
ok("駅の全選択は 320〜900ms", /var _base = 320 \+ Math\.floor\(Math\.random\(\) \* 300\);/.test(ps) && /humanRand\(_base, _base \+ 280\)/.test(ps));
ok("ランダムな一息（何駅目かで決めない）", /if \(Math\.random\(\) < 0\.10\) _gap \+= 900 \+ Math\.floor\(Math\.random\(\) \* 1700\);/.test(ps) === false && /function _stationBreath\(\)/.test(ps) && /if \(Math\.random\(\) < 0\.10\) add \+= 900 \+ Math\.floor\(Math\.random\(\) \* 1700\);/.test(ps));
ok("まれに長めの間（3%・2.6〜5.5秒）", /if \(Math\.random\(\) < 0\.03\) add \+= 2600 \+ Math\.floor\(Math\.random\(\) \* 2900\);/.test(ps));
ok("20駅ごとの等間隔ではない", !/idx % 20 === 0/.test(ps));
ok("駅の間隔（_stGapMin/_stGapMax）も 420〜1100ms＋ランダムな一息", /function _stGapMin\(\) \{ return 420; \}/.test(ps) && /function _stGapMax\(\) \{ return 1100 \+ _stationBreath\(\); \}/.test(ps));
ok("ITANDI の駅もランダムな一息（10%・3%）", /if \(Math\.random\(\) < 0\.10\) _stWait \+= 900 \+ Math\.floor\(Math\.random\(\) \* 1700\);/.test(ips) && /if \(Math\.random\(\) < 0\.03\) _stWait \+= 2600 \+ Math\.floor\(Math\.random\(\) \* 2900\);/.test(ips));

console.log("\n■ ⑤ 見張り（fill-done）の長さが駅を選ぶ時間に足りる");
ok("ページ側 235秒", /\}, 895000\);/.test(ps));
ok("background のリアプロも 245秒（旧90秒では足りない）", /realnetpro: 905000/.test(bg));

console.log("\n■ ⑥ 検索を押す前に選び終わるのを待つ（条件が欠けない）");
ok("ITANDI: _whenTickIdle で待つ", /_whenTickIdle/.test(ips));
ok("リアプロ: クリックの列が空になってから検索（whenClickQueueIdle）", /whenClickQueueIdle/.test(ps));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
