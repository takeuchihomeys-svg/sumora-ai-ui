// 実行: node tests/chrome-extension/human-hesitate-v2599.test.js
// 2026-11-10 竹内さん「あとボタン選択する際人間ならたまにまよう」
//   ① 迷うのは「選ぶ系」が多い・決定（送信）はほとんど迷わない
//   ② 迷う長さは3段（一瞬／考え込む／かなり迷う）
//   ③ 確率も長さも毎回ちがう（等間隔にしない）
//   ④ 迷った所を点検に残す（あとで人の回と比べる）
//   ⑤ 一覧の部屋選び・ITANDI のチェック・駅にも迷いが入る
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ps = read("page-script.js");
const ips = read("itandi-page-script.js");
const bd = read("bulk-dl.js");
const ib = read("itandi-bulk-dl.js");

console.log("■ ① 迷うのは選ぶ系が多い・送信はほとんど迷わない");
ok("_hesitateKindOf がある（choose / decide / other）", /function _hesitateKindOf\(el\)/.test(ps));
ok("選ぶ系は 15%（checkbox・radio・label・select）", /var base = kind === "choose" \? 0\.15 : \(kind === "decide" \? 0\.03 : 0\.08\);/.test(ps));
ok("決定系（button・submit）は 3%", /kind === "decide" \? 0\.03/.test(ps));
ok("直前5秒以内に迷っていたら少し迷いやすい（+4pt）", /var boost = \(Date\.now\(\) - _lastHesitateAt < 5000\) \? 0\.04 : 0;/.test(ps));

console.log("\n■ ② 迷う長さは3段");
ok("一瞬 250〜600ms（65%）", /if \(r < 0\.65\) return 250 \+ Math\.floor\(Math\.random\(\) \* 350\);/.test(ps));
ok("考え込む 700〜1600ms（30%）", /if \(r < 0\.95\) return 700 \+ Math\.floor\(Math\.random\(\) \* 900\);/.test(ps));
ok("かなり迷う 1800〜4500ms（5%）", /return 1800 \+ Math\.floor\(Math\.random\(\) \* 2700\);/.test(ps));

console.log("\n■ ③ 確率も長さも毎回ちがう");
ok("確率を ±20〜25% で揺らす", /var p = \(base \+ boost\) \* \(0\.8 \+ Math\.random\(\) \* 0\.45\);/.test(ps));
ok("旧の固定幅 300〜700ms の一様8%はもう無い", !/hesitate = \(Math\.random\(\) < \(0\.08 \* \(0\.75 \+ Math\.random\(\) \* 0\.5\)\)\) \? humanRand\(300, 700\) : 0;/.test(ps));

console.log("\n■ ④ 迷った所を点検に残す");
ok("_tmarkHesitate が数を数える", /_audit\.hesitate_n = \(_audit\.hesitate_n \|\| 0\) \+ 1;/.test(ps));
ok("合計の時間も残す", /_audit\.hesitate_ms = \(_audit\.hesitate_ms \|\| 0\) \+ ms;/.test(ps));
ok("どこで迷ったか（最大8件）", /_audit\.hesitate_last\.length < 8/.test(ps));
ok("押す前に呼ぶ", /if \(hesitate > 0\) \{ try \{ _tmarkHesitate\(item\.label, hesitate\); \}/.test(ps));

console.log("\n■ ⑤ 一覧の部屋選び・ITANDI のチェックにも迷い");
ok("リアプロの一覧の選択で迷う（15%・3段）", /function _humanClickCb\(cb\)[\s\S]{0,2200}Math\.random\(\) < 0\.15 \* \(0\.75 \+ Math\.random\(\) \* 0\.5\)/.test(bd));
ok("ITANDI の一覧の選択で迷う（15%・3段）", /function _humanCheckAll[\s\S]{0,3000}Math\.random\(\) < 0\.15 \* \(0\.75 \+ Math\.random\(\) \* 0\.5\)/.test(ib));
ok("ITANDI の条件チェック（tick）でも迷う", /function tick\(el\)[\s\S]{0,2000}Math\.random\(\) < 0\.15 \* \(0\.75 \+ Math\.random\(\) \* 0\.5\)/.test(ips));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
