// 実行: node tests/chrome-extension/learn-refresh-heal-v2814.test.js
// v2.8.114 タクヤ audit #1513「learn_warm screen=0」:
//   本番（main）の版確認は screen_solid を返さないため、手元の画面位置が空でも「版が同じ」で取り直さなかった。
//   強制の取り直しも、実行中の通常確認（何もしない）に吸収されていた。取り直しの結果も実行記録に残っていなかった。
//   あわせて同じお客様の開始が4秒差で2回来て、2本目の行（#1514）が steps 0 の started で残った。
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "../../chrome-extension");
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");
const ct = fs.readFileSync(path.join(root, "content.js"), "utf8");
const pp = fs.readFileSync(path.join(root, "popup.js"), "utf8");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, c, detail) {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail !== undefined ? "  " + JSON.stringify(detail) : "")); }
}
function fnSrc(src, head) {
  const i = src.indexOf(head);
  if (i < 0) return "";
  const m = /\r?\n\}\r?\n/.exec(src.slice(i));
  return m ? src.slice(i, i + m.index + m[0].length) : "";
}

(async function () {
  console.log("\n■ 強制の取り直しが実行中の確認に吸収されない");
  // 2.8.313: 引数が (force, targetSite, _noChain) に増えた（サイト別の取り直し）。頭は引数の並びに依存しない形で取る
  const q = fnSrc(bg, "function _refreshLearnedBundleQueued(");
  ok("関数が取れる", q.length > 200);
  const mk = new Function("stub", `
    var _learnInflight = null, _learnFailCount = 0, _learnNextTryAt = 0, _pendingRefreshTargetSite = null;
    function _normLearnSite(s) { return s || null; }
    var calls = [];
    function _learnBackoffMs() { return 60000; }
    function _refreshLearnedBundle(force) { calls.push(force); return Promise.resolve(stub(force, calls.length)); }
    ${q}
    return { run: _refreshLearnedBundleQueued, calls: calls, setInflight: function (p) { _learnInflight = p; } };
  `);
  // 実行中の通常確認が「版が同じ」で何もしなかった → 強制をもう1回だけ
  let h = mk(function (force) { return force ? { ok: true, screen_solid: 878 } : { ok: true, skipped: "same_version" }; });
  const first = h.run(false);
  const r1 = await h.run(true);
  await first;
  ok("通常確認が何もしなかった後に強制でもう1回取る", h.calls.length === 2 && h.calls[1] === true, h.calls);
  ok("強制の結果が返る", r1 && r1.screen_solid === 878, r1);
  // backoff 中は重ねない
  h = mk(function () { return { ok: true, skipped: "backoff" }; });
  const f2 = h.run(false);
  const r2 = await h.run(true);
  await f2;
  ok("backoff 中は重ねて取らない", h.calls.length === 1 && r2 && r2.skipped === "backoff", h.calls);
  // 実行中が取り込んでいれば重ねない
  h = mk(function () { return { ok: true, screen_solid: 10 } ; });
  const f3 = h.run(false);
  await h.run(true);
  await f3;
  ok("実行中が取り込み済みなら重ねない", h.calls.length === 1, h.calls);
  // 通常同士は重ねない（従来どおり）
  h = mk(function () { return { ok: true, skipped: "same_version" }; });
  const f4 = h.run(false);
  await h.run(false);
  await f4;
  ok("通常同士は1回だけ", h.calls.length === 1, h.calls);

  console.log("\n■ 本番が screen_solid を返さなくても、手元の画面位置が空なら取り直す");
  // 2.8.313: 印がサイト別（axlx_learn_empty_refetch_at__<site>）に増えた（旧の共通の印も互換で残る）。10分に1回は同じ
  ok("solid 不明でも空なら取り直す分岐がある", /else if \(_localScreenN === 0 && Date\.now\(\) - _emptyRefetchAt > 10 \* 60 \* 1000\)/.test(bg) && /var _emptyRefetchAt = Number\(\(st && st\[_emptyRefetchKey\]\) \|\| \(st && st\.axlx_learn_empty_refetch_at\)\) \|\| 0;/.test(bg));
  ok("10分に1回の印を残す", /var _erPatch = \{ axlx_learn_empty_refetch_at: Date\.now\(\) \};\s*\n\s*_erPatch\[_emptyRefetchKey\] = Date\.now\(\);\s*\n\s*await chrome\.storage\.local\.set\(_erPatch\)/.test(bg));
  ok("印を storage から読む", /"axlx_learn_empty_refetch_at",\s*\n\s*"axlx_learn_empty_refetch_at__realpro",\s*\n\s*"axlx_learn_empty_refetch_at__itandi",/.test(bg));

  console.log("\n■ 取り直しの結果がページまで届き、実行記録に残る");
  ok("content.js が結果を渡す", /from: "axlx-page-learn-refresh-done", id: rid, res: slim/.test(ct));
  ok("content.js は鍵などを渡さず数と状態だけ", /screen_solid: typeof res\.screen_solid === "number"/.test(ct) && !/res\.bundle/.test(ct.slice(ct.indexOf("var slim = null;"), ct.indexOf("var slim = null;") + 1200)));
  ok("ページは結果で resolve する", /fin\(e\.data\.res \|\| null\);/.test(ps) && /setTimeout\(function \(\) \{ fin\("timeout"\); \}, 8000\);/.test(ps));
  ok("warmLocal が learn_refresh_res を残す", /_auditStepP\("learn_refresh_res"/.test(ps));
  ok("後から届いた画面位置を残す", /_auditStepP\("learn_screen_late"/.test(ps));
  const pinLine = (ps.match(/var _PIN = \/\^\(([^\n]*)\)\//) || [])[1] || "";
  const pinKeys = pinLine.split("|");
  ok("新しい段は間引かない（_PIN）", ["learn_refresh_res", "learn_screen_late", "stale_pending_reset", "station_line_wait"].every((k) => pinKeys.includes(k)), pinKeys.slice(-6));

  console.log("\n■ 同じお客様の開始が続けて来ても行を2本にしない");
  const tag = fnSrc(pp, "function _auditTag(site, customer, conditions, ctx)");
  ok("15秒以内の同じお客様・サイトは前の run_id", /_nowTag - _lastAuditTag\.at < 15000/.test(tag) && /conditions\._audit_run_id = _lastAuditTag\.runId;/.test(tag));
  ok("使い回しの時は started を送らない（先に return）", tag.indexOf("return conditions;", tag.indexOf("_lastAuditTag.runId")) < tag.indexOf("A.post("));
  ok("ピンポイントと広げては別の回", /\(conditions\.is_wide \? "w" : "p"\)/.test(tag));
  ok("一括の run_id（ctx）は使い回さない", /if \(!\(ctx && ctx\.runId\) && _lastAuditTag/.test(tag));

  console.log("\n■ 版");
  // 2.8.313: 版の固定（=== 2.8.119）をやめ「2.8.114 以上」を見る（版は上がり続けるため。この試験の版は 2.8.114）
  const verNum = (s) => String(s).split(".").map(Number).reduce((a, n) => a * 1000 + n, 0);
  const pv = (ps.match(/var _AXLX_PAGE_VER = "([\d.]+)";/) || [])[1];
  ok("manifest が 2.8.114 以上", verNum(mf.version) >= verNum("2.8.114"), mf.version);
  ok("_AXLX_PAGE_VER が 2.8.114 以上", !!pv && verNum(pv) >= verNum("2.8.114"), pv);

  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail) process.exit(1);
})();
