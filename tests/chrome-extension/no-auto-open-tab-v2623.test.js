// 実行: node tests/chrome-extension/no-auto-open-tab-v2623.test.js
// 2026-11-10 竹内さん「リアプロやITANDIを勝手に開くのではなくて、開いている状態のところを確認してそこから行うようにする」
//   ① タブが開いていなければ、勝手に開かない（そのサイトは飛ばす・理由を点検に残す）
//   ② 開いているタブを優先して使う（既存の選び方は今まで通り）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const bg = read("background.js");
const G = require(path.join(dir, "batch-guard.js"));

console.log("■ ① タブが無ければ勝手に開かない");
ok("AXLX_NO_TAB で飛ばす", /AXLX_NO_TAB/.test(bg));
ok("理由を点検に残す（no_tab）", /_auditStep\([^)]*"no_tab"/.test(bg));
ok("「勝手に開かない」とログに出す", /タブが開いていない → 勝手に開かない/.test(bg));

console.log("\n■ ② 開いているタブを優先");
ok("pickRealproTab は main.php を先に選ぶ", (() => {
  const tabs = [
    { id: 1, url: "https://www.realnetpro.com/login.php" },
    { id: 2, url: "https://www.realnetpro.com/main.php?x=1" },
  ];
  return G.pickRealproTab(tabs)?.id === 2;
})());
ok("リアプロのタブが無ければ null（勝手に作らない）", G.pickRealproTab([]) === null);
ok("ITANDI は一覧（/rent_rooms/list）を先に選ぶ", (() => {
  const tabs = [
    { id: 1, url: "https://itandibb.com/other" },
    { id: 2, url: "https://itandibb.com/rent_rooms/list" },
  ];
  return G.pickItandiTab(tabs)?.id === 2;
})());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
