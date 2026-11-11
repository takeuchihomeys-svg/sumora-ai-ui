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
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
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
  ok("manifest の版 2.5.29 以上", manifest.version.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0) >= 2005029);
  const cs = manifest.content_scripts;
  const first = cs[0];
  // v2.5.40: 画面の文字の受け口（snapshot-core.js）を後ろに足した（先頭の2つの順は変えない）
  eq("先頭の段（document_start・3サイト）が human-wait.js → human-trace.js → own-mutation.js → search-audit.js（→ snapshot-core.js）の順", first.js, ["human-wait.js", "human-learn.js", "pointer-ui.js", "human-trace.js", "own-mutation.js", "search-audit.js", "parallel-sites.js", "snapshot-core.js"]);
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
  // v2.5.34: 間に itandi-update-days.js（募集条件更新 N日以内・itandi-update-days.test.js）。human-wait.js が先頭なのは変えない
  eq("itandi のページの中の段: human-wait.js → itandi-update-days.js → itandi-page-script.js（同じ world:MAIN）", mainWorld && mainWorld.js, ["human-wait.js", "human-learn.js", "pointer-ui.js", "floor-ijou.js", "itandi-update-days.js", "itandi-form-guard.js", "itandi-page-script.js"]);
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
      "setTimeout 220": [1, "タブを前面にしてから撮る前の描画待ち（v2.6.79）"],
      "setTimeout 35000": [2, "レインズの新タブの見張りの期限"], "setTimeout 500": [1, "タブが既に読み込み済みかの予備の確認"],
      "setTimeout 1000": [1, "PDF のアップロードのやり直し（サーバー）"], "setInterval 25000": [1, "Supabase Realtime の心拍"],
      "setTimeout 8000": [1, "Realtime の再接続"], "setTimeout 15000": [2, "Realtime の再接続・タブ読み込みの期限"],
      "setTimeout 6000": [2, "取得の期限（abort）・送付済みの部屋の取得の期限（v2.5.41 _loadSentRooms・サイトを触らない）"], "setInterval 500": [2, "止める合図の見張り（ページを触らない）"],
      "setTimeout 10000": [1, "バッジを消す"], "setTimeout 1500": [2, "タブの応答の確かめの期限（v2.5.32 _probeRealproTab・v2.5.45 _probeItandiTab）"],
      "setTimeout 3000": [1, "画面の文字の応答の期限（v2.5.40 _snapDom・ページを触らない）"],
      "setTimeout 30000": [1, "リアプロの資料1件の取得の期限（v2.5.58 fetchRealproPdfsInTab・タブの中で取る・ログイン情報をサーバーに渡さない）"],
      "setTimeout 300000": [1, "送信の待ち行列の1件の上限（v2.6.26・超えたら次へ＝後の物件を止めない・サイトを触らない）"],
    },
    "bulk-dl.js": {
      "setTimeout 200": [1, "checkbox の差し込みのやり直し（内部）"], "setTimeout 250": [1, "枠をサイトの固定のボタンに重ねない見直しの間引き（v2.5.74・位置だけ）"], "setTimeout 35000": [1, "判定の応答の期限（fail-open）"],
      "setTimeout 2500": [2, "表示を戻す・Case C の予備の起動（Case A/B の後ろの安全網）"], "setTimeout 800": [1, "popup の応答の期限"],
      "setTimeout 5000": [1, "表示を戻す"], "setTimeout 100": [2, "ダウンロードのリンクを消す"], "setTimeout 4000": [1, "表示を戻す"],
      "setInterval 200": [1, "描画待ちの見る間隔（4秒で打ち切り）"], "setTimeout 50": [1, "fill-done 後の差し込みのやり直し（内部）"],
      "setTimeout 2000": [2, "新しい結果が出たかの予備の確認・load 後の差し込み"], "setTimeout 400": [2, "MutationObserver の間引き・1件送信前のチェック確認（v2.6.23）"], "setInterval 1000": [2, "0件の確定の見る間隔（25秒で打ち切り）・休憩等の「あと何秒」の表示更新（v2.6.52）"],
      "setTimeout 1200": [2, "起動時の差し込み・自動押下で押せない行を飛ばす待ち（v2.6.29）"],
      "setTimeout 20000": [1, "1件だけのブレイン判定の期限（v2.6.26・超えたら送る＝fail-open）"],
      "setTimeout 3000": [2, "「終わってから次を押してください」の知らせ（v2.6.28）・自動押下のカーソルが動けない時の予備の押下（v2.6.29）・サイトを触らない"],
      "setTimeout 500": [1, "自動押下で1件の処理が終わったかを見る間隔（v2.6.29・サイトを触らない）"], "setInterval 60000": [1, "次回の自動便の時刻の描き直し（v2.6.83・画面の文字だけ・サイトを触らない）"],
      "setTimeout 800": [3, "popup の応答の期限・自動押下で1件の処理の終わりを待ち始める（v2.6.29）・自動モードに切り替えた時に押し始める（v2.6.30）"],
      // 2026-11-10: 「押した印刷用PDFを20秒まとめて送る」はやめた（押した1件をその場で送る・sendOnePdfNow）
    },
    "content.js": { "setTimeout 400": [1, "MutationObserver の間引き"], "setInterval 3000": [1, "サイドバーの見張り"], "setTimeout 300": [1, "起動時"] },
    // 2026-11-10 v2.6.23 見えるカーソル: 90ms は「押した時の見た目の縮みを戻す」だけ（サイトを触らない・固定でよい）
    "pointer-ui.js": { "setTimeout 90": [1, "押した時にカーソルが縮むのを戻す（見た目だけ）"], "setTimeout 130": [1, "押した後に指先がわずかに動く（v2.6.56・見た目だけ・サイトを触らない）"] },
    "itandi-bulk-dl.js": {
      "setTimeout 60000": [1, "PDF の期限"], "setInterval 500": [1, "モーダルが出たかの見る間隔"], "setTimeout 15000": [1, "モーダルの期限"],
      "setTimeout 800": [1, "popup の応答の期限"], "setTimeout 5000": [1, "表示を戻す"], "setInterval 1000": [2, "0件の確定の見る間隔・休憩等の「あと何秒」の表示更新（v2.6.52）"],
      "setTimeout 300": [1, "見えないタブから戻った時にボタンを1回探す（v2.5.73・読むだけ）"], "setTimeout 250": [1, "枠をサイトの固定のボタンに重ねない見直しの間引き（v2.5.74・位置だけ）"], "setInterval 10000": [1, "重さの数え（localStorage axlx_perf=1 の時だけ・v2.5.73）"],
    },
    "itandi-content.js": { "setTimeout 300": [1, "起動時"] },
    "itandi-page-script.js": {
      "setInterval 100": [2, "モーダルが消えた・間取りの欄が出たかの見る間隔（3秒で打ち切り）"], "setTimeout 240000": [1, "見張り（fill-done の保証）"],
      "setTimeout 5000": [1, "警告の表示を消す"], "setTimeout 500": [1, "検索を押した後の完了の合図（ページを触らない）"],
    },
    "page-script.js": { "setTimeout 15000": [1, "警告の表示を消す"], "setTimeout 895000": [1, "見張り（fill-done の保証）"], "setInterval 5000": [1, "180秒 操作が進まない時の見張り（v2.6.23）"], "setTimeout 0": [1, "同じ流れの続き"], "setInterval 3000": [1, "クリックの列が20秒固まったかの見張り（v2.6.23）"], "setTimeout 4000": [1, "住居ボタンを押した後に検索の欄が出たかの再確認（v2.6.23）"], "setTimeout 2500": [1, "住居検索を押しても移らない時の href での移動（v2.6.23）"], "setTimeout 500": [1, "検索を押した後にカーソルの居た所を点検へ残す（v2.6.63・読むだけ）"], "setTimeout 200": [1, "欄を開いたか見る間隔（v2.6.83・案内モードと同じ「＋を押して開く」）"], "setTimeout 150": [1, "欄を開いた後の見直しの間（v2.6.83）"] },
    "popup.js": {
      "setTimeout 6000": [1, "取得の期限"], "setTimeout 3000": [4, "取得のやり直し・表示を戻す"], "setTimeout 10000": [1, "取得の期限"],
      "setTimeout 15000": [1, "取得の期限"], "setTimeout 4000": [1, "表示を消す"], "setTimeout 1800": [1, "表示を戻す"], "setTimeout 2000": [1, "表示を戻す"],
      "setTimeout 800": [1, "一時調整の保存の間引き"], "setTimeout 8000": [1, "表示を戻す"], "setTimeout 20000": [1, "固まり防止の見張り"],
      "setTimeout 25000": [1, "固まり防止の見張り"], "setTimeout 1200": [1, "表示を閉じる"],
      "setTimeout 100": [1, "会話から押されたお客様を開く前に一覧が出るのを待つ見る間隔（v2.5.86・5秒で打ち切り・サイトを触らない）"], "setTimeout 0": [1, "検索モードのボタンを繋ぐ（v2.6.23・DOM の後）"],
      "setTimeout 150": [1, "開いた時に一覧が出るのを待つ見る間隔（v2.5.86・8秒で打ち切り・サイトを触らない）"],
      "setInterval 45000": [1, "スマホ等で押された「一番上へ」の印の軽い取り直し（v2.5.86・見えている時だけ・サーバーを読むだけ）"],
      "setInterval 60000": [1, "次回の自動便の時刻の描き直し（v2.6.83・画面の文字だけ・サイトを触らない）"],
    },
    "reins-bulk-dl.js": {
      "setTimeout 100": [1, "表示の更新"], "setTimeout 800": [2, "popup の応答の期限・MutationObserver の間引き"], "setTimeout 5000": [1, "表示を戻す"],
      "setTimeout 60000": [1, "PDF の期限"], "setTimeout 15000": [1, "期限"], "setInterval 200": [1, "行が出たかの見る間隔"],
      "setTimeout 30000": [1, "期限"], "setInterval 300": [1, "見る間隔"], "setTimeout 50": [1, "表示の更新"], "setInterval 2000": [1, "見張り"],
    },
    "realpro-guide.js": { "setInterval 400": [1, "案内の光を見直す間隔（v2.5.58・画面を読むだけ・サイトを触らない）"], "setTimeout 300": [1, "送付済みの行の隠し直しの間引き"], "setTimeout 2500": [2, "一覧の行が描かれるのを待つ（bulk-dl が読み込み＋2秒で行を読む・v2.5.71）"], "setTimeout 120": [1, "小窓が閉じた等の画面の変化の後に光を見直す間引き（v2.5.71・読むだけ）"], "setInterval 10000": [1, "重さの数え（localStorage axlx_perf=1 の時だけ・コンソールに出す・v2.5.72）"] },
    "itandi-guide.js": { "setInterval 400": [1, "ITANDI の案内の光を見直す間隔（v2.5.63・画面を読むだけ・サイトを触らない・v2.5.73 から変化が無ければ 1.5秒に1回）"], "setTimeout 120": [1, "画面の変化の後に光を見直す間引き（v2.5.73・読むだけ）"], "setInterval 10000": [1, "重さの数え（localStorage axlx_perf=1 の時だけ・v2.5.73）"] },
    "reins-content.js": { "setTimeout 300": [1, "起動時"] },
    // 2026-11-11 竹内さん「写真ちゃんと取れているか」: 写真テストで、クラウドに上がったかを見る間（読むだけ・サイトを触らない）
    "snapshot-popup.js": { "setTimeout 2500": [1, "写真テストの結果（クラウドに上がったか）を待つ（v2.6.83）"] },
    "reins-page-script.js": { "setTimeout 90000": [1, "見張り（fill-done の保証）"] },
    "score-overlay.js": { "setTimeout 900": [1, "点数の表示の間引き"], "setTimeout 500": [1, "点数の表示"], "setTimeout 300": [1, "点数の表示"] },
    "underbar.js": { "setTimeout 12000": [1, "会話から押されたお客様を開いた popup の答えの期限（v2.5.86・サイトを触らない）"], "setTimeout 80": [1, "パネルの表示"], "setTimeout 1500": [2, "拡張の再読み込み直後のやり直し・案内の記録の返事が来ない時の予備（v2.5.90・読むだけでサイトを触らない）"], "setTimeout 50": [1, "パネルの動き"] },
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
  // 2026-11-10: bulk-dl.js は旧の一括（_hd/_sd を大量に使っていた）を消し、新しい自動押下は logNormalDelay を使う。
  //   使う数の下限を 0 にし（bulk-dl は logNormalDelay・humanDelay を直接使う）、下の別の項目で新しい待ちを確かめる
  const USE = { "background.js": 12, "bulk-dl.js": 0, "page-script.js": 9, "itandi-page-script.js": 15, "itandi-bulk-dl.js": 1, "reins-page-script.js": 11, "reins-bulk-dl.js": 7, "content.js": 3, "reins-content.js": 2, "underbar.js": 1, "popup.js": 2 };
  for (const [f, n] of Object.entries(USE)) {
    const src = read(f);
    const NAMES = "(_hd|_sd|_pd|_settleMs|_pollMs|_axContentHd|_axContentSd|_popupSd|_popupPd)";
    const calls = (src.match(new RegExp("\\b" + NAMES + "\\(", "g")) || []).length;
    const defs = (src.match(new RegExp("function " + NAMES + "\\(ms\\)", "g")) || []).length;
    const c = calls - defs; // 定義の行は数えない
    ok(`${f}: ばらつきの関数を ${n} か所以上で使う（${c}）`, c >= n);
  }

  // 2026-11-10: 旧の一括を消したので、ばらつきの関数の使用数の下限を下げる（新しい自動押下は logNormalDelay）
  { const src = read("bulk-dl.js");
    const NAMES = "(?:_hd|_sd)";
    const calls = (src.match(new RegExp("\\b" + NAMES + "\\(", "g")) || []).length;
    const defs = (src.match(new RegExp("function " + NAMES + "\\(ms\\)", "g")) || []).length;
    const c = calls - defs;
    ok(`bulk-dl.js: 人の間（AxlxHumanWait・logNormalDelay）を使う`, /logNormalDelay/.test(src)); }
  console.log("\n■ ④ 検索 → 自動の押下（旧の一括は 2026-11-10 に消した）");
  const bulk = read("bulk-dl.js");
  //   いまは「印刷用PDFを1件ずつ押して送る」だけ（自動モードなら自動で押す）。
  ok("旧の一括の並び替え（_doStart）は残っていない（AD は新しい押下の前に戻した）", !/function _doStart\(/.test(bulk) && !/location\.href = adLink\.href/.test(bulk));
  ok("AD 高い順への並べ替えは自動の押下の前にある", /function autoPressPdfs\(\)[\s\S]{0,2600}location\.href = _adLink\.href/.test(bulk));
  ok("旧の一括の入口は安全弁（呼ばれても全件送らない）", /旧の全ページ送る（autoSendAllPages）は使いません/.test(bulk));
  ok("旧のページ送りの続きは捨てる（二重に送らない）", /clearAutoSendState\(\); \/\/ 旧のページ送りの続きは捨てる/.test(bulk));
  ok("自動の押下は人の間（logNormalDelay）を通す", /logNormalDelay\(3500, 0\.4\)/.test(bulk) && /logNormalDelay\(1000, 0\.4\)/.test(bulk));
  ok("自動の押下は案内モードでは始めない", /_guideBlocksAuto\("autoOnLoad"\)/.test(bulk) && /_guideBlocksAuto\("autoPressPdfs"\)/.test(bulk));

  console.log("\n■ 前後が入れ替わらない（itandi: ペットの欄を開く → 検索を押す）");
  const it = read("itandi-page-script.js");
  ok("ペットの欄の待ちは _sd(700)", /clickLabel\("ペット相談"\);\n\s*\}, _sd\(700\)\)/.test(it));
  ok("検索を押す待ちは _sd(1000)", /\}, _sd\(1000\)\); \/\/ 検索ボタンを押すまで/.test(it));
  ok(`ペットの最長 ${HW.settleRange(700).hi} < 検索の最短 ${HW.settleRange(1000).lo}`, HW.settleRange(700).hi < HW.settleRange(1000).lo);
  // v2.5.46: 前の条件は1つずつ外す（外すたびに人の間 _hd(RESET_STEP_MS)＝毎回ちがう・等間隔でない）
  ok("itandi の前の条件を外す間も毎回ちがう（旧 i*250 の等間隔）", !/i \* 250/.test(it) && /setTimeout\(next, _hd\(FG\.RESET_STEP_MS\)\)/.test(it));

  console.log("\n■ 5大バグの型に当たらない");
  ok("トグル: 旧の並び替えの遷移は消した（一括をなくした）", !/location\.href = _sortHref/.test(read("bulk-dl.js")));
  ok("クリックで切り替えない（旧の並び替えの遷移コードが無い）", !/location\.href = adLink\.href/.test(read("bulk-dl.js")));
  ok("checked の判定・クリックの関数は変えていない（_clickIfUnchecked が残る）", /function _clickIfUnchecked\(el\) \{ if \(!el\.checked\) _clickEl\(el\); \}/.test(read("page-script.js")));
  ok("見張り（235秒・240秒・90秒）の長さを固定している所を確かめる", /\}, 895000\);/.test(read("page-script.js")) && /\}, 240000\);/.test(it) && /90000/.test(read("reins-page-script.js")));
  ok("拡張の再読み込み: 版を上げた（2.5.29 以上）", manifest.version.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0) >= 2005029);

  console.log("\n■ 全ファイル node --check");
  const { execFileSync } = require("child_process");
  for (const f of fs.readdirSync(EXT).filter((x) => x.endsWith(".js"))) {
    let good = true; try { execFileSync(process.execPath, ["--check", path.join(EXT, f)], { stdio: "pipe" }); } catch (e) { good = false; }
    ok(`node --check ${f}`, good);
  }

console.log("\n■ ⑥ 自動モードの間隔（2026-11-10 対数正規・12操作ごとに8秒の休憩）");
{
  // 中央値 0.9秒・12操作ごとに 8秒。固定周期でないこと（同じ値が続かない・等間隔でない）を確かめる
  const rng = seeded(3);
  const p = HW.createPacer({ baseMs: 900, breakEvery: 12, breakMs: 8000 });
  const xs = [];
  for (let i = 0; i < 240; i++) xs.push(p.next(rng));
  const normal = xs.filter((x) => !x.isBreak).map((x) => x.ms);
  const breaks = xs.filter((x) => x.isBreak).map((x) => x.ms);
  ok(`休憩は 12操作ごと（${breaks.length}回／240操作）`, breaks.length === 20);
  ok("休憩の印は 12・24・36… の所", xs.filter((x) => x.isBreak).map((x) => x.n).slice(0, 3).join(",") === "12,24,36");
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  ok(`ふだんの間の中央値 ≒ 0.9秒（${med(normal)}ms）`, Math.abs(med(normal) - 900) < 120);
  ok(`休憩の中央値 ≒ 8秒（${med(breaks)}ms）`, Math.abs(med(breaks) - 8000) < 1200);
  ok(`ふだんの間がばらつく（${new Set(normal).size}通り／220回）`, new Set(normal).size > 100);
  ok(`休憩がばらつく（${new Set(breaks).size}通り／20回）`, new Set(breaks).size > 10);
  ok("下の端は 200ms 以上", normal.every((v) => v >= 200));
  ok("右に裾が長い（平均 > 中央値）＝人がたまに間を置く形", normal.reduce((a, b) => a + b, 0) / normal.length > med(normal));
  ok("どの間も 中央値の6倍を超えない（止まらない）", normal.every((v) => v <= 900 * 6) && breaks.every((v) => v <= 8000 * 6));
  eq("nextMs は next の ms と同じ形", typeof HW.createPacer().nextMs(rng), "number");
  eq("reset で数え直す", (() => { const q = HW.createPacer(); q.next(rng); q.next(rng); q.reset(); return q.count(); })(), 0);
  eq("壊れた設定でも落ちない（既定に戻る）", typeof HW.createPacer({ baseMs: 0, breakEvery: -3, breakMs: "x" }).next(rng).ms, "number");
  eq("logNormalDelay(0) は 0（待たない）", HW.logNormalDelay(0), 0);
  // 固定周期でないこと（等間隔の検出を避ける）: 連続する2つの間が同じになる確率が低い
  const same = normal.slice(1).filter((v, i) => v === normal[i]).length;
  ok(`同じ値が続く回数が少ない（${same}回／219回）`, same < 20);
}

console.log("\n■ ⑦ マウスの軌跡（pointerPath・まっすぐでない）と打鍵（1文字ずつ）");
{
  const rng = seeded(9);
  const path = HW.pointerPath({ x: 100, y: 100 }, { x: 600, y: 400 }, 14, rng);
  eq("点の数は steps+1", path.length, 15);
  eq("出発点から始まる", path[0], { x: 100, y: 100 });
  eq("終点にぴったり着く", path[path.length - 1], { x: 600, y: 400 });
  ok("途中は直線上に無い（曲がる）", path.slice(1, -1).some((p) => {
    // 直線 y = 100 + (x-100)*0.6 から 1px 以上ずれている点がある
    return Math.abs(p.y - (100 + (p.x - 100) * 0.6)) > 1;
  }), path.slice(0, 4));
  ok("点はなめらか（隣り合う点が飛ばない）", path.slice(1).every((p, i) => Math.abs(p.x - path[i].x) <= 120 && Math.abs(p.y - path[i].y) <= 120));
  eq("同じ所から同じ所なら動かない", HW.pointerPath({ x: 5, y: 5 }, { x: 5, y: 5 }, 6, rng).every((p) => p.x === 5 && p.y === 5), true);
  eq("壊れた引数でも落ちない", HW.pointerPath(null, undefined, 3).length, 4);
  eq("steps は 2〜60 に収める", [HW.pointerPath({ x: 0, y: 0 }, { x: 10, y: 0 }, 1).length, HW.pointerPath({ x: 0, y: 0 }, { x: 10, y: 0 }, 999).length], [3, 61]);

  const waits = HW.pointerDelays(12, 400, rng);
  eq("待ちの数は点の数と同じ", waits.length, 12);
  ok(`待ちの合計 ≒ 400ms（${waits.reduce((a, b) => a + b, 0)}）`, Math.abs(waits.reduce((a, b) => a + b, 0) - 400) < 90);
  ok("最初と最後は中ほどよりゆっくり（加速・減速）", waits[0] + waits[11] > waits[5] + waits[6], { first: waits[0], last: waits[11], mid: waits[5] + waits[6] });
  ok("どの待ちも 4ms 以上（2026-11-11: 0.1ms 単位にしたので下限を下げた）", waits.every((v) => v >= 4));

  // 打鍵（page-script.js / itandi-page-script.js に配線されている）
  const ps = read("page-script.js"), ips = read("itandi-page-script.js");
  ok("リアプロ: 短い欄は1文字ずつ打つ（typeTextLikeHuman）", /function typeTextLikeHuman\(el, value\)/.test(ps) && /setter\.call\(el, s\.slice\(0, i\)\)/.test(ps));
  ok("リアプロ: 長い文字列は一気に入れる（待ちが長くなりすぎない）", /s\.length > TYPE_MAX_CHARS/.test(ps));
  ok("リアプロ: 打鍵の間は対数正規＋たまに止まる", /H\.logNormalDelay\(165, 0\.32\)/.test(ps) && /Math\.random\(\) < 0\.05/.test(ps));
  ok("リアプロ: 押す前に画面へ入れて、人の軌跡でマウスを動かしてから押す", /_ensureInView\(item\.el\)/.test(ps) && /_humanPointerClick\(item\.el, item\.fn\)/.test(ps));
  ok("リアプロ: 軌跡は human-wait.js の pointerPath を使う", /H\.pointerPath\(_pointer, to,/.test(ps));
  ok("リアプロ: 押すのは最後の1回だけ（二重に効かせない）", /try \{ fire\(el\); \}/.test(ps) && (ps.match(/_humanPointerClick\(/g) || []).length >= 2);
  ok("ITANDI: 短い欄は1文字ずつ打つ（setReactValAsync）", /function setReactValAsync\(el, val\)/.test(ips) && /setter\.call\(el, s\.slice\(0, i\)\)/.test(ips));
  ok("ITANDI: スクロールは一瞬で飛ばさない（smoothScrollTo）", /function smoothScrollTo\(el\)/.test(ips) && /scrollIntoView\(\{ behavior: "smooth"/.test(ips) && !/behavior: "instant"/.test(ips));
  ok("一覧の次ページも押す前に画面へ入れる（リアプロ・ITANDI）", /_humanScrollToEl\(el\)/.test(read("bulk-dl.js")) && /nextBtn\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/.test(read("itandi-bulk-dl.js")));
  ok("案内モードの光はスクロールしても位置を直す（既存の仕組みのまま）", /addEventListener\("scroll", repositionSoon, true\)/.test(read("realpro-guide.js")));
}

console.log("\n■ ⑧ 1件ずつ（2026-11-10 竹内「まとめてチェックではなくて1つずつおこなう」）");
{
  const ib = read("itandi-bulk-dl.js");
  ok("ITANDI の一覧: 全選択は1件ずつ押す（一括代入をやめた）", /function _humanCheckAll\(cbs, next\)/.test(ib) && !/tracked\.forEach\(function\(t\) \{ t\.cb\.checked = true; checkedKeys\.add\(t\.rowKey\); \}\);/.test(ib));
  ok("ITANDI の一覧: 押す間は対数正規＋たまに一息", /H\.logNormalDelay\(200, 0\.32\)/.test(ib) && /Math\.random\(\) < 0\.08/.test(ib));
  ok("ITANDI の一覧: 押し終わってから選別・送付へ進む（_afterHumanCheck）", /_humanCheckAll\(tracked\.map\(function \(t\) \{ return t\.cb; \}\), function \(\) \{/.test(ib) && /function _afterHumanCheck\(/.test(ib));
  ok("ITANDI の一覧: 押す前に画面へ入れる（人が目で探す形）", /cb\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/.test(ib));
  ok("ITANDI の一覧: 送付済みを外す選別はその場で（送り漏れ・送りすぎを防ぐ）", /_toUncheck\.forEach\(function \(t\) \{ try \{ t\.cb\.checked = false; \} catch \(_\) \{\} checkedKeys\.delete\(t\.rowKey\); \}\);/.test(ib));

  const ips = read("itandi-page-script.js");
  ok("ITANDI の条件: tick は1件ずつ（人の間）", /function tick\(el\) \{[\s\S]{0,2000}_tickBusy\+\+/.test(ips));
  ok("ITANDI の条件: 検索を押す前に全部のチェックが済むのを待つ（_whenTickIdle）", /_whenTickIdle\(function \(\) \{ try \{/.test(ips));
  ok("ITANDI の条件: 待つ間隔は固定でない（_pd）", /_whenTickIdle\(cb\)\) ?, _pd\(120\)/.test(ips.replace(/\s+/g, " ")) || /_whenTickIdle\(cb\); \}, _pd\(120\)\);/.test(ips));

  const ps = read("page-script.js");
  ok("リアプロの条件: クリックの列の間は対数正規（humanRand が logNormalDelay）", /H\.logNormalDelay\(med, 0\.32\)/.test(ps) && /0\.1ms 単位/.test(ps));
  ok("リアプロの条件: 1件ずつの列に名前が付く（点検で1操作ずつ見える）", /label: _opLabel\(el\)/.test(ps));
}

console.log("\n■ ⑨ 人が動いているかの記録（human-trace.js・2026-11-10）");
{
  const HT = require(path.join(EXT, "human-trace.js"));
  let t = 1_000_000;
  const tr = HT.create({ now: () => t });
  const handlers = {};
  const fakeDoc = { addEventListener: (type, fn) => { handlers[type] = fn; }, removeEventListener: () => {} };
  const fakeWin = { addEventListener: (type, fn) => { handlers["w:" + type] = fn; }, removeEventListener: () => {} };
  tr.attach(fakeDoc, fakeWin);
  eq("最初は0", tr.snapshot().n, 0);
  // 拡張が作ったイベント（isTrusted=false）は数えない
  handlers.click({ isTrusted: false, target: {} });
  eq("拡張のクリックは数えない", tr.snapshot().n, 0);
  // 人が押した（isTrusted=true）は数える
  t += 800; handlers.click({ isTrusted: true, target: { name: "rental_cost2" } });
  eq("人のクリックは数える", [tr.snapshot().n, tr.snapshot().clicks, tr.snapshot().last_k], [1, 1, "click"]);
  eq("最後に触った欄の名前を残す（入力の中身は残さない）", tr.snapshot().last_name, "rental_cost2");
  t += 1200; handlers.click({ isTrusted: true, target: {} });
  eq("操作の間の平均（2回目は 1200ms）", tr.snapshot().avg_gap_ms, 1200);
  t += 100; handlers.keydown({ isTrusted: true, target: {} });
  eq("打鍵も数える", tr.snapshot().keys, 1);
  t += 100; handlers.change({ isTrusted: true, target: { name: "x" } });
  eq("選んだ（change）も数える", tr.snapshot().changes, 1);
  // スクロール: 人のホイールから 400ms に1回
  t += 500; handlers["w:wheel"]({ isTrusted: true });
  eq("人のスクロールは数える", tr.snapshot().scroll, 1);
  t += 100; handlers["w:wheel"]({ isTrusted: true });
  eq("400ms 以内の続きのスクロールは1回にまとめる", tr.snapshot().scroll, 1);
  t += 600; handlers["w:wheel"]({ isTrusted: true });
  eq("間が空けば数える", tr.snapshot().scroll, 2);
  eq("最後の操作からの経過", tr.snapshot().last_at, 0);
  t += 3000;
  eq("時間が経つと経過が伸びる", tr.snapshot().last_at, 3000);

  // 判定（案内モードで人が0回＝止まっている疑い）
  eq("人が動いていれば human", HT.judge({ n: 3 }, true).level, "human");
  eq("案内モードで0回は none（止まっている疑い）", HT.judge({ n: 0 }, true).level, "none");
  eq("自動系で0回は auto（正常）", HT.judge({ n: 0 }, false).level, "auto");
  eq("記録が無ければ unknown", HT.judge(null, true).level, "unknown");
  ok("案内で0回の文が「止まっている疑い」と言う", /止まっている疑い/.test(HT.judge({ n: 0 }, true).ja));

  // 配線（manifest・各ページ・点検）
  const mf2 = JSON.parse(read("manifest.json"));
  ok("manifest: 先頭の段で human-trace.js を読む（human-wait・human-learn の後）", mf2.content_scripts[0].js.indexOf("human-trace.js") === 3);
  ok("manifest: web_accessible_resources に human-trace.js（ページへ <script> で入れる）", mf2.web_accessible_resources[0].resources.includes("human-trace.js"));
  ok("リアプロのページ: 人が動いたかを点検の記録に載せる", /AxlxHumanTrace/.test(read("page-script.js")) && /_audit\.human = _humanSnapshot\(\)/.test(read("page-script.js")));
  ok("ITANDI のページ: 同じ", /AxlxHumanTrace/.test(read("itandi-page-script.js")) && /_itAudit\.human = _itHumanSnapshot\(\)/.test(read("itandi-page-script.js")));
  ok("案内（リアプロ・ITANDI）: 人の操作を送る", /__axlxHumanSnapshot/.test(read("realpro-guide.js")) && /_itHumanSnap\(\)/.test(read("itandi-guide.js")));
  ok("background: 案内から来た人の操作を filled.human に入れる", /if \(msg\.human && typeof msg\.human === "object"\) filled\.human = msg\.human;/.test(read("background.js")));
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
