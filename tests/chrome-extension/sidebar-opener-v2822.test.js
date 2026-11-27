// 実行: node tests/chrome-extension/sidebar-opener-v2822.test.js
// v2.8.122 2026-11-19 竹内さん「うごきも人間のようになっているのか・抜けている部分あれば改善して強化する」
//
// DB実測（#1532 くれあ・2.8.121・読むだけ）:
//   前の客の駅5・沿線1が残ったまま区3を入れ、関所「地域と駅が同時に入っている」→ gate_retry 2/6・3/6…
//   「沿線・駅絞り込み＋」を押しても小窓が開かず（screen_grasp station=unknown lineVis=0）人が止めた。
//   押した箱は div.one_slide_search_box 210×204（他の絞り込みもまとめた外側の箱）。写真 23043 でカーソルは「閲覧履歴」の辺り。
//   人は `左の沿線・駅絞り込み＋｜span` を押している。
//   さらに押下1回に span 160×30 と div 195×50 の記録が 0.43〜0.57秒差で2本（見えるカーソルの tap が2回）。
const fs = require("fs");
const path = require("path");

const read = (f) => fs.readFileSync(path.join(__dirname, "../../chrome-extension", f), "utf8").replace(/\r\n/g, "\n");
const ps = read("page-script.js");
const mf = JSON.parse(read("manifest.json"));
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || detail === undefined ? "" : "\n      " + JSON.stringify(detail).slice(0, 300))); }

function extractFn(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return null;
  let depth = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return null;
}

console.log("■ ① 一番内側の開くボタンを選ぶ");
const fnSrc = extractFn(ps, "_sidebarOpenerEl");
ok("_sidebarOpenerEl がある", !!fnSrc);
const reM = ps.match(/var _SIDEBAR_OTHER_RE = (\/.*\/);/);
ok("_SIDEBAR_OTHER_RE がある", !!reM);
{
  const mk = (text, w, h, cls) => ({ textContent: text, cls, getBoundingClientRect: () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h }) });
  const wrapper = mk("リスト検索 閲覧履歴 所在地絞り込み＋ 沿線・駅絞り込み＋ 駅からの移動手段", 210, 204, "one_slide_search_box");
  const inner = mk("沿線・駅絞り込み ＋", 195, 50, "one_slide_search_box");
  const area = mk("所在地絞り込み ＋", 160, 30, "click_menu");
  const run = (findHit, list) => {
    const document = { querySelectorAll: () => list };
    const norm = (s) => String(s || "").replace(/[\s　]+/g, "");
    const isVisible = () => true;
    const _findByText = () => findHit;
    const _SIDEBAR_OTHER_RE = eval(reM[1]);
    // eslint-disable-next-line no-new-func
    const f = new Function("document", "norm", "isVisible", "_findByText", "_SIDEBAR_OTHER_RE", fnSrc + "; return _sidebarOpenerEl;")(document, norm, isVisible, _findByText, _SIDEBAR_OTHER_RE);
    return (w) => f(w, _SIDEBAR_OTHER_RE);
  };
  const span = { tag: "span" };
  ok("文字の一番内側（_findByText）があればそれを押す", run(span, [wrapper, inner, area])("沿線・駅絞り込み") === span);
  ok("無い時: 外側の箱（210×204）ではなく内側の箱を選ぶ（文書の順が外側先でも）", run(null, [wrapper, inner, area])("沿線・駅絞り込み") === inner);
  ok("所在地も同じ（外側の箱を選ばない）", run(null, [wrapper, inner, area])("所在地絞り込み") === area);
  ok("他の絞り込み・閲覧履歴を含む箱しか無い時は押さない（null→文字で探す受け皿へ）", run(null, [wrapper])("沿線・駅絞り込み") === null);
}

console.log("\n■ ② 3か所とも外側の箱から探さない");
{
  // 退役（段階1・2026-11-27）: 1つずつ外し・段の外し・押し直しを廃止したため確認対象外 — 区の前に駅を外す時
  // 退役（段階1・2026-11-27）: 1つずつ外し・段の外し・押し直しを廃止したため確認対象外 — 駅の前に区を外す時
  ok("駅の入口（station_open）は内側を先に・旧の探し方は受け皿", /_sidebarOpenerEl\('沿線・駅絞り込み', _SIDEBAR_OTHER_RE\);[\s\S]{0,300}'station_open'\);[\s\S]{0,200}var clsTargets = \['click_menu', 'one_slide_search_box'\];/.test(ps));
  ok("文書の順で外側の箱を拾う旧の書き方が残っていない", !/document\.querySelectorAll\("div\.click_menu, div\.one_slide_search_box"\)\);\n\s*for \(var i = 0; i < divs\.length; i\+\+\) \{\n\s*if \(!isVisible\(divs\[i\]\)\) continue;\n\s*if \(\/(沿線・駅|所在地)絞り込み\//.test(ps));
}

console.log("\n■ ③ 見えるカーソルの「押す」は押下1回に1回");
{
  const i = ps.indexOf("var _doTap = function () {");
  const seg = ps.slice(i, i + 300);
  ok("_doTap で tap しない（_fireAt の中で1回）", i > 0 && !/_P\.tap\(\)/.test(seg), seg.slice(0, 200));
  ok("_fireAt は本物のクリックの後に tap（SELECT 以外）", /if \(_tag !== "SELECT"\) \{ if \(P && P\.tap\) P\.tap\(\); \}/.test(ps));
  ok("SELECT は開く時の1回だけ（P0.tap）", /if \(P0 && P0\.tap\) P0\.tap\(\);/.test(ps));
}

console.log("\n■ ④ 版");
ok("manifest が 2.8.122 以降", mf.version.localeCompare("2.8.122", undefined, { numeric: true }) >= 0, mf.version);
ok("_AXLX_PAGE_VER が manifest と同じ", ps.indexOf('var _AXLX_PAGE_VER = "' + mf.version + '";') >= 0);

console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
process.exit(fail ? 1 : 0);
