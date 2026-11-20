// 2.8.143 録画（2026-11-20 17:53〜18:00・run mwoqsmy8_ib0b）で見つけた抜けの再発防止
//   ① audit #1552: 自動モード中に人が押した検索の回が6分で idle_close（bad）→ 区切りとして閉じる
//   ② audit #1551: 120段を超えると begin・fill_done・所在地の代替の理由（fallback_area）が先頭から落ちた
//   ③ audit #1551 P2: 「送る8件」で送った1件・押さずに飛ばした6件の理由が残らなかった
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("✓", name); }
  else { fail++; console.log("✗", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}

(async () => {
  const A = require(path.join(EXT, "search-audit.js"));

  console.log("■ ② 長い回でも始まり・終わり・代替の理由を落とさない");
  {
    const list = [];
    A.pushStep(list, "begin", "single", 1);
    A.pushStep(list, "page:fallback_area", "所在地モーダル失敗", 2);
    for (let i = 0; i < 300; i++) A.pushStep(list, "page:ward_pace", "x" + i, 10 + i);
    A.pushStep(list, "fill_done", "ok", 999);
    ok("上限は MAX_STEPS のまま", list.length === A.MAX_STEPS, list.length);
    ok("begin が残る", list.some((s) => s.k === "begin"));
    ok("fallback_area が残る", list.some((s) => s.k === "page:fallback_area"));
    ok("fill_done が残る", list.some((s) => s.k === "fill_done"));
    ok("最新の段も残る", list.some((s) => s.d === "x299"));
    ok("古い普通の段から落ちる", !list.some((s) => s.d === "x0"));
    const all = [];
    for (let i = 0; i < 200; i++) A.pushStep(all, "begin", String(i), i);
    ok("全部が残す段でも上限で止まる（先頭から落とす）", all.length === A.MAX_STEPS && all[0].d === String(200 - A.MAX_STEPS));
    ok("残す段: area_all_done・modal_confirm_fallback", A.KEEP_STEP.test("page:area_all_done") && A.KEEP_STEP.test("page:modal_confirm_fallback_x"));
    ok("普通の段は残す段ではない", !A.KEEP_STEP.test("page:ward_pace") && !A.KEEP_STEP.test("dl:acq_sent_marked"));
  }

  console.log("■ ① 人が押した検索の回");
  {
    ok("human_ の run_id は人の検索", A.isHumanSearchAudit(null, "human_mwoqso2v"));
    ok("合図の印（no_run_id・local_run_id human_）でも分かる", A.isHumanSearchAudit({ no_run_id: true, local_run_id: "human_abc" }, "local_x"));
    ok("自動の回は人の検索ではない", !A.isHumanSearchAudit({ no_run_id: false, local_run_id: "human_abc" }, "sa_x") && !A.isHumanSearchAudit(null, "sa_mwoqua6u"));

    const idle = { error: "idle_close: …", error_kind: "idle_close" };
    const s1 = A.softenIdleClose({ human_search: true }, idle);
    ok("人の検索で誤り無し → 区切り（error 無し）", s1.soft === true && !s1.extra.error && !s1.extra.error_kind && /区切り/.test(s1.note));
    ok("人の検索でも入力の誤りがあれば idle_close のまま", A.softenIdleClose({ human_search: true, fill_error: "x" }, idle).soft === false);
    ok("自動の回は idle_close のまま", A.softenIdleClose({ human_search: false }, idle).extra.error_kind === "idle_close");
    ok("idle_close 以外は触らない", A.softenIdleClose({ human_search: true }, { error: "e" }).extra.error === "e");

    const posts = [];
    let clock = 1000;
    const T = A.createTracker({ post: (b) => { posts.push(b); return Promise.resolve({ ok: true }); }, now: () => clock++ });
    const h = T.begin({ run_id: "human_aa", site: "realpro", customer_id: "c1", trigger: "local", post_started: false });
    T.attachFill(h.run_id, { audit: { v: 1, no_run_id: true, local_run_id: "human_aa", steps: [{ k: "human_search", at: 1 }] } });
    ok("attachFill で人の検索の印が付く", T.get("human_aa").human_search === true);
    const a = T.begin({ run_id: "sa_bb", site: "realpro", customer_id: "c1", trigger: "single", post_started: false });
    T.attachFill(a.run_id, { audit: { v: 1, steps: [] } });
    ok("自動の回には付かない", !T.get("sa_bb").human_search);
    ok("同じサイトで開いた人の検索の回を返す（自分は除く）", JSON.stringify(T.openHumanSearchRuns("realnetpro", "sa_bb")) === '["human_aa"]');
    ok("別のサイトでは返さない", T.openHumanSearchRuns("itandi", "sa_bb").length === 0);
    await T.finish("human_aa", {});
    ok("閉じた回は返さない", T.openHumanSearchRuns("realpro", "sa_bb").length === 0);
  }

  console.log("■ ① 配線（background）");
  {
    const bg = read("background.js");
    const fin = bg.slice(bg.indexOf("function _auditFinish("), bg.indexOf("function _auditFinish(") + 900);
    ok("_auditFinish が softenIdleClose を通す", /softenIdleClose\(_auditTracker\.get\(runId\), x\)/.test(fin));
    ok("区切りの時は段 human_search_idle を残す", /_auditTracker\.step\(runId, "human_search_idle", _sf\.note\)/.test(fin));
    ok("次の回で閉じる関数がある", /function _auditCloseHumanSearchRuns\(site, exceptRid\)/.test(bg));
    ok("_auditBegin で閉じる", /if \(run\) _auditCloseHumanSearchRuns\(run\.site, run\.run_id\);/.test(bg));
    ok("fill 進捗で閉じる（人の検索の回自身は除く）", /if \(run && !run\.human_search\) _auditCloseHumanSearchRuns\(run\.site, _rid\);/.test(bg));
    ok("fill-done で閉じる（人の検索の回自身は除く）", /attachFill\(_rid, \{ audit: msg\.audit \|\| null, error: _pageErr \}\);\s*\n\s*if \(!run\.human_search\) _auditCloseHumanSearchRuns\(run\.site, _rid\);/.test(bg));
    ok("6分の閉じ処理の2か所は今まで通り idle_close の印", (bg.match(/_auditFinish\(_rid, AUDIT_IDLE_CLOSE_EXTRA\(\)\)/g) || []).length === 2);
  }

  console.log("■ ② page-script の間引き保護");
  {
    const ps = read("page-script.js");
    const pin = (ps.match(/var _PIN = \/\^\(([^\n]*)\)\//) || [])[1] || "";
    ok("_PIN に fallback_ と area_all_done", /\|fallback_\|area_all_done$/.test(pin), pin.slice(-60));
  }

  console.log("■ ③ bulk-dl: 押す途中で飛ばした理由を数える");
  {
    const bd = read("bulk-dl.js");
    ok("_tallySkip がある", /function _tallySkip\(why\)/.test(bd));
    ok("_skipToNext が数える", /_autoPdfRun\.skipped = \(Number\(_autoPdfRun\.skipped\) \|\| 0\) \+ 1;\s*\n\s*_tallySkip\(why\);/.test(bd));
    ok("押した直後に送付済みも数える", /_tallySkip\("押した直後に送付済み"\)/.test(bd));
    ok("押せなかった時も数える", /_tallySkip\("押せず"\)/.test(bd));
    ok("auto_pdf_end に理由を載せる", /_tmark\("auto_pdf_end", [^\n]*\+ whyText\);/.test(bd));
    ok("_autoPdfRun を消す前に理由を取る", /var whyText = _skipWhyText\(_autoPdfRun\);\s*\n\s*_autoPdfRun = null;/.test(bd));
    // 純粋な部分を動かして形を確かめる
    const a = bd.indexOf("function _tallySkip(why)");
    const b = bd.indexOf("function _autoPressNext(list)");
    const vm = require("vm");
    const ctx = { _autoPdfRun: { skipped: 0 } };
    vm.createContext(ctx);
    vm.runInContext(bd.slice(a, b), ctx);
    ctx._tallySkip("送付済み"); ctx._tallySkip("送付済み"); ctx._tallySkip("最安除外");
    const t = ctx._skipWhyText(ctx._autoPdfRun);
    ok("理由×回数の文になる", t === "／途中で飛ばした理由: 送付済み×2・最安除外×1", t);
    ok("飛ばしが無ければ空", ctx._skipWhyText({}) === "" && ctx._skipWhyText(null) === "");
  }

  console.log("■ 版");
  {
    const m = JSON.parse(read("manifest.json"));
    const ps = read("page-script.js");
    const rules = fs.readFileSync(path.join(__dirname, "../../app/lib/auto-procedure-rules.ts"), "utf8");
    ok("manifest 2.8.143 以上", m.version.split(".").map(Number).reduce((x, n) => x * 1000 + n, 0) >= 2008143, m.version);
    ok("page-script の版が manifest と同じ", ps.includes('var _AXLX_PAGE_VER = "' + m.version + '"'));
    ok("手順書の決まり audit_keep_reason が拡張にもある", /id: "audit_keep_reason"/.test(rules) && /"audit_keep_reason"/.test(ps));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
