// 実行: node tests/chrome-extension/auto-motion-learn-v2700.test.js
// 2026-11-11 竹内さん「動きも学習させたい」「画像もっと容量落としても大丈夫」
//
//   ① 自動モードでも**拡張自身の動き**を覚える（人が押した時だけ、では自動モードで何も残らない）
//      ⚠ ただし人の実測とは**別の入れ物**（`axlx_auto_motion`）。混ぜると「人の速さ」が壊れる
//   ② 写真をもっと小さく（長辺800px・JPEG32% → 40〜90KB）
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const rec = read("human-learn-record.js"), pu = read("pointer-ui.js"), bg = read("background.js");
const L = require(path.join(EXT, "human-learn.js"));

console.log("■ ① 自動モードの動きを覚える（人の実測と分ける）");
{
  ok("専用の入れ物（axlx_auto_motion / サイト別キー）", /var AUTO_KEY = "axlx_auto_motion"/.test(rec) && /var SITE_AUTO_KEY = /.test(rec));
  ok("拡張が押した事を受け取る口（__axlxNoteAutoOp）", /window\.__axlxNoteAutoOp = noteAutoOp/.test(rec));
  ok("押した場所を要素の中の割合で残す（カーソルの居た所）", /fx = Math\.round\(Math\.max\(0, Math\.min\(1, \(pos\.x - r\.left\) \/ r\.width\)\)/.test(rec));
  ok("間隔（gap）も残す", /gap: gap/.test(rec));
  ok("**人の実測とは別**の印を付ける（source）", /next\.source = "extension_auto"/.test(rec));
  ok("人の学習（axlx_human_learn）には混ぜない", /chrome\.storage\.local\.get\(\[(?:AUTO_KEY|SITE_AUTO_KEY)\]/.test(rec) && !/o\[(?:KEY|SITE_KEY)\] = next[\s\S]{0,40}noteAutoOp/.test(rec));
  ok("20件たまったら書き出す（毎回書かない）", /_autoOps\.length >= 20/.test(rec));
  // pointer-ui から知らせる
  ok("押す時（tap）に知らせる", /__axlxNoteAutoOp/.test(pu) && /_n\("tap", _tapEl, null\)/.test(pu));
  ok("狙った要素を覚える（_tapEl）", /_tapEl = el;/.test(pu));
  // 集計が読める
  const s = L.summarize([{ t: 1000, k: "tap", f: "検索" }, { t: 1800, k: "tap", f: "rental_cost2" }]);
  ok("記録の形を集計できる（n・kinds・fields）", s.n === 2 && s.kinds.tap === 2 && s.fields.indexOf("検索") >= 0);
}

console.log("\n■ ② 写真をもっと小さく");
{
  ok("2026-11-15「読めるサイズにする」: 等倍（上限1920px）で送る", /var SHOT_MAX_SIDE = 1920/.test(bg) && /const cap = _big \? SHOT_BIG_SIDE : SHOT_MAX_SIDE/.test(bg));
  ok("⚠ 480px に縮めてから左34%を切ると欄が163pxになり読めない（やめた）", !/SHOT_SEND_SIDE = 480/.test(bg));
  ok("縮めた物を送る", /data_url: shotForUpload/.test(bg));
  ok("元と送る物の大きさをログに出す", /撮りました: 元 /.test(bg));
}

console.log("\n■ ③ 写真はどのモードでも撮る（前回の直しが残っている）");
{
  ok("shouldShoot がある", /function shouldShoot\(st\)/.test(rec));
  // 2.8.313 退役: 「写真の見張りはモードに関係なく動く」— 2.8.154（2026-11-22 竹内さん「録画モード押していない時でも重い」）で、写真は自動・録画中だけに置き換えた（human-learn-record.js shouldShoot・memory/dept_search_tool.md 2.8.154・正本の試験は shot-gate-v28154.test.js）
  ok("起動直後に1枚撮る", /shootAfter\("startup"/.test(rec));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
