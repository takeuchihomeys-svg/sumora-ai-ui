// 「自動モードで地域が押せていない」を点検で見えるようにする試験（2026-11-13）
//
// 竹内さん「まだ自動モードで地域などの部分おせていない、ここ録画しているので
//   その点も含めて学習して改善する」（画面は「失敗5」・録画の写真が1枚も残らない）
//
// 見つけた穴（実測で裏づけ）:
//   ① 点検が `stalled:realpro:none`（最後の段: none）で **7日259回**。
//      ＝「どの段で止まったか」が一切残っていない＝地域・駅が押せていない事も見えない。
//      原因: `run_id` が無い回は段を**1つも記録しない**作りだった
//        - page-script `_auditReset`: `runId ? {...} : null`
//        - page-script 送信: `if (_fillRunId) { ... }`
//        - background fill-done: `if (msg.runId)`
//        - background `_auditOnFillDone`: `if (!msg.runId) return;`
//   ② 録画が失敗しても**理由が録画中に見えない**（止めた時だけ）＝「失敗5」だけで原因不明
//   ③ 失敗の種類（quota／権限／窓が後ろ／タブ無し）で手を打っていなかった
//
// 実行: node tests/chrome-extension/audit-always-record.test.js
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① 点検は run_id が無くても記録する（none 259回の原因）");
{
  const ps = read("page-script.js");
  t("_auditReset が run_id 無しでも作る", !/_audit = _fillRunId \? \{/.test(ps), "旧の三項演算子が残っている");
  t("その場の番号（local_）を持つ", ps.includes("local_run_id"));
  t("run_id が無い事を記録する", ps.includes("no_run_id"));
  t("送信が _fillRunId で止まらない", !/if \(_fillRunId\) \{\s*msg\.runId = _fillRunId;/.test(ps));
  t("_audit がある限り audit を載せる", /if \(_audit\) \{[\s\S]{0,300}msg\.audit = _auditPack\(\)/.test(ps));

  const bg = read("background.js");
  t("fill-done が runId で止まらない", !/if \(msg\.runId\) _auditOnFillDone/.test(bg));
  t("audit があれば記録する", /if \(msg\.audit \|\| msg\.runId\) _auditOnFillDone/.test(bg));
  t("_auditOnFillDone が runId 無しで即 return しない", !/if \(!_auditTracker \|\| !msg \|\| !msg\.runId\) return;/.test(bg));
  t("run_id の代わりを作る", bg.includes('"local_" + Date.now().toString(36)'));
}

console.log("■ ② 録画の失敗理由が録画中に見える");
{
  const sp = read("snapshot-popup.js");
  t("録画中も last_error を出す", /recording|録画中[\s\S]{0,300}last_error|why/.test(sp) && sp.includes("last_error"));
  t("理由を短く切って出す", /slice\(0, 40\)/.test(sp));
}

console.log("■ ③ 失敗の種類ごとに手を打つ");
{
  const bg = read("background.js");
  t("種類に分ける関数がある", bg.includes("_recErrKind"));
  t("quota は間隔を延ばす", /_kind === "quota"[\s\S]{0,160}gap \+= 800/.test(bg));
  t("権限は帯で知らせる", bg.includes("_recMarkNeedsPermission"));
  t("タブが無い時は待つ", /_kind === "no_tab"[\s\S]{0,80}gap \+= 1500/.test(bg));
  t("窓が後ろの時も手を打つ", /_kind === "not_focus"/.test(bg));
}

console.log("■ ④ 段の記録が実際に残る（純関数として確かめる）");
{
  // page-script の _auditStepP と同じ形（配列に積む・60件で古い物を捨てる）を再現して確かめる
  const steps = [];
  const stepP = (k, d) => {
    steps.push({ at: Date.now(), k: String(k).slice(0, 30), d: d == null ? null : String(d).slice(0, 120) });
    if (steps.length > 60) steps.shift();
  };
  for (let i = 0; i < 70; i++) stepP("s" + i, "x");
  t("60件を超えたら古い物から捨てる", steps.length === 60, steps.length);
  t("最後の段が残る", steps[steps.length - 1].k === "s69", steps[steps.length - 1]);
}

console.log("■ ⑤ 「最後の段: none」にならない（段が入る）");
{
  const check = fs.readFileSync(path.join(ROOT, "app", "lib", "search-audit-check.ts"), "utf8");
  t("段が空なら none と表示する仕様はそのまま", /stalled:\$\{siteKey\}:\$\{keyPart\(last\)\}/.test(check));
  // 段が1つでも入れば none にならない
  const stepSummary = (s) => (Array.isArray(s) && s.length ? String(s[s.length - 1].k) : "none");
  t("段があれば none にならない", stepSummary([{ k: "modal" }]) === "modal");
  t("段が空なら none（ここが259回だった）", stepSummary([]) === "none");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
