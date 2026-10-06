// 実行: node tests/chrome-extension/search-focus-v2586.test.js
// v2.5.86 2026-10-06 竹内「（会話の上の状態の帯を）広げたところに物件検索ボタンを出す。そうすると拡張ツール繰り上げられるようにする」
//   「スマホで押しても連携して拡張ツールのお客さんの一番上に繰り上がるようにする」
// ① search-focus.js（印が効いているか・並び・軽い取り直しの重ね方）
// ② webapp-bridge の search-focus の枝（ACK・タブ→無ければパネル・検索の道には入らない）
// ③ background の受け口（一括の最中はタブを動かさない・一番最近のタブ・パネルは await より前に開く）
// ④ popup の芯（AXLX-FOCUS-CORE: 開くだけで検索のボタンは押さない・同じ押しの2回目は何もしない・一覧に居なければ取り直す）
// ⑤ underbar の中継（バーを広げて popup に渡し、答えを待って返す）
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const SF = require("../../chrome-extension/search-focus.js");

const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || !detail ? "" : "\n      " + detail)); }
function eq(name, a, b) { const c = JSON.stringify(a) === JSON.stringify(b); ok(name, c, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
function between(src, a, b) { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("印が無い: " + a); return src.slice(i, j + b.length); }
const tick = () => new Promise((r) => setTimeout(r, 0));

const NOW = Date.parse("2026-10-06T13:00:00Z"); // JST 22:00
const AT = "2026-10-06T12:40:00Z";              // JST 21:40 に押した

(async function main() {
  console.log("\n① 印が効いているか（search-focus.js）");
  const base = { id: "c1", search_focus: { at: AT, by: null, device: "phone" } };
  eq("押した後に何もしていない → 効いている", SF.focusState(base, NOW), { active: true, reason: "active" });
  eq("印なし", SF.focusState({ id: "c1" }, NOW).reason, "none");
  eq("24時間たった → 外れる", SF.focusState(base, Date.parse(AT) + SF.TTL_MS).reason, "expired");
  eq("押した後にピンポイントで検索 → 外れる", SF.focusState(Object.assign({}, base, { last_pinpoint_search_at: "2026-10-06T12:45:00Z" }), NOW).reason, "searched");
  eq("押した後に広げて検索 → 外れる", SF.focusState(Object.assign({}, base, { last_wide_search_at: "2026-10-06T12:41:00Z" }), NOW).reason, "searched");
  eq("押す前の検索は関係ない", SF.focusState(Object.assign({}, base, { last_pinpoint_search_at: "2026-10-06T09:00:00Z" }), NOW).reason, "active");
  eq("押した後に送った → 外れる", SF.focusState(Object.assign({}, base, { last_property_sent_at: "2026-10-06T12:50:00Z" }), NOW).reason, "sent");
  eq("押す前に送ったのは関係ない", SF.focusState(Object.assign({}, base, { last_property_sent_at: "2026-10-05T12:50:00Z" }), NOW).reason, "active");
  eq("時刻が壊れている → 印なし", SF.focusState({ search_focus: { at: "x" } }, NOW).reason, "none");

  const list = [
    { id: "a", search_focus: { at: "2026-10-06T10:00:00Z" } },
    { id: "b" },
    { id: "c", search_focus: { at: "2026-10-06T12:00:00Z" } },
    { id: "d", search_focus: { at: "2026-10-06T11:00:00Z" }, last_wide_search_at: "2026-10-06T11:30:00Z" },
  ];
  eq("一番上は効いている印だけ・新しく押された順", SF.pinnedCustomers(list, NOW).map((c) => c.id), ["c", "a"]);

  const merged = SF.mergeMarks(list, [
    { property_customer_id: "b", at: "2026-10-06T12:55:00Z", by: null, device: "phone" },
    { property_customer_id: "c", at: "2026-10-06T12:00:00Z" },
    { property_customer_id: "zz", at: "2026-10-06T12:56:00Z" },
  ]);
  eq("スマホの印が手元の一覧に乗る", merged.customers.find((c) => c.id === "b").search_focus, { at: "2026-10-06T12:55:00Z", by: null, device: "phone" });
  ok("同じ印の行は同じ物のまま（描き直しを減らす）", merged.customers.find((c) => c.id === "c") === list[2]);
  eq("サーバーに無い印（24時間を過ぎた）は外す", merged.customers.find((c) => c.id === "a").search_focus, null);
  eq("一覧に居ないお客様は取り直しの合図", merged.missing, ["zz"]);
  ok("元の配列は変えない", list[1].search_focus === undefined);
  eq("署名は並びに関係なし", SF.marksSig([{ property_customer_id: "x", at: "1" }, { property_customer_id: "y", at: "2" }]), SF.marksSig([{ property_customer_id: "y", at: "2" }, { property_customer_id: "x", at: "1" }]));
  eq("札（JST）", SF.label({ at: AT, device: "phone" }), "10/6 21:40 スマホ");

  console.log("\n② webapp-bridge の search-focus の枝");
  const BRIDGE = read("webapp-bridge.js");
  function loadBridge() {
    const posted = [], sent = [];
    let listener = null;
    const win = { addEventListener(t, fn) { if (t === "message") listener = fn; }, postMessage(d) { posted.push(d); } };
    const chrome = { runtime: { lastError: undefined, sendMessage(m, cb) { sent.push({ msg: m, cb }); }, onMessage: { addListener() {} } } };
    vm.runInContext(BRIDGE, vm.createContext({ window: win, chrome, console: { log() {}, warn() {} } }));
    const fire = (data, o = {}) => listener({ origin: o.origin || "https://sumora-ai-ui.vercel.app", source: o.source === undefined ? win : o.source, data });
    return { posted, sent, fire };
  }
  let b = loadBridge();
  b.fire({ from: "aixlinx-webapp-search-focus", reqId: "r1", customerId: "c1", customerName: "H0N0KA.", at: AT });
  eq("すぐ ACK", b.posted[0], { from: "aixlinx-webapp-search-focus-ack", reqId: "r1" });
  eq("background へ axlx-search-focus（検索の種類ではない）", b.sent.map((s) => s.msg), [{ type: "axlx-search-focus", customerId: "c1", customerName: "H0N0KA.", at: AT }]);
  b.sent[0].cb({ ok: true, via: "tab", site: "realpro", opened: true });
  eq("タブを前に出せた → そのまま結果（パネルは開かない）", [b.posted[1], b.sent.length], [{ from: "aixlinx-webapp-search-focus-result", reqId: "r1", ok: true, via: "tab", site: "realpro", opened: true }, 1]);
  b = loadBridge();
  b.fire({ from: "aixlinx-webapp-search-focus", reqId: "r2", customerId: "c1" });
  b.sent[0].cb({ ok: true, via: "none", reason: "no-site-tab" });
  eq("タブが無い → パネルを頼む", b.sent[1].msg, { type: "axlx-search-focus-panel", customerId: "c1" });
  b.sent[1].cb({ ok: false, reason: "panel-refused", error: "sidePanel.open() may only be called in response to a user gesture." });
  eq("  断られた → 理由を返す", b.posted[1], { from: "aixlinx-webapp-search-focus-result", reqId: "r2", ok: true, via: "none", reason: "panel-refused", error: "sidePanel.open() may only be called in response to a user gesture." });
  b = loadBridge();
  b.fire({ from: "aixlinx-webapp-search-focus", reqId: "r3", customerId: "c1" });
  b.sent[0].cb({ ok: true, via: "none", reason: "batch-running" });
  eq("一括の最中 → パネルも開かない", [b.sent.length, b.posted[1].reason], [1, "batch-running"]);
  b = loadBridge();
  b.fire({ from: "aixlinx-webapp-search-focus", reqId: "r4" });
  eq("お客様の id が無い → 何もしない", [b.posted.length, b.sent.length], [0, 0]);
  b.fire({ from: "aixlinx-webapp-search-focus", reqId: "r5", customerId: "c1" }, { origin: "https://evil.example.com" });
  eq("許可していない origin → 何もしない", [b.posted.length, b.sent.length], [0, 0]);

  console.log("\n③ background の受け口");
  const bgSrc = read("background.js");
  const bgPart = bgSrc.slice(bgSrc.indexOf("// ===== 会話画面の「🔍 物件検索」"));
  function loadBg(o = {}) {
    let listener = null;
    const calls = [];
    const store = { batchRunning: o.lock || null };
    const chrome = {
      runtime: { lastError: undefined, onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: { set: async (v) => { calls.push(["set", v]); Object.assign(store, v); }, get: async (k) => ({ [k]: store[k] }) } },
      tabs: {
        query: async (q) => { calls.push(["query", q.url]); return o.tabs || []; },
        update: async (id, p) => { calls.push(["activate", id, p.active]); },
        sendMessage: (id, m, cb) => { calls.push(["tabMsg", id, m.type, m.customerId]); cb(o.tabAnswer || { ok: true }); },
      },
      windows: { update: async (id) => { calls.push(["focusWin", id]); } },
      sidePanel: o.noPanel ? undefined : { open: (p) => { calls.push(["panel", p.tabId, "sync"]); return o.panelRefuse ? Promise.reject(new Error("user gesture")) : Promise.resolve(); } },
    };
    vm.runInContext("var BATCH_LOCK_TTL_MS = 15 * 60 * 1000;\n" + bgPart, vm.createContext({ chrome, console: { log() {}, warn() {} }, Date, Promise, String }));
    const send = (msg, sender) => new Promise((res) => { const r = listener(msg, sender || { tab: { id: 9, windowId: 1 } }, res); if (r === false && !res.called) {} });
    return { listener, calls, send, store };
  }
  let g = loadBg({ tabs: [{ id: 3, windowId: 2, url: "https://itandibb.com/x", lastAccessed: 100 }, { id: 4, windowId: 2, url: "https://www.realnetpro.com/main.php", lastAccessed: 200 }] });
  let r = await g.send({ type: "axlx-search-focus", customerId: "c1", customerName: "H0N0KA.", at: AT });
  eq("一番最近見ていたタブ（リアプロ）を前に出す", r, { ok: true, via: "tab", site: "realpro", opened: true, reason: null });
  eq("  手元の印を置く", g.store.axlx_search_focus_open.customerId, "c1");
  eq("  前に出す→窓→バーへ（検索の命令は送らない）", g.calls.filter((c) => c[0] !== "set" && c[0] !== "query"), [["activate", 4, true], ["focusWin", 2], ["tabMsg", 4, "axlx-search-focus-open", "c1"]]);
  ok("  レインズのタブは探さない", !JSON.stringify(g.calls.find((c) => c[0] === "query")).includes("reins"));
  g = loadBg({ tabs: [{ id: 4, windowId: 2, url: "https://www.realnetpro.com/main.php" }], lock: { running: true, startedAt: Date.now() } });
  r = await g.send({ type: "axlx-search-focus", customerId: "c1" });
  eq("一括の最中 → タブを動かさない（印は置く）", [r.via, r.reason, g.calls.some((c) => c[0] === "activate"), !!g.store.axlx_search_focus_open], ["none", "batch-running", false, true]);
  g = loadBg({ tabs: [] });
  r = await g.send({ type: "axlx-search-focus", customerId: "c1" });
  eq("タブが無い → none（パネルは別の知らせで）", r, { ok: true, via: "none", reason: "no-site-tab" });
  g = loadBg();
  let resolved = null;
  const ret = g.listener({ type: "axlx-search-focus-panel", customerId: "c1" }, { tab: { id: 9 } }, (x) => { resolved = x; });
  eq("パネルは受け取ったその場で（await より前に）開く", [ret, g.calls[0]], [true, ["panel", 9, "sync"]]);
  await tick();
  eq("  開けた", resolved, { ok: true, via: "panel" });
  g = loadBg({ panelRefuse: true });
  r = await g.send({ type: "axlx-search-focus-panel", customerId: "c1" });
  eq("  断られた → 理由", [r.ok, r.reason], [false, "panel-refused"]);
  g = loadBg();
  eq("ほかの種類は触らない", g.listener({ type: "axlx-poll-now" }, {}, () => {}), false);

  console.log("\n④ popup の芯（AXLX-FOCUS-CORE）");
  const pp = read("popup.js");
  const core = between(pp, "// ==AXLX-FOCUS-CORE-BEGIN==", "// ==AXLX-FOCUS-CORE-END==");
  function makePopup(o = {}) {
    const log = [];
    const sb = {
      console: { log() {}, warn() {} }, Date, Promise, String, Number, JSON, setTimeout: (f) => setTimeout(f, 0),
      allCustomers: o.customers || [{ id: "c1", customer_name: "H0N0KA.", rent_max: 70000 }],
      selectedCustomer: null,
      API_BASE: "https://x",
      loadCustomers: async () => { log.push("reload"); if (o.afterReload) sb.allCustomers = o.afterReload; },
      fetchFreshCustomer: async (id) => { log.push("fresh:" + id); return o.fresh === undefined ? { id, customer_name: "H0N0KA.", rent_max: 80000 } : o.fresh; },
      syncFreshToCache: (f) => { const c = sb.allCustomers.find((x) => x.id === f.id); if (c) Object.assign(c, f); },
      openSiteView: (c) => { log.push("open:" + c.id + ":" + c.rent_max); },
      filterCustomers: () => { log.push("render"); },
      _renderCustomersKeepScroll: () => { log.push("render"); },
      document: { getElementById: (id) => (id === "autofill-btn" ? { click() { log.push("SEARCH-CLICKED"); } } : { value: "" }) },
      fetch: async () => ({ ok: true, json: async () => ({ ok: true, marks: o.marks || [] }) }),
    };
    sb.self = { AxlxSearchFocus: SF };
    vm.createContext(sb);
    vm.runInContext(core, sb);
    return { sb, log };
  }
  let p = makePopup();
  r = await p.sb._focusCustomerFromApp({ customerId: "c1", at: AT });
  eq("開いた（最新の条件＝取り直した家賃 8万で）", [r, p.log.filter((x) => x.startsWith("open"))], [{ ok: true }, ["open:c1:80000"]]);
  ok("  検索のボタンは押さない（案内モードのまま人が押す）", !p.log.includes("SEARCH-CLICKED"));
  eq("  手元の印が付く（一番上に出る）", p.sb.allCustomers[0].search_focus.at, AT);
  r = await p.sb._focusCustomerFromApp({ customerId: "c1", at: AT });
  eq("同じ押しの2回目（バーとパネル）は何もしない", [r, p.log.filter((x) => x.startsWith("open")).length], [{ ok: true, dup: true }, 1]);
  p = makePopup({ customers: [{ id: "c9" }], afterReload: [{ id: "c9" }, { id: "c1", customer_name: "新しく登録" }] });
  r = await p.sb._focusCustomerFromApp({ customerId: "c1", at: AT });
  eq("手元の一覧に居ない → 取り直して開く", [r.ok, p.log[0]], [true, "reload"]);
  p = makePopup({ customers: [{ id: "c9" }] });
  r = await p.sb._focusCustomerFromApp({ customerId: "c1", at: AT });
  eq("取り直しても居ない → 開かない", r, { ok: false, reason: "customer-not-found" });
  p = makePopup({ fresh: { id: "c1", rent_max: 80000, search_focus: null } });
  await p.sb._focusCustomerFromApp({ customerId: "c1", at: AT });
  eq("取り直しの行に印がまだ無くても（サーバーの書き込みが後）手元の印は残す", p.sb.allCustomers[0].search_focus && p.sb.allCustomers[0].search_focus.at, AT);
  eq("古い印では上書きしない", [p.sb._applyLocalFocusMark("c1", "2026-10-06T01:00:00Z"), p.sb.allCustomers[0].search_focus.at], [false, AT]);

  p = makePopup({ marks: [{ property_customer_id: "c1", at: AT, device: "phone" }] });
  await p.sb._pollSearchFocus();
  eq("スマホの印を軽い取り直しで拾って描き直す", [p.sb.allCustomers[0].search_focus.device, p.log], ["phone", ["render"]]);
  await p.sb._pollSearchFocus();
  eq("  変わっていなければ描き直さない", p.log, ["render"]);
  p = makePopup({ marks: [{ property_customer_id: "new1", at: AT }] });
  await p.sb._pollSearchFocus();
  eq("  一覧に居ないお客様の印 → 一覧を取り直す", p.log, ["reload"]);

  console.log("\n⑤ underbar の中継");
  const ub = read("underbar.js");
  ok("search-focus-open の受け口がある", ub.includes('msg.type !== "axlx-search-focus-open"'));
  ok("バーを広げてから popup に focus-customer を渡す", /doExpand\(\);[\s\S]{0,900}action: "focus-customer"/.test(ub));
  ok("switch-customer と同じ「iframe が無ければ作って待つ」を使う（startForward）", (ub.match(/return startForward\(/g) || []).length === 2);
  const html = read("popup.html");
  ok("popup.html が search-focus.js を popup.js より先に読む", html.indexOf("search-focus.js") > 0 && html.indexOf("search-focus.js") < html.indexOf('src="popup.js"'));
  const mf = JSON.parse(read("manifest.json"));
  ok("版は 2.5.86 以上", (function (v) { const p = v.split(".").map(Number); return p[0] > 2 || (p[0] === 2 && (p[1] > 5 || (p[1] === 5 && p[2] >= 86))); })(mf.version));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
