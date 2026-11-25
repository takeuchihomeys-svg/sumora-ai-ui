/**
 * 2.8.284 竹内さん「条件はずしはかなりむずかしい。人間のようにリセットボタンに切り替える。
 *   リセットおして→待機→画面照会（スクショ）→空と確認してから新しいお客さんの API を動かす」
 *   「検索ボタンの前に、Ajax の該当件数の再計算が終わるのを待つ」「送付後の完了ポップアップを閉じる」
 *   「完了判定は画像ではなく URL・DOM（客の番号に対する完了）」
 *
 *   ① ページ側（page-script）の作り（押すのは送付後の1点・入力中は断る・印・空の読み戻し・台帳を消す）
 *   ② 検索前の Ajax 待ち（実関数を偽の時計で動かす）
 *   ③ 一括ループ（シミュレーター）: 順序・失敗時の従来の外しへの戻り・止まらない
 *   ④ 完了判定が画像に依らない
 *   ⑤ 古い決定との整合（2.8.107 の試験が見ていた名前が増えていない）
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8").replace(/\r\n/g, "\n");
const ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8").replace(/\r\n/g, "\n");
const bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8").replace(/\r\n/g, "\n");
const man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function semverOk(v, min) {
  const a = String(v).split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
}
function fnSrc(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n  }\n");
  return e < 0 ? s : s.slice(0, e + 5);
}

console.log("\n■ 版");
ok("manifest ≥2.8.284", semverOk(man.version, "2.8.284"), man.version);
ok("page ≥2.8.284", semverOk((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.284"));
ok("rules ≥2.8.284", semverOk((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.284"));

console.log("\n■ ① ページ側の作り");
const press = fnSrc(ps, "  function _resetPress(done) {");
ok("入力中は断る（fill_running）", /window\._axFillRunning/.test(press) && /skipped: "fill_running"/.test(press));
ok("押す前に完了の小窓を閉じる", press.indexOf("_closeStrayWindows()") > 0 && press.indexOf("_closeStrayWindows()") < press.indexOf("_findResetBtn()"));
ok("押す前に読み直しの印（bootAt）を置く", /sessionStorage\.setItem\(_AX_RESET_PRESSED_KEY/.test(press) && /bootAt/.test(press));
ok("人のようにカーソルを動かして押す（enqueueHumanClick）", /enqueueHumanClick\(btn, _clickEl/.test(press));
ok("押す物が無ければ no_reset_button", /why: "no_reset_button"/.test(press));
ok("15秒で必ず返す（fail-open）", /press_timeout15/.test(press));
const closeFn = fnSrc(ps, "  function _closeStrayWindows() {");
ok("this_window_close を閉じる", /div\.this_window_close/.test(closeFn));
ok("「閉じる」だけの小窓も閉じる（検索の小窓は別扱い）", /=== "閉じる"/.test(closeFn) && /\.this_window/.test(closeFn));
const verify = fnSrc(ps, "  function _resetVerify(opts, done) {");
ok("空は _scanLeftoverForm の読み戻しで決める", /_resetFormState\(\)/.test(verify) && /function _resetFormState/.test(ps));
ok("空と確かめたら台帳を消す", /_ledgerClear\(\)/.test(verify) && /__axlxPrevLedger = null/.test(verify));
ok("空と確かめた印（reset_clean）を置く", /_AX_RESET_CLEAN_KEY/.test(verify));
ok("読み直しの有無を返す（reloaded）", /reloaded/.test(verify));
ok("画面の準備ができてから（readyState complete＋フォーム）", /readyState === "complete"/.test(verify));
const st = fnSrc(ps, "  function _resetFormState() {");
["stations", "lines", "wards", "towns", "layouts", "structured", "pet"].forEach((k) => ok("空の判定に " + k, st.indexOf('"' + k + '"') >= 0));
ok("空の判定に 敷礼・選ぶ欄・文字欄", /s\.shikirei/.test(st) && /s\.selects/.test(st) && /s\.texts/.test(st));
ok("公開関数 __axlxResetPressP／__axlxResetVerifyP", /window\.__axlxResetPressP/.test(ps) && /window\.__axlxResetVerifyP/.test(ps));
const dr = ps.slice(ps.indexOf("function _doReset(callback, _resetRound)"), ps.indexOf("function _doReset(callback, _resetRound)") + 14000);
ok("次客の開始: リセットで空と確認済みなら前客の外しを省く", /_axResetCleanFresh\(\)/.test(dr) && /reset_clean_skip_clear/.test(dr));
ok("省くのは「いまも空」の時だけ（読み戻し）", /function _axResetCleanFresh[\s\S]{0,400}_resetFormState\(\)\.empty/.test(ps));
ok("検索中（_doReset）はリセットを押さない（2.8.107 の決まり）", !/_resetPress\(|__axlxResetPressP/.test(dr));

console.log("\n■ ② 検索前の Ajax 待ち（実関数）");
{
  const settleSrc = ["  function _isShown(el)", "  function _axHitSig()", "  function _axLoadingShown()", "  function _axAjaxSettleThen(cb)"]
    .map((h) => fnSrc(ps, h) || (ps.slice(ps.indexOf(h), ps.indexOf("\n", ps.indexOf(h)))))
    .join("\n");
  function run(env) {
    let now = 0;
    const timers = [];
    const steps = [];
    const sandbox = {
      Date: { now: () => now },
      setTimeout: (fn, ms) => { timers.push({ at: now + ms, fn }); return timers.length; },
      _audit: {},
      _auditStepP: (k, d) => steps.push(k + ":" + d),
      window: { jQuery: { active: env.jq() } },
      document: {
        querySelectorAll: (sel) => (/count|hit|total/.test(sel) ? env.hitEls() : env.loadEls()),
      },
    };
    sandbox.window.jQuery = { get active() { return env.jq(); } };
    vm.createContext(sandbox);
    vm.runInContext(settleSrc + "\nglobalThis.__go = _axAjaxSettleThen;", sandbox);
    let called = false;
    sandbox.__go(() => { called = true; });
    let guard = 0;
    while (!called && guard++ < 1000) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers.shift();
      if (!t) break;
      now = t.at;
      env.tick && env.tick(now);
      t.fn();
    }
    return { called, ms: now, steps };
  }
  const el = (txt) => ({ offsetParent: {}, getClientRects: () => [1], textContent: txt, getBoundingClientRect: () => ({ width: 20, height: 20 }) });
  // 通信なし・件数も変わらない → 約0.6秒で押す
  let r = run({ jq: () => 0, hitEls: () => [el("該当件数58件")], loadEls: () => [] });
  ok("落ち着いている → 0.6〜1.0秒で押す", r.called && r.ms >= 600 && r.ms <= 1000, JSON.stringify(r));
  ok("settled を残す", r.steps.some((s) => /^ajax_settle:settled/.test(s)), JSON.stringify(r.steps));
  // 通信が2秒続く → 終わってから押す
  r = run({ jq: () => 0, hitEls: () => [el("58件")], loadEls: () => [], tick: null });
  let jqv = 1;
  const envJq = { jq: () => jqv, hitEls: () => [el("58件")], loadEls: () => [], tick: (n) => { if (n >= 2000) jqv = 0; } };
  r = run(envJq);
  ok("Ajax が終わるまで待つ（2秒後に終了）", r.called && r.ms >= 2000 && r.ms <= 3000, JSON.stringify(r));
  // 件数の表示が変わり続ける → 変わらなくなってから
  let hv = 0;
  r = run({ jq: () => 0, hitEls: () => [el("該当" + hv + "件")], loadEls: () => [], tick: (n) => { if (n < 1500) hv = Math.floor(n / 100); } });
  ok("件数が変わっている間は待つ（最後の変化から0.6秒）", r.called && r.ms >= 1800 && r.ms <= 2200, JSON.stringify(r));
  // 読み込み中の表示が出っぱなし → 5秒で押す（止まらない）
  r = run({ jq: () => 0, hitEls: () => [], loadEls: () => [el("loading")] });
  ok("読み込み表示が消えない → 5秒で押す（fail-open）", r.called && r.ms >= 5000 && r.ms <= 5400 && r.steps.some((s) => /^ajax_settle:timeout/.test(s)), JSON.stringify(r));
  // 見えない読み込み要素は無視
  r = run({ jq: () => 0, hitEls: () => [], loadEls: () => [{ offsetParent: null, getClientRects: () => [], textContent: "", getBoundingClientRect: () => ({ width: 0, height: 0 }) }] });
  ok("見えない読み込み要素は無視", r.called && r.ms <= 1000, JSON.stringify(r));
}
const lookTimer = ps.slice(ps.indexOf("window._axSearchLookTimer = setTimeout(function () {"), ps.indexOf("window._axSearchLookTimer = setTimeout(function () {") + 900);
ok("検索前の見直しの後、Ajax 待ちを通ってから clickSearch", /_axAjaxSettleThen\(function \(\) \{ try \{ clickSearch\(\); \} catch \(_\) \{\} \}\)/.test(lookTimer));

console.log("\n■ ③ 一括ループ（シミュレーター）");
const sim = require("./lib/bulk-sim.js");
const customers = (n) => Array.from({ length: n }, (_, i) => ({ id: "c" + (i + 1), name: "客" + (i + 1) }));
const start = async (w, n) => {
  const sw = w.startSw();
  await w.run(10);
  sw.call("_manualBulkRun", { site: "realnetpro", ids: customers(n).map((c) => c.id), isWide: false, startIndex: 0, resume: false, why: "popup" });
  return sw;
};
const filled = (w) => w.autofills.map((a) => a.cid);
const stepKeys = (w) => { const ks = []; w.db.forEach((r) => (r.steps || []).forEach((s) => ks.push(s.k))); return ks; };
const order = (w) => w.log.filter((l) => ["autofill", "reset_press_exec", "reset_verify_exec", "post_send_clear_exec"].includes(l.kind)).map((l) => l.kind + ":" + (l.kind === "autofill" ? l.d : ""));
(async function () {
  // 3-1 リセット成功: 押す→確認→次客。従来の外しは呼ばない
  let w = sim.createWorld({ customers: customers(3), resetButton: true });
  await start(w, 3);
  await w.run(30 * 60000);
  ok("3-1 3人を順に", JSON.stringify(filled(w)) === JSON.stringify(["c1", "c2", "c3"]), filled(w).join(","));
  ok("3-1 毎回リセット→確認（3回ずつ）", w.resetPressCalls === 3 && w.resetVerifyCalls === 3, w.resetPressCalls + "/" + w.resetVerifyCalls);
  ok("3-1 従来の外しは呼ばない", w.postSendClearCalls === 0, String(w.postSendClearCalls));
  const o1 = order(w);
  ok("3-1 順序: 入れる→リセット→確認→次客", o1.slice(0, 5).join(" ") === "autofill:c1 reset_press_exec: reset_verify_exec: autofill:c2 reset_press_exec:", o1.join(" "));
  const k1 = stepKeys(w);
  ok("3-1 記録に reset_press／reset_wait／reset_verified／reset_shot", ["reset_press", "reset_wait", "reset_verified", "reset_shot"].every((k) => k1.includes(k)), JSON.stringify([...new Set(k1)].filter((k) => /reset/.test(k))));
  const timed = [];
  w.db.forEach((r) => (r.steps || []).forEach((s) => timed.push(s)));
  const tPress = timed.find((s) => s.k === "reset_press");
  const tVer = timed.find((s) => s.k === "reset_verified");
  ok("3-1 押してから空の確認まで10秒以上", !!(tPress && tVer && tVer.at - tPress.at >= 10000), tPress && tVer ? tVer.at - tPress.at : null);
  ok("3-1 例外なし", (w.clock.errors || []).length === 0, (w.clock.errors || []).map(String).join("/"));
  ok("3-1 全件完了を1通", (w.fetches || []).filter((f) => /notify-group/.test(f.url) && /全件完了/.test(f.body)).length === 1);

  // 3-2 リセット後に空にならない → 従来の外しで残りを外す→次客へ
  w = sim.createWorld({ customers: customers(2), resetButton: true, page: () => ({ reset: "notempty" }) });
  await start(w, 2);
  await w.run(40 * 60000);
  ok("3-2 空にならない → 従来の外しへ戻る", w.postSendClearCalls === 2, String(w.postSendClearCalls));
  ok("3-2 次客へ進む", JSON.stringify(filled(w)) === JSON.stringify(["c1", "c2"]), filled(w).join(","));
  ok("3-2 reset_not_empty／reset_fallback を残す", stepKeys(w).includes("reset_not_empty") && stepKeys(w).includes("reset_fallback"));
  ok("3-2 空でないのに reset_verified を出さない", !stepKeys(w).includes("reset_verified"));

  // 3-3 リセットが見つからない → 従来の外しへ
  w = sim.createWorld({ customers: customers(2), resetButton: true, page: () => ({ reset: "nobutton" }) });
  await start(w, 2);
  await w.run(30 * 60000);
  ok("3-3 ボタン無し → 従来の外し", w.postSendClearCalls === 2 && w.resetVerifyCalls === 0, w.postSendClearCalls + "/" + w.resetVerifyCalls);
  ok("3-3 次客へ進む", JSON.stringify(filled(w)) === JSON.stringify(["c1", "c2"]), filled(w).join(","));

  // 3-4 押した返事が来ない → 25秒で諦めて従来の外し（止まらない）
  w = sim.createWorld({ customers: customers(2), resetButton: true, page: (cid) => (cid === "c1" ? { reset: "hang" } : {}) });
  await start(w, 2);
  await w.run(40 * 60000);
  ok("3-4 返事なし → 従来の外し→次客へ", JSON.stringify(filled(w)) === JSON.stringify(["c1", "c2"]), filled(w).join(","));
  ok("3-4 reset_press に理由を残す", stepKeys(w).includes("reset_press") && stepKeys(w).includes("reset_fallback"));

  // 3-5 切り替えフラグ off → リセットを押さない（従来どおり）
  w = sim.createWorld({ customers: customers(2) });
  await start(w, 2);
  await w.run(30 * 60000);
  ok("3-5 flag off → リセットを押さない", w.resetPressCalls === 0 && w.postSendClearCalls === 2, w.resetPressCalls + "/" + w.postSendClearCalls);

  // 3-6 リセット込みの1人あたりの増え分が上限（260秒）の中
  w = sim.createWorld({ customers: customers(2), resetButton: true });
  await start(w, 2);
  await w.run(30 * 60000);
  const gap = w.autofills[1].at - w.autofills[0].at;
  ok("3-6 リセット込みでも2人目は10分以内", gap < 10 * 60000, Math.round(gap / 1000) + "秒");

  console.log("\n■ ④ 完了判定は画像に依らない（客の番号＋DOM）");
  ok("送付完了は axlx-batch-customer-done（客の番号つき）で待つ", /_createBatchCustomerDoneWaiter\(customerId/.test(bg));
  ok("bulk-dl の完了の合図は客の番号を載せる", /type: "axlx-batch-customer-done"[\s\S]{0,400}customerId/.test(bd));
  const loopSrc = bg.slice(bg.indexOf("async function _manualBulkRun("), bg.indexOf("\nvar _manualBulkGen = 0;"));
  ok("一括ループは画面の写真・録画で完了を決めない", !/captureVisibleTab|_capturePaced|_resetShot|axlx-human-shot/.test(loopSrc));
  const resetFn = bg.slice(bg.indexOf("async function _postSendResetRealpro("), bg.indexOf("async function _postSendClearOrReset("));
  ok("リセットの『空』は読み戻し（verify）で決め、写真は記録だけ", resetFn.indexOf("_ver.empty") > 0 && resetFn.indexOf("_resetShot(") > resetFn.indexOf("reset_verified"));
  ok("写真が撮れなくても進む（時間切れ・権限なしは記録のみ）", /_withTimeout\(_resetShot\(/.test(resetFn) && /no_permission/.test(bg));

  console.log("\n■ ⑤ 整合・配線");
  const clearOrReset = bg.slice(bg.indexOf("async function _postSendClearOrReset("), bg.indexOf("var _scrapeLastOutcome"));
  ok("失敗時は従来の外し（_postSendClearRealpro）へ", /return _postSendClearRealpro\(customerId, auditRunId\)/.test(clearOrReset));
  ok("送付後の呼び出しは _postSendClearOrReset", /var _psP = _postSendClearOrReset\(customerId, _runId\)/.test(bg));
  ok("段の上限を 260秒に（リセット＋従来の外しが入る）", /_bulkPhaseSet\("post_send_clear", 260000/.test(bg));
  ok("切り替えフラグ axlx_reset_button_mode（false で使わない）", /RESET_BUTTON_MODE_KEY\] === false/.test(bg));
  ok("2.8.107 の試験が見ていた名前が増えていない", ps.indexOf("_tryResetButtonThen") === -1 && ps.indexOf("RESET_TEXTS") === -1 && ps.indexOf('"reset_btn"') === -1);
  ok("正本に reset_between_customers", /id: "reset_between_customers"/.test(rules));
  ok("page-script の完了一覧に reset_between_customers", /"reset_between_customers"/.test(ps));

  console.log("\n" + (fail ? "❌ " : "✅ ") + "pass=" + pass + " fail=" + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("NG: 例外 " + (e && e.stack || e)); process.exit(1); });

// ── 2.8.285 竹内さん「リセット押してからは10秒以上間をみたほうがよい。ラグがあるので・人間のように」
{
  const bgSrc = require("fs").readFileSync(require("path").join(__dirname, "../../chrome-extension/background.js"), "utf8");
  const min = Number((bgSrc.match(/var RESET_SETTLE_MIN_MS = (\d+);/) || [])[1]);
  const body = bgSrc.slice(bgSrc.indexOf("async function _postSendResetRealpro"), bgSrc.indexOf("async function _postSendClearOrReset"));
  const iPress = body.indexOf("__axlxResetPressP"), iWait = body.indexOf("_settleMs"), iVerify = body.indexOf("__axlxResetVerifyP");
  console.log("\n■ ⑥ 押した後は10秒以上待ってから空を読み戻す（2.8.285）");
  ok("待ちの下限が10秒以上", min >= 10000, min);
  ok("押す → 待つ → 空を読み戻す の順", iPress > 0 && iWait > iPress && iVerify > iWait, { iPress, iWait, iVerify });
  ok("3回に分けて待つ（人の間・毎回揺らす）", /_sleep\(_w1\)/.test(body) && /_sleep\(_w2\)/.test(body) && /Math\.random\(\)/.test(body));
  ok("待ちの印 reset_wait が DB の記録の上限に入っている", /reset_wait/.test(require("fs").readFileSync(require("path").join(__dirname, "../../chrome-extension/search-audit.js"), "utf8")));
}