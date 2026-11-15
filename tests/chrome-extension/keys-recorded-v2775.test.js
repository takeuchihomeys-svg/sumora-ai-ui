/**
 * 打ち込み（直接入力）が記録に残るかのテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「自動モードの録画で弱い部分や抜けている部分、機械的な部分、
 *     直接入力されてしまっている部分も見つけられるようにする」
 *
 * ★ 見つけた穴（実測）
 *   `kinds` には `key: 36`（36回打った）と入っているのに、
 *   `shot_ops` には `k:"key"` が **0件**だった。
 *   理由: 記録の受け口（`_cap`）が `click` と `change` しか拾っておらず、
 *        写真の撮影（`h`）も `click`/`change`/`wheel` だけだった。
 *   → 打ち込みが**操作の記録にも写真にも残らない**ので、
 *     「選ぶ所を打ち込んでしまっている」を後から見つけられなかった。
 *
 * ★ 直した事
 *   ① 記録の受け口に `keydown` を足す（欄の名前と時刻だけ・中身は入れない）
 *   ② 同じ欄は1.2秒に1回へ間引く（1文字ごとに積むと欄の名前が埋まる）
 *   ③ 写真も `keydown` で撮る
 *   ④ 外す時（stop）も `keydown` を外す（外し忘れると止めた後も撮り続ける）
 *
 * 実行: node tests/chrome-extension/keys-recorded-v2775.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; }
  else { fail++; console.log("  ✗ " + name); }
};

const recPath = path.join(ROOT, "chrome-extension/human-learn-record.js");
const rec = fs.readFileSync(recPath, "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome-extension/manifest.json"), "utf8"));

// ── ① 記録の受け口が keydown を拾う ────────────
t("記録の受け口に keydown を付けている", /document\.addEventListener\("keydown",\s*_cap,\s*true\)/.test(rec));
t("打ち込みを k:\"key\" として積む", /_pushOp\("key"/.test(rec));
t("打ち込みの記録を1.2秒に1回へ間引く", /_recKeyLast\.t\s*<\s*1200|1200\)\)/.test(rec));
t("間引き用の入れ物を _cap より前に宣言している",
  rec.indexOf("var _recKeyLast") > 0 && rec.indexOf("var _recKeyLast") < rec.indexOf("var _cap = function"));
t("中身（打った文字）を入れないと明記", /打った中身は入れない|入力した中身は入れない|中身は入れない/.test(rec));
t("欄の名前は30文字までに切る", /slice\(0,\s*30\)/.test(rec));

// ── ② 写真も打ち込みで撮る ────────────
t("写真の撮影に keydown を付けている", /document\.addEventListener\("keydown",\s*h,\s*true\)/.test(rec));
t("止める時に keydown も外す", /removeEventListener\("keydown",\s*h,\s*true\)/.test(rec));

// ── ③ 壊していない物（既存の経路）────────────
t("click の受け口は残っている", /document\.addEventListener\("click",\s*_cap,\s*true\)/.test(rec));
t("change の受け口は残っている", /document\.addEventListener\("change",\s*_cap,\s*true\)/.test(rec));
t("押した欄を積む _pushPoint は残っている", /_pushPoint\(e\.target,\s*_by,\s*e\)/.test(rec));
t("開き方を控える noteBeforeClick は残っている", /noteBeforeClick\(e\.target\)/.test(rec));
t("開き方を見る noteOpened は残っている", /noteOpened\(_openedFor\)/.test(rec));
t("拡張自身の小窓は記録しない判定は残っている", /#axlx-bar/.test(rec));

// ── ④ 版 ────────────
t("版が 2.7.75", manifest.version === "2.7.75");

// ── ⑤ 構文が壊れていない（実際に読める）────────────
let syntaxOk = true;
try { new Function(rec); } catch (e) { syntaxOk = false; console.log("    構文エラー: " + e.message); }
t("human-learn-record.js の構文が通る", syntaxOk);

// ── ⑥ 分析する側が key を見る ────────────
const lib = fs.readFileSync(path.join(ROOT, "app/lib/learn-auto-audit.ts"), "utf8");
const scr = fs.readFileSync(path.join(ROOT, "scripts/audit-auto-mode.ts"), "utf8");
t("分析の純関数が直接入力を数える", /export function countDirectTyping/.test(lib));
t("分析が「選ぶ所を打ち込んでいる疑い」を出す", /選ぶ所を打ち込んでいる疑い/.test(scr));
t("分析が押さずに値だけ変わった欄も見る", /countChangedWithoutClick/.test(lib) && /押さずに値だけ変わった欄/.test(scr));

// ── ⑦ なぜ必要かをコードに残している（次に読む人が分かる）────────────
t("実測の数字（36回 vs 0件）を残している", /36回/.test(rec) && /0件/.test(rec));
t("直した理由を竹内さんの言葉で残している", /直接入力されてしまっている部分/.test(rec));

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
