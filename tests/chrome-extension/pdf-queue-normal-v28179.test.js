// 2.8.179: 通常モードで busy 中の印刷用PDFを捨てず待ち行列へ（AIX未反映防止）
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..", "chrome-extension");
function read(n) { return fs.readFileSync(path.join(root, n), "utf8"); }
function verGe(a, b) {
  var x = String(a || "").split(".").map(Number), y = String(b || "").split(".").map(Number);
  for (var i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return true;
}
var passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { console.log("  ✓ " + name); passed++; }
  else { console.log("  ✗ " + name + (extra ? " — " + extra : "")); failed++; }
}
var man = JSON.parse(read("manifest.json"));
var bd = read("bulk-dl.js");
console.log("■ 2.8.179 通常PDF待ち行列＋失敗理由表示");
ok("manifest ≥2.8.179", verGe(man.version, "2.8.179"), man.version);
ok("_pdfQueue がある", /var _pdfQueue = \[\]/.test(bd));
ok("busy 時に pdf_queued", /pdf_queued/.test(bd));
ok("idle 後に queue を消化", /_pdfQueue\.shift/.test(bd));
ok("brain-skip を画面に出す", /ブレインが外す判定/.test(bd));
ok("pdf_send_fail 印", /pdf_send_fail/.test(bd));
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
