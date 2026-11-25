/**
 * 2.8.293 竹内さん「検索結果表示した後時間差で並べ替えするはずが並べ替えされずに物件取得にはいってしまった
 *   並べ替えの部分がなぜかデータかき消されて抜けていた可能性が高い　原因みつけて改善する」（2026-11-25 18:11）
 *   DB 実測: 点検 #1651（18:05:54 一括・てんさん・2.8.292）は開始の5段で started のまま。
 *     操作の記録は 18:10:10〜18:18:22 に印刷用PDFと「左の次」だけで、並べ替え（高→低）のクリックが1つも無い。
 *   ① 点検の回が裏のメモリにだけあり、起き直しで消えて後の段が全部捨てられていた → 書き出して戻す
 *   ② 並べ替えの30秒待ちの間に、一覧の描き直しから押し始められた → 待ちの間は押さない
 *   ③ 並べ替えに失敗すると即（見出しが見えない時）並びのまま押していた → 30〜36秒待って最初からもう1回
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const bd = rd("chrome-extension/bulk-dl.js");
const bg = rd("chrome-extension/background.js");
const ps = rd("chrome-extension/page-script.js");
const sa = rd("chrome-extension/search-audit.js");
const rules = rd("app/lib/auto-procedure-rules.ts");
const man = JSON.parse(rd("chrome-extension/manifest.json"));
const A = require(path.join(root, "chrome-extension/search-audit.js"));

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 220))); } }
function fnSrc(src, header, indent) {
  const i = src.indexOf(header);
  if (i < 0) return "";
  const s = src.slice(i);
  const e = s.indexOf("\n" + (indent || "  ") + "}\n");
  return e < 0 ? s : s.slice(0, e + 3 + (indent || "  ").length);
}

console.log("\n■ 版");
const pageVer = (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1];
const rulesVer = (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1];
ok("manifest = page = rules", man.version === pageVer && rulesVer === man.version, [man.version, pageVer, rulesVer]);
ok("版は 2.8.293 以上", man.version.split(".").map(Number)[2] >= 293, man.version);

console.log("\n■ ① 点検の回を書き出して戻す（裏の起き直しで消さない）");
{
  let t = 1_000_000;
  const sent = [];
  const tr1 = A.createTracker({ post: (b) => { sent.push(b); return Promise.resolve({ ok: true }); }, now: () => t });
  const run = tr1.begin({ site: "realpro", customer_id: "c-1", trigger: "bulk_manual", mode: "brain_aix" });
  tr1.step(run.run_id, "bulk_pos", "1/2");
  const done = tr1.begin({ site: "realpro", customer_id: "c-2", trigger: "bulk_manual" });
  tr1.finish(done.run_id, {});
  const saved = tr1.exportOpen();
  ok("開いている回だけ書き出す", saved.length === 1 && saved[0].run_id === run.run_id, saved.map((r) => r.run_id));
  ok("段も一緒に書き出す", saved[0].steps.some((s) => s.k === "bulk_pos"));
  ok("書き出しは JSON にできる（約束・タイマーを持たない）", (() => { try { JSON.stringify(saved); return true; } catch (_) { return false; } })());

  t += 5 * 60 * 1000;
  const tr2 = A.createTracker({ post: () => Promise.resolve({ ok: true }), now: () => t });
  const back = tr2.adopt(JSON.parse(JSON.stringify(saved[0])));
  ok("起き直した裏に戻せる", !!back && back.run_id === run.run_id);
  ok("お客さん・サイトで探せる（ページからの段が届く先になる）", tr2.findOpen("c-1", "realpro") && tr2.findOpen("c-1", "realpro").run_id === run.run_id);
  tr2.step(run.run_id, "dl:sort_menu", "start");
  ok("戻した回に後の段が足せる", tr2.get(run.run_id).steps.some((s) => s.k === "dl:sort_menu"));
  ok("同じ回は二重に戻さない", tr2.adopt(saved[0]) === null);
  const tr3 = A.createTracker({ post: () => Promise.resolve({ ok: true }), now: () => t + 61 * 60 * 1000 });
  ok("1時間を過ぎた回は戻さない", tr3.adopt(saved[0]) === null);
  ok("壊れた値は戻さない", tr3.adopt(null) === null && tr3.adopt({}) === null && tr3.adopt("x") === null);
}
ok("戻した印・並べ替えの読み直し印は削られない段（KEEP_STEP）", A.KEEP_STEP.test("sw_restart_restored") && A.KEEP_STEP.test("dl:ad_sort_reload") && A.KEEP_STEP.test("dl:sort_failed_wait_retry"));

const wrapIdx = bg.indexOf("function _auditWrapForPersist()");
const trackerIdx = bg.indexOf("var _auditTracker = (self.AxlxSearchAudit");
ok("裏: 回を作った直後に包む", trackerIdx > 0 && wrapIdx > trackerIdx);
const wrapSrc = bg.slice(wrapIdx, wrapIdx + 600);
["begin", "step", "attachFill", "attachProgress", "attachResult", "finish"].forEach((n) => {
  ok("裏: " + n + " の後に書き出す", wrapSrc.includes('"' + n + '"'));
});
ok("裏: chrome.storage.session に書く", /AUDIT_OPEN_RUNS_KEY\] = \{ at: Date\.now\(\), runs: _auditTracker\.exportOpen\(\) \}[\s\S]{0,80}chrome\.storage\.session\.set/.test(bg));
ok("裏: 起動時に戻して印を残す", /chrome\.storage\.session\.get\(\[AUDIT_OPEN_RUNS_KEY\][\s\S]{0,400}_auditTracker\.adopt\(saved\)[\s\S]{0,200}sw_restart_restored/.test(bg));

console.log("\n■ ② 並べ替えの待ちの間は、一覧の描き直しから押し始めない");
const loadFn = fnSrc(bd, "  function _maybeAutoPressOnLoad(");
const gIdx = loadFn.indexOf("var _sortOwnSince");
const sigIdx = loadFn.indexOf("var sig = tracked.map");
const lookIdx = loadFn.indexOf("_startAutoPressAfterLook(");
ok("待ちの確かめが見る間→押す道より前", gIdx > 0 && gIdx < sigIdx && sigIdx < lookIdx, [gIdx, sigIdx, lookIdx]);
ok("並べ替えの待ち・失敗後の待ち直しの両方を見る", /_sortWaitRetryPending \? _sortWaitRetryAt : \(_sortCursorScheduled \? _sortCursorScheduledAt : 0\)/.test(loadFn));
ok("固まっても永久に止めない（上限あり）", /Date\.now\(\) - _sortOwnSince < SORT_WAIT_OWN_MAX_MS/.test(loadFn) && /var SORT_WAIT_OWN_MAX_MS = (\d+);/.test(bd) && Number(bd.match(/var SORT_WAIT_OWN_MAX_MS = (\d+);/)[1]) >= 60000);
ok("待ちを入れた時刻を残す", /_sortCursorScheduled = true;\n\s*_sortCursorScheduledAt = Date\.now\(\);/.test(bd));
ok("afterSearch の道（並べ替えの番）は止めない", loadFn.indexOf("if (opt && opt.afterSearch) {") < gIdx);

console.log("\n■ ③ 並べ替えに失敗 → 30〜36秒待ってもう1回 → それでも駄目なら警告して続ける（11-14 の決定）");
const autoFn = fnSrc(bd, "  function autoPressPdfs(opt) {");
const retryFn = fnSrc(autoFn, "    function _sortFailWaitThenRetry(where) {", "    ");
ok("待ち直しの関数がある", retryFn.length > 100);
ok("待ちは人の間（検索後と同じ 30〜36秒）", /var waitMs = _humanWaitAfterSearchMs\(\);/.test(retryFn));
ok("回数に上限（1回）", /var SORT_FAIL_WAIT_RETRY_MAX = 1;/.test(bd) && /_sortFailWaitRetries >= SORT_FAIL_WAIT_RETRY_MAX\) return false/.test(retryFn));
ok("条件画面・入力中は待ち直さない", /if \(_isFillBusy\(\) \|\| _isCondModalLabelsOpen\(\)\) return false;/.test(retryFn));
ok("待った後に条件画面へ戻っていたら何もしない", /_sortGen !== genAt \|\| _isFillBusy\(\) \|\| _isCondModalLabelsOpen\(\)[\s\S]{0,120}sort_abort/.test(retryFn));
ok("待った後は並べ替えを最初から", /_beginAdSortLikeHuman\(\);\n\s*\}, waitMs\);/.test(retryFn));
ok("点検に残す（dl:sort_failed_wait_retry）", /_liveDlStep\("sort_failed_wait_retry"/.test(retryFn));
ok("画面にも出す", /_nudge\("⏳ 並べ替えがまだ出来ません/.test(retryFn));
const noHead = autoFn.indexOf('_sortFailWaitThenRetry("no_head")');
const contNoHead = autoFn.indexOf('_liveDlStep("sort_failed", "continue");');
ok("見出しが見えない失敗: 並びのまま押す前に待ち直す", noHead > 0 && noHead < contNoHead, [noHead, contNoHead]);
const quick = autoFn.indexOf('_sortFailWaitThenRetry("after_quick_retry")');
const contQuick = autoFn.indexOf('_liveDlStep("sort_failed", "continue_after_retry");');
ok("1.6秒の試し直しも駄目: 並びのまま押す前に待ち直す", quick > 0 && quick < contQuick, [quick, contQuick]);
ok("11-14 の決定: 待ち直しても駄目なら並びのまま続ける（止めない）", contQuick > 0 && contNoHead > 0 && /並べ替えできませんでした（この並びのまま続けます）/.test(autoFn));
ok("待ち直しの間は二重に始めない（autoPressPdfs の入口）", autoFn.indexOf("if (_sortWaitRetryPending && Date.now() - _sortWaitRetryAt < SORT_WAIT_OWN_MAX_MS)") > 0
  && autoFn.indexOf("if (_sortWaitRetryPending") < autoFn.indexOf("_pressRunSince = "));
const abortFn = fnSrc(bd, "  function _abortAdSort(why) {");
ok("条件入力・停止（_abortAdSort）で待ち直しを解く", /_sortFailWaitRetries = 0;/.test(abortFn) && /_sortWaitRetryPending = false;/.test(abortFn));

console.log("\n■ 読み直し直後に並べ替えを飛ばす所の記録");
ok("高→低になっていたかを点検に残す", /_liveDlStep\("ad_sort_reload", _adUrl \? "ad_url" : "no_ad_url"\);\n\s*\} catch \(_\) \{\}\n\s*_adSortDone = true;/.test(loadFn));

console.log("\n■ 手順書");
ok("決まりの文に待ち直しを書いた", rules.includes("sort_failed_wait_retry") && rules.includes("wait_sort_cursor"));
ok("30秒の待ちは変えていない", /var SORT_AFTER_SEARCH_MIN_MS = 30000;/.test(bd));

console.log("\n" + (fail ? "NG" : "OK") + "  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
