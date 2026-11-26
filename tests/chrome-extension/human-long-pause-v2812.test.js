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
// 2.8.313: 条件に pick・decide 等が後から増えたので「区・選択が先頭に並ぶ」形で見る（0 にする守りは同じ）
const ward = ps.search(/var hesitate = \(_isWardItem \|\| _isSelItem\b[^;]*\) \? 0 : _hesitateMs\(item\.el\);/);
ok("区・選択レーンの迷いは 0（_hesitateMs を呼ばない）", ward > 0);

// 版
// 2.8.313: 版は manifest と同じで 2.8.119 以上（2.8.119 だけを通す書き方をやめた）
const mf = JSON.parse(fs.readFileSync(path.join(__dirname, "../../chrome-extension/manifest.json"), "utf8"));
const verGte = (a, b) => { a = String(a).split(".").map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) > b[i]) return true; if ((a[i] || 0) < b[i]) return false; } return true; };
ok("_AXLX_PAGE_VER が manifest と同じで 2.8.119 以上", new RegExp('var _AXLX_PAGE_VER = "' + mf.version.replace(/\./g, "\\.") + '";').test(ps) && verGte(mf.version, [2, 8, 119]));

console.log(fail ? `\n${fail} 件失敗` : "\nすべて OK");
process.exit(fail ? 1 : 0);
