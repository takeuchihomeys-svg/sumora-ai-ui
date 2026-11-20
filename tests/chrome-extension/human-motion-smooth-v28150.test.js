// 2.8.150（2026-11-20 竹内さん「機械的になっている部分・人間の動きができていない部分は細かく改善」）
//   ① 画面を一瞬で飛ばさない（検索ボタン・小窓の一覧・プルダウンの見せ方 = いつも smooth）
//   ② 見えない欄は最大1.2秒見えるまで待ってからカーソルで押す（本番 2.8.145 で堺市の区7つが hidden_press）
//   ③ 押し直し・直押し・待って見えた印は page: の段として DB に残す（KEEP_STEP の page:( の中）
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("✓", name); }
  else { fail++; console.log("✗", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}
const ps = read("page-script.js");
const fnBody = (sig) => { const a = ps.indexOf(sig); const b = ps.indexOf("\n  function ", a + 10); return a > 0 ? ps.slice(a, b) : ""; };

console.log("■ ① 一瞬で飛ばさない");
ok("page-script に behavior: \"instant\" が無い", !/behavior:\s*"instant"/.test(ps));
const sp = fnBody("function _scrollIntoScrollParent(el)");
ok("小窓の一覧の送りは smooth だけ（15%の auto が無い）", /cont\.scrollBy\(\{ top: Math\.round\(dy\), behavior: "smooth" \}\)/.test(sp) && !/"auto"/.test(sp));
ok("プルダウンを見せる送りは2回目以降も smooth", /el\.scrollIntoView\(\{ behavior: "smooth", block: "center", inline: "nearest" \}\);/.test(ps) && !/tries === 1 \? "smooth" : "auto"/.test(ps));
ok("検索ボタンは6回待っても外なら smooth で送って印を残す", /search_scroll_smooth/.test(ps));

console.log("■ ② 見えない欄は待ってからカーソルで");
const hp = fnBody("function _humanPointerClick(el, fallbackFn, aim, tgtAt)");
ok("見えるまで最大1.2秒待つ", /if \(!el\.__axHidWaited\)/.test(hp) && /Date\.now\(\) - _hw0 >= 1200/.test(hp));
ok("待ってから自分を呼び直す（カーソルの経路へ）", /res\(_humanPointerClick\(el, fallbackFn, aim, tgtAt\)\)/.test(hp));
ok("見えたら印 hidden_wait_ok", /_auditStepP\("hidden_wait_ok"/.test(hp));
ok("待っても見えない時だけ hidden_press（印は残す）", hp.indexOf("__axHidWaited = 0;") > 0 && hp.indexOf("__axHidWaited = 0;") < hp.indexOf('_auditStepP("hidden_press"'));
ok("label が見える時は label にカーソル（待つより先）", hp.indexOf("if (_proxy) {") < hp.indexOf("if (!el.__axHidWaited)"));

console.log("■ ③ 印が DB に残る");
const ss = read("search-audit.js");
ok("KEEP_STEP の page:( に toggle_repress・toggle_direct・hidden_wait_", /page:\(toggle_repress\|toggle_direct\|hidden_wait_\|/.test(ss));

console.log("■ 版");
const man = JSON.parse(read("manifest.json"));
const verGe = (v) => { const [x, y, z] = String(v).split(".").map(Number); return x > 2 || (x === 2 && (y > 8 || (y === 8 && z >= 150))); };
ok("manifest 2.8.150 以上", verGe(man.version), man.version);
ok("_AXLX_PAGE_VER 2.8.150 以上", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
