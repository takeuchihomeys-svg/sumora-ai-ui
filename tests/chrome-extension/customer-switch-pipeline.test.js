/**
 * 2026-11-16 勇気さん実測: 一連中に次客を選ぶと owner_mismatch
 * 実行: node tests/chrome-extension/customer-switch-pipeline.test.js
 */
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
function ok(name, cond) {
  cond ? pass++ : fail++;
  console.log((cond ? "  ✓ " : "  ✗ ") + name);
}

const popup = read("popup.js");
const page = read("page-script.js");
const bulk = read("bulk-dl.js");
const man = JSON.parse(read("manifest.json"));

console.log("■ 一連中の送る相手固定（勇気・り）");
ok("openSiteView がパイプライン中は storage 上書きしない", /_pipeBusy/.test(popup) && /customer\.customer_name && !_pipeBusy/.test(popup));
ok("autofill-initiated に customerId", /from:\s*"axlx-autofill-initiated"[\s\S]{0,120}customerId:\s*_fillCustomerId/.test(page));
ok("bulk-dl が initiated の customerId を最優先", /_initCid/.test(bulk) && /fill の客を最優先|customerId を最優先|String\(_initCid\)/.test(bulk));
ok("別客で pending を上書きしない", /別客に上書きしない/.test(bulk));
ok("版 2.8.32+", (() => {
  const a = String(man.version).split(".").map(Number);
  return a[0] > 2 || (a[0] === 2 && a[1] > 8) || (a[0] === 2 && a[1] === 8 && a[2] >= 32);
})());

console.log("\n結果: 合格 " + pass + " / 不合格 " + fail);
if (fail) process.exit(1);
