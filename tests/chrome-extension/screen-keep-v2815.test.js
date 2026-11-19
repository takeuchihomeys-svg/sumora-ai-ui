// 実行: node tests/chrome-extension/screen-keep-v2815.test.js
// v2.8.115 竹内さん「束不安定なのはどう改善したら最善なのか」→ 拡張の保険:
//   本番の作り直しの束が位置0（#2413〜#2420）でも、手元の良い位置を空で上書きしない。控えはサイト別。
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, c, detail) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail !== undefined ? "  " + JSON.stringify(detail) : "")); }
}

const a = bg.indexOf("var _screenKept = null;");
const b = bg.indexOf("var _screenAllKeys = Object.keys(_screenAim).length;", a);
const block = a > 0 && b > a ? bg.slice(a, b) : "";

function makeRun() {
  const store = {};
  const chrome = { storage: { local: {
    get: async (keys) => { const o = {}; for (const k of keys) if (k in store) o[k] = JSON.parse(JSON.stringify(store[k])); return o; },
    set: async (o) => { for (const k in o) store[k] = JSON.parse(JSON.stringify(o[k])); },
  } } };
  const fn = new Function("chrome", "console", `return async function (curSite, _screenAim, _sceneAim, bundle) {
    ${block}
    return { screen: _screenAim, scene: _sceneAim, kept: _screenKept };
  };`)(chrome, { log() {} });
  return { run: fn, store };
}

(async function () {
  console.log("\n■ 位置0の束で良い位置を消さない（サイト別の控え）");
  ok("控えの処理がある", block.length > 200);
  const h = makeRun();
  const good = { "賃料": { x: 0.4, y: 0.3, n: 5 } };
  const scene = { station: { "駅": { x: 0.1, y: 0.1, n: 3 } } };
  let r = await h.run("realpro", good, scene, { generated_at: "2026-11-18T16:32:57Z" });
  ok("良い束は控えに残す", h.store.axlx_learn_screen_keep && h.store.axlx_learn_screen_keep.realpro && h.store.axlx_learn_screen_keep.realpro.screen["賃料"].n === 5 && r.kept === null);
  r = await h.run("realpro", {}, {}, { generated_at: "2026-11-18T17:08:28Z" });
  ok("位置0の束 → 同じサイトの控えを使う", r.screen["賃料"] && r.screen["賃料"].n === 5, r);
  ok("場面の位置も控えから", r.scene.station && r.scene.station["駅"].n === 3);
  ok("控えの版を記録（screen_kept）", r.kept === "2026-11-18T16:32:57", r.kept);
  r = await h.run("itandi", {}, {}, { generated_at: "x" });
  ok("別サイト（itandi）にはリアプロの控えを使わない", Object.keys(r.screen).length === 0 && r.kept === null);
  await h.run("itandi", { "区": { x: 0.2, y: 0.2, n: 2 } }, {}, { generated_at: "i1" });
  r = await h.run("realpro", {}, {}, { generated_at: "y" });
  ok("itandi を取り込んだ後もリアプロの控えは残る", r.screen["賃料"] && !r.screen["区"]);
  const fresh = { "賃料": { x: 0.5, y: 0.5, n: 7 } };
  r = await h.run("realpro", fresh, {}, { generated_at: "z" });
  ok("新しい良い束が来たらそちらを使い控えも更新", r.screen["賃料"].n === 7 && h.store.axlx_learn_screen_keep.realpro.screen["賃料"].n === 7 && r.kept === null);

  console.log("\n■ 配線");
  ok("link に screen_kept を載せる", /screen_kept: _screenKept,/.test(bg));
  ok("ページが learn_screen_kept を記録", /_auditStepP\("learn_screen_kept"/.test(ps) && /concat\(_LEARN_NEXT_KEYS, \["axlx_learn_link"\]\)/.test(ps));
  ok("新しい段は間引かない（_PIN）", /\|learn_screen_kept\|/.test(ps));

  console.log("\n■ 版");
  ok("manifest が 2.8.118", mf.version === "2.8.118", mf.version);
  ok("_AXLX_PAGE_VER が 2.8.118", /var _AXLX_PAGE_VER = "2\.8\.118";/.test(ps));

  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail) process.exit(1);
})();
