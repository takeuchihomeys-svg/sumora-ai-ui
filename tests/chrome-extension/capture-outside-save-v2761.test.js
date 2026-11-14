// tests/chrome-extension/capture-outside-save-v2761.test.js
// 実行: node tests/chrome-extension/capture-outside-save-v2761.test.js
// 2026-11-14 竹内さん「新しくとった直近のから動き方動かすようにする／あたらしく直近でとった録画されているのか」
//
//   ★ DBを見て判明（実測・決定的）:
//     21:26 の記録は 操作450件・欄20種類・順番6件・マウス490回と**全部取れていた**のに、**写真が0枚**だった。
//     21:17（v2.7.58）では写真が撮れていた（480px）ので、**私が構造を変えて壊した**。
//
//   ⚠ 真の原因: `save()` の**閉じる括弧が1つ足りなかった**。
//     そのため `save()` が 675行まで伸び、次の関数が**全部 `save()` の中**に閉じ込められていた。
//       _pushOp / _bootShooting / _attachOpCapture / _pushPoint / shootAfter …
//     `startShooting()` は `start()` 直下にあるので、`save()` の中の `shootAfter` を**参照できない**
//     （`ReferenceError`）→ 外側の `try{}catch{}` に飲まれて**黙って写真0枚**。エラーも出ない。
//
//   ⚠ なぜ今まで気づけなかったか: `node --check` は**通る**（構文としては正しい・関数が入れ子なだけ）。
//     テストも `function shootAfter(` の**文字があるか**しか見ていなかった。
//   → **関数が「start() の直下にいるか」を構造で確かめる**（文字の有無では不十分）。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const rec = read("human-learn-record.js");

/**
 * 関数の**入れ子の深さ**を数える（acorn が無い環境でも動くよう、文字を数えるだけにする）。
 *   ⚠ `node --check` では見つからない「関数が別の関数の中に入った」を検出するのが目的。
 *   → 各関数宣言の位置で「開いている { の数」から、その関数の親が何段かを出す。
 */
function depthAt(src, index) {
  let d = 0;
  for (let i = 0; i < index; i++) {
    const c = src[i];
    if (c === "{") d++;
    else if (c === "}") d--;
  }
  return d;
}

/** コメントを落とす（コメント内の `function foo(` を数えないため） */
const code = rec.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① save() が短い（撮影の関数を飲み込んでいない）");
{
  const iSave = code.indexOf("function save(force) {");
  ok("save(force) がある", iSave > 0);

  // save の開始位置から、次に現れる「深さが save と同じ」関数宣言を探す
  const dSave = depthAt(code, iSave);
  let nextSameDepth = -1;
  const re = /^\s*function (\w+)\(/gm;
  let m;
  while ((m = re.exec(code))) {
    if (m.index <= iSave) continue;
    if (depthAt(code, m.index) === dSave) { nextSameDepth = m.index; break; }
  }
  const saveLines = nextSameDepth > 0
    ? code.slice(iSave, nextSameDepth).split("\n").length
    : 99999;

  /**
   * ⚠ 壊れていた時の save は **675行**だった（撮影の541行を抱えていた）。
   *   正常な save は 100〜200行。**250行を超えたら「飲み込んでいる」**とみなす。
   */
  ok("⚠ save() が 250行未満（撮影の関数を抱えていない）", saveLines < 250, { saveLines });
}

console.log("\n■ ② 撮影・操作の関数が start() の**直下**にいる（save の中ではない）");
{
  const iStart = code.indexOf("function start() {");
  const dStart = depthAt(code, iStart);
  ok("start() がある（宣言の深さ " + dStart + "）", iStart > 0);
  /**
   * ⚠ `function start() {` の位置では、まだ start 自身の `{` を数えていない。
   *   → start の**中**は `dStart + 1`。
   */
  const dInside = dStart + 1;

  /**
   * ⚠ ここが今回の核心。`function shootAfter(` の**文字があるか**では駄目で、
   *   **start() の直下（深さが dInside）にいるか**を確かめる。
   */
  const must = ["shootAfter", "_attachOpCapture", "_bootShooting", "_pushOp", "_pushPoint",
    "_recentOps", "startShooting", "stopShooting", "_noteShotDiag", "_savePoints", "apply"];
  for (const name of must) {
    const i = code.indexOf("function " + name + "(");
    if (i < 0) { ok("  " + name + " がある", false); continue; }
    const d = depthAt(code, i);
    ok("  ⚠ " + name + " は start() の直下（深さ " + d + " = " + dInside + "）", d === dInside, { name, d, dInside });
  }
}

console.log("\n■ ③ startShooting から shootAfter が見える（同じ階層）");
{
  const iShoot = code.indexOf("function startShooting() {");
  const iAfter = code.indexOf("function shootAfter(");
  ok("両方ある", iShoot > 0 && iAfter > 0);
  ok("  ⚠ 同じ深さ（片方が関数の中だと ReferenceError で黙って止まる）",
    depthAt(code, iShoot) === depthAt(code, iAfter),
    { startShooting: depthAt(code, iShoot), shootAfter: depthAt(code, iAfter) });
  // 実際に startShooting が shootAfter を呼んでいる
  const seg = code.slice(iShoot, iShoot + 2000);
  ok("  startShooting が shootAfter を呼ぶ", /shootAfter\(/.test(seg));
}

console.log("\n■ ④ save() の閉じ括弧が正しい（次に try が続いていない）");
{
  /**
   * ⚠ 壊れていた時の形: `  }` の直後に**インデントされた `try {`** が続いていた
   *   （save の続きのつもりが、関数の外に出ていた）。
   *   正常なら save の閉じ `}` の後は空行＋コメント。
   */
  const lines = code.split("\n");
  const iSave = lines.findIndex((l) => /^\s*function save\(force\)/.test(l));
  ok("save の行が見つかる", iSave >= 0);
  // save の閉じ（深さが戻る行）を探す
  let d = 0, closeLine = -1;
  for (let i = iSave; i < Math.min(lines.length, iSave + 400); i++) {
    for (const c of lines[i]) { if (c === "{") d++; else if (c === "}") d--; }
    if (d === 0) { closeLine = i; break; }
  }
  ok("save の閉じが見つかる", closeLine > 0);
  const after = lines.slice(closeLine + 1, closeLine + 4).join("\n");
  ok("  ⚠ 閉じた直後に `try {` が続かない", !/^\s*try \{/m.test(after), { after });
}

console.log("\n■ ⑤ 写真は watching に依存しない（v2.7.56 の決定を守る）");
{
  const i = code.indexOf("function shootAfter(");
  const seg = code.slice(i, i + 9000);
  ok("watching で早期 return しない", !/if \(!watching\)\s*return/.test(seg));
  ok("止める設定は axlxShotOff だけ", /axlxShotOff/.test(seg));
}

console.log("\n■ ⑥ 構文");
{
  let okSyntax = true;
  try { new Function(rec); } catch (e) { okSyntax = false; }
  ok("human-learn-record.js の構文が通る", okSyntax);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
