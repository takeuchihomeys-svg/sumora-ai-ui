/**
 * 自動モードが「押して選ぶ」を記録できるかのテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「自動モード録画した。ちゃんと学習が反映されていない部分がおおい」
 *     「所在地のところ1つずつ押す前におそらく自動で入れているからエラーおきている」
 *     「徒歩の部分もきえている」「プルダウンの場合で押す部分もちゃんと理解できていない」
 *
 * ★ 実測（自動モード 2.7.79 の録画・235枚）
 *   機械の操作 17手の内訳: **click 11・change 6**
 *   ところが `rental_cost2`・`transportation_id`・`required_time`・`structured_date`・`update_date` は
 *   **change だけ**で click が無かった（＝「押さずに値を入れた」ように見える）。
 *   所在地の区は**機械が1回も押していない**（0回）。
 *   押した位置（`point_fields`）が **0種類**・`one_city` の操作が **0/100枚**。
 *
 * ★ 原因
 *   `pointer-ui.js` の `tap`（見えるカーソルの押下）は `__axlxNoteAutoOp`（自動用の別の入れ物）に
 *   しか記録しておらず、**`shot_ops`（点検・学習に載る方）には積んでいなかった**。
 *   → 記録を見ると「押していない」ように見え、統括が「直接入力している」と判断していた。
 *
 * ★ 直した事
 *   `tap` から **`__axlxRecNoteOp("click", 押した要素)` も呼ぶ**。
 *
 * 実行: node tests/chrome-extension/auto-click-recorded-v2780.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };

const ptr = fs.readFileSync(path.join(ROOT, "chrome-extension/pointer-ui.js"), "utf8");
const rec = fs.readFileSync(path.join(ROOT, "chrome-extension/human-learn-record.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "chrome-extension/manifest.json"), "utf8"));

// ── ① tap が shot_ops に載る記録を呼ぶ ────────────
t("tap が __axlxRecNoteOp を呼ぶ", (ptr.match(/__axlxRecNoteOp/g) || []).length >= 2);
t("押した要素を渡す", /_rec\("click", _tapEl\)/.test(ptr));
t("要素が無ければ呼ばない", /_rec === "function" && _tapEl/.test(ptr) || /_tapEl\) _rec/.test(ptr));
t("自動用の記録（__axlxNoteAutoOp）も残す", /__axlxNoteAutoOp/.test(ptr));

// ── ② 記録側が click を積める ────────────
t("__axlxRecNoteOp が公開されている", /window\.__axlxRecNoteOp = _recNoteOp/.test(rec));
t("_recNoteOp が _pushOp を呼ぶ", /_recNoteOp[\s\S]{0,80}_pushOp/.test(rec));

// ── ③ 実測の失敗を残している ────────────
t("機械の操作が click 11・change 6 と書いてある", /click 11/.test(ptr) || /click が11/.test(ptr));
t("change だけの欄を名指ししている", /rental_cost2/.test(ptr) && /transportation_id/.test(ptr));
t("押した位置が0種類と書いてある", /0種類/.test(ptr) || /押した位置.*0/.test(ptr));
t("所在地の区が0回と書いてある", /1回も押していない/.test(ptr) || /0回/.test(ptr));

// ── ④ 版 ────────────
t("版が 2.7.80 以降", manifest.version >= "2.7.80");

// ── ⑤ 構文 ────────────
let ok1 = true, ok2 = true;
try { new Function(ptr); } catch (e) { ok1 = false; console.log("    pointer-ui: " + e.message); }
try { new Function(rec); } catch (e) { ok2 = false; console.log("    human-learn-record: " + e.message); }
t("pointer-ui.js の構文が通る", ok1);
t("human-learn-record.js の構文が通る", ok2);

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
