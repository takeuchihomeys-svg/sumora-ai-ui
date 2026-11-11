// 実行: node tests/chrome-extension/ai-customer-mode-v2634.test.js
// 2026-11-11 竹内さん「4つ目にAIXをつけて、AIXの場合選択したお客さんが自動検索できるようにする。
//   もともとあったの。新着で条件きたりしたらそれもAIXで対応できる形とする」
//
// 固定する形:
//   ① モードは4つ: 通常／スタッフ／自動（aix）／AIX（ai）
//   ② AIX は「選んだお客さんを自動で検索」する（aiCustomerSearch）
//   ③ AIX は AIXツールの指示・新着（aix・web_brain）・自動便も受け取る（もともとあった動き）
//   ④ popup はお客さんを選び、条件の読み直しが終わってから検索ボタンを押す（古い条件で押さない）
//   ⑤ 同じお客様×サイトを続けて押さない（10分）・別のお客様に切り替わったら押さない
//   ⑥ 自動モード（aix）は今まで通り「一覧の行を1件ずつ押す」で、AIX とは別物
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
const M = require(path.join(dir, "mode-core.js"));

let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)); }
function ok(name, c, extra) { if (c) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

console.log("■ ① モードは4つ");
eq("MODES", M.MODES, ["normal", "staff", "aix", "ai"]);
eq("表示名", [M.modeLabel("normal"), M.modeLabel("staff"), M.modeLabel("aix"), M.modeLabel("ai")], ["通常", "スタッフ", "自動", "AIX"]);
{
  const html = read("popup.html");
  ok("popup.html に4つ目の選択肢（AIX）", /<option value="ai">/.test(html) && /AIX（選んだお客さん）/.test(html));
  const opts = (html.match(/<option value="(normal|staff|aix|ai)"/g) || []).length;
  eq("選択肢の数", opts, 4);
}

console.log("\n■ ② AIX は選んだお客さんの自動検索を開く");
eq("AIX の aiCustomerSearch", M.behavior("ai", false).aiCustomerSearch, true);
eq("AIX × ブレイン", M.behavior("ai", true).aiCustomerSearch, true);
eq("自動（aix）は開かない", M.behavior("aix", false).aiCustomerSearch, false);
eq("通常・スタッフは開かない", [M.behavior("normal", false).aiCustomerSearch, M.behavior("staff", false).aiCustomerSearch], [false, false]);
eq("実効（GUIDE_ONLY 中）でも AIX は開く", M.effectiveBehavior("ai", false).aiCustomerSearch, true);
eq("実効で 通常は閉じる", M.effectiveBehavior("normal", true).aiCustomerSearch, false);
eq("実効で スタッフは閉じる", M.effectiveBehavior("staff", true).aiCustomerSearch, false);

console.log("\n■ ③ AIX は AIXツールの指示・新着・自動便も受け取る（もともとあった動き）");
eq("claimAix（aix 由来の指示）", M.behavior("ai", false).claimAix, true);
eq("runAutoSchedule（11:00/17:00 の自動便）", M.behavior("ai", false).runAutoSchedule, true);
eq("claimCommands（一括検索）", M.behavior("ai", false).claimCommands, true);
eq("claimBrainCommands（web_brain・新着の条件）", M.behavior("ai", true).claimBrainCommands, true);
eq("ブレイン OFF では web_brain を受け取らない（判定する PC だけ）", M.behavior("ai", false).claimBrainCommands, false);
eq("判定はブレインの時だけ", [M.behavior("ai", true).brainJudge, M.behavior("ai", false).brainJudge], [true, false]);

console.log("\n■ ④ popup は条件の読み直しが終わってから押す");
{
  const pj = read("popup.js");
  ok("AIXモードの印を持つ（_aiCustomerModeOn）", /var _aiCustomerModeOn = false;/.test(pj) && /_aiCustomerModeOn = s\.mode === "ai";/.test(pj));
  ok("お客さん選択時の自動検索の関数", /function _maybeAiCustomerAutoSearch\(btn, customer, site\)/.test(pj));
  ok("条件の読み直し（fetchFreshCustomer）が終わってから呼ぶ", /_freshPreloadPromise = fetchFreshCustomer\(c0\?\.id\)\.then\(fresh => \{[\s\S]{0,900}_maybeAiCustomerAutoSearch\(autofillBtn, c0, "realpro"\)/.test(pj));
  ok("itandi でも同じ（読み直しの後）", /setupAreaModeSelector\(selectedCustomer, "itandi"\);[\s\S]{0,400}_maybeAiCustomerAutoSearch\(_itBtn, selectedCustomer, "itandi"\)/.test(pj));
  ok("人が押すのと同じ道（btn.click）", /btn\.click\(\);/.test(pj));
}

console.log("\n■ ⑤ 詰まらない決まり");
{
  const pj = read("popup.js");
  ok("同じお客様×サイトを続けて押さない（10分）", /AIX_RESEARCH_GAP_MS = 10 \* 60 \* 1000/.test(pj) && /同じお客様を続けて検索しない/.test(pj));
  ok("別のお客様に切り替わったら押さない", /String\(selectedCustomer\.id\) !== String\(customer\.id\)\) return;/.test(pj));
  ok("モードが変わったら押さない", /if \(!_aiCustomerModeOn\) return;/.test(pj));
  ok("スタッフモードでは押さない", /if \(!_aiCustomerModeOn \|\| _staffModeOn\) return false;/.test(pj));
  ok("自動の一括の回はそちらに任せる（二重に押さない）", /if \(btn\.dataset\.automated\) return false;/.test(pj));
  ok("押した時刻を記録する（_aiAutoSearchMemo）", /_aiAutoSearchMemo\[key\] = now;/.test(pj));
  ok("人の間（0.9〜4秒）を置いてから押す", /logNormalDelay\(1500, 0\.35\)/.test(pj));
}

console.log("\n■ ⑥ 自動（aix）は一覧の行を1件ずつ押す（AIX とは別物）");
{
  const bd = read("bulk-dl.js");
  ok("自動モードの時だけ一覧を押す（_autoModeOn）", /function autoPressPdfs\(\)[\s\S]{0,400}if \(!_autoModeOn\)/.test(bd));
  ok("自動モードの判定は aixMode＋autoModeAt", /return !staffOn && !!s\.aixMode && Number\(s\.autoModeAt\) > 0;/.test(bd));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
