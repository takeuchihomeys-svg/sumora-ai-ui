// chrome-extension/itandi-guide.js（ITANDI の「案内モード」・content script）
// 2026-10-01 竹内「ITANDIも画面表示光らせるようにする。検索の画面の入力は手動でそれ以外は今まで通りに、画像もそのままチェックして売上番長に送って解析させる流れ」
//
// ⚠ このファイルは値を入れない・押さない・ページをめくらない・スクロールしない（realpro-guide.js と同じ決まり）。
//   することは「読む（欄の今の値・チェック・所在地/路線・駅のチップ）」「光らせる（重ねた枠と吹き出し）」「案内の枠を出す」
//   「案内モードの間は『全ページ送る』（拡張がページをめくる）を押せなくする」だけ。
//   tests/chrome-extension/itandi-guide.test.js が、このファイルに click()・dispatchEvent・value の代入・checked の代入・scroll が無い事を確かめる。
//
// 流れ:
//   ① itandi-page-script.js が自動入力の依頼（axlx-itandi-fill-exec）を受けた時、案内モード（<html data-axlx-guide> が "0" 以外）なら
//      入力せずに axlx-itandi-guide-start を出す（1か所の受け口・popup・一括・URL の sumora_cid どの道から来ても同じ）
//   ② ここが手順表（itandi-guide-plan.js）を作り、まだ終わっていない最初の手順の欄を光らせる。スタッフが入れ終わったら次へ
//      （前のお客様の条件が残っていれば、最初に「外す」所を光らせる＝自動入力の「1つずつ外す」と同じ前提をスタッフの手で）
//   ③ スタッフが「検索」を押したら一覧の段へ。一覧の物件のチェック・「売上番長に送る」は今まで通り itandi-bulk-dl.js（自動では送らない）
(function () {
  "use strict";
  if (window.__axlxItandiGuide) return;
  window.__axlxItandiGuide = true;

  var SESSION_KEY = "axlx_itandi_guide_session"; // リアプロ（axlx_guide_session）とは別の箱（storage.session はタブ・サイトをまたいで同じ）
  var MODE_KEY = "guideMode";
  var SESSION_TTL_MS = 2 * 3600 * 1000;
  function W() { return typeof self !== "undefined" ? self : window; }
  var Plan = W().AxlxItandiGuidePlan;
  function FG() { return W().AxlxItandiFormGuard || null; }
  function UD() { return W().AxlxItandiUpdateDays || null; }
  var PANEL_ID = "axlx-itandi-guide-panel", LAYER_ID = "axlx-itandi-guide-layer";

  // ── 案内モードのオン・オフ（既定オン・リアプロと同じ guideMode）。itandi-page-script.js（ページの側）が読めるよう <html> に印を付ける ──
  var guideOn = true;
  function applyMode(v) {
    guideOn = v !== false;
    try { document.documentElement.setAttribute("data-axlx-guide", guideOn ? "1" : "0"); } catch (_) {}
    lockAutoPaging();
    renderPanel();
  }

  // ── 状態 ──
  var session = null; // { customerId, customerName, conditions, stage: "form"|"results", done: {id:true}, at }
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
  function nfkc(s) { var t = String(s == null ? "" : s); return t.normalize ? t.normalize("NFKC") : t; }
  function sq(t) { return nfkc(t).replace(/[\s　]+/g, ""); }
  // itandi-page-script.js の norm と同じ（括弧・〜・全角空白）
  function norm(s) { return String(s == null ? "" : s).replace(/（/g, "(").replace(/）/g, ")").replace(/〜/g, "~").replace(/～/g, "~").replace(/　/g, " ").trim(); }
  function textMatch(elText, search) { var t = norm(elText), n = norm(search); return t === n || t.indexOf(n) >= 0; }
  function mine(el) { return !!(el && el.closest && el.closest("#" + PANEL_ID + ",#" + LAYER_ID)); }
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    return (r.width > 0 || r.height > 0) && getComputedStyle(el).visibility !== "hidden";
  }
  function inDialog(el) { return !!(el && el.closest && el.closest('[role="dialog"]')); }
  function openDialog() {
    var ds = document.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < ds.length; i++) if (visible(ds[i])) return ds[i];
    return null;
  }
  function formRoot() {
    var r = document.querySelector('input[name="rent:lteq"]');
    return (r && r.closest && r.closest("form")) || null;
  }
  function field(name) {
    var el = (formRoot() || document).querySelector('input[name="' + name + '"]');
    return el && !inDialog(el) ? el : null;
  }
  function labelOf(input) {
    if (!input) return null;
    var l = input.closest ? input.closest("label") : null;
    if (l) return l;
    if (input.id) { try { var f = document.querySelector('label[for="' + CSS.escape(input.id) + '"]'); if (f) return f; } catch (_) {} }
    return input.parentElement;
  }
  function inputOf(lbl) {
    if (!lbl) return null;
    var inp = lbl.querySelector("input[type='checkbox'], input[type='radio']");
    if (!inp && lbl.htmlFor) inp = document.getElementById(lbl.htmlFor);
    return inp || null;
  }
  function isChecked(lbl) { var i = inputOf(lbl); return !!(i && i.checked); }
  function numEq(a, b) {
    var x = parseFloat(nfkc(a).replace(/[,，\s]/g, "")), y = parseFloat(nfkc(b).replace(/[,，\s]/g, ""));
    return isFinite(x) && isFinite(y) && Math.abs(x - y) < 1e-9;
  }
  function isEmptyVal(v) { var F = FG(); return F ? F.isEmptyValue(v) : sq(v) === ""; }
  /** 中に同じ条件の要素を持つ外側の箱は外す（一番内側だけ光らせる） */
  function innermost(list) { return list.filter(function (el) { return !list.some(function (o) { return o !== el && el.contains(o); }); }); }
  function btnByText(root, text) {
    var n = sq(text);
    var bs = [].slice.call((root || document).querySelectorAll("button")).filter(function (b) { return visible(b) && !mine(b); });
    return bs.filter(function (b) { return sq(b.textContent) === n; })[0] || bs.filter(function (b) { return sq(b.textContent).indexOf(n) >= 0; })[0] || null;
  }
  function closeBtnOf(dlg) {
    return dlg.querySelector('button[aria-label="閉じる"], button[aria-label="close"], button[aria-label="Close"]') || btnByText(dlg, "閉じる") || btnByText(dlg, "キャンセル");
  }
  // 小窓の中の「近畿」「大阪府」（itandi-page-script.js clickNav と同じ部品の種類・完全一致 → 部分一致）
  function navByText(root, text) {
    var n = norm(text);
    var els = [].slice.call(root.querySelectorAll("li, button, a, span, label, div[role='button']")).filter(function (e) { return visible(e) && !mine(e); });
    var hits = els.filter(function (e) { return norm(e.textContent) === n; });
    if (!hits.length) hits = els.filter(function (e) { return norm(e.textContent).indexOf(n) >= 0; });
    return innermost(hits)[0] || null;
  }
  // 所在地の小窓のラジオのラベル（itandi-page-script.js clickItandiRadio と同じ探し方: 完全一致 → 括弧を除いて → 区町村は前方一致・他は部分一致）
  function radioLabel(root, text) {
    var n = norm(text);
    var labels = [].slice.call(root.querySelectorAll("label")).filter(visible);
    var f = labels.filter(function (l) { return norm(l.textContent) === n; })[0];
    if (!f) f = labels.filter(function (l) { return norm(l.textContent).replace(/[（(].*$/, "") === n; })[0];
    if (!f) {
      var isWardTerm = /[区町村]$/.test(n);
      f = labels.filter(function (l) { var t = norm(l.textContent); return isWardTerm ? t.indexOf(n) === 0 : t.indexOf(n) >= 0; })[0];
    }
    return f || null;
  }

  // ── 所在地・路線/駅のチップを読む（itandi-page-script.js _itFilterBtn/_itFilterRow/_itChipNodes/_itChipDeleteCtl の読むだけの写し）──
  function filterBtn(rowDef) {
    var names = rowDef.buttons.map(sq);
    return [].slice.call(document.querySelectorAll("button, [role='button']")).filter(function (b) { return visible(b) && !inDialog(b) && !mine(b); })
      .filter(function (b) { return names.indexOf(sq(b.textContent)) >= 0; })[0] || null;
  }
  function filterRow(rowDef) {
    var F = FG();
    var btn = filterBtn(rowDef);
    if (!F || !btn) return null;
    var others = F.FILTER_ROWS.filter(function (r) { return r.key !== rowDef.key; });
    var lab = sq(rowDef.label), bt = sq(btn.textContent);
    var el = btn.parentElement;
    for (var i = 0; el && i < 8; i++, el = el.parentElement) {
      if (el.querySelector('input[name="rent:lteq"]')) break;
      var hasOther = others.some(function (o) { var ob = filterBtn(o); return ob && el.contains(ob); });
      if (hasOther) break;
      var tx = sq(el.textContent);
      if (tx.indexOf(lab) === 0 && tx.indexOf(bt) > 0) return { row: el, btn: btn };
    }
    return null;
  }
  function chipNodes(rowDef, f) {
    var F = FG();
    if (!F || !f) return null;
    var nodes = [];
    try {
      var w = document.createTreeWalker(f.row, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = w.nextNode())) {
        if (f.btn.contains(n)) continue;
        var t = (n.nodeValue || "").trim();
        if (!t) continue;
        var pe = n.parentElement;
        if (pe && !visible(pe)) continue;
        nodes.push({ text: t, node: n });
      }
    } catch (e) { return null; }
    return F.chipNames(nodes.map(function (x) { return x.text; }), rowDef.key).map(function (nm) {
      var hit = nodes.filter(function (x) { return sq(x.text) === nm; })[0];
      return { name: nm, node: hit ? hit.node : null };
    });
  }
  function chipDeleteCtl(chip, row, fbtn) {
    var F = FG();
    if (!chip.node || !chip.node.parentElement) return null;
    var el = chip.node.parentElement;
    for (var up = 0; el && el !== row && up < 4; up++, el = el.parentElement) {
      if (el.contains(fbtn)) break;
      var cands = [].slice.call(el.querySelectorAll("button, [role='button'], svg, [aria-label], [title], [class*='elete'], [class*='emove'], [class*='lose'], [class*='lear'], [class*='ancel']"));
      var ctl = cands.filter(function (d) {
        if (d.contains(chip.node) || d === fbtn || d.contains(fbtn) || !visible(d)) return false;
        return F.isDeleteControl({ tag: d.tagName, text: d.textContent, aria: d.getAttribute("aria-label"), title: d.getAttribute("title"), cls: String(d.getAttribute("class") || ""), role: d.getAttribute("role") });
      })[0];
      if (ctl) return ctl;
    }
    var b = chip.node.parentElement.closest ? chip.node.parentElement.closest("button, [role='button']") : null;
    if (b && b !== fbtn && row.contains(b) && !b.contains(fbtn)) return b;
    return null;
  }
  function rowDef(key) { var F = FG(); return F ? F.FILTER_ROWS.filter(function (r) { return r.key === key; })[0] : null; }
  /** { f（行・ボタン）, chips: [{name,node}] }。行が読めない時 chips は [] */
  function readRow(key) {
    var d = rowDef(key);
    var f = d ? filterRow(d) : null;
    return { def: d, f: f, chips: (f && chipNodes(d, f)) || [] };
  }

  // ── 欲しい区・駅か（itandi-form-guard.js foreignChips と同じ見分け＋町域）──
  function wardShortOf(w) { var s = sq(w).replace(/内$/, ""); var m = s.match(/^.+?[市郡]([^市郡]+[区町村])$/); return m ? m[1] : s; }
  function wardChipHit(chip, ward, towns) {
    var cs = sq(chip), x = sq(ward).replace(/内$/, "");
    if (!cs) return false;
    if (cs.indexOf(x) === 0 || x.indexOf(cs) === 0 || cs.indexOf(wardShortOf(x)) >= 0) return true;
    return (towns || []).some(function (t) { var tn = sq(t); return tn && (cs === tn || cs.indexOf(tn) === 0); });
  }
  function stationKey(s) { return sq(s).replace(/[（(].*?[）)]/g, "").replace(/駅$/, ""); }
  function wantStationKeys(stations) {
    var keys = {};
    (stations || []).forEach(function (s) { Plan.getStationAliases(String(s).replace(/駅$/, "")).forEach(function (a) { keys[stationKey(a)] = true; }); });
    return keys;
  }
  function townsFor(s, ward) {
    if (s.townMap && s.townMap[ward] && s.townMap[ward].length) return s.townMap[ward];
    if (s.townArea && s.wards && s.wards[s.wards.length - 1] === ward) return [s.townArea];
    return null;
  }
  function chipWanted(key, name) {
    var loc = plan && plan.want && plan.want.location;
    if (!loc) return true;
    if (key === "wards") {
      if (loc.mode !== "area") return false;
      if (loc.batchCity) return true;
      return loc.wards.some(function (w) { return wardChipHit(name, w, townsFor(loc, w)); });
    }
    if (key === "stations") {
      if (loc.mode !== "station") return false;
      if (loc.selectAll || !loc.stations.length) return true;
      return !!wantStationKeys(loc.stations)[stationKey(name)];
    }
    return true;
  }

  // ── 募集条件更新の欄（itandi-update-days.js findField・ラベルで見つけた物だけ＝自動入力と同じ）──
  var _udCache = null;
  function updateDaysField() {
    if (_udCache && document.documentElement.contains(_udCache)) return _udCache;
    var U = UD();
    if (!U) return null;
    var rentEl = document.querySelector('input[name="rent:lteq"]');
    var fm = rentEl && rentEl.closest ? rentEl.closest("form") : null;
    var found = null;
    try { found = U.findField(fm || document.body); } catch (_) { found = null; }
    _udCache = found && found.how === "label" ? found.el : null;
    return _udCache;
  }

  // ── 前のお客様の残り（自動入力の _itReadResetState と同じ欄を読む・このお客様で入れる物は残りにしない）──
  function wantedCheck(name, inp) {
    var list = (plan && plan.want.checks[name]) || [];
    var lt = sq(labelOf(inp) ? labelOf(inp).textContent : "");
    return list.some(function (x) {
      if (x.id && (inp.id === x.id || inp.value === x.id)) return true;
      return !!(x.labelText && lt && lt === sq(x.labelText));
    });
  }
  function leftovers() {
    var F = FG();
    if (!F || !plan) return [];
    var w = plan.want, root = formRoot(), scope = root || document, out = [];
    var udEl = updateDaysField();
    var clearNames = F.CLEAR_TEXT_FIELDS.map(function (d) { return d.name; });
    F.CLEAR_TEXT_FIELDS.forEach(function (d) {
      if (w.texts[d.name] != null) return;
      var el = field(d.name);
      if (el && !isEmptyVal(el.value)) out.push({ el: el, why: d.ja + "を空に" });
    });
    if (root) {
      [].slice.call(root.querySelectorAll("input[name]")).forEach(function (el) {
        var ty = String(el.type || "text").toLowerCase();
        if (["text", "search", "number", "tel", ""].indexOf(ty) < 0 || inDialog(el) || el === udEl) return;
        if (clearNames.indexOf(el.name) >= 0 || F.keepTextName(el.name) || w.texts[el.name] != null) return;
        if (!isEmptyVal(el.value)) out.push({ el: el, why: "入力欄（" + String(el.name).slice(0, 20) + "）を空に" });
      });
    }
    var U = UD();
    if (udEl && U && w.updateDays === null && U.readDays(udEl.value) !== null) out.push({ el: udEl, why: "募集条件更新を空に" });
    F.CLEAR_CHECK_NAMES.forEach(function (d) {
      [].slice.call(scope.querySelectorAll('input[type="checkbox"][name="' + d.name + '"]')).forEach(function (inp) {
        if (!inp.checked || inDialog(inp) || wantedCheck(d.name, inp)) return;
        out.push({ el: labelOf(inp) || inp, why: d.ja + "のチェックを外す" });
      });
    });
    if (!w.shikirei) {
      [].slice.call(scope.querySelectorAll("label")).forEach(function (l) {
        if (F.CLEAR_CHECK_LABELS.indexOf(sq(l.textContent)) < 0 || inDialog(l)) return;
        if (isChecked(l)) out.push({ el: l, why: sq(l.textContent) + "のチェックを外す" });
      });
    }
    ["wards", "stations"].forEach(function (key) {
      var r = readRow(key);
      if (!r.f) return;
      r.chips.forEach(function (ch) {
        if (chipWanted(key, ch.name)) return;
        var t = chipDeleteCtl(ch, r.f.row, r.f.btn) || (ch.node && ch.node.parentElement);
        if (t) out.push({ el: t, why: (key === "wards" ? "所在地" : "路線・駅") + "「" + ch.name + "」を×で外す" });
      });
    });
    return out;
  }

  /** 手順の状態: { done, missing（今の画面に無い欄＝飛ばす）, target（光らせる要素・複数可）, note（吹き出しの補足） } */
  function evalStep(s) {
    if (session && session.done && session.done[s.id]) return { done: true };
    if (s.kind === "clear") {
      var lo = leftovers();
      if (!lo.length) return { done: true };
      return { done: false, target: lo.map(function (x) { return x.el; }), note: lo.slice(0, 3).map(function (x) { return x.why; }).join("・") + (lo.length > 3 ? " ほか" + (lo.length - 3) : "") };
    }
    if (s.kind === "text") {
      var el = field(s.name);
      if (!el) return { done: true, missing: true };
      if (numEq(el.value, s.value)) return { done: true };
      return { done: false, target: [el], note: visible(el) ? null : "欄が隠れています。開いてください" };
    }
    if (s.kind === "update_days") {
      var ud = updateDaysField(), U = UD();
      if (!ud || !U) return { done: true, missing: true };
      if (U.readDays(ud.value) === s.value) return { done: true };
      return { done: false, target: [ud], note: "欄を押して一覧から「" + s.value + "」を選ぶ" };
    }
    if (s.kind === "check") return evalCheck(s);
    if (s.kind === "check_text") {
      var hit = [].slice.call(document.querySelectorAll("label")).filter(function (l) { return !inDialog(l) && s.texts.map(sq).indexOf(sq(l.textContent)) >= 0; })[0];
      var inp = inputOf(hit);
      if (!hit || !inp) return { done: true, missing: true };
      return inp.checked ? { done: true } : { done: false, target: [hit] };
    }
    if (s.kind === "pick_area") return evalArea(s);
    if (s.kind === "pick_lines") return evalLines(s);
    if (s.kind === "search") {
      var b = searchBtn();
      var F = FG();
      var why = F && b ? F.searchBlock({ found: true, disabled: !!(b.disabled || b.getAttribute("aria-disabled") === "true"), texts: blockTexts() }) : null;
      return { done: false, target: [b], note: why ? why.ja : null };
    }
    return { done: true };
  }
  function sectionOpener(sectionText) {
    var parts = sectionText.replace(/[（(）)]/g, " ").split(/\s+/).filter(Boolean);
    var hits = [].slice.call(document.querySelectorAll("button,[role='button'],div,li")).filter(function (e) {
      return !mine(e) && visible(e) && parts.every(function (p) { return (e.textContent || "").indexOf(p) >= 0; });
    });
    return innermost(hits)[0] || null;
  }
  function evalCheck(s) {
    var root = formRoot() || document;
    var inp = null;
    if (s.fid) inp = root.querySelector('input[name="' + s.name + '"][id="' + s.fid + '"]') || document.querySelector('input[name="' + s.name + '"][id="' + s.fid + '"]');
    else if (!s.labelText) inp = document.querySelector('input[name="' + s.name + '"]');
    if (!inp && s.labelText) {
      // ID で見つからない時はラベルの文字（自動入力の予備と同じ: 間取り・ペットは同じ文字／構造・バストイレ別は文字を含む）
      var texts = [s.labelText].concat(s.alt ? [s.alt] : []).concat(s.fid ? [s.fid] : []);
      var lbl = [].slice.call(document.querySelectorAll("label")).filter(function (l) {
        if (inDialog(l) || mine(l)) return false;
        return texts.some(function (t) { return s.exact ? sq(l.textContent) === sq(t) : textMatch(l.textContent, t); });
      })[0];
      inp = lbl ? inputOf(lbl) : null;
    }
    if (!inp) {
      var op0 = s.section ? sectionOpener(s.section) : null;
      if (op0) return { done: false, target: [op0], note: "先に「" + s.section + "」を開いてください" };
      return { done: true, missing: true };
    }
    if (inp.checked) return { done: true };
    var lb = labelOf(inp);
    if (visible(lb) || visible(inp)) return { done: false, target: [lb || inp] };
    var op = s.section ? sectionOpener(s.section) : null;
    return op ? { done: false, target: [op], note: "先に「" + s.section + "」を開いてください" } : { done: false, target: [lb || inp], note: "欄が隠れています。開いてください" };
  }
  function evalArea(s) {
    var r = readRow("wards");
    var chips = r.chips.map(function (c) { return c.name; });
    var missing = s.batchCity ? (chips.length ? [] : [s.batchCity]) : s.wards.filter(function (w) { return !chips.some(function (c) { return wardChipHit(c, w, townsFor(s, w)); }); });
    var dlg = openDialog();
    if (!missing.length && !dlg) return { done: true };
    if (!dlg) {
      var fb = r.f ? r.f.btn : (r.def ? filterBtn(r.def) : null);
      return { done: false, target: [fb], note: "「所在地で絞り込み」を押して小窓を開く" + (missing.length < (s.batchCity ? 1 : s.wards.length) ? "（次は " + missing[0] + "）" : "") };
    }
    if (!dlg.querySelector('input[name="regionName"]')) return { done: false, target: [closeBtnOf(dlg)], note: "別の小窓が開いています。閉じてください" };
    var okBtn = btnByText(dlg, "確定");
    if (!missing.length) return { done: false, target: [okBtn], note: "選び終えたら「確定」" };
    var kinki = radioLabel(dlg, "近畿");
    if (kinki && !isChecked(kinki)) return { done: false, target: [kinki], note: "「近畿」を選ぶ" };
    var osaka = radioLabel(dlg, "大阪府") || radioLabel(dlg, "大阪");
    if (osaka && !isChecked(osaka)) return { done: false, target: [osaka], note: "「大阪府」を選ぶ" };
    if (s.batchCity) {
      var npfx = norm(s.batchCity);
      var un = [].slice.call(dlg.querySelectorAll("label")).filter(function (l) {
        var t = norm(l.textContent);
        return visible(l) && inputOf(l) && t.indexOf(npfx) === 0 && t.indexOf(norm("大阪府")) !== 0 && !isChecked(l);
      });
      return un.length ? { done: false, target: un, note: s.batchCity + "の区を全部選ぶ（" + un.length + "）" } : { done: false, target: [okBtn], note: "選び終えたら「確定」" };
    }
    var w0 = missing[0];
    var short = Plan.wardShortName(w0);
    var wl = radioLabel(dlg, w0) || (short ? radioLabel(dlg, short) : null);
    if (!wl) return { done: false, target: [osaka || kinki], note: "「" + w0 + "」が見つかりません（大阪府を選ぶと出ます）" };
    if (!isChecked(wl)) return { done: false, target: [wl], note: "「" + w0 + "」を選ぶ" };
    var towns = townsFor(s, w0);
    if (towns) {
      var zen = [].slice.call(dlg.querySelectorAll("label")).filter(function (l) { return (l.textContent || "").trim() === "全域" && visible(l) && inputOf(l); })[0];
      if (zen && isChecked(zen)) return { done: false, target: [zen], note: "町域を選ぶため「全域」のチェックを外す" };
      var cbs = [].slice.call(dlg.querySelectorAll("label")).filter(function (l) { var i = inputOf(l); return i && i.type === "checkbox"; });
      var tl = [];
      towns.forEach(function (town) {
        var tn = norm(town);
        var m = cbs.filter(function (l) { return norm(l.textContent) === tn; });
        if (!m.length) m = cbs.filter(function (l) { return norm(l.textContent).indexOf(tn) === 0; });
        if (!m.length) m = cbs.filter(function (l) { return norm(l.textContent).indexOf(tn) >= 0; });
        m.forEach(function (l) { if (!isChecked(l) && tl.indexOf(l) < 0) tl.push(l); });
      });
      if (tl.length) return { done: false, target: tl, note: "町域にチェック: " + towns.join("・") };
    }
    return { done: false, target: [okBtn], note: "「確定」を押す（区ごとに1回）" };
  }
  function stationLabelHit(l, stations) {
    var nt = norm((l.textContent || "").trim());
    return stations.some(function (sn) {
      return Plan.getStationAliases(sn).some(function (a) {
        var nn = norm(a);
        if (nt === nn) return true;
        return nt.length <= 8 && nt.indexOf(nn) >= 0 && (nt.length - nn.length) <= 1;
      });
    });
  }
  function evalLines(s) {
    var r = readRow("stations");
    var keys = wantStationKeys(s.stations);
    var matched = r.chips.filter(function (c) { return keys[stationKey(c.name)]; });
    var enough = s.stations.length && !s.selectAll ? matched.length > 0 : r.chips.length > 0;
    var dlg = openDialog();
    if (!dlg && enough) return { done: true };
    if (!dlg) {
      var fb = r.f ? r.f.btn : (r.def ? filterBtn(r.def) : null);
      return { done: false, target: [fb], note: "「路線・駅で絞り込み」を押して小窓を開く" };
    }
    if (dlg.querySelector('input[name="regionName"]')) return { done: false, target: [closeBtnOf(dlg)], note: "所在地の小窓が開いています。閉じてください" };
    var cb = [].slice.call(dlg.querySelectorAll("label")).filter(function (l) { var i = inputOf(l); return i && i.type === "checkbox" && visible(l); });
    if (!cb.length) {
      var nav = [navByText(dlg, "近畿"), navByText(dlg, "大阪府")].filter(Boolean);
      return { done: false, target: nav, note: "「近畿」→「大阪府」の順に押すと路線が出ます" };
    }
    var isLine = function (l) { return s.lines.some(function (n) { return textMatch(l.textContent, n); }); };
    var st = cb.filter(function (l) {
      if (isLine(l) || isChecked(l)) return false;
      return s.selectAll ? !/線|電鉄|鉄道|モノレール/.test(sq(l.textContent)) : stationLabelHit(l, s.stations);
    });
    if (st.length) return { done: false, target: st, note: "光っている駅にチェック（" + st.length + "駅）" };
    var ln = cb.filter(function (l) { return isLine(l) && !isChecked(l); });
    if (ln.length) return { done: false, target: ln, note: "光っている路線を押すと、その路線の駅が出ます（" + ln.length + "路線）" };
    return { done: false, target: [btnByText(dlg, "確定")], note: "選び終えたら「確定」" };
  }
  // 検索のボタン（itandi-page-script.js _itSearchBtn と同じ・案内の枠と小窓の中は除く）
  function searchBtn() {
    var n = sq("検索");
    var bs = [].slice.call(document.querySelectorAll("button")).filter(function (b) { return visible(b) && !mine(b) && !inDialog(b); });
    return bs.filter(function (b) { return sq(b.textContent) === n; })[0] || bs.filter(function (b) { return sq(b.textContent).indexOf(n) >= 0 && !/条件|保存/.test(b.textContent); })[0] || null;
  }
  // 検索のボタンの近くの赤い文（itandi-page-script.js _itBlockTexts と同じ見分け）
  function blockTexts() {
    var out = [];
    try {
      [].slice.call(document.querySelectorAll("p, span, div, li")).forEach(function (el) {
        if (out.length >= 8 || el.children.length > 2 || mine(el)) return;
        var t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 120) return;
        if (/正しく入力されていない|で入力して下さい|で入力してください|桁以内|該当物件数が多すぎ|件以内になるように/.test(t) && visible(el) && out.indexOf(t) < 0) out.push(t);
      });
    } catch (e) {}
    return out;
  }

  // ── 光らせる（ページの要素には触らず、上に枠を重ねる）──
  var layer = null;
  function ensureLayer() {
    if (layer && document.body.contains(layer)) return layer;
    if (!document.getElementById("axlx-itandi-guide-style")) {
      var st = document.createElement("style");
      st.id = "axlx-itandi-guide-style";
      st.textContent = "@keyframes axlxItGlow{0%{box-shadow:0 0 0 3px rgba(255,179,0,.95),0 0 14px 6px rgba(255,179,0,.55)}50%{box-shadow:0 0 0 3px rgba(255,179,0,.95),0 0 26px 12px rgba(255,179,0,.25)}100%{box-shadow:0 0 0 3px rgba(255,179,0,.95),0 0 14px 6px rgba(255,179,0,.55)}}"
        + ".axlx-it-glow{position:fixed;pointer-events:none;border-radius:6px;z-index:2147483600;animation:axlxItGlow 1.2s ease-in-out infinite}"
        + ".axlx-it-tip{position:fixed;pointer-events:none;z-index:2147483601;background:#ff8f00;color:#fff;font:bold 12px/1.4 sans-serif;padding:4px 8px;border-radius:6px;max-width:320px;box-shadow:0 2px 6px rgba(0,0,0,.3)}";
      (document.head || document.documentElement).appendChild(st);
    }
    layer = document.createElement("div");
    layer.id = LAYER_ID;
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
      if (r.width <= 0 && r.height <= 0) return;
      var g = document.createElement("div");
      g.className = "axlx-it-glow";
      g.style.left = (r.left - 4) + "px"; g.style.top = (r.top - 4) + "px";
      g.style.width = (r.width + 8) + "px"; g.style.height = (r.height + 8) + "px";
      L.appendChild(g);
      if (!first) first = r;
    });
    if (label) {
      var tip = document.createElement("div");
      tip.className = "axlx-it-tip";
      var vh = window.innerHeight;
      if (!first) { tip.style.left = "16px"; tip.style.top = "16px"; tip.textContent = label; }
      else if (first.bottom < 0) { tip.style.left = Math.max(8, first.left) + "px"; tip.style.top = "8px"; tip.textContent = "↑ 上にあります: " + label; }
      else if (first.top > vh) { tip.style.left = Math.max(8, first.left) + "px"; tip.style.top = (vh - 40) + "px"; tip.textContent = "↓ 下にあります: " + label; }
      else { tip.style.left = Math.max(8, first.left) + "px"; tip.style.top = Math.max(8, first.top - 30) + "px"; tip.textContent = label; }
      L.appendChild(tip);
    }
  }

  // ── 案内の枠（既定は右上・右下は itandi-bulk-dl.js の「売上番長に送る」のバー）──
  //   リアプロの枠と同じく見出し（⠿）をつかんで動かせる・置いた場所はこの PC の localStorage（axlx_itandi_guide_pos）に覚える（枠の位置だけ・サイトには触らない）
  var panel = null;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function renderPanel(cur, curEval) {
    if (!document.body) return;
    if (!panel || !document.body.contains(panel)) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.style.cssText = "position:fixed;right:12px;top:12px;z-index:2147483602;width:300px;background:#fff;border:2px solid #ff8f00;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.25);font:12px/1.5 sans-serif;color:#263238;padding:8px 10px;";
      try {
        var pos = JSON.parse(localStorage.getItem("axlx_itandi_guide_pos") || "null");
        if (pos && pos.left >= 0 && pos.top >= 0 && pos.left < window.innerWidth - 40 && pos.top < window.innerHeight - 40) {
          panel.style.left = pos.left + "px"; panel.style.top = pos.top + "px"; panel.style.right = "auto";
        }
      } catch (_) {}
      panel.addEventListener("click", onPanelClick);
      panel.addEventListener("mousedown", onPanelDragStart);
      document.body.appendChild(panel);
    }
    var head = '<div data-drag="1" title="つかんで動かせます" style="display:flex;align-items:center;gap:6px;margin-bottom:4px;cursor:move;user-select:none"><b data-drag="1" style="flex:1;color:#e65100">⠿ 🔦 ITANDI 案内モード（入力・検索はスタッフ）</b>'
      + '<button data-a="mode" style="font-size:11px;padding:1px 6px;border-radius:9px;border:1px solid #ccc;background:' + (guideOn ? "#fff3e0" : "#eceff1") + '">' + (guideOn ? "ON" : "OFF") + "</button></div>";
    if (!guideOn) { panel.innerHTML = head + '<div style="color:#78909c">OFF の間は今まで通り拡張が入力します</div>'; return; }
    if (!session) { panel.innerHTML = head + '<div style="color:#78909c">拡張でお客様を選んで ITANDI の検索を押すと、ここに手順が出ます</div>'; return; }
    if (session.stage === "results") {
      panel.innerHTML = head + '<div><b>' + esc(session.customerName || "") + '</b> の検索結果</div>'
        + '<div style="color:#455a64">物件にチェックして「📤 売上番長に送る」を押してください（自動では送りません・「全ページ送る」は案内モードの間は止めています）</div>'
        + '<div style="margin-top:6px;display:flex;gap:6px"><button data-a="end" style="flex:1">案内を終える</button></div>';
      return;
    }
    var rows = (plan ? plan.steps : []).map(function (s) {
      var ev = evalStep(s);
      var isCur = cur && cur.id === s.id;
      return '<div style="' + (isCur ? "font-weight:bold;color:#e65100" : ev.done ? "color:#9e9e9e" : "") + '">' + (ev.done ? (ev.missing ? "－" : "✓") : isCur ? "▶" : "・") + " " + esc(s.label) + (ev.done && ev.missing ? "（この画面に無い欄）" : "") + "</div>";
    }).join("");
    var locNote = plan && plan.location === "none" ? '<div style="color:#c62828">所在地・路線/駅の条件がありません（自動入力でも検索しない形です）</div>' : "";
    panel.innerHTML = head + '<div style="margin-bottom:4px"><b>' + esc(session.customerName || "") + "</b></div>" + locNote
      + '<div style="max-height:220px;overflow:auto;border-top:1px solid #eee;padding-top:4px">' + rows + "</div>"
      + (curEval && curEval.note ? '<div style="margin-top:4px;color:#c62828">' + esc(curEval.note) + "</div>" : "")
      + '<div style="margin-top:6px;display:flex;gap:6px"><button data-a="skip" style="flex:1">この手順は済み</button><button data-a="end" style="flex:1">案内をやめる</button></div>';
  }
  function onPanelDragStart(e) {
    if (!e.target || !e.target.getAttribute || e.target.getAttribute("data-drag") !== "1" || !panel) return;
    var r = panel.getBoundingClientRect();
    var offX = e.clientX - r.left, offY = e.clientY - r.top;
    function move(ev) {
      var left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - offX));
      var top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY));
      panel.style.left = left + "px"; panel.style.top = top + "px"; panel.style.right = "auto";
    }
    function up() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      try { var b = panel.getBoundingClientRect(); localStorage.setItem("axlx_itandi_guide_pos", JSON.stringify({ left: Math.round(b.left), top: Math.round(b.top) })); } catch (_) {}
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    e.preventDefault();
  }
  function onPanelClick(e) {
    var a = e.target && e.target.getAttribute && e.target.getAttribute("data-a");
    if (!a) return;
    if (a === "mode") { try { var o = {}; o[MODE_KEY] = !guideOn; chrome.storage.local.set(o); } catch (_) { applyMode(!guideOn); } return; }
    if (a === "end") { endGuide(); return; }
    if (a === "skip" && session && plan) {
      var cur = currentStep();
      if (cur) { session.done = session.done || {}; session.done[cur.step.id] = true; saveSession(); tick(); }
    }
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
    if (!guideOn || !session || session.stage !== "form" || !plan) { clearHighlight(); renderPanel(); return; }
    var cur = currentStep();
    if (!cur) { clearHighlight(); renderPanel(); return; }
    highlight(cur.ev.target, cur.step.label + (cur.ev.note ? "（" + cur.ev.note + "）" : ""));
    renderPanel(cur.step, cur.ev);
  }
  setInterval(tick, 400);
  window.addEventListener("scroll", tick, true);
  window.addEventListener("resize", tick);

  // スタッフが押した物を見る（押した要素を読むだけ）: 検索
  document.addEventListener("click", function (e) {
    if (!session || session.stage !== "form" || !plan) return;
    var cur = currentStep();
    if (!cur || cur.step.kind !== "search") return;
    var tgt = (cur.ev.target || [])[0];
    if (tgt && (tgt === e.target || tgt.contains(e.target))) {
      session.stage = "results"; session.at = Date.now(); saveSession(); clearHighlight(); renderPanel();
    }
  }, true);

  // ── ① itandi-page-script.js から: 案内を始める ──
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.from !== "axlx-itandi-guide-start" || !Plan) return;
    var c = e.data.conditions || {};
    session = { customerId: e.data.customerId || c.customer_id || null, customerName: c.customer_name || c.name || "", conditions: c, stage: "form", done: {}, at: Date.now() };
    plan = Plan.buildPlan(c);
    saveSession();
    tick();
    // お客様の ID・名前が条件に無い時（一括・URL の道）は、拡張が選んでいる今のお客様で補う
    if (!session.customerId || !session.customerName) {
      var s0 = session;
      try {
        chrome.storage.local.get(["current_customer_id", "current_customer_name"], function (r) {
          if (session !== s0 || !r) return;
          if (!session.customerId && r.current_customer_id) session.customerId = String(r.current_customer_id);
          if (!session.customerName && r.current_customer_name) session.customerName = String(r.current_customer_name);
          saveSession(); renderPanel();
        });
      } catch (_) {}
    }
  });

  // 案内モードの間は、拡張がページを自動でめくって送る「全ページ送る」を止める（押せない）。「売上番長に送る」（このページのチェックした物）は今まで通り
  function lockAutoPaging() {
    var b = document.getElementById("axlx-itandi-all-pages-btn");
    if (!b) return;
    b.disabled = !!guideOn;
    b.title = guideOn ? "案内モードの間は使えません（ページはスタッフがめくる）" : "";
    b.style.opacity = guideOn ? "0.4" : "";
  }
  new MutationObserver(function () { lockAutoPaging(); }).observe(document.documentElement, { childList: true, subtree: true });

  // 案内モードの設定を読む（変数をすべて用意した後＝ファイルの最後で読む）
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
      if (session.stage === "form" && Plan) plan = Plan.buildPlan(session.conditions || {});
      tick();
    });
  } catch (_) {}
})();
