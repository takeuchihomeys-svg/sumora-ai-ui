// 地域ボタン・検索ボタンの「押す位置」を学習して使うか（2026-11-14）
//
// 竹内さん「この地域押すところや、検索押すところちゃんと学習する」
//
// 見つけた穴（実測）:
//   ① 学んだ押す位置（`axlx_learn_points`）は **プルダウン（chooseSelectLikeHuman）だけ**で使い、
//      **地域ボタン・検索ボタンでは一度も使っていなかった**。
//   ② `_aimOf(name)` は **欄の名前（name 属性）**で引くが、「所在地絞り込み」「検索」は
//      div/span のボタンで **name が無い** → そもそも引けない。
//   ③ 本番DBの学習データには `左の所在地絞り込み＋｜span`・`左の検索｜span` が
//      **入っていた**（＝学べているのに使われていないだけだった）。
//
// 直し:
//   ・`_aimByEl(el, keys)` … 要素の「文字・クラス・タグ」から学んだ名前を探して位置を返す
//   ・`_pressLearned(el, keys, tag)` … 学んだ位置があればそこへカーソルを動かして押す
//   ・`_humanPointerClick(el, fire, aim)` … 第3引数に学んだ位置を受ける
//   ・地域STEP1／区・町字・駅絞り込み／検索ボタンに適用
//
// 実行: node tests/chrome-extension/learn-press-points.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const ps = read("page-script.js");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① 学んだ位置を要素から引ける（名前の無いボタンでも）");
{
  t("_aimByEl がある", /function _aimByEl\(el, fallbackKeys\)/.test(ps));
  t("  学んだ名前を「場所｜印」に分ける", /split\("｜"\)/.test(ps));
  t("  要素の文字で照合する", /el\.textContent/.test(ps));
  t("  クラス名でも照合する", /el\.className/.test(ps));
  t("  何回も押された物を信頼する（n を足す）", /Number\(v\.n\) \|\| 0\)/.test(ps));
  t("  弱すぎる一致は使わない（誤学習で壊さない）", /best\.score < 18/.test(ps));
}

console.log("\n■ ② 学んだ位置で押す共通の道具");
{
  t("_pressLearned がある", /function _pressLearned\(el, keys, tag\)/.test(ps));
  t("  学んだ位置があれば _humanPointerClick に渡す", /_humanPointerClick\(el, function \(\) \{ simulateClick\(el\); \}, aim\)/.test(ps));
  t("  無ければ今まで通り simulateClick", /try \{ simulateClick\(el\); \}/.test(ps));
  t("  点検に残す（learn_aim）", /_auditStepP\('learn_aim'/.test(ps));
}

console.log("\n■ ③ ボタンを押す関数が「学んだ位置」を受ける");
{
  t("_humanPointerClick が第3引数 aim を受ける", /function _humanPointerClick\(el, fallbackFn, aim\)/.test(ps));
  t("  学んだ割合へカーソルを動かす（moveTo）", /_P\.moveTo\(_aimPt\.x, _aimPt\.y\)/.test(ps));
  t("  端すぎる所は押さない（0.2〜0.8）", /Math\.max\(0\.2, Math\.min\(0\.8, aim\.x\)/.test(ps));
  t("  学びが無ければ真ん中（moveToEl・今まで通り）", /return _P\.moveToEl\(el\);/.test(ps));
}

console.log("\n■ ④ 地域ボタン（所在地絞り込み）で学んだ位置を使う");
{
  const seg = ps.slice(ps.indexOf("STEP1: 「所在地絞り込み＋」"), ps.indexOf("_ensureAreaOpened(tries)"));
  t("  STEP1 で _pressLearned を使う", /_pressLearned\(/.test(seg));
  t("  「左の所在地絞り込み」を候補に入れる", /左の所在地絞り込み/.test(seg));
  t("  クラス名で見つけた時も使う", /area_open_by_class[\s\S]{0,200}_pressLearned/.test(seg));
  t("  帯の中で見つけた時も使う", /area_open_by_area[\s\S]{0,200}_pressLearned/.test(seg));
  t("  ⚠ 押し直しの保険は残っている", /_ensureAreaOpened/.test(ps));
}

console.log("\n■ ⑤ 区・町字は同期で押す（押した直後に確定へ進むため）");
{
  t("  ⚠ 区（コードで選択）は simulateClick（非同期の _pressLearned にしない）", /simulateClick\(lb2\); hitByCode\+\+/.test(ps));
  t("  ⚠ 区（文字で照合）も simulateClick", /simulateClick\(wardLabels\[i\]\);/.test(ps));
  t("  駅の絞り込み（開くだけ）は _pressLearned でよい", /_pressLearned\(divs\[i\], \['左の沿線・駅絞り込み/.test(ps));
  t("  ⚠ 区の「外さない」規則は残っている（トグルで外さない）", /ensureWardButtonY/.test(ps));
}

console.log("\n■ ⑤-2 押し直しは「押し終わるのを待ってから」（二重押しで閉じない）");
{
  const _a = ps.indexOf("_ensureAreaOpened(tries)");
  const seg = ps.slice(_a, _a + 2600);
  t("  最初は待つ（grace 1400ms）", /n === 0 \? 1400/.test(seg));
  t("  待ってから「開いたか」を確かめる", /setTimeout\(function \(\) \{\s*\n\s*if \(opened\(\)\)/.test(seg));
  t("  押し直しも学んだ位置で押す", /_pressLearned\(cand\[0\]/.test(seg));
}

console.log("\n■ ⑥ 検索ボタンで学んだ位置を使う");
{
  const seg = ps.slice(ps.indexOf("var _pressSearchBtn"), ps.indexOf("// 「検索」ボタンは2か所ある"));
  t("  _aimByEl で検索ボタンの学びを引く", /_aimByEl\(btn, \['左の検索'/.test(seg));
  t("  _humanPointerClick に渡す", /_humanPointerClick\(btn, function \(\) \{ try \{ btn\.click\(\); \} catch \(_\) \{\} \}, _sAim\)/.test(seg));
  t("  ⚠ 小窓の中の検索には学んだ位置を使わない（2か所を取り違えない）", /if \(!_inModal\(btn\)\) _sAim/.test(seg));
  t("  点検に残す（search の学び）", /'search:'/.test(seg));
}

console.log("\n■ ⑦ 学びは先に読み込む（名前の無いボタンは _kindOf を通らない）");
{
  t("_learnWarm がある", /function _learnWarm\(\)/.test(ps));
  t("  _aimByEl が _learnWarm を呼ぶ", /if \(!all\) \{ try \{ _learnWarm\(\); \}/.test(ps));
  t("  _kindOf も _learnWarm を使う（二重実装しない）", /function _kindOf\(name\) \{\s*\n\s*try \{\s*\n\s*_learnWarm\(\);/.test(ps));
  t("  30秒は読み直さない", /now - _learnKitsAt > 30000|now - _learnKindsAt > 30000/.test(ps));
}

console.log("\n■ ⑧ 実際の学習データの形で当たる（本番DBの名前）");
{
  // 本番DBに実際に入っている名前（2026-11-14 実測）
  const LEARNED = {
    "左の所在地絞り込み＋｜span": { x: 0.66, y: 0.57, n: 2, w: "other" },
    "左の検索｜span": { x: 0.74, y: 0.68, n: 1, w: "button" },
    "左の大阪市西区｜label.one_city": { x: 0.52, y: 0.46, n: 2, w: "checkbox" },
    "左の沿線・駅絞り込み＋｜span": { x: 0.66, y: 0.93, n: 1, w: "button" },
    "rental_cost2": { x: 0.1, y: 0.14, n: 6, w: "select" },
  };
  // page-script.js から _aimByEl を取り出して試す
  const startAt = ps.indexOf("function _aimByEl(el, fallbackKeys)");
  const endAt = ps.indexOf("function _aimOf(name)");
  let body = ps.slice(startAt, endAt);
  // `_learnKinds` を閉じ込める
  const sandbox = {
    _learnKinds: LEARNED,
    _learnKindsAt: Date.now(),
    _learnWarm() {},
    Object, String, Number, Math, Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(body + "\nthis.__aimByEl = _aimByEl;\nthis.__pressLearned = null;", sandbox);
  const aimByEl = sandbox.__aimByEl;

  const el = (text, cls, tag) => ({ textContent: text, className: cls || "", tagName: tag || "DIV" });

  let a = aimByEl(el("所在地絞り込み＋", "click_menu", "DIV"), ["左の所在地絞り込み", "所在地絞り込み＋"]);
  t("「所在地絞り込み」の学びを引ける", !!a && a.x === 0.66 && a.y === 0.57, a);
  a = aimByEl(el("検索", "go_search", "DIV"), ["左の検索", "検索"]);
  t("「検索」の学びを引ける", !!a && a.x === 0.74 && a.y === 0.68, a);
  a = aimByEl(el("大阪市西区", "one_city", "LABEL"), ["左の大阪市西区", "大阪市西区"]);
  t("「大阪市西区」の学びを引ける", !!a && a.x === 0.52 && a.y === 0.46, a);
  a = aimByEl(el("沿線・駅絞り込み＋", "click_menu", "DIV"), ["左の沿線・駅絞り込み", "沿線・駅絞り込み＋"]);
  t("「沿線・駅絞り込み」の学びを引ける", !!a && a.x === 0.66 && a.y === 0.93, a);
  a = aimByEl(el("まったく関係ない物", "xyz", "DIV"), ["無い名前"]);
  t("⚠ 関係ない要素では学びを使わない（誤爆しない）", a === null, a);
  a = aimByEl(null, ["検索"]);
  t("⚠ 要素が無ければ null（落ちない）", a === null);
}

console.log("\n■ ⑨ 壊れない（学びが空・変な値でも今まで通り）");
{
  const startAt = ps.indexOf("function _aimByEl(el, fallbackKeys)");
  const endAt = ps.indexOf("function _aimOf(name)");
  const body = ps.slice(startAt, endAt);
  const run = (learned) => {
    const sandbox = { _learnKinds: learned, _learnKindsAt: Date.now(), _learnWarm() {}, Object, String, Number, Math, Array };
    vm.createContext(sandbox);
    vm.runInContext(body + "\nthis.__aimByEl = _aimByEl;", sandbox);
    return sandbox.__aimByEl({ textContent: "検索", className: "", tagName: "DIV" }, ["検索"]);
  };
  t("学びが空 → null", run({}) === null);
  t("学びが null → null（落ちない）", run(null) === null);
  t("x が数値でない → null", run({ "左の検索｜span": { x: "a", y: 0.5, n: 9 } }) === null);
  t("n が1回でも使う（学んだ位置そのものは使う）", !!run({ "左の検索｜span": { x: 0.5, y: 0.5, n: 1 } }));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
