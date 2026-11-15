/**
 * 録画の写真を「読める大きさ」で送るテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「録画のサイズ読めるサイズにする」
 *
 * ★ 何が悪かったか（実測で確定）
 *   旧: 全体を **480px に縮めてから** 左34%（欄がある所）を切り出す
 *       → 欄の部分は実質 **163px 幅**。拡大しても情報は戻らない。
 *   同じ画面で比べた結果:
 *     163px 相当  … 「賃料」「フリーワード」は読めるが「14万」「1日以内」は読めない
 *     435px 相当  … 「1日以内」「14万円」「15年以内」「1LDK」「空室」まで読める
 *
 * ★ 直した事
 *   ① **等倍のまま送る**（縮めない）。画面が 1920px を超える時だけ縮める
 *   ② 上限に収まっている写真は**再エンコードしない**（元のまま送る）
 *      ⚠ 旧はいつも作り直していたので、画質が落ちるのに容量は増える事があった
 *         （実測: 元 85KB → q70 で 98KB）
 *   ③ 品質は q70（実測 40KB 前後）。小窓が開いた時は q82（文字が小さいため）
 *
 * 実行: node tests/chrome-extension/shot-readable-v2776.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };

const bg = fs.readFileSync(path.join(ROOT, "chrome-extension/background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome-extension/manifest.json"), "utf8"));

// ── ① 480px に縮めていない ────────────
t("480px 固定をやめた", !/var SHOT_SEND_SIDE = 480/.test(bg));
t("等倍（上限 1920px）で送る", /var SHOT_MAX_SIDE = 1920/.test(bg));
t("品質は q70", /var SHOT_SEND_Q = 0\.70/.test(bg));
t("小窓の時は q82", /var SHOT_BIG_Q = 0\.82/.test(bg));
t("送る時に上限と品質を使う", /const cap = _big \? SHOT_BIG_SIDE : SHOT_MAX_SIDE/.test(bg));

// ── ② 上限内なら作り直さない ────────────
t("上限に収まっていれば元のまま送る", /if \(long <= maxSide\)/.test(bg));
t("元のまま送る印を返す", /passthrough: true/.test(bg));
t("なぜ作り直さないかをコメントで残す", /画質が落ちるのに容量は増える/.test(bg));

// ── ③ 実測の数字を残している（次に読む人が理由を分かる）────────────
t("163px と 435px の比較を残す", /163px/.test(bg) && /435px/.test(bg));
t("容量の実測（40KB前後）を残す", /40KB/.test(bg));
t("読めた具体例を残す", /1LDK/.test(bg) && /空室/.test(bg));

// ── ④ 壊していない物 ────────────
t("縮小の関数は残っている（上限超えの時だけ使う）", /async function _shrinkShot/.test(bg));
t("小窓の判定は残っている", /function _shouldShotBig/.test(bg));
t("ローカルの控えは小さいまま（容量1.5MB制限）", /var SHOT_LOCAL_SIDE = 320/.test(bg));
t("サーバーの受け入れ上限内（4.5MB）に収まる設計", /4_500_000|4500000/.test(fs.readFileSync(path.join(ROOT, "app/api/human-motion/route.ts"), "utf8")));

// ── ⑤ 版 ────────────
t("版が 2.7.76", manifest.version >= "2.7.76");

// ── ⑥ 縮小の呼び出し（送る所1か所＋ローカルの控え1か所／定義は数えない）────────────
const calls = (bg.match(/_shrinkShot\((?!dataUrl, maxSide)/g) || []).length;
t("縮小の呼び出しは2か所（送る所＋ローカルの控え）", calls === 2);
t("送る所で上限と品質を渡している", /_shrinkShot\(dataUrl, cap, q\)/.test(bg));
t("ローカルの控えは別（小さいまま）", /_shrinkShot\(shrunkDataUrl/.test(bg));
t("ローカルの控えは別（小さいまま）", /_shrinkShot\(shrunkDataUrl/.test(bg));

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
