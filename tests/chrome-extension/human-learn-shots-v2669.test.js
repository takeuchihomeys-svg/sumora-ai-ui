// 実行: node tests/chrome-extension/human-learn-shots-v2669.test.js
// 2026-11-11 竹内さん「画面の動き方もちゃんと把握できているのかな録画のような形で」
//   → 「操作のたびに1枚」を選ばれた。録画のように並べられる形で残す。
//   ① 操作のたびに撮る（クリック・入力・選択・スクロールの後）
//   ② 間引く（連打で何十枚も撮らない・撮っている最中は重ねない）
//   ③ まとまり（run_id）＋連番で並べると流れになる
//   ④ 写真の中身は DB に送らない（Storage 内・名前だけ）
//   ⑤ 一覧を取れる（何枚・どのまとまり・どの操作の後か）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const L = require(path.join(dir, "human-learn.js"));
const rec = read("human-learn-record.js"), bg = read("background.js"), hl = read("human-learn.js"), up = read("human-learn-upload.js");

console.log("■ ① 操作のたびに撮る（onOp の口）");
{
  // 実際にイベントを流して onOp が呼ばれるか
  const ls = { doc: {}, win: {} };
  const doc = { addEventListener: (t, fn) => { (ls.doc[t] = ls.doc[t] || []).push(fn); }, removeEventListener() {}, documentElement: { scrollHeight: 3000 } };
  const win = { innerWidth: 1200, innerHeight: 800, pageYOffset: 0, addEventListener: (t, fn) => { (ls.win[t] = ls.win[t] || []).push(fn); }, removeEventListener() {} };
  const calls = [];
  let t = 1000;
  const rec2 = L.create({ now: () => t, doc, win, onOp: (kind, el, pt) => calls.push({ kind, pt }) });
  rec2.attach(doc, win);
  const fire = (list, ev) => (list || []).forEach((f) => f(ev));
  const el = (n) => ({ tagName: "INPUT", getAttribute: (a) => (a === "name" ? n : null), getBoundingClientRect: () => ({ left: 100, top: 100, width: 100, height: 30 }) });

  fire(ls.doc.click, { isTrusted: true, target: el("update_date"), clientX: 130, clientY: 115 });
  t += 500;
  fire(ls.doc.change, { isTrusted: true, target: el("update_date"), clientX: 130, clientY: 115 });
  t += 500;
  fire(ls.doc.keydown, { isTrusted: true, target: el("rental_cost2"), key: "8" });
  t += 500;
  fire(ls.win.wheel, { isTrusted: true, deltaY: 300 });
  t += 500;

  ok("クリックの後に撮る合図が出る", calls.some((c) => c.kind === "click"));
  ok("選択（change）の後に撮る合図が出る", calls.some((c) => c.kind === "change"));
  ok("キーの後に撮る合図が出る", calls.some((c) => c.kind === "keydown"));
  ok("スクロールの後に撮る合図が出る", calls.some((c) => c.kind === "wheel"));
  ok("押した座標も渡す", calls.some((c) => c.pt && c.pt.x === 130));
  ok("拡張の操作では撮らない（isTrusted=false）", (() => {
    const before = calls.length;
    fire(ls.doc.click, { isTrusted: false, target: el("x"), clientX: 1, clientY: 1 });
    return calls.length === before;
  })());

  // 記録する側が onOp を渡している
  ok("記録する側が onOp を渡している", /onOp: function \(kind, el, pt\) \{ shootAfter\(kind, el, pt\); \}/.test(rec));
  ok("background に送る時、何の操作か・どの欄かを渡す", /kind: kind,/.test(rec) && /what: el \?/.test(rec));
}

console.log("\n■ ② 間引く（撮りすぎない）");
{
  ok("最短 400ms はあける（記録側）", /SHOT_MIN_GAP_MS = 400/.test(rec));
  ok("撮っている最中は重ねない（3秒で解く）", /if \(_shotPending && now - _shotPendingAt < 3000\) return;/.test(rec) && /_shotPending = true;/.test(rec));
  ok("応答が返らない時に張り付かない（タイムアウトで解く）", /if \(_shotPending\) \{ _shotPending = false; diag\(false, "timeout_stuck"\); \}/.test(rec));
  ok("1ページの上限がある（暴走しない）", /SHOT_MAX_PER_SESSION = 300/.test(rec) && /_shotCount >= SHOT_MAX_PER_SESSION/.test(rec));
  ok("background でも 350ms はあける（二重の歯止め）", /MIN_GAP_MS = 350/.test(bg) && /too_soon/.test(bg));
  ok("間引かれた操作では写真を撮らない", /if \(added && onOp\)/.test(hl));
}

console.log("\n■ ③ まとまり（run_id）＋連番で並べる");
{
  ok("run_id と連番を持つ", /_shotRun/.test(bg) && /_shotSeq/.test(bg));
  ok("名前が「まとまり＋連番」（並べ替えると流れになる）", /"shot_" \+ _shotRun \+ "_" \+ String\(_shotSeq\)\.padStart\(4, "0"\)/.test(bg));
  /**
   * 2026-11-14 竹内さん「連続して画像をみたらアニメーションのように動き理解できる」:
   *   ⚠ 旧は `t0 - _shotLastAt > 10分` を**撮影のたびに**見ていたので、
   *     同時に走る撮影要求がそれぞれ新しいまとまりを作っていた（実測: 1秒ごとに run_id が変わる）。
   *   → 判定を `_shotRunFor`（保存した時刻を見る・同時実行を1つにする）に移した。
   */
  ok("10分あいたら新しいまとまり（_shotRunFor で判定・保存した時刻を見る）",
    /SHOT_RUN_GAP_MS = 10 \* 60 \* 1000/.test(bg) && /t - saved\.at <= SHOT_RUN_GAP_MS/.test(bg));
  ok("写真に seq・run_id・kind・what・x・y を持たせる", /seq: _shotSeq, run_id: _shotRun/.test(bg) && /kind: typeof msg\.kind/.test(bg) && /what: typeof msg\.what/.test(bg));
  ok("撮った物を Storage に置く（DB ではない）", /await chrome\.storage\.local\.set\(o\)/.test(bg));
  ok("全体の上限で古い物から消す（2026-11-12: 枚数ではなく**容量**で守る）", /SHOT_LOCAL_MAX_BYTES/.test(bg) && /SHOT_LOCAL_MAX_COUNT/.test(bg) && /b\.at - a\.at/.test(bg));
}

console.log("\n■ ④ 写真の中身は DB に送らない");
{
  ok("送るのは「撮った・名前」だけ（画像の中身は送らない）", (() => {
    const i = up.indexOf("chrome.runtime.sendMessage");
    const seg = up.slice(i, i + 500).replace(/\s+/g, " ");
    return /shot_taken/.test(seg) && /shot_key/.test(seg) && !/data:/.test(seg);
  })());
  ok("画像そのもの（data）は送らない", !/data: .*\.data/.test(up) && !/shot_b64/.test(up));
  ok("API 側も画像を受け取らない（捨てる）", fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "human-motion", "route.ts"), "utf8").includes("delete row.shot_b64"));
}

console.log("\n■ ⑤ 一覧を見られる（何枚・どのまとまり）");
{
  ok("一覧の受け口がある（axlx-human-shots-list）", /type === "axlx-human-shots-list"/.test(bg));
  ok("まとまりごとに要約する（枚数・時間・操作の種類）", /runs: Object\.keys\(runs\)\.map/.test(bg) && /kinds: \{\}/.test(bg));
  ok("中身（画像）は頼まれた時だけ返す（軽い）", /if \(msg\.with_data\) item\.data = v\.data;/.test(bg));
  ok("1つのまとまりだけ絞れる", /wantRun/.test(bg));
  ok("run_id でまとまりを絞れる（連番で並ぶ）", /keys = Object\.keys\(all\)\.filter\(function \(k\) \{ return k\.indexOf\("shot_"\) === 0; \}\)\.sort\(\)/.test(bg) && /wantRun && v\.run_id !== wantRun/.test(bg));
}

console.log("\n■ ⑥ 写真を撮る条件（安全側）");
{
  ok("<all_urls> の許可が無ければ撮らない", /no_permission/.test(bg));
  ok("見えているタブだけ撮る", /chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\)/.test(bg));
  ok("撮れなくても学習は止めない（理由を返すだけ）", /no_image/.test(bg) && /no_tab/.test(bg));
  ok("1枚撮る時間を返す（重さが分かる）", /ms: Date\.now\(\) - t0/.test(bg));
  ok("画質を落として軽くする（55）", /quality: 55/.test(bg));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
