/**
 * 通常モード（人が検索を押す）でも「終わった」が記録されるテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「学習と自動モードの強化もお願い」
 *
 * ★ 実測で見つけた穴（統括の判断が狂う一番の原因）
 *   `search_audits` 60件中 **54件が「途中で止まった（abandoned）」**だった。
 *   統括はこれを見て「完走率 8%」と言い、**検索が押せていない**と判断していた。
 *   ところが中身を見ると、止まった回も**最後まで操作が進んでいた**（最後の操作が `click:検索`・全49手）。
 *
 *   ⚠ 原因: 終わりの合図（`notifyDone`）は**拡張が自分で検索を押した時**（`clickSearch`）にしか
 *     呼ばれない。**通常モードでは人が検索を押す**ので通らず、合図が来ないまま `abandoned` になる。
 *     ＝ **止まっていないのに止まったと記録されていた**。
 *
 * ★ 直した事
 *   人が検索ボタンを押したのを検知して、2.5秒後に `notifyDone()` を呼ぶ（`startHumanSearchWatch`）。
 *   ⚠ 自動の時は `clickSearch` が送るので**二重にならない**（`_doneNotified` で1回だけ）。
 *   ⚠ `_audit` が無い（通常モード）時は**最低限の器を作る**（段を1つ残す）。
 *
 * 実行: node tests/chrome-extension/human-search-signal-v2777.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  ✗ " + name); } };

const ps = fs.readFileSync(path.join(ROOT, "chrome-extension/page-script.js"), "utf8");

// ── ① 見張りが在る ────────────
t("startHumanSearchWatch がある", /function startHumanSearchWatch\(\)/.test(ps));
t("起動時に呼んでいる", /try \{ startHumanSearchWatch\(\); \}/.test(ps));
t("二重に付けない", /if \(_humanSearchWatch\) return;/.test(ps));
t("click を capture で見ている", /document\.addEventListener\("click", onClick, true\)/.test(ps));

// ── ② 人の操作だけ（拡張の合成クリックは除く）────────────
t("isTrusted だけ拾う", /if \(!e \|\| !e\.isTrusted\) return;/.test(ps));
t("小窓の中の検索は除く", /this_window, \[role="dialog"\]/.test(ps));
t("検索ボタンの判定（go_search）", /div\.go_search, div\.go_search_submit/.test(ps));
t("検索ボタンの判定（文字）", /住居検索\|検索\|物件を検索する\|条件で検索/.test(ps));

// ── ③ 合図を送る（1回だけ・待ってから）────────────
t("notifyDone を呼ぶ", /notifyDone\(\);/.test(ps));
t("2.5秒待ってから送る", /}, 2500\);/.test(ps));
t("二重に送らない（_doneNotified）", /if \(_doneNotified\) return;/.test(ps));
t("段に human_search を残す", /_auditStepP\('human_search'/.test(ps));

// ── ④ 通常モードでは _audit が無い → 器を作る ────────────
t("_audit が無い時に最低限の器を作る", /_audit = \{\s*\n\s*v: 1, site: 'realpro', search_clicked: Date\.now\(\)/.test(ps));
t("器に段を1つ入れる", /steps: \[\{ at: t0, k: "human_search"/.test(ps));
t("no_run_id を立てる（点検に送れなくても段は残す）", /no_run_id: true/.test(ps));

// ── ⑤ 巻き上げの罠（var で定義して後から呼ぶと undefined）────────────
t("_sendHumanSearchDone は関数宣言（var ではない）", /function _sendHumanSearchDone\(t0\)/.test(ps));
const declPos = ps.indexOf("function _sendHumanSearchDone");
t("宣言が onClick より前にある（呼べる）", declPos > 0 && declPos < ps.indexOf("_humanSearchWatch = onClick"));
t("document.addEventListener を消していない", (ps.match(/document\.addEventListener\("click", onClick, true\)/g) || []).length === 1);

// ── ⑥ 顧客IDを借りる（無くても送る）────────────
t("current_customer_id を借りる", /chrome\.storage\.local\.get\(\["current_customer_id"\]/.test(ps));
t("無くても送る（点検の段だけ残す）", /_sendHumanSearchDone\(Date\.now\(\)\)/.test(ps));

// ── ⑦ 既存を壊していない ────────────
t("notifyDone 本体は残っている", /function notifyDone\(errMsg, gate\)/.test(ps));
t("拡張が押す経路も残っている（clickSearch）", /notifyDone\(\);\s*\n\s*return true;/.test(ps) || /clickSearch/.test(ps));
t("構文が通る", (() => { try { new Function(ps.replace(/^import .*$/gm, "")); return true; } catch (e) { console.log("    構文: " + e.message); return false; } })());

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
