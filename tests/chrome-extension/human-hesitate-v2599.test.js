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
// 2026-11-16 迷いを厚く: 選ぶ系 15%→22%・決定系 3%→7%・その他 8%→10%（選ぶ系 > その他 > 決定系の順は変わらない）
ok("決定系（button・submit）は 7%（選ぶ系より低い）", /kind === "decide" \? 0\.07/.test(ps));
ok("直前5秒以内に迷っていたら少し迷いやすい（+5pt）", /var boost = \(Date\.now\(\) - _lastHesitateAt < 5000\) \? 0\.05 : 0;/.test(ps));

console.log("\n■ ② 迷う長さは3段");
// 2026-11-17: 迷い時間も対数正規（一様バンド禁止）。3段の比は 60/32/8%
ok("考え込む（中央値 1100ms・32%）", /if \(r < 0\.92\) return Math\.round\(H && H\.logNormalDelay \? H\.logNormalDelay\(1100, 0\.5\)/.test(ps));
ok("かなり迷う（中央値 2600ms・残り8%）", /return Math\.round\(H && H\.logNormalDelay \? H\.logNormalDelay\(2600, 0\.45\)/.test(ps));

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
