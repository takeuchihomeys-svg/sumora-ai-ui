/**
 * 2.8.308 竹内さん「リセットのところと並べ替えのところで止まったらスクショして画面把握してそこから拡張ツールがもう一度できるように保険」
 *   リセットが空にならない・押せない時: 撮影 → 画面把握 → 空なら成功 → 空でなければもう1回押す → それでもだめな時だけ従来の外し
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const bg = rd("chrome-extension/background.js");
const ps = rd("chrome-extension/page-script.js");
const sa = rd("chrome-extension/search-audit.js");
const rules = rd("app/lib/auto-procedure-rules.ts");
const man = JSON.parse(rd("chrome-extension/manifest.json"));
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) pass++; else { fail++; console.log("NG: " + n + (e === undefined ? "" : " " + JSON.stringify(e).slice(0, 200))); } }

console.log("\n■ 版");
ok(
  "manifest = page = 手順書の見直し上限（≥2.8.308）",
  man.version === (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] &&
    (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] === man.version &&
    man.version.split(".").map(Number)[2] >= 308,
  man.version
);

console.log("\n■ 配線");
ok("_resetWithInsurance がある", /async function _resetWithInsurance\(customerId, runId, phase\)/.test(bg));
ok("送付後のリセットが保険つきを呼ぶ", /rr = await _resetWithInsurance\(customerId, auditRunId, "post_send_clear"\)/.test(bg));
ok("入力前のリセットが保険つきを呼ぶ", /rr = await _resetWithInsurance\(cid, runId, "pre_fill_reset"\)/.test(bg));
ok("撮影の名前を渡せる（reset_stuck）", /async function _resetShot\(shotTab, runId, customerId, whatLabel\)/.test(bg) && /what: whatLabel \|\| "reset_verified"/.test(bg));
ok("保険の段が点検に残る（KEEP_STEP・RULE_STEP の両方）", (sa.match(/reset_stuck_shot\|reset_stuck_grasp\|reset_stuck_recovered\|reset_retry/g) || []).length >= 2);

console.log("\n■ 保険の関数を実際に動かす");
const s0 = bg.indexOf("async function _resetWithInsurance");
const s1 = bg.indexOf("async function _postSendResetRealpro(");
// 2.8.328: 押すタブの選び方は入力と同じ1か所（_pickRealproResetTab）を使う → 一緒に読み込む
const pk0 = bg.indexOf("function _pickRealproResetTab(");
const fnSrc = (pk0 < 0 ? "" : bg.slice(pk0, bg.indexOf("\n}\n", pk0) + 3)) + bg.slice(s0, s1);

function run(opts) {
  const steps = [];
  const calls = { reset: 0, shot: 0, quiet: 0, phase: 0 };
  const results = opts.results.slice();
  const ctx = {
    console,
    _batchShouldStop: !!opts.stop,
    _manualBulkAlive: true,
    Promise, setTimeout: (fn) => setImmediate(fn), String, Date,
    _bulkWaitShow: () => {}, _bulkPressShow: () => {},
    _postSendResetRealpro: async () => { calls.reset++; return results.shift() || { ok: false, why: "none" }; },
    _auditStep: (rid, k, n) => steps.push(k + ":" + n),
    _auditOpenRunId: () => "run1",
    chrome: {
      tabs: { query: async () => [{ id: 7, active: true }] },
      scripting: { executeScript: async () => [{ result: opts.grasp }] },
    },
    _resetShot: async () => { calls.shot++; return "ok 10KB"; },
    _withTimeout: (p) => Promise.resolve(p),
    _bulkPhaseSet: () => { calls.phase++; },
    _quietSet: () => { calls.quiet++; },
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc + "\nthis.f = _resetWithInsurance;", ctx);
  return ctx.f("c1", "run1", "post_send_clear").then((r) => ({ r, steps, calls }));
}

(async () => {
  let t = await run({ results: [{ ok: true, left: 0, reset: true }], grasp: null });
  ok("最初で成功なら何もしない（撮らない・2回押さない）", t.r.ok === true && t.calls.reset === 1 && t.calls.shot === 0 && t.steps.length === 0, t);

  t = await run({ results: [{ skipped: "no_tab" }], grasp: null });
  ok("skipped はそのまま返す（保険を入れない）", t.r.skipped === "no_tab" && t.calls.reset === 1 && t.calls.shot === 0, t);

  t = await run({ results: [{ ok: false, why: "reset_not_empty:x", left: 3 }], grasp: { ok: true, empty: true, ready: true, left: 0 } });
  ok("止まったが画面は空だった → 成功（押し直さない）", t.r.ok === true && t.r.recovered === true && t.calls.reset === 1 && t.calls.shot === 1 && t.steps.some((s) => /^reset_stuck_recovered/.test(s)), t);

  t = await run({ results: [{ ok: false, why: "reset_not_empty:x", left: 3 }, { ok: true, left: 0, reset: true }], grasp: { ok: true, empty: false, ready: true, left: 3, detail: "stations=3" } });
  ok("空でない → 撮影→把握→もう1回押して成功", t.r.ok === true && t.calls.reset === 2 && t.calls.shot === 1 && t.steps.some((s) => /^reset_stuck_grasp/.test(s)) && t.steps.some((s) => /^reset_retry:2回目で空/.test(s)), t);
  ok("2回目の前に待ちの上限を張り直す（phase と quiet）", t.calls.phase === 1 && t.calls.quiet === 1, t.calls);

  t = await run({ results: [{ ok: false, why: "press_timeout" }, { ok: false, why: "reset_not_empty:y", left: 2 }], grasp: { ok: true, empty: false, left: 2 } });
  ok("2回ともだめ → 止める（stop・次の客へ進まない・従来の外しへ行かない）・押すのは2回まで", t.r.ok === false && t.r.stop === true && t.calls.reset === 2, t);

  t = await run({ results: [{ ok: false, why: "reset_not_empty:y" }], grasp: null, stop: true });
  ok("ストップ要求の時は保険を入れない", t.calls.reset === 1 && t.calls.shot === 0 && t.r.ok === false, t);

  t = await run({ results: [{ ok: false, why: "error", notPressed: true }, { ok: true, left: 0, reset: true }], grasp: null });
  ok("把握が読めなくても（null）もう1回押す", t.r.ok === true && t.calls.reset === 2, t);

  t = await run({ results: [{ ok: false, why: "press_timeout" }, { ok: false, why: "x" }], grasp: { ok: true, empty: false, left: 2 } });
  ok("保険の前に60〜90秒待つ（reset_insure_wait・完了の通知が来ない）", t.steps.some((s) => /^reset_insure_wait:完了の通知が来ない/.test(s)) && t.steps.some((s) => /さらに(6\d|7\d|8\d|90)秒待って/.test(s)), t.steps);

  console.log("\n■ 手順書");
  const block = (id) => { const i = rules.indexOf('id: "' + id + '"'); return i < 0 ? "" : rules.slice(i, rules.indexOf("\n  },", i)); };
  ok("決まり reset_retry_insurance がある（since 2.8.308・marker は関数）", /since: "2\.8\.308"/.test(block("reset_retry_insurance")) && /marker: "_resetWithInsurance\("/.test(block("reset_retry_insurance")));
  ok("reset_between_customers に古い『空でも数が増えなければ従来の外しへ』が残っていない", !/空でも数が増えなければ従来の1つずつ外しへ/.test(block("reset_between_customers")));
  ok("reset_between_customers が保険（もう1回押す）を書く", /reset_retry_insurance/.test(block("reset_between_customers")));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
