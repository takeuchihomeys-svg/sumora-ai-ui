/**
 * 2.8.328 竹内さん「町の選択や管理費・構造の選択は、効いたかを確かめていない ここも順に改善する 徹底的に改善する」:
 *   旧は「押す列が空いた」を選べた証拠にしていた（cond_one_ok・page:town）。
 *   → 押す列が空いてから画面の印を読み直す（_condEffectCheck）。付いていなければ1回だけ選び直す→それでも付かなければ
 *     press_ng_cond_effect を残して次へ（検索は止めない）。町は確定の前、管理費・構造は1欄ずつの列の中。
 *   実測（直近60回・読むだけ）: 町を入れた回は1回（#1658 detail_area=上本町・段の記録0件）、構造・管理費は0回。
 *   本番ではまだ一度も確かめられていない → この試験で確かめる手の動きを止め、実機は町・構造のある客で見る。
 * node tests/chrome-extension/pick-effect-v28328.test.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const ps = fs.readFileSync(path.join(EXT, "page-script.js"), "utf8");
const dl = fs.readFileSync(path.join(EXT, "bulk-dl.js"), "utf8");
const audit = require(path.join(EXT, "search-audit.js"));
const ROOT = path.join(__dirname, "..", "..");
const map = fs.readFileSync(path.join(ROOT, "app", "lib", "loop-flow-map.ts"), "utf8");
const pb = fs.readFileSync(path.join(ROOT, "app", "lib", "action-playbook.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 300) : "")); }
}
function sliceFn(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  let depth = 0, j = src.indexOf("{", i);
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return "";
}

function mkCheck() {
  const steps = [], notes = [];
  const sb = {
    _audit: {},
    _auditStepP: (k, d) => steps.push({ k, d: String(d || "") }),
    _pressNote: (w, r, d) => notes.push([w, r, String(d || "")]),
    whenClickQueueIdle: (cb) => cb(),
    setTimeout: (cb) => cb(),
    _ln: () => 0,
  };
  vm.createContext(sb);
  vm.runInContext(sliceFn(ps, "_condEffectCheck"), sb);
  return { sb, steps, notes };
}

console.log("■ ① 選んだ後に印を読む手（_condEffectCheck を動かす）");
{
  const t = mkCheck(); let nexts = 0;
  t.sb._condEffectCheck("構造", () => ({ ok: true, detail: "欲しい2・付いた2" }), () => {}, () => nexts++);
  ok("一度で付いた → cond_effect_ok・次へ1回", t.steps.some((s) => s.k === "cond_effect_ok") && nexts === 1 && !t.steps.some((s) => s.k === "cond_effect_retry"), t.steps);
  ok("  選び終えた印（cond_pick_idle）が先", t.steps[0] && t.steps[0].k === "cond_pick_idle", t.steps);
  ok("  枠に「効いた」（pick/effect_ok）", t.notes.some((n) => n[0] === "pick" && n[1] === "effect_ok"), t.notes);
}
{
  const t = mkCheck(); let nexts = 0, redo = 0, state = false;
  t.sb._condEffectCheck("管理費・共益費込み", () => ({ ok: state, detail: state ? "印あり" : "印なし" }), () => { redo++; state = true; }, () => nexts++);
  ok("1回目は付いていない → 1回だけ選び直す → 付いた", redo === 1 && nexts === 1 && t.steps.map((s) => s.k).join(",") === "cond_pick_idle,cond_effect_retry,cond_pick_idle,cond_effect_ok", t.steps.map((s) => s.k));
}
{
  const t = mkCheck(); let nexts = 0, redo = 0;
  t.sb._condEffectCheck("町", () => ({ ok: false, detail: "選んだ0/1・付かない=喜連西" }), () => { redo++; }, () => nexts++);
  ok("選び直しても付かない → press_ng_cond_effect を残して次へ（止めない・選び直しは1回だけ）", redo === 1 && nexts === 1 && t.steps.some((s) => s.k === "press_ng_cond_effect" && /喜連西/.test(s.d)), t.steps);
  ok("  枠に✗（pick/effect_ng）", t.notes.some((n) => n[0] === "pick" && n[1] === "effect_ng"), t.notes);
}
{
  const t = mkCheck(); let nexts = 0;
  t.sb._condEffectCheck("管理費・共益費込み", () => null, () => {}, () => nexts++);
  ok("確かめる物が無い（欄が無い）→ 印を足さずに次へ", nexts === 1 && !t.steps.some((s) => /cond_effect|press_ng/.test(s.k)), t.steps);
}
{
  const t = mkCheck(); let nexts = 0;
  t.sb._condEffectCheck("構造", () => { throw new Error("x"); }, null, () => nexts++);
  ok("読めない（例外）→ 付かない扱いで記録して次へ（固まらない）", nexts === 1 && t.steps.some((s) => s.k === "press_ng_cond_effect"), t.steps);
}

console.log("\n■ ② 構造・町の読み方（動かす）");
{
  const mkDoc = (cbs) => ({ querySelectorAll: (q) => (/structured_type/.test(q) ? cbs : []) });
  const sb = { document: null };
  vm.createContext(sb);
  vm.runInContext(sliceFn(ps, "_structureEffect"), sb);
  sb.document = mkDoc([{ value: "1", checked: true }, { value: "2", checked: true }, { value: "3", checked: false }]);
  let r = sb._structureEffect(["1", "2"]);
  ok("欲しい構造だけに印 → ok", r && r.ok === true, r);
  sb.document = mkDoc([{ value: "1", checked: true }, { value: "2", checked: false }, { value: "3", checked: true }]);
  r = sb._structureEffect(["1", "2"]);
  ok("足りない・余計がある → ok でない（数を言う）", r && r.ok === false && /足りない1/.test(r.detail) && /余計1/.test(r.detail), r);
  sb.document = mkDoc([]);
  ok("構造の欄が無い → null", sb._structureEffect(["1"]) === null);
}
{
  const lab = (txt, checked) => ({ textContent: txt, querySelector: () => ({ checked }) });
  const sb = { document: null };
  vm.createContext(sb);
  vm.runInContext(sliceFn(ps, "_townLabelMatches") + "\n" + sliceFn(ps, "_townPickedState"), sb);
  sb.document = { querySelectorAll: () => [lab("喜連西1丁目", true), lab("喜連東", false), lab("長吉長原", false)] };
  let r = sb._townPickedState(["喜連西", "喜連東"]);
  ok("町ごとに印を読む（喜連西＝付いた・喜連東＝付かない）", r && r.ok === false && r.missingNames.join() === "喜連東" && /選んだ1\/2/.test(r.detail), r);
  sb.document = { querySelectorAll: () => [lab("喜連西1丁目", true)] };
  r = sb._townPickedState(["喜連西"]);
  ok("全部付いた → ok", r && r.ok === true, r);
  sb.document = { querySelectorAll: () => [] };
  ok("町の札が画面に無い → null（確かめる物が無い）", sb._townPickedState(["喜連西"]) === null);
  ok("選ぶ時と確かめる時で同じ当て方（clickDetailArea も _townLabelMatches を使う）", /if \(!_townLabelMatches\(ptxt, clean\)\) continue;/.test(sliceFn(ps, "clickDetailArea")));
}

console.log("\n■ ③ 流れの中の位置（構造）");
{
  const run = sliceFn(ps, "_runBasicOneByOne");
  ok("1欄ずつの列: 押す列が空いたら、verify のある欄は印を読んでから cond_one_ok・次の欄", /whenClickQueueIdle\(function \(\) \{[\s\S]{0,200}typeof item\.verify === "function"[\s\S]{0,120}_condEffectCheck\(label, item\.verify, item\.run, afterRun\);\s*return;[\s\S]{0,200}cond_one_ok/.test(run));
  ok("管理費の欄は verify（_feeEffect）を持つ", /name: "include_common_fee",\s*verify: _feeEffect,/.test(ps));
  ok("構造の欄は verify（_structureEffect）を持つ", /name: "structured_type\[\]",\s*verify: function \(\) \{ return _structureEffect\(sVals0\); \},/.test(ps));
  const iTown = ps.indexOf("_auditStepP('town', null);");
  const iChk = ps.indexOf("_condEffectCheck('町'", iTown);
  const iClose = ps.indexOf("waitForClick(closeAreaModal", iTown);
  ok("町: 選んだ（town）→ 印を読む → 確定（closeAreaModal）の順", iTown > 0 && iChk > iTown && iClose > iChk && iChk - iTown < 300, { iTown, iChk, iClose });
  ok("町: 付いていない町だけ選び直す（missingNames）", /_condEffectCheck\('町'[\s\S]{0,200}missingNames[\s\S]{0,80}clickDetailArea\(n\)/.test(ps));
}

console.log("\n■ ④ 点検に残る・枠に出る・地図と手順書");
{
  ["page:cond_pick_idle", "page:cond_effect_ok", "page:cond_effect_retry", "page:press_ng_cond_effect"].forEach((k) => {
    ok("点検の上限で捨てない: " + k, audit.KEEP_STEP.test(k));
  });
  const pin = eval(ps.match(/var _PIN = (\/.*\/);/)[1]);
  ok("ページ側でも守る（_PIN: cond_effect_・cond_pick_）", pin.test("cond_effect_ok") && pin.test("cond_pick_idle"));
  const s = [];
  for (let i = 0; i < 3; i++) audit.pushStep(s, "page:cond_effect_ok", "構造 欲しい1・付いた1", i);
  ok("効いた記録は同じ秒でもまとめない（1回ずつ数える）", s.length === 3, s.length);
  ok("枠: pick の効いた・選び直す・付かない の文がある", /what === "pick" && result === "effect_ok"/.test(dl) && /what === "pick" && result === "retry"/.test(dl) && /what === "pick" && result === "effect_ng"/.test(dl));
  const fill = map.slice(map.indexOf('id: "fill"'), map.indexOf('id: "search"'));
  const order = ["駅の設定へ進む", "町（ピンポイント）", "確定してリストへ", "管理費・共益費込み", "構造"].map((b) => fill.indexOf('button: "' + b + '"'));
  ok("地図: 入力の段の押す物に 町（確定の前）・管理費・構造（確定の後）が流れの順で並ぶ", order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), order);
  ok("地図の印の目印がコードにある（_townPickedState・_feeEffect・_structureEffect）", ["_townPickedState(", "_feeEffect(", "_structureEffect("].every((t) => ps.indexOf(t) > 0));
  ok("手順書: 所在地②に町の把握の文（地図から）", /`②欲しい区（必要なら町）を選ぶ。\$\{pressLineOf\("fill", "町（ピンポイント）"\)\}`/.test(pb));
  ok("手順書: 条件①に管理費・構造の把握の文（地図から）", /pressLineOf\("fill", "管理費・共益費込み"\) \+ "。" \+ pressLineOf\("fill", "構造"\)/.test(pb));
}

console.log("\n結果: " + pass + " 通過 / " + fail + " 失敗");
process.exit(fail ? 1 : 0);
