// tests/chrome-extension/want-chips.test.js
// v2.5.39: 要望の項目（want_items）を popup の条件の表示に札で出す（検索には入れない・サーバーが作る）
// 実行: node tests/chrome-extension/want-chips.test.js
const fs = require("fs");
const path = require("path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", f), "utf8").replace(/\r\n/g, "\n");
let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}`); } };

const popup = read("popup.js");
ok("buildCondData が want_items を wantItems に写す（配列の時だけ）", /wantItems:\s*Array\.isArray\(c\.want_items\) \? c\.want_items : null/.test(popup));
ok("条件の表示の後ろに札を足す", /\.join\(""\)\}<\/div>\$\{_wantChipsHtml\(d\.wantItems\)\}`/.test(popup));
ok("札は設備＝k-equip・NG＝k-ng・その他＝k-other", /w\.kind === "設備" \? "k-equip" : w\.kind === "NG" \? "k-ng" : "k-other"/.test(popup));
ok("文字は esc を通す（XSS）", /esc\(w\.label \|\| ""\)/.test(popup) && /esc\(w\.kind\)/.test(popup));
ok("空・配列でない時は何も出さない", /if \(!Array\.isArray\(items\) \|\| !items\.length\) return "";/.test(popup));
ok("検索の入力（conditions）には want_items を渡さない", !/want_items:\s*c\.want_items|want_items:\s*selectedCustomer/.test(popup));

// _wantChipsHtml を取り出して動かす（esc は popup と同じ物）
const fn = popup.match(/function _wantChipsHtml\(items\) \{[\s\S]*?\n\}/)[0];
const escFn = popup.match(/function esc\(s\) \{[\s\S]*?\n\}/)[0];
const html = new Function(`${escFn}\n${fn}\nreturn _wantChipsHtml;`)()([
  { kind: "設備", label: "対面キッチン", scoring: "EQUIP_COUNTER_KITCHEN", source: "カウンターキッチン" },
  { kind: "その他", label: "初期費用15万円以内", scoring: null, source: "初期費用15万円以内" },
  { kind: "NG", label: "1階 → 2階以上", scoring: "EQUIP_FLOOR2", source: "1階", search: false },
  { kind: "その他", label: "<b>x</b>", scoring: null, note: true, source: "<b>x</b>" },
]);
ok("設備の札が緑（k-equip）", /class="want-chip k-equip"/.test(html) && html.includes("対面キッチン"));
ok("採点外の印は採点の札が無い時だけ", (html.match(/<i>採点外<\/i>/g) || []).length === 1);
ok("NG の札が赤（k-ng）", /class="want-chip k-ng"/.test(html));
ok("メモ（note）は薄く・採点外の印は出さない", /want-chip k-other note/.test(html));
ok("タグはエスケープされる", html.includes("&lt;b&gt;x&lt;/b&gt;") && !html.includes("<b>x</b>"));

const css = read("styles.css");
ok("styles.css に .want-chip の色", /\.want-chip\.k-equip/.test(css) && /\.want-chip\.k-ng/.test(css));
const mf = JSON.parse(read("manifest.json"));
ok("manifest の版 2.5.39 以上（v2.5.40 で画面の写真を足した）", mf.version.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0) >= 2005039);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
