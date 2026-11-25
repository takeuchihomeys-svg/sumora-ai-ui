/**
 * 2.8.290 竹内さん「リセットを押すところを、通常モードで録画した場所・ボタン・押す場所の把握も徹底的に確認」
 *   実測（DB・2026-11-25 16:36・通常モード・1回）: 「左のリセット｜span」・幅160×高さ30・押した位置 x=0.75/y=0.67。
 *   ⚠ 学習の束は n≥2 の欄しか残さないので、1回のこの欄は _aimByEl で引けず中央を押していた。
 *   → span を押す時は人の実測の位置を使う。2回以上の学習があれば、その位置を優先する。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8").replace(/\r\n/g, "\n");
const bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8").replace(/\r\n/g, "\n");
const man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function fnSrc(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n  }\n");
  return e < 0 ? s : s.slice(0, e + 5);
}

console.log("\n■ 版");
ok("manifest = page = rules = 2.8.290", man.version === "2.8.290"
  && (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] === "2.8.290"
  && (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] === "2.8.290", man.version);

const press = fnSrc(ps, "  function _resetPress(done) {");
console.log("\n■ 押す位置");
ok("学習の位置を先に引く（_aimByEl）", /_aimByEl\(btn, \["リセット", "左のリセット"\]\)/.test(press));
ok("学習が2回以上ならその位置を使う", /_rAim && _rAim\.n >= 2/.test(press) && /aim: \{ x: _rAim\.x, y: _rAim\.y \}/.test(press));
ok("span の時は人の実測（x0.75/y0.67）を使う", /=== "SPAN"\) _rOpts = Object\.assign\(\{\}, _rOpts, \{ aim: \{ x: 0\.75, y: 0\.67 \} \}\)/.test(press));
ok("押すのは enqueueHumanClick（人の動き）のまま", /enqueueHumanClick\(btn, _clickEl, _uiGapMin\(\), _uiGapMax\(\), null, _rOpts\)/.test(press));
ok("値の直接書き換えは無い", !/\.value\s*=/.test(press) && !/dispatchEvent/.test(press));
ok("結果に使った位置（aim）を返す", /aim: _rAim && _rAim\.n >= 2 \? "learned"/.test(press) && /"human_sample"/.test(press));
ok("背景の reset_press 段に 位置 が出る", /位置=" \+ String\(_press\.aim \|\| "-"\)/.test(bg));

console.log("\n■ 位置の選び方（実コードの分岐を動かす）");
function choose(tag, aim) {
  const ctx = vm.createContext({ btn: { tagName: tag }, _rAim: aim, _rOpts: {} });
  vm.runInContext(
    'if (_rAim && _rAim.n >= 2) _rOpts = Object.assign({}, _rOpts, { aim: { x: _rAim.x, y: _rAim.y } });' +
    'else if (String(btn.tagName || "").toUpperCase() === "SPAN") _rOpts = Object.assign({}, _rOpts, { aim: { x: 0.75, y: 0.67 } });' +
    '__a = _rOpts.aim || null;', ctx);
  return ctx.__a;
}
const a1 = choose("SPAN", null);
ok("学習が無い span は人の実測（0.75/0.67）", a1 && a1.x === 0.75 && a1.y === 0.67, a1);
const a2 = choose("SPAN", { n: 1, x: 0.4, y: 0.4 });
ok("学習が1回の span は人の実測（1回は束に入らないため）", a2 && a2.x === 0.75 && a2.y === 0.67, a2);
const a3 = choose("SPAN", { n: 3, x: 0.4, y: 0.5 });
ok("学習が3回の span は学習の位置を優先", a3 && a3.x === 0.4 && a3.y === 0.5, a3);
const a4 = choose("DIV", null);
ok("span でない時（div.reset_button 等）は位置を付けない（中央・従来どおり）", a4 === null, a4);

console.log("\n結果: " + pass + " 件OK / " + fail + " 件NG");
if (fail > 0) process.exitCode = 1;
