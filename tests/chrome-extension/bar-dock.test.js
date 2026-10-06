// 実行: node tests/chrome-extension/bar-dock.test.js
// 2026-10-06 v2.5.74 竹内「itandiの本来あるまとめて図面取得が押せない 拡張ツールが原因してるのかな？ 原因みつけて改善する」
//   原因: ITANDI の一括の枠（右下・fixed・z-index 最大）が、ITANDI が行のチェックで出す下の帯（すべて選択・まとめて図面取得）の右のボタンに重なっていた。
//   ① bar-dock.js の純関数（重なりの上へ逃がす bottom）
//   ② 実画面の形（画面の高さ 900・下の帯 840〜900・右に「まとめて図面取得」）を偽の document で再現して、枠が帯の上へ上がるか
//   ③ 拡張が ITANDI のボタンを止めない・押さえない（ファイルの中身）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const D = require(path.join(dir, "bar-dock.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

console.log("── ① 純関数");
ok("重なりが無ければ元の位置（24px）", D.dockBottom({ base: 24, vh: 900, hitTops: [] }) === 24);
ok("下の帯のボタン（上端 850）に重なる → その 10px 上（bottom 60）", D.dockBottom({ base: 24, vh: 900, hitTops: [850, 856], margin: 10 }) === 60);
ok("元の位置の方が高ければ元のまま", D.dockBottom({ base: 120, vh: 900, hitTops: [850], margin: 10 }) === 120);
ok("画面からはみ出さない（上は 8px まで）", D.dockBottom({ base: 24, vh: 900, hitTops: [40], margin: 10, barH: 100 }) === 792);
ok("四角の重なり", D.overlaps({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 5, right: 15, top: 5, bottom: 15 }) && !D.overlaps({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 10, right: 20, top: 0, bottom: 10 }));

console.log("── ② 実画面の形（ITANDI 289件・2行にチェック・下の帯に「まとめて図面取得」）");
{
  const VH = 900, VW = 1400;
  const mk = (o) => Object.assign({ nodeType: 1, id: "", className: "", parentElement: null, style: {}, closest(sel) { let n = this; while (n) { if (n._match && n._match(sel)) return n; n = n.parentElement; } return null; }, contains(x) { let n = x; while (n) { if (n === this) return true; n = n.parentElement; } return false; } }, o);
  const body = mk({ tag: "BODY" });
  const nativeBar = mk({ tag: "DIV", parentElement: body, _pos: "fixed", rect: { left: 0, right: VW, top: 840, bottom: 900, width: VW, height: 60 } });
  const allSel = mk({ tag: "BUTTON", parentElement: nativeBar, _match: (s) => /button/.test(s), rect: { left: 20, right: 140, top: 852, bottom: 888, width: 120, height: 36 } });
  const zumen = mk({ tag: "BUTTON", parentElement: nativeBar, _match: (s) => /button/.test(s), rect: { left: 1150, right: 1370, top: 850, bottom: 890, width: 220, height: 40 } });
  const zumenLabel = mk({ tag: "SPAN", parentElement: zumen, rect: zumen.rect });
  const rowBtn = mk({ tag: "BUTTON", parentElement: body, _pos: "static", _match: (s) => /button/.test(s), rect: { left: 1150, right: 1250, top: 700, bottom: 730, width: 100, height: 30 } });
  // 拡張の枠（右下 24px・高さ 90・幅 260）。bottom を変えると四角も変わる
  const bar = mk({ tag: "DIV", id: "axlx-itandi-bar", parentElement: body, style: { display: "flex", bottom: "24px" } });
  Object.defineProperty(bar, "rect", { get() { const b = parseInt(bar.style.bottom, 10) || 0; return { left: VW - 24 - 260, right: VW - 24, top: VH - b - 90, bottom: VH - b, width: 260, height: 90 }; } });
  const all = [nativeBar, allSel, zumen, zumenLabel, rowBtn];
  for (const el of all.concat([bar])) el.getBoundingClientRect = function () { return this.rect; };
  global.window = { innerHeight: VH, innerWidth: VW };
  global.getComputedStyle = (el) => ({ position: el._pos || "static" });
  global.document = {
    body,
    elementsFromPoint(x, y) {
      const hit = (el) => { const r = el.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; };
      const out = [];
      if (hit(bar)) out.push(bar);
      for (const el of [zumenLabel, zumen, allSel, rowBtn, nativeBar]) if (hit(el)) out.push(el);
      out.push(body);
      return out;
    },
  };
  const tops = D.hitTopsUnder(bar);
  ok("枠の下に「まとめて図面取得」（固定の帯の中のボタン）が見つかる", tops.length >= 1 && tops.every((t) => t === 850), tops);
  const b = D.applyBottom(bar, 24, 10);
  ok("枠を帯の上へ上げる（bottom 60px＝図面取得の上端 850 の 10px 上）", b === 60 && bar.style.bottom === "60px", { b, bottom: bar.style.bottom });
  ok("上げた後は図面取得に重ならない", !D.overlaps(bar.getBoundingClientRect(), zumen.getBoundingClientRect()));
  // 帯が消えた（チェックを外した）→ 元の位置に戻る
  nativeBar.rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  zumen.rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; zumenLabel.rect = zumen.rect;
  ok("帯が消えたら元の位置（24px）に戻る", D.applyBottom(bar, 24, 10) === 24 && bar.style.bottom === "24px");
  // 行の中の普通のボタン（固定ではない）には反応しない（スクロールで行が下に来ても枠は動かない）
  rowBtn.rect = { left: 1150, right: 1300, top: 800, bottom: 860, width: 150, height: 60 };
  ok("一覧の行のボタン（固定でない）では枠を動かさない", D.applyBottom(bar, 24, 10) === 24);
  delete global.window; delete global.document; delete global.getComputedStyle;
}

console.log("── ③ 拡張は ITANDI のボタンを止めない・押さえない");
const ib = read("itandi-bulk-dl.js"), ig = read("itandi-guide.js");
ok("全ページ送るの止め（lockAutoPaging）は拡張の自分のボタンだけ", /function lockAutoPaging\(\) \{\r?\n\s*var b = document\.getElementById\("axlx-itandi-all-pages-btn"\);/.test(ig));
ok("ITANDI 一括の枠: 下の帯の上へ逃がす（applyBottom）・ITANDI のチェックを押した後・画面の変化・大きさの変化で見直す", /D\.applyBottom\(bar, IT_BAR_BOTTOM, 10\)/.test(ib) && /if \(!_own\) dockItBarSoon\(\);/.test(ib) && /window\.addEventListener\("resize", dockItBarSoon\)/.test(ib) && /document\.addEventListener\("click", function \(\) \{ dockItBarSoon\(\); \}, true\)/.test(ib));
ok("ITANDI 一括の枠: 1行に畳める（この PC に覚える）", /axlx-itandi-fold-btn/.test(ib) && /axlx_itandi_bar_folded/.test(ib));
ok("拡張の ITANDI のファイルに preventDefault で ITANDI のクリックを止める所が無い（枠を動かす所だけ）", !/preventDefault/.test(ib) && (ig.match(/preventDefault/g) || []).length === 1 && /e\.preventDefault\(\);\r?\n\s*\}\r?\n\s*function onPanelClick/.test(ig));
ok("ITANDI のボタン・チェックの disabled を触らない（触るのは拡張のボタンだけ）", !/querySelectorAll\([^)]*button[^)]*\)[\s\S]{0,80}\.disabled\s*=/.test(ib + ig));
const rp = read("bulk-dl.js");
ok("リアプロの枠も重なる時だけ逃がす（スタッフが動かした位置は変えない）", /D\.applyTopAvoid\(bar, 10\)/.test(rp) && /bar\.removeAttribute\("data-axlx-docked"\); \/\/ v2\.5\.74/.test(rp));
const mf = JSON.parse(read("manifest.json"));
ok("manifest: bar-dock.js は両方の一括の段の先頭・版 2.5.74", mf.content_scripts.some((c) => c.js[0] === "bar-dock.js" && c.js[c.js.length - 1] === "bulk-dl.js") && mf.content_scripts.some((c) => c.js[0] === "bar-dock.js" && c.js[c.js.length - 1] === "itandi-bulk-dl.js") && mf.version === "2.5.74");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
