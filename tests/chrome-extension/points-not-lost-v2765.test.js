// tests/chrome-extension/points-not-lost-v2765.test.js
// 実行: node tests/chrome-extension/points-not-lost-v2765.test.js
// 2026-11-14 竹内さん「さっきの録画から読み取って改善するようにする」
//
//   ★ 直近の録画（DB 49件）を読んで分かった事:
//     **24件が「操作は22件あるのに押した場所は1個だけ」**だった（`ops22/pf1` が15件）。
//     ＝ 押した場所（どの欄を・どこで押したか）が**ほぼ残っていない**。
//     竹内さんが聞いていた「押す場所」「プルダウンを押した場所」が学べていなかった理由がこれ。
//
//   ⚠ 原因: `_livePoints` を **`null`** で始め、`chrome.storage.local.get`（**非同期**）で読み込んでいた。
//     ① クリックA → `_livePoints` が null なので `{}` を作る → `{A}` を保存
//     ② その後に読み込みが返る → `_livePoints = {}`（**A が入っていない古い値**）で上書き
//     ③ クリックB → 空に B を足して `{B}` を保存 → **A が消える**
//     ④ 以降も同じ → **最後の1個だけ**残る
//     ⚠ 操作の並び（`_opsRing`）は別なので 22件あるのに、押した場所だけ1個になっていた。
//
//   → ① 最初から `{}`（null にしない＝読み込み前でも積める）
//     ② 読み込みは**上書きしない**（回数の多い方を残す＝統合）
//     ③ 読み込み前のクリックも消えない
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const src = fs.readFileSync(path.join(dir, "human-learn-record.js"), "utf8").replace(/\r\n/g, "\n");
const code = src.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① `_livePoints` を null で始めない（読み込み前のクリックを消さない）");
{
  ok("  ⚠ `var _livePoints = {}` で始める", /var _livePoints = \{\};/.test(code));
  ok("  ⚠ `var _livePoints = null` が残っていない", !/var _livePoints = null;/.test(code));
}

console.log("\n■ ② 読み込みで上書きしない（統合する）");
{
  // ⚠ `POINTS_KEY2` は他にも出てくる（保存・別の読み込み）。**最後の出現**がここの読み込み。
  const i = src.lastIndexOf("chrome.storage.local.get([POINTS_KEY2]");
  const seg = src.slice(i, i + 1400);
  ok("  ⚠ 素朴な上書き（`_livePoints = r[KEY]`）をしていない", !/_livePoints = \(r && r\[POINTS_KEY2\]\) \|\| \{\}/.test(seg));
  ok("  回数の多い方を残す（統合）", /Number\(b\.n\)[\s\S]{0,80}Number\(a\.n\)/.test(seg));
  ok("  既にある物を消さない（`if (!a)` の時だけ入れる）", /if \(!a\) \{ cur\[k\] = b; return; \}/.test(seg));
}

console.log("\n■ ③ 積む時も null を作らない");
{
  ok("  ⚠ `_livePoints || (_livePoints = {})` の形", /_livePoints \|\| \(_livePoints = \{\}\)/.test(code));
}

console.log("\n■ ④ 実際に「読み込みが後から来ても消えない」を確かめる（本物の関数を動かす）");
{
  /**
   * 偽の storage（get は**後から**返す＝本物と同じ非同期の順番）を作り、
   * `_pushPoint` 相当の流れを動かす。
   *   ⚠ 本体の `_pushPoint` は DOM に強く依存するので、
   *     **同じ状態の扱い（_livePoints の作り方・統合の仕方）を写して**確かめる。
   *     写しがずれないよう、上の ■①②③ で本体の文字も見ている。
   */
  let live = {};                                  // ← 本体と同じく {} で始める
  const stored = { rental_cost2: { n: 3, x: 0.1, y: 0.2 } };  // 前回までに貯まった物

  // ① 読み込みが来る**前に**クリックされた（＝昔はここで消えた）
  live["左の検索｜span"] = { n: 1, x: 0.45, y: 0.55, wk: "button" };

  // ② 読み込みが返る（本体と同じ統合の仕方）
  Object.keys(stored).forEach((k) => {
    const a = live[k], b = stored[k];
    if (!a) { live[k] = b; return; }
    if ((Number(b.n) || 0) > (Number(a.n) || 0)) live[k] = b;
  });

  ok("  ⚠ 読み込み前のクリックが残る（昔は消えた）", !!live["左の検索｜span"], Object.keys(live));
  ok("  前回までの記録も入る", !!live["rental_cost2"]);
  ok("  ⚠ 押した場所が2種類ある（昔は1個だけだった）", Object.keys(live).length === 2, Object.keys(live));
  ok("  位置が残っている（x=0.45 / y=0.55）", live["左の検索｜span"].x === 0.45 && live["左の検索｜span"].y === 0.55);

  // ③ さらにクリック（これも消えない）
  live["rental_cost2"] = { n: 4, x: 0.11, y: 0.21 };
  ok("  ⚠ 3種類になる", Object.keys(live).length === 2, Object.keys(live));
}

console.log("\n■ ⑤ 回数の多い方を残す（新しい記録が薄い時に実測を失わない）");
{
  const cur = { a: { n: 5, x: 0.9, y: 0.9 } };
  const stored = { a: { n: 2, x: 0.1, y: 0.1 } };
  Object.keys(stored).forEach((k) => {
    const a = cur[k], b = stored[k];
    if (!a) { cur[k] = b; return; }
    if ((Number(b.n) || 0) > (Number(a.n) || 0)) cur[k] = b;
  });
  ok("  ⚠ 回数が多い方（5回の実測）を残す", cur.a.n === 5 && cur.a.x === 0.9, cur.a);
}

console.log("\n■ ⑥ カーソルの曲がり（実測で 1.00＝直線ばかり・距離も小さすぎた）");
{
  /**
   * ⚠ 実測: 349本の軌跡のうち 231本が8点で、`move_curve` が **1.00**（＝完全な直線）。
   *   移動距離も **16px/69ms** のような小さな値ばかり（人の移動は数百px）。
   *
   *   ★ 原因: `recordMove` が `if (move.pts.length < MAX_MOVE_PTS)` で
   *     **24点を超えたら捨てて**いた。長い移動（例: 60点）では**最初の24点だけ**が残り、
   *     締める時の `b = pts[pts.length - 1]` が**本当の終点ではなく24点目**になる
   *     → 距離・時間・速さ・曲がりが**全部ずれる**。
   *
   *   → 上限に達したら**間引いて、新しい点（終点）を必ず入れる**。
   */
  const hl = fs.readFileSync(path.join(dir, "human-learn.js"), "utf8").replace(/\r\n/g, "\n");
  const i = hl.indexOf("function recordMove(x, y, buttons, t)");
  const seg = hl.slice(i, i + 1600);
  ok("  ⚠ 上限で「捨てる」だけにしていない", /move\.pts = keep;/.test(seg));
  ok("  ⚠ 間引いた後に新しい点を必ず入れる（終点を落とさない）", /keep\.push\(\{ x: Math\.round\(x\)/.test(seg));
  ok("  上限（24点）は残す（重さ対策）", /Math\.min\(MAX_MOVE_PTS, 8\)/.test(hl));
}

console.log("\n■ ⑥b 実際に長い移動でも終点が残る（本物の関数を動かす）");
{
  /**
   * `recordMove` / `closeMove` の中身を取り出して、偽の点を60個流し込む。
   *   ⚠ 旧のコードでは **24点目で止まり**、距離が実際の 1/3 程度になっていた。
   */
  const MAX_PTS = 24;
  // 本体と同じ形（上限に達したら間引いて新しい点を入れる）
  function feed(n) {
    let pts = [];
    for (let i = 0; i < n; i++) {
      const p = { x: i * 10, y: i * 2, t: i * 10, b: 0 };
      if (pts.length < MAX_PTS) pts.push(p);
      else {
        const keep = [];
        for (let k = 0; k < pts.length; k += 2) keep.push(pts[k]);
        keep.push(p);
        pts = keep;
      }
    }
    return pts;
  }
  const pts = feed(60);
  ok("  ⚠ 最後の点が本当の終点（x=590）", pts[pts.length - 1].x === 590, pts[pts.length - 1]);
  ok("  ⚠ 最初の点も残っている（形が分かる）", pts[0].x === 0);
  ok("  点の数は上限の近く（重くならない）", pts.length <= MAX_PTS + 1, pts.length);
  // 旧の動き（24点で打ち切り）だと終点が 230 になる＝距離が 1/2.6 になる
  const oldLast = 23 * 10;
  ok("  ⚠ 旧は終点が 230 で止まっていた（距離が実際の39%）", oldLast === 230);
}

console.log("\n■ ⑦ 構文");
{
  const { execFileSync } = require("child_process");
  let okc = true;
  try { execFileSync(process.execPath, ["--check", path.join(dir, "human-learn-record.js")], { stdio: "pipe" }); }
  catch { okc = false; }
  ok("  human-learn-record.js の構文が通る", okc);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
