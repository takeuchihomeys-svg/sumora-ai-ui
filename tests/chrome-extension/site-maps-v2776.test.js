/**
 * サイト別の全体図（リアプロ／itandi／レインズ）のテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「リアプロitandiそれぞれ全体図つくっていくのと 補強して細かくきょうかしていく
 *     全体図があればわかりやすい どこを強化する部分があるのかもすぐにわかるし かいぜんできうようになる」
 *
 * ★ このテストが守る物
 *   ① サイトごとに**分けて**数える（欄の名前も手順も別物。混ぜると弱い所が見えなくなる）
 *   ② **新しい版の数字で強化する所を決める**（古い版で薄まった数字で決めると順番を間違える）
 *   ③ 件数0を「0%」と出さない（「測って悪い」と誤解する）→ 「－」と出す
 *   ④ 記録が無いサイトは「無い」と正直に出す（推測で埋めない）
 *
 * 実行: node tests/chrome-extension/site-maps-v2776.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };

const src = fs.readFileSync(path.join(ROOT, "scripts/site-maps.ts"), "utf8");

// ── ① サイトを分ける ────────────
t("3サイトを別々に持つ", /realpro/.test(src) && /itandi/.test(src) && /reins/.test(src));
t("サイト名の日本語を持つ", /リアプロ/.test(src) && /ITANDI BB/.test(src) && /レインズ/.test(src));
t("サイトで絞って集計する", /String\(r\.site \?\? ""\) === s\.key/.test(src));
t("サイト別の図を書き出す", /tmp-map-\$\{s\.key\}\.svg/.test(src));
t("索引（3サイトを1枚）を作る", /tmp-map-index\.svg/.test(src));

// ── ② 新しい版の数字で決める ────────────
t("新しい版を取り出す", /p\[2\] \?\? 0\) >= 46/.test(src));
t("強化する所は新しい版で決める", /const base = rn > 0 \? recent : rows/.test(src));
t("古い版しか無い時にそう言う", /新しい版（2\.7\.46以降）の記録が0件/.test(src));
t("全期間の数字も併記する", /全期間/.test(src) && /pctOf\(rows, hasOps\)/.test(src));
t("なぜ2つ見るかをコメントで残す", /薄まって/.test(src));

// ── ③ 0件を0%と出さない ────────────
t("件数0は「－」と出す", /rateTxt/.test(src) && /: "－"/.test(src));
t("バーの長さは0件なら0", /ratePct/.test(src));
t("索引でも null を「－」にする", /x\.ops == null \? "－"/.test(src));

// ── ④ 無い物は無いと言う ────────────
t("記録が無ければそう出す", /記録がありません → このサイトで1回検索して録画する/.test(src));
t("少ない記録は傾向と言わない", /まだ傾向とは言えません|傾向とは言えない/.test(src));

// ── ⑤ 3つの軸（マウス・ボタン・プルダウン）が入っている ────────────
t("マウスの実測を出す", /速さ \$\{medSpeed/.test(src));
t("ボタンの欄の数を出す", /欄 \$\{Object\.keys\(fieldHit\)\.length\}種類/.test(src));
t("プルダウン（select）を数える", /o\.w === "select"/.test(src));
t("開いた中身の割合を出す", /開いた中身/.test(src));

// ── ⑥ よく押す欄と段ごとの手順 ────────────
t("よく押す欄を出す", /よく押す欄/.test(src));
t("段（step）ごとの手順を出す", /画面の段ごとの手順/.test(src));

// ── ⑦ 入力した中身を出さない ────────────
t("入力の中身を扱わないと明記", /欄の名前と位置だけ|入力した中身/.test(src));

// ── ⑧ 図が実際に在る（作った証拠）────────────
const mapDir = path.join(ROOT, "memory/site-maps");
for (const f of ["tmp-map-index.png", "tmp-map-realpro.png", "tmp-map-itandi.png", "tmp-map-reins.png"]) {
  const p = path.join(mapDir, f);
  t(`図が在る: ${f}`, fs.existsSync(p) && fs.statSync(p).size > 10000);
}

// ── ⑨ 実測の数字（誤読しないための記録）────────────
//   実測: リアプロの操作の並びは全期間49% → 新しい版だけ98%。
//   この差を「古い版のせい」と説明できないと、また順番を間違える。
t("全期間と新しい版で差が出る事をコメントで残す", /49%/.test(src) || /98%/.test(src));
t("古い版の欠けは撮り直せば直ると書く", /撮り直せば直る|古い版の欠け/.test(src));

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
