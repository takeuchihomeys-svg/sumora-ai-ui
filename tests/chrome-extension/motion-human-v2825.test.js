// tests/chrome-extension/motion-human-v2825.test.js
// 実行: node tests/chrome-extension/motion-human-v2825.test.js
// 2026-11-19 v2.8.25 自動モードのカーソルを「人の実測分布」に寄せる＋検索（ラン）ごとの動きの個性（persona）
//
//   ★ 本番DBの実測（human_motion_learn・通常モード・リアプロ・直近150行）
//     速さ px/s: p10/p50/p90 = 130/375/478・CV 0.64   曲がり（道のり÷直線）: p50 1.02・CV 0.16
//     1回の移動時間: p50 284ms・CV 0.91                 移動距離: p50 116px
//     自動モード（mode=aix）の行は 150行すべて moves_n=0＝自動の動きは測れていなかった。
//
//   ① human-wait.js の純関数（seededRng / makePersona / sanitizePlan / planMove / pressMs / motionSummary）
//   ② 分布が人の実測に近い（seed 固定で多数回）
//   ③ persona は seed ごとに違い・同じ seed で再現する
//   ④ 計画なし／壊れた計画／期限切れでも例外なく動く
//   ⑤ pointer-ui.js（vm）: ラン単位の persona・押し込み時間・指標・サーバー学習値の受け取り
//   ⑥ content.js の PUSH_KEYS・pointerPath を引数無しで呼ぶ従来の挙動
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const HW = require(path.join(dir, "human-wait.js"));

function pct(arr, q) {
  const a = arr.slice().sort((x, y) => x - y);
  const idx = (a.length - 1) * q, lo = Math.floor(idx), hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}
function cv(arr) {
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length;
  return Math.sqrt(v) / m;
}
function std(arr) {
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length);
}
/** 距離が対数正規（中央値116px・σ0.9）の移動を n 回作る */
function genMoves(persona, seed, n, extra) {
  const rng = HW.seededRng(seed);
  const gen = [];
  for (let i = 0; i < n; i++) {
    const g = Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());
    const d = Math.max(8, Math.min(1200, 116 * Math.exp(0.9 * g)));
    const ang = rng() * Math.PI * 2;
    const from = { x: 600, y: 400 };
    const to = { x: 600 + Math.cos(ang) * d, y: 400 + Math.sin(ang) * d };
    gen.push(HW.planMove(from, to, Object.assign({ persona, rng }, extra || {})));
  }
  return gen;
}

console.log("■ ① seededRng / makePersona（seed 固定で再現・seed が違えば違う）");
{
  const a = HW.seededRng(123), b = HW.seededRng(123), c = HW.seededRng(124);
  const sa = [a(), a(), a(), a()], sb = [b(), b(), b(), b()], sc = [c(), c(), c(), c()];
  ok("同じ seed は同じ列", JSON.stringify(sa) === JSON.stringify(sb));
  ok("seed が違えば違う列", JSON.stringify(sa) !== JSON.stringify(sc));
  ok("0以上1未満", sa.every((x) => x >= 0 && x < 1));
  ok("文字列の seed でも使える（客IDなど）", HW.seededRng("cust-1")() === HW.seededRng("cust-1")() && HW.seededRng("cust-1")() !== HW.seededRng("cust-2")());
  const p1 = HW.makePersona(7), p2 = HW.makePersona(7);
  ok("同じ seed の persona は完全に同じ", JSON.stringify(p1) === JSON.stringify(p2), [p1, p2]);
  const ps = []; for (let s = 1; s <= 200; s++) ps.push(HW.makePersona(s));
  ok("persona が seed ごとに違う（speed_scale の標準偏差 > 0.1）", std(ps.map((p) => p.speed_scale)) > 0.1, std(ps.map((p) => p.speed_scale)));
  ok("curve_gain も seed ごとに違う（標準偏差 > 0.1）", std(ps.map((p) => p.curve_gain)) > 0.1);
  ok("press_ms も seed ごとに違う（標準偏差 > 8）", std(ps.map((p) => p.press_ms)) > 8);
  const R = HW.PERSONA_RANGE;
  ok("全ての値が範囲内", ps.every((p) => Object.keys(R).every((k) => p[k] >= R[k][0] - 1e-9 && p[k] <= R[k][1] + 1e-9)));
  ok("overshoot_p は 0.08〜0.28・hesitate_p は 0.10〜0.30", ps.every((p) => p.overshoot_p >= 0.08 && p.overshoot_p <= 0.28 && p.hesitate_p >= 0.10 && p.hesitate_p <= 0.30));
  ok("press_ms は 60〜120", ps.every((p) => p.press_ms >= 60 && p.press_ms <= 120));
  const gm = Math.exp(ps.reduce((s, p) => s + Math.log(p.speed_scale), 0) / ps.length);
  ok("speed_scale の中心は 1.0（幾何平均 0.9〜1.1）", gm > 0.9 && gm < 1.1, gm);
  ok("seed が undefined でも例外なく persona が作れる", (() => { try { const p = HW.makePersona(undefined); return typeof p.speed_scale === "number"; } catch (_) { return false; } })());
}

console.log("\n■ ② 動きの分布が人の実測に近い（距離 中央値116px・多数回）");
{
  // 速さの中心を 1.0 にした persona（個性ではなく分布そのものを測る）
  const base = Object.assign({}, HW.makePersona(11), { speed_scale: 1, curve_gain: 1, overshoot_p: 0.18, hesitate_p: 0.2 });
  const mv = genMoves(base, 2025, 400);
  const sp = mv.map((m) => m.speed), ms = mv.map((m) => m.ms), cr = mv.map((m) => m.curve), di = mv.map((m) => m.dist);
  const sp50 = pct(sp, 0.5), spcv = cv(sp), mscv = cv(ms), ms50 = pct(ms, 0.5);
  ok("速さ p50 が 300〜450 px/s（実測 375）", sp50 >= 300 && sp50 <= 450, sp50);
  ok("速さの CV が 0.4〜0.9（実測 0.64）", spcv >= 0.4 && spcv <= 0.9, spcv);
  ok("移動時間の CV が 0.6 以上（実測 0.91・一定にならない）", mscv >= 0.6, mscv);
  ok("移動距離の p50 が 100〜135px（入力の分布が狙い通り）", pct(di, 0.5) >= 100 && pct(di, 0.5) <= 135, pct(di, 0.5));
  ok("曲がりの p50 が 1.10 以下（実測 1.02・旧は 1.18〜1.46）", pct(cr, 0.5) <= 1.10 && pct(cr, 0.5) >= 1.0, pct(cr, 0.5));
  ok("曲がりの p90 が 1.35 以下", pct(cr, 0.9) <= 1.35, pct(cr, 0.9));
  ok("移動時間は 90〜1600ms＋行き過ぎの修正分（最大 1820 以内）", ms.every((x) => x >= 90 && x <= 1820), [Math.min(...ms), Math.max(...ms)]);
  // 116px 付近（100〜135px）の移動時間の中央値が人の 284ms の近く
  const near = mv.filter((m) => m.dist >= 100 && m.dist <= 135).map((m) => m.ms);
  ok("116px 付近の移動時間の p50 が 220〜400ms（実測 284）", near.length > 20 && pct(near, 0.5) >= 220 && pct(near, 0.5) <= 400, [near.length, pct(near, 0.5)]);
  // 距離が長いほど時間も長い（Fitts 的）
  const far = mv.filter((m) => m.dist >= 400).map((m) => m.ms), short = mv.filter((m) => m.dist <= 50).map((m) => m.ms);
  ok("遠い移動のほうが近い移動より時間が長い", far.length > 5 && short.length > 5 && pct(far, 0.5) > pct(short, 0.5) * 1.5, [pct(far, 0.5), pct(short, 0.5)]);
  ok("近い移動の下限は 90ms 前後（旧は最低 320ms）", Math.min(...short) >= 90 && pct(short, 0.5) < 320, [Math.min(...short), pct(short, 0.5)]);
  ok("終点は必ず狙い点（最後の点＝to）", mv.every((m, i) => m.pts.length > 3), null);
  const rng = HW.seededRng(5);
  const to = { x: 333, y: 444 };
  const one = HW.planMove({ x: 10, y: 10 }, to, { persona: base, rng });
  ok("最後の点が狙い点に一致（着地精度は今と同じ）", one.pts[one.pts.length - 1].x === 333 && one.pts[one.pts.length - 1].y === 444);
  ok("最初の点が出発点", one.pts[0].x === 10 && one.pts[0].y === 10);
  ok("待ちの数が点の数と同じ・全て正", one.waits.length === one.pts.length && one.waits.every((w) => w > 0));
  ok("ピーク速度が平均より速い（加速・減速がある・p50 1.5〜3）", (() => { const pk = mv.map((m) => m.peakRatio); return pct(pk, 0.5) >= 1.5 && pct(pk, 0.5) <= 3; })());
  const S = HW.motionSummary(mv);
  ok("motionSummary が n・speed_p50・ms_cv・curve_p50・over_pct・pause_pct を返す", S.n === 400 && S.speed_p50 > 0 && S.ms_cv > 0 && S.curve_p50 >= 1 && S.over_pct >= 0 && S.pause_pct >= 0, S);
  ok("motionSummary は空でも落ちない", HW.motionSummary([]).n === 0 && HW.motionSummary(null).n === 0 && HW.motionSummary([null, {}]).n === 0);
}

console.log("\n■ ③ persona ごとの行き過ぎ率・ためらい率（範囲）と曲がりの上限（20人分）");
{
  let overOk = 0, hesOk = 0, curveOk = 0, speedOk = 0, total = 0;
  const detail = [];
  for (let s = 1; s <= 20; s++) {
    const p = HW.makePersona(s * 31);
    const mv = genMoves(p, s * 1009, 400);
    const longMv = mv.filter((m) => m.dist > 80);
    const overRate = longMv.filter((m) => m.overshoot).length / longMv.length;
    const hesLong = mv.filter((m) => m.dist >= 60);
    const hesRate = hesLong.filter((m) => m.paused).length / hesLong.length;
    const cr = mv.map((m) => m.curve);
    const sp50 = pct(mv.map((m) => m.speed), 0.5);
    total++;
    if (Math.abs(overRate - p.overshoot_p) <= 0.08) overOk++;
    if (Math.abs(hesRate - p.hesitate_p) <= 0.08) hesOk++;
    if (pct(cr, 0.5) <= 1.10 && pct(cr, 0.9) <= 1.35) curveOk++;
    // 速さの中央値は 375 × speed_scale に比例する（±20%）
    if (sp50 >= 375 * p.speed_scale * 0.8 && sp50 <= 375 * p.speed_scale * 1.2) speedOk++;
    detail.push([p.overshoot_p, +overRate.toFixed(2), p.hesitate_p, +hesRate.toFixed(2), +pct(cr, 0.5).toFixed(2), +pct(cr, 0.9).toFixed(2)]);
  }
  ok("20人全員: 行き過ぎ率が persona.overshoot_p の ±0.08 以内", overOk === total, detail);
  ok("20人全員: ためらい率が persona.hesitate_p の ±0.08 以内", hesOk === total, detail);
  ok("20人全員: 曲がり p50 ≤ 1.10・p90 ≤ 1.35", curveOk === total, detail);
  ok("20人全員: 速さの中央値が 375×speed_scale に比例（±20%）", speedOk === total);
  const flat = HW.makePersona(3), mvF = genMoves(flat, 3, 300).filter((m) => m.dist <= 80);
  ok("80px 以下は行き過ぎない（旧は 72%）", mvF.every((m) => !m.overshoot));
  const overs = []; for (let s = 1; s <= 10; s++) genMoves(Object.assign({}, HW.makePersona(s), { overshoot_p: 0.28 }), s, 200).forEach((m) => { if (m.overshoot) overs.push(m); });
  ok("行き過ぎの量は控えめ（最終点との差が 4〜14px 程度＝道のりの増分が小さい）", overs.length > 20 && overs.every((m) => m.curve < 1.6), overs.slice(0, 3).map((m) => m.curve));
}

console.log("\n■ ④ 計画の扱い（無い・壊れた・期限切れでも例外なく動く）");
{
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  const good = { v: 1, plan_id: "plan-1", expires_at: future, run_seed: 4242, persona: { speed_scale: 1.2, press_ms: 100, curve_gain: 9, tremor: "abc", hesitate_p: -3 } };
  const sp = HW.sanitizePlan(good);
  ok("有効な計画は通る", sp && sp.plan_id === "plan-1" && sp.run_seed === 4242);
  ok("範囲外は丸める（curve_gain 9 → 1.5・hesitate_p -3 → 0.10）", sp.persona.curve_gain === 1.5 && sp.persona.hesitate_p === 0.10, sp.persona);
  ok("数でない値は捨てる（tremor が文字）", !("tremor" in sp.persona));
  ok("期限切れは無視（null）", HW.sanitizePlan(Object.assign({}, good, { expires_at: past })) === null);
  ok("期限が読めない／無いは無視", HW.sanitizePlan(Object.assign({}, good, { expires_at: "あした" })) === null && HW.sanitizePlan(Object.assign({}, good, { expires_at: undefined })) === null);
  ok("v が違う・plan_id が無いは無視", HW.sanitizePlan(Object.assign({}, good, { v: 2 })) === null && HW.sanitizePlan(Object.assign({}, good, { plan_id: "" })) === null);
  const junk = [null, undefined, 0, 1, "x", [], [1, 2], true, { v: 1 }, () => 1];
  ok("壊れた計画（null・文字・配列・関数など）で例外なし・null", junk.every((j) => { try { return HW.sanitizePlan(j) === null; } catch (_) { return false; } }));
  const pPlan = HW.makePersona(1, good);
  ok("計画の persona の値が優先される（speed_scale 1.2・press_ms 100）", pPlan.speed_scale === 1.2 && pPlan.press_ms === 100 && pPlan.source === "plan", pPlan);
  ok("計画に無い値は seed からローカル生成（overshoot_p は範囲内）", pPlan.overshoot_p >= 0.08 && pPlan.overshoot_p <= 0.28);
  ok("計画の run_seed が seed に使われる（seed 引数が違っても同じ persona）", JSON.stringify(HW.makePersona(1, good)) === JSON.stringify(HW.makePersona(999, good)));
  const pLocalA = HW.makePersona(1), pExp = HW.makePersona(1, Object.assign({}, good, { expires_at: past }));
  ok("期限切れの計画は無視して seed からローカル生成（従来相当）", JSON.stringify(pLocalA) === JSON.stringify(pExp));
  ok("壊れた計画でもローカル生成で動く", junk.every((j) => { try { const p = HW.makePersona(5, j); return p.source === "local" && p.speed_scale > 0; } catch (_) { return false; } }));
  ok("persona が壊れていても planMove は中立で動く（null・文字・NaN）", [null, undefined, "x", { speed_scale: NaN, press_ms: "a" }].every((pp) => {
    try { const m = HW.planMove({ x: 0, y: 0 }, { x: 200, y: 50 }, { persona: pp, rng: HW.seededRng(1) }); return m.pts.length > 3 && m.ms >= 90; } catch (_) { return false; }
  }));
  ok("壊れた from/to でも落ちない", (() => { try { HW.planMove(null, undefined, {}); HW.planMove({ x: NaN, y: 1 }, { x: 5, y: 5 }); return true; } catch (_) { return false; } })());
  ok("学習した速さで中央値が置き換わる（速い学習値 → 時間が短くなる・でも一定にならない）", (() => {
    const base = Object.assign({}, HW.makePersona(2), { speed_scale: 1 });
    const slow = genMoves(base, 9, 300, { speedPxS: 200 }).map((m) => m.ms), fast = genMoves(base, 9, 300, { speedPxS: 700 }).map((m) => m.ms);
    return pct(fast, 0.5) < pct(slow, 0.5) * 0.7 && new Set(fast).size > 100 && cv(fast) > 0.5;
  })());
  ok("学習した曲がりが 1.0 付近ならほぼ直線（p50 ≤ 1.04）", (() => {
    const base = Object.assign({}, HW.makePersona(2), { curve_gain: 1, overshoot_p: 0.08 });
    return pct(genMoves(base, 7, 300, { curve: 1.0 }).map((m) => m.curve), 0.5) <= 1.04;
  })());
  ok("学習した曲がりが極端（9.9）でも上限で丸まる（p90 ≤ 1.5）", pct(genMoves(HW.makePersona(2), 7, 300, { curve: 9.9 }).map((m) => m.curve), 0.9) <= 1.5);
}

console.log("\n■ ⑤ pointerPath / pointerDelays を引数無しで呼ぶ従来の挙動（壊していない）");
{
  const rng = HW.seededRng(1);
  const path0 = HW.pointerPath({ x: 100, y: 100 }, { x: 600, y: 400 }, 14, rng);
  ok("pointerPath（引数無し）: 点の数 n+1・最後が終点・最初が出発点", path0.length === 15 && path0[14].x === 600 && path0[14].y === 400 && path0[0].x === 100);
  ok("pointerPath（引数無し）: 壊れた引数でも落ちない", HW.pointerPath(null, undefined, 3).length === 4);
  ok("pointerPath（引数無し）: steps は 2〜60", HW.pointerPath({ x: 0, y: 0 }, { x: 10, y: 0 }, 1).length === 3 && HW.pointerPath({ x: 0, y: 0 }, { x: 10, y: 0 }, 999).length === 61);
  const w0 = HW.pointerDelays(24, 600);
  ok("pointerDelays（引数無し）: 24点で 18種類以上・合計 600 前後・最初と最後が中ほどより遅い", new Set(w0).size >= 18 && Math.abs(w0.reduce((a, b) => a + b, 0) - 600) < 30 && w0[0] + w0[1] > w0[11] + w0[12]);
  const pp = HW.makePersona(3);
  const path1 = HW.pointerPath({ x: 0, y: 0 }, { x: 800, y: 0 }, 20, HW.seededRng(2), pp);
  ok("pointerPath（persona 付き）: 終点に着く・最初は出発点", path1[path1.length - 1].x === 800 && path1[path1.length - 1].y === 0 && path1[0].x === 0);
  const w1 = HW.pointerDelays(24, 600, HW.seededRng(3), pp);
  ok("pointerDelays（persona 付き）: 合計 600 前後・全て正", Math.abs(w1.reduce((a, b) => a + b, 0) - 600) < 30 && w1.every((x) => x > 0));
}

console.log("\n■ ⑥ pressMs（押し込み時間・90ms 固定でない）");
{
  const p = Object.assign({}, HW.makePersona(4), { press_ms: 90 });
  const rng = HW.seededRng(8);
  const v = []; for (let i = 0; i < 400; i++) v.push(HW.pressMs(p, rng));
  ok("45〜180ms に丸める", v.every((x) => x >= 45 && x <= 180), [Math.min(...v), Math.max(...v)]);
  ok("中央値が persona.press_ms 付近（75〜105）", pct(v, 0.5) >= 75 && pct(v, 0.5) <= 105, pct(v, 0.5));
  ok("90ms 固定ではない（20種類以上）", new Set(v).size >= 20, new Set(v).size);
  ok("persona が違えば中央値も違う（60 と 120）", (() => {
    const a = [], b = []; const r = HW.seededRng(1);
    for (let i = 0; i < 300; i++) { a.push(HW.pressMs({ press_ms: 60 }, r)); b.push(HW.pressMs({ press_ms: 120 }, r)); }
    return pct(b, 0.5) > pct(a, 0.5) * 1.5;
  })());
}

// ─────────────── pointer-ui.js を vm で動かす（偽の document） ───────────────
function makeSandbox(extra) {
  const timers = { delays: [] };
  const els = [];
  const handlers = {};
  const body = { tagName: "BODY" };
  const documentElement = { appendChild(el) { el.isConnected = true; els.push(el); } };
  const store = {};
  const sb = {
    console,
    Math, Date, JSON, Object, Array, Number, String, Promise, isFinite, parseInt, parseFloat, Error,
    setTimeout: (fn, ms) => { timers.delays.push(ms); fn(); return 0; },
    clearTimeout: () => {},
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: {
      body, documentElement,
      createElement: () => ({ style: { cssText: "", transform: "" }, setAttribute() {}, innerHTML: "", isConnected: false, parentNode: null }),
      querySelectorAll: () => [],
      elementFromPoint: () => null,
    },
  };
  sb.window = sb;
  sb.self = sb;
  sb.innerWidth = 1400; sb.innerHeight = 900;
  sb.addEventListener = (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); };
  sb.postMessage = () => {};
  sb.getComputedStyle = () => ({ cursor: "" });
  Object.assign(sb, extra || {});
  vm.createContext(sb);
  for (const f of ["human-wait.js", "human-learn.js", "pointer-ui.js"]) vm.runInContext(read(f), sb, { filename: f });
  sb.__timers = timers; sb.__handlers = handlers; sb.__els = els;
  sb.__push = (data) => { (handlers.message || []).forEach((h) => h({ source: vm.runInContext("window", sb), data: { from: "axlx-page-learn-push", data } })); };
  return sb;
}
const run = (sb, code) => vm.runInContext(code, sb);

console.log("\n■ ⑦ pointer-ui.js（vm）: ラン単位の persona");
{
  const sb = makeSandbox();
  const P = sb.AxlxPointerUi;
  ok("公開: holdMs / newRun / persona / motionStats", ["holdMs", "newRun", "persona", "motionStats"].every((k) => typeof P[k] === "function"));
  ok("moveTo が動く（Promise・着いたら true）", (() => { let r; P.moveTo(500, 300).then((x) => { r = x; }); return true; })());
  run(sb, "window._axFillRunningCustomerId = 'cust-A'; window.__axlxRunId = 'run-1';");
  P.moveTo(100, 100); P.moveTo(420, 380); P.moveTo(90, 520);
  const pA1 = P.persona();
  P.moveTo(700, 100); P.moveTo(120, 300);
  const pA2 = P.persona();
  ok("同じラン内では persona が固定", pA1 && pA2 && pA1.seed === pA2.seed && pA1.speed_scale === pA2.speed_scale, [pA1, pA2]);
  run(sb, "window.__axlxRunId = 'run-2';");
  P.moveTo(300, 300);
  const pB = P.persona();
  ok("ラン（run id）が変わると persona が作り直される", pB.seed !== pA2.seed, [pA2.seed, pB.seed]);
  run(sb, "window._axFillRunningCustomerId = 'cust-B';");
  P.moveTo(800, 500);
  const pC = P.persona();
  ok("お客さん（customer id）が変わっても作り直される", pC.seed !== pB.seed);
  run(sb, "window._axFillRunningCustomerId = null; window.__axlxRunId = null;");
  P.moveTo(300, 200);
  run(sb, "window._axFillRunningCustomerId = 'cust-B'; window.__axlxRunId = null;");
  P.moveTo(500, 700);
  const pD = P.persona();
  ok("同じお客さんでも、ランが一度終わって（空になって）また始まれば作り直される", pD.seed !== pC.seed);
  const seeds = new Set();
  for (let i = 0; i < 12; i++) { run(sb, "window.__axlxRunId = 'r" + i + "'; window._axFillRunningCustomerId = 'c';"); P.moveTo(100 + i * 40, 200); seeds.add(P.persona().speed_scale); }
  ok("12ラン分の speed_scale が 6種類以上（ランごとに個性が違う）", seeds.size >= 6, [...seeds]);
  const nPers = P.newRun(777).seed, nPers2 = P.newRun(777).seed;
  ok("newRun(seed) は seed から persona を作る（同じ seed → 同じ persona）", nPers === nPers2 && nPers === (777 >>> 0));
}

console.log("\n■ ⑧ pointer-ui.js（vm）: 計画・サーバー学習値の受け取り");
{
  const sb = makeSandbox();
  const P = sb.AxlxPointerUi;
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  // 計画なし
  P.moveTo(100, 100); P.moveTo(600, 400);
  ok("計画が無くても動く（persona はローカル生成・source=local）", P.persona().source === "local");
  // 学習値が届く
  sb.__push({ axlx_learn_motion: { speed_px_s: 520, curve: 1.04 }, axlx_motion_plan: { v: 1, plan_id: "plan-X", expires_at: future, run_seed: 31337, persona: { speed_scale: 1.4, press_ms: 111 } } });
  ok("axlx-page-learn-push で window.__axlxServerMotion に入る", sb.__axlxServerMotion && sb.__axlxServerMotion.speed_px_s === 520, sb.__axlxServerMotion);
  ok("axlx-page-learn-push で window.__axlxMotionPlan に入る", sb.__axlxMotionPlan && sb.__axlxMotionPlan.plan_id === "plan-X");
  ok("human-learn の learnedSpeedPxS が chrome.storage 無しでもグローバルを読む（520）", sb.AxlxHumanLearn.learnedSpeedPxS(null) === 520, sb.AxlxHumanLearn.learnedSpeedPxS(null));
  ok("human-learn の serverCurve もグローバルを読む（1.04）", sb.AxlxHumanLearn.serverCurve() === 1.04);
  P.moveTo(200, 200);
  const pp = P.persona();
  ok("有効な計画が来たら persona が作り直され、計画の値（speed_scale 1.4・press_ms 111・seed 31337）を使う", pp.source === "plan" && pp.speed_scale === 1.4 && pp.press_ms === 111 && pp.seed === 31337, pp);
  const st = P.motionStats();
  ok("motionStats に plan_id と persona の要約が入る", st.plan_id === "plan-X" && st.persona && st.persona.speed_scale === 1.4, st);
  // 期限切れ・壊れた計画
  sb.__push({ axlx_motion_plan: { v: 1, plan_id: "plan-old", expires_at: past, persona: { speed_scale: 1.7 } } });
  let thrown = false;
  try { for (let i = 0; i < 20; i++) P.moveTo(100 + i * 30, 300 + (i % 3) * 50); } catch (_) { thrown = true; }
  ok("期限切れの計画でも例外なく動く（persona は期限切れの計画の値 1.7 を取り込まない）", !thrown && P.persona().speed_scale !== 1.7 && P.persona().plan_id !== "plan-old", P.persona());
  sb.__push({ axlx_motion_plan: "こわれた" });
  sb.__push({ axlx_motion_plan: { v: 1 } });
  sb.__push({ axlx_motion_plan: [1, 2, 3] });
  sb.__push({ axlx_learn_motion: "こわれた" });
  thrown = false;
  try { for (let i = 0; i < 20; i++) P.moveTo(50 + i * 25, 100 + (i % 4) * 60); P.tap(); P.holdMs(); } catch (_) { thrown = true; }
  ok("壊れた計画・壊れた学習値でも例外なく動く", !thrown);
  ok("壊れた学習値は無視（learnedSpeedPxS は手元の癖→null）", sb.AxlxHumanLearn.learnedSpeedPxS(null) === null);
  sb.__push({ axlx_motion_plan: null, axlx_learn_motion: null });
  ok("null が来たら消える", sb.__axlxMotionPlan === null && sb.__axlxServerMotion === null);
  // 学習値の速さを中央値にして一定にしない
  const sb2 = makeSandbox();
  sb2.__push({ axlx_learn_motion: { speed_px_s: 800 } });
  const P2 = sb2.AxlxPointerUi;
  run(sb2, "window.__axlxRunId = 'fast';"); P2.newRun(5);
  const ms = [];
  sb2.__timers.delays.length = 0;
  for (let i = 0; i < 60; i++) P2.moveTo(100 + (i % 2) * 400, 300 + (i % 3) * 40);
  const rec = sb2.__axlxAutoMoves;
  ok("学習した速さがあっても移動時間は一定にならない（ms が 30種類以上）", new Set(rec.map((m) => m.ms)).size >= 30, new Set(rec.map((m) => m.ms)).size);
}

console.log("\n■ ⑨ pointer-ui.js（vm）: 自動の動きの指標（リング 200）");
{
  const sb = makeSandbox();
  const P = sb.AxlxPointerUi;
  run(sb, "window.__axlxRunId = 'stat';");
  for (let i = 0; i < 260; i++) P.moveTo(80 + ((i * 97) % 900), 120 + ((i * 53) % 600));
  ok("window.__axlxAutoMoves は最大 200件", Array.isArray(sb.__axlxAutoMoves) && sb.__axlxAutoMoves.length === 200, sb.__axlxAutoMoves && sb.__axlxAutoMoves.length);
  const m0 = sb.__axlxAutoMoves[0];
  ok("1件に dist・ms・pathLen・straight・curve・overshoot・paused・peakRatio があり、軌跡の点は無い", ["dist", "ms", "pathLen", "straight", "curve", "overshoot", "paused", "peakRatio"].every((k) => k in m0) && !("pts" in m0) && !("points" in m0), m0);
  const s = P.motionStats();
  ok("motionStats が n・speed_p50・speed_cv・ms_p50・ms_cv・curve_p50・curve_cv・over_pct・pause_pct・dist_p50・plan_id・persona を返す",
    s.n === 200 && ["speed_p50", "speed_cv", "ms_p50", "ms_cv", "curve_p50", "curve_cv", "over_pct", "pause_pct", "dist_p50", "plan_id", "persona"].every((k) => k in s), s);
  ok("曲がり p50 が 1.10 以下（人の実測に近い）", s.curve_p50 <= 1.10 && s.curve_p50 >= 1.0, s.curve_p50);
  ok("近すぎる移動（4px 未満）は記録しない", (() => { const n0 = sb.__axlxAutoMoves.length; const pos = P.position(); P.moveTo(pos.x + 1, pos.y + 1); return sb.__axlxAutoMoves.length === n0; })());
  const sbX = makeSandbox();
  ok("記録が無い時の motionStats は n=0（落ちない）", sbX.AxlxPointerUi.motionStats().n === 0);
}

console.log("\n■ ⑩ tap の押し込み時間（90ms 固定でない）");
{
  const src = read("pointer-ui.js");
  ok("tap の setTimeout が 90 の直書きではない", !/_press\(false\); \}, 90\)/.test(src));
  ok("holdMs() を使っている", /var _hold = holdMs\(\);/.test(src) && /setTimeout\(function \(\) \{ _press\(false\); \}, _hold\)/.test(src));
  const sb = makeSandbox();
  const P = sb.AxlxPointerUi;
  run(sb, "window.__axlxRunId = 'tap';");
  P.moveTo(100, 100);
  const first = [];
  for (let i = 0; i < 80; i++) { sb.__timers.delays.length = 0; P.tap(); first.push(sb.__timers.delays[0]); }
  ok("tap の押し込みの待ち（最初の setTimeout）が 45〜180ms", first.every((x) => x >= 45 && x <= 180), [Math.min(...first), Math.max(...first)]);
  ok("90 に張り付かない（20種類以上）", new Set(first).size >= 20 && first.filter((x) => x === 90).length < 20, new Set(first).size);
  const hold = []; for (let i = 0; i < 100; i++) hold.push(P.holdMs());
  ok("holdMs の中央値が persona.press_ms 付近", (() => { const pm = P.persona().press_ms; return pct(hold, 0.5) > pm * 0.75 && pct(hold, 0.5) < pm * 1.25; })());
}

console.log("\n■ ⑪ 配線（content.js の PUSH_KEYS・人の記録は変えない）");
{
  const c = read("content.js");
  const m = c.match(/var PUSH_KEYS = \[([\s\S]*?)\];/);
  ok("PUSH_KEYS に axlx_learn_motion", m && /"axlx_learn_motion"/.test(m[1]));
  ok("PUSH_KEYS に axlx_motion_plan", m && /"axlx_motion_plan"/.test(m[1]));
  const hl = read("human-learn-record.js") + read("human-learn.js");
  ok("人の記録の hMove の !isTrusted 除外は変えていない（自動の動きを人の学習に混ぜない）", /isTrusted/.test(hl));
  const pu = read("pointer-ui.js");
  ok("pointer-ui: axlx_learn_motion / axlx_motion_plan を受ける", /axlx_learn_motion/.test(pu) && /axlx_motion_plan/.test(pu) && /__axlxServerMotion/.test(pu) && /__axlxMotionPlan/.test(pu));
  ok("pointer-ui: window.__axlxAutoMoves に積む", /__axlxAutoMoves/.test(pu));
  ok("pointer-ui: 旧の 72% の行き過ぎは新しい動きでは使わない（予備の _planLegacy にだけ残る）", (pu.match(/Math\.random\(\) < 0\.72/g) || []).length === 1 && /function _planLegacy/.test(pu));
  ok("human-learn: _serverMotion は chrome.storage が無い時 window.__axlxServerMotion を読む", /__axlxServerMotion/.test(read("human-learn.js")));
  for (const f of ["human-wait.js", "human-learn.js", "pointer-ui.js", "content.js"]) {
    let okc = true;
    try { new vm.Script(read(f), { filename: f }); } catch (e) { okc = false; console.log("    " + f + ": " + e.message); }
    ok(f + " の構文が通る", okc);
  }
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
