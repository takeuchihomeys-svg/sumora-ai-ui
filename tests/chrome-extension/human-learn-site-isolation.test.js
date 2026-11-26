// 実行: node tests/chrome-extension/human-learn-site-isolation.test.js
// 2026-11-27 サイト間汚染・DOM破損名防止テスト
// 1. human-learn.js: form 内に name="id" の入力がある <form> で #[object HTMLInputElement] を作らない
// 2. human-learn-record.js / human-learn-upload.js / pointer-ui.js: サイト別キー(__realpro / __itandi)に分離し他サイトと混ぜない
// 3. content.js / itandi-content.js / popup.js: サイト別キーを橋渡し・合算表示する

const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
const L = require(path.join(EXT, "human-learn.js"));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + String(extra).slice(0, 300) : "")); }
}

console.log("■ ① human-learn.js: form.id が HTMLInputElement に化けても #[object ...] を作らない");
{
  // <form id="real_form"><input name="id"></form> の DOM 擬似オブジェクト（form.id が HTMLInputElement を返す）
  const fakeInput = { toString: () => "[object HTMLInputElement]" };
  const fakeFormWithNameId = {
    tagName: "FORM",
    id: fakeInput,
    className: { baseVal: "cls" },
    name: "",
    type: "",
    getAttribute: (k) => (k === "id" ? "real_form" : null),
  };
  const label1 = L.fieldName(fakeFormWithNameId);
  ok("getAttribute('id') が優先され #real_form が返る", label1 === "#real_form", label1);

  const fakeFormNoAttr = {
    tagName: "FORM",
    id: fakeInput,
    className: "search-box",
    name: "",
    type: "",
    getAttribute: () => null,
  };
  const label2 = L.fieldName(fakeFormNoAttr);
  ok("getAttribute が無く id が非文字列なら [object ...] を出さない", !String(label2).includes("[object ") && label2 === "form.search-box", label2);
}

console.log("\n■ ② 録画・アップロード・ポインタがサイト別ストレージキー(__realpro / __itandi)を使う");
{
  const rec = read("human-learn-record.js");
  const up = read("human-learn-upload.js");
  const pu = read("pointer-ui.js");

  ok("human-learn-record: SITE_KEY / SITE_PROFILE_KEY / SITE_POINTS_KEY / SITE_AUTO_KEY が定義されている",
    /SITE_KEY = KEY \+ _siteSuffix/.test(rec)
    && /SITE_PROFILE_KEY = PROFILE_KEY \+ _siteSuffix/.test(rec)
    && /SITE_POINTS_KEY = POINTS_KEY2 \+ _siteSuffix/.test(rec)
    && /SITE_AUTO_KEY = AUTO_KEY \+ _siteSuffix/.test(rec));
  ok("human-learn-record: _pushPoint で [object ...] を除外する", /indexOf\("\[object "\) >= 0/.test(rec));
  ok("human-learn-upload: SITE_KEY と SITE_SENT_KEY を使い他サイト混載の古いaggを送らない",
    /SITE_KEY = _siteKey\(KEY, SITE\)/.test(up)
    && /agg\.site && agg\.site !== SITE/.test(up));
  ok("pointer-ui: ページホストに応じて _ptrSiteSuffix を付けてサイト別キーを読む",
    /var _ptrSiteSuffix = _ptrSite \? \("__" \+ _ptrSite\) : ""/.test(pu)
    && /PROF_KEY = "axlx_human_learn" \+ _ptrSiteSuffix/.test(pu)
    && /PROF_LIVE_KEY = "axlx_human_profile" \+ _ptrSiteSuffix/.test(pu)
    && /POINTS_KEY = "axlx_human_points" \+ _ptrSiteSuffix/.test(pu));
}

console.log("\n■ ③ content.js / itandi-content.js / popup.js のサイト別キー連携");
{
  const c = read("content.js");
  const ic = read("itandi-content.js");
  const pop = read("popup.js");

  ok("content.js: リアプロ専用キーを PUSH_KEYS に持つ",
    c.includes('"axlx_human_profile__realpro"') && c.includes('"axlx_human_learn__realpro"') && c.includes('"axlx_human_points__realpro"'));
  ok("itandi-content.js: ITANDI専用キーを MAIN 側へ橋渡しする",
    ic.includes('"axlx_human_profile__itandi"') && ic.includes('"axlx_human_learn__itandi"') && ic.includes('"axlx_human_points__itandi"'));
  ok("popup.js: 学習バッジが __realpro と __itandi を合算表示する",
    pop.includes('"axlx_human_learn__realpro"') && pop.includes('"axlx_human_learn__itandi"'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
