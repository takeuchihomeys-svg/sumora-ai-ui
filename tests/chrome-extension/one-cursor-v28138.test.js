// tests/chrome-extension/one-cursor-v28138.test.js
// 実行: node tests/chrome-extension/one-cursor-v28138.test.js
// 2026-11-20 竹内さん「マウスの色や選択するときのマウスの形が実際の人間の形と違う」
//   「同時に２つマウス出現しないように…実際の人間のように1つのマウスでおこなう」
//
//   pointer-ui.js はリアプロ・ITANDI で2つの世界（content script と、content.js がページへ入れる方）で別々に動く。
//   ここでは**同じ小さなページ**を2つの世界で共有して、実際の関数を動かして確かめる。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");
const dir = path.join(__dirname, "..", "..");
const file = process.env.AXLX_PU_FILE || path.join(dir, "chrome-extension", "pointer-ui.js");
const code = fs.readFileSync(file, "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 小さなページ（2つの世界で共有） ──
function mkClassList() {
  const s = new Set();
  return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) };
}
const doc = {};
function mkEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), attrs: {}, style: {}, children: [], parentNode: null, classList: mkClassList(),
    innerHTML: "", _cursor: "auto",
    get isConnected() { let p = this.parentNode; while (p) { if (p === doc.documentElement) return true; p = p.parentNode; } return false; },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : (k === "id" && this.id ? this.id : null); },
    hasAttribute(k) { return k in this.attrs; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    dispatchEvent() { return true; },
    getBoundingClientRect() { return this.rect || { left: 0, top: 0, width: 0, height: 0 }; },
    closest() { return null; },
  };
  return el;
}
doc.documentElement = mkEl("html");
doc.head = mkEl("head"); doc.documentElement.appendChild(doc.head);
doc.body = mkEl("body"); doc.documentElement.appendChild(doc.body);
function walk(el, out) { out.push(el); for (const c of el.children) walk(c, out); return out; }
doc.getElementById = (id) => walk(doc.documentElement, []).find((e) => e.id === id) || null;
doc.querySelectorAll = (sel) => { const id = String(sel).replace(/^#/, ""); return walk(doc.documentElement, []).filter((e) => e.id === id); };
doc.createElement = (t) => mkEl(t);
let under = null;
doc.elementFromPoint = () => under;

const listeners = [];
const store = {};
const sessionStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
function getComputedStyle(el) {
  if (doc.documentElement.classList.contains("axlx-one-cursor")) return { cursor: "none" };
  return { cursor: el && el._cursor ? el._cursor : "auto" };
}
class MouseEvent { constructor(type, o) { this.type = type; Object.assign(this, o || {}); } }

function world() {
  const ctx = {
    document: doc, setTimeout, clearTimeout, Date, Math, JSON, WeakMap, MouseEvent, sessionStorage, getComputedStyle,
    innerWidth: 1200, innerHeight: 800, isFinite, Number, String, Promise,
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    postMessage: () => {},
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: "pointer-ui.js" });
  return ctx.AxlxPointerUi;
}
function realMouse(type, x, y, mv) {
  const e = { type, isTrusted: true, clientX: x, clientY: y, movementX: mv, movementY: mv };
  for (const l of listeners) if (l.type === type) l.fn(e);
}

(async () => {
  console.log("■ ① 構文");
  {
    let okc = true;
    try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }); } catch { okc = false; }
    ok("pointer-ui.js の構文が通る", okc);
  }

  const A = world();   // ページの世界（page-script の自動）
  const B = world();   // content script の世界（bulk-dl・記録側）

  console.log("\n■ ② 見た目は Windows の標準カーソル（白い矢印・黒い縁）");
  {
    A.ensure();
    const cur = doc.getElementById("axlx-fake-cursor");
    ok("矢印は白く塗って黒い縁", /fill="#fff" stroke="#000"/.test(cur.innerHTML), cur.innerHTML.slice(0, 160));
    ok("旧の黒い矢印（fill #111）は無い", !/fill="#111"/.test(code));
    ok("押しても縮まない（scale を付けない）", !/scale\(/.test(code));
  }

  console.log("\n■ ③ カーソルは1つ・2つの世界で同じ位置を使う");
  {
    await A.moveTo(300, 200);
    const pa = A.position();
    ok("A が動いた先", Math.abs(pa.x - 300) < 1 && Math.abs(pa.y - 200) < 1, pa);
    B.ensure();
    ok("要素は1つだけ", doc.querySelectorAll("#axlx-fake-cursor").length === 1);
    const pb = B.position();
    ok("B は A が動かした所を知っている（自分の古い位置から飛ばない）", Math.abs(pb.x - 300) < 1 && Math.abs(pb.y - 200) < 1, pb);
    const vb = B.visiblePosition();
    ok("記録側（B）の押した位置も A の位置", vb && Math.abs(vb.x - 300) < 1, vb);
  }

  console.log("\n■ ④ 片方が動いている間、もう片方は待つ（同時に2つ動かない）");
  {
    const pA = A.moveTo(900, 600);
    await sleep(15);
    const el = doc.getElementById("axlx-fake-cursor");
    ok("A が動いている間は data-busy が付く", /^p[a-z0-9]+:\d+$/.test(String(el.getAttribute("data-busy"))), el.attrs);
    let bStartedAt = 0, aDoneAt = 0;
    const pB = B.moveTo(100, 650).then(() => { bStartedAt = bStartedAt || Date.now(); });
    const xs = [];
    let aDone = false;
    const watch = setInterval(() => { if (!aDone) xs.push(Number(el.getAttribute("data-x"))); }, 5);
    await pA; aDone = true; aDoneAt = Date.now();
    await pB;
    clearInterval(watch);
    // A は 300→900（右へ）。B が割り込むと A の途中で 100 側（左）へ引っぱられる
    const pulledLeft = xs.filter((x) => x < 280).length;
    ok("A が着くまで B は動き出さない（A の途中で左へ引っぱられない）", xs.length > 5 && pulledLeft === 0, { pulledLeft, n: xs.length });
    const pbEnd = B.position();
    ok("B は A の着いた所から動いて着いた", Math.abs(pbEnd.x - 100) < 1 && Math.abs(pbEnd.y - 650) < 1, pbEnd);
    ok("動き終わったら data-busy は外れる", !el.hasAttribute("data-busy"), el.attrs);
  }

  console.log("\n■ ⑤ 見えるカーソルの間は OS のカーソルを隠す／人が本物のマウスを動かしたら逆");
  {
    const el = doc.getElementById("axlx-fake-cursor");
    ok("見えるカーソルが出ている間は OS カーソルを隠す class", doc.documentElement.classList.contains("axlx-one-cursor"));
    ok("隠す CSS は cursor:none", /cursor:none!important/.test((doc.getElementById("axlx-one-cursor-style") || {}).textContent || ""));
    realMouse("mousemove", 700, 120, 0);
    ok("スクロール後の動き0の mousemove では切り替えない", doc.documentElement.classList.contains("axlx-one-cursor") && el.style.opacity !== "0");
    realMouse("mousemove", 700, 120, 3);
    ok("人が本物のマウスを動かすと OS カーソルが戻る", !doc.documentElement.classList.contains("axlx-one-cursor"));
    ok("同時に見えるカーソルは隠れる（2つにならない）", el.style.opacity === "0");
    ok("隠れている間は記録側の位置を返さない（人の押しを自動の位置で書かない）", B.visiblePosition() === null);
    const pm = A.moveTo(720, 160);
    const firstX = Number(el.getAttribute("data-x")), firstY = Number(el.getAttribute("data-y"));
    ok("本物のマウスが居た所から動き出す（1つのマウスに見える）", Math.abs(firstX - 700) <= 3 && Math.abs(firstY - 120) <= 3, { firstX, firstY });
    await pm;
    ok("次に自動が動くと見えるカーソルが戻り OS カーソルを隠す", el.style.opacity === "1" && doc.documentElement.classList.contains("axlx-one-cursor"));
  }

  console.log("\n■ ⑥ 見えている時は出だしで瞬間移動しない（本物のマウスは飛ばない）");
  {
    const before = A.position();
    const r = A.scatter(50, 50);
    const after = A.position();
    ok("scatter は見えている時は何もしない", r === false && after.x === before.x && after.y === before.y, { r, before, after });
  }

  console.log("\n■ ⑦ 形はページが出す形（CSS の cursor）に合わせる");
  {
    const el = doc.getElementById("axlx-fake-cursor");
    const btn = mkEl("div"); btn._cursor = "pointer"; under = btn;
    A.tap();
    ok("cursor:pointer の上は手（白い手）", el.getAttribute("data-axlx-shape") === "hand" && /fill="#fff"/.test(el.innerHTML), el.getAttribute("data-axlx-shape"));
    const sel = mkEl("select"); under = sel;
    A.tap();
    ok("select（cursor:auto）の上は矢印（旧は名前で手にしていた）", el.getAttribute("data-axlx-shape") === "arrow");
    const chk = mkEl("input"); chk.type = "checkbox"; chk.setAttribute("name", "city_code[]"); under = chk;
    A.tap();
    ok("区のチェック欄も CSS が auto なら矢印", el.getAttribute("data-axlx-shape") === "arrow");
    const txt = mkEl("input"); txt.type = "text"; under = txt;
    A.tap();
    ok("文字を打つ欄の上は I の形", el.getAttribute("data-axlx-shape") === "ibeam");
    const lab = mkEl("label"); lab._cursor = "pointer"; lab.setAttribute("class", "one_city"); under = lab;
    A.tap();
    ok("CSS が pointer のラベルは手", el.getAttribute("data-axlx-shape") === "hand");
    ok("形を読む時は OS カーソルを隠す class を外して読む（none を読まない）", doc.documentElement.classList.contains("axlx-one-cursor"));
    ok("名前で手にする旧の決め打ちは無い", !/city_code\|town_code\|station\|route_id\|go_search/.test(code));
    under = null;
  }

  console.log("\n■ ⑧ 消す時は OS カーソルも戻す");
  {
    A.hide();
    ok("hide で OS カーソルが戻る", !doc.documentElement.classList.contains("axlx-one-cursor"));
  }

  console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
  if (failed > 0) process.exit(1);
})();
