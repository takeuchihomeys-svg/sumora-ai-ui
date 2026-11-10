// 実行: node tests/chrome-extension/human-pause-v2611.test.js
// 2026-11-10 竹内さん「この止まった部分ちゃんと解決できるように／人間も止まったりするので
//   ここの部分を改善ちゃんと行っていく／人間のように」
//   ① 低確率で長めの停止（8〜25秒）が入る（人が考え込む）
//   ② 止まる前と後に点検へ印（fill_pause / fill_resume）
//   ③ 止まった後は必ず続きへ戻る（失敗にしない）
//   ④ わざとの停止中は安全弁（20秒）が発動しない
//   ⑤ 本物のフリーズは今まで通り安全弁で復帰する
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ps = read("page-script.js");

console.log("■ ① 長めの停止（人が手を止める）");
ok("_longPauseDue がある", /function _longPauseDue\(\)/.test(ps));
ok("8〜25秒（対数正規・中央値11秒）", /_ln\(11000, 0\.5, 8000, 25000\)/.test(ps));
ok("確率は低い（2〜5%）", /var p = 0\.02 \+ Math\.min\(0\.03, _opsSincePause \/ 2000\);/.test(ps));
ok("操作が続くほど少し上がる", /_opsSincePause\+\+/.test(ps));

console.log("\n■ ② 止まる前と後に点検へ印");
ok("fill_pause を残す", /_auditStepP\('fill_pause'/.test(ps));
ok("fill_resume を残す", /_auditStepP\('fill_resume'/.test(ps));

console.log("\n■ ③ 止まった後は必ず続きへ");
ok("止まった後 _scheduleClickDrain を呼ぶ", /try \{ _auditStepP\('fill_resume'[^;]*; \} catch \(_\) \{\}\s*_scheduleClickDrain\(\);/.test(ps));
ok("drift で静かに漂わせる（画面を暴れさせない）", /P0\.drift\(pause\)\.then\(_endPause, _endPause\)/.test(ps));
ok("止まった物は失敗にしない（throw しない）", !/fill_pause[\s\S]{0,600}notifyDone/.test(ps));

console.log("\n■ ④ わざとの停止中は安全弁が動かない");
ok("_holdingPause の間は時計を戻す", /if \(_holdingPause\) \{ _lastQueueProgressAt = Date\.now\(\); _lastBusyLabel = null; return; \}/.test(ps));
ok("止まったら _holdingPause=true、戻ったら false", /_holdingPause = true;/.test(ps) && /_holdingPause = false; _lastQueueProgressAt = Date\.now\(\); _startAfterPause\(\);/.test(ps));
ok("忙しい判定にも含める", /\|\| _holdingPause;/.test(ps));

console.log("\n■ ⑤ 本物のフリーズは今まで通り復帰");
ok("20秒進まない時の強制復帰が残る", /クリックの列が20秒進まない → 強制的に次へ/.test(ps));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
