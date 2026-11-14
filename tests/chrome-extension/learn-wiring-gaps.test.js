// 「DBにあるのに反映できていない物」を塞いだ事を守る（2026-11-14）
//
// 竹内さん「DBにあって反映できていないものや連携にあたって強化できていない部分はあるか」
//
// 実測で見つけた4つ:
//   ① `screen_flow`（画面ごとの手順）… popup の表示だけ。自動検索では0箇所
//   ② `learn_plan`（統括の判断＝弱い所）… storage に置くだけで誰も読んでいない
//   ③ `opens`（押したら何が開くか）… popup に出していない（人が見えない）
//   ④ `ext_version`（版）… 束に入れていない。実測で直近200件が全部 2.7.29 で気づけなかった
//
// 実行: node tests/chrome-extension/learn-wiring-gaps.test.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const ps = read("page-script.js");
const hl = read("human-learn.js");
const pop = read("popup.js");
const bg = read("background.js");

const brain = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "human-learn-brain.ts"), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① 画面ごとの手順（screen_flow）を自動検索が使う");
{
  t("page-script が axlx_learn_screen_flow を読む", /axlx_learn_screen_flow/.test(ps));
  t("  window.__axlxLearnScreenFlow に入れる", /window\.__axlxLearnScreenFlow/.test(ps));
  t("  順番の合成に使う（mergeWithSequence）", /screenFlow[\s\S]{0,400}mergeWithSequence/.test(ps));
  t("  ⚠ 1回だけの前後は採らない（回数2以上）", /if \(Number\(st\.n\) < 2\) return;/.test(ps));
  t("  ⚠ 項目は増減しない（並べ替えだけ）", /_orderByLearned/.test(ps) && /items\.length === items\.length/.test(ps));
}

console.log("\n■ ② 統括の判断（learn_plan＝弱い所）を自動検索が使う");
{
  t("page-script が axlx_learn_plan を読む", /axlx_learn_plan/.test(ps));
  t("  弱い欄を引く（_weakOf）", /function _weakOf\(name\)/.test(ps));
  t("  点検に残す（learn_weak）", /_auditStepP\('learn_weak'/.test(ps));
  t("  ⚠ 動きは変えない（記録だけ）", !/_weakOf\([^)]*\)\s*\{[^}]*return (true|false);/.test(ps));
}

console.log("\n■ ③ 押したら何が開くか（opens）を画面にも出す");
{
  t("human-learn.js が opens を1行にする", /押したら何が開くか/.test(hl));
  t("  意味の分かる言葉にする", /小窓が開く/.test(hl) && /プルダウンの一覧が開く/.test(hl));
  t("popup が axlx_learn_opens を読む", /axlx_learn_opens/.test(pop));
  t("  opens だけでも表示する（他が空でも）", /!srv\.opens\) return;/.test(pop));
}

console.log("\n■ ④ 版（ext_version）と材料の数を束に入れる");
{
  t("source に versions を足した", /versions\?: Record<string, number>/.test(brain));
  t("source に with_ops を足した", /with_ops\?: number/.test(brain));
  t("  版の内訳を数える", /const versions: Record<string, number> = \{\}/.test(brain));
  t("  材料（操作の並び）がある記録を数える", /const withOps = list\.filter/.test(brain));
  t("  束に入れる", /\.\.\.\(Object\.keys\(versions\)\.length \? \{ versions \} : \{\}\)/.test(brain) && /with_ops: withOps/.test(brain));
  t("  人が読む行に出す（材料・版）", /材料（操作の並び）がある記録/.test(brain) && /記録した版/.test(brain));
}

console.log("\n■ ⑤ 拡張まで届く（置く→読む）");
{
  t("background が axlx_learn_opens を置く", /axlx_learn_opens: opens/.test(bg));
  t("background が axlx_learn_screen_flow を置く", /axlx_learn_screen_flow: screenFlow/.test(bg));
  t("background が axlx_learn_plan を置く", /axlx_learn_plan: plan/.test(bg));
  t("page-script が opens を読む", /axlx_learn_opens/.test(ps));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
