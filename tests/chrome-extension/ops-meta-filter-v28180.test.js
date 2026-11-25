// 2.8.180: 流れ台帳・未完了メモを学習の輪に載せない／UIの輪0文言
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../..");
const rec = fs.readFileSync(path.join(root, "chrome-extension/human-learn-record.js"), "utf8");
const snap = fs.readFileSync(path.join(root, "chrome-extension/snapshot-popup.js"), "utf8");
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

console.log("■ 2.8.180 メタ操作フィルタ＋輪0文言");
ok("manifest ≥2.8.180", verGe(man.version, "2.8.180"), man.version);
ok(
  "_recNoteName が未完了/今の客/流れ台帳を弾く",
  /未完了:.*完了済:.*今の客:.*流れ台帳.*流れ地図/.test(rec.replace(/\s+/g, "")) ||
    /\/\^\(未完了:\|完了済:\|今の客:\|流れ台帳\|流れ地図\|弱:\)\//.test(rec),
  "filter regex missing"
);
ok(
  "snapshot が読み直しリセットを説明する",
  snap.includes("検索後の読み直しでリセット") && snap.includes("DBに保存"),
  "UX message missing"
);
