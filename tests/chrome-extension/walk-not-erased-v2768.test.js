// tests/chrome-extension/walk-not-erased-v2768.test.js
// 実行: node tests/chrome-extension/walk-not-erased-v2768.test.js
// 2026-11-14 竹内さん「徒歩の部分選択したら、そこは押して消えてしまうのは改善されるようになっているのか」
//
//   ★ 実データで確認（7日6,027件）。まず「消えている」と見えたが、**記録の数え方**だった:
//
//     徒歩（transportation_id）の記録の中身（実測・全72件が同じ間隔）:
//       +0ms    click  transportation_id  (w=select)   ← 人が「徒歩」を選ぶ
//       +1018ms change transportation_id  (w=select)   ← ブラウザが「値が変わった」を出す
//       +2080ms click  required_time      (w=text)     ← 分数を入れる
//       +7021ms change required_time      (w=text)     ← 入力を確定
//
//   ⚠ **1回の操作が `click` と `change` の2件**として記録されていた（差は **1,018ms で一定**）。
//     そのため「徒歩を2回選んだ」ように見え（165件中141件）、
//     手順として学ぶと「徒歩 → 徒歩 → 分数」という**人がやらない手順**になっていた。
//   ⚠ 既存の `splitByScene` は「直前と同じ名前なら畳む」だが、
//     `change` が 1,018ms 後に来るので**時刻を見ていなかった**ため残っていた。
//
//   → **同じ欄の click→change は1回に畳む**（既定 1,200ms 以内）。
//     ⚠ 1,200ms より離れた同じ欄は**押し直しとして残す**（迷いの証拠・実測では0件）。
//
//   ⚠ 自動で押す方は既に直っている（`page-script.js` の `_keepTransportBeforeWalk`）:
//     リアプロは移動手段を選ぶと**下の分数がリセットされる**ので、移動手段を必ず先に固定する。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const dir = path.join(__dirname, "..", "..");
const src = fs.readFileSync(path.join(dir, "app", "lib", "learn-flow-steps.ts"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

/** 本体と同じ決まりを写す（本体の文字は ■④ で見る） */
function collapseSameField(ops, opt) {
  const gap = (opt && opt.gapMs) || 1200;
  const out = [];
  let prevF = "", prevT = 0, has = false;
  for (const o of ops) {
    const f = typeof (o && o.f) === "string" ? o.f : "";
    const t = Number(o && o.t) || 0;
    if (f && has && f === prevF && Math.abs(t - prevT) <= gap) { prevT = t; continue; }
    out.push(o);
    if (f) { prevF = f; prevT = t; has = true; }
  }
  return out;
}

console.log("■ ① 実測の形（徒歩の click → change が 1018ms 後）を1回に畳む");
{
  // ⚠ これは**実際にDBに入っていた形**（推測で作っていない）
  const ops = [
    { t: 0, k: "click", f: "transportation_id", w: "select" },
    { t: 1018, k: "change", f: "transportation_id", w: "select" },
    { t: 2080, k: "click", f: "required_time", w: "text" },
    { t: 7021, k: "change", f: "required_time", w: "text" },
  ];
  const out = collapseSameField(ops);
  /**
   * ⚠ 期待値は **3件**（徒歩1回・分数の click と change）。
   *   `required_time` は click(2080) → change(7021) で **4,941ms 差**なので畳まれない
   *   （分数は打ち込んで確定するまで時間がかかる＝**畳むべきではない**・正しい）。
   *   ⚠ 直したいのは「徒歩が2回」の方なので、そこだけ見る。
   */
  ok("  ⚠ 4件 → 3件（徒歩は1回・分数は click と change が離れているので残る）", out.length === 3, out.length);
  ok("  ⚠ 徒歩は click の1件だけ残る", out[0].k === "click" && out[0].f === "transportation_id", out[0]);
  ok("  分数の click が残る", out[1].f === "required_time" && out[1].k === "click", out[1]);
  ok("  ⚠ 「徒歩 → 徒歩 → 分数」にならない", out.filter((o) => /transportation_id/.test(o.f)).length === 1);
}

console.log("\n■ ② 本当の押し直しは残す（迷いの証拠を消さない）");
{
  const ops = [
    { t: 0, k: "click", f: "rental_cost2" },
    { t: 5000, k: "change", f: "rental_cost2" },   // 5秒後＝別の操作として残す
  ];
  const out = collapseSameField(ops);
  ok("  ⚠ 1200ms より離れていれば2件残る（押し直し）", out.length === 2, out.length);
  const quick = collapseSameField([{ t: 0, k: "click", f: "a" }, { t: 300, k: "change", f: "a" }]);
  ok("  300ms なら1件に畳む", quick.length === 1, quick.length);
  const bound = collapseSameField([{ t: 0, k: "click", f: "a" }, { t: 1200, k: "change", f: "a" }]);
  ok("  ちょうど 1200ms は畳む", bound.length === 1, bound.length);
  const over = collapseSameField([{ t: 0, k: "click", f: "a" }, { t: 1201, k: "change", f: "a" }]);
  ok("  1201ms は残す", over.length === 2, over.length);
}

console.log("\n■ ③ 別の欄は畳まない（区を続けて選ぶ手順を壊さない）");
{
  const ops = [
    { t: 0, k: "click", f: "大阪市都島区" },
    { t: 200, k: "click", f: "大阪市中央区" },
    { t: 400, k: "click", f: "大阪市西区" },
  ];
  const out = collapseSameField(ops);
  ok("  ⚠ 3つとも残る（別の区）", out.length === 3, out.length);
}

console.log("\n■ ④ 本体（learn-flow-steps.ts）が同じ決まりを持っている");
{
  ok("  collapseSameField がある", /export function collapseSameField</.test(src));
  ok("  既定は 1200ms", /gapMs \?\? 1200|opt\.gapMs \?\? 1200/.test(src));
  ok("  ⚠ splitByScene が畳んでから分ける", /const list0 = collapseSameField\(/.test(src));
  ok("  ⚠ 時刻の差で判定している（名前だけではない）", /Math\.abs\(t - prevT\) <= gap/.test(src));
}

console.log("\n■ ⑤ 自動で押す方は移動手段を先に固定している（消えない）");
{
  const ps = fs.readFileSync(path.join(dir, "chrome-extension", "page-script.js"), "utf8");
  ok("  _keepTransportBeforeWalk がある", /_keepTransportBeforeWalk/.test(ps));
  ok("  ⚠ 並べ替えの後にもう一度そろえる", /_keepTransportBeforeWalk2/.test(ps));
  ok("  移動手段を分数より前に固定する", /_ti < _wi\) return;/.test(ps));
}

console.log("\n■ ⑥ 所在地の「同じ区を2回」も記録の数え方か確かめる");
{
  /**
   * ⚠ 実測: 同じ区を click で2回押した記録が 88件あった。
   *   これも「クリック →（チェックが入る）→ change」の対なら畳むべき。
   *   ただし区はチェックボックスなので、**人が外そうとして押し直す**事もある。
   *   → 畳むのは**同じ欄が 1200ms 以内**の時だけ（それ以上は押し直しとして残す）。
   */
  const ward = [
    { t: 0, k: "click", f: "左の大阪市都島区｜label.one_city" },
    { t: 900, k: "change", f: "左の大阪市都島区｜label.one_city" },
  ];
  const out = collapseSameField(ward);
  ok("  ⚠ 区の click→change も1回に畳む", out.length === 1, out.length);
  const uncheck = [
    { t: 0, k: "click", f: "左の大阪市都島区｜label.one_city" },
    { t: 900, k: "change", f: "左の大阪市都島区｜label.one_city" },
    { t: 4000, k: "click", f: "左の大阪市都島区｜label.one_city" },  // 4秒後＝外した（本物）
  ];
  const out2 = collapseSameField(uncheck);
  ok("  ⚠ 4秒後の押し直しは残す（外した証拠）", out2.length === 2, out2.length);
}

console.log("\n■ ⑦ 構文");
{
  let okc = true;
  try { execFileSync(process.execPath, ["--check", path.join(dir, "chrome-extension", "page-script.js")], { stdio: "pipe" }); }
  catch { okc = false; }
  ok("  page-script.js の構文が通る", okc);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
