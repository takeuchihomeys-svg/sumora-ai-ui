/**
 * 2.8.294 竹内さん「リセット押すのも拡張りかいしていない／拡張の自動モードちゃんと反映されているのか／
 *   ここの部分ちょうさしてちゃんと拡張ツール側が把握するように／新しく改善された動きちゃんと把握して／
 *   昔ののこっているのとりのぞくようにする」（2026-11-25 18:26）
 *   DB 実測: #1653（18:19:36・一括 2/2 再開）は begin→bulk_pos→bulk_phase→tab_reload「拡張の中身が応答しない」で止まり、
 *   その後の段・操作は0件。拡張の読み直しでページの古い中身が裏と話せないまま残っていた。
 *   人の「リセット」の押下を拡張が見る仕組みは無かった。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const bd = rd("chrome-extension/bulk-dl.js");
const bg = rd("chrome-extension/background.js");
const ps = rd("chrome-extension/page-script.js");
const rules = rd("app/lib/auto-procedure-rules.ts");
const man = JSON.parse(rd("chrome-extension/manifest.json"));
const A = require(path.join(root, "chrome-extension/search-audit.js"));

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function fnSrc(src, header, indent) {
  const ind = indent == null ? "  " : indent;
  const i = src.indexOf(header);
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n" + ind + "}\n");
  return e < 0 ? s : s.slice(0, e + 2 + ind.length + 1);
}

console.log("\n■ 版");
const pageVer = (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1];
const rulesVer = (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1];
ok("manifest = page = rules", man.version === pageVer && rulesVer === man.version, [man.version, pageVer, rulesVer]);
ok("版は 2.8.294 以上", man.version.split(".").map(Number)[2] >= 294, man.version);

console.log("\n■ 人のリセットの見分け（ページ）");
const targetFn = fnSrc(bd, "  function _humanResetTarget(el) {");
ok("見分けの関数がある", targetFn.length > 50);
const ctx = {};
vm.createContext(ctx);
vm.runInContext(targetFn + "\nthis._humanResetTarget = _humanResetTarget;", ctx);
const mk = (o) => Object.assign({ nodeType: 1, id: "", className: "", children: [], textContent: "", parentElement: null }, o);
const leaf = mk({ textContent: " リセット " });
ok("文字が「リセット」だけの葉を拾う", (ctx._humanResetTarget(leaf) || {}).via === "text");
const cls = mk({ className: "reset_button big", children: [{}], textContent: "リセット" });
const inner = mk({ textContent: "", children: [{}], parentElement: cls });
ok("reset_button の中の子を押しても拾う", (ctx._humanResetTarget(inner) || {}).via === "class");
const bar = mk({ id: "axlx-bar", children: [{}] });
const stopBtn = mk({ textContent: "リセット", parentElement: bar });
ok("拡張の枠の中は人のリセットにしない", ctx._humanResetTarget(stopBtn) === null);
const barStop = mk({ textContent: "⏹ 止めてリセット", parentElement: bar });
ok("「⏹ 止めてリセット」は拾わない", ctx._humanResetTarget(barStop) === null);
ok("他の文字は拾わない", ctx._humanResetTarget(mk({ textContent: "検索" })) === null);
ok("null でも落ちない", ctx._humanResetTarget(null) === null);

const listen = bd.slice(bd.indexOf('document.addEventListener("click", function (ev) {\n    try {\n      if (!ev || !ev.isTrusted'), bd.indexOf('document.addEventListener("click", function (ev) {\n    try {\n      if (!ev || !ev.isTrusted') + 500);
ok("人の押下だけ（isTrusted・拡張の押下は合成で false）", /if \(!ev \|\| !ev\.isTrusted \|\| _orphaned\) return;/.test(listen));
ok("左の検索欄だけ（画面の左45%）", /r\.left > \(window\.innerWidth \|\| 1200\) \* 0\.45\) return;/.test(listen));
ok("押す前に捕まえる（capture）", /\}, true\);/.test(listen));

const onReset = fnSrc(bd, "  function _onHumanReset(via) {");
ok("この画面の自動を止める", /_quietLocalStop\("human_reset"\)/.test(onReset));
ok("検索済みの印を消す（リセット後の全物件の一覧を押さない）", /axlx_search_grasped/.test(onReset) && /sessionStorage\.removeItem\(AUTO_SEND_KEY\)/.test(onReset) && /axlx_search_grasped_sync/.test(onReset));
ok("裏へ知らせる（axlx-human-reset）", /type: "axlx-human-reset"/.test(onReset));
ok("枠に出す", /人がリセットを押した/.test(onReset));
const quiet = fnSrc(bd, "  function _quietLocalStop(why) {");
ok("止める中身: 押す・見る待ち・送る列・並べ替え・検索の合図", ["_autoPdfRun.stopped = true", "_lookWait.skip", "_pdfQueue = []", "_abortAdSort", "clearTimeout(_sortCursorTimer)", "_autoSendArmed = false"].every((s) => quiet.includes(s)));
ok("止める時は裏へ送らない・読み直さない", !/sendMessage|location\.reload/.test(quiet));

console.log("\n■ 人のリセット（裏）");
ok("裏が受けて点検に human_reset_press を残す", /msg\.type === "axlx-human-reset"[\s\S]{0,900}_auditStep\(_hrRid, "human_reset_press"/.test(bg));
ok("起き直しても分かる（storage.session）", /axlx_human_reset_at: _hrAt/.test(bg) && /chrome\.storage\.session\.get\("axlx_human_reset_at"\)/.test(bg));
const waitFn = fnSrc(bg, "async function _waitAfterHumanReset(runId) {", "");
ok("待ちは 2.8.292 のリセット後と同じ30秒以上", /var need = RESET_SETTLE_MIN_MS - el \+ Math\.floor\(Math\.random\(\) \* RESET_SETTLE_JITTER_MS\);/.test(waitFn) && /var RESET_SETTLE_MIN_MS = 30000;/.test(bg));
ok("30秒を過ぎていれば待たない", /if \(el < 0 \|\| el >= RESET_SETTLE_MIN_MS\) return 0;/.test(waitFn));
ok("待ちの間は段を張る（見張りが止まったと見ない）", /_bulkPhaseSet\("human_reset_wait"/.test(waitFn));
// 実際に待つ長さ
{
  const c2 = { Date, Math, chrome: { storage: { session: { get: async () => ({}) } } }, _auditStep() {}, _bulkPhaseSet() {}, _manualBulkAlive: false, RESET_SETTLE_MIN_MS: 30000, RESET_SETTLE_JITTER_MS: 4000, _humanResetAt: 0, setTimeout: (f) => f(), out: [] };
  vm.createContext(c2);
  vm.runInContext(waitFn + "\nthis.w = _waitAfterHumanReset;", c2);
  c2._humanResetAt = Date.now() - 10000;
  c2.w(null).then((ms) => { ok("リセットから10秒 → あと約20〜24秒待つ", ms >= 19900 && ms <= 24100, ms); });
  c2._humanResetAt = Date.now() - 40000;
  c2.w(null).then((ms) => { ok("リセットから40秒 → 待たない", ms === 0, ms); });
}
const loopWait = bg.indexOf("await _waitAfterHumanReset(_bulkAudit ? _bulkAudit.runId : null);");
const loopWaiter = bg.indexOf("// fill-done ウェイターを autofill 発火「前」に生成");
const loopFill = bg.indexOf('_bulkPhaseSet("autofill", 300000, { runId: _bulkPhaseRunId });');
ok("一括: 次の条件入力の前に待つ（fill-done の待ち手より前）", loopWait > 0 && loopWait < loopWaiter && loopWaiter < loopFill, [loopWait, loopWaiter, loopFill]);
ok("一括: 待ちの間に新しいループになれば抜ける", /await _waitAfterHumanReset\(_bulkAudit \? _bulkAudit\.runId : null\);\n\s*if \(_myGen !== _manualBulkGen\)/.test(bg));
ok("入れ直しの道も待つ", /await _waitAfterHumanReset\(runId\);\n\s*if \(_batchShouldStop\) throw new Error\("__BATCH_STOPPED__"\);\n\s*var fillDoneP2/.test(bg));

console.log("\n■ 古い中身を取り除く");
const orphanFn = fnSrc(bd, "  function _becomeOrphan(why) {");
ok("裏とつながっていない＝chrome.runtime.id が無い", /chrome\.runtime && chrome\.runtime\.id/.test(fnSrc(bd, "  function _extAlive() {")));
ok("2秒ごとに確かめる", /setInterval\(function \(\) \{ if \(!_orphaned && !_extAlive\(\)\) _becomeOrphan\("runtime_gone"\); \}, 2000\);/.test(bd));
ok("古い中身: 自動を止める", /_quietLocalStop\("orphan"\)/.test(orphanFn) && /_autoModeOn = false/.test(orphanFn));
ok("古い中身: 古い枠（旧の版）を消す", /getElementById\("axlx-bar"\)[\s\S]{0,40}\.remove\(\)/.test(orphanFn));
ok("古い中身: 読み直しの案内を出す", /ページを読み直す/.test(orphanFn));
ok("古い中身は枠を作り直さない", /function ensureBar\(\) \{\n\s*if \(_orphaned\) return;/.test(bd));
const inst = fnSrc(bg, "async function _reloadOrphanTabsOnInstall(details) {", "");
ok("読み直し・入れ直しの時だけ（Chrome の更新では触らない）", /if \(reason !== "update" && reason !== "install"\) return;/.test(inst));
ok("答えるタブは触らない・答えないタブだけ読み直す", /if \(!p \|\| p\.pong \|\| p\.gone\) continue;/.test(inst) && /chrome\.tabs\.reload\(t\.id\)/.test(inst));
ok("リアプロは main.php のタブだけ・ITANDI も", /realnetpro\.com\/main\.php\*/.test(inst) && /itandibb\.com\/\*/.test(inst));
ok("読み直しに登録", /chrome\.runtime\.onInstalled\.addListener\(_reloadOrphanTabsOnInstall\);/.test(bg));

console.log("\n■ 記録・手順書");
ok("human_reset の段は削られない・決まりの段", A.KEEP_STEP.test("human_reset_press") && A.KEEP_STEP.test("human_reset_wait") && A.RULE_STEP.test("human_reset_press"));
ok("手順書に人のリセットを書いた", rules.includes("human_reset_press") && rules.includes("2.8.294"));

setTimeout(() => {
  console.log("\n" + (fail ? "NG" : "OK") + "  " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}, 50);
