// 実行: node tests/chrome-extension/human-learn-motion-v2665.test.js
// 2026-11-11 竹内さん「普通モードでのマウスの動かし方やボタンのどこ押すかもちゃんとたまるんかな。画面のうごかしかたも」
//   ① マウスの動きを覚える（距離・時間・速さ・曲がり・形・始点終点）
//   ② ボタンのどこを押したかを覚える（要素の中の0〜1の割合・欄ごとの癖）
//   ③ 画面の動かし方を覚える（1回の量・向き・ページ内の位置）
//   ④ 集計して貯める形にできる（傾向＋見本）・前と合わせられる
//   ⑤ 人が起こした操作だけ（拡張の dispatch は覚えない）・値（中身）は残さない
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

/** 画面と document の代わり（イベントを手で起こせる最小の物） */
function fakeEnv(vw, vh, pageY, pageH) {
  const listeners = { doc: {}, win: {} };
  const doc = {
    addEventListener: (t, fn) => { (listeners.doc[t] = listeners.doc[t] || []).push(fn); },
    removeEventListener: (t, fn) => { listeners.doc[t] = (listeners.doc[t] || []).filter((f) => f !== fn); },
    documentElement: { scrollHeight: pageH },
  };
  const win = {
    innerWidth: vw, innerHeight: vh, pageYOffset: pageY,
    addEventListener: (t, fn) => { (listeners.win[t] = listeners.win[t] || []).push(fn); },
    removeEventListener: (t, fn) => { listeners.win[t] = (listeners.win[t] || []).filter((f) => f !== fn); },
  };
  return { doc, win, listeners };
}
const fire = (list, ev) => (list || []).forEach((f) => f(ev));

console.log("■ ① マウスの動かし方を覚える");
{
  let t = 1000;
  const env = fakeEnv(1200, 800, 0, 3000);
  const rec = L.create({ now: () => t, doc: env.doc, win: env.win });
  rec.attach(env.doc, env.win);

  // 人が右へ動かす（途中で下へ曲がる＝まっすぐではない）
  const pts = [[100, 100], [160, 110], [220, 150], [260, 220], [280, 300]];
  for (const [x, y] of pts) { fire(env.listeners.doc.mousemove, { isTrusted: true, clientX: x, clientY: y, buttons: 0 }); t += 40; }
  t += 500; // 指を止める → 締める
  const d1 = rec.detail();
  ok("1回の移動として覚える", d1.moves.length === 1, d1.moves);
  const m = d1.moves[0];
  ok("時間を測る（40ms×4＝160ms）", m.ms === 160);
  ok("動いた距離を測る（区間の合計がまっすぐより長い）", m.dist >= 250, m.dist);
  ok("速さ（px/秒）を出す", m.px_s > 1000 && m.px_s < 3000, m.px_s);
  ok("曲がり具合（1.0より大きい＝曲がった）", m.curve > 1.05, m.curve);
  ok("始点と終点を画面の％で持つ", m.from.x === Math.round((100 / 1200) * 100) / 100 && m.to.y === Math.round((300 / 800) * 100) / 100, [m.from, m.to]);
  ok("形（通過点）を覚える", Array.isArray(m.shape) && m.shape.length >= 2);
  ok("ドラッグではない", m.drag === false);

  // まっすぐ動かすと曲がりは1.0に近い
  rec.reset(); t += 1000;
  for (let i = 0; i <= 4; i++) { fire(env.listeners.doc.mousemove, { isTrusted: true, clientX: 100 + i * 50, clientY: 300, buttons: 0 }); t += 30; }
  t += 500;
  const m2 = rec.detail().moves[0];
  ok("まっすぐ動くと曲がりは 1.0", m2.curve === 1, m2.curve);

  // 押しながら動かす＝ドラッグとして区別
  rec.reset(); t += 1000;
  for (let i = 0; i <= 3; i++) { fire(env.listeners.doc.mousemove, { isTrusted: true, clientX: 200 + i * 40, clientY: 400, buttons: 1 }); t += 30; }
  t += 500;
  ok("押しながらの動きはドラッグとして覚える", rec.detail().moves[0].drag === true);

  // 拡張が起こした動きは覚えない
  rec.reset(); t += 1000;
  fire(env.listeners.doc.mousemove, { isTrusted: false, clientX: 10, clientY: 10, buttons: 0 });
  t += 40;
  fire(env.listeners.doc.mousemove, { isTrusted: false, clientX: 50, clientY: 50, buttons: 0 });
  t += 500;
  ok("拡張の動き（isTrusted=false）は覚えない", rec.detail().moves.length === 0);
}

console.log("\n■ ② ボタンのどこを押したかを覚える");
{
  let t = 2000;
  const env = fakeEnv(1200, 800, 0, 3000);
  const rec = L.create({ now: () => t, doc: env.doc, win: env.win });
  rec.attach(env.doc, env.win);

  // 100x40 のボタンの左寄り（20%, 50%）を押す
  const btn = {
    tagName: "BUTTON", textContent: "検索",
    getBoundingClientRect: () => ({ left: 500, top: 300, width: 100, height: 40 }),
  };
  fire(env.listeners.doc.click, { isTrusted: true, target: btn, clientX: 520, clientY: 320 });
  const p = rec.detail().points;
  ok("押した場所を覚える", p.length === 1, p);
  ok("横は要素の中の割合（20%）", p[0].x === 0.2, p[0].x);
  ok("縦は要素の中の割合（50%）", p[0].y === 0.5, p[0].y);
  ok("どの要素か残す（押した文字）", p[0].f === "検索", p[0].f);
  ok("大きさも残す", p[0].w === 100 && p[0].h === 40);

  // 枠の外（別の要素の上）の座標は捨てる
  fire(env.listeners.doc.click, { isTrusted: true, target: btn, clientX: 900, clientY: 900 });
  ok("要素の枠の外の座標は覚えない", rec.detail().points.length === 1);
}

console.log("\n■ ③ 画面の動かし方を覚える");
{
  const env = fakeEnv(1200, 800, 0, 4000);
  const rec = L.create({ now: () => 3000, doc: env.doc, win: env.win });
  rec.attach(env.doc, env.win);
  // 下へ 300px（全体 4000・見えている 800 → 動かせる幅 3200）
  env.win.pageYOffset = 300;
  fire(env.listeners.win.wheel, { isTrusted: true, deltaY: 300 });
  const s = rec.detail().scrolls;
  ok("1回のスクロールを覚える", s.length === 1, s);
  ok("量を覚える（300px）", s[0].dy === 300);
  ok("向きを覚える（下）", s[0].dir === "down");
  ok("ページ内のどこまで送ったかを覚える（300/3200≒0.09）", s[0].y === 0.09, s[0].y);
  // 上へ
  env.win.pageYOffset = 100;
  fire(env.listeners.win.wheel, { isTrusted: true, deltaY: -200 });
  const s2 = rec.detail().scrolls;
  ok("上へ動かしたのも覚える", s2[1].dir === "up" && s2[1].dy === -200);
  // 拡張のスクロールは覚えない
  fire(env.listeners.win.wheel, { isTrusted: false, deltaY: 500 });
  ok("拡張のスクロールは覚えない", rec.detail().scrolls.length === 2);
}

console.log("\n■ ④ 集計して貯める形にできる（傾向＋見本）");
{
  const det = {
    moves: [
      { ms: 400, dist: 500, px_s: 1250, peak_px_s: 900, curve: 1.2, from: { x: 0.1, y: 0.2 }, to: { x: 0.5, y: 0.6 }, drag: false, shape: [[0.1, 0.2], [0.5, 0.6]] },
      { ms: 600, dist: 700, px_s: 1167, peak_px_s: 800, curve: 1.4, from: { x: 0.2, y: 0.3 }, to: { x: 0.7, y: 0.8 }, drag: true, shape: [[0.2, 0.3], [0.7, 0.8]] },
    ],
    points: [
      { f: "検索", x: 0.2, y: 0.5, w: 100, h: 40 },
      { f: "検索", x: 0.3, y: 0.6, w: 100, h: 40 },
      { f: "rental_cost2", x: 0.5, y: 0.5, w: 120, h: 30 },
    ],
    scrolls: [
      { dy: 300, dir: "down", y: 0.09 },
      { dy: 200, dir: "down", y: 0.15 },
      { dy: -100, dir: "up", y: 0.1 },
    ],
  };
  const sm = L.summarizeMotion(det);
  ok("マウス: 回数を数える", sm.moves.n === 2);
  ok("マウス: ふだんの速さ（中央値 1167〜1250の間）", sm.moves.speed_px_s >= 1167 && sm.moves.speed_px_s <= 1250, sm.moves.speed_px_s);
  ok("マウス: 曲がり具合（中央値 1.2〜1.4）", sm.moves.curve >= 1.2 && sm.moves.curve <= 1.4, sm.moves.curve);
  ok("マウス: 押しながら動かした回", sm.moves.drag_n === 1);
  ok("マウス: 形の見本を持つ", sm.moves.shapes.length === 2);
  ok("押した場所: 横の癖（検索は0.2と0.3→0.25）", sm.points.fields["検索"].x === 0.25, sm.points.fields["検索"]);
  ok("押した場所: 欄ごとに分ける", !!sm.points.fields["rental_cost2"]);
  ok("押した場所: 全体の縦の癖", sm.points.y === 0.5, sm.points.y);
  ok("スクロール: 1回の量（中央値 200）", sm.scrolls.dy === 200, sm.scrolls.dy);
  ok("スクロール: 下と上の回数", sm.scrolls.down === 2 && sm.scrolls.up === 1);
  ok("スクロール: よく居る位置", sm.scrolls.y === 0.1, sm.scrolls.y);

  // 前と合わせる
  const base = L.mergeAggregate(null, Object.assign({ n: 3, kinds: { click: 3 }, gaps: [300], fields: ["検索"], order: ["検索"] }, sm));
  ok("貯める形に入る（moves・points・scrolls）", base.moves.n === 2 && base.points.n === 3 && base.scrolls.n === 3);
  const next = L.mergeAggregate(base, Object.assign({ n: 1, kinds: { click: 1 }, gaps: [500], fields: ["検索"], order: ["検索"] }, L.summarizeMotion(det)));
  ok("2回目と合わせて回数が増える", next.moves.n === 4 && next.points.n === 6 && next.scrolls.n === 6);
  ok("合わせても曲がり具合は 1.0〜1.5 の範囲", next.moves.curve >= 1.0 && next.moves.curve <= 1.5, next.moves.curve);
  ok("形の見本は上限6本まで", next.moves.shapes.length <= 6);
  ok("欄ごとの癖は残る", !!next.points.fields["検索"] && !!next.points.fields["rental_cost2"]);

  // 1行・説明
  ok("1行の報告にマウス・押した所・スクロールが入る", /マウス 4回分/.test(L.reportLine(next)) && /押した所/.test(L.reportLine(next)) && /スクロール 6回/.test(L.reportLine(next)), L.reportLine(next));
  const desc = L.describe(next);
  ok("説明（人に見せる）に3つとも出る", desc.some((x) => /マウス/.test(x)) && desc.some((x) => /押した場所/.test(x)) && desc.some((x) => /画面の動かし方/.test(x)));
  ok("中身（値）は持たない（座標と欄の名前だけ・入力した文字や数字は無い）", (() => {
    const keys = new Set();
    JSON.stringify(next, (k, v) => { if (k) keys.add(k); return v; });
    // 値の入れ物になる名前を持たないこと（value / text / val / input）
    //   ※ v は「記録の版」の番号、x / y は座標の割合なので除く
    return !keys.has("value") && !keys.has("text") && !keys.has("val") && !keys.has("input");
  })());
}

console.log("\n■ ⑤ 記録する側（録る・貯める・見える）");
{
  const rec = read("human-learn-record.js");
  ok("記録する器に document と window を渡す（大きさ・位置を測るため）", /L\.create\(\{[\s\S]{0,200}doc: document, win: window/.test(rec));
  ok("動き・押した場所・スクロールも集計して貯める", /summarizeMotion\(det\)/.test(rec) && /add\.moves = motion\.moves/.test(rec));
  ok("貯めたら操作と動きをまとめて空にする", /rec\.reset\(\); \/\/ 操作・動き・押した場所・スクロールをまとめて空にする/.test(rec));
  ok("画面の印に貯まっている数を出す（増えるのが見える）", /👀 学習中 操作/.test(rec) && /マウス" \+ \(det\.moves \|\| \[\]\)\.length/.test(rec));
  ok("1分ごとに印を更新する", /paintBadge\(\);/.test(rec));
  ok("外から中身を見られる（__axlxHumanLearnReport）", /detail: det,/.test(rec) && /summarizeMotion: function/.test(rec));
  ok("通常・スタッフの時だけ覚える（自動・AIX は覚えない）", /function shouldLearn\(st\)/.test(rec));
  ok("値（入力の中身）は記録に載せない旨が残る", /入力した中身（値）は残さない/.test(read("human-learn.js")));
}

console.log("\n■ ⑥ 拡張の小窓で貯まった物を見られる");
{
  const html = read("popup.html"), pp = read("popup.js");
  ok("popup.html に「👀 学習」のボタンがある", /id="learn-report-btn"/.test(html));
  ok("popup.html が human-learn.js を popup.js より前に読む", html.indexOf('src="human-learn.js"') > 0 && html.indexOf('src="human-learn.js"') < html.indexOf('src="popup.js"'));
  ok("押すと覚えた物の説明を出す（describe）", /initLearnReport/.test(pp) && /L\.describe\(agg\)/.test(pp));
  ok("貯まった回数をボタンに出す（👀 学習 N）", /"👀 学習 " \+ n/.test(pp));
  ok("もう一度押すと閉じる", /if \(old\) \{ old\.remove\(\); return; \}/.test(pp));
  ok("中身（値）は覚えていないと書いてある", /入力した中身（文字・数字）は覚えていません/.test(pp));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
