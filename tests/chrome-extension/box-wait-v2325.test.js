/**
 * 2.8.325 竹内さん「待機中や待機している時間もちゃんとボックスに表示されるように」:
 *   枠の「いま」の下に ⏳ 何を待っているか（あと N 秒）を出す。残りは1秒ごとに数え、0で消える。
 *   待ちの印: sort_lag（押したあと）・sort_resume_lag（読み直したあと）・search_to_sort（検索の後の並べ替え待ち）・reset_settle（リセット後・background）。
 * node tests/chrome-extension/box-wait-v2325.test.js
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); }
}

const dl = read("chrome-extension/bulk-dl.js");
const bg = read("chrome-extension/background.js");

console.log("■ 1. 枠に待ちの行がある（いまの下・最初は隠す）");
{
  const i = dl.indexOf('id="axlx-count"');
  const j = dl.indexOf('id="axlx-wait"', i);
  const k = dl.indexOf('id="axlx-next"', i);
  ok("axlx-wait が いま（axlx-count）の下・つぎ（axlx-next）の上", i > 0 && j > i && j < k);
  ok("最初は隠す（display:none）", /id="axlx-wait" style="display:none;/.test(dl));
}

console.log("■ 2. 残りを1秒ごとに数え、0で消す");
{
  const p = dl.indexOf("function _paintWait()");
  const body = dl.slice(p, p + 600);
  // 2.8.329 竹内さん「時間も5秒刻みとかでよいのでしっかりと表記するように」→ 残りは5秒刻みの切り上げ（最後の5秒は「あと5秒以内」）
  ok("残りの秒数を出す（あと約 N 秒・5秒刻み）", /Math\.ceil\(left \/ 5\) \* 5/.test(body) && /"あと5秒以内"/.test(body) && /"あと約" \+ _fmtElapsed5\(left5 \* 1000\)/.test(body));
  ok("0以下で隠して止める", /left <= 0[\s\S]{0,160}display = "none"[\s\S]{0,80}_stopWaitTick\(\)/.test(body));
  ok("1秒ごとに数え直す（setInterval 1000）", /setInterval\(_paintWait, 1000\)/.test(dl));
}

console.log("■ 3. 各待ちがボックスへ届く");
{
  ok("押したあと（sort_lag）", /_setBulkWaitById\("sort_lag", 1200 \+ _lagG\)/.test(dl));
  ok("読み直したあと（sort_resume_lag）", /_setBulkWaitById\("sort_resume_lag", _lagR\)/.test(dl));
  ok("検索の後の並べ替え待ち（search_to_sort）", /_setBulkWaitById\("search_to_sort", wait\)/.test(dl));
  ok("リセット後（background が id と秒数を送る）", /_bulkWaitShow\("reset_settle", _settleMs\)/.test(bg));
  ok("background は tabs へ axlx-bulk-wait を送る", /type: "axlx-bulk-wait"/.test(bg));
  ok("bulk-dl は axlx-bulk-wait を受けて枠へ出す", /msg\.type === "axlx-bulk-wait"[\s\S]{0,120}_setBulkWaitById\(/.test(dl));
}

console.log("■ 4. 言葉が無い id は止める（黙って空を出さない）");
{
  const p = dl.indexOf("function _setBulkWaitById(");
  const body = dl.slice(p, p + 300);
  ok("言葉が無い id は点検に残して戻る", /wait_unknown_id/.test(body) && /return;/.test(body));
}

console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
if (fail) process.exit(1);
