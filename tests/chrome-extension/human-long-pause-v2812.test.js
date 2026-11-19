// v2.8.112 竹内さん（2026-11-19）「人の速さで迷いも人のように入れる」
// 汎用の欄（チェック・リンク等）に、人の実測（4秒以上が約26%・p90 約7秒）に寄せた長い迷いを足す。
const fs = require("fs");
const path = require("path");
const ps = fs.readFileSync(path.join(__dirname, "../../chrome-extension/page-script.js"), "utf8");

let fail = 0;
function ok(name, cond, detail) {
  if (cond) console.log("ok  ", name);
  else { fail++; console.log("FAIL", name, detail !== undefined ? detail : ""); }
}

const start = ps.indexOf("function _hesitateMs(el)");
ok("_hesitateMs がある", start > 0);
const body = ps.slice(start, start + 1400);
ok("決めるのは押す欄の種類（_hesitateKindOf）", /var kind = _hesitateKindOf\(el\);/.test(body));
ok("decide（ボタン）には長い迷いを入れない", /if \(kind !== "decide"\)/.test(body));
ok("長い迷いは 12%（Math.random() < 0.12）", /Math\.random\(\) < 0\.12/.test(body));
ok("長い迷いの範囲は 4000〜9000ms に収める", /Math\.min\(9000, Math\.max\(4000,/.test(body));
ok("対数正規の中心 5200", /logNormalDelay\(5200, 0\.3\)/.test(body));

// 区・選択レーンは _hesitateMs を通さない（別の混合で管理）
const ward = ps.indexOf("var hesitate = (_isWardItem || _isSelItem) ? 0 : _hesitateMs(item.el);");
ok("区・選択レーンの迷いは 0（_hesitateMs を呼ばない）", ward > 0);

// 版
ok("_AXLX_PAGE_VER が 2.8.115", /var _AXLX_PAGE_VER = "2\.8\.115";/.test(ps));

console.log(fail ? `\n${fail} 件失敗` : "\nすべて OK");
process.exit(fail ? 1 : 0);
