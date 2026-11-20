// 実行: node tests/chrome-extension/active-clock-v2819.test.js
// v2.8.119 竹内さん「タイムアウトでボトルネックとなっている部分を取り除いていく必要がある」:
//   ① 手順の中の短い期限（駅の設定へ戻る9秒・沿線再開12秒・外し関数の6/12/14/3/2.5秒）が、
//      人らしい長い間・押しの列が忙しい間・タブが隠れている間まで数えて、押し直し・諦めを早めていた
//      → 「動ける間だけ数える時計」（_activeClock）に替える
//   ② 欄を開く（_ensureFieldVisible）が開かないまま期限で false を返していた（#1479 open_timeout:city_code[]）
//      → 1回だけ押し直す・それでもだめなら理由を残す
//   ③ 裏側: タブが隠れたままだと 30分の待ち切れまで待っていた（#1493 1864秒）
//      → 進捗が2分無い間だけタブを確かめて戻す・4回続けて見えなければ理由付きで閉じる
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, c, detail) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail !== undefined ? "  " + JSON.stringify(detail) : "")); }
}

function extractFrom(src, head) {
  const s = src.indexOf(head);
  if (s < 0) return null;
  let i = src.indexOf("{", s) + 1, depth = 1, inStr = null, inLine = false, inBlock = false;
  for (; i < src.length && depth > 0; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === "/" && n === "/") { inLine = true; continue; }
    if (c === "/" && n === "*") { inBlock = true; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    if (c === "}") depth--;
  }
  return src.slice(s, i);
}
const fn = (name) => extractFrom(ps, "  function " + name + "(");
const srcClock = fn("_activeClock");

function fakeClock() {
  const clk = { t: 1000000 };
  clk.Date = { now: () => clk.t };
  return clk;
}
function fakeWaitForClick(clk, log) {
  return function (tryFn, onDone, maxTries, retryMs, _pause, onFail) {
    log.calls++;
    for (let k = 0; k < maxTries; k++) {
      clk.t += retryMs;
      if (tryFn()) { onDone(); return; }
    }
    if (onFail) onFail();
  };
}

console.log("\n■ ① 動ける間だけ数える時計（_activeClock）");
ok("関数がある", !!srcClock);
function clockEnv() {
  const clk = fakeClock();
  const st = { busy: false, vis: "visible" };
  const ctx = { Date: clk.Date, Math, document: { get visibilityState() { return st.vis; } }, isClickQueueBusy: () => st.busy };
  vm.createContext(ctx);
  vm.runInContext(srcClock, ctx);
  return { clk, st, mk: vm.runInContext("_activeClock", ctx) };
}
{
  const e = clockEnv();
  const c = e.mk();
  ok("最初の1回は 0", c.tick() === 0);
  for (let k = 0; k < 10; k++) { e.clk.t += 450; c.tick(); }
  ok("動ける間はそのまま数える（450ms×10）", c.tick() === 4500, c.tick());
  e.st.busy = true;
  for (let k = 0; k < 20; k++) { e.clk.t += 450; c.tick(); }
  ok("押しの列が忙しい間は数えない", c.tick() === 4500, c.tick());
  e.st.busy = false;
  e.clk.t += 450; c.tick();
  e.st.vis = "hidden";
  for (let k = 0; k < 20; k++) { e.clk.t += 450; c.tick(); }
  ok("タブが隠れている間は数えない", c.tick() === 4950, c.tick());
  e.st.vis = "visible";
  e.clk.t += 30000;
  ok("見ていなかった長い間（人の長い休み）は1回分だけ（上限1.2秒）", c.tick() === 6150, c.tick());
}

console.log("\n■ ② 外し関数の期限は「動ける間」で数える");
function runStationClear(opts) {
  const clk = fakeClock();
  const log = { calls: 0, steps: [], next: 0, opened: 0, confirmed: 0, advance: 0, polls: 0 };
  const st = { st: 2, ln: 1, screen: "unknown" };
  const ctx = {
    window: {},
    Date: clk.Date,
    Math,
    document: {
      visibilityState: "visible",
      querySelectorAll: (sel) => {
        if (/station_id/.test(sel)) return { length: st.st };
        if (/route_id/.test(sel)) return { length: st.ln };
        return [];
      },
      querySelector: () => null,
    },
    isClickQueueBusy: () => log.opened >= 1 && log.polls < opts.busyPolls,
    isVisible: () => true,
    _graspStationModalScreen: () => {
      log.polls++;
      if (log.opened >= 1 && log.polls >= opts.busyPolls) st.screen = st.screen === "unknown" ? "station_list" : st.screen;
      return { kind: st.screen };
    },
    _markPanelOpened: () => {},
    _pressLearned: () => {},
    clickByText: (arr) => { if (/沿線・駅絞り込み/.test(arr[arr.length - 1])) { log.opened++; return true; } return false; },
    _advanceForcePlaceClearViaStationFirst: () => { log.advance++; if (log.advance >= 2) { st.st = 0; st.ln = 0; return true; } return false; },
    _pressConfirmListLikeHuman: () => { log.confirmed++; st.screen = "closed"; return true; },
    enqueueHumanClick: () => {},
    _clickEl: () => {}, _uiGapMin: () => 0, _uiGapMax: () => 0, _uiGapOpts: () => ({}),
    _audit: {},
    _auditStepP: (k, d) => log.steps.push([k, d]),
  };
  // 忙しい間も tryFn を呼ぶ（本物の waitForClick は呼ばないが、関数の中の自衛も確かめる）
  ctx.waitForClick = fakeWaitForClick(clk, log);
  const origBusy = ctx.isClickQueueBusy;
  ctx.isClickQueueBusy = () => { const b = origBusy(); if (b) log.polls++; return b; };
  vm.createContext(ctx);
  vm.runInContext(srcClock + "\n" + fn("_leftoverProgressNew") + "\n" + fn("_leftoverProgressStep") + "\n" + fn("_clearStationsBeforeWardThen"), ctx);
  vm.runInContext("_clearStationsBeforeWardThen", ctx)(() => { log.next++; }, "所在地");
  return log;
}
{
  const log = runStationClear({ busyPolls: 40 });
  ok("押した後に列が18秒忙しくても押し直さない（旧: 6秒で二度押し）", log.opened === 1, log.opened);
  ok("開けなかった扱いにしない（旧: 12秒で fail_open）", !log.steps.some((s) => /開けず/.test(s[1])) && log.confirmed === 1 && log.next === 1, log.steps);
}
const srcW = fn("_clearWardsBeforeStationThen");
{
  const clk = fakeClock();
  const log = { calls: 0, steps: [], next: 0, opened: 0, confirmed: 0, toggled: 0, polls: 0 };
  const w = { left: 2, panel: false };
  const doc = {
    visibilityState: "visible",
    querySelectorAll: (sel) => {
      if (/:checked/.test(sel)) { const arr = []; for (let k = 0; k < w.left; k++) arr.push({}); return arr; }
      if (/one_city/.test(sel)) { log.polls++; if (log.polls === 30) { doc.visibilityState = "visible"; w.panel = true; } return w.panel ? [{}] : []; }
      return [];
    },
    querySelector: () => (w.panel ? {} : null),
  };
  const ctx = {
    window: {}, Date: clk.Date, Math, document: doc,
    isClickQueueBusy: () => false,
    isVisible: () => true,
    clickByText: (arr) => { if (/所在地絞り込み/.test(arr[arr.length - 1])) { log.opened++; doc.visibilityState = "hidden"; return true; } return false; },
    _pressLearned: () => {},
    _labelForCheckbox: (cb) => cb,
    _toggleCheckboxLikeHuman: () => { log.toggled++; w.left = Math.max(0, w.left - 1); },
    // 2.8.146: 見える区を1つずつ外す係（中身は ward-clear-one-v28146 で確かめる）
    _clearWardsOneByOne: (done) => {
      Array.from(ctx.document.querySelectorAll('input[name="city_code[]"]:checked, input[name="town_code[]"]:checked'))
        .filter((cb) => ctx.isVisible(ctx._labelForCheckbox(cb) || cb))
        .forEach((cb) => ctx._toggleCheckboxLikeHuman(cb, false));
      done();
    },
    _noteClearMethod: () => {},
    _pressConfirmListLikeHuman: () => { log.confirmed++; w.panel = false; return true; },
    _audit: {},
    _auditStepP: (k, d) => log.steps.push([k, d]),
    console: { log: () => {} },
  };
  ctx.waitForClick = fakeWaitForClick(clk, log);
  vm.createContext(ctx);
  vm.runInContext(srcClock + "\n" + fn("_leftoverProgressNew") + "\n" + fn("_leftoverProgressStep") + "\n" + srcW, ctx);
  vm.runInContext("_clearWardsBeforeStationThen", ctx)(() => { log.next++; });
  ok("タブが隠れていた13秒を数えず押し直さない（旧: 6秒で押し直し・14秒で諦め）", log.opened === 1 && log.toggled === 2 && log.next === 1, log);
  ok("押し直しの記録も出ない", !log.steps.some((s) => s[0] === "ward_clear_open_retry"), log.steps);
}
{
  const body = extractFrom(ps, "  function _advanceForcePlaceClearViaStationFirst(") || "";
  ok("駅の設定へ戻る9秒は動ける間で数える", /window\.__axlxPlaceClearGoAt = _placeClearClock\.tick\(\) \|\| 1;/.test(body) && /_placeClearClock\.tick\(\) - goAt > 9000/.test(body), null);
  ok("沿線再開12秒も動ける間で数える", /window\.__axlxPlaceClearReopenAt = _placeClearClock\.tick\(\) \|\| 1;/.test(body) && /_placeClearClock\.tick\(\) - reAt > 12000/.test(body), null);
  ok("この2つに壁時計が残っていない", !/Date\.now\(\) - goAt|Date\.now\(\) - reAt/.test(body));
  ok("外し関数2つにも壁時計が残っていない", !/Date\.now\(\)/.test(fn("_clearStationsBeforeWardThen")) && !/Date\.now\(\)/.test(srcW));
  ok("共有の時計がある", /var _placeClearClock = _activeClock\(\);/.test(ps));
}

console.log("\n■ ③ 欄を開く（_ensureFieldVisible）: 期限で1回押し直す");
const srcEF = fn("_ensureFieldVisible");
ok("関数がある", !!srcEF);
async function runEnsure(opts) {
  const clk = fakeClock();
  const timers = [];
  const log = { presses: 0, steps: [], busyUntil: 0 };
  const el = { open: false };
  const ctx = {
    window: {}, Date: clk.Date, Math: Object.create(Math, { random: { value: () => 0.5 } }),
    Promise,
    console: { log: () => {} },
    document: { visibilityState: "visible" },
    setTimeout: (f, ms) => { timers.push({ at: clk.t + (ms || 0), f }); },
    isClickQueueBusy: () => clk.t < log.busyUntil,
    isVisible: (x) => !!x.open,
    _openerForKind: () => ({ textContent: "所在地絞り込み＋", scrollIntoView: null }),
    _markPanelOpened: () => {}, _panelKindOf: () => "area",
    _intentDomainOfName: () => "open_area",
    _noteIntentUnderstood: () => {},
    _pressLearned: () => {
      log.presses++;
      if (opts.busyAfterPress) log.busyUntil = clk.t + opts.busyAfterPress;
      if (opts.openOn && log.presses === opts.openOn) el.open = true;
      if (opts.openAt) timers.push({ at: clk.t + opts.openAt, f: () => { el.open = true; } });
    },
    _audit: {},
    _auditStepP: (k, d) => log.steps.push([k, d]),
  };
  el.getBoundingClientRect = () => ({ width: el.open ? 100 : 0, height: el.open ? 20 : 0 });
  vm.createContext(ctx);
  vm.runInContext(srcClock + "\n" + srcEF, ctx);
  let result;
  const p = vm.runInContext("_ensureFieldVisible", ctx)(el, "city_code[]", 3000).then((r) => { result = r; });
  for (let guard = 0; guard < 2000 && result === undefined; guard++) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers.shift();
    if (!t) break;
    clk.t = Math.max(clk.t, t.at);
    t.f();
    await Promise.resolve();
  }
  await p;
  return { result, log };
}
(async function () {
  {
    const r = await runEnsure({ openOn: 1 });
    ok("1回で開けばそのまま（押し直さない）", r.result === true && r.log.presses === 1 && !r.log.steps.some((s) => s[0] === "open_field_retry"), r.log);
  }
  {
    const r = await runEnsure({ openOn: 2 });
    ok("1回目で開かなければ期限で1回押し直して開く（旧: そのまま false）", r.result === true && r.log.presses === 2, r.log);
    ok("押し直しを記録", r.log.steps.some((s) => s[0] === "open_field_retry" && /city_code/.test(s[1])), r.log.steps);
  }
  {
    const r = await runEnsure({});
    ok("押し直しても開かなければ false（押すのは2回まで）", r.result === false && r.log.presses === 2, r.log);
    ok("開かなかった理由を記録", r.log.steps.some((s) => s[0] === "open_field_timeout"), r.log.steps);
  }
  {
    const r = await runEnsure({ busyAfterPress: 20000, openAt: 15000 });
    ok("押した後に列が忙しい間は期限を進めない（15秒後に開いても押し直さない）", r.result === true && r.log.presses === 1, r.log);
  }

  console.log("\n■ ④ 裏側: タブが隠れたまま30分待たない");
  const waiter = extractFrom(bg, "function _createFillDoneWaiter(") || "";
  ok("進捗が2分無い時だけ確かめる", /Date\.now\(\) - _hidLastProg < 120000\) return;/.test(waiter));
  ok("1分ごと", /\}, 60000\);/.test(waiter));
  ok("見えない時はウィンドウを戻して記録", /_auditStep\(_hidRid, "tab_hidden_stall"/.test(waiter) && /_restoreWindowForTab\(r\.tabId/.test(waiter));
  ok("4回続けて見えなければ理由付きで閉じる", /_hidN >= 4/.test(waiter) && /onTimeout\("AXLX_TAB_HIDDEN:/.test(waiter));
  ok("進捗が来たら数え直す", /entry\.restart = function \(\) \{[\s\S]*?_hidLastProg = Date\.now\(\);\s*_hidN = 0;/.test(waiter));
  ok("待ちが終われば見張りも止まる", /if \(_fillDoneWaiters\.indexOf\(entry\) < 0\) \{ clearInterval\(_hidWatch\); return; \}/.test(waiter));

  const srcHid = extractFrom(bg, "async function _fillTabHiddenCheck(");
  ok("タブ確認の関数がある", !!srcHid);
  async function hid(tabs, probes, cid) {
    const ctx = {
      Promise, String,
      chrome: { tabs: { query: async () => tabs } },
      _probeRealproTab: async (id) => probes[id],
      _probeItandiTab: async (id) => probes[id],
    };
    vm.createContext(ctx);
    vm.runInContext(srcHid, ctx);
    return vm.runInContext("_fillTabHiddenCheck", ctx)({ site: "realnetpro", customerId: cid });
  }
  {
    const r = await hid([{ id: 1 }, { id: 2 }], { 1: { pong: true, vis: "visible", fillCustomerId: "B" }, 2: { pong: true, vis: "hidden", fillCustomerId: "A" } }, "A");
    ok("待っている客のタブを見る（隠れている）", r && r.hidden === true && r.tabId === 2, r);
  }
  {
    const r = await hid([{ id: 1 }], { 1: { pong: true, vis: "visible", fillCustomerId: "A" } }, "A");
    ok("見えていれば hidden ではない", r && r.hidden === false, r);
  }
  {
    const r = await hid([{ id: 1 }], { 1: { pong: false } }, "A");
    ok("応答が無いタブだけなら判断しない（null）", r === null, r);
  }
  {
    const r = await hid([{ id: 1 }, { id: 2 }], { 1: { pong: true, vis: "hidden" }, 2: { pong: true, vis: "visible" } }, "A");
    ok("客が分からない時は全部隠れている時だけ hidden", r && r.hidden === false, r);
  }

  console.log("\n■ 記録・版");
  const pin = (ps.match(/var _PIN = \/\^\(([^)]*)\)\//) || [])[1] || "";
  ["open_field_retry", "open_field_timeout"].forEach((k) => ok("記録が間引かれない: " + k, pin.split("|").indexOf(k) >= 0));
  ok("manifest が 2.8.119", mf.version === "2.8.119", mf.version);
  ok("_AXLX_PAGE_VER が 2.8.119", /var _AXLX_PAGE_VER = "2\.8\.119";/.test(ps));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
