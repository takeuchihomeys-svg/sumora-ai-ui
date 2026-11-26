/**
 * 2.8.315 実測 #1661（竹内さん「リセットはちゃんと押せていた。押したと把握できていなかったのか」）:
 *   リセットのクリックは人の動きのキューで遅れて実行される。旧は 15 秒で「押せず」と返したが実際は押されていた。
 *   ① page-script の _resetPress を仮想時計で実際に動かす（遅れて押された／ずっと押されない）
 *   ② 裏の「返事が時間切れでも読み直されていたら遅れて押した」の作りと上限
 *   ③ 決まり・点検の段・版
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const ps = rd("chrome-extension/page-script.js");
const bg = rd("chrome-extension/background.js");
const sa = rd("chrome-extension/search-audit.js");
const rules = rd("app/lib/auto-procedure-rules.ts");
const man = JSON.parse(rd("chrome-extension/manifest.json"));

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 240))); } }
function semverOk(v, min) {
  const a = String(v).split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
}
function cut(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n  }\n");
  return e < 0 ? s : s.slice(0, e + 5);
}

console.log("\n■ 版");
ok("manifest ≥2.8.315", semverOk(man.version, "2.8.315"), man.version);

// ---- 仮想時計で _resetPress を動かす ----
function makeEnv(clickDelayMs) {
  const timers = [];
  let now = 0;
  const env = {
    steps: [],
    queue: [],
    result: null,
    clicked: 0,
  };
  const btn = { __axPending: false, textContent: "リセット", children: [] };
  const ctx = {
    Date: { now: () => now },
    Math,
    JSON,
    document: { hidden: false },
    window: { __axlxBootAt: 111, _axFillRunning: false, sessionStorage: { setItem() {}, removeItem() {} } },
    _clickQueue: env.queue,
    _axHumanTookOver: false,
    _resetVia: "learned",
    _audit: true,
    _auditStepP: (k, d) => env.steps.push([k, String(d)]),
    _closeStrayWindows: () => 0,
    whenClickQueueIdle: (cb) => { (function poll() { if (env.queue.length === 0 && !env._busy) cb(); else ctx.setTimeout(poll, 150); })(); },
    isClickQueueBusy: () => env.queue.length > 0 || !!env._busy,
    humanRand: () => 800,
    _findResetBtn: () => btn,
    _resetFormState: () => ({ detail: "stations=3" }),
    _resultCountNow: () => ({ n: 10 }),
    _aimByEl: () => null,
    _resetAimPoint: () => ({ aim: null, kind: "center" }),
    _uiGapOpts: () => ({}),
    _uiGapMin: () => 900,
    _uiGapMax: () => 1800,
    _AX_RESET_PRESSED_KEY: "k",
    _AX_RESET_CLEAN_KEY: "c",
    _clickEl: () => { env.clicked++; },
    enqueueHumanClick: (el, fn) => {
      const item = { el, fn };
      env.queue.push(item);
      // 人の動きのキュー: clickDelayMs 後に実際のクリックが実行されてキューから出る
      ctx.setTimeout(() => {
        const i = env.queue.indexOf(item);
        if (i < 0) return; // 取り消された
        env.queue.splice(i, 1);
        item.fn(el);
      }, clickDelayMs);
      return true;
    },
    setTimeout: (fn, ms) => { const t = { at: now + (ms || 0), fn, dead: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.dead = true; },
  };
  env.run = (limitMs) => {
    while (now <= limitMs) {
      const due = timers.filter((t) => !t.dead).sort((a, b) => a.at - b.at)[0];
      if (!due || due.at > limitMs) break;
      now = Math.max(now, due.at);
      due.dead = true;
      due.fn();
    }
  };
  env.now = () => now;
  vm.createContext(ctx);
  const consts = "var _RESET_PRESS_SOFT_MS = 15000;\nvar _RESET_PRESS_HARD_MS = 40000;\nvar _RESET_PRESS_POLL_MS = 2000;\n";
  vm.runInContext(consts + cut(ps, "  function _resetPress(done) {") + "\nthis._resetPress = _resetPress;", ctx);
  env.start = () => ctx._resetPress((r) => { env.result = r; env.doneAt = now; });
  return env;
}

console.log("\n■ ① 実際に動かす");
// 速い（5秒で押される）→ 普通に押した
let e1 = makeEnv(5000); e1.start(); e1.run(60000);
ok("速い: 押した扱い", e1.result && e1.result.ok === true && e1.result.pressed === true, e1.result);
ok("速い: 15秒の印は出ない", !e1.steps.some((s) => s[0] === "reset_press_slow"), e1.steps);
// 遅い（22秒で押される・旧は15秒で「押せず」だった）→ 押した扱い
let e2 = makeEnv(22000); e2.start(); e2.run(90000);
ok("遅い(22秒): 押した扱い（旧は press_timeout15 で押せず）", e2.result && e2.result.ok === true && e2.result.pressed === true, e2.result);
ok("遅い(22秒): クリックは1回だけ", e2.clicked === 1, e2.clicked);
ok("遅い(22秒): 15秒を過ぎた印が残る", e2.steps.some((s) => s[0] === "reset_press_slow"), e2.steps);
ok("遅い(22秒): 取り消しは無い", !e2.steps.some((s) => s[0] === "reset_press_cancel"));
// 遅い（35秒）→ まだ40秒以内なので押した扱い
let e3 = makeEnv(35000); e3.start(); e3.run(90000);
ok("かなり遅い(35秒): 押した扱い", e3.result && e3.result.ok === true && e3.result.pressed === true, e3.result);
// 押されない（600秒かかる）→ 40秒で取り消して「押せず」
let e4 = makeEnv(600000); e4.start(); e4.run(700000);
ok("押されない: 押せずを返す", e4.result && e4.result.ok === false && /^press_timeout4\d$/.test(String(e4.result.why)), e4.result);
ok("押されない: 40秒前後で返す（無限に待たない）", e4.doneAt >= 40000 && e4.doneAt <= 43000, e4.doneAt);
ok("押されない: 積んだクリックを取り消した（あとで勝手に押されない）", e4.queue.length === 0 && e4.clicked === 0, { q: e4.queue.length, c: e4.clicked });
ok("押されない: 取り消しの印が残る", e4.steps.some((s) => s[0] === "reset_press_cancel"), e4.steps);
// 入力中は断る
let e5 = makeEnv(1000);
e5.start();
ok("(参考)入力中でない時はすぐ断られない", e5.result === null);

console.log("\n■ ② 裏の遅れて押した把握");
const sec = bg.slice(bg.indexOf("async function _postSendResetRealpro"), bg.indexOf("/** ★ 2.8.297 版の比べ"));
ok("裏の押す待ちの上限が45秒（ページの40秒より長い）", /var RESET_PRESS_TIMEOUT_MS = 45000;/.test(bg));
ok("返事が press_timeout／返事なしなら読み直しを確かめる", /!_press \|\| \(_press\.ok === false && !_press\.skipped && \/\^press_timeout\/\.test/.test(sec));
ok("読み直し（reloaded）なら遅れて押した扱い", /_lr && _lr\.reloaded/.test(sec) && /late: true/.test(sec));
ok("遅れて押した扱いの後は従来どおり待機→空の確認へ進む", sec.indexOf("late_press") > 0 && sec.indexOf("late_press") < sec.indexOf("② 読み直しを待つ"));
ok("読み直されていなければ今まで通り押せず", /reset_press_late_check/.test(sec) && /reset_not_pressed:/.test(sec));

console.log("\n■ ③ 決まり・点検の段");
ok("rules に reset_press_late_grasp", /id: "reset_press_late_grasp"/.test(rules));
ok("_AXLX_RULES_DONE に reset_press_late_grasp", /"reset_press_late_grasp"/.test(ps));
ok("KEEP_STEP に page:reset_press_", /var KEEP_STEP = [^\n]*page:reset_press_/.test(sa));
ok("RULE_STEP に page:reset_press_", /var RULE_STEP = [^\n]*page:reset_press_/.test(sa));

console.log("\n" + (fail ? "✗ " + fail + " 件失敗" : "✓ 全部通過") + "（" + pass + " 項目）");
process.exit(fail ? 1 : 0);
