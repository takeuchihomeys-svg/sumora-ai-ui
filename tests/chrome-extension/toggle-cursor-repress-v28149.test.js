// 2.8.149（2026-11-20 竹内さん「外すも入れるも1つずつカーソルで動いてクリックする・細部まで」）
//   チェックボックスの押し直しを直の input.click／simulateClick にしない（カーソルを動かしてから押す）
//   直で押したのは印（toggle_direct）に残す。外しも入れるも同じ関数（_toggleCheckboxLikeHuman）を通る
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("✓", name); }
  else { fail++; console.log("✗", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}

const ps = read("page-script.js");
const start = ps.indexOf("function _toggleCheckboxLikeHuman(cb, wantOn, minGap, maxGap, flags)");
const end = ps.indexOf("\n  function ", start + 10);
const body = ps.slice(start, end);

ok("関数が見つかる", start > 0 && end > start, { start, end });
ok("押し直しは _humanPointerClick（カーソル→押し）", /_humanPointerClick\(hit, function \(\) \{ try \{ cb\.click\(\); \} catch/.test(body));
ok("simulateClick 直押しは _humanPointerClick で包む", /_humanPointerClick\(_tgt, function \(\) \{ try \{ simulateClick\(_tgt\)/.test(body));
ok("直の cb.click() が裸で残らない（関数の中の cb.click は _humanPointerClick の中だけ）", (() => {
  const lines = body.split("\n");
  return lines.every((l) => !/^\s*try \{ cb\.click\(\); \}/.test(l));
})());
ok("裸の simulateClick(…) が残らない", !/^\s*try \{ simulateClick\(hit/.test(body) && !/^\s*try \{ simulateClick\(hit && hit\.isConnected/.test(body));
ok("直押しは印 toggle_direct に残す", /_auditStepP\("toggle_direct"/.test(body));
ok("押し直しは印 toggle_repress に残す", /_auditStepP\("toggle_repress"/.test(body));
ok("clear_method は direct_fallback と分ける（カーソル扱いの誤記録を防ぐ）", /_noteClearMethod\(_domain, "direct_fallback"/.test(body));

const ss = read("search-audit.js");
ok("KEEP_STEP に toggle_direct・toggle_repress（DBに残る）", /KEEP_STEP = \/\^\(([^)]*\|)?toggle_repress\|toggle_direct\|/.test(ss));

const man = JSON.parse(read("manifest.json"));
const verGe = (v) => { const [x, y, z] = String(v).split(".").map(Number); return x > 2 || (x === 2 && (y > 8 || (y === 8 && z >= 149))); };
ok("manifest 2.8.149 以上", verGe(man.version), man.version);
ok("_AXLX_PAGE_VER 2.8.149 以上", verGe((ps.match(/_AXLX_PAGE_VER = "([\d.]+)"/) || [])[1]));

const rules = fs.readFileSync(path.join(EXT, "../app/lib/auto-procedure-rules.ts"), "utf8");
ok("AUTO_RULES_REVIEWED_UP_TO も 2.8.149", /AUTO_RULES_REVIEWED_UP_TO = "2\.8\.149"/.test(rules));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
