/**
 * 画像の位置から要素を特定して押す仕組みのテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「実装する」
 *
 * ★ なぜ必要か（実測）
 *   自動モードは画像から **2,837欄** 読めているのに、押した位置は **30個** だけだった。
 *   理由は「押した記録がある欄しか狙えない」から。
 *
 * ★ ⚠ なぜ「画面の位置をそのまま使う」と壊れるか
 *   `_humanPointerClick` は `aim.x` を**要素の中の割合**として計算する。
 *   画面の位置（0.17）を渡すと「要素の中の17%」と解釈され、**違う所を押す**。
 *
 * ★ 正しい手順（実装した）
 *   ① 画面の位置を px に直す
 *   ② `document.elementFromPoint` で**その場所の要素**を取る
 *   ③ 目的の欄か**確かめる**（名前が合うか・祖先3階層まで）
 *   ④ 合えば**その要素の真ん中**を押す
 *   ⑤ 合わなければ**使わない**（違う物を押さない）
 *
 * 実行: node tests/chrome-extension/screen-element-v2784.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };

const ps = fs.readFileSync(path.join(ROOT, "chrome-extension/page-script.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome-extension/manifest.json"), "utf8"));

// ── ① 画面の位置から要素を探す ────────────
t("elementFromPoint を使う", /document\.elementFromPoint\(px, py\)/.test(ps));
t("画面の割合を px に直す", /Math\.round\(x \* vw\)/.test(ps));
t("画面の外に出ない（clamp）", /Math\.max\(0, Math\.min\(vw - 1/.test(ps));

// ── ② 目的の欄か確かめる ────────────
t("名前を比べる", /okName = got === want/.test(ps));
t("祖先を3階層まで見る（位置のずれ対策）", /for \(var up = 0; up < 3 && p; up\+\+\)/.test(ps));
t("合わなければ使わない", /if \(!okName\) return null/.test(ps));

// ── ③ 危険な物を避ける ────────────
t("拡張自身の小窓は押さない", /#axlx-bar, #axlx-guide/.test(ps));
t("見えない・大きさ0は使わない", /r\.width > 2 && r\.height > 2/.test(ps));

// ── ④ 押した記録が無い・少ない時に使う ────────────
t("押した記録が無い時に探す", /var _sa = _screenAimOf\(name\);\s*\n\s*if \(_sa\) \{\s*\n\s*var _found = _elementAtScreenPos/.test(ps));
t("1回だけの時も探す", /var _sa2 = _screenAimOf\(name\);\s*\n\s*if \(_sa2\) \{\s*\n\s*var _f2 = _elementAtScreenPos/.test(ps));
t("見つかったら真ん中を押す", /return \{ el: el, x: 0\.5, y: 0\.5, fromScreen: true \}/.test(ps));
t("見つからなければ理由を残す", /screen_no_element/.test(ps));

// ── ⑤ 画面の位置をそのまま aim にしない（重要） ────────────
t("⚠ 画面の位置を aim.x として直接返さない", !/var aim = \{ x: v\.x, y: v\.y, n: Number\(v\.n\) \|\| 0 \};\s*\n\s*_noteAimUsed\(name, aim, null\);\s*\n\s*return aim;[\s\S]{0,100}fromScreen: true/.test(ps) && !/_noteAimUsed\(name, _sa, null\)/.test(ps));

// ── ⑥ 版 ────────────
t("版が 2.7.84 以降（2.7.85 で地域の確認を直した）", Number(manifest.version.split(".")[2]) >= 84);

// ── ⑦ 構文 ────────────
let ok = true;
try { new Function(ps); } catch (e) { ok = false; console.log("    " + e.message); }
t("page-script.js の構文が通る", ok);

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
