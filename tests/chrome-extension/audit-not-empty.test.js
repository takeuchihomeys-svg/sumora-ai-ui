// 自動モードの検索が「段なし」で終わっていた問題（2026-11-14）
//
// 竹内さん「自動モードでの検索はちゃんと改善されているのか」
//
// 実測（本番DB・直近3日）:
//   search_audits 175回中 **147回（84%）が `steps:0`**（自動モードが113回）
//   自動モード93回中、完走13回（14%）・abandoned 80回（86%）
//
// 原因（ページの世界）:
//   1. `fillRealpro` が2回呼ばれる（popup経由とbackground経由）
//   2. 2回目が重複として `notifyDone('duplicate-call-ignored')` を呼ぶ
//   3. これが **`finished` を「段なし」で送る** うえ `_doneNotified = true` にする
//   4. 1回目の本物の検索が終わっても、段も結果も記録されない
//
// 直し:
//   ・重複した時は **`notifyDone` を呼ばない**（段に1行足すだけ）
//   ・**重複の判定より先に `_auditReset`** を呼ぶ（点検を必ず作る）
//
// 実行: node tests/chrome-extension/audit-not-empty.test.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const ps = fs.readFileSync(path.join(SRC, "page-script.js"), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 重複した呼び出しが「段なしの finished」を送らない");
{
  /**
   * ⚠ `if (window._axFillRunning)` は**2か所**ある（2098行は別の用途）。
   *   実際の修正は `duplicate_ignored` を含む**重複ブロック**。
   *   ⚠ コメントの中にも `notifyDone` の文字が出るので、**実際の呼び出し（行頭寄り）**だけを見る。
   */
  const dupAt = ps.indexOf("duplicate_ignored");
  const start = dupAt > 0 ? ps.lastIndexOf("if (window._axFillRunning)", dupAt) : -1;
  const block = start >= 0 ? ps.slice(start, dupAt + 400) : "";
  const codeOnly = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  t("重複ブロックがある", start >= 0, { dupAt, start });
  t("  ⚠ 中で notifyDone を呼ばない（本物の段を消さない）", codeOnly.length > 0 && !/notifyDone\s*\(/.test(codeOnly), codeOnly.slice(0, 200));
  t("  代わりに段へ1行足す（duplicate_ignored）", block.includes("duplicate_ignored"));
  t("  点検が無い時は落ちない（try/catch）", /try \{ if \(_audit && _audit\.steps\)/.test(block));
}

console.log("\n■ ② 重複の判定より先に点検を作る");
{
  const dupLine = ps.indexOf("if (window._axFillRunning)", ps.indexOf("duplicate_ignored") - 1600);
  const resetAt = ps.indexOf("try { _auditReset(cond && cond._audit_run_id); }");
  t("_auditReset が重複判定より前にある", resetAt > 0 && dupLine > 0 && resetAt < dupLine, { resetAt, dupLine });
  t("  ⚠ 落ちても止まらない（try/catch）", /try \{ _auditReset\(/.test(ps));
}

console.log("\n■ ③ 点検は run_id が無くても作られる（自動モードの多くは無い）");
{
  t("_auditReset(runId) がある", /function _auditReset\(runId\)/.test(ps));
  t("  runId が無くても _audit を作る（local_ の番号）", /local_/.test(ps));
  t("  _auditStepP が _audit に積む", /_audit\.steps\.push\(/.test(ps));
  t("  上限60件で古い物から捨てる", /_audit\.steps\.length > 60/.test(ps));
}

console.log("\n■ ④ 段の名前が学習にも残る（世界をまたぐ橋）");
{
  t("postMessage で名前を送る", /from: "axlx-rec-note-name"/.test(ps));
  t("  地域・駅の段の名前がある", /modal: "所在地絞り込み"/.test(ps) && /station: "沿線・駅絞り込み"/.test(ps));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
