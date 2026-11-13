// 実行: node tests/chrome-extension/learn-points-per-element-v2710.test.js
// 2026-11-13 竹内さん「撮影したところからぼたんの押す場所の確認や移動の部分で学習した部分あるか。学習したら」
//
//   これまで学習していた物（DB で実際に確認）:
//     ・押した位置（point_fields）… rental_cost2 → {x:0.10, y:0.14, n:6} など**要素ごと**に記録されていた
//     ・マウスの速さ・曲がり … `profileFrom` で癖にして、カーソルの動きに反映
//   ただし **押す位置は「全体の平均1つ」しか使っていなかった**（要素ごとの違いが反映されない）。
//   → 要素ごとの実測（`axlx_human_points`）を読み、**そのボタンの押された場所**を狙うようにした。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const ptr = read("pointer-ui.js");
const rec = read("human-learn-record.js");
const learn = read("human-learn.js");

console.log("■ ① 押した位置は要素ごとに覚えている（今まで通り）");
{
  ok("要素の名前を作る（fieldName）", /function fieldName\(/.test(learn));
  ok("  欄の名前を最優先（input/select の name）", /getAttribute\("name"\)/.test(learn));
  ok("  2か所の「検索」を区別する（左の／小窓の）", /placePrefix = "小窓の"/.test(learn) && /placePrefix = "左の"/.test(learn));
  ok("押した位置を要素ごとに集める（point_fields）", /point_fields|points\.fields/.test(read("human-learn-upload.js")) || /fields/.test(rec));
}

console.log("\n■ ② 要素ごとの押した位置を storage に貯める（新規）");
{
  ok("鍵は axlx_human_points", /POINTS_KEY2 = "axlx_human_points"/.test(rec));
  ok("2回以上押した物だけ使う（1回は偶然かもしれない）", /nNew <= nOld/.test(rec) || /Number\(v\.n\) < 2/.test(ptr));
  ok("回数の多い方（新しい実測）に寄せる", /if \(nNew <= nOld\) return;/.test(rec));
}

console.log("\n■ ③ カーソルが「そのボタンの押された場所」を狙う（新規）");
{
  ok("読み出し口がある（_pointsFor）", /function _pointsFor\(name\)/.test(ptr));
  ok("  pointer-ui と同じ鍵", /POINTS_KEY = "axlx_human_points"/.test(ptr));
  ok("  30秒ごとに読み直す（貯まった分を次の動きから）", /30000/.test(ptr));
  ok("  2回未満は使わない", /if \(Number\(v\.n\) < 2\) return null;/.test(ptr));
  ok("要素ごとの位置を**優先**して狙う", /if \(perEl\) \{/.test(ptr));
  ok("  無ければ全体の平均（prof.aim）", /else if \(prof && prof\.aim\)/.test(ptr));
  ok("  揺らしは小さめ（要素の中なので 0.12）", /perEl\.x \+ \(Math\.random\(\) - 0\.5\) \* 0\.12/.test(ptr));
  ok("要素の外にはみ出さない（0.15〜0.85）", /Math\.max\(0\.15, Math\.min\(0\.85, perEl\.x/.test(ptr));
}

console.log("\n■ ④ 移動（速さ・曲がり）の学習は今まで通り効いている");
{
  ok("速さから移動時間を出す（moveMsFor）", /function moveMsFor\(profile, dist\)/.test(learn));
  ok("  120〜1600msに丸める（飛ばない・止まらない）", /Math\.max\(120, Math\.min\(1600/.test(learn));
  ok("カーソルが覚えた時間で動く", /_LL\.moveMsFor\(prof, dist\)/.test(ptr));
  ok("曲がりも反映する（_bendLike）", /_bendLike/.test(ptr) && /prof\.curve/.test(ptr));
  ok("貯まるたびに癖を作り直す", /PROFILE_KEY|axlx_human_profile/.test(rec));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
