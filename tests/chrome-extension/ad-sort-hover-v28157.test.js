// 2.8.157（2026-11-22 竹内さん録画）
// 並べ替えにマウスを置くだけで下展開 → ADに置くと右に低→高／高→低 → 高→低だけクリック
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + String(extra).slice(0, 300) : "")); }
}
function verGe(v, want) {
  const a = String(v || "").split(".").map(Number);
  const b = String(want || "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

const bd = read("bulk-dl.js");
const man = JSON.parse(read("manifest.json"));

console.log("■ 2.8.158 AD並び替え＝ホバー展開→高→低クリック（手順書 ad_sort_hover）");
ok("manifest ≥2.8.158", verGe(man.version, "2.8.158"), man.version);
ok("_AXLX_PAGE_VER ≥2.8.158", verGe((read("page-script.js").match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1], "2.8.158"));
ok("拡張の _AXLX_RULES_DONE に ad_sort_hover", /"ad_sort_hover"/.test(read("page-script.js")));
ok("点検に _tmark でも残す（dl:sort_*）", /_tmark\(k, detail/.test(bd) || /_auditSort[\s\S]{0,200}?_tmark\(k/.test(bd));

ok("① 並べ替えはホバー（クリックしないログ）", /① 並べ替えへカーソルを動かします/.test(bd));
ok("① press(sortHead) しない", !/press\(sortHead/.test(bd));
ok("① hover(sortHead)", /hover\(sortHead/.test(bd));
ok("② AD もホバー（クリックしない）", /② 並べ替えから AD へカーソルを動かします/.test(bd));
ok("③ 高→低だけ press", /③ 高→低へカーソルを動かして押します/.test(bd) && /press\(hiToLo/.test(bd));
ok("高→低を href でも探す（ad=odr_desc）", /ad=odr_desc/.test(bd) && /findHiToLoNear/.test(bd));
ok("既に AD 高い順か ad=odr_desc も見る", /_params\.get\("ad"\) === "odr_desc"/.test(bd));
ok("閉メニューにリンクが無くても並べ替えを試す", /メニュー操作を\*\*必ず試す\*\*/.test(bd) || /リンクの有無で止めない/.test(bd));
ok("ページを読み込み直さない", !/location\.href = _adLink\.href;/.test(bd) && !/location\.href = _u\.toString\(\)/.test(bd));
ok("点検印 sort_head_hover / sort_ad_hover", /sort_head_hover/.test(bd) && /sort_ad_hover/.test(bd));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
