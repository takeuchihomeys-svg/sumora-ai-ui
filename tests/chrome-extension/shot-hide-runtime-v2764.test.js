// tests/chrome-extension/shot-hide-runtime-v2764.test.js
// 実行: node tests/chrome-extension/shot-hide-runtime-v2764.test.js
// 2026-11-14 竹内さん「これで改善されたかな」（文字があるかだけでなく、動かして確かめる）
//
// ★ 2.8.141 竹内さん「白黒にフラッシュになってしまう」:
//   撮る瞬間に小窓を隠す方式をやめ、**写真の方を塗る**方式にした。
//   このテストは **偽のページを作って、本物の `_shotMaskRects`（窓の位置）と `_maskShot`（写真を塗る）を動かす**。
//     ・画面の 2% 以上の拡張の窓 → 塗る位置に入る
//     ・小さい印・見えていない窓 → 入らない
//     ・⚠ html に見えるカーソルの印（旧 `axlx-one-cursor`）があっても、ページ全体を塗らない（実測: 写真14枚が真っ白）
//     ・窓の中の部品は数えない（12枠を使い切って2つ目の窓が漏れない）
//     ・画面の外は切る
//     ・写真の大きさ（拡大率）に合わせて塗る
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const src = fs.readFileSync(path.join(dir, "human-learn-record.js"), "utf8").replace(/\r\n/g, "\n");
const bgSrc = fs.readFileSync(path.join(dir, "background.js"), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

function extractFn(text, head) {
  const start = text.indexOf(head);
  if (start < 0) throw new Error(head + " が見つからない");
  let d = 0, i = text.indexOf("{", start);
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) { i++; break; } }
  }
  return text.slice(start, i);
}

/** 偽の要素（親子・class・大きさ・見え方だけ持つ） */
function el(id, cls, rect, style) {
  const e = {
    id, className: cls || "", parent: null, kids: [], _style: style || {},
    getBoundingClientRect: () => ({
      left: rect[0], top: rect[1], width: rect[2], height: rect[3], right: rect[0] + rect[2], bottom: rect[1] + rect[3],
    }),
    contains(o) { for (let p = o; p; p = p.parent) if (p === e) return true; return false; },
    add(...cs) { for (const c of cs) { c.parent = e; e.kids.push(c); } return e; },
  };
  return e;
}
function all(root) { const out = []; (function walk(n) { out.push(n); n.kids.forEach(walk); })(root); return out; }
/** 拡張の印（id/class の axlx- / aixlinx-）＝ SHOT_HIDE_SEL と同じ判定 */
function isExt(n) { return /axlx-|aixlinx-/.test(n.id || "") || /axlx-|aixlinx-/.test(n.className || ""); }

function runRects(html, body, vw, vh) {
  const fn = extractFn(src, "function _shotMaskRects()");
  const fakeDoc = {
    documentElement: html, body,
    querySelectorAll: () => all(html).filter(isExt),
  };
  const fakeWin = {
    innerWidth: vw, innerHeight: vh,
    getComputedStyle: (n) => Object.assign({ visibility: "visible", display: "block", opacity: "1" }, n._style),
  };
  const factory = new Function("document", "window",
    "var SHOT_HIDE_SEL = \"[id^='axlx-']\";\n" + fn + "\nreturn _shotMaskRects();");
  return factory(fakeDoc, fakeWin);
}

console.log("■ ① 画面を覆う拡張の窓だけが塗る位置に入る（サイトの要素は入らない）");
{
  const html = el("", "", [0, 0, 1920, 1080]);
  const body = el("", "", [0, 0, 1920, 1080]);
  const big = el("aixlinx-float-wrap", "", [700, 300, 520, 400]);
  const bar = el("axlx-bar", "", [1700, 0, 220, 900]);
  const site = el("suumo-list", "", [0, 0, 1200, 600]);
  html.add(body); body.add(big, bar, site);
  const r = runRects(html, body, 1920, 1080);
  ok("  2つ入る", r.rects.length === 2, r.rects);
  ok("  中央の窓の位置", JSON.stringify(r.rects[0]) === JSON.stringify({ x: 700, y: 300, w: 520, h: 400 }), r.rects[0]);
  ok("  画面の大きさも返す", r.vw === 1920 && r.vh === 1080);
}

console.log("\n■ ② ⚠ html に見えるカーソルの印（axlx-one-cursor）があってもページ全体を塗らない");
{
  const html = el("", "axlx-one-cursor", [0, 0, 1920, 1080]);
  const body = el("", "", [0, 0, 1920, 1080]);
  const big = el("aixlinx-float-wrap", "", [700, 300, 520, 400]);
  html.add(body); body.add(big);
  const r = runRects(html, body, 1920, 1080);
  ok("  ⚠ html は入らない（入ると写真が全部灰色＝旧は真っ白に隠れた）", r.rects.every((x) => x.w < 1920), r.rects);
  ok("  窓だけ1つ", r.rects.length === 1, r.rects);
  const body2 = el("", "axlx-x", [0, 0, 1920, 1080]);
  const html2 = el("", "", [0, 0, 1920, 1080]).add(body2);
  ok("  ⚠ body に印があっても入らない", runRects(html2, body2, 1920, 1080).rects.length === 0);
  const html3 = el("", "", [0, 0, 1920, 1080]);
  const body3 = el("", "", [0, 0, 1920, 1080]);
  const cover = el("axlx-cover", "", [0, 0, 1900, 1000]);
  html3.add(body3); body3.add(cover);
  ok("  ⚠ 画面の 85% 以上を覆う物は入らない", runRects(html3, body3, 1920, 1080).rects.length === 0);
}

console.log("\n■ ③ 小さい印・見えていない窓は入らない");
{
  const html = el("", "", [0, 0, 1920, 1080]);
  const body = el("", "", [0, 0, 1920, 1080]);
  const badge = el("axlx-learn-badge", "", [10, 10, 100, 20]);
  const hid = el("axlx-guide", "", [100, 100, 600, 400], { visibility: "hidden" });
  const none = el("axlx-guide2", "", [100, 100, 600, 400], { display: "none" });
  const zero = el("axlx-guide3", "", [100, 100, 600, 400], { opacity: "0" });
  html.add(body); body.add(badge, hid, none, zero);
  ok("  どれも入らない", runRects(html, body, 1920, 1080).rects.length === 0);
  const html2 = el("", "", [0, 0, 320, 240]);
  const body2 = el("", "", [0, 0, 320, 240]);
  const mid = el("axlx-learn-badge", "", [0, 0, 100, 20]);
  html2.add(body2); body2.add(mid);
  ok("  2.6% なら入る（面積比で決めている）", runRects(html2, body2, 320, 240).rects.length === 1);
}

console.log("\n■ ④ 窓の中の部品は数えない（2つ目の窓が漏れない）");
{
  const html = el("", "", [0, 0, 1920, 1080]);
  const body = el("", "", [0, 0, 1920, 1080]);
  const panel = el("axlx-bulk-panel", "", [1500, 0, 420, 1000]);
  for (let i = 0; i < 20; i++) panel.add(el("axlx-row-" + i, "", [1500, i * 50, 420, 48]));
  const big = el("aixlinx-float-wrap", "", [700, 300, 520, 400]);
  html.add(body); body.add(panel, big);
  const r = runRects(html, body, 1920, 1080);
  ok("  ⚠ パネルと中央の窓の2つ（中の20行は数えない）", r.rects.length === 2, r.rects);
}

console.log("\n■ ⑤ 画面の外は切る");
{
  const html = el("", "", [0, 0, 1000, 800]);
  const body = el("", "", [0, 0, 1000, 800]);
  const w = el("axlx-bar", "", [800, -100, 400, 500]);
  html.add(body); body.add(w);
  const r = runRects(html, body, 1000, 800);
  ok("  切った位置", JSON.stringify(r.rects[0]) === JSON.stringify({ x: 800, y: 0, w: 200, h: 400 }), r.rects[0]);
}

console.log("\n■ ⑥ 本物の _maskShot が写真の大きさに合わせて塗る");
(async () => {
  const fn = extractFn(bgSrc, "async function _maskShot(dataUrl, info)");
  const fills = [];
  let style = "";
  class FakeCanvas {
    constructor(w, h) { this.w = w; this.h = h; }
    getContext() {
      return {
        drawImage() {},
        set fillStyle(v) { style = v; }, get fillStyle() { return style; },
        fillRect: (x, y, w, h) => fills.push([x, y, w, h]),
      };
    }
    async convertToBlob() { return new Blob([Buffer.from("MASKED")]); }
  }
  const factory = new Function("OffscreenCanvas", "createImageBitmap", "atob", "btoa", "Blob",
    fn + "\nreturn _maskShot;");
  const maskShot = factory(FakeCanvas, async () => ({ width: 3840, height: 2160, close() {} }), atob, btoa, Blob);
  const src64 = "data:image/jpeg;base64," + Buffer.from("PHOTO").toString("base64");
  const out = await maskShot(src64, { rects: [{ x: 700, y: 300, w: 520, h: 400 }], vw: 1920, vh: 1080 });
  ok("  塗った写真を返す", Buffer.from(out.split(",")[1], "base64").toString() === "MASKED", out.slice(0, 60));
  ok("  ⚠ 拡大率2倍に合わせて塗る", JSON.stringify(fills[0]) === JSON.stringify([1400, 600, 1040, 800]), fills);
  ok("  灰色", style === "#808080", style);
  const same = await maskShot(src64, { rects: [], vw: 1920, vh: 1080 });
  ok("  塗る所が無ければ元のまま", same === src64);
  const brokenFactory = new Function("OffscreenCanvas", "createImageBitmap", "atob", "btoa", "Blob", fn + "\nreturn _maskShot;");
  const broken = brokenFactory(FakeCanvas, async () => { throw new Error("decode"); }, atob, btoa, Blob);
  ok("  ⚠ 失敗しても元の写真を返す（撮影は止めない）", (await broken(src64, { rects: [{ x: 0, y: 0, w: 10, h: 10 }], vw: 100, vh: 100 })) === src64);

  console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
  if (failed > 0) process.exit(1);
})();
