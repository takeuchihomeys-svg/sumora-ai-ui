// 2.8.154（2026-11-22 竹内さん「録画モード押していない時でもかなり重たい」）
//   主因: 通常でも操作のたび captureVisibleTab。録画中 or 自動だけ撮る／診断 storage は5秒に1回
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
const a = src.indexOf("function shouldShoot(st)");
const b = src.indexOf("/** 覚えている最中の印", a);
const sb = { _isAutoModeSt: function (s) { return !!(s && (s.aiMode || s.aixMode)); }, window: {} };
vm.createContext(sb);
vm.runInContext(src.slice(a, b), sb);
const f = sb.shouldShoot;

console.log("■ shouldShoot");
ok("通常・録画OFF → 撮らない", f({}) === false && f({ axlx_rec_mode: { on: false } }) === false);
ok("通常・録画ON → 撮る", f({ axlx_rec_mode: { on: true } }) === true);
ok("自動（aix）→ 撮る", f({ aixMode: true }) === true);
ok("自動（ai）→ 撮る", f({ aiMode: true }) === true);
ok("axlxShotOff → 撮らない", f({ axlx_rec_mode: { on: true }, axlxShotOff: true }) === false);
ok("KEYS に axlx_rec_mode", /"axlx_rec_mode"/.test(src) || /axlx_rec_mode/.test(src.slice(src.indexOf("var KEYS"))));
ok("apply が _shotAllow を決める", /_shotAllow = shouldShoot\(st\)/.test(src));
ok("shootAfter は _shotAllow が無いと即 return", /if \(!_shotAllow\) return;/.test(src));
ok("診断 storage は5秒に1回", /now - _diagWriteAt >= 5000|_diagWriteAt && now - _diagWriteAt < 5000/.test(src));
ok("旧の『どのモードでも撮る』return true が無い", !/function shouldShoot\(st\) \{\s*var s = st \|\| \{\};\s*try \{ if \(s\.axlxShotOff === true\) return false; \} catch \(_\) \{\}\s*return true;/.test(src));

console.log("■ 案内の空回り");
ok("realpro-guide: 案内OFFなら tick しない", /if \(!guideOn\) return;/.test(read("realpro-guide.js")));
ok("itandi-guide: 案内OFFなら tick しない", /if \(typeof guideOn !== "undefined" && !guideOn\) return;/.test(read("itandi-guide.js")));

console.log("■ 版");
const man = JSON.parse(read("manifest.json"));
const verGe = (v) => { const [x, y, z] = String(v).split(".").map(Number); return x > 2 || (x === 2 && (y > 8 || (y === 8 && z >= 154))); };
ok("manifest ≥2.8.154", verGe(man.version), man.version);
ok("_AXLX_PAGE_VER ≥2.8.154", verGe((read("page-script.js").match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1]));
ok("human-learn-record 構文", (() => { try { new vm.Script(src); return true; } catch (e) { console.log(e.message); return false; } })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
