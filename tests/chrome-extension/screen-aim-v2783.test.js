/**
 * 画像の「画面の位置」を束に載せ、危険な使い方をしない事を固定するテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「理論上この通常のように自動もできる」「実装する」
 *
 * ★ やった事
 *   束（`shots.learned`）に **x/y/zone（画面のどこか）**を載せた。
 *   ⚠ 実測: 旧は名前と種類しか載せていなかったので、拡張に「どこにあるか」が届いていなかった。
 *   背景が `axlx_learn_screen` に「画面の位置」を入れる（押す位置とは**別の入れ物**）。
 *
 * ★ ⚠ 危険なので**やらなかった**事（これが一番大事）
 *   画面の位置を「押す位置」として使わない。
 *   `_humanPointerClick` は `aim.x` を**要素の中の割合**として計算するので、
 *   画面の位置（0.1）を渡すと**違う所を押す**。
 *   → 記録に理由（`screen_only`）を残すだけにした。
 *
 * 実行: node tests/chrome-extension/screen-aim-v2783.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };

const ps = fs.readFileSync(path.join(ROOT, "chrome-extension/page-script.js"), "utf8");
const bg = fs.readFileSync(path.join(ROOT, "chrome-extension/background.js"), "utf8");
const brain = fs.readFileSync(path.join(ROOT, "app/lib/human-learn-brain.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome-extension/manifest.json"), "utf8"));

// ── ① 束に画面の位置を載せる ────────────
t("束に x を載せる", /\.\.\.\(typeof rec\.x === "number" \? \{ x: rec\.x \}/.test(brain));
t("束に y を載せる", /\.\.\.\(typeof rec\.y === "number" \? \{ y: rec\.y \}/.test(brain));
t("束に zone を載せる", /zone: String\(rec\.zone\)/.test(brain));
t("型にも x/y/zone がある", /x\?: number; y\?: number; zone\?: string/.test(brain));

// ── ② 背景が別の入れ物に入れる ────────────
t("axlx_learn_screen を作る", /axlx_learn_screen: _screenAim/.test(bg));
t("3回以上見た欄だけ入れる", /\(Number\(f\.n\) \|\| 0\) < 3\) continue/.test(bg));
t("押す位置とは別の入れ物（混ぜない）", /_screenAim\[k\] = \{ x:/.test(bg));

// ── ③ ✅ 画面の位置から**要素を特定して**使う（v2.7.84 で実装）────────────
t("_screenAimOf がある（読む所）", /function _screenAimOf/.test(ps));
/**
 * ⚠ 2026-11-15 竹内さん「実装する」で設計を進めた:
 *   旧: 画面の位置を **aim として使わない**（意味が違うので危険）→ 記録だけ
 *   新: **要素を特定してから**使う（`elementFromPoint` ＋ 名前の確認）
 *   → v2.7.83 の「使わない」テストは v2.7.84 で「要素を特定して使う」に変わった。
 */
t("✅ 要素を特定する関数がある", /function _elementAtScreenPos/.test(ps));
t("✅ 要素を特定してから使う", /_elementAtScreenPos\(_sa\.x, _sa\.y, name/.test(ps));
t("⚠ 要素が見つからなければ使わない（違う物を押さない）", /screen_no_element/.test(ps));
t("⚠ 名前が合わなければ使わない", /if \(!okName\) return null/.test(ps));

// ── ④ 押した記録がある時は今まで通り ────────────
t("押した記録（n>=2）は今まで通り使う", /var aim = \{ x: v\.x, y: v\.y, n: Number\(v\.n\) \|\| 0 \}/.test(ps));
t("1回だけの記録は使わない（偶然）", /if \(Number\(v\.n\) < 2\)/.test(ps));

// ── ⑤ 版 ────────────
t("版が 2.7.83 以降", manifest.version >= "2.7.83");

// ── ⑥ 構文 ────────────
let ok1 = true, ok2 = true;
try { new Function(ps); } catch (e) { ok1 = false; console.log("    page: " + e.message); }
try { new Function(bg.replace(/^import .*$/gm, "")); } catch (e) { ok2 = false; console.log("    bg: " + e.message); }
t("page-script.js の構文が通る", ok1);
t("background.js の構文が通る", ok2);

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
