// 実行: node tests/chrome-extension/webapp-bridge.test.js
// 2026-09-25: webapp-bridge.js は 8/10（497a94e9）から「同じ名前の二重の宣言」（var site と const { site }）で
// 読み込みの時点で SyntaxError だった＝6週間ウェブアプリ→拡張の橋渡しが全部止まっていた。
// ①拡張の全ファイルが node --check を通る ②橋渡しが読み込める ③直した後に動き出す道・止めたままの道 を確かめる。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }

const EXT = path.join(__dirname, "../../chrome-extension");
const BRIDGE_SRC = fs.readFileSync(path.join(EXT, "webapp-bridge.js"), "utf8");

// ── ① 拡張の全ファイルの node --check（文法の誤りは静かに機能を止める）────────────────
console.log("\n■ 拡張の全ファイルの node --check");
function listJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue; // .tmp.driveupload など
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(p));
    else if (ent.name.endsWith(".js")) out.push(p);
  }
  return out;
}
const files = listJs(EXT);
const bad = [];
for (const f of files) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
  catch (e) { bad.push(path.relative(EXT, f) + ": " + String(e.stderr || e.message).split("\n").slice(0, 5).join(" | ")); }
}
eq(`全 ${files.length} ファイルが通る`, bad, []);
// manifest の content_scripts / background に書かれた js が実在する
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const listed = [].concat(...(manifest.content_scripts || []).map((c) => c.js || []));
if (manifest.background && manifest.background.service_worker) listed.push(manifest.background.service_worker);
eq("manifest の js が全部ある", listed.filter((f) => !fs.existsSync(path.join(EXT, f))), []);
eq("webapp-bridge.js はウェブアプリのページで読まれる", (manifest.content_scripts || []).some((c) => (c.js || []).includes("webapp-bridge.js") && (c.matches || []).includes("https://sumora-ai-ui.vercel.app/*")), true);

// ── ② 読み込み（偽の window / chrome の上で content script を動かす）──────────────────────
function load(src) {
  const posted = [];     // 橋渡しがページへ postMessage した物
  const sent = [];       // background へ送った物 { msg, cb }
  const onMessageListeners = [];
  let messageListener = null;
  const win = {
    addEventListener(type, fn) { if (type === "message") messageListener = fn; },
    postMessage(data) { posted.push(data); },
  };
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) { sent.push({ msg, cb }); },
      onMessage: { addListener(fn) { onMessageListeners.push(fn); } },
    },
  };
  const ctx = vm.createContext({ window: win, chrome, console: { log() {}, warn() {} } });
  vm.runInContext(src, ctx, { filename: "webapp-bridge.js" });
  const fire = (data, opts = {}) => messageListener({
    origin: opts.origin || "https://sumora-ai-ui.vercel.app",
    source: opts.source === undefined ? win : opts.source,
    data,
  });
  return { posted, sent, fire, onMessageListeners, hasListener: () => !!messageListener };
}

console.log("\n■ 読み込み");
let b;
try { b = load(BRIDGE_SRC); eq("SyntaxError なく読み込める", true, true); }
catch (e) { eq("SyntaxError なく読み込める: " + e.message, false, true); process.exit(1); }
eq("message の受け口がある", b.hasListener(), true);
eq("background からの受け口（batch-customer-done の中継）がある", b.onMessageListeners.length, 1);

// ── ③ 分かれ道 ───────────────────────────────────────────────────────────────
console.log("\n■ 入口の歯止め");
b = load(BRIDGE_SRC);
b.fire({ from: "aixlinx-webapp-poll-now" }, { origin: "https://evil.example.com" });
eq("許可していない origin は何もしない", b.sent.length, 0);
b.fire({ from: "aixlinx-webapp-poll-now" }, { source: {} });
eq("別の window（iframe など）からは何もしない", b.sent.length, 0);
b.fire({ from: "aixlinx-webapp-poll-now" }, { origin: "http://localhost:3000" });
eq("localhost:3000 は通る", b.sent.map((s) => s.msg.type), ["axlx-poll-now"]);
b = load(BRIDGE_SRC);
b.fire(null); b.fire("text"); b.fire({ from: "something-else" });
eq("形の違うメッセージは何もしない", [b.sent.length, b.posted.length], [0, 0]);

console.log("\n■ 動かす道");
b = load(BRIDGE_SRC);
b.fire({ from: "aixlinx-webapp-poll-now" });
eq("poll-now → axlx-poll-now（1回だけ）", b.sent.map((s) => s.msg), [{ type: "axlx-poll-now" }]);

b = load(BRIDGE_SRC);
b.fire({ from: "aixlinx-webapp-estimate-auto", site: "itandi" });
eq("見積書 旧フロー → axlx-estimate-auto（site を渡す）", b.sent.map((s) => s.msg), [{ type: "axlx-estimate-auto", site: "itandi" }]);
b.sent[0].cb({ ok: true, text: "【itandi 物件詳細】\n賃料: 5.7万円" });
eq("  成功 → aixlinx-estimate-data", b.posted, [{ from: "aixlinx-estimate-data", text: "【itandi 物件詳細】\n賃料: 5.7万円" }]);
b = load(BRIDGE_SRC);
b.fire({ from: "aixlinx-webapp-estimate-auto" });
eq("  site 無し → unknown", b.sent[0].msg.site, "unknown");
b.sent[0].cb(undefined);
eq("  拡張の返事なし → aixlinx-estimate-error", b.posted, [{ from: "aixlinx-estimate-error", error: "不明なエラー" }]);

b = load(BRIDGE_SRC);
b.fire({ from: "aixlinx-webapp-estimate-search", propertyName: "テスト物件", roomNumber: "101" });
eq("見積書 新フロー → axlx-estimate-realpro-search", b.sent.map((s) => s.msg), [{ type: "axlx-estimate-realpro-search", propertyName: "テスト物件", roomNumber: "101" }]);
b.sent[0].cb({ ok: false, error: "物件の一括検索の実行中です。終わってからもう一度お試しください。" });
eq("  一括中で断られた → aixlinx-estimate-search-error（理由をそのまま）", b.posted, [{ from: "aixlinx-estimate-search-error", error: "物件の一括検索の実行中です。終わってからもう一度お試しください。" }]);
b = load(BRIDGE_SRC);
b.fire({ from: "aixlinx-webapp-estimate-search", propertyName: "テスト物件", roomNumber: "101" });
b.sent[0].cb({ ok: true, text: "【客付業者様へ】" });
eq("  成功 → aixlinx-estimate-search-data", b.posted, [{ from: "aixlinx-estimate-search-data", text: "【客付業者様へ】" }]);

b = load(BRIDGE_SRC);
b.fire({ from: "aixlinx-webapp-request-pending-supplementary" });
eq("補足情報の受け取り → axlx-get-pending-supplementary", b.sent.map((s) => s.msg.type), ["axlx-get-pending-supplementary"]);
b.sent[0].cb({ ok: false, text: null });
eq("  古い（10分超）で渡されなかった → ページには何も入れない", b.posted, []);
b = load(BRIDGE_SRC);
b.fire({ from: "aixlinx-webapp-request-pending-supplementary" });
b.sent[0].cb({ ok: true, text: "【客付業者様へ】" });
eq("  新しい → aixlinx-estimate-pending-supplementary", b.posted, [{ from: "aixlinx-estimate-pending-supplementary", text: "【客付業者様へ】" }]);

b = load(BRIDGE_SRC);
b.onMessageListeners[0]({ type: "axlx-batch-customer-done" });
eq("一括の1人完了（customerId 無し）→ ページへ中継", b.posted, [{ from: "aixlinx-batch-customer-done", customerId: null }]);
b.onMessageListeners[0]({ type: "axlx-something-else" });
eq("  ほかの種類は中継しない", b.posted.length, 1);

console.log("\n■ 止めたままの道（直接の検索・6週間の本番と同じくキューに任せる）");
b = load(BRIDGE_SRC);
b.fire({ from: "aixlinx-webapp-scrape", customerId: "c1", customerName: "テスト", isWide: false, conditions: {} });
eq("比較のスクレイプ: ACK を返さない・background に渡さない（→ ウェブアプリはキュー＋poll-now）", [b.posted.length, b.sent.length], [0, 0]);
b.fire({ from: "aixlinx-webapp", site: "realnetpro", conditions: { customerId: "c1" } });
eq("物件検索（個別）: 受領 ACK なし・渡さない（→ /api/automation/trigger）", [b.posted.length, b.sent.length], [0, 0]);
b.fire({ from: "aixlinx-webapp", site: "itandi", conditions: { customerId: "c1" }, auto_send_all: true });
eq("要対応一括の直接の検索（auto_send_all）: 渡さない（キューの一括と2本同時に走らない）", [b.posted.length, b.sent.length], [0, 0]);

// 戻す時（DIRECT_SEARCH_ENABLED = true）でも、改名後の枝が読めて前の形で動くこと
console.log("\n■ DIRECT_SEARCH_ENABLED = true にした時（戻す時の確認）");
const ON_SRC = BRIDGE_SRC.replace("const DIRECT_SEARCH_ENABLED = false;", "const DIRECT_SEARCH_ENABLED = true;");
eq("切り替えの定数が1か所ある", ON_SRC !== BRIDGE_SRC, true);
b = load(ON_SRC);
b.fire({ from: "aixlinx-webapp", site: "itandi", conditions: { customerId: "c1" }, auto_send_all: true });
eq("物件検索: 受領 ACK → axlx-webapp-search", [b.posted, b.sent.map((s) => s.msg)], [[{ from: "aixlinx-webapp-received", site: "itandi" }], [{ type: "axlx-webapp-search", site: "itandi", conditions: { customerId: "c1" }, auto_send_all: true }]]);
b = load(ON_SRC);
b.fire({ from: "aixlinx-webapp-scrape", customerId: "c1", customerName: "テスト", isWide: true, conditions: { rent_max: 70000 } });
eq("比較のスクレイプ: ACK → axlx-scrape-and-compare", [b.posted, b.sent.map((s) => s.msg)], [[{ from: "aixlinx-webapp-scrape-ack", customerId: "c1" }], [{ type: "axlx-scrape-and-compare", customerId: "c1", conditions: { rent_max: 70000, customerName: "テスト", isWide: true } }]]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
