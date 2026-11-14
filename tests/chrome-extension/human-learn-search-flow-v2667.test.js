// 実行: node tests/chrome-extension/human-learn-search-flow-v2667.test.js
// 2026-11-11 竹内さん「通常モードで検索する際のうごきちゃんと学習されるようになっているのか」
//
// 実際の検索の操作（マウスを動かす → 更新日を押して選ぶ → 賃料を押して選ぶ → 駅を選ぶ →
//   スクロール → 検索ボタンを押す）を**イベントとして流して**、学習に乗るかを確かめる。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 500) : "")); }
}

const L = require(path.join(dir, "human-learn.js"));

/** 画面と document の代わり（人が起こしたイベントだけを流せる） */
function env(opts) {
  const o = opts || {};
  const ls = { doc: {}, win: {} };
  const doc = {
    addEventListener: (t, fn) => { (ls.doc[t] = ls.doc[t] || []).push(fn); },
    removeEventListener: (t, fn) => { ls.doc[t] = (ls.doc[t] || []).filter((f) => f !== fn); },
    documentElement: { scrollHeight: o.pageH || 3000 },
  };
  const win = {
    innerWidth: o.vw || 1200, innerHeight: o.vh || 800, pageYOffset: o.pageY || 0,
    addEventListener: (t, fn) => { (ls.win[t] = ls.win[t] || []).push(fn); },
    removeEventListener: (t, fn) => { ls.win[t] = (ls.win[t] || []).filter((f) => f !== fn); },
  };
  return { doc, win, ls };
}
const fire = (list, ev) => (list || []).forEach((f) => f(ev));

/** 要素（画面のどこにあり、何という名前か） */
function el(name, left, top, w, h, tag) {
  return {
    tagName: tag || "INPUT",
    getAttribute: (a) => (a === "name" ? name : null),
    getBoundingClientRect: () => ({ left, top, width: w, height: h }),
  };
}

console.log("■ ① 検索の一連の操作が学習に乗るか（実際にイベントを流す）");
{
  const e = env();
  let t = 10000;
  const rec = L.create({ now: () => t, doc: e.doc, win: e.win });
  rec.attach(e.doc, e.win);

  // ── 1) 人がマウスを検索の欄へ動かす（いくつかの点・何度か動かす） ──
  for (let round = 0; round < 4; round++) {
    for (const [x, y] of [[300 + round * 20, 500], [450, 380], [600, 300], [720, 250], [800, 210]]) {
      fire(e.ls.doc.mousemove, { isTrusted: true, clientX: x, clientY: y, buttons: 0 });
      t += 45;
    }
    /**
     * ⚠ 2026-11-14: 締まるまでの間を **350ms → 650ms** に伸ばした（細切れを直す・v2.7.66）。
     *   実測で 1回の移動が 376ms・80px しかなく、人の1ストロークになっていなかった。
     *   → このテストの「止まる」も 650ms より長くしないと**締まらない**（旧は 400ms で足りていた）。
     */
    t += 700; // 止まる → 1回の移動として締まる（650ms より長く）
  }
  // ── 2) 更新日をプルダウンで選ぶ（開く→選ぶ） ──
  const upd = el("update_date", 760, 180, 120, 28, "SELECT");
  fire(e.ls.doc.click, { isTrusted: true, target: upd, clientX: 800, clientY: 195 });
  t += 700;
  fire(e.ls.doc.change, { isTrusted: true, target: upd, clientX: 800, clientY: 195 });
  t += 500;

  // ── 3) 賃料を打つ（キー） ──
  const rent = el("rental_cost2", 760, 240, 120, 28);
  fire(e.ls.doc.click, { isTrusted: true, target: rent, clientX: 790, clientY: 255 });
  t += 300;
  for (let i = 0; i < 4; i++) { fire(e.ls.doc.keydown, { isTrusted: true, target: rent, key: "8" }); t += 130; }
  t += 400;

  // ── 4) 駅を選ぶ（チェック） ──
  const st = el("station_id[]", 100, 500, 200, 24);
  fire(e.ls.doc.click, { isTrusted: true, target: st, clientX: 130, clientY: 512 });
  t += 600;

  // ── 5) 画面を動かす（下へ 400px・何度か） ──
  e.win.pageYOffset = 400;
  fire(e.ls.win.wheel, { isTrusted: true, deltaY: 400 });
  t += 800;
  e.win.pageYOffset = 800;
  fire(e.ls.win.wheel, { isTrusted: true, deltaY: 400 });
  t += 800;

  // ── 6) 検索ボタンを押す ──
  const btn = { tagName: "DIV", textContent: "検索", getBoundingClientRect: () => ({ left: 60, top: 700, width: 200, height: 50 }) };
  fire(e.ls.doc.click, { isTrusted: true, target: btn, clientX: 120, clientY: 725 });
  t += 100;

  const det = rec.detail();
  const sum = L.summarize(rec.list());
  const motion = L.summarizeMotion(det);

  ok("操作を覚えた（7回以上）", sum.n >= 7, sum.n);
  ok("クリックを覚えた", sum.kinds.click >= 4, sum.kinds);
  ok("キー（賃料の打鍵）を覚えた", sum.kinds.key >= 1, sum.kinds);
  ok("選択（更新日）を覚えた", sum.kinds.change >= 1, sum.kinds);
  ok("スクロールを覚えた", sum.kinds.scroll >= 1, sum.kinds);

  ok("触った欄の名前を覚えた（update_date）", sum.fields.includes("update_date"), sum.fields);
  ok("触った欄の名前を覚えた（rental_cost2）", sum.fields.includes("rental_cost2"), sum.fields);
  ok("触った順を覚えた（更新日 → 賃料 の順）", sum.order.indexOf("update_date") < sum.order.indexOf("rental_cost2"), sum.order);

  ok("マウスの動きを覚えた（1回以上）", motion.moves.n >= 1, motion.moves.n);
  ok("マウスの速さを測った", typeof motion.moves.speed_px_s === "number" && motion.moves.speed_px_s > 0, motion.moves.speed_px_s);
  ok("曲がり具合を測った", typeof motion.moves.curve === "number" && motion.moves.curve >= 1, motion.moves.curve);
  ok("動きの形（通過点）を持つ", Array.isArray(motion.moves.shapes) && motion.moves.shapes.length >= 1);

  ok("押した場所を覚えた（4回以上）", motion.points.n >= 4, motion.points.n);
  ok("ふだんの押す横の位置を出した", typeof motion.points.x === "number" && motion.points.x > 0 && motion.points.x < 1, motion.points.x);
  ok("欄ごとの押す位置（update_date）", !!motion.points.fields["update_date"], Object.keys(motion.points.fields));
  ok("欄ごとの押す位置（rental_cost2）", !!motion.points.fields["rental_cost2"], Object.keys(motion.points.fields));

  ok("画面の動かし方を覚えた（1回）", motion.scrolls.n >= 1, motion.scrolls.n);
  ok("スクロールの量を覚えた（400px）", motion.scrolls.dy === 400, motion.scrolls.dy);
  ok("どこまで送ったかを覚えた（400/(3000-800)≒0.18）", motion.scrolls.y_samples.includes(0.18), motion.scrolls.y_samples);
  ok("2回目の位置も覚えた（800/(3000-800)≒0.36）", motion.scrolls.y_samples.includes(0.36), motion.scrolls.y_samples);
  ok("下へ動かした回を数えた", motion.scrolls.down >= 1, motion.scrolls.down);

  // 貯める形 → 自動モードに使う値
  const agg = L.mergeAggregate(null, Object.assign({ n: sum.n, kinds: sum.kinds, gaps: sum.gaps, fields: sum.fields, order: sum.order }, motion));
  const prof = L.profileFrom(agg);
  ok("貯める形にして癖を作れる", !!prof, prof);
  ok("速さが癖に入る", prof && prof.speed_px_s > 0, prof && prof.speed_px_s);
  ok("押す位置が癖に入る", prof && prof.aim && prof.aim.x > 0, prof && prof.aim);
  ok("スクロール量が癖に入る（400px）", prof && prof.scroll_dy === 400, prof && prof.scroll_dy);

  // 1回だけでは癖を作らない（急に動きが変わらない＝安全側）
  const once = L.summarizeMotion({ moves: [{ ms: 400, dist: 500, px_s: 1250, curve: 1.1, shape: [[0.1, 0.2], [0.5, 0.6]] }], points: [{ f: "x", x: 0.3, y: 0.5 }], scrolls: [{ dy: 300, dir: "down", y: 0.1 }] });
  ok("実測が1回ずつでは癖を作らない（材料不足）", L.profileFrom(Object.assign({ n: 5, kinds: { click: 5 }, gaps: [], fields: [], order: [] }, once)) === null);

  // 1行の報告に出る
  const line = L.reportLine(agg);
  ok("1行の報告に操作・マウス・押した所・スクロールが出る", /人の動き:/.test(line) && /マウス/.test(line) && /押した所/.test(line) && /スクロール/.test(line), line);
}

console.log("\n■ ② 拡張の動き（拡張が押した物）は学習に混ざらない");
{
  const e = env();
  let t = 20000;
  const rec = L.create({ now: () => t, doc: e.doc, win: e.win });
  rec.attach(e.doc, e.win);
  const b = el("search", 100, 100, 80, 30, "BUTTON");
  // 拡張が dispatch した物（isTrusted === false）
  for (let i = 0; i < 5; i++) {
    fire(e.ls.doc.click, { isTrusted: false, target: b, clientX: 140, clientY: 115 });
    fire(e.ls.doc.mousemove, { isTrusted: false, clientX: 200 + i * 50, clientY: 200, buttons: 0 });
    t += 100;
  }
  t += 500;
  const det = rec.detail();
  ok("拡張のクリックは覚えない", rec.list().length === 0, rec.list().length);
  ok("拡張のマウス移動は覚えない", det.moves.length === 0, det.moves.length);
  ok("拡張の押した場所は覚えない", det.points.length === 0, det.points.length);
}

console.log("\n■ ③ 3つのサイト全部で学習が動く（読み込みの設定）");
{
  const mf = JSON.parse(read("manifest.json"));
  const recCs = mf.content_scripts.find((c) => (c.js || []).includes("human-learn-record.js"));
  ok("human-learn-record.js が content script にある", !!recCs);
  for (const m of ["https://www.realnetpro.com/*", "https://realnetpro.com/*", "https://itandibb.com/*", "https://system.reins.jp/*"]) {
    ok(`  ${m} で学習する`, recCs.matches.includes(m));
  }
  const firstCs = mf.content_scripts[0];
  ok("純関数 human-learn.js は先頭（document_start）で読む（カーソルより前）", firstCs.js.indexOf("human-learn.js") >= 0 && firstCs.js.indexOf("human-learn.js") < firstCs.js.indexOf("pointer-ui.js"));
  ok("送る係 human-learn-upload.js も同じ段にある", recCs.js.includes("human-learn-upload.js"));
}

console.log("\n■ ④ DB に届く（送る側の設定）");
{
  const up = read("human-learn-upload.js"), bg = read("background.js");
  ok("記録が増えたら送る", /ch\[KEY\]\.newValue/.test(up) && /maybeUpload\(\)/.test(up));
  ok("5分は送らない（叩きすぎない）", /MIN_GAP_MS = 5 \* 60 \* 1000/.test(up));
  ok("画面を開いた時にも1回送る", /setTimeout\(maybeUpload, wait\)/.test(up));
  ok("background が鍵を付けて /api/human-motion へ送る", /type === "axlx-human-motion"/.test(bg) && /\/api\/human-motion/.test(bg));
  ok("送り先の表は human_motion_learn", fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "human-motion", "route.ts"), "utf8").includes('from("human_motion_learn").insert'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
