// 実行: node tests/chrome-extension/switch-once.test.js
// v2.5.48「1回の指示で自動入力のボタンを押すのは1回」
//
// 原因（本番 search_audits 9/30・ITANDI の一括の回すべてに 6〜13秒遅れの trigger=single の行）:
//   background の chrome.tabs.sendMessage(axlx-switch-customer) 1回を、同じタブの
//   (A) underbar.js の中継 → popup.js の window message と (B) popup.js の chrome.runtime.onMessage の両方が受け、
//   自動入力のボタンを2回 click していた。リアプロは onclick が disabled にするので偶然止まり、ITANDI は歯止めが無かった。
// 直し: 受け口は (A) の1本（_runSwitchCustomer）・2回目の見分けは押す直前・ITANDI の onclick に実行中の印・
//       点検の文脈は click に直接渡す・underbar は popup の答えを待って返す。
// ここでは popup.js の芯（AXLX-SWITCH-CORE）と underbar.js の中継を、模型の画面で実際に動かして click の回数を数える。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const SA = require("../../chrome-extension/search-audit.js");

const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || !detail ? "" : "\n      " + detail)); }
function eq(name, a, b) { const c = JSON.stringify(a) === JSON.stringify(b); ok(name, c, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

const pp = read("popup.js");
const ub = read("underbar.js");
const bg = read("background.js");

function between(src, a, b) { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("印が無い: " + a); return src.slice(i, j + b.length); }
function fnSrc(src, head) {
  const i = src.indexOf(head); if (i < 0) throw new Error("関数が無い: " + head);
  let d = 0, k = src.indexOf("{", i);
  for (; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}") { d--; if (d === 0) break; } }
  return src.slice(i, k + 1);
}

// ── popup の芯を模型の画面で動かす ──
function makePopup(opts) {
  opts = opts || {};
  const clicks = []; // { ctx, automated, auto_send_all, locked }
  const log = [];
  const aBtn = {
    dataset: {}, style: { display: "block" }, _axlxAuditCtx: null,
    click() { clicks.push({ ctx: this._axlxAuditCtx, automated: this.dataset.automated || null, auto_send_all: this.dataset.auto_send_all, locked: this.dataset.area_mode_locked || null }); },
  };
  const modeBtn = { click() { log.push("mode"); } };
  const areaBtn = { click() { log.push("area"); sandbox._areaModeSource = "user"; } };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (f) => setTimeout(f, 0), // 人の間は縮める（回数だけを見る）
    Date, Math, Promise, String, JSON,
    allCustomers: opts.customers || [{ id: "c1", customer_name: "YUMA" }],
    currentAreaMode: "ward", _areaModeSource: "auto", _adjRestoreSuppressed: false,
    _popupPd: () => 1,
    openSiteView() { log.push("open"); },
    openInstructions() { log.push("instr"); },
    _awaitFreshPreload: async () => true,
    _applySearchOverrideToForm: () => true,
    _afterSearchOverrideClick() { log.push("afterOv"); },
    _applyAutoRunToForm: () => ({}),
    _restoreAutoRun() { log.push("restoreAr"); },
    document: {
      querySelector: () => modeBtn,
      getElementById: (id) => (id === "autofill-btn" ? (opts.noBtn ? null : aBtn) : areaBtn),
    },
  };
  sandbox.self = { AxlxSearchAudit: SA, AxlxSearchOverride: { sanitize: (o) => o } };
  vm.createContext(sandbox);
  vm.runInContext(
    "var _lastSwitchSeen = null;\n" + fnSrc(pp, "function _isDupSwitch(d)") + "\n" + fnSrc(pp, "function _clickAuditCtx(btn)") + "\n" +
    between(pp, "// ==AXLX-SWITCH-CORE-BEGIN==", "// ==AXLX-SWITCH-CORE-END=="), sandbox);
  return { sandbox, clicks, log, aBtn };
}
const SW = { customerId: "c1", site: "itandi", areaMode: "ward", is_wide: false, auditRunId: "sa_x_1", trigger: "bulk_queue", commandId: "cmd1" };

(async function main() {
  console.log("\n① 1回の指示で click は1回（受け口は underbar の中継の1本）");
  {
    const p = makePopup();
    const r = await p.sandbox._runSwitchCustomer(Object.assign({}, SW));
    eq("押した", r, { ok: true });
    eq("click は1回", p.clicks.length, 1);
    eq("点検の文脈は click に直接渡る（run_id・種類・命令）", p.clicks[0].ctx, { runId: "sa_x_1", trigger: "bulk_queue", commandId: "cmd1" });
    eq("自動の印が付く", p.clicks[0].automated, "1");
    eq("押した後は印・文脈を外す", [p.aBtn.dataset.automated, p.aBtn._axlxAuditCtx], [undefined, null]);
    eq("一括の軸は db（自動補正しない）", p.sandbox._areaModeSource, "db");
    eq("onclick が受け取ると空になる（1回だけ）", (() => { p.aBtn._axlxAuditCtx = { runId: "r" }; const a = p.sandbox._clickAuditCtx(p.aBtn); return [a, p.sandbox._clickAuditCtx(p.aBtn)]; })(), [{ runId: "r" }, null]);
  }

  console.log("\n② 同じ指示がもう1回届いても（古いタブ・中継の重なり）click は1回");
  {
    const p = makePopup();
    const [a, b] = await Promise.all([p.sandbox._runSwitchCustomer(Object.assign({}, SW)), p.sandbox._runSwitchCustomer(Object.assign({}, SW))]);
    eq("click は1回", p.clicks.length, 1);
    eq("2回目の答えは dup（押していないが、1回目が押している）", [a, b].filter((x) => x.dup).length, 1);
    eq("どちらも ok（background は代わりの入力をしない）", [a.ok, b.ok], [true, true]);
  }

  console.log("\n③ 穴: 先に着いた側が何もせず終わっても、もう片方を捨てない（鍵の記録は押す直前）");
  {
    const p = makePopup({ customers: [] });
    p.sandbox._popupPd = () => 1;
    const first = p.sandbox._openAndClickAutofill(Object.assign({}, SW), { dedupe: true }); // お客様の一覧がまだ無い → 顧客なしで終わる
    const r1 = await first;
    eq("1回目は顧客なし（押していない・ok でない）", [r1.ok, r1.reason, p.clicks.length], [false, "customer-not-found", 0]);
    p.sandbox.allCustomers = [{ id: "c1" }];
    const r2 = await p.sandbox._runSwitchCustomer(Object.assign({}, SW));
    eq("直後の同じ指示は押す", [r2, p.clicks.length], [{ ok: true }, 1]);
  }

  console.log("\n④ 入れ直し（同じお客様・同じ回・数秒後）は通す／押せない時は正直に");
  {
    const p = makePopup();
    await p.sandbox._runSwitchCustomer(Object.assign({}, SW));
    p.sandbox._lastSwitchSeen.at -= SA.SWITCH_DUP_WINDOW_MS + 1; // 窓の外
    await p.sandbox._runSwitchCustomer(Object.assign({}, SW));
    eq("窓の外の同じ指示は押す（ITANDI の入れ直し）", p.clicks.length, 2);
    const q = makePopup({ noBtn: true });
    eq("ボタンが無い → ok でない", await q.sandbox._runSwitchCustomer(Object.assign({}, SW)), { ok: false, reason: "no-autofill-btn" });
    const n = makePopup();
    eq("サイトなし → ok でない", await n.sandbox._runSwitchCustomer({ customerId: "c1" }), { ok: false, reason: "no-site" });
    const late = makePopup();
    late.sandbox._awaitFreshPreload = async () => { late.sandbox.Date = { now: () => Date.now() + 60000 }; return true; };
    const rl = await late.sandbox._runSwitchCustomer(Object.assign({}, SW));
    eq("遅すぎたら押さない（underbar は答えなしを返し、background が代わりに入れる＝二重にしない）", [rl.ok, rl.reason, late.clicks.length], [false, "too-late", 0]);
    const ex = makePopup();
    ex.sandbox.openInstructions = () => { throw new Error("boom"); };
    const re = await ex.sandbox._runSwitchCustomer(Object.assign({}, SW));
    eq("例外は ok でない答えに（投げない）・復元の印は戻る", [re.ok, /^exception: boom/.test(re.reason), ex.sandbox._adjRestoreSuppressed], [false, true, false]);
  }

  console.log("\n⑤ ウェブアプリの自動入力（pendingPopupCmd）も同じ芯（click は1回・軸を固定）");
  {
    const p = makePopup();
    const r = await p.sandbox._runPendingPopupCmd({ customerId: "c1", site: "realpro", areaMode: "both", auto_send_all: true }, "load");
    eq("押した", [r.ok, p.clicks.length], [true, 1]);
    eq("軸の固定・全ページの印", [p.clicks[0].locked, p.clicks[0].auto_send_all], ["ward", "1"]);
    eq("手で軸を押した扱いのまま（db にしない）", p.sandbox._areaModeSource, "user");
    const h = makePopup(); h.aBtn.style.display = "none";
    eq("ボタンが隠れている時は押さない", [(await h.sandbox._runPendingPopupCmd({ customerId: "c1", site: "realpro" }, "load")).ok, h.clicks.length], [false, 0]);
  }

  console.log("\n⑥ underbar の中継: popup の答えを待って返す（渡しただけで ok にしない）");
  {
    function makeUnderbar() {
      const listeners = { message: [] };
      let onMsg = null;
      const posted = [];
      const iframeWin = { postMessage(m) { posted.push(m); } };
      const timers = [];
      const sb = {
        console: { log() {}, warn() {} },
        setTimeout: (f, ms) => { timers.push({ f, ms, on: true }); return timers.length - 1; },
        clearTimeout: (i) => { if (timers[i]) timers[i].on = false; },
        Date, Math,
        iframe: { contentWindow: iframeWin, addEventListener() {} },
        ensureIframe() {}, _sd: (x) => x,
        window: { addEventListener: (t, f) => listeners[t].push(f), removeEventListener: (t, f) => { listeners[t] = listeners[t].filter((x) => x !== f); } },
        chrome: { runtime: { onMessage: { addListener: (f) => { onMsg = f; } } } },
      };
      vm.createContext(sb);
      const i = ub.indexOf("var SWITCH_REPLY_TIMEOUT_MS");
      const j = ub.indexOf("\n})();", i);
      vm.runInContext(ub.slice(i, j), sb);
      return { send: (m, cb) => onMsg(m, {}, cb), posted, fire: (data, source) => listeners.message.slice().forEach((f) => f({ data, source })), timers, iframeWin, listeners };
    }
    const u = makeUnderbar();
    const got = [];
    const keep = u.send({ type: "axlx-switch-customer", customerId: "c1", site: "itandi" }, (r) => got.push(r));
    eq("チャンネルを開いたまま（true）・渡した時点ではまだ答えない", [keep, got.length, u.posted.length], [true, 0, 1]);
    ok("reqId を付けて渡す", typeof u.posted[0].reqId === "string" && u.posted[0].reqId.length > 5);
    u.fire({ from: "axlx-switch-result", reqId: "ほかの指示", ok: true }, u.iframeWin);
    u.fire({ from: "axlx-switch-result", reqId: u.posted[0].reqId, ok: true }, {});
    eq("違う reqId・iframe 以外からの答えは使わない", got.length, 0);
    u.fire({ from: "axlx-switch-result", reqId: u.posted[0].reqId, ok: false, reason: "customer-not-found" }, u.iframeWin);
    eq("popup の答えをそのまま返す", got, [{ ok: false, reason: "customer-not-found", dup: false }]);
    u.fire({ from: "axlx-switch-result", reqId: u.posted[0].reqId, ok: true }, u.iframeWin);
    eq("答えは1回だけ・聞き手は外す", [got.length, u.listeners.message.length], [1, 0]);

    const v = makeUnderbar();
    const got2 = [];
    v.send({ type: "axlx-switch-customer", customerId: "c1", site: "itandi" }, (r) => got2.push(r));
    const t = v.timers.find((x) => x.on && x.ms === 20000);
    ok("答えを待つ上限は 20秒（popup の『遅すぎたら押さない』16秒より長い）", !!t && /var SWITCH_CLICK_DEADLINE_MS = 16000;/.test(pp));
    t.f();
    eq("答えが無ければ ok でない（popup-no-answer）", got2, [{ ok: false, reason: "popup-no-answer" }]);
    eq("ほかの種類の知らせは受けない", v.send({ type: "axlx-ping" }, () => {}), false);
  }

  console.log("\n⑦ 配線（受け口は1本・ITANDI の実行中の印・点検の文脈）");
  {
    ok("popup.js に switch-customer の chrome.runtime.onMessage は無い", !/msg\.type === "axlx-switch-customer"/.test(pp) && !/type === "axlx-switch-customer"/.test(pp));
    eq("自動入力のボタンを自動で押す所は芯の1か所だけ", (pp.match(/aBtn\.click\(\)/g) || []).length, 1);
    ok("underbar の中継が唯一の受け口", /from === "underbar-parent" && e\.data\?\.action === "switch-customer"\) \{[\s\S]{0,200}_runSwitchCustomer\(e\.data\)\.then/.test(pp));
    ok("答えを親（underbar）へ返す（reqId）", /from: "axlx-switch-result", reqId: e\.data\.reqId \|\| null, ok: !!\(r && r\.ok\)/.test(pp));
    ok("underbar は渡しただけで ok を返さない", !/\}, "\*"\);\s*\n\s*sendResponse\(\{ ok: true \}\);/.test(ub));
    ok("1回使い切りの置き場は無い", !/_pendingAuditCtx\s*=/.test(pp) && !/_setPendingAuditCtx\(/.test(pp));
    ok("ITANDI の onclick に実行中の印（始めに見る・finally で外す）",
      /if \(_itandiFillRunningAt && Date\.now\(\) - _itandiFillRunningAt < 60000\) \{[\s\S]{0,160}return;\s*\}\s*_itandiFillRunningAt = Date\.now\(\);[\s\S]{0,160}try \{ await _itandiAutofillRun\(_auditCtx_it\); \} finally \{ _itandiFillRunningAt = 0; \}/.test(pp));
    ok("3つの onclick とも点検の文脈を await の前に受け取り _auditTag に渡す",
      /_auditTag\("itandi", selectedCustomer, conditions, _auditCtx_it\)/.test(pp) && /_auditTagWith\(_auditCtx_rp, "realpro", c, \{/.test(pp) && /_auditTag\("reins", c0, conditions, _auditCtx_re\)/.test(pp));
    ok("_auditTag は渡された文脈を使う（無ければ single）", /function _auditTag\(site, customer, conditions, ctx\) \{/.test(pp) && /trigger: \(ctx && ctx\.trigger\) \|\| "single"/.test(pp));
    ok("background は ok でない答えで代わりの入力へ（ITANDI）", /if \(!batchItandiSwitched\) \{[\s\S]{0,200}popup_fallback/.test(bg));
  }

  // ITANDI の実行中の印を模型で: 走っている間の2回目は本体を呼ばない・例外でも外れる
  console.log("\n⑧ ITANDI の onclick: 走っている間の2回目は受けない・例外でも印が外れる");
  {
    const head = pp.indexOf("    autofillBtn.onclick = async () => {\n      if (_itandiFillRunningAt");
    const tail = pp.indexOf("    const _itandiAutofillRun = async (_auditCtx_it) => {", head);
    ok("印の付いた onclick が見つかる", head > 0 && tail > head);
    let runs = 0, release = null, boom = false;
    const sb = { console: { log() {} }, Date, Promise, autofillBtn: { _axlxAuditCtx: null }, _itandiFillRunningAt: 0,
      _clickAuditCtx: (b) => { const c = b._axlxAuditCtx; b._axlxAuditCtx = null; return c; },
      _itandiAutofillRun: async () => { runs++; if (boom) throw new Error("x"); await new Promise((r) => { release = r; }); } };
    vm.createContext(sb);
    vm.runInContext(pp.slice(head, tail), sb);
    const p1 = sb.autofillBtn.onclick();
    const p2 = sb.autofillBtn.onclick();
    await p2;
    eq("2回目は本体を呼ばない", runs, 1);
    release(); await p1;
    eq("終わったら印が外れる", sb._itandiFillRunningAt, 0);
    boom = true;
    await sb.autofillBtn.onclick().catch(() => {});
    eq("例外でも印が外れる・次は受ける", [sb._itandiFillRunningAt, runs], [0, 2]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
