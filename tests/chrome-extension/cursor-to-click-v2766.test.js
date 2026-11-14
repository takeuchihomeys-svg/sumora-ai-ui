// tests/chrome-extension/cursor-to-click-v2766.test.js
// 実行: node tests/chrome-extension/cursor-to-click-v2766.test.js
// 2026-11-14 竹内さん「画面からプルダウンのばしょやカーソルのうごかしてクリックおしていた動きは理解しているのかな」
//
//   ★ 実測（7日 6,027件・全頁）
//     ① プルダウンの位置 → **100%取れている**（select 558件すべてに x,y あり・4種類を記憶）
//     ② カーソルの軌跡 → **押した場所に届いていない**
//          軌跡 1,917本 / 終点が押した場所とほぼ同じ **0本** / 5%以内 339本
//          ずれの中央値 0.152（画面の15%＝数百px）
//     ③ 1回の移動が **中央値 376ms・80px**（人は 200〜600px 動く＝**細切れ**）
//
//   ⚠ 原因は2つ:
//     (a) 350ms で締めていたので、人の1ストロークが**細切れ**になっていた
//     (b) クリックが来ても**貯めている移動を締めていなかった**ので、
//         押した瞬間の位置が別の移動になり、軌跡の終点と押した場所が**繋がらなかった**
//
//   → (a) 650ms に伸ばす（人の手が止まる自然な間）
//     (b) **押す直前に必ず締める**（＝軌跡の終点が押した場所になる）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const hl = fs.readFileSync(path.join(dir, "human-learn.js"), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① 移動を締める間を伸ばした（細切れを直す）");
{
  const m = hl.match(/var MOVE_GAP_MS = (\d+);/);
  ok("  MOVE_GAP_MS がある", !!m);
  ok("  ⚠ 350ms より長い（旧は細切れで 80px しか動いていなかった）", m && Number(m[1]) >= 600, m && m[1]);
  ok("  ⚠ 長すぎない（別の操作が混ざる・1000ms 未満）", m && Number(m[1]) < 1000, m && m[1]);
}

console.log("\n■ ② 押す直前に移動を締める（軌跡の終点を押した場所にする）");
{
  ok("  クリックで closeMove を呼ぶ", /if \(type === "click" \|\| type === "change"\) \{ try \{ closeMove\(\); \}/.test(hl));
  // ⚠ record より**前**に呼ぶこと（後だと押した操作が前の移動に混ざる）
  const iClose = hl.indexOf('if (type === "click" || type === "change") { try { closeMove(); }');
  const iRec = hl.indexOf("var added = record(type, e.target);");
  ok("  ⚠ record より前にある", iClose > 0 && iRec > 0 && iClose < iRec, { iClose, iRec });
}

console.log("\n■ ③ 実際に「押した時に移動が締まる」を動かして確かめる");
{
  /**
   * `closeMove` と `recordMove` の**決まり**を写して動かす（本体の文字は上の■①②で見ている）。
   *   ⚠ 旧: 60点動いてからクリック → 350ms 以内なので**締まらず**、押した場所が移動に混ざる
   *     新: クリックで締める → **軌跡の終点が押した場所**になる
   */
  const MOVE_GAP_MS = 650;
  let move = null;
  const moves = [];
  function recordMove(x, y, buttons, t) {
    if (!move || t - move.lastAt > MOVE_GAP_MS) {
      closeMove();
      move = { t0: t, lastAt: t, pts: [], drag: !!buttons };
    }
    move.lastAt = t;
    if (move.pts.length < 24) move.pts.push({ x, y, t });
    else {
      const keep = [];
      for (let i = 0; i < move.pts.length; i += 2) keep.push(move.pts[i]);
      keep.push({ x, y, t });
      move.pts = keep;
    }
  }
  function closeMove() {
    if (!move || move.pts.length < 2) { move = null; return; }
    const a = move.pts[0], b = move.pts[move.pts.length - 1];
    let dist = 0;
    for (let i = 1; i < move.pts.length; i++) dist += Math.hypot(move.pts[i].x - move.pts[i - 1].x, move.pts[i].y - move.pts[i - 1].y);
    moves.push({ from: [a.x, a.y], to: [b.x, b.y], dist: Math.round(dist), ms: b.t - a.t });
    move = null;
  }

  // 人が 400px 動いてから、その場所を押す
  for (let i = 0; i <= 40; i++) recordMove(100 + i * 10, 200 + i * 2, 0, i * 16);   // 0〜640ms
  // ⚠ 新: 押す直前に締める
  closeMove();

  ok("  ⚠ 押す前に1本に締まる", moves.length === 1, moves.length);
  ok("  ⚠ 軌跡の終点が押した場所（x=500）", moves[0] && moves[0].to[0] === 500, moves[0]);
  ok("  ⚠ 距離が実際の 400px 以上（旧は80pxしか取れていなかった）", moves[0] && moves[0].dist >= 400, moves[0] && moves[0].dist);
  ok("  時間も 600ms 以上（人の1ストローク）", moves[0] && moves[0].ms >= 600, moves[0] && moves[0].ms);
}

console.log("\n■ ④ 押さずに止まった時も、650ms で自然に締まる");
{
  const MOVE_GAP_MS = 650;
  let move = null;
  const moves = [];
  function recordMove(x, y, t) {
    if (!move || t - move.lastAt > MOVE_GAP_MS) {
      if (move && move.pts.length >= 2) moves.push(move);
      move = { lastAt: t, pts: [] };
    }
    move.lastAt = t;
    move.pts.push({ x, y, t });
  }
  recordMove(100, 100, 0);
  recordMove(300, 150, 200);
  recordMove(500, 200, 400);
  ok("  650ms 以内は1本のまま", moves.length === 0);
  recordMove(500, 200, 1200);   // 400→1200 で 800ms あいた
  ok("  ⚠ 650ms あいたら締まる", moves.length === 1, moves.length);
  ok("  締まった移動は3点", moves[0] && moves[0].pts.length === 3, moves[0] && moves[0].pts.length);
}

console.log("\n■ ⑤ 構文");
{
  let okc = true;
  try { execFileSync(process.execPath, ["--check", path.join(dir, "human-learn.js")], { stdio: "pipe" }); }
  catch { okc = false; }
  ok("  human-learn.js の構文が通る", okc);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
