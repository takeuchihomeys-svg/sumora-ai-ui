// 実行: node tests/chrome-extension/shot-shrink-v2688.test.js
// 2026-11-11 竹内さん「まだ写真クラウドにおくれていないのか」
//
//   写真は撮れていて、送信の列にも積まれていた。**届かなかった理由は大きさ**。
//   フルHD画面のJPEG（quality 55）は 3MB を超えることがあり、
//   サーバーは 3MB 超を**黙って捨てていた**（エラーも返さない）＝「送ったのに届かない」。
//
//   ① 送る前に縮める（長辺1280px・JPEG 45% → 200〜400KB）
//   ② 大きすぎて捨てた時は**理由を返す**
//   ③ 置けなかった時も**理由を返す**
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
const readApi = () => fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "human-motion", "route.ts"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bg = read("background.js"), api = readApi();

console.log("■ ① 送る前に縮める");
{
  ok("縮める関数がある（_shrinkShot）", /async function _shrinkShot\(dataUrl, maxSide, quality\)/.test(bg));
  ok("OffscreenCanvas を使う（service worker に DOM は無い）", /OffscreenCanvas/.test(bg) && /createImageBitmap/.test(bg));
  ok("長辺 800px に縮める", /_shrinkShot\(dataUrl, 800, 0\.32\)/.test(bg));
  ok("JPEG 32% で保存", /quality: quality \|\| 0\.45/.test(bg) || /0\.32/.test(bg));
  ok("使えない環境では null（＝元の大きさで送る・止まらない）", /if \(typeof OffscreenCanvas === "undefined"/.test(bg));
  ok("送るのは縮めた物（shotForUpload）", /data_url: shotForUpload/.test(bg));
  ok("縮めた大きさを記録に残す", /shot_w: shotW, shot_h: shotH/.test(bg));
  ok("元と送る物の大きさをログに出す", /撮りました: 元 /.test(bg));
}

console.log("\n■ ② サーバーは黙って捨てない（理由を返す）");
{
  ok("空の画像は理由を返す", /error: "image_empty"/.test(api));
  ok("大きすぎる時は 413 と理由", /error: "image_too_large"/.test(api) && /413/.test(api));
  ok("大きさ（bytes）も返す", /bytes: buf\.length/.test(api));
  ok("Storage に置けなかった時も理由を返す", /error: "storage: " \+ up\.error\.message/.test(api));
  ok("3MB の上限は残す（Storage を守る）", /3_000_000/.test(api));
}

console.log("\n■ ③ 画面の帯に結果が出る（成功も失敗も）");
{
  const sp = read("snapshot-popup.js");
  ok("写真テストでクラウドに上がったかまで見る", /axlx_human_shot_upload/.test(sp));
  ok("上がったら「クラウドに上がりました」", /クラウドに上がりました/.test(sp));
  ok("上がらなければ理由を出す", /クラウドに上がりませんでした/.test(sp));
  ok("失敗の理由（error / status）を出す", /u\.error \|\| \("status " \+ u\.status\)/.test(sp));
}

console.log("\n■ ④ 送信の結果を必ず残す（成功・失敗の両方）");
{
  ok("成功を残す（ok: true）", /axlx_human_shot_upload: \{ ok: true/.test(bg));
  ok("失敗を残す（ok: false・status）", /axlx_human_shot_upload: \{ ok: false, status: res\.status/.test(bg));
  ok("例外も残す（ok: false・error）", /axlx_human_shot_upload: \{ ok: false, error:/.test(bg));
  ok("送信中の印を先に置く（phase: sending）", /phase: "sending"/.test(bg));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
