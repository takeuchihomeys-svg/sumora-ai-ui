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
ok("manifest = page = rules ≥2.8.291", man.version === (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1]
  && (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] === man.version
  && man.version.split(".").map(Number)[2] >= 291, man.version);

const press = fnSrc(ps, "  function _resetPress(done) {");
console.log("\n■ 押す位置");
ok("学習の位置を先に引く（_aimByEl）", /_aimByEl\(btn, \["リセット", "左のリセット"\]\)/.test(press));
ok("押す点は _resetAimPoint（中心＋ボタン上のばらつき）", /_resetAimPoint\(btn,/.test(press));
ok("ばらつきはボタンの面（0.22〜0.78）に収める", /Math\.max\(0\.22, Math\.min\(0\.78/.test(fnSrc(ps, "  function _resetAimPoint(btn, learned) {")));
ok("押すのは enqueueHumanClick（人の動き）のまま", /enqueueHumanClick\(btn, _fireReset, _uiGapMin\(\), _uiGapMax\(\), null, _rOpts\)/.test(press));
ok("値の直接書き換えは無い", !/\.value\s*=/.test(press) && !/dispatchEvent/.test(press));
ok("結果に使った位置（種類と割合）を返す", /aim: _rPick\.kind \+ \(_rPick\.aim \? " " \+ _rPick\.aim\.x/.test(press));
ok("背景の reset_press 段に 位置 が出る", /位置=" \+ String\(_press\.aim \|\| "-"\)/.test(bg));

console.log("\n■ 位置の選び方（実コードの分岐を動かす）");
const aimFn = fnSrc(ps, "  function _resetAimPoint(btn, learned) {");
function pick(tag, learned) {
  const ctx = vm.createContext({ Math, btn: { tagName: tag }, learned: learned });
  vm.runInContext(aimFn + "\n__p = _resetAimPoint(btn, learned);", ctx);
  return ctx.__p;
}
const a1 = pick("SPAN", null);
ok("学習が無い span は人の点のまわり（種類 human_sample）", a1 && a1.kind === "human_sample" && a1.aim, a1);
ok("その点はボタンの面の上（0.22〜0.78）", a1 && a1.aim.x >= 0.22 && a1.aim.x <= 0.78 && a1.aim.y >= 0.22 && a1.aim.y <= 0.78, a1);
const seen = {};
for (let i = 0; i < 30; i++) { const p = pick("SPAN", null); seen[p.aim.x + "/" + p.aim.y] = 1; }
ok("30回押すと点が1つに固まらない（ばらつく）", Object.keys(seen).length >= 3, Object.keys(seen).length);
const a2 = pick("SPAN", { n: 1, x: 0.4, y: 0.4 });
ok("学習が1回の span は人の点（1回は束に入らない）", a2 && a2.kind === "human_sample", a2);
const a3 = pick("SPAN", { n: 3, x: 0.4, y: 0.5 });
ok("学習が3回の span は学習の位置のまわり", a3 && a3.kind === "learned" && a3.aim.x >= 0.22 && a3.aim.x <= 0.58, a3);
const a4 = pick("DIV", null);
ok("span でない時は位置を付けない（中央・従来どおり）", a4 && a4.aim === null && a4.kind === "center", a4);

console.log("\n結果: " + pass + " 件OK / " + fail + " 件NG");
if (fail > 0) process.exitCode = 1;
