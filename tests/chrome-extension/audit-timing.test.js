// 2026-09-27 v2.5.31: 検索の点検に「操作ごとの時刻」と「止まった時の様子」を残す／ウェブアプリの自動入力（pendingPopupCmd）も読み直しを待つ
// 竹内「2000回試すなど危ないやり方なのでやらない…もっと人間が試した形で試す」「残っている課題も改善する」
//   → 待ち時間は本物の検索1回の記録（点検の steps・filled.ops）で読む。ここは配線と記録の形だけを確かめる（関数を大量に呼んで分布を取らない）
// 実行: node tests/chrome-extension/audit-timing.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? "\n      " + extra : "")); } };
const grab = (src, name) => { const s = src.indexOf(name); if (s < 0) return ""; let d = 0, j = src.indexOf("{", s); for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}") { d--; if (d === 0) break; } } return src.slice(s, j + 1); };

(async () => {
  const popup = read("popup.js");
  console.log("■ ① ウェブアプリの自動入力（pendingPopupCmd）の2経路も、登録の条件の読み直しを待ってから押す");
  // v2.5.48: 芯は _openAndClickAutofill（background の切替と同じ1本）。_runPendingPopupCmd はそれを呼ぶだけ
  const core = grab(popup, "async function _openAndClickAutofill(");
  const fn = core + "\n" + grab(popup, "function _runPendingPopupCmd(");
  ok("共通の関数 _runPendingPopupCmd がある（芯は _openAndClickAutofill）", core.length > 0 && /function _runPendingPopupCmd\(cmd, via\) \{\s*return _openAndClickAutofill\(cmd, \{[^}]*suppressRestore: true[^}]*requireVisible: true, lockAreaMode: true \}\);/.test(popup));
  ok("開いた時（loadCustomers の後）と開いている時（storage.onChanged）の両方がこの関数を呼ぶ",
    /_runPendingPopupCmd\(cmd, "load"\)/.test(popup) && /_runPendingPopupCmd\(cmd, "changed"\)/.test(popup));
  ok("旧: 読み直しを待たずに 0.8〜1.2秒で押す setTimeout（_autoClickDelay）が残っていない", !/_autoClickDelay/.test(popup));
  const iOpen = fn.indexOf("openInstructions(d.site)"), iWait = fn.indexOf("await _awaitFreshPreload(6000)"), iMode = fn.indexOf("btn-mode-station"), iLock = fn.indexOf("lockedAreaMode = currentAreaMode"), iClick = fn.indexOf("aBtn.click()");
  ok("開く → 待つ → 地域/駅の軸 → 軸を固定 → 押す の順", iOpen > 0 && iWait > iOpen && iMode > iWait && iLock > iMode && iClick > iLock, [iOpen, iWait, iMode, iLock, iClick].join(","));
  ok("開く時は一時調整を復元しない（try/finally で必ず戻す）", /if \(o\.suppressRestore \|\| ov\) _adjRestoreSuppressed = true;\s*try \{ openInstructions\(d\.site\); \} finally \{ _adjRestoreSuppressed = false; \}/.test(fn));
  ok("押す前の人の間は乱数（800〜1200ms）", /setTimeout\(r, 800 \+ Math\.floor\(Math\.random\(\) \* 400\)\)/.test(fn));
  ok("自動の印（automated・auto_send_all・area_mode_locked）を押した後に消す", /delete aBtn\.dataset\.automated;[\s\S]*delete aBtn\.dataset\.area_mode_locked;/.test(fn));

  // 動かして順を確かめる（DOM の代わりに記録するだけの物）
  const log = [];
  let resolveFresh;
  const btn = (id) => ({ id, style: {}, dataset: {}, click() { log.push("click:" + id + (id === "autofill-btn" ? ":" + JSON.stringify(this.dataset) : "")); } });
  const els = { "autofill-btn": btn("autofill-btn"), "btn-mode-ward": btn("btn-mode-ward"), "btn-mode-station": btn("btn-mode-station") };
  const ctx = {
    console: { warn: (m) => log.push("warn:" + m), log() {} }, setTimeout: (f, ms) => setTimeout(f, ms >= 6000 ? 400 : 0), Promise, // 読み直しの期限（6秒）だけ 0.4秒に縮める
    allCustomers: [{ id: "509cd061" }], _adjRestoreSuppressed: false, currentAreaMode: "auto", _freshPreloadPromise: null,
    document: { getElementById: (id) => els[id] || null, querySelector: (s) => ({ click() { log.push("mode:" + s); } }) },
    openSiteView: () => log.push("openSiteView"),
    openInstructions: (site) => { log.push("open:" + site + ":sup=" + ctx._adjRestoreSuppressed); ctx._freshPreloadPromise = new Promise((r) => { resolveFresh = () => { log.push("fresh"); ctx.currentAreaMode = "ward"; r(); }; }); },
  };
  vm.createContext(ctx);
  vm.runInContext(grab(popup, "async function _awaitFreshPreload(") + "\n" + fn, ctx);
  const p = vm.runInContext('_runPendingPopupCmd({ customerId: "509cd061", site: "realpro", areaMode: "ward", is_wide: false, auto_send_all: true }, "load")', ctx);
  await new Promise((r) => setTimeout(r, 20));
  ok("読み直しが終わるまで押さない", !log.some((x) => x.startsWith("click:autofill-btn")), log.join(" | "));
  resolveFresh();
  await p;
  const iF = log.indexOf("fresh"), iC = log.findIndex((x) => x.startsWith("click:autofill-btn"));
  ok("読み直しの後に押す", iF >= 0 && iC > iF, log.join(" | "));
  ok("開く間だけ復元しない印が立ち、終わったら戻る", log.includes("open:realpro:sup=true") && ctx._adjRestoreSuppressed === false);
  ok("押す時の軸は読み直しの後の値（ward）", /area_mode_locked":"ward"/.test(log[iC]), log[iC]);
  ok("押した後に自動の印が消える", Object.keys(els["autofill-btn"].dataset).length === 0);

  console.log("\n■ ② page-script: 操作ごとの時刻（ops）と段（steps）・見張りで止まった時の様子（stall）");
  const ps = read("page-script.js");
  ok("クリックの列の1件ごとに名前を持つ（enqueueHumanClick・enqueueHumanAction・queueSelVal・queueTxtVal）",
    /label: _opLabel\(el\)/.test(ps) && /label: label \|\| 'action'/.test(ps) && /'sel:' \+ name \+ '=' \+ val/.test(ps) && /'txt:' \+ name \+ '=' \+ val/.test(ps));
  ok("列を消化する時に予定の間と実際の間を記録（_auditOp）", /var _planned = item\.gap \+ hesitate, _setAt = Date\.now\(\);[\s\S]{0,120}_auditOp\(item\.label, _planned, Date\.now\(\) - _setAt\);/.test(ps));
  ok("段は60件まで・ops は80件まで", /if \(_audit\.steps\.length > 60\) _audit\.steps\.shift\(\);/.test(ps) && /if \(_audit\.ops\.length > 80\) _audit\.ops\.shift\(\);/.test(ps));
  for (const k of ["'vis'", "'reset'", "'cities'", "'modal'", "'ward'", "'next_step'", "'town'", "'modal_close'", "'search_wait'", "'search'"]) ok(`段 ${k} を記録する`, ps.includes("_auditStepP(" + k));
  ok("見張り（85秒）で止まる時は stall を残してから fill-done を送る", /_auditStall\(\);\s*notifyDone\('watchdog-timeout/.test(ps));
  ok("見張りの長さは 85秒のまま", /\}, 85000\);/.test(ps));
  const stall = grab(ps, "function _auditStall(");
  for (const k of ["stage", "since_stage_ms", "visibility", "has_focus", "hidden_ms", "queue_len", "queue_busy", "queue_next", "late_max", "late_over_1s", "modal_open", "city_checked", "form"]) ok(`stall に ${k}`, new RegExp("\\b" + k + ":").test(stall));
  ok("止まった時の読み戻しは stall.form（点検の比べる form には入れない）", !/_audit\.form = _readRealproForm\(\);[\s\S]{0,40}notifyDone\('watchdog/.test(ps) && /form: _readRealproForm\(\),/.test(stall));

  // 記録の関数を動かす（段・操作・止まった時）
  const pctx = { Date, document: { visibilityState: "hidden", hasFocus: () => false, addEventListener() {}, querySelector: () => null, querySelectorAll: () => ({ length: 2 }) }, window: {}, isVisible: () => false, isClickQueueBusy: () => true, _readRealproForm: () => ({ rent_max: "85000" }), _clickQueue: [{ label: "city_code[]:27109" }] };
  vm.createContext(pctx);
  vm.runInContext("var _fillRunId = null, _audit = null;\n" + ps.slice(ps.indexOf("  var _fillStartedAt = 0;"), ps.indexOf("  function _visibleTexts(")), pctx);
  vm.runInContext("_auditReset('sa_x'); _auditStepP('fill_start', 'ward'); _auditStepP('cities', 4); _auditOp('city_code[]:27111', 120, 60120); _auditOp('city_code[]:27128', 90, 95); _auditStall();", pctx);
  const a = pctx._audit;
  ok("ops: {t, k, p, w} で残る", a.ops.length === 2 && a.ops[0].k === "city_code[]:27111" && a.ops[0].p === 120 && a.ops[0].w === 60120);
  ok("遅れの最大と1秒超の回数", a.late_max === 60000 && a.late_over_1s === 1);
  ok("stall: 最後の段・タブが隠れている・列の残り・次の操作", a.stall.stage === "cities" && a.stall.visibility === "hidden" && a.stall.queue_len === 1 && a.stall.queue_next === "city_code[]:27109" && a.stall.has_focus === false && a.stall.hidden_ms >= 0);
  ok("ブレインでない（run_id なし）時は記録しない", vm.runInContext("_auditReset(null); _auditOp('x', 1, 2); _auditStepP('y'); _audit === null", pctx));

  console.log("\n■ ③ bulk-dl: 結果を見た・並び替え・ページ・資料の送信の束の時刻を audit.timings に");
  const bd = read("bulk-dl.js");
  for (const k of ['"armed"', '"results"', '"start"', '"sort_wait"', '"sort_go"', '"page"', '"send"', '"sent"', '"send_err"', '"next"']) ok(`時刻 ${k} を記録する`, bd.includes("_tmark(" + k));
  ok("並び替えの前の間は記録した値と同じ乱数（_hd(900) を1回だけ引く）", /var _sortWaitMs = _hd\(900\);\s*_tmark\("sort_wait", _sortWaitMs\);[\s\S]*\}, _sortWaitMs\);/.test(bd));
  ok("sessionStorage に貯める（ページが読み直されても消えない）", /sessionStorage\.setItem\(AUDIT_T_KEY/.test(bd));
  ok("_auditResult が timings を載せて消す", /var _tl = _ttake\(\);\s*if \(_tl\) r\.timings = _tl;/.test(bd));
  // 動かす
  const store = {};
  const bctx = { sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }, Date, JSON, String };
  vm.createContext(bctx);
  vm.runInContext("var AUDIT_T_KEY = 'axlx_audit_timings';\n" + grab(bd, "function _treset(") + "\n" + grab(bd, "function _tmark(") + "\n" + grab(bd, "function _ttake("), bctx);
  vm.runInContext("_treset(null); _tmark('armed'); _tmark('results', 'rows=24'); _tmark('start', 'unsorted', '509cd061'); _tmark('sort_wait', 1023);", bctx);
  const t1 = vm.runInContext("_ttake()", bctx);
  ok("順に残る（お客様の id は最初に分かった時に付く）", t1.map((x) => x.k).join() === "armed,results,start,sort_wait" && t1[3].d === "1023");
  ok("取ったら消える", vm.runInContext("_ttake()", bctx) === null);
  vm.runInContext("_tmark('page', 'P1', 'A'); _tmark('page', 'P1', 'B');", bctx);
  ok("別のお客様の回に変わったら前の時刻を捨てる", vm.runInContext("_ttake()", bctx).length === 1);

  console.log("\n■ ④ search-audit.js: timings を段（dl:）に並べる・段は120件まで");
  const A = require(path.join(EXT, "search-audit.js"));
  ok("MAX_STEPS 120", A.MAX_STEPS === 120);
  const posts = [];
  let clock = 1000;
  const T = A.createTracker({ post: (b) => { posts.push(b); return Promise.resolve({ ok: true }); }, now: () => clock++ });
  const run = T.begin({ site: "realpro", customer_id: "509cd061", trigger: "web_brain" });
  T.attachFill(run.run_id, { audit: { v: 1, search_clicked: true, steps: [{ k: "fill_start", at: 1 }], ops: [{ t: 10, k: "sel:rental_cost2=80000", p: 120, w: 131 }] } });
  T.attachResult(run.run_id, { read_rows: 20, timings: [{ k: "sort_wait", at: 50, d: "1023" }, { k: "send", at: 60, d: "P1 1/2 n=10" }] });
  await T.finish(run.run_id, {});
  const fin = posts[posts.length - 1];
  ok("dl:sort_wait・dl:send が段に並ぶ（時刻は bulk-dl の時刻のまま）", fin.steps.some((s) => s.k === "dl:sort_wait" && s.at === 50 && s.d === "1023") && fin.steps.some((s) => s.k === "dl:send" && s.at === 60));
  ok("result に timings は残さない（二重に持たない）", !("timings" in fin.result) && fin.result.read_rows === 20);
  ok("ops は filled に残る", fin.filled.ops.length === 1 && fin.filled.ops[0].k === "sel:rental_cost2=80000");
  const big = A.clampAudit({ v: 1, ops: Array.from({ length: 80 }, (_, i) => ({ t: i, k: "city_code[]:" + i, p: 100, w: 100 })), steps: Array.from({ length: 60 }, (_, i) => ({ k: "s" + i, at: i, d: "x".repeat(100) })), stall: { stage: "cities", form: { wards: Array.from({ length: 100 }, (_, i) => "区" + i) } } }, 4000);
  ok("8KB を超える時は ops・stall.form も短くする", JSON.stringify(big).length <= 4000 && big.truncated === true);

  console.log("\n■ ⑤ 版・構文");
  const manifest = JSON.parse(read("manifest.json"));
  ok("manifest の版 2.5.31 以上", manifest.version.split(".").map(Number).reduce((a2, n) => a2 * 1000 + n, 0) >= 2005031);
  for (const f of ["popup.js", "page-script.js", "bulk-dl.js", "search-audit.js", "background.js"]) { let good = true; try { execFileSync(process.execPath, ["--check", path.join(EXT, f)], { stdio: "pipe" }); } catch (_) { good = false; } ok(`node --check ${f}`, good); }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
