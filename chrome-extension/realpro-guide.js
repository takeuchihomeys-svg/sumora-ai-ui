// chrome-extension/realpro-guide.js（リアプロの「案内モード」・content script）
// 2026-10-01 竹内「光らせるようにする。今選択しているところを光らせるようにする」「そうすれば機械的な動きがなく人間が押す形となる」
//   「一度送ったことある物件などは出ないようにする。監視画面が判断する形で」
//
// ⚠ このファイルは値を入れない・押さない・ページをめくらない・スクロールしない。
//   することは「読む（欄の今の値・チェック）」「光らせる（重ねた枠と吹き出し）」「送付済みの行を隠す（表示だけ）」「案内の枠を出す」だけ。
//   tests/chrome-extension/realpro-guide.test.js が、このファイルに click()・dispatchEvent・value の代入・checked の代入・scroll が無い事を確かめる。
//
// 流れ:
//   ① page-script.js が自動入力の依頼を受けた時、案内モード（<html data-axlx-guide="1">）なら入力せずに axlx-guide-start を出す
//   ② ここが手順表（realpro-guide-plan.js）を作り、まだ終わっていない最初の手順の欄を光らせる。スタッフが入れ終わったら次へ
//   ③ スタッフが「検索」を押したら、案内の状態を storage.session に置く（ページが切り替わる）
//   ④ 一覧の画面では、このお客様に送付済みの部屋の行を隠す（sent-skip.js と同じ見分け・bulk-dl.js の行の読み取り）
(function () {
  "use strict";
  if (window.__axlxRealproGuide) return;
  window.__axlxRealproGuide = true;

  var SESSION_KEY = "axlx_guide_session";
  var MODE_KEY = "guideMode";
  var SESSION_TTL_MS = 2 * 3600 * 1000;
  var Plan = (typeof self !== "undefined" ? self : window).AxlxRealproGuidePlan;

  // ── 案内モードのオン・オフ（既定オン）。page-script.js（ページの側）が読めるよう <html> に印を付ける ──
  var guideOn = true;
  function applyMode(v) {
    guideOn = v !== false;
    try { document.documentElement.setAttribute("data-axlx-guide", guideOn ? "1" : "0"); } catch (_) {}
    lockAutoPaging();
    renderPanel();
  }

  // ── 状態 ──
  var session = null;
  /** 最後に案内したお客様（リセットの手順を出すか＝前のお客様と違う時だけ） */
  var lastCid = null;
  try { chrome.storage.session.get(["axlx_guide_last_cid"], function (r) { if (r && r.axlx_guide_last_cid) lastCid = String(r.axlx_guide_last_cid); }); } catch (_) {} // { customerId, customerName, conditions, stage: "form"|"results", done: {id:true}, at }
  var plan = null;
  function saveSession() {
    try { var o = {}; o[SESSION_KEY] = session; chrome.storage.session.set(o); } catch (_) {}
  }
  function endGuide() {
    session = null; plan = null;
    try { chrome.storage.session.remove(SESSION_KEY); } catch (_) {}
    clearHighlight(); renderPanel();
  }

  // ── 読むための部品 ──
  function norm(t) { return String(t || "").replace(/[\s　]+/g, "").replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }); }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }
  function inViewport(el) {
    var r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  }
  /**
   * 文字が texts のどれかと同じ要素。2026-10-01 実画面（YUMA の確かめ）: 「リセット」が2か所あり、画面の外の物を光らせて
   *   「↓ 下にあります」になり、左のリセットを押しても済みにならなかった → 見えている物・画面の中の物・一番内側の物を選ぶ
   */
  function textMatches(texts, sel) {
    var want = texts.map(norm);
    var list = document.querySelectorAll(sel || "a,button,div,span,td,p,label,input[type=button],input[type=submit]");
    var hits = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.closest && el.closest("#axlx-guide-panel,#axlx-guide-layer")) continue;
      if (want.indexOf(norm(el.value || el.textContent)) >= 0 && visible(el)) hits.push(el);
    }
    // 一番内側だけ（中に同じ文字の要素を持つ外側の箱は外す）
    return hits.filter(function (el) { return !hits.some(function (o) { return o !== el && el.contains(o); }); });
  }
  function byText(texts, sel) {
    var hits = textMatches(texts, sel);
    var inv = hits.filter(inViewport);
    return (inv.length ? inv : hits)[0] || null;
  }
  function labelOf(input) {
    if (!input) return null;
    var l = input.closest("label");
    if (l) return l;
    if (input.id) { var f = document.querySelector('label[for="' + CSS.escape(input.id) + '"]'); if (f) return f; }
    return input.parentElement;
  }
  function textOfInput(input) {
    var l = labelOf(input);
    return norm(l ? l.textContent : "").replace(/駅$/, "");
  }
  function checkInput(name, value) {
    var q = 'input[name="' + name + '"]' + (value != null ? '[value="' + value + '"]' : "");
    return document.querySelector(q);
  }
  /** 欄が見えない時に開くボタン（条件の欄が閉じている・小窓が開いていない） */
  /** 閉じた欄の見出し（「絞り込み条件 ＋」「所在地絞り込み ＋」など末尾が＋の物）か */
  var PLUS_HEAD_RE = /[＋+]$/;
  /**
   * 見えない欄 el を開くボタン。2026-10-01 実画面: 「ペット相談」は左の「絞り込み条件 ＋」の中にあり、旧は「検索条件を表示」しか探さず何も光らなかった。
   *   ① el から上の箱へたどり、その箱のすぐ前（前の兄弟）か箱の中の、見えている「…＋」の見出しを光らせる（どの欄でも効く）
   *   ② 見つからなければ名前で探す
   */
  function openerFor(el) {
    for (var n = el, depth = 0; n && n !== document.body && depth < 8; n = n.parentElement, depth++) {
      for (var sib = n.previousElementSibling, k = 0; sib && k < 3; sib = sib.previousElementSibling, k++) {
        if (visible(sib) && PLUS_HEAD_RE.test(norm(sib.textContent)) && norm(sib.textContent).length <= 20) return sib;
        var inner = sib.querySelector ? Array.prototype.filter.call(sib.querySelectorAll("a,button,div,span,p,dt,h3,h4"), function (x) { return visible(x) && PLUS_HEAD_RE.test(norm(x.textContent)) && norm(x.textContent).length <= 20; }) : [];
        if (inner.length) return inner[inner.length - 1];
      }
    }
    return null;
  }
  function opener(kind, el) {
    var near = el ? openerFor(el) : null;
    if (near) return near;
    if (kind === "pick_station" || kind === "pick_route") return byText(["沿線・駅絞り込み＋", "沿線・駅絞り込み+", "沿線・駅絞り込み"]);
    if (kind === "pick_city") return byText(["所在地絞り込み＋", "所在地絞り込み+", "所在地絞り込み"]);
    return byText(["絞り込み条件＋", "絞り込み条件+", "絞り込み条件", "検索条件を表示"]);
  }

  /** 手順の状態: { done, target（光らせる要素・複数可）, note（吹き出しの補足） } */
  function evalStep(s) {
    if (session && session.done && session.done[s.id]) return { done: true };
    if (s.kind === "reset") {
      // 後の手順がもう入っている（スタッフが先に進めた）時はリセットは済み扱い（リセットで止まらない）
      if (plan && plan.steps.some(function (o) { return o.kind !== "reset" && o.kind !== "search" && (function (ev) { return ev.done && !ev.missing; })(evalStep(o)); })) return { done: true };
      return { done: false, target: [byText(["リセット"])] };
    }
    if (s.kind === "select" || s.kind === "text") {
      var el = document.querySelector((s.kind === "select" ? "select" : "input") + '[name="' + s.name + '"]');
      if (!el) return { done: false, target: [opener(s.kind)], note: "欄が見つかりません。条件の欄を開いてください" };
      if (String(el.value) === String(s.value)) return { done: true };
      return visible(el) ? { done: false, target: [el] } : { done: false, target: [opener(s.kind, el)], note: "先に光っている所を押して欄を開いてください" };
    }
    if (s.kind === "check") {
      var cb = checkInput(s.name, s.value);
      // 今の画面に無い欄（このページに無い・リアプロの画面が変わった）は止まらずに飛ばす
      if (!cb) return { done: true, missing: true };
      if (!!cb.checked === !!s.want) return { done: true };
      var lb = labelOf(cb);
      return visible(cb) || visible(lb) ? { done: false, target: [lb || cb] } : { done: false, target: [opener(s.kind, lb || cb)], note: "先に光っている所を押して欄を開いてください" };
    }
    if (s.kind === "check_text") {
      var labels = document.querySelectorAll("label"), hit = null;
      for (var i = 0; i < labels.length; i++) if (norm(labels[i].textContent) === norm(s.text)) { hit = labels[i]; break; }
      var inp = hit && hit.querySelector('input[type="checkbox"]');
      if (!inp) return { done: true, missing: true };
      return !!inp.checked === !!s.want ? { done: true } : { done: false, target: [hit] };
    }
    if (s.kind === "pick_station") {
      var want = {}; (s.names || []).forEach(function (n) { want[norm(n).replace(/駅$/, "")] = true; });
      var found = [], unchecked = [];
      document.querySelectorAll('input[type="checkbox"]').forEach(function (c) {
        if (!visible(c) && !visible(labelOf(c))) return;
        if (!want[textOfInput(c)]) return;
        found.push(c); if (!c.checked) unchecked.push(labelOf(c) || c);
      });
      if (found.length && !unchecked.length) return { done: false, target: [byText(["決定", "OK", "閉じる", "この条件で絞り込む"])], note: "駅を選び終えたら小窓を閉じて、この手順を「済み」にしてください" };
      if (unchecked.length) return { done: false, target: unchecked, note: "光っている駅にチェック（" + unchecked.length + "駅）" };
      var lineBtns = (s.lines || []).map(function (l) { return byText([l]); }).filter(Boolean);
      if (lineBtns.length) return { done: false, target: lineBtns, note: "先に路線を押してください: " + (s.lines || []).join("・") };
      return { done: false, target: [opener(s.kind)], note: "「沿線・駅絞り込み」を開いてください" };
    }
    if (s.kind === "pick_route") {
      var lb2 = (s.lines || []).map(function (l) { return byText([l]); }).filter(Boolean);
      return lb2.length ? { done: false, target: lb2, note: "路線: " + (s.lines || []).join("・") + "（選び終えたら「済み」）" } : { done: false, target: [opener(s.kind)] };
    }
    if (s.kind === "pick_city") {
      var un = [], any = false;
      (s.codes || []).forEach(function (code) {
        var c2 = checkInput("city_code[]", code);
        if (!c2) return;
        any = true;
        if (!c2.checked) un.push(labelOf(c2) || c2);
      });
      if (any && !un.length) return { done: true };
      if (un.length && un.some(function (x) { return visible(x); })) return { done: false, target: un, note: "光っている区にチェック（" + un.length + "区）" };
      return { done: false, target: [opener(s.kind)], note: "「所在地絞り込み」を開いてください" };
    }
    if (s.kind === "search") {
      var go = document.querySelector("div.go_search");
      return { done: false, target: [visible(go) ? go : byText(["検索"])] };
    }
    return { done: true };
  }

  // ── 光らせる（ページの要素には触らず、上に枠を重ねる）──
  var layer = null;
  function ensureLayer() {
    if (layer && document.body.contains(layer)) return layer;
    if (!document.getElementById("axlx-guide-style")) {
      var st = document.createElement("style");
      st.id = "axlx-guide-style";
      st.textContent = "@keyframes axlxGlow{0%{box-shadow:0 0 0 3px rgba(255,179,0,.95),0 0 14px 6px rgba(255,179,0,.55)}50%{box-shadow:0 0 0 3px rgba(255,179,0,.95),0 0 26px 12px rgba(255,179,0,.25)}100%{box-shadow:0 0 0 3px rgba(255,179,0,.95),0 0 14px 6px rgba(255,179,0,.55)}}"
        + ".axlx-glow{position:fixed;pointer-events:none;border-radius:6px;z-index:2147483600;animation:axlxGlow 1.2s ease-in-out infinite}"
        + ".axlx-tip{position:fixed;pointer-events:none;z-index:2147483601;background:#ff8f00;color:#fff;font:bold 12px/1.4 sans-serif;padding:4px 8px;border-radius:6px;max-width:320px;box-shadow:0 2px 6px rgba(0,0,0,.3)}"
        + ".axlx-sent-hidden{display:none !important}";
      (document.head || document.documentElement).appendChild(st);
    }
    layer = document.createElement("div");
    layer.id = "axlx-guide-layer";
    document.body.appendChild(layer);
    return layer;
  }
  function clearHighlight() { if (layer) layer.innerHTML = ""; }
  function highlight(targets, label) {
    var L = ensureLayer();
    L.innerHTML = "";
    var first = null;
    (targets || []).filter(Boolean).slice(0, 40).forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      var g = document.createElement("div");
      g.className = "axlx-glow";
      g.style.left = (r.left - 4) + "px"; g.style.top = (r.top - 4) + "px";
      g.style.width = (r.width + 8) + "px"; g.style.height = (r.height + 8) + "px";
      L.appendChild(g);
      if (!first) first = r;
    });
    if (label) {
      var tip = document.createElement("div");
      tip.className = "axlx-tip";
      var vh = window.innerHeight;
      if (!first) { tip.style.left = "16px"; tip.style.top = "16px"; tip.textContent = label; }
      else if (first.bottom < 0) { tip.style.left = Math.max(8, first.left) + "px"; tip.style.top = "8px"; tip.textContent = "↑ 上にあります: " + label; }
      else if (first.top > vh) { tip.style.left = Math.max(8, first.left) + "px"; tip.style.top = (vh - 40) + "px"; tip.textContent = "↓ 下にあります: " + label; }
      else { tip.style.left = Math.max(8, first.left) + "px"; tip.style.top = Math.max(8, first.top - 30) + "px"; tip.textContent = label; }
      L.appendChild(tip);
    }
  }

  // ── 案内の枠（右上）──
  var panel = null;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function renderPanel(cur, curEval) {
    if (!document.body) return;
    if (!panel || !document.body.contains(panel)) {
      panel = document.createElement("div");
      panel.id = "axlx-guide-panel";
      panel.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483602;width:290px;background:#fff;border:2px solid #ff8f00;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.25);font:12px/1.5 sans-serif;color:#263238;padding:8px 10px;";
      panel.addEventListener("click", onPanelClick);
      document.body.appendChild(panel);
    }
    var head = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><b style="flex:1;color:#e65100">🔦 案内モード（押すのはスタッフ）</b>'
      + '<button data-a="mode" style="font-size:11px;padding:1px 6px;border-radius:9px;border:1px solid #ccc;background:' + (guideOn ? "#fff3e0" : "#eceff1") + '">' + (guideOn ? "ON" : "OFF") + "</button></div>";
    if (!guideOn) { panel.innerHTML = head + '<div style="color:#78909c">OFF の間は今まで通り拡張が入力します</div>'; return; }
    if (!session) { panel.innerHTML = head + '<div style="color:#78909c">拡張でお客様を選ぶと、ここに手順が出ます</div>'; return; }
    if (session.stage === "results") {
      panel.innerHTML = head + '<div><b>' + esc(session.customerName || "") + '</b> の検索結果</div><div id="axlx-guide-sent" style="color:#455a64">' + esc(sentNote || "送付済みの部屋を確かめています…") + "</div>"
        + '<div style="margin-top:6px;display:flex;gap:6px"><button data-a="showsent" style="flex:1">送付済みも表示</button><button data-a="end" style="flex:1">案内を終える</button></div>';
      return;
    }
    var rows = (plan ? plan.steps : []).map(function (s, i) {
      var d = evalStep(s).done;
      var isCur = cur && cur.id === s.id;
      return '<div style="' + (isCur ? "font-weight:bold;color:#e65100" : d ? "color:#9e9e9e" : "") + '">' + (d ? "✓" : isCur ? "▶" : "・") + " " + esc(s.label) + "</div>";
    }).join("");
    panel.innerHTML = head + '<div style="margin-bottom:4px"><b>' + esc(session.customerName || "") + "</b></div>"
      + '<div style="max-height:220px;overflow:auto;border-top:1px solid #eee;padding-top:4px">' + rows + "</div>"
      + (curEval && curEval.note ? '<div style="margin-top:4px;color:#c62828">' + esc(curEval.note) + "</div>" : "")
      + '<div style="margin-top:6px;display:flex;gap:6px"><button data-a="skip" style="flex:1">この手順は済み</button><button data-a="end" style="flex:1">案内をやめる</button></div>';
  }
  function onPanelClick(e) {
    var a = e.target && e.target.getAttribute && e.target.getAttribute("data-a");
    if (!a) return;
    if (a === "mode") { try { var o = {}; o[MODE_KEY] = !guideOn; chrome.storage.local.set(o); } catch (_) { applyMode(!guideOn); } return; }
    if (a === "end") { endGuide(); return; }
    if (a === "skip" && session && plan) {
      var cur = currentStep();
      if (cur) { session.done = session.done || {}; session.done[cur.step.id] = true; saveSession(); tick(); }
      return;
    }
    if (a === "showsent") { showSent = !showSent; applySentHiding(); }
  }

  function currentStep() {
    if (!plan) return null;
    for (var i = 0; i < plan.steps.length; i++) {
      var ev = evalStep(plan.steps[i]);
      if (!ev.done) return { step: plan.steps[i], ev: ev };
    }
    return null;
  }

  // ── 毎回の見直し（スタッフの操作・画面の変化に合わせて光を移す）──
  function tick() {
    if (!guideOn || !session || session.stage !== "form" || !plan) { if (session && session.stage === "results") clearHighlight(); renderPanel(); return; }
    var cur = currentStep();
    if (!cur) { clearHighlight(); renderPanel(); return; }
    highlight(cur.ev.target, cur.step.label + (cur.ev.note ? "（" + cur.ev.note + "）" : ""));
    renderPanel(cur.step, cur.ev);
  }
  setInterval(tick, 400);
  window.addEventListener("scroll", tick, true);
  window.addEventListener("resize", tick);

  // スタッフが押した物を見る（押した要素を読むだけ）: リセット・検索
  document.addEventListener("click", function (e) {
    if (!session || session.stage !== "form" || !plan) return;
    var t = e.target;
    var cur = currentStep();
    if (!cur) return;
    var tgt = (cur.ev.target || [])[0];
    // リセットは光らせた物でなくても、文字が「リセット」の物を押せば済み（同じ文字のボタンが複数ある）
    var isResetClick = false;
    for (var n = t, k = 0; n && k < 4; n = n.parentElement, k++) if (norm(n.value || n.textContent) === "リセット") { isResetClick = true; break; }
    if (cur.step.kind === "reset" && (isResetClick || (tgt && (tgt === t || tgt.contains(t))))) {
      session.done = session.done || {}; session.done[cur.step.id] = true; saveSession();
    }
    if (cur.step.kind === "search" && tgt && (tgt === t || tgt.contains(t))) {
      session.stage = "results"; session.at = Date.now(); saveSession(); clearHighlight();
    }
  }, true);

  // ── ① page-script.js から: 案内を始める ──
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.from !== "axlx-guide-start" || !Plan) return;
    var c = e.data.conditions || {};
    var prevCid = session && session.customerId ? String(session.customerId) : lastCid;
    var newCid = e.data.customerId || c.customer_id || null;
    var withReset = !!(prevCid && newCid && String(newCid) !== prevCid);
    lastCid = newCid ? String(newCid) : lastCid;
    try { chrome.storage.session.set({ axlx_guide_last_cid: lastCid }); } catch (_) {}
    session = { customerId: e.data.customerId || c.customer_id || null, customerName: c.customer_name || c.name || "", conditions: c, stage: "form", done: {}, at: Date.now() };
    session.withReset = withReset;
    plan = Plan.buildPlan(c, { withReset: withReset });
    saveSession();
    tick();
  });

  // ── ④ 一覧の画面: 送付済みの部屋の行を隠す ──
  var sentIndex = null, sentNote = "", showSent = false;
  function loadSentRooms() {
    if (!session || !session.customerId) { sentNote = "お客様が分からないので送付済みは隠していません"; renderPanel(); return; }
    try {
      chrome.runtime.sendMessage({ type: "axlx-guide-sent-rooms", customerId: session.customerId }, function (resp) {
        void chrome.runtime.lastError;
        var SK = (typeof self !== "undefined" ? self : window).AxlxSentSkip;
        if (!SK || !resp || !resp.ok) { sentNote = "送付済みの部屋を読めませんでした（全部表示しています）"; renderPanel(); return; }
        sentIndex = SK.indexFor({ customerId: String(session.customerId), rooms: resp.rooms || [], at: Date.now() }, session.customerId, Date.now());
        applySentHiding();
      });
    } catch (_) {}
  }
  function applySentHiding() {
    var SK = (typeof self !== "undefined" ? self : window).AxlxSentSkip;
    var R = (typeof self !== "undefined" ? self : window).AxlxRealproRows;
    if (!SK || !R) return;
    var rows = R.list();
    var hidden = 0;
    rows.forEach(function (r) {
      var sent = !!(sentIndex && r.room && SK.isSentRoom(sentIndex, r.name, r.room));
      if (r.row) r.row.classList.toggle("axlx-sent-hidden", sent && !showSent);
      if (sent) { hidden++; if (r.cb) r.cb.disabled = true; }
    });
    ensureLayer();
    sentNote = sentIndex ? (hidden ? "このお客様に送付済みの部屋 " + hidden + "件を" + (showSent ? "表示しています（チェックはできません）" : "隠しています") : "このページに送付済みの部屋はありません") : "送付済みの部屋はまだありません";
    renderPanel();
  }

  // 案内モードの間は、拡張がページを自動でめくる「全ページ送る」を止める（押せない）
  function lockAutoPaging() {
    var b = document.getElementById("axlx-auto-btn");
    if (!b) return;
    b.disabled = !!guideOn;
    b.title = guideOn ? "案内モードの間は使えません（ページはスタッフがめくる）" : "";
    b.style.opacity = guideOn ? "0.4" : "";
  }
  var _hideTimer = null;
  new MutationObserver(function (muts) {
    lockAutoPaging();
    // 一覧の行が後から描かれた時も隠し直す（自分の枠・光の変化は見ない）
    if (!sentIndex || _hideTimer) return;
    if (muts.every(function (m) { return m.target && m.target.closest && m.target.closest("#axlx-guide-panel,#axlx-guide-layer"); })) return;
    _hideTimer = setTimeout(function () { _hideTimer = null; applySentHiding(); }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 案内モードの設定を読む（変数をすべて用意した後＝ファイルの最後で読む。先に読むと案内の枠が2つできる）
  try {
    chrome.storage.local.get([MODE_KEY], function (r) { applyMode(r ? r[MODE_KEY] : undefined); });
    chrome.storage.onChanged.addListener(function (ch, area) { if (area === "local" && ch[MODE_KEY]) applyMode(ch[MODE_KEY].newValue); });
  } catch (_) { applyMode(true); }

  // ページを開いた時: 前の案内の続き
  try {
    chrome.storage.session.get([SESSION_KEY], function (r) {
      var s = r && r[SESSION_KEY];
      if (!s || !s.at || Date.now() - s.at > SESSION_TTL_MS) return;
      session = s;
      if (session.stage === "form" && Plan) plan = Plan.buildPlan(session.conditions || {}, { withReset: !!session.withReset });
      if (session.stage === "results") setTimeout(loadSentRooms, 1500);
      tick();
    });
  } catch (_) {}
})();
