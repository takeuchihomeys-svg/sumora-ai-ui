/**
 * 2.8.289 竹内さん「リセットを押して10秒以上後に確認→リセットできていると画面写真で把握。
 *   外すところはリセットで外せる。外した後、該当物件の数がふえていたらリセットされた証拠。
 *   そこから拡張ツールから新しいお客さんの条件を入れる。これでループできる」
 *   ① 押す前の該当物件数（○戸）を覚える ② 空の確認に加えて、数が増えた時だけ「外れた」と認める
 *   ③ 数が増えなければ従来の1つずつ外しへ戻る ④ 数が読めない時は空の確認だけ（記録に残す）
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..", "..");
const bg = fs.readFileSync(path.join(root, "chrome-extension/background.js"), "utf8").replace(/\r\n/g, "\n");
const ps = fs.readFileSync(path.join(root, "chrome-extension/page-script.js"), "utf8").replace(/\r\n/g, "\n");
const sa = fs.readFileSync(path.join(root, "chrome-extension/search-audit.js"), "utf8").replace(/\r\n/g, "\n");
const man = JSON.parse(fs.readFileSync(path.join(root, "chrome-extension/manifest.json"), "utf8"));
const rules = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function fnSrc(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n  }\n");
  return e < 0 ? s : s.slice(0, e + 5);
}
function semverOk(v, min) {
  const a = String(v).split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
}

console.log("\n■ 版");
ok("manifest = page = rules ≥2.8.289", semverOk(man.version, "2.8.289") && man.version === (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1]
  && (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] === man.version, man.version);

const countSrc = fnSrc(ps, "  function _resultCountNow() {");
const judgeSrc = fnSrc(ps, "  function _resetCountJudge(before, now) {");
const verifySrc = fnSrc(ps, "  function _resetVerify(opts, done) {");
const pressSrc = fnSrc(ps, "  function _resetPress(done) {");

console.log("\n■ ① 押す前の件数を覚える");
ok("_resultCountNow がある", countSrc.length > 0);
ok("押す前に件数を読んで pressed に残す（読み直しを越える sessionStorage）", /cntBefore = _resultCountNow\(\)/.test(pressSrc) && /cntBefore: cntBefore \? cntBefore\.n : null/.test(pressSrc));
ok("結果に countBefore を返す", /countBefore: cntBefore \? cntBefore\.n : null/.test(pressSrc));

console.log("\n■ ② 空に加えて件数が増えた時だけ外れたと認める");
ok("_resetVerify は空かつ verified の時だけ成功", /ready && st\.empty && jd\.verified/.test(verifySrc));
ok("成功の結果に verified:true と件数", /verified: true, left: 0[\s\S]{0,200}countBefore: jd\.before/.test(verifySrc));
ok("空でも件数が増えない時は印を付けない（CLEAN_KEY は verified の中だけ）",
  verifySrc.indexOf("_AX_RESET_CLEAN_KEY") > verifySrc.indexOf("jd.verified"));
ok("maxMs まで待ったら verified:false で返す（空かどうかは empty で別に返す）", /verified: false, left: st\.left/.test(verifySrc) && /empty: !!\(ready && st\.empty\)/.test(verifySrc));

console.log("\n■ ③ 増えなければ従来の外しへ（背景）");
const bgVerify = bg.slice(bg.indexOf("async function _postSendResetRealpro"), bg.indexOf("async function _postSendClearOrReset"));
ok("2.8.307 空の確認ループは空なら止める（件数が増えなくても外しへ回さない）", /_ver\.ok && _ver\.empty\) break;/.test(bgVerify) && !/_ver\.empty && _ver\.verified !== false\) break/.test(bgVerify));
ok("2.8.307 成功は空なら（件数が増えなくても）", /if \(_ver && _ver\.ok && _ver\.empty\) \{/.test(bgVerify) && !/_ver\.empty && _ver\.verified !== false\) \{/.test(bgVerify));
ok("2.8.307 空でも件数が増えない時は reset_count_same を記録だけして成功にする（ok:false で従来へ回さない）", /_ver\.verified === false\) _stamp\("reset_count_same"[\s\S]{0,1200}return \{ ok: true, left: 0, reset: true/.test(bgVerify) && !/countSame: true, why: "reset_count_same"/.test(bgVerify));
ok("reset_count_same は監査の段として残る（search-audit の RULE_STEP）", /reset_count_same/.test(sa));
ok("従来へ戻る経路は変わらず（_postSendClearOrReset の rr.ok 判定）", /if \(rr && rr\.ok\) return rr;/.test(bg));

console.log("\n■ ④ 件数の読み取りと判定（実関数を動かす）");
function runCount(text) {
  const ctx = vm.createContext({ document: { body: { innerText: text } } });
  vm.runInContext(countSrc + "\n__c = _resultCountNow;", ctx);
  return ctx.__c();
}
const c1 = runCount("大阪 150 棟 385 戸 並べ替え");
ok("半角の ○棟○戸 から ○戸 を読む", c1 && c1.n === 385, c1);
const c2 = runCount("大阪 １５０ 棟 １，０３８ 戸");
ok("全角数字・カンマを読む（1,038）", c2 && c2.n === 1038, c2);
ok("件数が無いページは null", runCount("検索結果がありません") === null);

const jud = vm.createContext({});
vm.runInContext(judgeSrc + "\n__j = _resetCountJudge;", jud);
const J = (b, n) => jud.__j(b, n);
ok("増えた（5→10）は verified・up", J(5, 10).verified === true && J(5, 10).up === true);
ok("同じ（10→10）は verified しない", J(10, 10).verified === false);
ok("減った（10→8）は verified しない", J(10, 8).verified === false);
ok("押す前が読めない（null→5）は空の確認だけ（known=false）", J(null, 5).verified === true && J(null, 5).known === false);
ok("外した後が読めない（5→null）は空の確認だけ（known=false）", J(5, null).verified === true && J(5, null).known === false);

console.log("\n■ ⑤ 古い決定との整合");
ok("入力中はリセットを押さない（従来の決まり）", /skipped: "fill_running"/.test(pressSrc));
ok("ルール文に件数の判定が入っている", /該当物件の数（○戸）がリセット前より増えたかは記録/.test(rules));

console.log("\n結果: " + pass + " 件OK / " + fail + " 件NG");
if (fail > 0) process.exitCode = 1;
