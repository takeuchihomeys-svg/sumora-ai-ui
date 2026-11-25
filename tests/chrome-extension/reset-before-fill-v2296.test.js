/**
 * 2.8.296 竹内さん「何で次のお客さんの条件入れる前にリセットおしていないのか」:
 *   条件を入れる前に「ページが空か」を読み、空でなければリセットを押す（_resetBeforeFill）。
 *   実測の穴（監査 #1654・#1656）: リセットは送付が終わった客の後だけ。前客が0件・時間切れ／一括の最初の客／裏が起き直した回は
 *   リセットの段が無く、ページ側の古い「1つずつ外す」で入力に入っていた。
 *
 *   ・配線（文字）: 一括ループで _waitInheritedReset の後・fill-done ウェイターの前に呼ぶ／点検が段を残す／手順書の決まり
 *   ・動作（本物の background.js を動かす）: すでに空→押さない／空でない→窓を張って押す／入力中→押さない／押せない→従来へ
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { loadBackground } = require(path.join(__dirname, "lib", "bg-load.js"));
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
const audit = fs.readFileSync(path.join(EXT, "search-audit.js"), "utf8");
const ps = fs.readFileSync(path.join(EXT, "page-script.js"), "utf8");
const rules = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "auto-procedure-rules.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 300) : "")); }
}

console.log("■ ① 配線（一括ループでの位置・点検・手順書）");
{
  const iInh = bg.indexOf("await _waitInheritedReset(_bulkAudit");
  const iRbf = bg.indexOf("await _resetBeforeFill(_bc");
  const iWaiter = bg.indexOf("var _bulkFillDone = (_bulkSite === \"realnetpro\"");
  const iAuto = bg.indexOf("await _batchAutofill(_bc, _bulkSite");
  ok("一括ループが条件を入れる前に _resetBeforeFill を呼ぶ", iRbf > 0);
  ok("  順番: 前回のリセット待ち → 入力前のリセット → fill-done ウェイター → 条件入力", iInh > 0 && iInh < iRbf && iRbf < iWaiter && iWaiter < iAuto, { iInh, iRbf, iWaiter, iAuto });
  ok("  リアプロの時だけ（ITANDI の回では押さない）", /if \(_bulkSite === "realnetpro"\) \{\s*await _waitInheritedReset[\s\S]{0,1800}await _resetBeforeFill\(_bc/.test(bg));
  ok("  世代が替わったら抜ける・ストップ要求で止まる", /await _resetBeforeFill\(_bc[\s\S]{0,400}_myGen !== _manualBulkGen[\s\S]{0,300}_batchShouldStop/.test(bg));
  ok("段の名前 pre_fill_reset（枠に出す日本語がある）", /pre_fill_reset: "条件を入れる前にリセットを押す"/.test(bg));
  ok("点検が reset_before_fill を残す（KEEP_STEP・RULE_STEP）", /KEEP_STEP = \/\^\([^\n]*\|customer_think\|reset_before_fill\|(?:(?:look_skip|server_behind|ext_behind)\|)*post_send_clear\|/.test(audit) && /RULE_STEP = \/\^\([^\n]*\|customer_think\|reset_before_fill\|(?:(?:look_skip|server_behind|ext_behind)\|)*post_send_clear\|/.test(audit));
  {
    // 文字ではなく動き: 実際の正規表現に段の名前を通す（落とされない・前後の名前に巻き込まれない）
    const keep = eval(audit.match(/var KEEP_STEP = (\/.*\/);/)[1]);
    const rule = eval(audit.match(/var RULE_STEP = (\/.*\/);/)[1]);
    ok("KEEP_STEP は reset_before_fill を通す（前後の reset_press・customer_think も従来どおり）", keep.test("reset_before_fill") && keep.test("customer_think") && keep.test("begin"));
    ok("RULE_STEP は reset_before_fill を通す", rule.test("reset_before_fill") && rule.test("reset_press") && rule.test("bulk_phase"));
    ok("似た名前（xreset_before_fill）は通さない", !keep.test("xreset_before_fill"));
  }
  ok("手順書の決まり reset_before_fill（since 2.8.296・印が無ければ検出）", /id: "reset_before_fill"[\s\S]{0,1200}since: "2\.8\.296"[\s\S]{0,300}mustHaveAny: \["reset_before_fill"\]/.test(rules));
  ok("ページ側の印の一覧にも入れた（_AXLX_RULES_DONE）", /"quiet_window_no_interrupt",\s*"reset_before_fill",/.test(ps));
  ok("入力の最中は押さない（_axFillRunning を先に読む）", /_resetBeforeFill[\s\S]{0,1500}window\._axFillRunning/.test(bg));
  ok("押す手順は送付後と同じ _postSendResetRealpro（30秒以上の待ち・空の確認を再利用）", /_resetBeforeFill[\s\S]{0,3500}await _postSendResetRealpro\(cid, runId\)/.test(bg));
}

function mk(probe, over) {
  const o = over || {};
  const steps = [];
  const press = { n: 0, quietAtPress: null };
  const tabs = {
    query: async () => (o.noTab ? [] : [{ id: 5, windowId: 1, index: 0, active: true, url: "https://www.realnetpro.com/main.php", title: "リアプロ" }]),
  };
  const scripting = { executeScript: async () => { if (o.probeThrows) throw new Error("tab_gone"); return [{ result: probe }]; } };
  const h = loadBackground({ chrome: { tabs, scripting }, storageLocal: o.off ? { axlx_reset_button_mode: false } : {} });
  h.ctx._auditStep = function (rid, k, d) { steps.push({ rid, k, d: String(d || "") }); };
  h.ctx._postSendResetRealpro = async function () {
    press.n++;
    press.quietAtPress = h.ctx._quiet ? h.ctx._quiet.kind : null;
    return o.pressResult || { ok: true, left: 0, reset: true };
  };
  return { h, steps, press, scripts: () => h.calls.filter((c) => c.api === "scripting.executeScript" || /executeScript/.test(c.api)) };
}
const stepOf = (steps) => steps.filter((s) => s.k === "reset_before_fill").map((s) => s.d);

(async () => {
  console.log("\n■ ② すでに空 → 押さない");
  {
    const t = mk({ ok: true, empty: true, verified: true, left: 0, ready: true });
    const r = await t.h.ctx._resetBeforeFill({ id: "c1111111-aaaa" }, "run1");
    ok("リセットを押さない", t.press.n === 0, t.press);
    ok("  結果は clean（ok:true）", r && r.ok === true && r.clean === true, r);
    ok("  点検に「すでに空」", stepOf(t.steps).some((d) => /すでに空/.test(d)), stepOf(t.steps));
    ok("  窓（quiet）を張っていない", t.h.ctx._quiet == null);
  }

  console.log("\n■ ③ 空でない → 窓を張ってリセット → 窓を外す");
  {
    const t = mk({ ok: true, empty: false, verified: false, left: 4, detail: "stations=3,layouts=1", ready: true });
    const r = await t.h.ctx._resetBeforeFill({ id: "c2222222-bbbb" }, "run2");
    ok("リセットを1回押す", t.press.n === 1, t.press);
    ok("  押している間は邪魔しない窓 reset が立っている", t.press.quietAtPress === "reset", t.press);
    ok("  終わったら窓を外す（残さない）", t.h.ctx._quiet == null, t.h.ctx._quiet);
    ok("  結果 ok", r && r.ok === true, r);
    const d = stepOf(t.steps);
    ok("  点検に「空でない（残=4 …）→リセットを押す」と「リセットで空を確認」", d.some((x) => /空でない（残=4/.test(x)) && d.some((x) => /リセットで空を確認/.test(x)), d);
    ok("  窓の印 quiet_on / quiet_off も残る", t.steps.some((s) => s.k === "quiet_on" && /^reset/.test(s.d)) && t.steps.some((s) => s.k === "quiet_off" && /pre_fill_done/.test(s.d)), t.steps.map((s) => s.k));
  }

  console.log("\n■ ④ 押せない・空にならない → 従来（ページ側の外し）に任せる");
  {
    const t = mk({ ok: true, empty: false, left: 2, detail: "wards=2" }, { pressResult: { ok: false, why: "reset_not_pressed:no_reset_button", notPressed: true } });
    const r = await t.h.ctx._resetBeforeFill({ id: "c3333333-cccc" }, "run3");
    ok("押そうとした（1回）", t.press.n === 1);
    ok("  失敗を返す（呼び出し側は止まらず入力へ進む）", r && r.ok === false, r);
    ok("  点検に「空にできず→…従来の外しへ（理由=…no_reset_button）」", stepOf(t.steps).some((d) => /空にできず[\s\S]*no_reset_button/.test(d)), stepOf(t.steps));
    ok("  窓は残さない", t.h.ctx._quiet == null);
  }

  console.log("\n■ ⑤ 入力の最中 → 押さない（入力が消える）");
  {
    const t = mk({ ok: false, busy: true, why: "fill_running" });
    const r = await t.h.ctx._resetBeforeFill({ id: "c4444444-dddd" }, "run4");
    ok("押さない", t.press.n === 0);
    ok("  skipped: fill_running", r && r.skipped === "fill_running", r);
  }

  console.log("\n■ ⑥ そのほか（タブ無し・機能オフ・読めない）");
  {
    const t = mk(null, { noTab: true });
    const r = await t.h.ctx._resetBeforeFill({ id: "c5" }, "run5");
    ok("リアプロのタブが無い → 見送り（押さない・読まない）", t.press.n === 0 && r && r.skipped === "no_tab", { r, n: t.press.n });
  }
  {
    const t = mk({ ok: true, empty: false }, { off: true });
    const r = await t.h.ctx._resetBeforeFill({ id: "c6" }, "run6");
    ok("リセットボタン機能がオフ → 見送り（従来の外し）", t.press.n === 0 && r && r.skipped === "off", { r, n: t.press.n });
  }
  {
    const t = mk(null, { probeThrows: true });
    const r = await t.h.ctx._resetBeforeFill({ id: "c7" }, "run7");
    ok("空かどうかが読めない（タブが落ちた等）→ 空と決めつけずリセットを試す", t.press.n === 1, t.press);
    ok("  投げない", r && typeof r === "object");
  }
  {
    const t = mk({ ok: true, empty: false }, { pressResult: { ok: true } });
    const r = await t.h.ctx._resetBeforeFill(null, null);
    ok("お客さん・記録が無くても落ちない", r && typeof r === "object", r);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("✗ 試験が落ちた: " + (e && e.stack || e)); process.exit(1); });
