/**
 * 2.8.329 リセットの「押した」の受け取りと、枠の表記・重さの計測の配線（構造で見る）。
 *   npx tsx tests/chrome-extension/reset-receipt-box-v28329.test.js
 *
 *   実例（#1677・2026-11-27）: リセットを押すとページが読み直され、押す処理の返事ごと消えた（no_answer）。
 *   旧は1回だけ確かめて読み直し中の失敗を黙って捨て「押せず」→保険の86秒待ちに入った。
 *   → 押した瞬間に読み直しを越えて残る印（sessionStorage axlx_reset_fired）を置き、背景が「印の後に起動したページ」で押せたと知る。
 *   文言の有無だけでなく、順番（印を置いてから押す・印を消してから押す）・どの結果でも点検に残る・古い印を数えない、を見る。
 */
const fs = require("fs");
const path = require("path");
const ext = path.join(__dirname, "..", "..", "chrome-extension");
const page = fs.readFileSync(path.join(ext, "page-script.js"), "utf8");
const bg = fs.readFileSync(path.join(ext, "background.js"), "utf8");
const bulk = fs.readFileSync(path.join(ext, "bulk-dl.js"), "utf8");
const SA = require(path.join(ext, "search-audit.js"));

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + String(extra).slice(0, 300))); } }

/** name から始まる関数の本体（中括弧の対応で切る） */
function body(src, startRe) {
  const m = startRe.exec(src);
  if (!m) return "";
  let i = src.indexOf("{", m.index), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return "";
}

console.log("■ ページ: 押す瞬間に印を置いてから押す");
{
  const fire = body(page, /var _fireReset = function \(el\)/);
  const set = fire.indexOf("setItem(_AX_RESET_FIRED_KEY");
  const click = fire.indexOf("_clickEl(el)");
  ok("_fireReset に印がある", set > 0, fire.slice(0, 200));
  ok("印を置いてから押す（押すと読み直されて後ろは走らない）", set > 0 && click > set);
  ok("押せずで終わった後の遅れクリックでは印を置かない", fire.indexOf("finished && !fired") > 0 && fire.indexOf("finished && !fired") < set);
  ok("印に時刻が入る", /setItem\(_AX_RESET_FIRED_KEY, JSON\.stringify\(\{ at: firedAt/.test(fire));
  const press = body(page, /function _resetPress\s*\(/);
  ok("_resetPress の初めに前の印を消す", press && press.indexOf("removeItem(_AX_RESET_FIRED_KEY)") > 0 && press.indexOf("removeItem(_AX_RESET_FIRED_KEY)") < press.indexOf("_fireReset"));
}

console.log("■ 背景: 返事が消えても読み直し越しに確かめる");
{
  const i0 = bg.indexOf("var _pressT0 = Date.now();");
  const iPress = bg.indexOf("window.__axlxResetPressP()", i0);
  const iLoop = bg.indexOf("while (Date.now() - _lateT0 < RESET_LATE_TRY_MS)");
  const iStamp = bg.indexOf('_stamp("reset_press_late_check"');
  const iHit = bg.indexOf("if (_lateHit) {", iLoop);
  ok("押す前の時刻を取る", i0 > 0 && iPress > i0);
  ok("押す前に前の印を消す", /"axlx_sort_pressed_sync", "axlx_reset_fired"\]\.forEach/.test(bg.slice(i0, iPress)));
  ok("確かめは数回の輪", iLoop > iPress);
  ok("どの結果でも点検に1行（輪の後・押せた分かれの前）", iStamp > iLoop && iHit > iStamp);
  const loop = bg.slice(iLoop, iStamp);
  ok("印と起動時刻を直接読む", /axlx_reset_fired/.test(loop) && /performance\.timeOrigin/.test(loop));
  ok("押す前より古い印は数えない", /_fa < _pressT0 - 2000\) _fa = 0/.test(loop));
  ok("起動が印より後＝押せた", /_lr\.origin > _fa/.test(loop));
  ok("読み込み中は待つ", /_st === "loading"/.test(loop));
  ok("失敗を黙って捨てない（理由を積む）", /_tries\.push\("err:/.test(loop) && /_tries\.push\("timeout"\)/.test(loop));
  const hit = bg.slice(iHit, iHit + 600);
  ok("押せた時は押した扱いで先へ（保険へ行かない）", /pressed: true/.test(hit) && /_bulkPressShow\("reset", "pressed_late"/.test(hit));
}

console.log("■ ページ: 一覧の完了は送付完了の時だけ");
{
  const h = page.slice(page.indexOf("__axlxBulkNextSig") - 400, page.indexOf("__axlxBulkNextSig") + 1200);
  const gate = h.indexOf("e.data.done !== true");
  const done = h.indexOf('"list_done"');
  ok("done の門がある", gate > 0);
  ok("門の後でだけ list_done", done > gate, h.slice(0, 300));
  const posts = bulk.split('from: "axlx-bulk-next"').slice(1).map((s) => s.slice(0, 200));
  ok("bulk-dl の送付完了は done: true を付ける", posts.some((s) => /^\s*,\s*done: true/.test(s)), posts.join(" ‖ "));
  ok("枠の更新の知らせには done を付けない（検索の最中に一覧完了にしない）", posts.some((s) => !/done:/.test(s)));
}

console.log("■ 枠: 読み直しの後も待ち・押した行・位置を戻す");
{
  ok("背景が待ちを保存", /_boxLiveSave\("wait"/.test(bg));
  ok("背景が押した行を保存", /_boxLiveSave\("press"/.test(bg));
  ok("背景がリセットの位置を保存して知らせる", /_boxLiveSave\("resetPos"/.test(bg) && /axlx-bulk-reset-pos/.test(bg));
  ok("リセットの初めに位置を出す", /_bulkResetPosShow\(phase\)/.test(body(bg, /async function _resetWithInsurance\s*\(/)));
  ok("枠が戻す", /function _restoreBoxLive/.test(bulk) && /_liveDlStep\("box_live_restore"/.test(bulk));
  ok("枠が位置を言葉づくりに渡す", /resetPos: _rp/.test(bulk));
  ok("経過は5秒刻み", /function _fmtElapsed5/.test(bulk) && /\/ 5000\)/.test(body(bulk, /function _fmtElapsed5/)));
}

console.log("■ 重さの計測（動きは変えない）");
{
  const p = body(bulk, /\(function _axlxLoafProbe\(\)/);
  ok("長い描画を見る", /long-animation-frame/.test(p));
  ok("ファイルごとに足す", /sourceURL/.test(p));
  ok("前の頁の分を離れる時に置く", /pagehide/.test(p) && /axlx_perf_prev/.test(p));
  ok("返事待ちを測る", /responseStart - n\.requestStart/.test(p));
  for (const k of ["dl:perf_nav", "dl:perf_loaf", "dl:perf_loaf_prev", "dl:panel_text", "dl:box_live_restore", "reset_press_late_check"]) {
    ok("点検が残す: " + k, SA.KEEP_STEP.test(k));
  }
}

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
