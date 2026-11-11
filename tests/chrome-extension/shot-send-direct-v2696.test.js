// 実行: node tests/chrome-extension/shot-send-direct-v2696.test.js
// 2026-11-11 竹内さん「写真もまだとれていない真の原因をちゃんとみつける。写真の容量も小さく」
//
//   ★ 真の原因（3つ）
//     ① 写真は**学習の中**から撮っていた → 自動・AIX では学習しないので**撮られもしない**
//     ② 送信は**キュー**を通していた → キューは巨大な `if (msg.type === ...)` の中にあり、
//        メッセージのたびに作り直される。積んだ物が消える事があった
//     ③ 送る前に縮めていなかった → フルHD の JPEG は 3MB を超え、サーバーが**黙って捨てた**
//
//   直し: **キューをやめて、撮ったらその場で縮めて送る**（`_sendShotNow`）。
//         縮小は **長辺1000px・JPEG40%**（100〜250KB）。
//   このテストは **_sendShotNow を実際に動かして** fetch まで行くことを確かめる。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const src = fs.readFileSync(path.join(EXT, "background.js"), "utf8").replace(/\r\n/g, "\n");
const rec = fs.readFileSync(path.join(EXT, "human-learn-record.js"), "utf8").replace(/\r\n/g, "\n");

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

console.log("■ ① 写真は「学習」と切り離した（自動・AIX でも撮る）");
{
  ok("shouldShoot がある（モードに関係なく撮る）", /function shouldShoot\(st\)/.test(rec));
  ok("shouldLearn と shouldShoot を別々に使う", /if \(shouldLearn\(st\)\)/.test(rec) && /if \(shouldShoot\(st\)\) startShooting\(\)/.test(rec));
  ok("shootAfter は「撮る見張り」でも動く（学習中でなくても）", /if \(!_shooting && !watching\) \{ diag\(false, "not_shooting"\); return; \}/.test(rec));
  ok("自前の見張り（startShooting）がある", /function startShooting\(\)/.test(rec));
  ok("起動直後に1枚撮る（撮れるか確かめられる）", /setTimeout\(function \(\) \{ shootAfter\("startup"/.test(rec));
}

console.log("\n■ ② キューをやめて「その場で送る」");
{
  ok("_sendShotNow がある", /async function _sendShotNow\(job\)/.test(src));
  ok("キューに積まず直接送る（撮った所から）", /_sendShotNow\(\{[\s\S]{0,300}data_url: shotForUpload/.test(src));
  ok("キュー方式は廃止（_pumpShotUpload は空）", /function _pumpShotUpload\(\) \{\s*\/\* 旧のキュー方式は廃止/.test(src));
  ok("_enqueueShotUpload を呼んでいない", !/_enqueueShotUpload\(/.test(src));
  ok("同時に送りすぎない（上限つき）", /if \(_shotSending >= 3\)/.test(src));
}

console.log("\n■ ③ 容量を小さくする（長辺1000px・JPEG40%）");
{
  ok("縮小は 1000px・40%", /_shrinkShot\(dataUrl, 1000, 0\.40\)/.test(src));
  ok("縮めた物を送る（元の大きさではない）", /data_url: shotForUpload/.test(src));
  ok("元と送る物の大きさをログに出す", /撮りました: 元 /.test(src));
  ok("OffscreenCanvas を使う（service worker に DOM が無い）", /OffscreenCanvas/.test(src) && /createImageBitmap/.test(src));
}

console.log("\n■ ④ 実際に動かす（縮小→送信）");
{
  let fetchCalls = [];
  let sets = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, String, Number, Object, Array, Promise, setTimeout,
    AbortSignal: { timeout: () => null },
    SUMORA_BATCH_API: "https://example.test",
    _shotSending: 0,
    chrome: { storage: { local: { get: async () => ({}), set: (o) => sets.push(o) } } },
    _getAutomationKeyHeader: async () => ({}),
    _snapInstallId: async () => "test",
    _extVersion: () => "2.6.98",
    fetch: async (url, opts) => { fetchCalls.push({ url, len: opts.body.length }); return { ok: true, status: 200, text: async () => '{"ok":true}' }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(grab("_sendShotNow"), sandbox);

  const p = sandbox._sendShotNow({ data_url: "data:image/jpeg;base64," + "A".repeat(4000), site: "realpro", run_id: "r1", seq: 1 });
  p.then(function (r) {
    ok("fetch が呼ばれた（送信まで行った）", fetchCalls.length === 1, fetchCalls.length);
    ok("送り先は /api/human-motion", fetchCalls[0] && /\/api\/human-motion$/.test(fetchCalls[0].url));
    ok("成功を記録した（ok: true）", sets.some((s) => s.axlx_human_shot_upload && s.axlx_human_shot_upload.ok === true));
    ok("戻り値も ok", r && r.ok === true, r);

    console.log("\n■ ⑤ 失敗したら理由を残す（黙って捨てない）");
    ok("HTTP エラーは status と本文を残す", /axlx_human_shot_upload: \{ ok: false, status: res\.status, error:/.test(src));
    ok("例外も残す", /axlx_human_shot_upload: \{ ok: false, error: msg, at:/.test(src));
    ok("送信中の印を先に置く（phase: sending）", /phase: "sending"/.test(src));
    ok("サーバーは大きすぎる写真を黙って捨てない", /error: "image_too_large"/.test(fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "human-motion", "route.ts"), "utf8")));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
}
