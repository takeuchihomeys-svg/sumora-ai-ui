// 実行: node tests/chrome-extension/shot-upload-works-v2685.test.js
// 2026-11-11 竹内さん「こうでた」（写真テストが「アップロードの結果はまだ」）
//
//   この版（v2.7.0）で **キュー方式は廃止**し、`_sendShotNow` で**その場で送る**形になった。
//   ここでは「送信が fetch まで行くこと」「理由を必ず残すこと」だけを固定する
//   （縮小・長辺・並列の細部は shot-send-direct-v2696.test.js が見る）。
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
  const a = src.indexOf("async function " + name);
  const b = src.indexOf("function " + name);
  const s = a >= 0 ? a : b;
  if (s < 0) return "";
  let d = 0, i = src.indexOf("{", s);
  for (; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (d === 0) break; }
  }
  return src.slice(s, i + 1);
}

console.log("■ 原因になった書き方が残っていない");
{
  ok("storage.local.get(...).catch をしていない", !/chrome\.storage\.local\.get\([^)]*\)\.catch/.test(src));
  ok("キュー方式は廃止（_enqueueShotUpload を呼んでいない）", !/_enqueueShotUpload\(/.test(src));
  ok("その場で送る関数がある（_sendShotNow）", /async function _sendShotNow\(job\)/.test(src));
}

console.log("\n■ 実際に動かす（送信まで行く）");
{
  let fetchCalls = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, String, Number, Object, Array, Promise, setTimeout,
    AbortSignal: { timeout: () => null },
    SUMORA_BATCH_API: "https://example.test",
    _shotSending: 0,
    chrome: { storage: { local: { get: async () => ({}), set: () => {} } } },
    _getAutomationKeyHeader: async () => ({}),
    _snapInstallId: async () => "t",
    _extVersion: () => "2.7.14",
    fetch: async (url, opts) => { fetchCalls.push({ url, len: opts.body.length }); return { ok: true, status: 200, text: async () => '{"ok":true}' }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(grab("_sendShotNow"), sandbox);
  sandbox._sendShotNow({ data_url: "data:image/jpeg;base64,AAAA", site: "realpro", run_id: "r1", seq: 1 }).then((r) => {
    ok("fetch が呼ばれた（送信まで行った）", fetchCalls.length === 1, fetchCalls.length);
    ok("送り先は /api/human-motion", fetchCalls[0] && /\/api\/human-motion$/.test(fetchCalls[0].url));
    ok("戻り値が ok", r && r.ok === true);

    console.log("\n■ 失敗したら理由を残す（黙って捨てない）");
    ok("HTTP エラーは status と本文を残す", /axlx_human_shot_upload: \{ ok: false, status: res\.status, error:/.test(src));
    ok("例外も残す", /axlx_human_shot_upload: \{ ok: false, error: msg, at:/.test(src));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
}
