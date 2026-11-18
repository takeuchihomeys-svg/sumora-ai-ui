/**
 * 「押す前の状態（was）」が確実に記録されるかのテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「3組目の悠さんは駅での検索なので、前に残っていた
 *     泉大津市・西成区・住之江区・浪速区を外すために押している。
 *     選択しているのではなくて押すことで前に残っている部分をはずしている」
 *
 * ★ 実測で分かった事（**was が1件も入らなかった原因**）
 *   2.7.78 で `was`/`now` を足したのに、まりあさんの録画151枚で **0件**だった。
 *   ⚠ 原因: クリックの `e.target` は **`label.one_city` や `span`** で、
 *     **`checked` を持っていない**。チェックの実体は**その中の `input`** にある。
 *   → `el.checked` だけ見ていると `was` が入らない（実測で0件）。
 *   → **要素の中の `input[type=checkbox|radio]` も見る**ように直した（2.7.79）。
 *
 * 実行: node tests/chrome-extension/was-recorded-v2779.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };

const rec = fs.readFileSync(path.join(ROOT, "chrome-extension/human-learn-record.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome-extension/manifest.json"), "utf8"));

// ── ① 押す前の状態を取る ────────────
t("wasChecked を持っている", /var wasChecked = null;/.test(rec));
t("checked を読んでいる", /\.checked === "boolean"/.test(rec));
t("⚠ 要素の中の input も探す（label を押しても取れる）", /querySelector\('input\[type="checkbox"\], input\[type="radio"\]'\)/.test(rec));
t("closest('label') の中も探す", /\.closest\("label"\)/.test(rec));
t("探した要素を _chkEl として使う", /_chkEl = _findCheckEl\(el\)/.test(rec) || /_chkEl = _inp/.test(rec));
t("was を操作に載せる", /_opObj\.was = wasChecked/.test(rec));
t("now も載せる", /_opObj\.now = _chkEl\.checked/.test(rec));
t("mousedown で押す前を掴む（2.8.10）", /addEventListener\("mousedown"/.test(rec) && /_pendingWas/.test(rec));

// ── ② 押す前に呼ばれる（capture）────────────
t("click を capture で拾う（押す前に状態を読める）", /document\.addEventListener\("click", _cap, true\)/.test(rec));
t("change も拾う", /document\.addEventListener\("change", _cap, true\)/.test(rec));

// ── ③ 中身は入れない ────────────
t("真偽だけと明記", /真偽だけ/.test(rec));
t("入力した中身は入れないと明記", /入力した中身は入れない|中身は入れない/.test(rec));

// ── ④ 実測の失敗を残している ────────────
t("151枚で0件だったと書いてある", /151枚/.test(rec) || /1件も入らない/.test(rec));
t("label は checked を持たないと書いてある", /label.*checked.*持っていない|checked.*持っていない/.test(rec));

// ── ⑤ サーバーが受け取る ────────────
const route = fs.readFileSync(path.join(ROOT, "app/api/human-motion/route.ts"), "utf8");
t("サーバーが was を受け取る", /typeof r\.was === "boolean"/.test(route));
t("サーバーが now を受け取る", /typeof r\.now === "boolean"/.test(route));

// ── ⑥ サーバーに入れてから判定に使える ────────────
const lib = fs.readFileSync(path.join(ROOT, "app/lib/toggle-meaning.ts"), "utf8");
t("was=true → now=false は「外した」", /now \? "on" : "off"/.test(lib));
t("押す前が無ければ unknown（推測しない）", /unknown/.test(lib));

// ── ⑦ 版 ────────────
t("版が 2.7.79 以降", manifest.version >= "2.7.79");

// ── ⑧ 構文 ────────────
let ok = true;
try { new Function(rec); } catch (e) { ok = false; console.log("    構文: " + e.message); }
t("構文が通る", ok);

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
