// 実行: node tests/chrome-extension/shot-upload-works-v2685.test.js
// 2026-11-11 竹内さん「こうでた」（写真テストが「アップロードの結果はまだ」）
//
//   写真は**撮れていた**のに、クラウドへ送る処理が毎回失敗していた。
//   原因は `chrome.storage.local.get(...).catch(...)`。
//   `chrome.storage.local.get` は**Promise を返さない**（コールバック式）ので、
//   `.catch` を呼ぶと `Cannot read properties of undefined (reading 'catch')` で落ちていた。
//
//   このテストは **実際に動かして**「積む → 送る（fetch まで行く）」を確かめる。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const src = fs.readFileSync(path.join(EXT, "background.js"), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

function grab(name) {
  const s = src.indexOf("function " + name);
  if (s < 0) return "";
  let d = 0, i = src.indexOf("{", s);
  for (; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (d === 0) break; }
  }
  return src.slice(s, i + 1);
}

console.log("■ ① 原因になった書き方が残っていない");
{
  ok("storage.local.get(...).catch をしていない", !/chrome\.storage\.local\.get\([^)]*\)\.catch/.test(src));
  ok("device_label は await で受ける", /device_label: await \(async function/.test(src));
}

console.log("\n■ ② 実際に動かす（積む → 送る）");
{
  let fetchCalls = [];
  let storageSet = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, String, Number, Object, Array, Promise, setTimeout,
    AbortSignal: { timeout: () => null },
    SUMORA_BATCH_API: "https://example.test",
    _getAutomationKeyHeader: async () => ({}),
    _snapInstallId: async () => "test-install",
    _extVersion: () => "2.6.93",
    fetch: async (url, opts) => {
      fetchCalls.push({ url, bodyLen: opts && opts.body ? opts.body.length : 0 });
      return { ok: true, status: 200 };
    },
    chrome: { storage: { local: {
      get: (k, cb) => { if (cb) cb({}); return Promise.resolve({}); },
      set: (o, cb) => { storageSet.push(Object.keys(o).join(",")); if (cb) cb(); },
    } } },
  };
  const code = [
    "var _shotUploadQueue = [];",
    "var _shotUploading = false;",
    "var _shotUploadStartedAt = 0;",
    grab("_enqueueShotUpload"),
    grab("_pumpShotUpload"),
  ].join("\n");
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  sandbox._enqueueShotUpload({ data_url: "data:image/jpeg;base64,AAAA", site: "realpro", run_id: "r1", seq: 1 });

  const done = new Promise((r) => setTimeout(r, 350));
  done.then(() => {
    ok("fetch が呼ばれた（送信まで行った）", fetchCalls.length === 1, fetchCalls.length);
    ok("送り先は /api/human-motion", fetchCalls[0] && /\/api\/human-motion$/.test(fetchCalls[0].url), fetchCalls[0] && fetchCalls[0].url);
    ok("写真の中身が載っている（300B以上）", fetchCalls[0] && fetchCalls[0].bodyLen > 300, fetchCalls[0] && fetchCalls[0].bodyLen);
    ok("結果を storage に残す（成功/失敗が分かる）", storageSet.some((k) => k.indexOf("axlx_human_shot_upload") >= 0), storageSet);

    console.log("\n■ ③ 張り付き対策・結果の記録");
    ok("送信中の張り付きを30秒で解く", /_shotUploadStartedAt < 30000/.test(grab("_pumpShotUpload")) || /30000/.test(src));
    ok("始めた印を先に置く（phase: sending）", /phase: "sending"/.test(src));
    ok("失敗したら理由を残す", /axlx_human_shot_upload: \{ ok: false/.test(src));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
}
