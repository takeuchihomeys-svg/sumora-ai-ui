// 実行: node tests/chrome-extension/human-wait.test.js
// 拡張の待ち時間のばらつき（chrome-extension/human-wait.js・v2.5.29）を固定する。
// 2026-09-27 竹内「拡張ツールで物件検索を押してから並び替えを変える所、毎回一定の時間になっているか？
//   なっていたら全て不規則にする（時間ランダム）。拡張ツールは人間らしい動きをするために全て時間ランダムにする」
//
// ① 関数の範囲（人の間 0.8〜1.5倍・小さい値の下限・大きい値の上の幅・落ち着く待ちは元より短くしない・見る間隔は平均が同じ）
// ② 読み込みの配線（manifest・background の import・popup.html の順・ページの中へ入れる順）
// ③ 置き換え漏れ（固定の数字の setTimeout / sleep を数え、残してよい物の表と一字一句同じ件数か）
// ④ 検索 → 並び替えの間・5大バグの型（状態の記憶・止めた時・前後の入れ替わり）
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const HW = require("../../chrome-extension/human-wait.js");

const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || !detail ? "" : "\n      " + detail)); }
function eq(name, a, b) { const c = JSON.stringify(a) === JSON.stringify(b); ok(name, c, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// 決まった乱数（再現できるように）
function seeded(seed) { let s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function sample(fn, base, n, seed) {
  const rng = seeded(seed || 7); const xs = [];
  for (let i = 0; i < n; i++) xs.push(fn(base, rng));
  const min = Math.min(...xs), max = Math.max(...xs), mean = xs.reduce((a, b) => a + b, 0) / n;
  return { min, max, mean, distinct: new Set(xs).size };
}

console.log("\n■ ① 人の操作の間 humanDelay（base×0.8〜1.5）");
for (const b of [100, 200, 300, 500, 800, 900, 1000, 1500, 2000]) {
  const r = HW.humanRange(b);
  eq(`${b}ms の幅 = ${b * 0.8}〜${b * 1.5}`, [r.lo, r.hi], [b * 0.8, b * 1.5]);
  const s = sample(HW.humanDelay, b, 5000, b);
  ok(`${b}ms: 5000回が幅の中（${s.min}〜${s.max}）`, s.min >= Math.floor(r.lo) && s.max <= Math.ceil(r.hi));
  ok(`${b}ms: 毎回ちがう（${s.distinct}通り）`, s.distinct >= Math.min(20, r.hi - r.lo));
  ok(`${b}ms: 平均は元の 1.1〜1.2倍（${(s.mean / b).toFixed(3)}）`, s.mean / b > 1.1 && s.mean / b < 1.2);
}
eq("端: 乱数 0 → 下の端", HW.humanDelay(1000, () => 0), 800);
eq("端: 乱数 0.9999… → 上の端", HW.humanDelay(1000, () => 0.9999999), 1500);
eq("乱数が 1 を返しても上の端を超えない", HW.humanDelay(1000, () => 1), 1500);
eq("乱数が NaN でも下の端", HW.humanDelay(1000, () => NaN), 800);

console.log("\n■ 小さい値は下限（50ms 以下は元より短くしない）");
eq("30ms → 30〜45", [HW.humanRange(30).lo, HW.humanRange(30).hi], [30, 45]);
eq("50ms → 50〜75", [HW.humanRange(50).lo, HW.humanRange(50).hi], [50, 75]);
eq("60ms → 50〜90（0.8倍の 48 より下限 50 が上）", [HW.humanRange(60).lo, HW.humanRange(60).hi], [50, 90]);
ok("小さい値の 5000回が下限を下回らない", sample(HW.humanDelay, 40, 5000).min >= 40);

console.log("\n■ 大きい値は上の幅を狭める（2秒を超えたら min(0.5倍, 1秒+0.1倍)）");
eq("3000ms → 2400〜4300", [HW.humanRange(3000).lo, HW.humanRange(3000).hi], [2400, 4300]);
eq("5000ms → 4000〜6500", [HW.humanRange(5000).lo, HW.humanRange(5000).hi], [4000, 6500]);
eq("10000ms → 8000〜12000", [HW.humanRange(10000).lo, HW.humanRange(10000).hi], [8000, 12000]);
ok("10000ms の平均は元とほぼ同じ（1.0倍）", Math.abs(sample(HW.humanDelay, 10000, 5000).mean / 10000 - 1.0) < 0.02);

console.log("\n■ 0・負・数でない値は 0（待たない＝今までの setTimeout(fn, 0) と同じ）");
for (const v of [0, -5, NaN, undefined, null, "abc"]) eq(`humanDelay(${String(v)}) = 0`, HW.humanDelay(v), 0);
eq("文字の数字は読む", HW.humanRange("1000"), { lo: 800, hi: 1500 });

console.log("\n■ 画面が落ち着く待ち settleDelay（元より短くしない）");
for (const b of [200, 300, 500, 600, 800, 1000, 1500, 2000, 2500]) {
  const s = sample(HW.settleDelay, b, 3000, b + 1);
  ok(`${b}ms: 最小 ${s.min} ≧ 元（短くしない）`, s.min >= b);
  ok(`${b}ms: 最大 ${s.max} ≦ ${Math.ceil(HW.settleRange(b).hi)}`, s.max <= Math.ceil(HW.settleRange(b).hi));
  ok(`${b}ms: 毎回ちがう`, s.distinct > 20);
}
eq("1000ms → 1000〜1350", [HW.settleRange(1000).lo, HW.settleRange(1000).hi], [1000, 1350]);
eq("2500ms → 2500〜3375", [HW.settleRange(2500).lo, HW.settleRange(2500).hi], [2500, 3375]);

console.log("\n■ 条件を見る間隔 pollDelay（±15%・平均は元と同じ＝回数で打ち切る待ちの長さを変えない）");
for (const b of [100, 150, 200, 250, 400, 500]) {
  const s = sample(HW.pollDelay, b, 5000, b + 2);
  ok(`${b}ms: ${s.min}〜${s.max} が ${b * 0.85}〜${b * 1.15} の中`, s.min >= Math.floor(b * 0.85) && s.max <= Math.ceil(b * 1.15));
  ok(`${b}ms: 平均 ${(s.mean / b).toFixed(3)} 倍（0.98〜1.02）`, Math.abs(s.mean / b - 1) < 0.02);
}
// 回数で打ち切る待ち（500ms × 12回 = 6秒）の合計: 平均は同じ・最長でも 6.9秒
{
  const rng = seeded(11); let worst = 0, sum = 0; const N = 2000;
  for (let k = 0; k < N; k++) { let t = 0; for (let i = 0; i < 12; i++) t += HW.pollDelay(500, rng); worst = Math.max(worst, t); sum += t; }
  ok(`500ms×12回の合計の平均 ${Math.round(sum / N)}ms ≒ 6000ms`, Math.abs(sum / N - 6000) < 60);
  ok(`500ms×12回の合計の最長 ${worst}ms ≦ 6900ms`, worst <= 6900);
}

console.log("\n■ Promise 版（async の中で使う）");
(async () => {
  const t0 = Date.now(); await HW.humanWait(20); const dt = Date.now() - t0;
  ok(`humanWait(20) が待つ（${dt}ms）`, dt >= 15);
  const t1 = Date.now(); await HW.settleWait(20); ok("settleWait(20) が待つ", Date.now() - t1 >= 15);
  const t2 = Date.now(); await HW.pollWait(20); ok("pollWait(20) が待つ", Date.now() - t2 >= 10);
  rest();
})();

function rest() {
  console.log("\n■ ページの中（module の無い所）でも self.AxlxHumanWait が付く");
  {
    const win = {}; win.self = win; win.window = win;
    vm.runInNewContext(read("human-wait.js"), win);
    ok("ページの中: window.AxlxHumanWait.humanDelay がある", typeof win.AxlxHumanWait?.humanDelay === "function");
    ok("ページの中: 値が幅の中", (() => { const v = win.AxlxHumanWait.humanDelay(1000); return v >= 800 && v <= 1500; })());
    const sw = {}; sw.self = sw; // service worker（window が無い）
    vm.runInNewContext(read("human-wait.js"), sw);
    ok("service worker（window なし）: self.AxlxHumanWait がある", typeof sw.AxlxHumanWait?.settleDelay === "function");
  }

  console.log("\n■ ② 読み込みの配線");
  const manifest = JSON.parse(read("manifest.json"));
  eq("manifest の版 2.5.29", manifest.version, "2.5.29");
  const cs = manifest.content_scripts;
  const first = cs[0];
  eq("先頭の段（document_start・3サイト）が human-wait.js → search-audit.js の順", first.js, ["human-wait.js", "search-audit.js"]);
  eq("先頭の段は document_start（後の段の content script より先に読む）", first.run_at, "document_start");
  for (const site of ["https://www.realnetpro.com/*", "https://realnetpro.com/*", "https://itandibb.com/*", "https://system.reins.jp/*"]) {
    ok(`先頭の段が ${site} を含む`, first.matches.includes(site));
  }
  // human-wait を使う content script が全部、先頭の段の matches に入っている
  const users = cs.filter((c) => c.world !== "MAIN" && c.js.some((f) => /AxlxHumanWait/.test(read(f))));
  for (const c of users) for (const m of c.matches) {
    const covered = first.matches.some((fm) => fm === m || (fm.endsWith("/*") && m.startsWith(fm.slice(0, -1))));
    ok(`${c.js.join(",")} の ${m} は先頭の段で読まれる`, covered);
  }
  const mainWorld = cs.find((c) => c.world === "MAIN" && c.js.includes("itandi-page-script.js"));
  eq("itandi のページの中の段: human-wait.js → itandi-page-script.js（同じ world:MAIN）", mainWorld && mainWorld.js, ["human-wait.js", "itandi-page-script.js"]);
  const war = manifest.web_accessible_resources[0];
  ok("web_accessible_resources に human-wait.js（リアプロ・レインズのページへ <script> で入れる）", war.resources.includes("human-wait.js"));
  ok("web_accessible_resources の対象にリアプロとレインズ", war.matches.some((m) => /realnetpro/.test(m)) && war.matches.some((m) => /reins/.test(m)));
  ok("background.js が human-wait.js を import", /^import "\.\/human-wait\.js";/m.test(read("background.js")));
  const html = read("popup.html");
  const iHw = html.indexOf('<script src="human-wait.js">'), iPop = html.indexOf('<script src="popup.js">');
  ok("popup.html: human-wait.js が popup.js より前", iHw > 0 && iHw < iPop);
  for (const [f, page] of [["content.js", "page-script.js"], ["reins-content.js", "reins-page-script.js"]]) {
    const src = read(f);
    const a = src.indexOf('getURL("human-wait.js")'), b = src.indexOf(`getURL("${page}")`);
    ok(`${f}: human-wait.js を ${page} より先に入れる`, a > 0 && a < b);
    ok(`${f}: 2つとも async=false（入れた順に動く）`, (src.slice(a - 200, b + 100).match(/\.async = false/g) || []).length >= 2);
  }
  for (const f of ["page-script.js", "reins-page-script.js", "itandi-page-script.js"]) {
    ok(`${f}: 読めない時は元の値（予備あり）`, /return H \? H\.\w+Delay\(ms\) : ms;/.test(read(f)) && /AxlxHumanWait/.test(read(f)));
  }

  console.log("\n■ ③ 置き換え漏れ — 固定の数字の setTimeout / setInterval / sleep を数える");
  // 残してよい物（人の操作の間ではない）: タイムアウトの上限・見張り・サーバーの待ち・画面の表示を消す・
  //   setInterval の見る間隔・checkbox を差し込む内部の間引き・起動時の読み込み待ち。
  // ここに無い固定の数字が増えたら落ちる（人の操作の間なら human-wait を通す／残すならここに理由を書いて足す）。
  const KEEP = {
    "background.js": {
      "setTimeout 35000": [2, "レインズの新タブの見張りの期限"], "setTimeout 500": [1, "タブが既に読み込み済みかの予備の確認"],
      "setTimeout 1000": [1, "PDF のアップロードのやり直し（サーバー）"], "setInterval 25000": [1, "Supabase Realtime の心拍"],
      "setTimeout 8000": [1, "Realtime の再接続"], "setTimeout 15000": [2, "Realtime の再接続・タブ読み込みの期限"],
      "setTimeout 6000": [1, "取得の期限（abort）"], "setInterval 500": [2, "止める合図の見張り（ページを触らない）"],
      "setTimeout 10000": [1, "バッジを消す"],
    },
    "bulk-dl.js": {
      "setTimeout 200": [1, "checkbox の差し込みのやり直し（内部）"], "setTimeout 35000": [1, "判定の応答の期限（fail-open）"],
      "setTimeout 2500": [2, "表示を戻す・Case C の予備の起動（Case A/B の後ろの安全網）"], "setTimeout 800": [1, "popup の応答の期限"],
      "setTimeout 5000": [1, "表示を戻す"], "setTimeout 100": [2, "ダウンロードのリンクを消す"], "setTimeout 4000": [1, "表示を戻す"],
      "setInterval 200": [1, "描画待ちの見る間隔（4秒で打ち切り）"], "setTimeout 50": [1, "fill-done 後の差し込みのやり直し（内部）"],
      "setTimeout 2000": [2, "新しい結果が出たかの予備の確認・load 後の差し込み"], "setInterval 1000": [1, "0件の確定の見る間隔（25秒で打ち切り）"],
      "setTimeout 400": [1, "MutationObserver の間引き"], "setTimeout 1200": [1, "起動時の差し込み"],
    },
    "content.js": { "setTimeout 400": [1, "MutationObserver の間引き"], "setInterval 3000": [1, "サイドバーの見張り"], "setTimeout 300": [1, "起動時"] },
    "itandi-bulk-dl.js": {
      "setTimeout 60000": [1, "PDF の期限"], "setInterval 500": [1, "モーダルが出たかの見る間隔"], "setTimeout 15000": [1, "モーダルの期限"],
      "setTimeout 800": [1, "popup の応答の期限"], "setTimeout 5000": [1, "表示を戻す"], "setInterval 1000": [1, "0件の確定の見る間隔"],
    },
    "itandi-content.js": { "setTimeout 300": [1, "起動時"] },
    "itandi-page-script.js": {
      "setInterval 100": [2, "モーダルが消えた・間取りの欄が出たかの見る間隔（3秒で打ち切り）"], "setTimeout 240000": [1, "見張り（fill-done の保証）"],
      "setTimeout 5000": [1, "警告の表示を消す"], "setTimeout 500": [1, "検索を押した後の完了の合図（ページを触らない）"],
    },
    "page-script.js": { "setTimeout 15000": [1, "警告の表示を消す"], "setTimeout 85000": [1, "見張り（fill-done の保証）"], "setTimeout 0": [1, "同じ流れの続き"] },
    "popup.js": {
      "setTimeout 6000": [1, "取得の期限"], "setTimeout 3000": [4, "取得のやり直し・表示を戻す"], "setTimeout 10000": [1, "取得の期限"],
      "setTimeout 15000": [1, "取得の期限"], "setTimeout 4000": [1, "表示を消す"], "setTimeout 1800": [1, "表示を戻す"], "setTimeout 2000": [1, "表示を戻す"],
      "setTimeout 800": [1, "一時調整の保存の間引き"], "setTimeout 8000": [1, "表示を戻す"], "setTimeout 20000": [1, "固まり防止の見張り"],
      "setTimeout 25000": [1, "固まり防止の見張り"], "setTimeout 1200": [1, "表示を閉じる"],
    },
    "reins-bulk-dl.js": {
      "setTimeout 100": [1, "表示の更新"], "setTimeout 800": [2, "popup の応答の期限・MutationObserver の間引き"], "setTimeout 5000": [1, "表示を戻す"],
      "setTimeout 60000": [1, "PDF の期限"], "setTimeout 15000": [1, "期限"], "setInterval 200": [1, "行が出たかの見る間隔"],
      "setTimeout 30000": [1, "期限"], "setInterval 300": [1, "見る間隔"], "setTimeout 50": [1, "表示の更新"], "setInterval 2000": [1, "見張り"],
    },
    "reins-content.js": { "setTimeout 300": [1, "起動時"] },
    "reins-page-script.js": { "setTimeout 90000": [1, "見張り（fill-done の保証）"] },
    "score-overlay.js": { "setTimeout 900": [1, "点数の表示の間引き"], "setTimeout 500": [1, "点数の表示"], "setTimeout 300": [1, "点数の表示"] },
    "underbar.js": { "setTimeout 80": [1, "パネルの表示"], "setTimeout 1500": [1, "拡張の再読み込み直後のやり直し"], "setTimeout 50": [1, "パネルの動き"] },
  };
  const found = scanFixed();
  const files = new Set([...Object.keys(found), ...Object.keys(KEEP)]);
  let totalFixed = 0;
  for (const f of [...files].sort()) {
    const got = found[f] || {};
    const want = {};
    for (const [k, [n]] of Object.entries(KEEP[f] || {})) want[k] = n;
    totalFixed += Object.values(got).reduce((a, b) => a + b, 0);
    eq(`${f}: 固定の数字の待ちは残してよい物だけ`, sortObj(got), sortObj(want));
  }
  console.log(`    （固定の数字の待ち 合計 ${totalFixed} 件＝全部 人の操作の間ではない物）`);

  console.log("\n■ 人の操作の間が human-wait を通っている（件数の下限）");
  const USE = { "background.js": 12, "bulk-dl.js": 6, "page-script.js": 9, "itandi-page-script.js": 15, "itandi-bulk-dl.js": 1, "reins-page-script.js": 11, "reins-bulk-dl.js": 7, "content.js": 3, "reins-content.js": 2, "underbar.js": 1, "popup.js": 2 };
  for (const [f, n] of Object.entries(USE)) {
    const src = read(f);
    const NAMES = "(_hd|_sd|_pd|_settleMs|_pollMs|_axContentHd|_axContentSd|_popupSd|_popupPd)";
    const calls = (src.match(new RegExp("\\b" + NAMES + "\\(", "g")) || []).length;
    const defs = (src.match(new RegExp("function " + NAMES + "\\(ms\\)", "g")) || []).length;
    const c = calls - defs; // 定義の行は数えない
    ok(`${f}: ばらつきの関数を ${n} か所以上で使う（${c}）`, c >= n);
  }

  console.log("\n■ ④ 検索 → 並び替え（リアプロ bulk-dl の AD 高→低）");
  const bulk = read("bulk-dl.js");
  const doStart = bulk.slice(bulk.indexOf("function _doStart("), bulk.indexOf("function _doStart(") + 3000);
  const iSet = doStart.indexOf("setAutoSendState(sortState)"), iFlag = doStart.indexOf("_pendingAutoSendDispatched = true"), iWait = doStart.indexOf("_hd(900)"), iNav = doStart.indexOf("location.href = _sortHref");
  ok("並び替えの前に人の間（_hd(900)＝0.72〜1.35秒）を置く", iWait > 0 && iNav > 0);
  ok("状態（sortState）は待つ前に書く（待つ間のリロードでも再開できる）", iSet > 0 && iSet < iWait);
  ok("待つ前に起動済みの印（Case B が並び替え前のページを送らない）", iFlag > iSet && iFlag < iWait);
  ok("待つ間に止められたら遷移しない（getAutoSendState を見る）", /if \(!getAutoSendState\(\)\)[^\n]*return;[\s\S]{0,40}location\.href = _sortHref/.test(doStart));
  ok("旧: すぐ遷移（location.href = adLink.href）が残っていない", !/location\.href = adLink\.href/.test(bulk));
  ok("検索の結果 → 自動送信の開始（固定 200ms）がばらつく", (bulk.match(/setTimeout\(autoSendAllPages, _hd\(200\)\)/g) || []).length === 2);
  ok("次のページへ（固定 800ms）がばらつく", (bulk.match(/tryNext\((state|_resumeState)\); \}, _hd\(800\)\)/g) || []).length === 2);
  const hr = HW.humanRange(900);
  console.log(`    並び替えの前の間: ${hr.lo}〜${hr.hi}ms（旧 0ms）`);

  console.log("\n■ 前後が入れ替わらない（itandi: ペットの欄を開く → 検索を押す）");
  const it = read("itandi-page-script.js");
  ok("ペットの欄の待ちは _sd(700)", /clickLabel\("ペット相談"\);\n\s*\}, _sd\(700\)\)/.test(it));
  ok("検索を押す待ちは _sd(1000)", /\}, _sd\(1000\)\); \/\/ 検索ボタンを押すまで/.test(it));
  ok(`ペットの最長 ${HW.settleRange(700).hi} < 検索の最短 ${HW.settleRange(1000).lo}`, HW.settleRange(700).hi < HW.settleRange(1000).lo);
  ok("itandi の残ったチップを消す間も毎回ちがう（旧 i*250 の等間隔）", !/i \* 250/.test(it) && /_chipAt \+= _hd\(250\)/.test(it));

  console.log("\n■ 5大バグの型に当たらない");
  ok("トグル: 並び替えはリンクへの遷移（クリックで切り替えない）", /location\.href = _sortHref/.test(doStart));
  ok("checked の判定・クリックの関数は変えていない（_clickIfUnchecked が残る）", /function _clickIfUnchecked\(el\) \{ if \(!el\.checked\) _clickEl\(el\); \}/.test(read("page-script.js")));
  ok("見張り（85秒・240秒・90秒）の長さは変えていない", /\}, 85000\);/.test(read("page-script.js")) && /\}, 240000\);/.test(it) && /90000/.test(read("reins-page-script.js")));
  ok("拡張の再読み込み: 版を上げた（2.5.29）", manifest.version === "2.5.29");

  console.log("\n■ 全ファイル node --check");
  const { execFileSync } = require("child_process");
  for (const f of fs.readdirSync(EXT).filter((x) => x.endsWith(".js"))) {
    let good = true; try { execFileSync(process.execPath, ["--check", path.join(EXT, f)], { stdio: "pipe" }); } catch (e) { good = false; }
    ok(`node --check ${f}`, good);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

function sortObj(o) { return Object.fromEntries(Object.entries(o).sort()); }

// 固定の数字（数字と + - * だけ）の遅れを持つ setTimeout / setInterval / sleep を file → {"setTimeout 500": 件数}
function scanFixed() {
  const SKIP = /^(transit_graph|build-transit-graph|osaka-transit|human-wait)\.js$/;
  const out = {};
  for (const f of fs.readdirSync(EXT).filter((x) => x.endsWith(".js") && !SKIP.test(x))) {
    const src = read(f);
    const re = /\b(setTimeout|setInterval|sleep)\s*\(/g; let m;
    while ((m = re.exec(src))) {
      if (/function\s*$/.test(src.slice(Math.max(0, m.index - 10), m.index))) continue;
      const args = splitArgs(src, m.index + m[0].length - 1);
      const d = m[1] === "sleep" ? args[0] : args[1];
      if (d === undefined) continue;
      const dt = d.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (!/^[\d\s*+\-]+$/.test(dt)) continue;
      const key = m[1] + " " + dt.replace(/\s+/g, " ");
      (out[f] = out[f] || {})[key] = ((out[f] || {})[key] || 0) + 1;
    }
  }
  return out;
}
function splitArgs(src, i) {
  let depth = 0, cur = i + 1, inStr = null; const args = [];
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (inStr) { if (c === "\\") { j++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "/" && src[j + 1] === "/") { j = src.indexOf("\n", j); if (j < 0) break; continue; }
    if (c === "/" && src[j + 1] === "*") { j = src.indexOf("*/", j) + 1; continue; }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") { depth--; if (depth === 0) { args.push(src.slice(cur, j)); return args; } }
    else if (c === "," && depth === 1) { args.push(src.slice(cur, j)); cur = j + 1; }
  }
  return args;
}
