/**
 * 2.8.304 竹内さん「なんで今まで拡張ツールの手順書やほかの部分反映されていなかったのか／ちゃんと反映されるようにしくみ化」
 *   実測 2026-11-26: 手元 2.8.303 に対し、最後に自動を回した拡張は 2.8.295（再読み込みの忘れが誰にも見えなかった）。
 *
 *   ① 判定: 本物の _cmpExtVer を取り出して、拡張が本番の最新版より古い時だけ ext_behind になる（本番が版を返さない時は出さない）
 *   ② 記録: axlx_server_state に ext_behind を書く・客ごとの記録に ext_behind を1段残す・点検が捨てない（KEEP_STEP / RULE_STEP）
 *   ③ 表示: ポップアップの案内（#ext-stale-warn）・再読み込みの直後は前の版の状態を出さない
 *   ④ 安全: 自動では再読み込みしない（chrome.runtime.reload を呼ばない）
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "../../chrome-extension");
const rd = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
const bg = rd("background.js");
const sa = rd("search-audit.js");
const pj = rd("popup.js");
const ph = rd("popup.html");
const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); }
}

console.log("■ ① 判定（本物の _cmpExtVer を動かす）");
const m = /function _cmpExtVer\(a, b\) \{[\s\S]*?\n\}/.exec(bg);
ok("background.js から _cmpExtVer を取り出せる", !!m);
const cmp = m ? vm.runInNewContext("(" + m[0].replace(/^function _cmpExtVer/, "function") + ")") : null;
const behind = (ext, srv) => !!srv && cmp(ext, srv) < 0;
if (cmp) {
  ok("拡張 2.8.295 ＜ 本番 2.8.304 → 古い", behind("2.8.295", "2.8.304") === true);
  ok("拡張 2.8.304 ＝ 本番 2.8.304 → 古くない", behind("2.8.304", "2.8.304") === false);
  ok("拡張 2.8.305 ＞ 本番 2.8.304（本番のデプロイ待ち）→ 古くない", behind("2.8.305", "2.8.304") === false);
  ok("本番が版を返さない（空）→ 判定しない（拡張を古いと決めつけない）", behind("2.8.295", "") === false);
  ok("2.8.99 と 2.8.100 は数として比べる（文字の並びで比べない）", behind("2.8.99", "2.8.100") === true);
}

console.log("\n■ ② 記録");
ok("コードに _extBehind の判定がある（決まり ext_behind_notice の目印）", /var _extBehind = !!_srvUp && _cmpExtVer\(_extV, _srvUp\) < 0/.test(bg));
ok("axlx_server_state に ext_behind を書く", /ext: _extV, ext_behind: !!_extBehind,/.test(bg));
ok("客ごとの記録に ext_behind を1段残す", /_auditStep\(_bulkAudit\.runId, "ext_behind"/.test(bg));
ok("点検が ext_behind を捨てない（KEEP_STEP）", /KEEP_STEP = \/\^\([^\n]*\|server_behind\|ext_behind\|/.test(sa));
ok("点検が ext_behind を捨てない（RULE_STEP）", /RULE_STEP = \/\^\([^\n]*\|server_behind\|ext_behind\|/.test(sa));
ok("手順書の決まりに ext_behind_notice がある", /id: "ext_behind_notice"/.test(rules));

console.log("\n■ ③ 表示");
ok("ポップアップに案内の枠がある", /id="ext-stale-warn"/.test(ph));
ok("案内は ext_behind の時だけ出す", /st && st\.ext_behind && String\(st\.ext \|\| ""\) === cur/.test(pj));
ok("再読み込みの直後（状態の版が今の版と違う）は出さない", /String\(st\.ext \|\| ""\) === cur/.test(pj));
ok("状態が変わったら表示を更新する", /chrome\.storage\.onChanged\.addListener\(function \(ch, area\) \{\s*if \(area === "local" && ch && ch\.axlx_server_state\)/.test(pj));

console.log("\n■ ④ 安全");
ok("案内の追加で chrome.runtime.reload を呼んでいない（自動の再読み込みはしない）", !/chrome\.runtime\.reload\s*\(/.test(pj) && !/_extBehind[\s\S]{0,400}chrome\.runtime\.reload/.test(bg));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
