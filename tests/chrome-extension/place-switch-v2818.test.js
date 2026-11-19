// 実行: node tests/chrome-extension/place-switch-v2818.test.js
// v2.8.118 竹内さん「新しいお客さんが所在地で検索する場合駅外して所在地を入れるなど これらの点穴がないか細部まで細かく強化」:
//   ① 所在地・場所なしの客で、前客の駅・沿線を誰も外していなかった（#1478・#1476・#1479）→ 入る前に駅→沿線で外して確定
//   ② 駅の前に区を外す処理が 8秒で黙って諦めていた → 押し直し・理由を残す・見えない残だけなら確定へ
//   ③ 駅の一覧に無い名前（堀江・新町）があると約50秒で検索ごと止めていた（#1463）→ 一覧が落ち着いたら数から外す
//   ④ 関所の駅余りは「開くだけ」、区余りは直外しだった → どちらも1つずつ外し切る（駅の客の駅は外さない）
//   ⑤ 駅の設定へ進むを押した直後に二度押ししない・押しても移らない時は理由を残す
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "../../chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, detail) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail !== undefined ? "  " + JSON.stringify(detail) : "")); }
}

function extractFn(name) {
  const head = "  function " + name + "(";
  const s = ps.indexOf(head);
  if (s < 0) return null;
  let i = ps.indexOf("{", s) + 1, depth = 1, inStr = null, inLine = false, inBlock = false;
  for (; i < ps.length && depth > 0; i++) {
    const c = ps[i], n = ps[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === "/" && n === "/") { inLine = true; continue; }
    if (c === "/" && n === "*") { inBlock = true; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    if (c === "}") depth--;
  }
  return ps.slice(s, i);
}

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

console.log("\n■ ① 所在地へ入る前に駅・沿線を外す（_clearStationsBeforeWardThen）");
const srcSt = extractFn("_clearStationsBeforeWardThen");
ok("関数がある（最上位）", !!srcSt);
function runStationClear(opts) {
  const clk = fakeClock();
  const log = { calls: 0, steps: [], next: 0, opened: 0, confirmed: 0, advance: 0 };
  const st = { st: opts.st, ln: opts.ln, screen: "unknown" };
  const ctx = {
    window: {},
    Date: clk.Date,
    document: {
      querySelectorAll: (sel) => {
        if (/station_id/.test(sel)) return { length: st.st };
        if (/route_id/.test(sel)) return { length: st.ln };
        if (/click_menu/.test(sel)) return [];
        return [];
      },
      querySelector: () => null,
    },
    isClickQueueBusy: () => false,
    isVisible: () => true,
    _graspStationModalScreen: () => ({ kind: st.screen }),
    _markPanelOpened: () => {},
    _pressLearned: () => {},
    clickByText: (arr) => {
      if (/沿線・駅絞り込み/.test(arr[arr.length - 1])) {
        log.opened++;
        if (opts.opens && log.opened >= (opts.opensOn || 1)) st.screen = "station_list";
        return true;
      }
      return false;
    },
    _advanceForcePlaceClearViaStationFirst: () => {
      log.advance++;
      if (log.advance >= 3) { st.st = 0; st.ln = 0; st.screen = "line_list"; return true; }
      return false;
    },
    _pressConfirmListLikeHuman: () => { log.confirmed++; st.screen = "closed"; return true; },
    enqueueHumanClick: () => {},
    _clickEl: () => {}, _uiGapMin: () => 0, _uiGapMax: () => 0, _uiGapOpts: () => ({}),
    _audit: {},
    _auditStepP: (k, d) => log.steps.push([k, d]),
    setTimeout: (f) => f(),
    _ln: () => 0,
  };
  ctx.waitForClick = fakeWaitForClick(clk, log);
  vm.createContext(ctx);
  vm.runInContext(extractFn("_activeClock") + "\n" + srcSt, ctx);
  vm.runInContext("_clearStationsBeforeWardThen", ctx)(() => { log.next++; }, "所在地");
  return { log, st };
}
{
  const r = runStationClear({ st: 0, ln: 0, opens: true });
  ok("残りが無ければ何もせずすぐ次へ（今までと同じ）", r.log.next === 1 && r.log.calls === 0 && r.log.opened === 0, r.log);
}
{
  const r = runStationClear({ st: 3, ln: 2, opens: true });
  ok("残りがあれば沿線・駅絞り込みを開く", r.log.opened === 1, r.log.opened);
  ok("駅→沿線の順で外す処理を回す", r.log.advance >= 3, r.log.advance);
  ok("外した後に確定する", r.log.confirmed === 1, r.log.confirmed);
  ok("次へは1回だけ進む", r.log.next === 1, r.log.next);
  ok("始まりと完了を記録（残0）", r.log.steps.some((s) => s[0] === "station_clear_before_ward" && /駅残3・沿線残2/.test(s[1])) &&
    r.log.steps.some((s) => s[0] === "station_clear_before_ward_done" && /完了 残 駅0・沿線0/.test(s[1])), r.log.steps);
}
{
  const r = runStationClear({ st: 2, ln: 1, opens: true, opensOn: 2 });
  ok("1回目で開かなければ 6秒後に1回押し直す", r.log.opened === 2 && r.log.next === 1, r.log.opened);
}
{
  const r = runStationClear({ st: 2, ln: 1, opens: false });
  ok("開けない時も止めずに進む（関所が再確認）", r.log.next === 1, r.log.next);
  ok("開けなかった理由と残数を残す", r.log.steps.some((s) => s[0] === "station_clear_before_ward_done" && /開けず 残 駅2・沿線1/.test(s[1])), r.log.steps);
  // ★ 2.8.123 竹内さん「ちゃんと外して次に移る」: 残れば開く→外す→確定を最大3回（1回の中で押し直し2回）
  ok("2.8.123: 残れば最大3回までやり直す（station_clear_retry×2・開く押下 3×3）",
    r.log.steps.filter((s) => s[0] === "station_clear_retry").length === 2 && r.log.opened === 9, { opened: r.log.opened, steps: r.log.steps.map((s) => s[0]) });
}
{
  const r = runStationClear({ st: 2, ln: 1, opens: true });
  ok("2.8.123: 外し切れた時はやり直さない", !r.log.steps.some((s) => s[0] === "station_clear_retry") && r.log.next === 1, r.log.steps);
}

console.log("\n■ ② 駅の前に区を外す（_clearWardsBeforeStationThen・最上位へ移動）");
const srcW = extractFn("_clearWardsBeforeStationThen");
ok("関数がある（最上位）", !!srcW);
ok("中の重複定義が無い", ps.split("function _clearWardsBeforeStationThen(").length === 2);
function runWardClear(opts) {
  const clk = fakeClock();
  const log = { calls: 0, steps: [], next: 0, opened: 0, confirmed: 0, toggled: 0 };
  const w = { left: opts.left, panel: false };
  const ctx = {
    window: {},
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
        if (/click_menu/.test(sel)) return [];
        return [];
      },
      querySelector: () => (w.panel ? {} : null),
    },
    isClickQueueBusy: () => false,
    isVisible: (el) => !(el && el.hidden),
    clickByText: (arr) => {
      if (/所在地絞り込み/.test(arr[arr.length - 1])) {
        log.opened++;
        if (opts.opens && log.opened >= (opts.opensOn || 1)) w.panel = true;
        return true;
      }
      return false;
    },
    _pressLearned: () => {},
    _labelForCheckbox: (cb) => cb,
    _toggleCheckboxLikeHuman: () => { log.toggled++; w.left = Math.max(0, w.left - 1); },
    _noteClearMethod: () => {},
    _pressConfirmListLikeHuman: () => { log.confirmed++; w.panel = false; return true; },
    _audit: {},
    _auditStepP: (k, d) => log.steps.push([k, d]),
    console: { log: () => {} },
    setTimeout: (f) => f(),
    _ln: () => 0,
  };
  ctx.waitForClick = fakeWaitForClick(clk, log);
  vm.createContext(ctx);
  vm.runInContext(extractFn("_activeClock") + "\n" + srcW, ctx);
  vm.runInContext("_clearWardsBeforeStationThen", ctx)(() => { log.next++; });
  return { log, w };
}
{
  const r = runWardClear({ left: 0, opens: true });
  ok("区の残りが無ければすぐ駅へ", r.log.next === 1 && r.log.calls === 0, r.log);
}
{
  const r = runWardClear({ left: 4, opens: true });
  ok("区を1つずつ外して確定してから駅へ", r.log.toggled === 4 && r.log.confirmed === 1 && r.log.next === 1, r.log);
  ok("完了と残0を記録", r.log.steps.some((s) => s[0] === "ward_clear_before_station_done" && /完了 残 区\/町0/.test(s[1])), r.log.steps);
}
{
  const r = runWardClear({ left: 2, opens: true, opensOn: 2 });
  ok("所在地絞り込みが開かなければ押し直す（旧: 8秒で黙って諦め）", r.log.opened === 2 && r.log.toggled === 2 && r.log.next === 1, r.log);
  ok("押し直しを記録", r.log.steps.some((s) => s[0] === "ward_clear_open_retry"), r.log.steps);
}
{
  const r = runWardClear({ left: 2, opens: false });
  ok("開けない時は理由と残数を残して進む", r.log.next === 1 && r.log.steps.some((s) => s[0] === "ward_clear_before_station_done" && /開けず 残 区\/町2/.test(s[1])), r.log.steps);
  ok("2.8.123: 開けず区が残れば最大3回までやり直す（ward_clear_retry×2）",
    r.log.steps.filter((s) => s[0] === "ward_clear_retry").length === 2 && r.log.opened === 6, { opened: r.log.opened, steps: r.log.steps.map((s) => s[0]) });
}
{
  const r = runWardClear({ left: 2, opens: true, hidden: true });
  ok("見えない残だけなら3秒後に確定へ（時間切れまで回らない）", r.log.confirmed === 1 && r.log.next === 1 &&
    r.log.steps.some((s) => s[0] === "ward_clear_hidden_left"), r.log.steps);
}

console.log("\n■ ③ 駅の一覧に無い名前（_stationNamesAbsentStable）");
const srcA = extractFn("_stationNamesAbsentStable");
const srcM = extractFn("_stationNameMatch");
ok("関数がある", !!srcA && !!srcM);
function absentEnv(listNames) {
  const clk = fakeClock();
  const steps = [];
  const inputs = listNames.map((n) => ({ label: { textContent: n } }));
  const ctx = {
    window: {},
    Date: clk.Date,
    document: { querySelectorAll: () => inputs },
    _labelForCheckbox: (inp) => inp.label,
    isVisible: () => true,
    _audit: {},
    _auditStepP: (k, d) => steps.push([k, d]),
  };
  vm.createContext(ctx);
  vm.runInContext(srcM + "\n" + srcA, ctx);
  const f = vm.runInContext("_stationNamesAbsentStable", ctx);
  return { clk, f, steps };
}
{
  const e = absentEnv(["桜川", "西長堀", "西大橋", "ドーム前千代崎"]);
  const want = ["堀江", "新町", "桜川", "西長堀"];
  ok("一覧が出た直後は判断しない（描画途中で外さない）", e.f(want).length === 0);
  e.clk.t += 1000;
  ok("1秒ではまだ判断しない", e.f(want).length === 0);
  e.clk.t += 2000;
  const a = e.f(want);
  ok("2.5秒落ち着いたら一覧に無い名前を返す", a.join() === "堀江,新町", a);
  ok("記録は客ごとに1回", (e.f(want), e.steps.filter((s) => s[0] === "station_name_absent").length === 1), e.steps);
}
{
  const e = absentEnv(["梅田", "中津"]);
  e.f(["堀江", "新町"]);
  e.clk.t += 3000;
  ok("全部無い時は空（今まで通り止める・全件検索にしない）", e.f(["堀江", "新町"]).length === 0);
}
{
  const e = absentEnv(["十三", "南方"]);
  e.f(["十三"]);
  e.clk.t += 3000;
  ok("全部在れば空", e.f(["十三"]).length === 0);
}

console.log("\n■ 配線（所在地の枝・駅の選択・確定・関所・駅の設定へ進む）");
const areaHead = ps.indexOf('if (locationMode === "area" || locationMode === "none") {');
ok("所在地・場所なしの枝の頭で駅を外してから入る", /_clearStationsBeforeWardThen\(function \(\) \{/.test(ps.slice(areaHead, areaHead + 400)));
ok("枝の終わりで場面名を渡す", /\}, locationMode === "none" \? "場所なし" : "所在地"\);/.test(ps));
const stepD = ps.slice(ps.indexOf("var _absentD = [];"), ps.indexOf("var _absentD = [];") + 2200);
ok("駅の選択: 一覧に無い名前を数から外す", /_floorD = _wantedStCleans\.length - _absentD\.length/.test(stepD));
ok("駅の選択: 一覧が落ち着いたら地図の期待で止めない", /_wantOkForm < _mapExp2 && !_absentD\.length/.test(stepD));
const closeSt = ps.slice(ps.indexOf("function closeStationModal()"), ps.indexOf("function closeStationModal()") + 1500);
ok("確定: 一覧に無い名前を待たない", /_wantN -= _stationNamesAbsentStable\(cond\.station_names\)\.length/.test(closeSt));
const scene = extractFn("_understandStationScene") || "";
ok("場面理解も同じ数え方", /wantTargets < wantStN - absentN/.test(scene));
const gate = ps.slice(ps.indexOf('name: "station_id[]",') - 600, ps.indexOf('name: "city_code[]",') + 900);
ok("関所の駅余り: 外し切るまで待つ（Promise）", /return new Promise\(function \(res\) \{\s*_clearStationsBeforeWardThen\(res, "関所"\);/.test(gate));
ok("関所の区余り: 直外しをやめ1つずつ外す", /return new Promise\(function \(res\) \{\s*_clearWardsBeforeStationThen\(res, "関所"\);/.test(gate) && !/setCheckboxes\("city_code\[\]", \[\]\)/.test(gate));
ok("関所: 駅の客の駅は外さない", /\(_gate\.extraStation \|\| _gate\.placeMixed\) && _axExpect\.areaMode !== "station"/.test(gate));
ok("関所: 所在地の客の区は外さない", /\(_gate\.extraWard \|\| _gate\.placeMixed\) && _axExpect\.areaMode !== "ward"/.test(gate));
const stepC = ps.slice(ps.indexOf("// STEP C: 「駅の設定へ進む」が出るまで待ってクリック"), ps.indexOf("// STEP C: 「駅の設定へ進む」が出るまで待ってクリック") + 5000);
ok("駅の設定へ進む: 押し終わってから1.8秒は切り替わりを待つ", /if \(!_stationNextAt\) _stationNextAt = Date\.now\(\);/.test(stepC) && /Date\.now\(\) - _stationNextAt < 1800\) return false;/.test(stepC));
ok("駅の設定へ進む: 移らない時は理由を残す", /station_go_stuck/.test(stepC));
ok("客ごとに一覧の印を戻す", /window\.__axlxStListSig = null;\s*window\.__axlxStAbsentSent = false;/.test(ps));
const pin = (ps.match(/var _PIN = \/\^\(([^)]*)\)\//) || [])[1] || "";
["station_clear_before_ward", "station_name_absent", "ward_clear_before_station", "ward_clear_open_retry", "ward_clear_hidden_left", "station_go_stuck"].forEach((k) => {
  ok("記録が間引かれない: " + k, pin.split("|").indexOf(k) >= 0);
});
{
  const mfv = JSON.parse(fs.readFileSync(path.join(__dirname, "../../chrome-extension/manifest.json"), "utf8")).version;
  ok("版: _AXLX_PAGE_VER が manifest と同じ（2.8.119 以降）", ps.indexOf('_AXLX_PAGE_VER = "' + mfv + '"') >= 0 && mfv.localeCompare("2.8.119", undefined, { numeric: true }) >= 0, mfv);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
