// 実行: node tests/chrome-extension/learn-to-autofill-v2722.test.js
// 2026-11-13 竹内さん「それで自動検索の部分に反映できるようにする。その点も併せて改善できるようにする」
//
//   学んだ事（押す位置・欄の種類）を、**自動検索の入力**で使う。
//   ⚠ 一番大事: **画面の作りを最優先**する。学習は「どこを押すか」にだけ使う
//     （誤学習で欄の扱いを変えると、検索が壊れる）。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); }
}

const ps = read("page-script.js");
const bg = read("background.js");

console.log("■ ① 学んだ押す位置を読む");
{
  ok("学習を読む関数（_kindOf / _aimOf）", /function _kindOf\(name\)/.test(ps) && /function _aimOf\(name\)/.test(ps));
  ok("  30秒ごとに読み直す（学習が進んだら次から効く）", /now - _learnKindsAt > 30000/.test(ps));
  ok("  2回以上押した所だけ使う（1回は偶然）", /if \(Number\(v\.n\) < 2\) return null;/.test(ps));
  ok("  storage の axlx_learn_points を読む", /axlx_learn_points/.test(ps));
  ok("background も points を保存している", /axlx_learn_points: points/.test(bg));
}

console.log("\n■ ② プルダウンは「人が押した位置」を狙って開く");
{
  ok("学んだ位置を chooseSelectLikeHuman に渡す", /\{ forceOpen: true, aim: _aim \}/.test(ps));
  ok("  学んだ割合の所へカーソルを動かす（moveTo）", /P\.moveTo\(_r\.left \+ _r\.width \* _fx/.test(ps));
  ok("  学びが無ければ真ん中（moveToEl・今まで通り）", /return P\.moveToEl\(el\);/.test(ps));
  ok("  端すぎる所は押さない（0.2〜0.8）", /Math\.max\(0\.2, Math\.min\(0\.8, o\.aim\.x\)/.test(ps));
  ok("  ⚠ 画面の作りを最優先（select は select のまま・種類で分岐を変えない）", !/o\.aim[\s\S]{0,80}_learnedKind/.test(ps.split("function chooseSelectLikeHuman")[1]?.slice(0, 3000) || ""));
}

console.log("\n■ ③ 点検に残す（あとから「学んだ事を使った」と分かる）");
{
  ok("学んだ種類を点検に残す（learn_kind）", /learn_kind/.test(ps));
  ok("  押す位置も残す（横◯%）", /押す位置 横/.test(ps));
}

console.log("\n■ ④ 壊れない（学びが無い・変な値でも今まで通り）");
{
  ok("学びが無ければ何もしない（null を返す）", /return v && v\.w \? String\(v\.w\) : null;/.test(ps));
  ok("  壊れた入力でも落ちない（try/catch）", /function _aimOf[\s\S]{0,400}catch \(_\) \{ return null; \}/.test(ps));
  ok("  moveTo が無い環境でも動く（moveToEl に落ちる）", /if \(o\.aim && P\.moveTo && el\.getBoundingClientRect\)/.test(ps));
}

console.log("\n■ ⑤ 押す順番（v2.7.12）と両立する");
{
  ok("順番の並べ替えは残っている", /_orderByLearned/.test(ps));
  ok("  項目は増減しない", /out\.length !== list\.length/.test(read("learn-order.js")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
