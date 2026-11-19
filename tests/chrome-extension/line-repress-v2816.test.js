// 実行: node tests/chrome-extension/line-repress-v2816.test.js
// v2.8.116 竹内さん「タクヤの場合沿線だけおして駅を押さなかった」（audit #1513）:
//   1本目の沿線だけ押され、2本目は印（__axPending）だけ残って二度と積まれず、全部チェック待ちが64秒回った。
//   ① 列が空なのに未チェックの沿線が残る時は、その沿線だけ印を外して押し直す（最大3回）→ 入らなければ理由を1回残す
//   ② 「前客と被り残し」は自分が押した沿線を数えない（#1513 では自分で押した1本を前客の物と記録していた）
//   ③ 湊（南海本線）が駅→沿線の逆引きに無かった。逆引きの穴は増やさない（数の上限で止める）
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

console.log("\n■ 押し直しの部分を実際に動かす（偽の画面）");
const startTok = "var _lnIdle = true;";
const sIdx = ps.indexOf(startTok);
const tryIdx = ps.lastIndexOf("try {", sIdx);
const endIdx = ps.indexOf("} catch (_) {}", ps.indexOf("station_line_stuck", sIdx)) + "} catch (_) {}".length;
const block = ps.slice(tryIdx, endIdx);
ok("押し直しの部分がある", sIdx > 0 && block.indexOf("station_line_repress") > 0 && block.indexOf("station_line_stuck") > 0);

function makeEnv(opts) {
  const steps = [];
  const pressed = [];
  const mkLine = (name, value, checked) => {
    const cb = { checked, value, __axPending: false };
    const lb = { textContent: name, htmlFor: "", __axPending: false, querySelector: () => cb };
    return { lb, cb };
  };
  const lines = opts.lines.map((l) => mkLine(l[0], l[1], l[2]));
  if (opts.stalePending) { lines[1].lb.__axPending = true; lines[1].cb.__axPending = true; }
  const ctx = {
    window: { __axlxLineWaitN: 0, __axlxLineRepressN: 0, __axlxLineStuckSent: false },
    document: { querySelectorAll: (sel) => (sel === "label.one_line" ? lines.map((x) => x.lb) : []), getElementById: () => null },
    cond: { route_ids: ["6681", "6686"] },
    ROUTE_LINE_MAP: { "6681": "南海電鉄南海本線", "6686": "南海電鉄高野線" },
    norm: (s) => String(s).replace(/\s+/g, ""),
    isClickQueueBusy: () => !!opts.busy,
    _isElQueuedOrBusy: () => false,
    clickLineButtons: (ids) => {
      pressed.push(ids.slice());
      ids.forEach((id) => {
        const nm = ctx.ROUTE_LINE_MAP[id];
        const hit = lines.find((x) => x.lb.textContent === nm);
        if (hit && !hit.lb.__axPending && opts.pressWorks) hit.cb.checked = true;
      });
    },
    _audit: {},
    _auditStepP: (k, d) => steps.push([k, d]),
    _graspStationModalScreen: () => ({ kind: "line_list" }),
  };
  vm.createContext(ctx);
  const fn = vm.runInContext("(function(){ " + block + " })", ctx);
  return { ctx, fn, steps, pressed, lines };
}

{
  const e = makeEnv({ lines: [["南海電鉄高野線", "6686", true], ["南海電鉄南海本線", "6681", false]], stalePending: true, pressWorks: true });
  for (let i = 1; i <= 8; i++) { e.ctx.window.__axlxLineWaitN = i; e.fn(); }
  ok("8回待ったら未チェックの沿線だけ押し直す", e.pressed.length === 1 && e.pressed[0].join() === "6681", e.pressed);
  ok("押し直す前に残った印を外す", e.lines[1].lb.__axPending === false && e.lines[1].cb.__axPending === false);
  ok("押し直しを記録する", e.steps.some((s) => s[0] === "station_line_repress" && /南海電鉄南海本線/.test(s[1])), e.steps);
  ok("押し直しで沿線が入る", e.lines[1].cb.checked === true);
}
{
  const e = makeEnv({ lines: [["南海電鉄高野線", "6686", true], ["南海電鉄南海本線", "6681", false]], pressWorks: false });
  for (let i = 1; i <= 60; i++) { e.ctx.window.__axlxLineWaitN = i; e.fn(); }
  ok("押し直しは最大3回まで", e.pressed.length === 3, e.pressed.length);
  const stuck = e.steps.filter((s) => s[0] === "station_line_stuck");
  ok("入らない時は理由を1回だけ残す", stuck.length === 1, stuck);
  ok("理由に沿線名・状態・画面が入る", stuck[0] && /南海電鉄南海本線:未/.test(stuck[0][1]) && /画面=line_list/.test(stuck[0][1]), stuck[0]);
}
{
  const e = makeEnv({ lines: [["南海電鉄高野線", "6686", false], ["南海電鉄南海本線", "6681", false]], busy: true, pressWorks: true });
  for (let i = 1; i <= 16; i++) { e.ctx.window.__axlxLineWaitN = i; e.fn(); }
  ok("列が動いている間は押し直さない（重ね押ししない）", e.pressed.length === 0, e.pressed);
}

console.log("\n■ 前客の残りと自分が押した沿線を分ける");
const toggle = ps.slice(ps.indexOf("function _toggleCheckboxLikeHuman("), ps.indexOf("function _toggleCheckboxLikeHuman(") + 5000);
ok("沿線を選んだら __axlxLinePickedRun に印", /wantOn && \/route_id\/\.test\(nm\)[\s\S]{0,200}__axlxLinePickedRun\[String\(cb\.value/.test(toggle));
const ov = ps.slice(ps.indexOf("var _keptMine = 0;"), ps.indexOf("var _keptMine = 0;") + 2000);
ok("自分が押した物は _keptMine・それ以外だけ前客と数える", /if \(_mine\) _keptMine\+\+; else _keptOverlap\+\+;/.test(ov));
ok("前客と被りの記録は客ごとに1回", /_keptOverlap > 0 && !window\.__axlxLineOverlapSent/.test(ov));
const reset = ps.slice(ps.indexOf("window.__axlxStationForceClearedOnce = false;\n      window.__axlxLineWaitN = 0;".replace(/\n/g, ps.includes("\r\n") ? "\r\n" : "\n")) - 10, ps.indexOf("window._axPreSearchWalkSealed = false;"));
ok("客ごとに待ち回数・押し直し回数・押した沿線を空にする", ["__axlxLineWaitN = 0", "__axlxLineRepressN = 0", "__axlxLineStuckSent = false", "__axlxLineOverlapSent = false", "__axlxLinePickedRun = {}"].every((s) => reset.indexOf(s) >= 0), reset.slice(0, 300));
const pin = (ps.match(/var _PIN = \/\^\(([^)]*)\)\//) || [])[1] || "";
ok("押し直し・止まりの記録は間引かれない（_PIN）", pin.split("|").includes("station_line_repress") && pin.split("|").includes("station_line_stuck"));

console.log("\n■ 駅→沿線の逆引き（湊）と穴の上限");
function loadMaps(file, names) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8") + "\n;this.__o={" + names.join(",") + "};", ctx);
  return ctx.__o;
}
const M = loadMaps("popup-maps.js", ["STATION_LINE_MAP", "LINE_STATION_ORDER", "LINE_ROUTE_MAP"]);
ok("popup-maps: 湊 → 南海電鉄南本線", Array.isArray(M.STATION_LINE_MAP["湊"]) && M.STATION_LINE_MAP["湊"].includes("南海電鉄南本線"));
ok("湊の沿線はリアプロ 6681（南海本線）", M.LINE_ROUTE_MAP[M.STATION_LINE_MAP["湊"][0]] === "6681");
const rc = fs.readFileSync(path.join(root, "resolution-core.js"), "utf8");
ok("resolution-core（写し）にも湊", /"湊": \["南海電鉄南本線"\]/.test(rc));
const gaps = [];
for (const [line, sts] of Object.entries(M.LINE_STATION_ORDER)) for (const st of sts) if (!M.STATION_LINE_MAP[st]) gaps.push(st + "（" + line + "）");
ok("沿線の並びにあって逆引きに無い駅は 69 以下（増やさない・埋めたら上限を下げる）", gaps.length <= 69, gaps.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
