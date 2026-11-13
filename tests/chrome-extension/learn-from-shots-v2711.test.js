// 実行: node tests/chrome-extension/learn-from-shots-v2711.test.js
// 2026-11-13 竹内さん「写真から学習する。押す場所や押す順番などもりかいできるから。
//   通常モードで光っている部分どうおしているか。おしかたのボタンの仕様の理解の為にも。
//   そして自動モードでは実際に人間がおしたようにおすことができる」
//
//   これまでの穴: 写真は撮っていたが、**サーバーが「どの操作の写真か」を捨てていた**。
//   → 写真と押した操作が結びつかず、写真からは何も学べなかった。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const rec = read("human-learn-record.js");
const bg = read("background.js");
const learn = read("human-learn.js");
const api = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "human-motion", "route.ts"), "utf8");
const mig = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "migrate-schema", "route.ts"), "utf8");

const L = require(path.join(EXT, "human-learn.js"));

console.log("■ ① 写真と「押した操作」を結びつける（これが無いと学べない）");
{
  ok("操作を小さな輪に残す（_pushOp）", /function _pushOp\(kind, el\)/.test(rec));
  ok("  人が押した時に記録する", /_pushOp\(e\.type \|\| "click", e\.target\)/.test(rec));
  // 2026-11-13: 地域（6段）・駅（5段）も記録するようになったので 40 → 60 に上げた
  ok("  上限60件（古い物から捨てる）", /OPS_RING_MAX = 60/.test(rec) && /_opsRing\.shift\(\)/.test(rec));
  ok("写真と一緒に送る（ops）", /ops: _recentOps\(\)/.test(rec));
  ok("  入れるのは 時刻・種類・欄の名前 だけ（中身は入れない）", /\{ t: t, k: String\(kind \|\| "\?"\)\.slice\(0, 10\), f: nmStr, w: kd, g: gap/.test(rec));
  // 2026-11-13: 交互クリックを畳むために DOM 要素を一時的に持つが、**送る時は外す**
  ok("  送る時は DOM 要素を外す（中身ではないが重い）", /return \{ t: o\.t, k: o\.k, f: o\.f, w: o\.w, g: o\.g \};/.test(rec));
  ok("background が ops を受け取って送る", /ops: Array\.isArray\(msg\.ops\) \? msg\.ops : null/.test(bg));
  ok("  送信の中身に shot_ops を足した", /shot_ops: Array\.isArray\(job\.ops\)/.test(bg));
  ok("サーバーが shot_ops を整えて残す", /shot_ops: \(\(\) => \{/.test(api));
  ok("  欄の名前は30字・操作は10字まで", /r\.f\.slice\(0, 30\)/.test(api) && /r\.k\.slice\(0, 10\)/.test(api));
  ok("migrate-schema にも shot_ops 列を足した（同時更新の決まり）", /ADD COLUMN IF NOT EXISTS shot_ops JSONB/.test(mig));
}

console.log("\n■ ② 写真の並びから「次に押す物」を学ぶ（純関数）");
{
  ok("nextPressFrom がある", typeof L.nextPressFrom === "function");
  // 実際の形で試す: 「所在地絞り込み＋」→「大阪市港区」、「沿線・駅絞り込み＋」→「阪急宝塚線」
  const seqs = [
    [{ k: "click", f: "左の所在地絞り込み＋｜span" }, { k: "click", f: "左の大阪市港区｜label.one_city" }, { k: "click", f: "確定してリストへ｜span" }],
    [{ k: "click", f: "左の所在地絞り込み＋｜span" }, { k: "click", f: "左の大阪市港区｜label.one_city" }, { k: "click", f: "確定してリストへ｜span" }],
    [{ k: "click", f: "左の沿線・駅絞り込み＋｜span" }, { k: "click", f: "左の阪急宝塚線｜label.one_line" }],
    [{ k: "click", f: "左の沿線・駅絞り込み＋｜span" }, { k: "click", f: "左の阪急宝塚線｜label.one_line" }],
  ];
  const m = L.nextPressFrom(seqs);
  ok("「所在地絞り込み＋」の次は「大阪市港区」", m["左の所在地絞り込み＋｜span"] && m["左の所在地絞り込み＋｜span"].next === "左の大阪市港区｜label.one_city", m["左の所在地絞り込み＋｜span"]);
  ok("  回数も数える（2回）", m["左の所在地絞り込み＋｜span"].n === 2);
  ok("「沿線・駅絞り込み＋」の次は「阪急宝塚線」", m["左の沿線・駅絞り込み＋｜span"] && m["左の沿線・駅絞り込み＋｜span"].next === "左の阪急宝塚線｜label.one_line");
  ok("「大阪市港区」の次は「確定してリストへ」", m["左の大阪市港区｜label.one_city"] && m["左の大阪市港区｜label.one_city"].next === "確定してリストへ｜span");
  ok("1回だけの組は返さない（偶然かもしれない）", (() => {
    const once = [[{ f: "A" }, { f: "B" }]];
    return Object.keys(L.nextPressFrom(once)).length === 0;
  })());
  ok("  2回あれば返す", (() => {
    const twice = [[{ f: "A" }, { f: "B" }], [{ f: "A" }, { f: "B" }]];
    return L.nextPressFrom(twice).A && L.nextPressFrom(twice).A.next === "B";
  })());
  ok("同じ欄の続き（値の入力中）は数えない", (() => {
    const same = [[{ f: "A" }, { f: "A" }], [{ f: "A" }, { f: "A" }]];
    return Object.keys(L.nextPressFrom(same)).length === 0;
  })());
  ok("多い方の行き先を選ぶ（2対1）", (() => {
    const mix = [[{ f: "A" }, { f: "B" }], [{ f: "A" }, { f: "B" }], [{ f: "A" }, { f: "C" }]];
    return L.nextPressFrom(mix).A.next === "B";
  })());
  ok("空・壊れた入力でも落ちない", Object.keys(L.nextPressFrom(null)).length === 0 && Object.keys(L.nextPressFrom([null, 1, []])).length === 0);
}

console.log("\n■ ③ 押す場所は要素ごとに狙う（v2.7.10 の続き・自動モードで人のように押す）");
{
  const ptr = read("pointer-ui.js");
  ok("要素ごとの位置を読む（_pointsFor）", /function _pointsFor\(name\)/.test(ptr));
  ok("その位置を優先して狙う", /if \(perEl\) \{/.test(ptr));
  ok("動きの速さ・曲がりも学習から（moveMsFor・_bendLike）", /moveMsFor\(prof, dist\)/.test(ptr) && /_bendLike/.test(ptr));
}

console.log("\n■ ④ 中身（入力した文字）は送らない（個人情報を入れない決まり）");
{
  ok("記録するのは欄の名前だけ（value を入れない）", !/_opsRing\.push\(\{[^}]*value/.test(rec));
  ok("サーバーも t・k・f 以外を受け取らない", /t: typeof r\.t === "number" \? r\.t : null/.test(api));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
