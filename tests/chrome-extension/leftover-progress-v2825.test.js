// 実行: node tests/chrome-extension/leftover-progress-v2825.test.js
// v2.8.125 2026-11-19 竹内さん「最大3回って形だと残ってしまう可能性がある」「入れたのを覚えていたら外せるので、完了したらちゃんと外すようにすれば問題ない。順番に行えば」
//   統括Pro: 案A（控え＋画面残りを1件ずつ外し「一覧が空」で完了・進捗なし2回で別経路・残れば汚れたまま検索せず止めて理由を残す）
//            案B（送付完了後に控えの順で外す）。実装前に「外しの完了線」を F57 として定義。
//   ① 進捗型の判定（_leftoverProgressStep・純関数）: 減っていれば回数無制限・2回続けて減らなければ別経路・別経路でも減らなければ終える・時間上限
//   ② 駅・沿線／区・町の外し関数が進捗型になっている（回数 3 の上限が無い）
//   ③ 台帳の名前単位の残り判定（_ledgerNamesLeft）と F57 の完了線（_f57Judge）
//   ④ きれい確認の関所: 完了線に届かない時は leftover_stuck で中止（汚れたまま検索しない）／台帳だけに残りがあり画面に無ければ進む
//   ⑤ 送付後の外し（案B）: page-script _postSendClear の fail-open・入力中は何もしない／background _postSendClearRealpro の off フラグ・タブなし・例外
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");

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
const extractFn = (name) => extractFrom(ps, "  function " + name + "(");

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

// ───────────────────────────────────────────────
console.log("\n■ ① 進捗型の判定（_leftoverProgressStep）");
const sb0 = {};
vm.createContext(sb0);
vm.runInContext(["_leftoverProgressNew", "_leftoverProgressStep"].map(extractFn).join("\n"), sb0);
const P = sb0._leftoverProgressNew, S = sb0._leftoverProgressStep;
{
  const prog = P(5, 0);
  const a = S(prog, 3, 1000), b = S(prog, 0, 2000);
  ok("残り 5→3 は続ける（減った）", a.action === "continue" && a.progressed === true, a);
  ok("残り 3→0 は完了", b.action === "done", b);
}
{
  // 20件が1つずつ減る＝20回目まで続く（回数上限3は無い）
  const prog = P(20, 0);
  let acts = [];
  for (let n = 19; n >= 0; n--) acts.push(S(prog, n, 1000 + (20 - n) * 100).action);
  ok("1つずつ減る間は回数制限なしで続け最後に done（19×continue→done）", acts.slice(0, 19).every((x) => x === "continue") && acts[19] === "done", acts);
}
{
  const prog = P(5, 0);
  const a = S(prog, 5, 1), b = S(prog, 5, 2), c = S(prog, 5, 3), d = S(prog, 5, 4);
  ok("1回減らない→continue（進捗なし1回）", a.action === "continue" && !a.progressed, a);
  ok("2回続けて減らない→別経路へ（alt）", b.action === "alt" && prog.route === "alt", b);
  ok("別経路の1回目は continue", c.action === "continue", c);
  ok("別経路でも2回続けて減らない→stuck（理由付き）", d.action === "stuck" && /別経路でも減らず/.test(d.why), d);
}
{
  const prog = P(5, 0);
  S(prog, 5, 1); S(prog, 5, 2);                    // alt へ
  const a = S(prog, 5, 3), b = S(prog, 2, 4), c = S(prog, 2, 5), d = S(prog, 0, 6);
  ok("別経路で減ったら進捗が戻る（flat を数え直す）→最後は done", a.action === "continue" && b.action === "continue" && b.progressed && c.action === "continue" && d.action === "done", [a, b, c, d]);
}
{
  const prog = P(5, 0);
  const a = S(prog, 4, 151000);
  ok("時間上限（150秒）を超えたら、減っていても stuck（回数ではなく時間が上限）", a.action === "stuck" && /時間上限150秒/.test(a.why), a);
}
{
  const prog = P(5, 0);
  const a = S(prog, 6, 1), b = S(prog, 7, 2);
  ok("残りが増えた時は進捗なし扱い（別経路へ）", a.action === "continue" && b.action === "alt", [a, b]);
}
{
  // どんな列でも必ず終わる（無限ループにならない）: 乱数列 2000本 × 最大 2000 回
  let bad = 0;
  for (let k = 0; k < 2000; k++) {
    const prog = P(8, 0);
    let t = 0, ended = false;
    for (let n = 0; n < 2000; n++) {
      t += 1000;
      const left = Math.floor(Math.random() * 9);
      const r = S(prog, left, t);
      if (r.action === "done" || r.action === "stuck") { ended = true; break; }
    }
    if (!ended) bad++;
  }
  ok("乱数の残り列でも必ず done か stuck で終わる（無限ループなし）", bad === 0, bad);
}

// ───────────────────────────────────────────────
console.log("\n■ ② 駅・沿線／区・町の外しが進捗型（回数上限3回が無い）");
ok("駅の外しに `_round < 2` の上限が無い", !/_clearStationsBeforeWardThen[\s\S]{0,1500}_round < 2/.test(extractFn("_clearStationsBeforeWardThen")));
ok("区の外しに `_round < 2` の上限が無い", !/_round < 2/.test(extractFn("_clearWardsBeforeStationThen")));
ok("駅の外しは進捗型の判定を通る", /_leftoverProgressStep\(prog, lx\.st \+ lx\.ln, clk\.tick\(\)\)/.test(extractFn("_clearStationsBeforeWardThen")));
ok("区の外しは進捗型の判定を通る", /_leftoverProgressStep\(prog, _wl, clk\.tick\(\)\)/.test(extractFn("_clearWardsBeforeStationThen")));
ok("時間は壁時計(Date.now)ではなく動ける間だけ数える時計（clk.tick）", !/Date\.now\(\)/.test(extractFn("_clearStationsBeforeWardThen")) && !/Date\.now\(\)/.test(extractFn("_clearWardsBeforeStationThen")));

function runStationClear(opts) {
  const clk = fakeClock();
  const log = { calls: 0, steps: [], next: 0, opened: 0, confirmed: 0, closeClicks: 0 };
  const st = { st: opts.start, ln: 0, screen: "closed" };
  const win = {};
  const ctx = {
    window: win,
    Date: clk.Date,
    document: {
      querySelectorAll: (sel) => {
        if (/station_id/.test(sel)) return { length: st.st };
        if (/route_id/.test(sel)) return { length: st.ln };
        return [];
      },
      querySelector: (sel) => (/this_window_close/.test(sel) && st.screen !== "closed" ? { close: true } : null),
    },
    isClickQueueBusy: () => false,
    isVisible: () => true,
    _graspStationModalScreen: () => ({ kind: st.screen }),
    _markPanelOpened: () => {},
    _pressLearned: () => {},
    clickByText: (arr) => {
      if (/沿線・駅絞り込み/.test(arr[arr.length - 1])) { log.opened++; st.screen = "station_list"; return true; }
      return false;
    },
    _advanceForcePlaceClearViaStationFirst: () => true,
    _pressConfirmListLikeHuman: () => {
      log.confirmed++;
      const seq = opts.seq;
      st.st = seq[Math.min(log.confirmed - 1, seq.length - 1)];
      if (opts.confirmCloses !== false) st.screen = "closed";
      if (opts.tickPerConfirmMs) clk.t += opts.tickPerConfirmMs;
      return true;
    },
    enqueueHumanClick: () => { log.closeClicks++; st.screen = "closed"; },
    _clickEl: () => {}, _uiGapMin: () => 0, _uiGapMax: () => 0, _uiGapOpts: () => ({}),
    _audit: {},
    _auditStepP: (k, d) => log.steps.push([k, d]),
    setTimeout: (f) => f(),
    _ln: () => 0,
  };
  ctx.waitForClick = fakeWaitForClick(clk, log);
  vm.createContext(ctx);
  vm.runInContext(["_activeClock", "_leftoverProgressNew", "_leftoverProgressStep", "_clearStationsBeforeWardThen"].map(extractFn).join("\n"), ctx);
  vm.runInContext("_clearStationsBeforeWardThen", ctx)(() => { log.next++; }, "所在地");
  return { log, st, win };
}
{
  const r = runStationClear({ start: 5, seq: [3, 0] });
  ok("駅 5→3→0: 2回で外し切り次へ（進捗を残す・別経路なし）", r.log.confirmed === 2 && r.log.next === 1 && r.st.st === 0 &&
    r.log.steps.some((s) => s[0] === "leftover_progress") && !r.log.steps.some((s) => s[0] === "leftover_alt_route"), { confirmed: r.log.confirmed, steps: r.log.steps.map((s) => s[0]) });
}
{
  const seq = [];
  for (let n = 11; n >= 0; n--) seq.push(n);
  const r = runStationClear({ start: 12, seq });
  ok("駅 12→0 を1つずつ減らす: 12回続けて外し切る（旧は3回で打ち切り）", r.log.confirmed === 12 && r.st.st === 0 && r.log.next === 1, { confirmed: r.log.confirmed, left: r.st.st });
}
{
  const r = runStationClear({ start: 5, seq: [5] });
  ok("駅 5のまま減らない: 4回で打ち切り（初回・retry・別経路・別経路retry）→次へ", r.log.confirmed === 4 && r.log.next === 1, { confirmed: r.log.confirmed });
  ok("別経路へ切り替えた印（leftover_alt_route）が1回", r.log.steps.filter((s) => s[0] === "leftover_alt_route").length === 1, r.log.steps.map((s) => s[0]));
  ok("外し切れず終えた理由が window.__axlxLeftoverWhy に残る（関所が leftover_stuck で使う）", /別経路でも減らず/.test(r.win.__axlxLeftoverWhy || ""), r.win.__axlxLeftoverWhy);
}
{
  const r = runStationClear({ start: 5, seq: [5, 5, 5, 2, 0] });
  ok("駅 5,5,5,2,0: 別経路で減れば最後まで続けて外し切る", r.log.confirmed === 5 && r.st.st === 0 && r.log.next === 1, { confirmed: r.log.confirmed, left: r.st.st });
}
{
  const r = runStationClear({ start: 5, seq: [5], confirmCloses: false });
  ok("別経路では開いたままのモーダルを一度閉じてから開き直す（別経路の2回で閉じ押下2回）", r.log.closeClicks === 2, r.log.closeClicks);
}
{
  const seq = [];
  for (let n = 199; n >= 0; n--) seq.push(n);
  const r = runStationClear({ start: 200, seq });
  ok("時間上限: 減り続けても150秒を超えたら終える（200→…の途中で次へ・理由=時間上限）", r.log.next === 1 && r.st.st > 0 && /時間上限/.test(r.win.__axlxLeftoverWhy || ""), { left: r.st.st, why: r.win.__axlxLeftoverWhy, confirmed: r.log.confirmed });
}

function runWardClear(opts) {
  const clk = fakeClock();
  const log = { calls: 0, steps: [], next: 0, opened: 0, confirmed: 0, toggled: 0, closeClicks: 0 };
  const w = { left: opts.left, panel: false };
  const win = {};
  const ctx = {
    window: win,
    Date: clk.Date,
    document: {
      querySelectorAll: (sel) => {
        if (/:checked/.test(sel)) {
          const arr = [];
          for (let k = 0; k < w.left; k++) arr.push({ hidden: !!opts.hidden });
          if (sel.indexOf("input[") === 0 && !/forEach/.test(sel)) return Object.assign(arr, { length: arr.length });
          return arr;
        }
        if (/one_city/.test(sel)) return w.panel ? [{ v: 1 }] : [];
        return [];
      },
      querySelector: () => (w.panel ? {} : null),
    },
    isClickQueueBusy: () => false,
    isVisible: (el) => !(el && el.hidden),
    clickByText: (arr) => {
      if (/所在地絞り込み/.test(arr[arr.length - 1])) { log.opened++; w.panel = true; return true; }
      return false;
    },
    _pressLearned: () => {},
    _labelForCheckbox: (cb) => cb,
    _toggleCheckboxLikeHuman: () => { log.toggled++; if (!opts.noEffect) w.left = Math.max(0, w.left - 1); },
    // 2.8.146: 見える区を1つずつ外す係（中身は ward-clear-one-v28146 で確かめる）
    _clearWardsOneByOne: (done) => {
      Array.from(ctx.document.querySelectorAll('input[name="city_code[]"]:checked, input[name="town_code[]"]:checked'))
        .filter((cb) => ctx.isVisible(ctx._labelForCheckbox(cb) || cb))
        .forEach((cb) => ctx._toggleCheckboxLikeHuman(cb, false));
      done();
    },
    _noteClearMethod: () => {},
    _pressConfirmListLikeHuman: () => { log.confirmed++; w.panel = false; return true; },
    enqueueHumanClick: () => { log.closeClicks++; w.panel = false; },
    _clickEl: () => {}, _uiGapMin: () => 0, _uiGapMax: () => 0, _uiGapOpts: () => ({}),
    _audit: {},
    _auditStepP: (k, d) => log.steps.push([k, d]),
    console: { log: () => {} },
    setTimeout: (f) => f(),
    _ln: () => 0,
  };
  ctx.waitForClick = fakeWaitForClick(clk, log);
  vm.createContext(ctx);
  vm.runInContext(["_activeClock", "_leftoverProgressNew", "_leftoverProgressStep", "_clearWardsBeforeStationThen"].map(extractFn).join("\n"), ctx);
  vm.runInContext("_clearWardsBeforeStationThen", ctx)(() => { log.next++; }, "駅");
  return { log, w, win };
}
{
  const r = runWardClear({ left: 6 });
  ok("区・町を1つずつ外して0→進む", r.w.left === 0 && r.log.next === 1 && r.log.toggled === 6, r.log);
}
{
  const r = runWardClear({ left: 3, noEffect: true });
  ok("区・町 3のまま減らない: 外し切れず終えて次へ（無限に回らない）・理由が残る（別経路でも減らず／時間上限）", r.log.next === 1 && /別経路でも減らず|時間上限/.test(r.win.__axlxLeftoverWhy || ""), { next: r.log.next, why: r.win.__axlxLeftoverWhy });
}
{
  const r = runWardClear({ left: 3, hidden: true });
  ok("区・町 見えない残（畳まれた町）だけ: カーソルで外せないので回し直さず終える・理由に「見えない残」", r.log.next === 1 && r.log.confirmed === 1 && /見えない残/.test(r.win.__axlxLeftoverWhy || ""), { next: r.log.next, conf: r.log.confirmed, why: r.win.__axlxLeftoverWhy });
}

// ───────────────────────────────────────────────
console.log("\n■ ③ 台帳の名前単位の残り（_ledgerNamesLeft）と F57 の完了線（_f57Judge）");
const sb1 = {};
vm.createContext(sb1);
vm.runInContext(["_ledgerNamesLeft", "_f57Judge", "_leftoverStuckText", "_planLeftover"].map(extractFn).join("\n"), sb1);
const NL = sb1._ledgerNamesLeft, F57 = sb1._f57Judge, plan = sb1._planLeftover;
const names = ["駅:梅田", "駅:難波", "線:御堂筋線", "区:大阪市北区"];
{
  const left = NL(names, { "駅": ["梅田駅", "天王寺"], "線": [], "区": [] });
  ok("画面に梅田が残っていれば「駅:梅田」だけ返す（駅の末尾「駅」は無視）", left.length === 1 && left[0] === "駅:梅田", left);
}
{
  const left = NL(names, { "駅": [], "線": ["御堂筋線"], "区": ["大阪市北区"] });
  ok("線・区の名前も種類ごとに突き合わせる", left.length === 2 && left.indexOf("線:御堂筋線") >= 0 && left.indexOf("区:大阪市北区") >= 0, left);
}
ok("画面が空なら名前の残りは0", NL(names, { "駅": [], "線": [], "区": [] }).length === 0);
ok("種類 kinds で今回外す側だけ見る（駅の客に区の名前の残りは数えない）", NL(names, { "駅": [], "線": [], "区": ["大阪市北区"] }, ["駅", "線"]).length === 0);
ok("別の駅名は当たらない（難波は無い）", NL(["駅:難波"], { "駅": ["梅田"] }).length === 0);
ok("16文字に切られた台帳名でも画面の長いラベルに当たる", NL(["区:大阪市北区天神橋筋六丁目"], { "区": ["大阪市北区天神橋筋六丁目付近"] }).length === 1);
ok("名前の形でない物・空は無視", NL(["xxx", "駅:"], { "駅": ["梅田"] }).length === 0);
const empty = { stations: 0, lines: 0, wards: 0, towns: 0, layouts: 0, structured: 0, pet: 0, shikirei: false, selects: [], texts: [] };
{
  const pl = (s, want) => plan(Object.assign({}, empty, s), want, null);
  let j = F57(empty, pl({}, "area"), []);
  ok("F57: 台帳名0・画面残0・混在印0 → 完了", j.done && j.stLeft === 0 && j.wdLeft === 0 && j.mixed === 0 && j.names === 0, j);
  j = F57(Object.assign({}, empty, { stations: 2 }), pl({ stations: 2 }, "area"), []);
  ok("F57: 駅が画面に残る（地域の客）→ 未完了", !j.done && j.stLeft === 2, j);
  j = F57(empty, pl({}, "area"), ["駅:梅田"]);
  ok("F57: 画面は空でも台帳の名前が残るなら未完了", !j.done && j.names === 1, j);
  j = F57(Object.assign({}, empty, { stations: 1, wards: 1 }), pl({ stations: 1, wards: 1 }, "area"), []);
  ok("F57: 混在印が立つ（駅と区が両方ある）→ 未完了", !j.done && j.mixed === 1, j);
  j = F57(Object.assign({}, empty, { stations: 3, lines: 1 }), pl({ stations: 3, lines: 1 }, "station"), []);
  ok("F57: 駅の客の駅は「外す側」ではないので残りに数えない", j.done, j);
  j = F57(Object.assign({}, empty, { layouts: 2 }), pl({ layouts: 2 }, "area"), []);
  ok("F57: 場所の完了線は間取りの残りに左右されない（間取りは別のやり直し）", j.done, j);
}

// ───────────────────────────────────────────────
console.log("\n■ ④ きれい確認の関所: 完了線に届かない時は leftover_stuck で中止");
const gateSrc = extractFn("_cleanStartGate");
function runGate(opts) {
  const log = { steps: [], proceed: 0, redo: 0, stClear: 0, wdClear: 0, ledgerCleared: 0, aborted: 0, abortMsg: "", swept: 0 };
  let scanN = 0;
  const win = { __axlxPrevLedger: opts.ledger || null, __axlxLedgerForceOpenSt: false, __axlxLeftoverWhy: "" };
  const sb = {
    window: win,
    _audit: {},
    _auditStepP: (k, v) => log.steps.push([k, String(v)]),
    setTimeout: () => 1,
    clearTimeout: () => {},
    _axWantPlaceMode: (c) => (c && c.station_names ? "station" : "area"),
    _planLeftover: plan,
    _scanLeftoverForm: () => {
      const arr = opts.scans;
      const s = arr[Math.min(scanN, arr.length - 1)];
      scanN++;
      return Object.assign({}, empty, s);
    },
    _checkedLabelTexts: (n) => ((opts.checked || {})[n] || []),
    _ledgerNamesLeft: NL, _f57Judge: F57, _leftoverStuckText: sb1._leftoverStuckText,
    _leftoverSweepNames: (nm, kinds, done) => { log.swept++; log.sweptKinds = kinds; if (opts.afterSweep) opts.afterSweep(); done(opts.sweepN || 0); },
    _leftoverAbort: (m) => { log.aborted++; log.abortMsg = m; },
    _clearStationsBeforeWardThen: (next) => { log.stClear++; if (opts.afterStClear) opts.afterStClear(); next(); },
    _clearWardsBeforeStationThen: (next) => { log.wdClear++; next(); },
    _ledgerClear: () => { log.ledgerCleared++; },
  };
  vm.createContext(sb);
  vm.runInContext(gateSrc, sb);
  sb._cleanStartGate(opts.cond || { city_codes: ["27100"] }, opts.round || 0, () => { log.proceed++; }, () => { log.redo++; });
  log.win = win;
  return log;
}
const keys = (r) => r.steps.map((s) => s[0]);
{
  const r = runGate({ scans: [{ stations: 5, lines: 1 }, {}] });
  ok("外し切れた → leftover_done_F57 を残し・台帳を消し・進む（中止しない）", r.proceed === 1 && r.aborted === 0 && keys(r).indexOf("leftover_done_F57") >= 0 && r.ledgerCleared >= 1, r);
}
{
  const r = runGate({ scans: [{ stations: 5, lines: 1 }, { stations: 4, lines: 1 }] });
  ok("外し切れず駅4・沿線1が残る → 進まず leftover_stuck で中止（頭「leftover_stuck:」）", r.proceed === 0 && r.aborted === 1 && /^leftover_stuck:/.test(r.abortMsg) && keys(r).indexOf("leftover_stuck") >= 0, r);
  const st = r.steps.find((s) => s[0] === "leftover_stuck");
  ok("leftover_stuck の理由に残の内訳（駅4・沿線1）が出る", st && /残 駅4・沿線1・区0・町0/.test(st[1]) && /残 駅4・沿線1/.test(r.abortMsg), st);
  ok("中止の時は leftover_done_F57 を残さない・台帳も消さない", keys(r).indexOf("leftover_done_F57") < 0 && r.ledgerCleared === 0, r);
}
{
  const r = runGate({ cond: { station_names: ["梅田"] }, scans: [{ wards: 3, towns: 2 }, { wards: 1 }] });
  ok("駅の客で区・町が残る → leftover_stuck で中止（区1）", r.proceed === 0 && r.aborted === 1 && /区1/.test(r.abortMsg), r);
}
{
  const r = runGate({ scans: [{ stations: 5 }, { stations: 2 }], ledger: { n: { stations: 5 }, names: ["駅:梅田", "駅:難波"] }, checked: { "station_id[]": ["梅田駅"] }, afterSweep: null, sweepN: 1 });
  ok("画面に台帳の名前が残る → その名前の項目を個別に外す関数を1回だけ呼ぶ（種類=駅・線）", r.swept === 1 && r.sweptKinds.join() === "駅,線", r);
  ok("個別に外しても残れば中止（無限に個別外しを繰り返さない）", r.aborted === 1 && r.swept === 1 && r.proceed === 0, r);
  ok("中止理由に台帳の名前の残りが出る", /台帳名残駅:梅田/.test(r.abortMsg), r.abortMsg);
}
{
  // 個別外しで画面が空になる: 2回目の scan で空
  const o = { scans: [{ stations: 2 }, { stations: 2 }, {}], ledger: { n: { stations: 2 }, names: ["駅:梅田"] }, checked: { "station_id[]": ["梅田"] }, sweepN: 1 };
  o.afterSweep = () => { o.checked = {}; };
  const r = runGate(o);
  ok("名前単位の個別外しで空になれば完了（F57 を残して進む・中止しない）", r.swept === 1 && r.proceed === 1 && r.aborted === 0 && keys(r).indexOf("leftover_done_F57") >= 0, r);
}
{
  const r = runGate({ scans: [{}, {}], ledger: { n: { stations: 5, lines: 1 }, names: ["駅:梅田"] } });
  ok("台帳だけに残りがあり画面に見えない（memOnly）→ 開いて確かめて何も無ければ中止せず進む", r.proceed === 1 && r.aborted === 0 && r.stClear === 1 && keys(r).indexOf("leftover_done_F57") >= 0, r);
}
{
  const r = runGate({ round: 1, scans: [{ layouts: 2 }, { layouts: 2 }] });
  ok("チェック類（間取り）だけ残る時は従来どおり関所へ進む（中止しない）", r.proceed === 1 && r.aborted === 0 && keys(r).indexOf("leftover_unclean") >= 0, r);
}
{
  const r = runGate({ scans: [{ stations: 3 }, { stations: 3 }] , cond: { station_names: ["梅田"] }});
  ok("駅→駅（同種）は外し専用も中止も無し（入れ直しの既存手順へ）", r.stClear === 0 && r.aborted === 0 && r.proceed === 1, r);
}
{
  const r = runGate({ scans: [{ stations: 4, lines: 1, wards: 1 }, { stations: 4 }] });
  ok("混在（駅と区）→ 外した後も駅が残るなら中止（旧: 関所の混在→やり直しへ戻らない）", r.aborted === 1 && r.proceed === 0, r);
}
ok("関所が200秒の最後の砦を持つ（残りがあれば中止・無ければ進む）", /200000/.test(gateSrc) && /abortStuck\(s9/.test(gateSrc));

// ───────────────────────────────────────────────
console.log("\n■ ⑤ 送付後の外し（案B・page-script の _postSendClear）");
const psc = extractFn("_postSendClear");
ok("_postSendClear が最上位にある", !!psc);
function runPostSend(opts) {
  const log = { steps: [], done: [], order: [], timers: [], ledgerCleared: 0, enq: 0 };
  let scanN = 0;
  const win = { _axFillRunning: !!opts.fillRunning, __axlxPrevLedger: null };
  const st = { left: opts.left == null ? 0 : opts.left, wards: opts.wards || 0 };
  const sb = {
    window: win,
    document: {
      querySelectorAll: () => (opts.showBtn ? [{ offsetParent: {}, textContent: "検索条件を表示" }] : []),
    },
    Date,
    _audit: {},
    _auditStepP: (k, v) => log.steps.push([k, String(v)]),
    setTimeout: (f, ms) => { log.timers.push({ f, ms }); return log.timers.length; },
    clearTimeout: () => {},
    _ledgerLoad: () => (opts.ledger || null),
    _ledgerClear: () => { log.ledgerCleared++; },
    _scanLeftoverForm: () => {
      if (opts.scanThrows) throw new Error("scan boom");
      scanN++;
      return Object.assign({}, empty, { stations: st.left, wards: st.wards });
    },
    _planLeftover: plan,
    _leftoverStuckText: sb1._leftoverStuckText,
    _clearStationsBeforeWardThen: (next) => { log.order.push("station"); if (opts.stThrows) throw new Error("clear boom"); if (!opts.stuck) st.left = 0; next(); },
    _clearWardsBeforeStationThen: (next) => { log.order.push("ward"); if (!opts.stuck) st.wards = 0; next(); },
    enqueueHumanClick: () => { log.enq++; },
    _clickEl: () => {}, _uiGapMin: () => 0, _uiGapMax: () => 0, _uiGapOpts: () => ({}),
    whenClickQueueIdle: (f) => f(),
    humanRand: () => 0,
  };
  vm.createContext(sb);
  vm.runInContext(psc, sb);
  const done = opts.doneThrows ? (r) => { log.done.push(r); throw new Error("done boom"); } : (r) => { log.done.push(r); };
  let threw = null;
  try { sb._postSendClear(done); } catch (e) { threw = e; }
  // 「検索条件を表示」押下後の setTimeout(run) を流す
  for (let k = 0; k < 5 && log.timers.length; k++) {
    const t = log.timers.shift();
    if (t.ms === 120000) { log.guard = t; continue; }
    t.f();
  }
  log.win = win; log.threw = threw;
  return log;
}
{
  const r = runPostSend({ fillRunning: true, left: 3 });
  ok("入力中（_axFillRunning）は何もしない（外しを呼ばず・skipped で done）", r.order.length === 0 && r.done.length === 1 && r.done[0].skipped === "fill_running" && r.done[0].ok === true, r);
}
{
  const r = runPostSend({ left: 0 });
  ok("画面に残りが無ければ外す物なし→ok・残0・台帳を消す", r.done.length === 1 && r.done[0].ok === true && r.done[0].left === 0 && r.order.length === 0 && r.ledgerCleared === 1, r);
}
{
  const r = runPostSend({ left: 4, wards: 2 });
  ok("駅4・区2: 駅→区の順（既存の順序）で外し、完了で ok・残0・post_send_clear を監査に残す", r.order.join() === "station,ward" && r.done[0].ok === true && r.done[0].left === 0 &&
    r.steps.filter((s) => s[0] === "post_send_clear").length >= 2 && r.ledgerCleared === 1, r);
}
{
  const r = runPostSend({ left: 3, ledger: { n: { stations: 3 }, names: ["駅:梅田"] } });
  ok("台帳と画面を突き合わせて開始する（開始の記録に入れた控えの名前が出る）", r.steps.some((s) => s[0] === "post_send_clear" && /梅田/.test(s[1])), r.steps);
}
{
  const r = runPostSend({ left: 3, stuck: true });
  ok("外し切れなくても done は呼ぶ（ok=false・残を返す）＝次客を止めない", r.done.length === 1 && r.done[0].ok === false && r.done[0].left === 3, r);
}
{
  const r = runPostSend({ scanThrows: true });
  ok("例外（画面を読めない）でも done が呼ばれる（fail-open）", r.done.length === 1 && r.done[0].ok === false && /exception/.test(r.done[0].why), r);
}
{
  const r = runPostSend({ left: 3, stThrows: true });
  ok("外しの途中で例外でも done が呼ばれる（fail-open）", r.done.length === 1 && r.done[0].ok === false, r);
}
{
  const r = runPostSend({ left: 3, doneThrows: true });
  ok("done 自体が例外を投げても呼び出し元には投げない", r.threw === null && r.done.length === 1, r);
}
{
  // 120秒の砦: 外しが終わらない（loops が next を呼ばない）時に 120000ms のタイマーで done
  const log = { done: [], timers: [], steps: [] };
  const sb = {
    window: { _axFillRunning: false },
    document: { querySelectorAll: () => [] },
    _audit: {}, _auditStepP: (k, v) => log.steps.push([k, v]),
    setTimeout: (f, ms) => { log.timers.push({ f, ms }); return log.timers.length; },
    clearTimeout: () => {},
    _ledgerLoad: () => null, _ledgerClear: () => {},
    _scanLeftoverForm: () => Object.assign({}, empty, { stations: 3 }),
    _planLeftover: plan, _leftoverStuckText: sb1._leftoverStuckText,
    _clearStationsBeforeWardThen: () => { /* 返らない */ },
    _clearWardsBeforeStationThen: () => {},
    enqueueHumanClick: () => {}, _clickEl: () => {}, _uiGapMin: () => 0, _uiGapMax: () => 0, _uiGapOpts: () => ({}), whenClickQueueIdle: (f) => f(), humanRand: () => 0,
  };
  vm.createContext(sb);
  vm.runInContext(psc, sb);
  sb._postSendClear((r) => log.done.push(r));
  const guard = log.timers.find((t) => t.ms === 120000);
  ok("120秒の砦タイマーがある", !!guard);
  ok("外しが返らなくても 120秒で done（timeout120・ok=false）", (guard.f(), log.done.length === 1 && log.done[0].why === "timeout120" && log.done[0].ok === false), log.done);
  guard.f();
  ok("砦が二重に鳴っても done は1回だけ", log.done.length === 1);
}
ok("公開: window.__axlxPostSendClear（callback 版）と __axlxPostSendClearP（Promise 版）", /window\.__axlxPostSendClear = function \(done\)/.test(ps) && /window\.__axlxPostSendClearP = function \(\) \{ return new Promise/.test(ps));

console.log("\n■ ⑤-b 送付後の外し（案B・background の _postSendClearRealpro）");
const bgFn = extractFrom(bg, "async function _postSendClearRealpro(");
ok("_postSendClearRealpro が background にある", !!bgFn);
async function runBg(opts) {
  const log = { exec: 0, steps: [], logs: [] };
  const sb = {
    console: { log: (m) => log.logs.push(String(m)), warn: (m) => log.logs.push("W:" + String(m)) },
    Date, Math, Promise, setTimeout, String,
    chrome: {
      storage: { local: { get: async () => (opts.off ? { axlx_post_send_clear_off: true } : {}) } },
      tabs: { query: async () => (opts.tabs === undefined ? [{ id: 7, active: true }] : opts.tabs) },
      scripting: {
        executeScript: async () => {
          log.exec++;
          if (opts.execThrows) throw new Error("ホスト権限エラー");
          return [{ result: opts.result || { ok: true, left: 0 } }];
        },
      },
    },
    _auditOpenRunId: () => "run1",
    _auditStep: (id, k, d) => log.steps.push([id, k, d]),
  };
  vm.createContext(sb);
  vm.runInContext(bgFn, sb);
  log.ret = await sb._postSendClearRealpro("cust1");
  return log;
}
(async () => {
  let r = await runBg({ off: true });
  ok("off フラグ（axlx_post_send_clear_off=true）なら実行しない", r.exec === 0 && r.ret.skipped === "off", r);
  r = await runBg({ tabs: [] });
  ok("リアプロのタブが無ければ何もしない（投げない）", r.exec === 0 && r.ret.skipped === "no_tab", r);
  r = await runBg({ execThrows: true });
  ok("executeScript が失敗しても投げない（非致命・ok=false）", r.ret.ok === false && r.logs.some((l) => /失敗（非致命/.test(l)), r);
  r = await runBg({ result: { ok: true, left: 0 } });
  ok("成功: ページの結果を返し、監査の段 post_send_clear を残す", r.exec === 1 && r.ret.ok === true && r.steps.some((s) => s[1] === "post_send_clear" && /ok=true/.test(s[2])), r);
  r = await runBg({ result: { ok: false, left: 2, why: "別経路でも減らず" } });
  ok("残りが有っても投げず結果を返す（残=2 を監査に）", r.ret.ok === false && r.steps.some((s) => /残=2/.test(s[2])), r);
  ok("背景の待ちは最大125秒（ページ側120秒より長い）", /125000/.test(bgFn));
  ok("ページ側の公開関数 __axlxPostSendClearP を world:MAIN で呼ぶ", /world: "MAIN"/.test(bgFn) && /__axlxPostSendClearP/.test(bgFn));

  // ───────────────────────────────────────────────
  console.log("\n■ ⑥ 呼び出し経路・監査名（ソースの形）");
  const scrape = extractFrom(bg, "async function _scrapeAndSendRealpro(");
  ok("_scrapeAndSendRealpro がリアプロ（realnetpro）の時だけ送付後の外しを頼む（ITANDI には入れない）", /if \(_siteKey === "realnetpro"\) \{[\s\S]{0,400}_postSendClearRealpro\(customerId\)/.test(scrape));
  ok("送付進捗ありの切り上げ（送付が続く）では触らない", /!\(batchDone && batchDone\.timedOut && batchDone\.sawProgress\)\)[\s\S]{0,200}_postSendClearRealpro/.test(scrape));
  ok("次客の switch／fill より前（一連ロックを外す前）に実行する", scrape.indexOf("_postSendClearRealpro(customerId)") > 0 && scrape.indexOf("_postSendClearRealpro(customerId)") < scrape.indexOf('_releasePipelineLock(batchDone && batchDone.timedOut ? "batch_timeout" : "scrape_done"'));
  ok("最後のお客さんは待たずに戻す（_axlxLastCustomerId と同じ客なら await しない）", /_psIsLast[\s\S]{0,200}_psP\.catch/.test(scrape));
  ok("一括（_runBatchSearch）と手の一括の両方の客ループで最後の客の印を置く", (bg.match(/self\._axlxLastCustomerId = /g) || []).length === 2);
  ok("_auditFinish が leftover_stuck: を error_kind=leftover_stuck にする", /leftover_stuck:\/\.test\(String\(x\.error\)\)[\s\S]{0,120}error_kind: "leftover_stuck"/.test(bg));
  ok("監査の間引き保護 _PIN に post_send_clear と leftover_ がある", /_PIN = \/\^\([^\n]*leftover_\|post_send_clear(\|[a-z_]+)*\)\//.test(ps));
  ok("即送信の _clearKey に post_send_clear と leftover_ がある", /var _clearKey = [^\n]*leftover_\|post_send_clear(\|[a-z_]+)*\/\.test\(String\(k\)\)/.test(ps));
  ok("新しい監査名 leftover_stuck / leftover_done_F57 / leftover_progress / leftover_alt_route は leftover_ で守られる", ["leftover_stuck", "leftover_done_F57", "leftover_progress", "leftover_alt_route"].every((k) => /^(leftover_|post_send_clear)/.test(k)));
  ok("_doReset の完了は今まで通り関所（_cleanStartGate）を通る", /_cleanStartGate\(cond, _rr, _cb0/.test(ps));
  ok("直外し（checked=false の直書き）を新しい関数で使っていない", !/\.checked = false/.test(extractFn("_leftoverSweepNames") + extractFn("_postSendClear") + extractFn("_cleanStartGate")));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
