// 2.8.148（2026-11-20 竹内さん「自動モードは画面が変わった時だけ撮る」）
//   自動（aix・ai）の写真は画面の印が前と同じなら撮らない・同じ画面が15秒続いたら1枚・撮らなかった枚数を次の写真に残す
//   通常・スタッフは今まで通り
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("✓", name); }
  else { fail++; console.log("✗", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}

const src = read("human-learn-record.js");
const a = src.indexOf("var AUTO_SHOT_SAME_MS = 15000;");
const b = src.indexOf("function _screenSig(openedKind)", a);
const sb = {};
vm.createContext(sb);
vm.runInContext(src.slice(a, b), sb);

console.log("■ 自動かどうか");
ok("aix は自動", sb._isAutoModeSt({ aixMode: true }) === true);
ok("ai も自動", sb._isAutoModeSt({ aiMode: true }) === true);
ok("通常は自動ではない", sb._isAutoModeSt({}) === false);
ok("スタッフが優先（自動ではない）", sb._isAutoModeSt({ staffMode: true, aixMode: true }) === false);

console.log("■ 画面が変わった時だけ");
ok("最初の1枚は撮る", sb.autoShotDecide(null, 0, "s1", 1000) === "shoot");
ok("画面が変わったら撮る", sb.autoShotDecide("s1", 1000, "s2", 1500) === "shoot");
ok("同じ画面なら撮らない", sb.autoShotDecide("s1", 1000, "s1", 5000) === "skip");
ok("同じ画面が15秒続いたら1枚（止まっている証拠）", sb.autoShotDecide("s1", 1000, "s1", 16000) === "shoot");

console.log("■ 組み込み");
const shoot = src.slice(src.indexOf("function shootAfter(kind, el, pt)"), src.indexOf("function noteAutoOp("));
ok("自動の時だけ画面の印で間引く", /if \(_shotAuto\) \{[\s\S]{0,200}_screenSig\(_openedKind\(\)\)[\s\S]{0,200}autoShotDecide\(/.test(shoot));
ok("間引きは失敗として数えない（diag を呼ばない）", /_autoShotSkipped\+\+;\s*return;/.test(shoot));
ok("撮らなかった枚数を次の写真の shot_ops 先頭に k:\"same\"", /\[\{ t: now, k: "same", f: null, w: null, same: _sameSkippedNow, by: "auto" \}\]\.concat\(/.test(shoot));
ok("モードは apply で受け取る", /function apply\(st\) \{\s*_shotAuto = _isAutoModeSt\(st\);/.test(src));
ok("画面の印は文字や入力値を読まない（textContent は頁番号の4文字だけ）", (src.slice(b, src.indexOf("return parts.join", b)).match(/textContent/g) || []).length === 1);

console.log("■ 版");
const man = JSON.parse(read("manifest.json"));
const ps = read("page-script.js");
const verGe = (v) => { const [x, y, z] = String(v).split(".").map(Number); return x > 2 || (x === 2 && (y > 8 || (y === 8 && z >= 148))); };
ok("manifest 2.8.148 以上", verGe(man.version), man.version);
ok("_AXLX_PAGE_VER 2.8.148 以上", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
