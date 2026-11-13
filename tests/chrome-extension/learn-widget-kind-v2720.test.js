// 実行: node tests/chrome-extension/learn-widget-kind-v2720.test.js
// 2026-11-13 竹内さん「どこがダウンドロップでどこが入力する部分かなども学習できているかな。弱い部分あるかな」
//
//   これまでの穴: 押した**位置**と**名前**は学んでいたが、**要素の種類**（プルダウン／チェック／直接入力）は
//   学んでいなかった。→ 自動モードで「プルダウンは開いて選ぶ」「入力欄は打つ」を人がやった通りに選べない。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); }
}

const L = require(path.join(EXT, "human-learn.js"));
const learn = read("human-learn.js");
const rec = read("human-learn-record.js");
const brain = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "human-learn-brain.ts"), "utf8");

// 模型の要素
const el = (tag, type) => ({ tagName: tag, getAttribute: (k) => (k === "type" ? type ?? null : null), querySelector: () => null });

console.log("■ ① 要素の種類を見分ける（純関数）");
{
  ok("kindOfEl がある", typeof L.kindOfEl === "function");
  ok("  <select> → プルダウン", L.kindOfEl(el("SELECT")) === "select");
  ok("  <input type=text> → 直接入力", L.kindOfEl(el("INPUT", "text")) === "text");
  ok("  <input type=checkbox> → チェック", L.kindOfEl(el("INPUT", "checkbox")) === "checkbox");
  ok("  <input type=radio> → チェック（1つ）", L.kindOfEl(el("INPUT", "radio")) === "radio");
  ok("  <input type=submit> → 押すだけ", L.kindOfEl(el("INPUT", "submit")) === "button");
  ok("  <button> → 押すだけ", L.kindOfEl(el("BUTTON")) === "button");
  ok("  <a> → 押すだけ", L.kindOfEl(el("A")) === "link");
  ok("  <textarea> → 直接入力", L.kindOfEl(el("TEXTAREA")) === "text");
  ok("  <label> にチェックが入っていれば チェック", L.kindOfEl({ tagName: "LABEL", getAttribute: () => null, querySelector: () => ({}) }) === "checkbox");
  ok("  type の無い input → 直接入力（既定）", L.kindOfEl(el("INPUT", null)) === "text");
  ok("  null・壊れた物でも落ちない", L.kindOfEl(null) === "other" && L.kindOfEl({}) === "other");
}

console.log("\n■ ② 押した時に種類も残す（記録）");
{
  ok("点の記録に種類（wk）を入れる", /wk: kindOfEl\(el\)/.test(learn));
  ok("  ⚠ 幅の w と取り違えない（種類は wk）", /w: Math\.round\(r\.width\)/.test(learn) && /wk: kindOfEl/.test(learn));
  ok("集計で種類を数える", /byField\[f\]\.w\[w\] = \(byField\[f\]\.w\[w\] \|\| 0\) \+ 1/.test(learn));
  ok("  一番多い種類を採る", /fieldSpread\[f\]\.w = bw/.test(learn));
  ok("  前の集計と合わせる時も種類を保つ", /\.\.\.\(pre\.w \|\| af\[f\]\.w/.test(learn));
  ok("録画の操作の輪にも種類を入れる", /w: \(L && L\.kindOfEl\) \? L\.kindOfEl\(el\) : null/.test(rec));
}

console.log("\n■ ③ 学習の束に種類が入り、日本語で出る");
{
  ok("PointStat に w（種類）を持つ", /type PointStat = \{[^}]*w\?: string/.test(brain));
  ok("  回数の多い実測の種類を採る", /const w = typeof r\.w === "string"/.test(brain));
  ok("  種類ごとにまとめて出す", /プルダウン（開いて選ぶ）/.test(brain) && /直接入力/.test(brain));
  ok("  種類が無ければ「まだ学んでいません」と出す", /欄の種類: まだ学んでいません/.test(brain));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
