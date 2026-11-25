/**
 * 2.8.287 竹内さん「リセットのボタンは人間の動作から把握しているのか」→「進めてよい／直接入力せず人の動きのようにする」
 *   人の操作の記録（shot_ops・2026-11-23 の4件）: 「左のリセット｜span」・クリック・押した要素は幅160×高さ30。
 *   ① 押す先は、まず人が押した形（文字「リセット」・画面の幅45%より左・幅120〜200×高さ22〜40・子の無い葉）を探す
 *   ② 無ければ従来（div.reset_button → 文字の順）へ戻る
 *   ③ 押すのは従来どおり enqueueHumanClick（人の動き）。値の直接書き換えは無い
 *   ④ 監査の段 reset_press に「押した先」が残る
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8").replace(/\r\n/g, "\n");
const ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8").replace(/\r\n/g, "\n");
const man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function semverOk(v, min) {
  const a = String(v).split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
}
function fnSrc(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n  }\n");
  return e < 0 ? s : s.slice(0, e + 5);
}

console.log("\n■ 版");
ok("manifest ≥2.8.287", semverOk(man.version, "2.8.287"), man.version);
ok("page ≥2.8.287", semverOk((ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1], "2.8.287"));
ok("rules ≥2.8.287", semverOk((rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1], "2.8.287"));
ok("manifest と page と rules の版が同じ", man.version === (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] && man.version === (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1]);

console.log("\n■ ① 学習した形を先に探す（順序）");
const learned = fnSrc(ps, "  function _findResetBtnLearned() {");
const find = fnSrc(ps, "  function _findResetBtn() {");
ok("学習した形の探し方がある", learned.length > 0);
ok("学習した形は子の無い葉・文字「リセット」・左側・幅高さの範囲を見る",
  /children\.length !== 0/.test(learned) && /trim\(\) !== "リセット"/.test(learned) && /r\.left < vw \* 0\.45/.test(learned) &&
  /r\.width >= 120 && r\.width <= 200/.test(learned) && /r\.height >= 22 && r\.height <= 40/.test(learned));
ok("値を書き換えていない（value 代入なし）", !/\.value\s*=/.test(learned) && !/dispatchEvent/.test(learned));
ok("_findResetBtn は学習した形を最初に見る", find.indexOf("_findResetBtnLearned()") > 0 &&
  find.indexOf("_findResetBtnLearned()") < find.indexOf("div.reset_button"));
ok("従来の div.reset_button は学習の後の戻り先に残る", find.indexOf("div.reset_button") > find.indexOf("_findResetBtnLearned()"));
ok("文字の探しは最後の戻り先", find.indexOf('"text"') > find.indexOf('"fixed_class"'));
ok("押す先の印 _resetVia が決まる", /_resetVia = "learned"/.test(find) && /_resetVia = "fixed_class"/.test(find) && /_resetVia = "text"/.test(find));

console.log("\n■ ② 押す（人の動き）と結果");
const press = fnSrc(ps, "  function _resetPress(done) {");
ok("押すのは enqueueHumanClick のまま", /enqueueHumanClick\(btn, _clickEl/.test(press));
ok("結果に押した先（via）が入る", /via: _resetVia/.test(press));
ok("_resetPress は _findResetBtn() の後で _resetVia を読む（閉じ込め）", press.indexOf("_findResetBtn()") > 0 && press.indexOf("via: _resetVia") > press.indexOf("_findResetBtn()"));

console.log("\n■ ③ 監査の段に押した先");
ok("background の reset_press 段に 押した先 が入る", /押した先=" \+ String\(_press\.via \|\| "-"\)/.test(bg));

console.log("\n■ ④ 実際の探し方（偽の画面で実関数を動かす）");
function makeEl(o) {
  const el = Object.assign({ tagName: "SPAN", className: "", children: [], textContent: "", left: 0, width: 0, height: 0, offsetParent: {} }, o);
  el.getBoundingClientRect = () => ({ left: el.left, width: el.width, height: el.height });
  el.getAttribute = () => null;
  el.getClientRects = () => [1];
  return el;
}
function runFind(els, innerWidth) {
  const sandbox = {
    window: { innerWidth: innerWidth || 1200 },
    document: {
      querySelectorAll(sel) {
        if (/reset_button/.test(sel)) return els.filter((e) => /reset_button/.test(e.className));
        return els.slice();
      },
    },
    _isShown: (e) => !!(e && e.offsetParent),
    console,
  };
  const src = learned + "\n" + find + "\n__f = _findResetBtn; __v = function () { return _resetVia; };";
  // _resetVia の宣言（page-script 内の位置）も一緒に
  const decl = 'var _resetVia = "";\n';
  const ctx = vm.createContext(sandbox);
  vm.runInContext(decl + src, ctx);
  const hit = ctx.__f();
  return { hit, via: ctx.__v() };
}
// 1) 人が押した形 → learned
const humanSpan = makeEl({ textContent: "リセット", left: 100, width: 160, height: 30, offsetParent: {} });
const r1 = runFind([humanSpan]);
ok("人が押した形（左・160×30・文字リセット）は learned で見つかる", r1.hit === humanSpan && r1.via === "learned", r1.via);
// 2) 右側にある同じ文字 → learned にしない（左のリセットだけ）
const rightSpan = makeEl({ textContent: "リセット", left: 900, width: 160, height: 30, offsetParent: {} });
const r2 = runFind([rightSpan]);
ok("右側の同じ文字は learned にしない", r2.via !== "learned", r2.via);
// 3) 幅が広すぎる（見出しの文字など）→ learned にしない
const wide = makeEl({ textContent: "リセット", left: 100, width: 400, height: 30, offsetParent: {} });
const r3 = runFind([wide]);
ok("幅400の文字は learned にしない", r3.via !== "learned", r3.via);
// 4) learned の形が無く div.reset_button がある → fixed_class
const cls = makeEl({ tagName: "DIV", className: "reset_button", textContent: "", left: 300, width: 160, height: 30, offsetParent: {} });
const r4 = runFind([cls]);
ok("形が無ければ div.reset_button に戻る", r4.hit === cls && r4.via === "fixed_class", r4.via);
// 5) 両方ある → learned を優先
const r5 = runFind([cls, humanSpan]);
ok("両方あれば学習した形を優先", r5.hit === humanSpan && r5.via === "learned", r5.via);
// 6) 文字だけ（左・幅が合わない）→ text
const txtOnly = makeEl({ textContent: "リセット", left: 300, width: 90, height: 30, offsetParent: {} });
const r6 = runFind([txtOnly]);
ok("幅が合わない文字は最後の戻り先 text", r6.hit === txtOnly && r6.via === "text", r6.via);
// 7) 何も無い → null
const r7 = runFind([]);
ok("何も無ければ null（no_reset_button に流れる）", r7.hit === null, r7.via);
// 8) 子がある「リセット」（親の見出し）は learned にしない
const parentLike = makeEl({ tagName: "DIV", textContent: "リセット", left: 100, width: 160, height: 30, children: [makeEl({})], offsetParent: {} });
const r8 = runFind([parentLike]);
ok("子のある親の要素は learned にしない（葉だけ）", r8.via !== "learned", r8.via);

console.log("\n■ ⑤ 古い決定との整合");
ok("押す物は no_reset_button で断る（従来）", /why: "no_reset_button"/.test(press));
ok("入力中は押さない（従来の決まり）", /skipped: "fill_running"/.test(press));
const doReset = fnSrc(ps, "  function _doReset");
ok("_doReset はリセットを押さない（従来の決まり）", !/_resetPress\(|__axlxResetPressP/.test(doReset || ""));
ok("ルール文に学習した形が書かれている", /幅160×高さ30/.test(rules) && /reset_press（押した先）/.test(rules));

console.log("\n結果: " + pass + " 件OK / " + fail + " 件NG");
if (fail > 0) process.exitCode = 1;
