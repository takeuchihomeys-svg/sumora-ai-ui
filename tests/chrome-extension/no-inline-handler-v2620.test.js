// 実行: node tests/chrome-extension/no-inline-handler-v2620.test.js
// 2026-11-10 竹内さん「まだエラーある」（chrome://extensions の CSP エラー）
//   Manifest V3 の CSP は **インラインのイベント属性（onclick など）を実行しない**（実行しようとするとエラーが出て、押しても動かない）。
//   ① HTML に on* 属性が1つも無い
//   ② JS が作る HTML にも on* 属性が無い（innerHTML の中）
//   ③ 検索モードの2つのボタンは JS で繋いでいる（押すと動く）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const htmls = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
console.log(`■ ① HTML ${htmls.length} 本に on* 属性が無い`);
for (const f of htmls) {
  const src = read(f);
  // コメントを除いてから見る
  const body = src.replace(/<!--[\s\S]*?-->/g, "");
  const hits = [...body.matchAll(/\son(click|change|input|submit|load|error|focus|blur|keydown|keyup)\s*=\s*"/gi)].map((m) => m[0]);
  ok(`${f}: インラインのイベント属性なし`, hits.length === 0, hits.slice(0, 4));
}

console.log("\n■ ② JS が作る HTML にも on* 属性が無い");
for (const f of ["popup.js", "page-script.js", "itandi-page-script.js", "bulk-dl.js", "itandi-bulk-dl.js", "realpro-guide.js", "itandi-guide.js", "underbar.js"]) {
  if (!fs.existsSync(path.join(dir, f))) continue;
  const src = read(f);
  // 文字列の中の onclick=" や onclick=' を探す（コメント行は除く）
  const lines = src.split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l));
  const hits = lines.filter((l) => /on(click|change|input)\s*=\s*["']/.test(l) && /innerHTML|<|>/.test(l));
  ok(`${f}: 生成する HTML に on* 属性なし`, hits.length === 0, hits.slice(0, 3));
}

console.log("\n■ ③ 検索モードのボタンは JS で繋ぐ");
const pp = read("popup.js");
ok("_initSearchModeButtons がある", /function _initSearchModeButtons\(\)/.test(pp));
ok("modeTransfer を押すと transfer になる", /getElementById\('modeTransfer'\)[\s\S]{0,120}setSearchMode\('transfer'\)/.test(pp));
ok("modeTime を押すと time になる", /getElementById\('modeTime'\)[\s\S]{0,160}setSearchMode\('time'\)/.test(pp));
ok("DOM の後に実行する", /readyState === 'loading'[\s\S]{0,200}_initSearchModeButtons/.test(pp));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
