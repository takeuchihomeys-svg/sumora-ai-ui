// v2.8.248: 送付済み・次無しで止まらない／AD旧経路廃止の衝突インベントリ
var fs = require("fs");
var path = require("path");
var root = path.join(__dirname, "..", "..");
var bd = fs.readFileSync(path.join(root, "chrome-extension/bulk-dl.js"), "utf8");
var ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8");
var mf = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
var rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");
var f64 = fs.readFileSync(path.join(root, "app/lib/root-cause-improve-loop.ts"), "utf8");
var n = 0;
var fail = 0;
function ok(name, cond, detail) {
  n++;
  if (cond) console.log("  ✓ " + name);
  else {
    fail++;
    console.log("  ✗ " + name + (detail ? " — " + detail : ""));
  }
}

console.log("\n■ 版");
ok("manifest ≥2.8.248", mf.version >= "2.8.248", mf.version);
ok("page ≥2.8.248", (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] >= "2.8.248");
ok("rules ≥2.8.248", (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] >= "2.8.248");

console.log("\n■ 送付済み→止まらず客完了");
ok("all_sent_no_press 印", /all_sent_no_press/.test(bd));
ok("押せる行0でも _autoFinish", /送付済みのみ・押せる行無し/.test(bd) && /_autoFinish\("送付済みのみ/.test(bd));
ok("次無しは _sendBatchDone 一本化", /all_sent_done/.test(bd) && /_sendBatchDone\(/.test(bd));
ok("決まり all_sent_advance_no_stuck", /id: "all_sent_advance_no_stuck"/.test(rules));
ok("RULES_DONE", /"all_sent_advance_no_stuck"/.test(ps));
ok("F64 all_sent_no_next_stuck", /all_sent_no_next_stuck/.test(f64));

console.log("\n■ AD／並べ替え 旧ボトルネック廃止");
ok("sort_legacy 原子を刻まない", !/_stampSortFlowAtom\("sort_legacy"/.test(bd));
ok("claude_path でAD開始しない", !/finishGate\(true,\s*"legacy_claude_path"\)/.test(bd));
ok("location.href でADしない", !/location\.href\s*=\s*.*ad=odr_desc/.test(bd) && !/location\.href\s*=\s*_adLink/.test(bd));
ok("press(sortHead) しない", !/press\(sortHead/.test(bd));
ok("sort_screen_ok 正本", /_stampSortFlowAtom\("sort_screen_ok"/.test(bd));
ok("hover→AD→高→低 残存", /hover\(sortHead/.test(bd) && /hover\(adItem/.test(bd) && /press\(hiToLo/.test(bd));
ok("sort_forbid_click 残存", /sort_forbid_click/.test(bd));

console.log("\n" + n + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
