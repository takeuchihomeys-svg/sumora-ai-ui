/**
 * background.js を偽の Chrome の中で読み込み、登録された受け口（onMessage の関数）を取り出す。
 * 本物のコードのまま動かす（切り出さない）。chrome.* は呼ばれた記録を残す偽物。
 *
 *   const h = loadBackground({ storageLocal: {...}, storageSession: {...} });
 *   h.dispatch({ type: "axlx-poll-now" }, (res) => ...);
 *   h.calls  → [{ api: "tabs.update", args: [...] }, ...]
 *   h.ctx    → vm の中の変数（_manualBulkAlive など）を読む／書く
 *
 * 2.8.295 の邪魔しない窓の試験で使う。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DIR = process.env.AXLX_EXT_DIR || path.join(__dirname, "..", "..", "..", "chrome-extension");

function makeStub(calls, name, store) {
  // 何を呼んでも落ちない偽のオブジェクト（呼ばれた名前を calls に残す）
  const fn = function () {
    calls.push({ api: name, args: Array.prototype.slice.call(arguments) });
    return Promise.resolve(undefined);
  };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toPrimitive) return () => "";
      return makeStub(calls, name + "." + String(prop), store);
    },
    apply(_t, _this, args) {
      calls.push({ api: name, args: Array.prototype.slice.call(args) });
      return Promise.resolve(undefined);
    },
  });
}

function loadBackground(opts) {
  opts = opts || {};
  const calls = [];
  const listeners = [];
  const storeLocal = Object.assign({}, opts.storageLocal || {});
  const storeSession = Object.assign({}, opts.storageSession || {});
  const storageArea = (store, name) => ({
    get(keys, cb) {
      calls.push({ api: name + ".get", args: [keys] });
      let out = {};
      if (typeof keys === "string") out[keys] = store[keys];
      else if (Array.isArray(keys)) keys.forEach((k) => { out[k] = store[k]; });
      else if (keys && typeof keys === "object") Object.keys(keys).forEach((k) => { out[k] = k in store ? store[k] : keys[k]; });
      else out = Object.assign({}, store);
      if (typeof cb === "function") cb(out);
      return Promise.resolve(out);
    },
    set(obj) { calls.push({ api: name + ".set", args: [obj] }); Object.assign(store, obj); return Promise.resolve(); },
    remove(keys) { calls.push({ api: name + ".remove", args: [keys] }); [].concat(keys).forEach((k) => delete store[k]); return Promise.resolve(); },
    onChanged: { addListener() {} },
  });
  const chrome = {
    storage: {
      local: storageArea(storeLocal, "storage.local"),
      session: storageArea(storeSession, "storage.session"),
      onChanged: { addListener() {} },
    },
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      onConnect: { addListener() {} },
      getManifest: () => ({ version: "2.8.295" }),
      getURL: (p) => "chrome-extension://x/" + p,
      sendMessage: makeStub(calls, "runtime.sendMessage", null),
      lastError: null,
    },
    alarms: { create() {}, onAlarm: { addListener() {} }, get: () => Promise.resolve(null), clear: () => Promise.resolve(true) },
    tabs: makeStub(calls, "tabs", null),
    windows: makeStub(calls, "windows", null),
    scripting: makeStub(calls, "scripting", null),
    action: makeStub(calls, "action", null),
    sidePanel: makeStub(calls, "sidePanel", null),
    webNavigation: { onCompleted: { addListener() {} }, onBeforeNavigate: { addListener() {} } },
    tabGroups: makeStub(calls, "tabGroups", null),
    commands: { onCommand: { addListener() {} } },
  };
  // 足りない chrome.* は何でも受ける偽物（呼ばれた記録を残す・読むと偽物を返す）
  const deep = (name) => new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (prop === "addListener" || prop === "removeListener") return () => {};
      if (prop === "hasListener") return () => false;
      return deep(name + "." + String(prop));
    },
    apply(_t, _this, args) {
      calls.push({ api: name, args: Array.prototype.slice.call(args) });
      return Promise.resolve(undefined);
    },
  });
  // 試験ごとの差し替え: opts.chrome.tabs.query = async () => [...] のように書く（書いて無い物は偽物のまま）
  const overlay = (name, base, over) => new Proxy(base, {
    get(t, prop) {
      if (over && prop in over) return over[prop];
      if (prop in t) return t[prop];
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return deep(name + "." + String(prop));
    },
  });
  const chromeFull = new Proxy(chrome, {
    get(t, prop) {
      const ov = opts.chrome && opts.chrome[prop];
      if (ov) return overlay("chrome." + String(prop), t[prop] || {}, ov);
      if (prop in t) return t[prop];
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return deep("chrome." + String(prop));
    },
  });
  const ctx = {
    chrome: chromeFull,
    console: { log() {}, warn() {}, error() {}, info() {} },
    // 待ち時間は次の順番で流す（本物の待ちは要らない・窓の判定の前後の順番だけ見る）
    setTimeout: (f) => { setImmediate(typeof f === "function" ? f : () => {}); return 0; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    // 通信は返事を空で返す（本物の送信はしない）
    fetch: (url, opts) => {
      calls.push({ api: "fetch", args: [String(url), opts || {}] });
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ ok: true }), text: async () => "", blob: async () => ({ size: 0, type: "" }), arrayBuffer: async () => new ArrayBuffer(0) });
    },
    Date, Math, JSON, Promise, Map, Set, URL, Object, Array, String, Number, RegExp, Error,
    Symbol, Proxy, Reflect, AbortSignal, AbortController, TextEncoder, TextDecoder, URLSearchParams, atob, btoa,
    importScripts: () => {},
    self: null,
    globalThis: null,
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  // 読み込むファイル: 受け口のある background.js と、その下で使う共通の部品（順番は manifest の background.scripts と同じ）
  // background.js は ES モジュール（先頭の import "./x.js" は副作用だけ）。import 行を外し、同じ順で先に読む。
  const rawBg = fs.readFileSync(path.join(DIR, "background.js"), "utf8");
  const importRe = /^import\s+"\.\/([^"]+)";[^\n]*$/gm;
  const imported = [];
  let m;
  while ((m = importRe.exec(rawBg))) imported.push(m[1]);
  let bgSrc = rawBg.replace(importRe, "");
  // _takeShot など一部の関数は外側のブロックの中で定義されている（トップから見えない）。
  // テストでだけ、そのブロックの中で eval できる入口を差し込む（background.js 本体は変えない）。
  const marker = "async function _takeShot(msg, done) {";
  if (bgSrc.indexOf(marker) >= 0) {
    bgSrc = bgSrc.replace(marker, "globalThis.__bgEval = function (c) { return eval(c); };\n" + marker);
  }
  const pre = imported.map((f) => fs.readFileSync(path.join(DIR, f), "utf8")).join("\n;\n");
  ctx.__importedFiles = imported;
  try {
    vm.runInContext(pre + "\n;\n" + bgSrc, ctx, { filename: "background.js" });
  } catch (e) {
    throw new Error("background.js を読み込めない: " + (e && e.message));
  }
  return {
    ctx,
    calls,
    storeLocal,
    storeSession,
    /** 受け口を1つ呼ぶ（戻り値は sendResponse の中身）。非同期の受け口は flush を待つ */
    dispatch(msg, sender) {
      const res = { value: undefined, done: false };
      const sendResponse = (v) => { res.value = v; res.done = true; };
      let handled = false;
      for (const fn of listeners) {
        const r = fn(msg, sender || {}, sendResponse);
        if (r === true) handled = true;
      }
      return { handled, res };
    },
    /** 非同期の処理が終わるまで待つ（マイクロタスクを何回か回す） */
    async flush(n) {
      for (let i = 0; i < (n || 20); i++) await new Promise((r) => setImmediate(r));
    },
  };
}

module.exports = { loadBackground };
