// 実行: node tests/chrome-extension/guide-auto-parity-v2682.test.js
// 2026-11-11 竹内さん「もともとの通常モードでのアナウンスとかでも押す場所や賃料等の条件理解しているから
//   ちゃんとそれを押すことができればよいのになぜできていないのか。場所とかも通常モードなら押す場所理解しているのに
//   なぜ自動モードやAIXモードでは理解できていないのか。ここの部分改善する」
//
//   原因: 案内モード（realpro-guide.js）には「閉じている欄を開く」段取り（openerFor）があるのに、
//         自動モード（page-script.js）には無かった。
//   → 自動モードにも同じ考え方を入れた（同じ画面・同じ手順で探す）。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const ps = read("page-script.js"), guide = read("realpro-guide.js");

console.log("■ ① 案内モードが持っている「開く」段取り（元の賢さ）");
{
  ok("案内モードは「＋」の見出しを探す（PLUS_HEAD_RE）", /var PLUS_HEAD_RE = \/\[＋\+\]\$\//.test(guide));
  ok("案内モードは欄から上へたどって開くボタンを探す（openerFor）", /function openerFor\(el\)/.test(guide));
  ok("案内モードは名前でも探す（所在地・沿線・絞り込み条件）", /所在地絞り込み＋/.test(guide) && /沿線・駅絞り込み＋/.test(guide) && /絞り込み条件＋/.test(guide));
  ok("案内モードは「欄が見つかりません→条件の欄を開いて」と案内する", /欄が見つかりません。条件の欄を開いてください/.test(guide));
}

console.log("\n■ ② 自動モードにも同じ「開く」段取りを入れた");
{
  ok("自動モードに PLUS_HEAD_RE がある", /var PLUS_HEAD_RE = \/\[＋\+\]\$\//.test(ps));
  ok("自動モードに _openerFor がある（欄から上へたどる）", /function _openerFor\(el\)/.test(ps));
  ok("自動モードに _openerForKind がある（名前でも探す）", /function _openerForKind\(name, el\)/.test(ps));
  ok("  所在地は「所在地絞り込み＋」", /_openerForKind[\s\S]{0,400}所在地絞り込み＋/.test(ps));
  ok("  駅は「沿線・駅絞り込み＋」", /_openerForKind[\s\S]{0,500}沿線・駅絞り込み＋/.test(ps));
  ok("  その他は「絞り込み条件＋」", /絞り込み条件＋/.test(ps));
  ok("自動モードに _ensureFieldVisible がある", /function _ensureFieldVisible\(el, name, maxMs\)/.test(ps));
  ok("  「＋」を押してから見えるのを待つ（最大3秒）", /_humanPointerClick\(op, function \(\) \{ try \{ op\.click\(\); \} catch \(_\) \{\} \}\)/.test(ps) && /setTimeout\(poll, 200\)/.test(ps));
  ok("  押した事を点検に残す（open_field）", /_auditStepP\('open_field'/.test(ps));
}

console.log("\n■ ③ 値の入力が「閉じた欄」でも入るようになった");
{
  ok("setSelVal は見えるようにしてから入れる", /function setSelVal\(name, val\) \{[\s\S]{0,600}_ensureFieldVisible\(el, name, 2500\)\.then/.test(ps));
  ok("_operateWithPointer は「ただ待つ」だけでなく「開く」を試す", /if \(attempt === 1\) \{[\s\S]{0,200}_ensureFieldVisible/.test(ps));
  ok("「見えていなければ少し待つ」の上限は残る（止まらない）", /if \(ok \|\| attempt >= 12\)/.test(ps));
}

console.log("\n■ ④ 場所（所在地・駅）のモーダルは自動でも開ける");
{
  ok("所在地のモーダルを開く（所在地絞り込み＋）", /waitForClick\([\s\S]{0,200}所在地絞り込み＋/.test(ps));
  ok("駅のモーダルを開く（沿線・駅絞り込み＋）", /clickByText\(\['沿線・駅絞り込み＋'/.test(ps));
  ok("開いたかどうかを点検に残す（modal / area）", /_auditStepP\('modal', 'area'\)/.test(ps));
}

console.log("\n■ ⑤ 検索前の確認で「違う」になっても止まらない（v2.6.81）");
{
  ok("場所だけ止める", /_auditStepP\('gate_stop_area'/.test(ps));
  ok("家賃などは警告して検索する", /_auditStepP\('gate_warn'/.test(ps));
  ok("止めてもいないのに検索しない、が無い", !/_auditStepP\('gate_stop'/.test(ps));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
