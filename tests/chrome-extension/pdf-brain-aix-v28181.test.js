// 2.8.181: ブレイン手押しPDFが AIX に残る（ガード通過・クリック武装・待ち行列）
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../..");
const bulk = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
const man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));

function ok(name, cond, detail) {
  if (!cond) {
    console.error("✗", name, detail || "");
    process.exitCode = 1;
  } else {
    console.log("✓", name);
  }
}
function verGe(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

console.log("■ 2.8.181 ブレインPDF→AIX");
ok("manifest ≥2.8.181", verGe(man.version, "2.8.181"), man.version);
ok("ブレインでも guard_pass", /_autoModeOn \|\| _brainModeOn/.test(bulk) && /guard_pass/.test(bulk));
ok("クリック武装で sendOnePdfNow", /_armClickSend/.test(bulk) && /pdf_click_arm/.test(bulk));
ok("busy 時は自動も待ち行列", /_pdfQueue\.length >= 12/.test(bulk) && !/pdf_busy_drop/.test(bulk));
ok("印刷用PDFクリック監視", /印刷用PDF/.test(bulk) && /addEventListener\("click"/.test(bulk));
