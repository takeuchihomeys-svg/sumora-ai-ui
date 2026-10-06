// 実行: node tests/chrome-extension/list-speed-v2587.test.js
// 2026-10-07 v2.5.87 竹内「拡張ツールのお客さん一覧が表示されるときかなり重い　原因をみつける　すべてのお客さんのデータを一気によみとっているから重い可能性ある
//   （その場合うえから最新○件）読むなどおこなえば、かなり効率よくなる可能性がある」
//   測った原因: 一覧の1行ごとの「駅／地域」の札（computeAreaModeBadgeHtml → parseAreaTokens）が 326人で 約0.8〜0.9秒・一覧を描くたび（開いた時・取り直し・検索欄の1文字ごと）。
//   直し: ①札を希望エリアの文字ごとに覚える（開き直しても・表が変われば捨てる）②上から40人を先に描き残りは40人ずつ足す ③折りたたみの中は開いた時に描く
//         ④前回の一覧が無い時は最新50人＋📌の人を先に頼む（?view=list&limit=50）⑤サーバーは重い列を DB から読まない
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || detail === undefined ? "" : "\n      " + JSON.stringify(detail).slice(0, 300))); }

// ── popup の実物（popup.html の順に読む）を DOM の代わりの小さな物で動かす ──
function loadPopup() {
  function stub() { const f = function () { return stub(); }; return new Proxy(f, { get(t, k) { if (k === Symbol.toPrimitive) return () => ""; if (k === "then") return undefined; if (k === "length") return 0; if (k === "value") return ""; return stub(); }, set() { return true; }, apply() { return stub(); } }); }
  function mkEl(id) {
    return { id, innerHTML: "", style: {}, value: "", scrollTop: 0, dataset: {}, isConnected: true, textContent: "", className: "", kids: [],
      classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll() { return []; }, addEventListener() {},
      appendChild(c) { this.kids.push(c); c.isConnected = true; }, insertBefore(c, ref) { const i = this.kids.indexOf(ref); this.kids.splice(i < 0 ? this.kids.length : i, 0, c); c.isConnected = true; },
      remove() { this.isConnected = false; } };
  }
  const els = {};
  const document = { getElementById(id) { return els[id] || (els[id] = mkEl(id)); }, querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {}, createElement() { return mkEl("x"); }, body: stub(), visibilityState: "visible" };
  const saved = {};
  const storage = { get(k, cb) { const o = {}; (Array.isArray(k) ? k : [k]).forEach((x) => { if (x in saved) o[x] = saved[x]; }); cb && cb(o); return Promise.resolve(o); }, set(o) { Object.assign(saved, o); }, remove() {}, onChanged: { addListener() {} } };
  const chrome = { storage: { local: storage, session: storage, sync: storage, onChanged: { addListener() {} } }, runtime: { sendMessage() {}, onMessage: { addListener() {} }, getURL: (x) => x, id: "x", getManifest: () => ({ version: "2.5.87" }) }, tabs: stub() };
  const queue = [];
  const ctx = { console: { log() {}, warn() {}, error() {} }, document, chrome, setTimeout: (f) => { queue.push(f); return 1; }, clearTimeout() {}, setInterval() {}, fetch: () => new Promise(() => {}),
    sessionStorage: { getItem() { return null; }, setItem() {} }, localStorage: { getItem() { return null; }, setItem() {} }, navigator: { userAgent: "x" }, location: { href: "" }, URL, Date, Math, JSON, Promise, Map, Set };
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx; ctx.parent = ctx; ctx.addEventListener = () => {}; ctx.postMessage = () => {};
  vm.createContext(ctx);
  const html = read("popup.html");
  for (const s of [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])) {
    if (s === "snapshot-popup.js") continue;
    vm.runInContext(read(s), ctx, { filename: s });
  }
  queue.length = 0;
  return { ctx, els, queue, saved, run: (code) => vm.runInContext(code, ctx) };
}

const AREAS = ["梅田・中津・天満", "大阪市北区", "江坂・緑地公園", "大阪市中央区・大阪市西区", "なんば・日本橋", "天王寺区", "新大阪、東三国", "堺筋線沿線・梅田・東梅田・北新地・江坂", "吹田市", "本町・堺筋本町"];
function makeCustomers(n, extra) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(Object.assign({ id: "c" + i, customer_name: "お客様" + i, status: i % 3 ? "property_search" : "hot", desired_area: AREAS[i % AREAS.length], rent_max: 80000 + (i % 5) * 5000, floor_plan: "1K", is_linked: true, linked_conversation: { id: "v" + i, is_flagged: i % 2 === 0, status: "active" }, search_history: null, list_view: true }, extra ? extra(i) : {}));
  }
  return out;
}
const rowsIn = (h) => (h.match(/class="customer-item/g) || []).length;
const idsIn = (h) => [...h.matchAll(/class="customer-item[^"]*" data-id="([^"]+)"/g)].map((m) => m[1]);
function drain(p) { const t = []; while (p.queue.length) { const f = p.queue.shift(); f(); t.push(1); } return t.length; }
function allHtml(list) { return list.innerHTML + list.kids.filter((k) => k.isConnected && k.className === "axlx-rows-chunk").map((k) => k.innerHTML).join(""); }

console.log("── ① 上から40人を先に描き、残りは40人ずつ足す（並び・人数は今まで通り）");
{
  const p = loadPopup();
  p.ctx.__c = makeCustomers(120);
  p.run("allCustomers = __c; linkedOnly = true;");
  const list = p.ctx.document.getElementById("customer-list");
  p.run('filterCustomers("")');
  ok("最初は40人だけ描く", rowsIn(list.innerHTML) === 40, rowsIn(list.innerHTML));
  ok("区切りの人数は全員（🔗 紐付け済み (120人)）", /紐付け済み \(120人\)/.test(list.innerHTML));
  const more = list.kids.find((k) => /axlx-list-more/.test(k.className));
  ok("下に「残り 80人を表示中…」", more && more.textContent === "残り 80人を表示中…", more && more.textContent);
  const steps = drain(p);
  ok("40人ずつ2回で全員（止まらずに下まで）", steps === 2 && rowsIn(allHtml(list)) === 120, [steps, rowsIn(allHtml(list))]);
  ok("描き終えたら「残り」の表示は消える", more && more.isConnected === false);
  const progressive = idsIn(allHtml(list));
  list.kids = []; list.scrollTop = 300; // 見ていた場所を戻す描き直し → 全部を1回で
  p.run('filterCustomers("")');
  ok("スクロールしている時の描き直しは全部を1回で描く（場所が戻る）", rowsIn(list.innerHTML) === 120 && p.queue.length === 0);
  ok("並びは全部を1回で描いた時と同じ", JSON.stringify(idsIn(list.innerHTML)) === JSON.stringify(progressive));
}

console.log("── ② 📌 会話から物件検索の人は数に入れず必ず先に・描き直しが始まったら前の続きは捨てる");
{
  const p = loadPopup();
  const at = new Date().toISOString();
  p.ctx.__c = makeCustomers(100, (i) => (i >= 90 ? { search_focus: { at, by: null, device: "phone" } } : {}));
  p.run("allCustomers = __c; linkedOnly = true;");
  const list = p.ctx.document.getElementById("customer-list");
  p.run('filterCustomers("")');
  const ids = idsIn(list.innerHTML);
  ok("📌 の10人は一番上に全員（一覧の下の方の人でも）", ids.slice(0, 10).every((x) => Number(x.slice(1)) >= 90) && /📌 会話から物件検索 \(10人\)/.test(list.innerHTML), ids.slice(0, 12));
  ok("📌 の後に普通の40人", rowsIn(list.innerHTML) === 50, rowsIn(list.innerHTML));
  const stale = p.queue.length;
  list.kids = [];
  p.run('filterCustomers("")'); // もう一度描く（取り直し・印）
  const before = list.kids.filter((k) => k.className === "axlx-rows-chunk").length;
  p.queue.shift()(); // 前の回の続き
  ok("前の回の続きは何も足さない", stale === 1 && list.kids.filter((k) => k.className === "axlx-rows-chunk").length === before);
  drain(p);
  ok("新しい回は最後まで描く", rowsIn(allHtml(list)) === 100, rowsIn(allHtml(list)));
}

console.log("── ③ 「駅／地域」の札は希望エリアの文字ごとに覚える");
{
  const p = loadPopup();
  p.ctx.__c = makeCustomers(60);
  p.run("allCustomers = __c; linkedOnly = true; var __n = 0; var __orig = parseAreaTokens; parseAreaTokens = function (a) { __n++; return __orig(a); };");
  const list = p.ctx.document.getElementById("customer-list");
  p.run('filterCustomers("")'); drain(p);
  const first = p.run("__n");
  ok("1回目は文字の種類の数だけ計算（60人・10種類）", first === AREAS.length, first);
  list.kids = [];
  p.run('__n = 0; filterCustomers("")'); drain(p);
  ok("2回目（取り直し・検索欄の1文字）は計算しない", p.run("__n") === 0, p.run("__n"));
  p.run("_applyLearnedMaps({ regions: [], stations: [], lines: {} })");
  ok("地名・駅の学習済みの表を当て直したら覚えを捨てる", p.run("_areaBadgeMemo.size") === 0);
  const raw = p.run('_computeAreaModeBadgeHtmlRaw("梅田・中津・天満")');
  ok("覚えた答えは計算した答えと同じ", p.run('computeAreaModeBadgeHtml("梅田・中津・天満")') === raw && p.run('computeAreaModeBadgeHtml("梅田・中津・天満")') === raw);

  console.log("── ④ 覚えは開き直しても使う（拡張の版と学習済みの表の時刻が同じ時だけ）");
  p.run("_learnedMapsTs = 111; _areaBadgeMemoSavedSize = -1;");
  p.run('filterCustomers("")'); drain(p);
  const st = p.saved.axlx_area_badge_memo_v1;
  ok("描き終えたら手元に残す（版|表の時刻）", st && st.sig === "2.5.87|111" && st.entries.length === AREAS.length, st && [st.sig, st.entries.length]);
  const q = loadPopup();
  q.ctx.__st = st;
  q.run("_learnedMapsTs = 111;");
  ok("同じ版・同じ表なら戻す", q.run("_restoreAreaBadgeMemo(__st)") === AREAS.length && q.run("_areaBadgeMemo.size") === AREAS.length);
  const r = loadPopup();
  r.ctx.__st = st;
  r.run("_learnedMapsTs = 222;");
  ok("表を取り直した後（時刻が違う）は捨てる", r.run("_restoreAreaBadgeMemo(__st)") === 0 && r.run("_areaBadgeMemo.size") === 0);
  r.ctx.__st2 = Object.assign({}, st, { sig: "2.5.86|222" });
  ok("拡張の版が違う時も捨てる", r.run("_restoreAreaBadgeMemo(__st2)") === 0);
  ok("壊れた値は読まない", r.run('_restoreAreaBadgeMemo({ sig: _areaBadgeMemoSig(), entries: "x" })') === 0 && r.run("_restoreAreaBadgeMemo(null)") === 0);
}

console.log("── ⑤ 折りたたみ（申込中・検討中）の中は開いた時に描く");
{
  const p = loadPopup();
  p.ctx.__c = makeCustomers(30, (i) => (i < 8 ? { status: "applying" } : {}));
  p.run("allCustomers = __c; linkedOnly = true;");
  const list = p.ctx.document.getElementById("customer-list");
  p.run('filterCustomers("")'); drain(p);
  ok("申込中の見出しは人数つきで出る", /申込中<span class="collapsible-count">8人/.test(allHtml(list)));
  ok("中の行はまだ描かない（data-lazy）", rowsIn(allHtml(list)) === 22 && /id="coll-applying" style="display:none" data-lazy="1"><\/div>/.test(allHtml(list)));
  ok("開いた時に描く行を持っている", p.run("_collapsedRows['coll-applying'].length") === 8);
  const pp = read("popup.js");
  ok("見出しを押した時に初めて描いて押せるようにする", /if \(!open && body\.dataset\.lazy === "1"\) \{\s*body\.dataset\.lazy = "";\s*body\.innerHTML = \(_collapsedRows\[header\.dataset\.target\] \|\| \[\]\)\.map\(\(c\) => renderCustomerRow\(c, false\)\)\.join\(""\);\s*_bindCustomerRows\(body\);/.test(pp));
}

console.log("── ⑥ 読み込み（前回の一覧が無い時は最新50人＋📌 を先に）");
{
  const pp = read("popup.js");
  ok("最新 LIST_HEAD_FETCH=50 人を ?view=list&limit= で頼む", /const LIST_HEAD_FETCH = 50;/.test(pp) && /\?view=list` \+ \(headN \? "&limit=" \+ headN : ""\)/.test(pp) && /_fetchCustomerList\(LIST_HEAD_FETCH\)\.then/.test(pp));
  ok("前回の一覧を出した時・手元に一覧がある取り直しでは頼まない", /if \(!shown && !\(allCustomers && allCustomers\.length\)\) \{/.test(pp));
  ok("全員が先に届いたら仮の表示はしない", /if \(fullArrived \|\| !Array\.isArray\(head\) \|\| !head\.length\) return;/.test(pp));
  ok("仮の間は今日対応の人数を出さない", /if \(typeof _customerListPartial !== "undefined" && _customerListPartial\) \{ banner\.style\.display = "none"; return; \}/.test(pp));
  ok("仮の間は印の取り直しをしない（全員を待つ）", /if \(typeof _customerListPartial !== "undefined" && _customerListPartial\) return; \/\/ v2\.5\.87/.test(pp));
  ok("会話から押された人を開く所は全員を待つ（2か所）", /\|\| _customerListPartial\) && Date\.now\(\) - t0 < 8000\)/.test(pp) && /_customerListPartial\)\) && Date\.now\(\) - t0 < 5000\)/.test(pp));
  ok("前回の地名・駅の表を当ててから描く（最大0.3秒・手元の読み出しだけ）", /await Promise\.race\(\[_learnedCachedReady, new Promise\(\(r\) => setTimeout\(r, LIST_MAPS_WAIT_MS\)\)\]\)/.test(pp) && /const LIST_MAPS_WAIT_MS = 300;/.test(pp));
  ok("前回の一覧をすぐ出し裏で取り直す（v2.5.80 のまま）", /if \(!shown\) await refresh;/.test(pp) && /if \(sig !== _customerListSig\)/.test(pp));
}

console.log("── ⑦ サーバー（/api/property-customers?view=list）");
{
  const api = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "property-customers", "route.ts"), "utf8");
  ok("重い列を DB から読まない（列の名前は1行の * から知る＝新しい列も漏れない）", /async function listColumns\(\)/.test(api) && /select\("\*"\)\.limit\(1\)/.test(api) && /select\(listView \? await listColumns\(\) : "\*"\)/.test(api));
  ok("会話は一覧が使う列だけ", /const LIST_CONV_COLS = "id, property_customer_id, last_sender, updated_at, account, status, is_hot, is_flagged";/.test(api));
  ok("?limit=N は最新 N 人＋📌 の人・会話もその人たちの分だけ", /async function listHead\(n: number\)/.test(api) && /\.order\("updated_at", \{ ascending: false \}\)\.limit\(n\)/.test(api) && /\.in\("id", focusRows\.map/.test(api) && /\.select\(LIST_CONV_COLS\)\.in\("property_customer_id", convIds\)/.test(api));
  ok("既定（view なし）の形は変えない", /want_items: itemizeWants\(c as WantsCustomerLike\)/.test(api));
}

ok("manifest の版 2.5.87 以上", (function (v) { const p = v.split(".").map(Number); return p[0] > 2 || (p[0] === 2 && (p[1] > 5 || (p[1] === 5 && p[2] >= 87))); })(JSON.parse(read("manifest.json")).version));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
