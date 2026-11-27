// 2.8.320 リセットは押す前に背面のタブを前に出す／押す処理の途中の印をページの点検に消されず背景へ運ぶ
//   竹内さん 2026-11-27「押せないのはなぜか」。実測: #1666（2.8.318）は 3s にリセット開始→135s まで押されず。
//   ページ側の「押せず15秒」の印が一度も残らず（ページの点検が次の入力で作り直され、印が捨てられていた）。
//   背面のタブでは押す処理（setTimeout の列）が遅れる → 押す前に見え方を確かめ、背面なら前に出す。
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(root, "chrome-extension", f), "utf8");
const bg = read("background.js");
const page = read("page-script.js");
const sa = read("search-audit.js");

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (detail ? " :: " + detail : "")); }
}

console.log("■ 1. 押す前に見え方を確かめ、背面なら前に出す（背景）");
{
  const start = bg.indexOf("async function _postSendResetRealpro(");
  ok("_postSendResetRealpro がある", start > 0);
  const body = bg.slice(start, start + 16000);
  const frontAt = body.indexOf("_bringRealproTabFront(_tab, _ridFront");
  const pressAt = body.indexOf("chrome.scripting.executeScript");
  ok("背面なら前に出す処理がある（_bringRealproTabFront）", frontAt > 0);
  ok("前に出すのは押す処理（executeScript）より前", frontAt > 0 && pressAt > 0 && frontAt < pressAt, `front=${frontAt} press=${pressAt}`);
  ok("見え方が hidden の時だけ前に出す", /_vis0 === "hidden"/.test(body.slice(0, frontAt)));
  ok("見え方の印 reset_vis を残す", /_stamp\("reset_vis"/.test(body));
  ok("前に出した後の見え方 reset_front を残す", /_stamp\("reset_front"/.test(body));
  ok("見え方の確かめは返事なしでも止まらない（try で囲む）", /try \{\s*var _pv0 = await _probeRealproTab\(_tab\.id\);/.test(body));
}

console.log("■ 2. 押す処理の途中の印を背景の点検へ運ぶ（ページの点検で消えない）");
{
  ok("背景は押す処理の返事の steps を点検へ移す（page:）", /_press\.steps\.forEach\(function \(s\) \{ _stamp\("page:"/.test(bg));
  // 2.8.329: 遅れの確かめはページの関数（読み直し後は新しいページの空の箱）に頼らず押した印を直接読む。各回の結果を1行にまとめて残す
  ok("遅れの確かめは毎回の結果を点検へ残す（_tries）", /_stamp\("reset_press_late_check", [^\n]*_tryLine/.test(bg));
  ok("ページ側の印は専用の箱（_resetStepBuf）に残す", /var _resetStepBuf = \[\];/.test(page) && /function _resetStepP\(k, d\)/.test(page));
  ok("押す処理の開始の印（reset_press_start）", /_resetStepP\("reset_press_start"/.test(page));
  ok("押せず（slow）の印は専用の箱へ（点検の _audit があるかに依存しない）", /_resetStepP\("reset_press_slow"/.test(page) && !/if \(_audit\) _auditStepP\("reset_press_slow"/.test(page));
  ok("取り消し（cancel）の印も専用の箱へ", /_resetStepP\("reset_press_cancel"/.test(page) && !/if \(_audit\) _auditStepP\("reset_press_cancel"/.test(page));
  ok("キューに積んだ時の印（reset_press_queued）", /_resetStepP\("reset_press_queued"/.test(page));
  ok("押す処理の返事（fin）に印を載せる", /r\.steps = _resetStepBuf\.slice\(\)/.test(page));
  ok("押す処理の返事の印は20件まで（溢れない）", /if \(_resetStepBuf\.length > 20\) _resetStepBuf\.shift\(\)/.test(page));
  ok("押す処理そのもの（キューへ積む）は変えていない", /enqueueHumanClick\(btn, _fireReset, _uiGapMin\(\), _uiGapMax\(\), null, _rOpts\)/.test(page));
}

console.log("■ 3. 点検の段の一覧（落ちずに残る）");
{
  const rule = /var RULE_STEP = (\/.*\/[a-z]*);/.exec(sa);
  const keep = /var KEEP_STEP = (\/.*\/[a-z]*);/.exec(sa);
  const R = rule ? new Function("return " + rule[1])() : null;
  const K = keep ? new Function("return " + keep[1])() : null;
  ok("reset_vis が点検に残る", !!R && R.test("reset_vis"));
  ok("reset_front が点検に残る", !!R && R.test("reset_front"));
  ok("page:reset_press_start が点検に残る", !!K && K.test("page:reset_press_start"));
  ok("タブが背面の印（tab_hidden）が落ちずに残る", !!K && K.test("tab_hidden"));
  ok("前に出した印（tab_front）が落ちずに残る", !!K && K.test("tab_front"));
  ok("ウィンドウを戻した印（window_restore）が落ちずに残る", !!K && K.test("window_restore"));
}

console.log("■ 4. 拡張の構文が通る（読み込めないファイルは出さない）");
{
  // background.js は ES モジュール（import を使う）なので vm.Script では読めない。一時ファイル(.mjs)で node --check する
  const os = require("os");
  const cp = require("child_process");
  for (const f of ["background.js", "page-script.js", "search-audit.js"]) {
    const tmp = path.join(os.tmpdir(), "axlx-2320-" + f.replace(/\W/g, "_") + ".mjs");
    fs.writeFileSync(tmp, read(f));
    const r = cp.spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    try { fs.unlinkSync(tmp); } catch (_) {}
    ok(`${f} が構文として読める`, r.status === 0, String(r.stderr || "").slice(0, 160));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log("reset-front-visible-v2320.test OK");

