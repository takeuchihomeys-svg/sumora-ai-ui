// 実行: node tests/chrome-extension/search-focus-closing-v2588.test.js
// v2.5.88 2026-10-07 竹内「それにする　設計知見と協力しておこなう」:
//   AIX【物件を探す】を送ったら（自動検索は 10/01 から停止中）お客様を拡張の一覧の一番上「📌 会話から物件検索」に出す（device="aix"）。
//   印のお客様を開いた時、決め手の条件（closing-target）を一時調整の欄に「この回だけ」入れる。
// ① search-focus.js（AIX の札・closingKey・closingNote）
// ② popup の AXLX-FOCUS-CLOSING（先に読めていれば同期で入れる・メモの上書きの回は入れない・印が外れても続けて別サイトなら同じ像）
// ③ 繋ぎ目（openInstructions の最後で呼ぶ・📌 の一覧で先に読む・版）
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const SF = require("../../chrome-extension/search-focus.js");
const SO = require("../../chrome-extension/search-override.js");

const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || !detail ? "" : "\n      " + detail)); }
function eq(name, a, b) { const c = JSON.stringify(a) === JSON.stringify(b); ok(name, c, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
function between(src, a, b) { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("印が無い: " + a); return src.slice(i, j + b.length); }
const tick = () => new Promise((r) => setTimeout(r, 0));

const NOW = Date.now();
const AT = new Date(NOW - 10 * 60 * 1000).toISOString(); // 10分前に AIX を送った

(async function main() {
  console.log("\n① search-focus.js");
  const lab = SF.label({ at: "2026-10-07T03:00:00Z", by: "AIX物件を探す", device: "aix" });
  eq("AIX の印の札（by と二重に出さない）", lab, "10/7 12:00 AIX物件を探す");
  eq("スマホの札は今まで通り", SF.label({ at: "2026-10-07T03:00:00Z", by: null, device: "phone" }), "10/7 12:00 スマホ");
  const c = { id: "c1", search_focus: { at: AT, by: "AIX物件を探す", device: "aix" } };
  eq("効いている印 → 鍵", SF.closingKey(c, NOW), "c1@" + AT);
  eq("印が無い → null（読まない）", SF.closingKey({ id: "c1" }, NOW), null);
  eq("押した後に検索した → null", SF.closingKey(Object.assign({}, c, { last_pinpoint_search_at: new Date(NOW - 60000).toISOString() }), NOW), null);
  const clRent = { kinds_ja: ["家賃"], favorite: "バウスフラッツ新大阪 1002", search_override: { v: 1, rent_max: 76000 }, equipment: [] };
  eq("家賃の帯", SF.closingNote(clRent, SO.describe), "🎯 決め手の条件［家賃］（この回だけ）: 家賃〜7.6万（バウスフラッツ新大阪 1002 が基準）");
  const clEq = { kinds_ja: ["設備"], favorite: null, search_override: null, equipment: ["カウンターキッチン"] };
  eq("設備の帯（サイトでは絞らない）", SF.closingNote(clEq, SO.describe), "🎯 決め手の条件［設備］（この回だけ）: 設備: カウンターキッチン（サイトでは絞らず採点で上げる）");
  eq("何も無い → 空", SF.closingNote({ search_override: null, equipment: [] }, SO.describe), "");
  eq("null → 空", SF.closingNote(null, SO.describe), "");

  console.log("\n② popup の AXLX-FOCUS-CLOSING");
  const pp = read("popup.js");
  const block = between(pp, "// ==AXLX-FOCUS-CLOSING-BEGIN==", "// ==AXLX-FOCUS-CLOSING-END==");
  function makeCtx(opts) {
    const applied = [];
    const fetched = [];
    const els = {};
    const mkEl = (id) => ({ id, style: {}, textContent: "", parentNode: null });
    const anchor = mkEl("adj-mode-indicator");
    anchor.parentNode = { insertBefore: (el) => { els[el.id] = el; } };
    const ctx = {
      console: { log() {}, warn() {} },
      API_BASE: "https://x",
      Date, Promise, encodeURIComponent, String,
      self: { AxlxSearchFocus: SF, AxlxSearchOverride: SO },
      document: {
        getElementById: (id) => (id === "adj-mode-indicator" ? anchor : els[id] || null),
        createElement: () => mkEl(""),
      },
      selectedCustomer: opts.customer,
      selectedSite: opts.site || "realpro",
      _adjRestoreSuppressed: !!opts.suppressed,
      _applySearchOverrideToForm: (ov, pass, cust) => { applied.push({ ov, pass, id: cust.id }); return true; },
      fetch: (url) => { fetched.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, marked: true, closing: opts.closing }) }); },
    };
    ctx.window = ctx.self;
    vm.createContext(ctx);
    vm.runInContext(block, ctx);
    return { ctx, applied, fetched, els };
  }

  // 先に読んでおく（📌 の一覧）→ 開いた瞬間に同期で入る（▶案内 の押下に間に合う）
  {
    const t = makeCtx({ customer: c, closing: clRent });
    t.ctx._prefetchFocusClosing([c]);
    await tick(); await tick(); await tick();
    eq("📌 の一覧で1回だけ読む", t.fetched.length, 1);
    ok("customer_id で読む", /\/api\/property-search-focus\?customer_id=c1$/.test(t.fetched[0] || ""), t.fetched[0]);
    t.ctx._applyFocusClosing("realpro");
    eq("開いた瞬間に（同期で）欄に入れる", t.applied.map((a) => a.ov.rent_max), [76000]);
    eq("駅／地域の回ではない（pass=null）", t.applied[0].pass, null);
    ok("帯に出す", t.els["focus-closing-note"] && t.els["focus-closing-note"].style.display === "block" && /家賃〜7\.6万/.test(t.els["focus-closing-note"].textContent));
    t.ctx._prefetchFocusClosing([c]);
    await tick();
    eq("同じ印は読み直さない", t.fetched.length, 1);
  }
  // 読めていない時 → 読んでから入れる
  {
    const t = makeCtx({ customer: c, closing: clRent, site: "itandi" });
    t.ctx._applyFocusClosing("itandi");
    eq("その場ではまだ入れない", t.applied.length, 0);
    await tick(); await tick(); await tick();
    eq("届いたら入れる", t.applied.length, 1);
  }
  // メモの上書き・ウェブアプリの自動入力の回は入れない
  {
    const t = makeCtx({ customer: c, closing: clRent, suppressed: true });
    t.ctx._applyFocusClosing("realpro");
    await tick(); await tick();
    eq("_adjRestoreSuppressed の回は読まず入れない", [t.fetched.length, t.applied.length], [0, 0]);
  }
  // レインズでは入れない
  {
    const t = makeCtx({ customer: c, closing: clRent, site: "reins" });
    t.ctx._applyFocusClosing("reins");
    await tick();
    eq("レインズは対象外", [t.fetched.length, t.applied.length], [0, 0]);
  }
  // 設備だけ → 欄は触らず帯だけ
  {
    const t = makeCtx({ customer: c, closing: clEq });
    t.ctx._applyFocusClosing("realpro");
    await tick(); await tick(); await tick();
    eq("設備だけは欄に入れない", t.applied.length, 0);
    ok("帯に設備", /カウンターキッチン/.test((t.els["focus-closing-note"] || {}).textContent || ""));
  }
  // 印の無いお客様 → 読まない
  {
    const t = makeCtx({ customer: { id: "c9" }, closing: clRent });
    t.ctx._applyFocusClosing("realpro");
    await tick();
    eq("印なし → 読まない・入れない", [t.fetched.length, t.applied.length], [0, 0]);
  }
  // リアプロで検索して印が外れた後、続けて ITANDI を開く → 同じ像を入れる
  {
    const t = makeCtx({ customer: c, closing: clRent, site: "itandi" });
    t.ctx._prefetchFocusClosing([c]);
    await tick(); await tick(); await tick();
    t.ctx.selectedCustomer = Object.assign({}, c, { last_pinpoint_search_at: new Date().toISOString() });
    t.ctx._applyFocusClosing("itandi");
    eq("印が外れても続けて別サイトなら入れる", t.applied.length, 1);
    eq("読み直さない", t.fetched.length, 1);
  }
  // 別のお客様に切り替えた後に届いた → 入れない
  {
    const t = makeCtx({ customer: c, closing: clRent });
    t.ctx._applyFocusClosing("realpro");
    t.ctx.selectedCustomer = { id: "other" };
    await tick(); await tick(); await tick();
    eq("切り替えた後に届いた像は捨てる", t.applied.length, 0);
  }

  console.log("\n③ 繋ぎ目");
  const oi = between(pp, "function openInstructions(siteKey) {", "\nfunction buildCopyAll(");
  ok("openInstructions の最後（showView の前）で _applyFocusClosing", /_applyFocusClosing\(siteKey\)[\s\S]{0,200}showView\("view-instructions"\);\s*\n\}/.test(oi));
  const rl = between(pp, "function renderList(customers) {", "if (!customers.length && !pinned.length)");
  ok("📌 の一覧で先に読む", /_prefetchFocusClosing\(pinned\)/.test(rl));
  const m = JSON.parse(read("manifest.json"));
  ok("版は 2.5.88 以上", m.version.split(".").map(Number).reduce((a, x) => a * 1000 + x, 0) >= 2 * 1e6 + 5 * 1e3 + 88, m.version);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
