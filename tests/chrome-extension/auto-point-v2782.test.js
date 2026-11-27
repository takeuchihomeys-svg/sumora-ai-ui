/**
 * 自動モードでも「押した位置」が記録されるかのテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「実装する」→ 統括の1番（0円）:
 *     「自動モードで押した位置が記録されていない（通常74% / 自動12%）」
 *
 * ★ 実測で判明した原因
 *   記録側（`_pushPoint`）は `by === "auto"` の時、位置を **0.5（真ん中）に固定**していた。
 *   ＝ 実際にどこを押したかは**カーソルが知っているのに使っていなかった**。
 *   → 自動モードの押した位置は「全部真ん中」になり、学びになっていなかった。
 *
 * ★ 直した事
 *   ① `pointer-ui.js` の `tap` が**カーソルの実際の位置**を `__axlxRecNotePoint` に渡す
 *   ② `_pushPoint` が `synthetic:true` の時は**その座標をそのまま使う**
 *   ③ 要素の外に居たら記録しない（嘘を入れない）
 *
 * 実行: node tests/chrome-extension/auto-point-v2782.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };

const ptr = fs.readFileSync(path.join(ROOT, "chrome-extension/pointer-ui.js"), "utf8");
const rec = fs.readFileSync(path.join(ROOT, "chrome-extension/human-learn-record.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome-extension/manifest.json"), "utf8"));

// ── ① tap が実際の位置を渡す ────────────
t("tap が __axlxRecNotePoint を呼ぶ", /__axlxRecNotePoint/.test(ptr));
t("カーソルの位置（position()）を使う", /position\(\)/.test(ptr));
t("要素の中の割合を計算する", /\(_p2\.x - _r2\.left\) \/ _r2\.width/.test(ptr));
t("synthetic:true を付ける（実際の座標だと伝える）", /synthetic:\s*true/.test(ptr));
t("要素の外なら記録しない（0〜1で判定）", /_fx2 >= 0 && _fx2 <= 1/.test(ptr));

// ── ② _pushPoint が自動でも実座標を使う ────────────
// 2026-11-17（統括Pro）以降: 旧 `syn` 変数は useXY に統合（auto でも実座標があれば使う・0,0 だけ真ん中）
t("synthetic の時は真ん中にしない（実座標を使う）", /var useXY = hasXY && !zeroish && \(ev\.synthetic === true \|\| by === "human" \|\| by === "auto"\)/.test(rec));
t("座標が無い時だけ真ん中", /var fx = useXY \? \(\(cxU - r\.left\) \/ r\.width\) : 0\.5/.test(rec) && /var fy = useXY \? \(\(cyU - r\.top\) \/ r\.height\) : 0\.5/.test(rec));
t("実座標があるか確かめる", /Number\.isFinite\(Number\(ev\.clientX\)\)/.test(rec));

// ── ③ __axlxRecNotePoint を公開 ────────────
t("__axlxRecNotePoint を公開している", /window\.__axlxRecNotePoint = _pushPoint/.test(rec));

// ── ④ 実測の失敗を残している ────────────
t("真ん中に固定していたと書いてある", /0\.5（真ん中）に固定/.test(rec) || /真ん中.*固定/.test(rec));
t("通常74% / 自動12% と書いてある", /74%/.test(rec) && /12%/.test(rec) || /通常74%/.test(rec));

// ── ⑤ 版 ────────────
t("版が 2.7.82 以降", manifest.version >= "2.7.82");

// ── ⑥ 構文 ────────────
let ok1 = true, ok2 = true;
try { new Function(ptr); } catch (e) { ok1 = false; console.log("    pointer-ui: " + e.message); }
try { new Function(rec); } catch (e) { ok2 = false; console.log("    record: " + e.message); }
t("pointer-ui.js の構文が通る", ok1);
t("human-learn-record.js の構文が通る", ok2);

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
