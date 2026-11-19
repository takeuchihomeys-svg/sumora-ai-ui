// 2.8.126 「人間に近づいたか」の確かめ（サイトには一切触れない・計算だけ）
//   人の実測（本番DB human_motion_learn・通常モード・2026-11-19 読み）:
//     速さ p50 375px/s CV 0.64 ／ 曲がり p50 1.02 CV 0.16 ／ 移動 p50 284ms CV 0.91 ／ 距離 p50 116px
//   新: human-wait.js planMove（ラン別 persona）を、人の距離分布（対数正規 中央値116px）で多数回引いて比べる。
//   旧: pointer-ui.js _planLegacy の式（曲がり 1.18〜1.46 の一様・総時間 = 対数正規(max(320, dist×2.45), 0.28)・80px超の72%で行き過ぎ）を
//       同じ式で再現して並べる（旧の実物は pointer-ui.js の内側にあり、ここでは式のまま計算する）。
const path = require("path");
const HW = require(path.join(__dirname, "..", "..", "chrome-extension", "human-wait.js"));
let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (d ? " :: " + d : "")); } }

const HUMAN = { speed_p50: 375, speed_cv: 0.64, curve_p50: 1.02, curve_cv: 0.16, ms_p50: 284, ms_cv: 0.91, dist_p50: 116 };
function gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function pct(a, q) { const s = a.slice().sort((x, y) => x - y); const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }
function cv(a) { const m = a.reduce((x, y) => x + y, 0) / a.length; const v = a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length; return Math.sqrt(v) / m; }
function summarize(rows) {
  const sp = rows.map((r) => (r.dist / r.ms) * 1000), ms = rows.map((r) => r.ms), cu = rows.map((r) => r.curve), di = rows.map((r) => r.dist);
  return { speed_p50: pct(sp, 0.5), speed_cv: cv(sp), ms_p50: pct(ms, 0.5), ms_cv: cv(ms), curve_p50: pct(cu, 0.5), curve_cv: cv(cu), dist_p50: pct(di, 0.5), over_pct: (rows.filter((r) => r.over).length / rows.length) * 100 };
}
const N = 6000;
const ptsFrom = () => {
  const dist = Math.max(20, Math.min(900, 116 * Math.exp(0.9 * gauss())));
  const ang = Math.random() * Math.PI * 2;
  return { a: { x: 500, y: 400 }, b: { x: 500 + dist * Math.cos(ang), y: 400 + dist * Math.sin(ang) } };
};

// 新（persona はラン＝12〜25移動ごとに作り直す）
const newRows = [];
let persona = null, left = 0;
for (let i = 0; i < N; i++) {
  if (left <= 0) { persona = HW.makePersona((Math.random() * 4294967296) >>> 0); left = 12 + Math.floor(Math.random() * 14); }
  left--;
  const { a, b } = ptsFrom();
  const m = HW.planMove(a, b, { persona, rng: Math.random });
  newRows.push({ dist: m.dist, ms: m.ms, curve: m.curve, over: m.overshoot });
}
// 旧（式の再現）
const oldRows = [];
for (let i = 0; i < N; i++) {
  const { a, b } = ptsFrom();
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  let total = Math.min(1600, Math.max(320, Math.round(dist * 2.45)));
  const j = total * Math.exp(0.28 * gauss());
  if (j > 280 && j < 1800) total = Math.round(j);
  const over = dist > 80 && Math.random() < 0.72;
  if (over) total = Math.min(1800, total + 110 + Math.floor(Math.random() * 180));
  oldRows.push({ dist, ms: total, curve: 1.18 + Math.random() * 0.28, over });
}
const S = summarize(newRows), O = summarize(oldRows);
const f = (x, d) => (x == null ? "-" : Number(x).toFixed(d == null ? 2 : d));
console.log("\n            人(実測)   新(2.8.126)   旧(2.8.125まで)");
console.log("速さ p50    " + HUMAN.speed_p50 + "        " + f(S.speed_p50, 0) + "          " + f(O.speed_p50, 0));
console.log("速さ CV     " + HUMAN.speed_cv + "       " + f(S.speed_cv) + "          " + f(O.speed_cv));
console.log("移動ms p50  " + HUMAN.ms_p50 + "        " + f(S.ms_p50, 0) + "          " + f(O.ms_p50, 0));
console.log("移動ms CV   " + HUMAN.ms_cv + "       " + f(S.ms_cv) + "          " + f(O.ms_cv));
console.log("曲がり p50  " + HUMAN.curve_p50 + "       " + f(S.curve_p50) + "          " + f(O.curve_p50));
console.log("曲がり CV   " + HUMAN.curve_cv + "       " + f(S.curve_cv) + "          " + f(O.curve_cv));
console.log("行き過ぎ%   (80px超で人は少ない)  " + f(S.over_pct, 1) + "        " + f(O.over_pct, 1) + "\n");

// 近さ = 人との差（相対）。新が旧より人に近いこと、かつ帯の中にあること
const rel = (x, h) => Math.abs(x - h) / h;
ok("速さの中央値: 新は人の ±30% 以内", rel(S.speed_p50, HUMAN.speed_p50) <= 0.30, f(S.speed_p50, 0));
ok("速さのばらつき(CV): 新は人(0.64)に旧より近い", rel(S.speed_cv, HUMAN.speed_cv) < rel(O.speed_cv, HUMAN.speed_cv), "新" + f(S.speed_cv) + " 旧" + f(O.speed_cv));
ok("速さのばらつき(CV): 新は 0.4〜0.9 の帯", S.speed_cv >= 0.4 && S.speed_cv <= 0.9, f(S.speed_cv));
ok("移動時間の中央値: 新は人の ±35% 以内", rel(S.ms_p50, HUMAN.ms_p50) <= 0.35, f(S.ms_p50, 0));
ok("曲がりの中央値: 新は人(1.02)に旧(約1.32)より近い", rel(S.curve_p50, HUMAN.curve_p50) < rel(O.curve_p50, HUMAN.curve_p50), "新" + f(S.curve_p50) + " 旧" + f(O.curve_p50));
ok("曲がりの中央値: 新は 1.0〜1.12 の帯", S.curve_p50 >= 1.0 && S.curve_p50 <= 1.12, f(S.curve_p50));
ok("行き過ぎ: 新は旧(72%)より大きく減る（30%未満）", S.over_pct < 30 && S.over_pct < O.over_pct, f(S.over_pct, 1));
ok("距離の中央値は人と同じ入力（比較条件がそろっている）", rel(S.dist_p50, HUMAN.dist_p50) <= 0.12 && rel(O.dist_p50, HUMAN.dist_p50) <= 0.12, f(S.dist_p50, 0));

// ラン別 persona が本当に「一定でない」こと: ラン平均の速さ（run ごと）がばらつく
const runs = [];
for (let r = 0; r < 200; r++) {
  const p = HW.makePersona((Math.random() * 4294967296) >>> 0);
  const sp = [];
  for (let i = 0; i < 20; i++) { const { a, b } = ptsFrom(); const m = HW.planMove(a, b, { persona: p, rng: Math.random }); sp.push((m.dist / m.ms) * 1000); }
  runs.push(pct(sp, 0.5));
}
const runCv = cv(runs);
console.log("ラン(検索)ごとの速さp50のばらつき CV = " + f(runCv) + "（旧は全ランで同じ＝0）");
ok("検索ごとに動きの癖が変わる（ラン間の速さ p50 の CV が 0.1 以上）", runCv >= 0.1, f(runCv));
// 押し込み
const presses = []; for (let i = 0; i < 4000; i++) presses.push(HW.pressMs(HW.makePersona((Math.random() * 4294967296) >>> 0), Math.random));
ok("押し込み時間: 固定90msでなく 45〜180ms に散る（CV 0.15 以上）", Math.min.apply(null, presses) >= 45 && Math.max.apply(null, presses) <= 180 && cv(presses) >= 0.15, f(cv(presses)));
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
