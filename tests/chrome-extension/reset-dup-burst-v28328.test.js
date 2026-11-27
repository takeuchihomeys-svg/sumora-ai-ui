/**
 * 2.8.328 竹内さん「裏が起き直した後の入力前リセットが二重になる／同じ秒に同じ段（bulk_phase）が重複して記録される ここも順に改善する」
 *   実測 #1666（2.8.318）・#1671（2.8.320）: 一括の段 pre_fill_reset が 29回・58回（その回が自分で押した入力前リセットは1回）。
 *   元: popup.js の自動入力ボタンが先頭で学びの取り直しを await してから「自動の押しか」（dataset.automated）を読んでいた。
 *       押す側（_switchAndClick）は click() の直後に印を消すので、自動の押しを手押しと読み違え、
 *       番号なしの入力前リセット（axlx-reset-before-fill）を裏へ何本も頼んでいた。
 *   ・ポップアップ: 印・点検の文脈・更新日の欄は最初の await より前に読む（リアプロ・ITANDI）
 *   ・裏: 入力前リセットは同時に1本だけ（走っている1本の結果を受け取る）／一括の最中は受け口から押さない
 *   ・点検: 同じ段・同じ中身が2秒以内に続いたら n 回にまとめる（押した・送った・失敗はまとめない）
 * node tests/chrome-extension/reset-dup-burst-v28328.test.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { loadBackground } = require(path.join(__dirname, "lib", "bg-load.js"));
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const popup = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
const audit = require(path.join(EXT, "search-audit.js"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 300) : "")); }
}

/**
 * onclick = async () => { … } の中で、押す側が click() の直後に消す物（印・点検の文脈・更新日の欄）を
 * 最初の await より後に読んでいる所を返す（構造の点検）。読む物は直接か、写し取った物を渡す形で読む。
 */
const VOLATILE = [/dataset\.automated/, /dataset\.auto_send_all/, /dataset\.area_mode_locked/, /dataset\.auto_sort/, /dataset\.auto_max_pages/, /_clickAuditCtx\(/, /"adj-update-days"/];
function lateReads(src) {
  const out = [];
  const re = /\.onclick = async \(\) => \{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, i = m.index + m[0].length - 1, end = -1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = src.slice(m.index, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    if (!/dataset\.automated/.test(body)) continue;
    const firstAwait = body.search(/\bawait\b/);
    if (firstAwait < 0) continue;
    const after = body.slice(firstAwait);
    for (const v of VOLATILE) if (v.test(after)) out.push({ at: m.index, what: String(v) });
  }
  return out;
}

console.log("■ ① ポップアップ: 押す側が消す物は最初の await より前に読む");
{
  const bad = lateReads(popup);
  ok("自動入力ボタンの処理で、印・点検の文脈・更新日の欄を await の後に読んでいる所が無い", bad.length === 0, bad);
  const rpStart = popup.indexOf("const _auditCtx_rp = _clickAuditCtx(autofillBtn);");
  const rpLearn = popup.indexOf("await new Promise(function (r) { _axLearnRefreshBeforeAutofill(r); });", rpStart);
  const rpAuto = popup.indexOf("const isAutomated = !!autofillBtn.dataset.automated;", rpStart);
  const rpDays = popup.indexOf('const adjUpdateDays = document.getElementById("adj-update-days")', rpStart);
  ok("リアプロ: 学びの取り直しの待ちは、印と欄を読み終えた後", rpStart > 0 && rpAuto > rpStart && rpDays > rpAuto && rpLearn > rpDays, { rpStart, rpAuto, rpDays, rpLearn });
  ok("ITANDI: 押した時点の印と更新日を写し取ってから待つ（_btnSnap_it）",
    /const _btnSnap_it = \{[\s\S]{0,500}automated: !!autofillBtn\.dataset\.automated[\s\S]{0,500}update_days: document\.getElementById\("adj-update-days"\)[\s\S]{0,300}await new Promise\(function \(r\) \{ _axLearnRefreshBeforeAutofill\(r\); \}\);\s*await _itandiAutofillRun\(_auditCtx_it, _btnSnap_it\);/.test(popup));
  ok("ITANDI: 処理の中は写しから読む（ボタンの印を直接読まない）", /const isAutomated_itandi = !!_snapIt\.automated;/.test(popup) && !/isAutomated_itandi = !!autofillBtn\.dataset/.test(popup));
  ok("手押しの時だけ入力前リセットを頼む形は残す（!isAutomated && 自動モード）", /if \(!isAutomated && _isAutoModeNow\(\)\) \{[\s\S]{0,400}type: "axlx-reset-before-fill"/.test(popup));
  // 自己点検: 悪い形（await の後に印を読む）を止められるか
  const badSrc = 'x.onclick = async () => { await f(); const a = !!b.dataset.automated; };';
  ok("自己点検: await の後に印を読む形を見つける", lateReads(badSrc).length === 1, lateReads(badSrc));
  const goodSrc = 'x.onclick = async () => { const a = !!b.dataset.automated; await f(); };';
  ok("自己点検: await の前に読む形は通す", lateReads(goodSrc).length === 0);
}

console.log("\n■ ② 裏: 一括の最中は受け口から入力前リセットを押さない");
{
  ok("受け口 axlx-reset-before-fill は一括の最中なら断る（bulk_owns_reset・段 reset_before_fill_dup_skip）",
    /msg\.type === "axlx-reset-before-fill"[\s\S]{0,1200}if \(_manualBulkAlive \|\| _batchLoopAlive\) \{[\s\S]{0,400}reset_before_fill_dup_skip[\s\S]{0,300}skipped: "bulk_owns_reset"[\s\S]{0,200}return;[\s\S]{0,80}await _resetBeforeFill\(/.test(bg));
}

function mk(pressMs) {
  const steps = [];
  const press = { n: 0 };
  const tabs = { query: async () => [{ id: 5, windowId: 1, index: 0, active: true, url: "https://www.realnetpro.com/main.php", title: "リアプロ" }] };
  const scripting = { executeScript: async () => [{ result: { ok: true, empty: false, left: 3, ready: true } }] };
  const h = loadBackground({ chrome: { tabs, scripting }, storageLocal: {} });
  h.ctx._auditStep = function (rid, k, d) { steps.push({ rid, k, d: String(d || "") }); };
  h.ctx._postSendResetRealpro = async function () {
    press.n++;
    await new Promise((r) => setTimeout(r, pressMs));
    return { ok: true, left: 0, reset: true };
  };
  return { h, steps, press };
}

(async () => {
  console.log("\n■ ③ 裏: 入力前リセットは同時に1本だけ（動かして確かめる）");
  {
    const t = mk(40);
    const rs = await Promise.all([
      t.h.ctx._resetBeforeFill({ id: "c1111111" }, "runA"),
      t.h.ctx._resetBeforeFill({ id: "c1111111" }, "runA2"),
      t.h.ctx._resetBeforeFill({ id: "c1111111" }, "runA3"),
    ]);
    ok("3本同時に頼んでも押すのは1回", t.press.n === 1, t.press);
    ok("  後の2本は走っている1本の結果を受け取る（joined）", rs[1] && rs[1].joined === true && rs[2] && rs[2].joined === true && rs[1].ok === rs[0].ok, rs);
    ok("  受け取った事を点検に残す（reset_before_fill_join）", t.steps.filter((s) => s.k === "reset_before_fill_join").length === 2, t.steps.map((s) => s.k));
    ok("  終わったら次の頼みはまた押せる（固まらない）", await (async () => { await t.h.ctx._resetBeforeFill({ id: "c2222222" }, "runB"); return t.press.n === 2; })(), t.press);
  }
  {
    ok("走っている1本が上限（6分）を過ぎたら待たない", /RESET_BEFORE_FILL_JOIN_MAX_MS = 360000/.test(bg) && /cur && Date\.now\(\) - cur\.at < RESET_BEFORE_FILL_JOIN_MAX_MS/.test(bg));
  }

  console.log("\n■ ④ 点検: 同じ段・同じ中身が2秒以内に続いたら n 回にまとめる");
  {
    const s = [];
    for (let i = 0; i < 16; i++) audit.pushStep(s, "bulk_phase", "pre_fill_reset 上限330秒 2/3", 1000 + i * 30);
    ok("#1666 の形（同じ秒に16回）→ 1行 n=16", s.length === 1 && s[0].n === 16, s);
    audit.pushStep(s, "bulk_phase", "pre_fill_reset 上限330秒 2/3", 1000 + 16 * 30 + 5000);
    ok("2秒より離れた同じ段は別の行（時刻を残す）", s.length === 2, s.length);
    audit.pushStep(s, "bulk_phase", "autofill 上限300秒 2/3", 9000);
    ok("中身が違えば別の行", s.length === 3, s.length);
    const d = [];
    for (let i = 0; i < 5; i++) audit.pushStep(d, "dl:send_bar_dock", "beside-wrap", 100 + i);
    ok("枠の出し入れ（send_bar_dock）は同じ秒ならまとめる", d.length === 1 && d[0].n === 5, d);
    const p = [];
    for (let i = 0; i < 4; i++) audit.pushStep(p, "reset_press", "ok", i);
    ok("押した記録（reset_press）は1行ずつ残す", p.length === 4, p.length);
    const q = [];
    for (let i = 0; i < 3; i++) audit.pushStep(q, "dl:one_send_ms", "1200", i);
    ok("送った記録（one_send_ms）は1行ずつ残す", q.length === 3, q.length);
    const g = [];
    for (let i = 0; i < 3; i++) audit.pushStep(g, "page:press_ng_area", "x", i);
    ok("押せなかった記録（press_ng_）は1行ずつ残す", g.length === 3, g.length);
    const b = [];
    for (let i = 0; i < 3; i++) audit.pushStep(b, "begin", "bulk_manual", i);
    ok("守る段（begin）はまとめない", b.length === 3, b.length);
  }

  console.log("\n結果: " + pass + " 通過 / " + fail + " 失敗");
  process.exit(fail ? 1 : 0);
})();
