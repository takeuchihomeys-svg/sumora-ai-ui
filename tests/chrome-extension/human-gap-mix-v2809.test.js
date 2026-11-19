// 実行: node tests/chrome-extension/human-gap-mix-v2809.test.js
// v2.8.109 竹内さん（2026-11-18）:
//   「手を止めたり迷うのも入れる人間のように」
//   「家賃・更新日の前後のところも実際の通常モードの人間のように」
//
// DB実測（読むだけ・通常=人 / 自動=aix・小標本）:
//   区の間隔  通常: 約45%が速い群（0.9〜1.2s）・約50%が迷い 1.5〜6.5s（中央 約3.9s）・約5%が 7〜10s の停止（max 9.5s）
//   select    通常: 欄の中 p50=1.3s（p90=2.0s）・直前 p50=2.0s（p90=3.9s）・欄どうし p50=2.2s（p90=3.5s・max 4.2s）
//             自動: 欄の中 p50=2.8s・前後 p50=4.1s・8秒超 12〜25%
//
// 実装の計算をそのまま取り出して回す（_ln / _wardPaceMs / _wardGapPlan / _selGapPlan）。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const HW = require("../../chrome-extension/human-wait.js");

const ps = fs.readFileSync(path.join(__dirname, "../../chrome-extension/page-script.js"), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || detail === undefined ? "" : "\n      " + JSON.stringify(detail).slice(0, 300))); }

function grab(startRe, endMarker) {
  const i = ps.search(startRe);
  if (i < 0) return "";
  const rest = ps.slice(i);
  const j = rest.indexOf(endMarker);
  return j < 0 ? "" : rest.slice(0, j + endMarker.length);
}

const lnSrc = grab(/function _ln\(median, sigma, lo, hi\) \{/, "return Math.max(lo, Math.min(hi, v));\n  }");
const planSrc = grab(/function _wardPaceMs\(\) \{/, "return { kind: \"pause\", ms: _ln(8500, 0.13, 7000, 11000) };\n  }");
console.log("■ 0 実装の取り出し");
ok("_ln が取り出せる", lnSrc.length > 50);
ok("_wardPaceMs / _wardGapPlan / _selGapPlan が取り出せる", /_wardGapPlan/.test(planSrc) && /_selGapPlan/.test(planSrc), planSrc.slice(0, 80));

const sandbox = { window: { AxlxHumanWait: HW }, Math, Date };
vm.createContext(sandbox);
vm.runInContext(lnSrc + "\n" + planSrc + "\nthis.wardPlan = _wardGapPlan; this.selPlan = _selGapPlan; this.paceMs = _wardPaceMs;", sandbox);

function run(fn, N) {
  const xs = [];
  const kinds = { fast: 0, hesitate: 0, pause: 0 };
  for (let i = 0; i < N; i++) { const p = fn(); xs.push(p.ms); kinds[p.kind]++; }
  xs.sort((a, b) => a - b);
  const q = (p) => xs[Math.floor(p * (xs.length - 1))];
  return { xs, kinds, q, max: xs[xs.length - 1], min: xs[0] };
}

console.log("\n■ ① 区の間隔: 速い群＋迷い＋停止の混合（通常の人）");
{
  const N = 40000;
  const r = run(sandbox.wardPlan, N);
  const f = (k) => r.kinds[k] / N;
  console.log(`      速い=${(f("fast") * 100).toFixed(1)}% 迷い=${(f("hesitate") * 100).toFixed(1)}% 停止=${(f("pause") * 100).toFixed(1)}%  p50=${Math.round(r.q(0.5))} p90=${Math.round(r.q(0.9))} max=${Math.round(r.max)}`);
  ok("速い群が 4〜6割（通常 約45%）", f("fast") > 0.4 && f("fast") < 0.6, f("fast"));
  ok("迷い（1.5〜6.5s）が 38〜50%（通常 約50%）", f("hesitate") > 0.38 && f("hesitate") < 0.5, f("hesitate"));
  ok("停止（7〜10.5s）が 3〜9%（通常 約5%）", f("pause") > 0.03 && f("pause") < 0.09, f("pause"));
  const fast = run(sandbox.paceMs ? (() => ({ kind: "fast", ms: sandbox.paceMs() })) : null, 20000);
  ok("速い群の中央値は 0.9s 付近（±100ms）", Math.abs(fast.q(0.5) - 900) <= 100, fast.q(0.5));
  ok("どの間隔も 11 秒を超えない（自動の最大 23.9s にしない）", r.max <= 11000, r.max);
  ok("どの間隔も 650ms 未満にならない", r.min >= 650, r.min);
  const hes = r.xs.filter((x) => x >= 1500 && x <= 6500);
  ok("迷いの中央値が 3〜4.8s（通常 約3.9s）", hes.length > 0 && hes[Math.floor(hes.length / 2)] > 2800 && hes[Math.floor(hes.length / 2)] < 4800, hes[Math.floor(hes.length / 2)]);
  ok("毎回ちがう（種類が多い）", new Set(r.xs.map(Math.round)).size > 1000);
}

console.log("\n■ ② select欄の間隔: 通常の分布（欄どうし p50=2.2s・p90=3.5s・まれに停止）");
{
  const N = 40000;
  const r = run(sandbox.selPlan, N);
  const f = (k) => r.kinds[k] / N;
  console.log(`      速い=${(f("fast") * 100).toFixed(1)}% 迷い=${(f("hesitate") * 100).toFixed(1)}% 停止=${(f("pause") * 100).toFixed(1)}%  p50=${Math.round(r.q(0.5))} p75=${Math.round(r.q(0.75))} p90=${Math.round(r.q(0.9))} max=${Math.round(r.max)}`);
  ok("中央値が通常（2.2s）に近い（±0.5s）", Math.abs(r.q(0.5) - 2200) <= 500, r.q(0.5));
  ok("p90 が 通常 3.5s〜迷いを含めて 5.5s 以下", r.q(0.9) <= 5500, r.q(0.9));
  ok("自動の旧 p50（4.1s）より短い", r.q(0.5) < 4100, r.q(0.5));
  ok("迷いが 8〜16%・停止が 1〜5%", f("hesitate") > 0.08 && f("hesitate") < 0.16 && f("pause") > 0.01 && f("pause") < 0.05, { h: f("hesitate"), p: f("pause") });
  ok("停止でも 11 秒を超えない", r.max <= 11000, r.max);
  ok("毎回ちがう（種類が多い）", new Set(r.xs.map(Math.round)).size > 1000);
}

console.log("\n■ ③ 配線（ソース）");
{
  ok("drain が区は _wardGapPlan、select は _selGapPlan を使う", /\(_isWardItem \? _wardGapPlan\(\) : _selGapPlan\(\)\)/.test(ps));
  ok("迷い・停止は欄の上で漂ってから押す（hesitate を設定・tgt は null のまま）", /hesitate = Math\.max\(400, Math\.round\(_plan\.ms - \(_nowL - _ref\) - 1000\)\);/.test(ps));
  ok("速い群は『直前の操作＋間隔』を押す時刻の目標にする", /_wardTgt = _ref \+ _plan\.ms;/.test(ps));
  ok("quick（選び直し）は迷い・停止を入れない", /var _plan = item\.quick/.test(ps) && /quick: !!\(opts && opts\.quick\)/.test(ps));
  ok("_toggleCheckboxLikeHuman が flags.quick を渡す", /function _toggleCheckboxLikeHuman\(cb, wantOn, minGap, maxGap, flags\)/.test(ps) && /quick: !!\(flags && flags\.quick\)/.test(ps));
  ok("区の選び直し（2回目以降）と外し直しが quick", /_toggleCheckboxLikeHuman\(target\.c, true, 620, 1400, \{ quick: /.test(ps) && /_toggleCheckboxLikeHuman\(extras\[ei\], false, 620, 1400, \{ quick: true \}\)/.test(ps) && /_toggleCheckboxLikeHuman\(inp, false, 620, 1400, \{ quick: true \}\)/.test(ps));
  ok("迷いの二重待ちをしない（drift 済みはタイマーに足さない）", /\(_isWardItem \|\| _isSelItem\) && hesitate > 0 && window\.AxlxPointerUi && window\.AxlxPointerUi\.drift\) \? 0 : hesitate/.test(ps));
  ok("select は lane:sel（押す前の待ちが小さい・「息」「考え」を足さない）", /lane: "sel"/.test(ps) && /gap: _ln\(110, 0\.45, 50, 260\), label: label \|\| _opLabel\(el\), aim: aim \|\| null, lane: "sel"/.test(ps));
  ok("select の行を押した時刻を記録（__axlxSelTapAt）", /window\.__axlxSelTapAt = Date\.now\(\);/.test(ps));
  ok("直前の操作の時刻を記録（__axlxLastClickAt）", /window\.__axlxLastClickAt = _tn;/.test(ps));
  ok("欄の中: 見る・押す前・閉じる待ちが通常の速さ", /_ln\(330, 0\.35, 200, 560\)/.test(ps) && /_ln\(210, 0\.35, 120, 400\)/.test(ps) && /_ln\(130, 0\.35, 70, 230\)/.test(ps));
  ok("1項目ごとの待ちを短く（二重にしない）", /var pause = _ln\(200, 0\.45, 90, 650\);/.test(ps) && !/if \(Math\.random\(\) < 0\.12\) pause \+= 700/.test(ps));
}

console.log("\n■ ④ 欄の中の所要（開く→選ぶ）の見積り（通常 p50=1.3s・p90=2.0s）");
{
  // 見る(_lookMs) + 押す前(_tapMs) + 選んだ後の3段の待ち（実装の式の中央値）で足し上げる
  const N = 20000, xs = [];
  const L = (m, s, lo, hi) => Math.max(lo, Math.min(hi, HW.logNormalDelay(m, s)));
  for (let i = 0; i < N; i++) {
    let t = L(260, 0.35, 160, 440) + (Math.random() < 0.08 ? 700 + Math.random() * 900 : 0);
    t += L(170, 0.35, 100, 320) + L(130, 0.35, 70, 230) + L(170, 0.35, 100, 300) + L(120, 0.35, 70, 220);
    // カーソル移動・開く・選ぶ操作そのもの（実測の ≈ 0.4〜0.6s）を足す
    t += 400 + Math.random() * 200;
    xs.push(t);
  }
  xs.sort((a, b) => a - b);
  const q = (p) => xs[Math.floor(p * (N - 1))];
  console.log(`      p50=${Math.round(q(0.5))} p75=${Math.round(q(0.75))} p90=${Math.round(q(0.9))}`);
  ok("p50 が 1.0〜1.8s（通常 1.3s・自動の旧 2.8s より短い）", q(0.5) >= 1000 && q(0.5) <= 1800, q(0.5));
  ok("p90 が 3s 以下（通常 2.0s・たまの迷いを含む）", q(0.9) <= 3000, q(0.9));
}

console.log("\n■ ⑤ 版");
{
  const mf = JSON.parse(fs.readFileSync(path.join(__dirname, "../../chrome-extension/manifest.json"), "utf8"));
  ok("manifest が 2.8.116", mf.version === "2.8.116", mf.version);
  ok("_AXLX_PAGE_VER が 2.8.116", /var _AXLX_PAGE_VER = "2\.8\.116";/.test(ps));
}

console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
process.exit(fail ? 1 : 0);
