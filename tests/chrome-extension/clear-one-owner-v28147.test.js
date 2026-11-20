// 2.8.147（2026-11-20 竹内さん「外し方も入れるのと同じようにちゃんと１つずつ」「つまらないようにする」「精度も上げる」）
//   ① 前客の残チェック（間取り・ペット等）も1つずつ「送る→カーソルで押す→外れたか確かめる→次」（_clearChecksOneByOne）
//   ② 外しは同時に1つだけ: 次客の入力は送付後の外しを待つ（60秒で止めて引き継ぐ）・引き継いだ古い外しは押すのをやめる
//   ③ 駅・沿線の外しも小窓の一覧の中で送る（_scrollIntoScrollParent）
//   ④ 区の外しの小窓は左の帯の学んだ開き方を先に使う
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const EXT = path.join(__dirname, "../../chrome-extension");
const ROOT = path.join(__dirname, "../..");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("✓", name); }
  else { fail++; console.log("✗", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ps = read("page-script.js");
const A = require(path.join(EXT, "search-audit.js"));

function makeSandbox(items, extra) {
  const steps = [];
  const presses = [];
  const inputs = items.map((w) => ({ name: w.name || "eq_rm[]", value: w.code, checked: true, isConnected: true, stick: !!w.stick }));
  const labels = inputs.map((cb, i) => ({ textContent: items[i].label || items[i].code, hidden: !!items[i].hidden, cb, parentElement: null }));
  let pending = 0;
  const sb = Object.assign({
    console, Math, Date, String, Number, Array, setTimeout, clearTimeout,
    _audit: {},
    _axHumanTookOver: false,
    _lastScrollAt: 0, _lastScrollDir: 0,
    _ln: () => 5,
    _auditStepP: (k, d) => steps.push([k, String(d || "")]),
    _labelForCheckbox: (cb) => labels[inputs.indexOf(cb)],
    isVisible: (el) => !el.hidden,
    _visibleHitPoint: () => ({ x: 1, y: 1 }),
    _graspAreaModalScreen: () => ({ kind: "ward_list", wardVis: 72, townVis: 0 }),
    window: { getComputedStyle: () => ({ display: "block", visibility: "visible", overflowY: "visible" }), innerHeight: 800 },
    document: {
      body: {}, documentElement: {},
      querySelectorAll: () => inputs.filter((c) => c.checked),
    },
    _toggleCheckboxLikeHuman: (cb, wantOn) => {
      presses.push({ code: cb.value, wantOn, busy: pending, at: Date.now() });
      pending++;
      setTimeout(() => { if (!cb.stick) cb.checked = !!wantOn; pending--; }, 30);
    },
    whenClickQueueIdle: (cb) => cb(),
  }, extra || {});
  labels.forEach((l) => { l.getBoundingClientRect = () => ({ top: 100, bottom: 120, width: 80, height: 20 }); l.scrollIntoView = () => {}; });
  return { sb, steps, presses, inputs };
}

(async () => {
  const genAt = ps.indexOf("var _clearGen = 0;");
  const genEnd = ps.indexOf("function _postSendClear(done)", genAt);
  const genSrc = ps.slice(genAt, genEnd);
  const oneAt = ps.indexOf("function _scrollIntoScrollParent(el)");
  const oneEnd = ps.indexOf("function _clearWardsBeforeStationThen(", oneAt);
  const oneSrc = ps.slice(oneAt, oneEnd);

  console.log("■ ① 前客の残チェックも1つずつ");
  const runAt = ps.indexOf("var _runUncheck = function (onlyRe, skipRe, after)");
  const run = ps.slice(runAt, ps.indexOf("var _openThenUncheck = function ()", runAt));
  ok("_runUncheck は _clearChecksOneByOne で1つずつ", /_clearChecksOneByOne\(function \(\) \{ return _toUncheck; \}/.test(run) && /"前客の残チェック", "clear_one"\)/.test(run));
  ok("まとめて順番待ちに積まない（enqueueHumanClick の forEach が無い）", !/enqueueHumanClick/.test(run));
  ok("押す相手を label[for] で決めない（選ぶ時と同じ _labelForCheckbox）", !/label\[for=/.test(run));
  ok("外した後のパネル清算は残す", /_settlePanelDebtThen\("前客クリア後のパネル清算"/.test(run));
  ok("決まりの印（marker）がある", /入れる時と同じく1つずつ: 送る→カーソルで押す/.test(run));
  {
    const { sb, steps, presses, inputs } = makeSandbox([
      { code: "1K", name: "layout[]" }, { code: "2LDK", name: "layout[]" }, { code: "ペット", name: "eq_rm[]" },
    ]);
    vm.createContext(sb);
    vm.runInContext("var _clearGen = 0;\nfunction _clearGenStale(gen) { return gen != null && gen !== _clearGen; }\n" + oneSrc, sb);
    let doneN = 0;
    sb._clearChecksOneByOne(function () { return inputs; }, () => { doneN++; }, "試し", "clear_one");
    await sleep(800);
    ok("3つとも外れた", inputs.every((c) => !c.checked), inputs.map((c) => c.checked));
    ok("1つずつ（重ね押し0）", presses.length === 3 && presses.every((p) => p.busy === 0), presses);
    ok("印: clear_one ×3・ok ×3・done", steps.filter((s) => s[0] === "clear_one").length === 3 && steps.filter((s) => s[0] === "clear_one_ok").length === 3 && steps.some((s) => s[0] === "clear_one_done"), steps);
    ok("終わりの合図は1回", doneN === 1, doneN);
  }
  {
    const { sb, steps, presses, inputs } = makeSandbox([{ code: "1K", name: "layout[]", hidden: true }, { code: "2K", name: "layout[]" }]);
    vm.createContext(sb);
    vm.runInContext("var _clearGen = 0;\nfunction _clearGenStale(gen) { return gen != null && gen !== _clearGen; }\n" + oneSrc, sb);
    let doneN = 0;
    sb._clearChecksOneByOne(function () { return inputs; }, () => { doneN++; }, "試し", "clear_one");
    await sleep(3500);
    ok("場所以外は見えなくても飛ばさず押す（前の形と同じ・小窓の外の欄）", presses.some((p) => p.code === "1K"), presses);
    ok("終わりの合図は1回（詰まらない）", doneN === 1, doneN);
    void steps;
  }

  console.log("■ ② 外しは同時に1つだけ（引き継いだら古い外しは止める）");
  {
    const items = [{ code: "27141", name: "city_code[]" }, { code: "27142", name: "city_code[]" }, { code: "27143", name: "city_code[]" }, { code: "27144", name: "city_code[]" }];
    const { sb, steps, presses, inputs } = makeSandbox(items);
    vm.createContext(sb);
    vm.runInContext("var _clearGen = 0;\nfunction _clearGenStale(gen) { return gen != null && gen !== _clearGen; }\n" + oneSrc, sb);
    let doneN = 0;
    sb._clearWardsOneByOne(() => { doneN++; }, "送付後");
    await sleep(40);
    vm.runInContext("_clearGen++;", sb); // 次客の入力が引き継いだ
    await sleep(1500);
    ok("引き継いだ後は古い外しが押さない（1つ目で止まる）", presses.length <= 1, presses);
    ok("残りは押していない", inputs.slice(1).every((c) => c.checked), inputs.map((c) => c.checked));
    ok("止めても終わりの合図は返す（詰まらない）", doneN === 1, doneN);
    ok("止めた理由を残す", steps.some((s) => s[0] === "ward_clear_one_done" && /引き継ぎ/.test(s[1])), steps.filter((s) => /done/.test(s[0])));
  }
  {
    // 送付後の外しが走っていない時はすぐ進む・世代を進める
    const sb = { window: {}, _audit: {}, _axHumanTookOver: false, _auditStepP: () => {}, setTimeout, Date, Math };
    vm.createContext(sb);
    vm.runInContext(genSrc, sb);
    let n = 0;
    sb._waitPostSendClearThen(() => { n++; });
    ok("走っていなければ待たずに進む", n === 1);
    ok("世代を進める（自分が持ち主）", vm.runInContext("_clearGen", sb) === 1);
  }
  {
    // 走っている時は終わるまで待つ
    const steps = [];
    const sb = { window: { __axlxPostSendClearRunning: true }, _audit: {}, _axHumanTookOver: false, _auditStepP: (k, d) => steps.push([k, d]), setTimeout, Date, Math };
    vm.createContext(sb);
    vm.runInContext(genSrc, sb);
    let n = 0;
    sb._waitPostSendClearThen(() => { n++; });
    await sleep(400);
    ok("走っている間は進まない", n === 0);
    sb.window.__axlxPostSendClearRunning = false;
    await sleep(500);
    ok("終わったら1回だけ進む", n === 1, n);
    ok("待った印 post_send_wait → post_send_wait_done", steps[0][0] === "post_send_wait" && steps.some((s) => s[0] === "post_send_wait_done"), steps);
  }
  ok("60秒で止めて引き継ぐ（post_send_cancel・必ず next）", /Date\.now\(\) - t0 > 60000\)[\s\S]{0,260}post_send_cancel[\s\S]{0,120}next\(\);/.test(genSrc));
  const resetHead = ps.slice(ps.indexOf("function _doReset(callback, _resetRound)"), ps.indexOf("function _doReset(callback, _resetRound)") + 2500);
  ok("次客の入力の最初（round 0）で送付後の外しを待つ", /_rr === 0 && !\(callback && callback\.__axPsWaited\)[\s\S]{0,200}_waitPostSendClearThen\(function \(\) \{ _doReset\(callback, 0\); \}\)/.test(resetHead));
  const psc = ps.slice(genEnd, ps.indexOf("function _postSendClear(done)") + 1800);
  ok("送付後の外しは始める時に世代を持つ", /window\.__axlxPostSendGen = \+\+_clearGen;/.test(psc));
  ok("送付後の外しが120秒で終わらない時は中の外しも止める", /if \(_clearGen === window\.__axlxPostSendGen\) _clearGen\+\+;/.test(psc));
  const wbs = ps.slice(oneEnd, ps.indexOf("function _stationNamesAbsentStable", oneEnd));
  ok("区の開き直しの係: 世代が変わったら止める", /prog\.gen = _clearGen|gen: _clearGen/.test(wbs) && /if \(_clearGenStale\(prog\.gen\)\) \{ stale = true; return true; \}/.test(wbs));
  const sbw = ps.slice(ps.indexOf("function _clearStationsBeforeWardThen("), ps.indexOf("function _clearStationsBeforeWardThen(") + 12000);
  ok("駅の開き直しの係: 世代が変わったら止める", /if \(_clearGenStale\(prog\.gen\)\) \{ stale = true; return true; \}/.test(sbw));
  ok("決まりの印（marker）がある", /外しは同時に1つだけ。引き継いだら古い外しは止める/.test(ps));

  console.log("■ ③ 駅・沿線も小窓の中で送る");
  const stAt = ps.indexOf("function _uncheckVisibleStationsLikeHuman");
  const st = ps.slice(stAt, stAt + 7000);
  ok("駅・沿線の外しは _scrollIntoScrollParent", (st.match(/_scrollIntoScrollParent\((visLeft\.hit|hit0)\)/g) || []).length >= 4, (st.match(/_scrollIntoScrollParent\([^)]*\)/g) || []));
  ok("画面の scrollIntoView だけで済ませない", !/visLeft\.hit\.scrollIntoView\(|hit0\.scrollIntoView\(/.test(st));

  console.log("■ ④ 区の外しの小窓は学んだ開き方を先に");
  ok("左の帯の開き方 → 無ければ文字で探す", /_sidebarOpenerEl\("所在地絞り込み", _SIDEBAR_OTHER_RE\);\s*if \(_arOp\) \{[\s\S]{0,200}_pressLearned\(_arOp[\s\S]{0,200}if \(!_arOpened\) clickByText\(/.test(wbs));
  ok("開いた方法を残す（ward_clear_open）", /_auditStepP\("ward_clear_open"/.test(wbs));

  console.log("■ 点検記録・決まり・版");
  ok("page 側 _PIN に clear_one・post_send_wait・post_send_cancel・clear_cancelled", /var _PIN = [^\n]*\|clear_one\|post_send_wait\|post_send_cancel\|clear_cancelled/.test(ps));
  ok("RULE_STEP に clear_one・post_send_wait", A.RULE_STEP.test("page:clear_one_done") && A.RULE_STEP.test("page:post_send_wait") && A.RULE_STEP.test("page:post_send_wait_done"));
  ok("KEEP_STEP に clear_one_ng・done・post_send_cancel・clear_cancelled", A.KEEP_STEP.test("page:clear_one_ng") && A.KEEP_STEP.test("page:clear_one_done") && A.KEEP_STEP.test("page:post_send_cancel") && A.KEEP_STEP.test("page:clear_cancelled"));
  const rules = fs.readFileSync(path.join(ROOT, "app/lib/auto-procedure-rules.ts"), "utf8");
  ok("決まり clear_one_by_one・clear_single_owner", /id: "clear_one_by_one"/.test(rules) && /id: "clear_single_owner"/.test(rules));
  ok("_AXLX_RULES_DONE に2つ", /_AXLX_RULES_DONE[\s\S]{0,4000}"clear_one_by_one", "clear_single_owner"/.test(ps));
  const man = JSON.parse(read("manifest.json"));
  const verGe = (v) => { const [a, b, c] = String(v).split(".").map(Number); return a > 2 || (a === 2 && (b > 8 || (b === 8 && c >= 147))); };
  ok("manifest 2.8.147 以上", verGe(man.version), man.version);
  ok("_AXLX_PAGE_VER 2.8.147 以上", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1]));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
