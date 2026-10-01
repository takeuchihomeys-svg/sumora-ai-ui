(function () {
  "use strict";

  // 2026-09-27 竹内「拡張ツールは人間らしい動きをするために全て時間ランダムにする」: 固定の数字の待ちを共通の関数で散らす。
  //   human-wait.js（self.AxlxHumanWait）は manifest の同じ world:MAIN の段で先に読む。読めない時は元の値で動く。
  //   _hd＝人の操作の間（0.8〜1.5倍）／_sd＝画面が落ち着くのを待つ固定の秒数（元より短くしない）／_pd＝条件を見る間隔（±15%）
  function _hw() { return (typeof self !== "undefined" ? self : window).AxlxHumanWait; }
  function _hd(ms) { var H = _hw(); return H ? H.humanDelay(ms) : ms; }
  function _sd(ms) { var H = _hw(); return H ? H.settleDelay(ms) : ms; }
  function _pd(ms) { var H = _hw(); return H ? H.pollDelay(ms) : ms; }

  // v2.5.45 ITANDI のフォームの決まり（itandi-form-guard.js・同じ world:MAIN の段で先に読む）。読めない時は旧の動き
  function _itFG() { return (typeof self !== "undefined" ? self : window).AxlxItandiFormGuard; }

  function setReactVal(el, val) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, String(val));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // v2.5.45 人が欄を打ち終えて離れた形（focusout）。ITANDI の入力の確かめ（「5桁以内」等の赤い文）は欄を離れた時に出し直す
  function _itLeave(el) { try { el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); el.dispatchEvent(new FocusEvent("blur")); } catch (e) {} }

  function tick(el) {
    if (el && !el.checked) el.click();
  }

  function norm(s) {
    return String(s)
      .replace(/（/g, "(").replace(/）/g, ")")
      .replace(/〜/g, "~").replace(/～/g, "~")
      .replace(/　/g, " ")
      .trim();
  }

  // itandi BB での駅名表記ゆれ対応（漢字↔ひらがな・別称）
  var ITANDI_STATION_ALIAS_MAP = {
    "難波":       ["難波", "なんば"],
    "なんば":     ["なんば", "難波"],
    "大阪難波":   ["大阪難波", "難波", "なんば"],
    "天王寺":     ["天王寺", "大阪阿部野橋"],
    "大阪阿部野橋": ["大阪阿部野橋", "天王寺"],
    "北浜":       ["北浜", "大阪北浜"],
    "大阪北浜":   ["大阪北浜", "北浜"],
  };
  function getStationAliases(name) {
    return ITANDI_STATION_ALIAS_MAP[name] || [name];
  }

  function isTargetStation(lblText, stNames) {
    var t = lblText.replace(/駅$/, "").trim();
    return stNames.some(function(sn) {
      return getStationAliases(sn).some(function(alias) {
        return norm(alias) === norm(t);
      });
    });
  }

  function isVis(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function textMatch(elText, search) {
    var t = norm(elText);
    var n = norm(search);
    return t === n || t.includes(n);
  }

  // label内のcheckboxを優先（React対応）
  // container: 検索スコープ（省略時はdocument全体。ダイアログ内操作時は必ず渡す）
  function clickLabel(text, container) {
    var root = container || document;
    var lbl = [].slice.call(root.querySelectorAll("label")).find(function (l) {
      return textMatch(l.textContent, text) && isVis(l);
    });
    if (!lbl) return false;
    var inp = lbl.querySelector("input[type='checkbox']");
    if (!inp && lbl.htmlFor) inp = document.getElementById(lbl.htmlFor);
    if (inp) {
      if (!inp.checked) inp.click();
    } else {
      lbl.click();
    }
    return true;
  }

  // ── 検索の点検（2026-09-25 竹内「検索がちゃんとされていなかったら原因を見つけられるようにする」）──
  // popup が conditions._audit_run_id を載せた時（＝ブレインの時）だけ、押せなかった路線・駅（最後に試した路線・ラベル数・見本）・
  // 部品・リセットの失敗と、検索ボタンを押す直前のフォームの読み戻し（このファイルが値を入れている name だけ）を fill-done の audit に載せる。
  // 駅は「路線ごとに全駅名を試す」ので、1路線で見つからないのは普通 → 最後まで1度も押せなかった駅だけを「押せなかった」にする
  var _itAudit = null;
  var _itRunId = null;
  var _itDiag = {}; // 正規化した駅名 → 最後に見つからなかった時の { line, label_count, sample }
  function _itAuditReset(runId) {
    _itRunId = runId || null;
    _itDiag = {};
    _itAudit = _itRunId ? { v: 1, site: "itandi", search_clicked: null, form: null, stations_ok: [], stations_missing: [], lines_missing: [], click_fails: [], reset_fail: null, reset: null, area_path: null, fallback: null, steps: [] } : null;
  }
  function _itStep(k, d) {
    if (!_itAudit) return;
    _itAudit.steps.push({ at: Date.now(), k: String(k).slice(0, 30), d: d == null ? null : String(d).slice(0, 120) });
    if (_itAudit.steps.length > 20) _itAudit.steps.shift();
  }
  function _itReadForm() {
    var f = {};
    try {
      var v = function (name) { var el = document.querySelector('input[name="' + name + '"]'); return el ? el.value : undefined; };
      var r = v("rent:lteq"); if (r !== undefined) f.rent_max = r;
      var rm = v("rent:gteq"); if (rm !== undefined) f.rent_min = rm;
      var w = v("station_walk_minutes:lteq"); if (w !== undefined) f.walk = w;
      var a = v("building_age:lteq"); if (a !== undefined) f.age = a;
      f.layouts = [].slice.call(document.querySelectorAll("input[name='room_layout:in']:checked")).map(function (x) { return String(x.id || x.value || ""); }).slice(0, 20);
      // v2.5.34: 「募集条件更新 N日以内」の欄に見えている文字（""＝なし）。欄が見つからない時は入れない（サーバーは比べない）
      //   名前だけで見つけた欄（how="name"）は打っていないので読まない（別の欄の値を更新日と取り違えない）
      var ud = _itFindUpdateDaysField();
      if (ud && ud.how === "label") f.update_days = String(ud.el.value == null ? "" : ud.el.value).slice(0, 20);
    } catch (e) { f.read_error = String((e && e.message) || e).slice(0, 100); }
    return f;
  }

  // ── 募集条件更新 N日以内（v2.5.34・itandi-update-days.js）──
  // 2026-09-27 竹内「リアプロはボタンで選択やけど ITANDI は入力となる（更新日）」: リアプロと同じ日数（cond.rp_update_days）を欄に打つ。
  //   日数が無い時は空のまま（前の値が残っていたら空にする）。入った値を読み直してから検索を押す（ずれたまま押さない）
  function _itUD() { return (typeof self !== "undefined" ? self : window).AxlxItandiUpdateDays; }
  function _itFindUpdateDaysField() {
    var UD = _itUD();
    if (!UD) return null;
    // 探す範囲は検索フォーム（一覧の表まで textContent を読まない）。フォームが分からない時は body
    var rentEl = document.querySelector('input[name="rent:lteq"]');
    var formEl = rentEl && rentEl.closest ? rentEl.closest("form") : null;
    return UD.findField(formEl || document.body);
  }
  function _itUpdateDaysEnv() {
    return {
      later: function (fn, ms) { setTimeout(fn, ms); },
      hd: _hd, sd: _sd,
      setVal: function (el, v) {
        var proto = String(el.tagName).toUpperCase() === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(v));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      fire: function (el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); },
      // 人が欄を押した形（mousedown → focus → mouseup → click）。一覧（MUI の Autocomplete）は mousedown で開く
      press: function (el) {
        ["mousedown", "mouseup", "click"].forEach(function (t, i) {
          el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
          if (i === 0 && el.focus) el.focus();
        });
      },
      click: function (el) { el.click(); },
      // ⚠ Escape で閉じない（178行目）。欄を離れて閉じる
      blur: function (el) { if (el.blur) el.blur(); },
      options: function (el) {
        var lbId = el.getAttribute && (el.getAttribute("aria-controls") || el.getAttribute("aria-owns"));
        var lb = lbId ? document.getElementById(lbId) : null;
        return [].slice.call((lb || document).querySelectorAll('[role="option"]')).filter(isVis);
      },
    };
  }
  // next(ok, errMsg): ok=false の時だけ検索を押さない（前の値が残って空にもできない）
  function _itFillUpdateDays(cond, next) {
    var UD = _itUD();
    var want = UD ? UD.normDays(cond && cond.rp_update_days) : null;
    var rec = function (o) { if (_itAudit) _itAudit.update_days = o; _itStep("update_days", o.status + (o.want != null ? ":" + o.want : "")); };
    if (!UD) { rec({ status: "module_missing", want: null }); next(true); return; }
    var found = null;
    try { found = _itFindUpdateDaysField(); } catch (e) { found = null; }
    // v2.5.34 反証の検証: 名前だけで見つけた欄（how="name"）には打たない（別の欄に日数を打つおそれ）。name だけ記録して、欄が無い扱い
    if (!found || found.how !== "label") {
      if (want !== null) console.warn("[AX] itandi 募集条件更新の欄が見つかりません（" + want + "日以内を入れずに検索）" + (found ? " 名前の候補=" + found.name : ""));
      rec({ status: want === null ? "no_field" : "field_missing", want: want, how: found ? found.how : null, name: found ? found.name : null });
      next(true); return;
    }
    // 途中で例外が出ても検索は止めない（点検に error を残して次へ）。next は1回だけ呼ぶ
    var settled = false;
    var env = _itUpdateDaysEnv();
    var onErr = function (e) {
      if (settled) return; settled = true;
      console.warn("[AX] itandi 募集条件更新の入力で例外:", e);
      rec({ status: "error", want: want, how: found.how, error: String((e && e.message) || e).slice(0, 100) });
      next(true);
    };
    env.later = function (fn, ms) { setTimeout(function () { if (settled) return; try { fn(); } catch (e) { onErr(e); } }, ms); };
    try { UD.run(found.el, want, env, function (r) {
      if (settled) return; settled = true;
      r.how = found.how; r.name = found.name;
      rec(r);
      console.log("[AX] itandi 募集条件更新:", want === null ? "なし" : want + "日以内", "→", r.status, "（欄=" + (r.got || "空") + "）");
      if (r.status === "stuck") next(false, "itandi 募集条件更新の欄に前の値（" + r.got + "）が残り空にできない");
      else next(true);
    }); } catch (e) { onErr(e); }
  }
  function _itPack() {
    if (!_itAudit) return null;
    try {
      var a = _itAudit;
      if (JSON.stringify(a).length > 8000) {
        a = JSON.parse(JSON.stringify(a));
        ["stations_missing", "lines_missing", "click_fails"].forEach(function (k) { a[k] = (a[k] || []).slice(0, 6).map(function (m) { if (m && m.sample) m.sample = m.sample.slice(0, 3); return m; }); });
        a.stations_ok = (a.stations_ok || []).slice(0, 20);
        a.steps = (a.steps || []).slice(-8);
        if (a.reset && a.reset.after) { a.reset.after.stations = (a.reset.after.stations || []).slice(0, 15); a.reset.after.unmatched_stations = (a.reset.after.unmatched_stations || []).slice(0, 5); }
        a.truncated = true;
      }
      return a;
    } catch (e) { return { v: 1, site: "itandi", pack_error: true }; }
  }
  function _itLabelSample(root, n) {
    try {
      return [].slice.call((root || document).querySelectorAll("label")).filter(function (l) { return l.querySelector("input[type='checkbox']"); })
        .map(function (l) { return l.textContent.replace(/\s+/g, "").slice(0, 20); }).slice(0, n || 6);
    } catch (e) { return []; }
  }
  function _itLabelCount(root) {
    try { return [].slice.call((root || document).querySelectorAll("label")).filter(function (l) { return l.querySelector("input[type='checkbox']"); }).length; } catch (e) { return null; }
  }

  // buttonのみ。完全一致 → 部分一致フォールバック
  function clickBtn(text) {
    var n = norm(text);
    var btns = [].slice.call(document.querySelectorAll("button")).filter(isVis);
    // 完全一致
    var found = btns.find(function (b) { return norm(b.textContent) === n; });
    if (found) { found.click(); return true; }
    // 部分一致フォールバック（ボタンテキストに検索語が含まれる）
    found = btns.find(function (b) { return norm(b.textContent).includes(n); });
    if (found) {
      console.log("[AXLX] clickBtn partial match: '" + text + "' → '" + found.textContent.trim() + "'");
      found.click(); return true;
    }
    // デバッグ: 表示中の全ボタンテキストを出力
    console.log("[AXLX] clickBtn not found: '" + text + "'. Visible buttons:", btns.map(function(b){ return "'" + b.textContent.trim().slice(0,40) + "'"; }).join(", "));
    return false;
  }

  // ナビタブ（li/button/a/span/label）。完全一致 → 部分一致フォールバック
  // itandiの地域・都道府県タブはLABELタグ（診断で確認済み）
  function clickNav(text) {
    var n = norm(text);
    var els = [].slice.call(document.querySelectorAll("li, button, a, span, label, div[role='button']")).filter(isVis);
    // 完全一致
    var found = els.find(function (el) { return norm(el.textContent) === n; });
    if (found) { found.click(); return true; }
    // 部分一致フォールバック
    found = els.find(function (el) { return norm(el.textContent).includes(n); });
    if (found) {
      console.log("[AXLX] clickNav partial match: '" + text + "' → '" + found.textContent.trim() + "'");
      found.click(); return true;
    }
    return false;
  }

  // ── 所在地モーダル ───────────────────────────────────────────────────────
  // itandi診断済みDOM: LABEL.itandi-bb-ui__InputRadio + input[type=radio]
  //   近畿: name=regionName / 大阪府: name=prefectureId / 区市: name=''
  // 戻り値: boolean（モーダルを開けたか）
  // 市区町村ラジオはname=""の同一グループ → 1区1モーダルで順番に開いてチップを積み上げる方式
  // wardTownMap: { "大阪市城東区": ["稲田本町","稲田新町"], "東大阪市": ["川保本町"] } または null
  // 確定クリック → 1500ms後もモーダルが残っていたら閉じるボタンをクリック
  // ⚠️ Escapeキーは絶対に使わない: itandiのグローバルkeydownがReact状態を壊すため
  function safeConfirm(afterClose) {
    clickBtn("確定");
    setTimeout(function () {
      // dialog内にregionNameが残っている = モーダルが本当に閉じていない
      var dialog = document.querySelector('[role="dialog"]');
      var stuck  = dialog && dialog.querySelector('input[name="regionName"]');
      if (stuck) {
        console.log("[AX] safeConfirm: モーダルが閉じていない → 閉じるボタンをクリック");
        var closeBtn = (dialog.querySelector('button[aria-label="閉じる"]'))
                    || (dialog.querySelector('button[aria-label="close"]'))
                    || (dialog.querySelector('button[aria-label="Close"]'))
                    || document.querySelector('button[aria-label="閉じる"]');
        if (closeBtn) {
          closeBtn.click();
          console.log("[AX] safeConfirm: 閉じるボタンをクリック");
        } else {
          console.warn("[AX] safeConfirm: 閉じるボタン未発見 → 確定を再試行");
          clickBtn("確定");
        }
      }
      // モーダル消失を最大3秒ポーリング（固定1000ms待機の競合を回避）
      var _m12elapsed = 0;
      var _m12poll = setInterval(function() {
        _m12elapsed += 100;
        var dlg = document.querySelector('[role="dialog"]');
        if (!dlg || !dlg.offsetParent) {
          clearInterval(_m12poll);
          afterClose();
        } else if (_m12elapsed >= 3000) {
          clearInterval(_m12poll);
          afterClose(); // タイムアウトでも進める
        }
      }, 100);
    }, _sd(1500));
  }

  function selectItandiArea(wardNamesInput, wardTownMap, townAreaFallback, onDone) {
    var wardNames = Array.isArray(wardNamesInput) ? wardNamesInput : (wardNamesInput ? [wardNamesInput] : []);
    if (!wardNames.length) return false;

    // 同一市の全区が対象かつ町域指定なし → 1回のモーダルで全区を一括チェック
    function getCityPrefix(w) {
      var m = w.match(/^([^\s　]+?[市])/);
      return m ? m[1] : null;
    }
    var batchCity = (function() {
      // ★ 修正(Bug1): batchモードは「明示的な市全域指定（1件）」のみで発火させる。
      // 旧実装は「同一市の区が2件以上・町域なし」でも市全域バッチを発火させており、
      // 例: ["大阪市西区","大阪市西淀川区","大阪市淀川区"] → batchCity="大阪市" となり
      // openBatchCityModal が「大阪市」で始まる全24区を無差別クリックして
      // 指定外の区まで選択されるバグがあった。複数区は1区ずつモード（openNextWardModal）で処理する。
      if (wardNames.length === 1) {
        var single = wardNames[0];
        // 「〇〇市内」パターン（popup.jsが展開できなかった市全域指定）
        var mInner = single.match(/^([^\s　]+?[市])(内)$/);
        if (mInner) return mInner[1];
        // 「〇〇市」（区・町・村を含まない純粋な市名）
        if (/^[^\s　]+[市]$/.test(single) && !/[区町村]/.test(single)) return single;
      }
      return null;
    })();

    // 市全域バッチ選択: 1回のモーダルで全区チェックボックスをまとめて選択
    function openBatchCityModal() {
      var opened = clickBtn("所在地で絞り込む") || clickBtn("所在地を絞り込む")
                || clickBtn("所在地で絞り込み") || clickBtn("エリアで絞り込む")
                || clickBtn("エリアを絞り込む") || clickBtn("エリアで絞り込み")
                || clickBtn("地域で絞り込む") || clickBtn("地域を絞り込む")
                || clickBtn("地域で絞り込み");
      if (!opened) {
        console.log("[AX] batchCity: modal button not found, fallback to one-by-one");
        openNextWardModal(); return;
      }
      setTimeout(function() {
        clickItandiRadio("近畿");
        setTimeout(function() {
          clickItandiRadio("大阪府") || clickItandiRadio("大阪");
          // 大阪府クリック後、区リストのレンダリングをポーリングで待つ
          var npfx = norm(batchCity);
          var pollTries = 0;
          function pollForWardLabels() {

            // 標準label検索（name=""の区radioも含む）
            var labels = [].slice.call(document.querySelectorAll("label")).filter(function(l) {
              var inp = l.querySelector("input[type='radio'], input[type='checkbox']");
              if (!inp) return false;
              var ltxt = norm(l.textContent.trim());
              return ltxt.startsWith(npfx) && !ltxt.startsWith(norm("大阪府")) && !ltxt.startsWith(norm("近畿"));
            });
            // フォールバック: input[name=""]（ITANDI区radio固有構造）で再検索
            if (labels.length === 0) {
              [].slice.call(document.querySelectorAll('input[type="radio"][name=""]')).forEach(function(inp) {
                var pl = inp.closest ? inp.closest("label") : inp.parentElement;
                if (pl && norm(pl.textContent.trim()).startsWith(npfx)) {
                  if (labels.indexOf(pl) === -1) labels.push(pl);
                }
              });
            }
            console.log("[AX] batchCity poll" + (pollTries + 1) + ": " + batchCity + " → " + labels.length + "件");
            if (labels.length > 0) {
              // 各区を500-900ms間隔（ランダム）でクリック（ITANDIのJS処理を待つため）
              var clickIdx = 0;
              function clickNextWardLabel() {
                if (clickIdx >= labels.length) {
                  console.log("[AX] batchCity: 全" + labels.length + "区クリック完了 → 確定");
                  setTimeout(function() {
                    safeConfirm(function() { onDone(); });
                  }, 700 + Math.floor(Math.random() * 400));
                  return;
                }
                var l = labels[clickIdx++];
                l.click();
                console.log("[AX] batchCity: クリック " + clickIdx + "/" + labels.length + ": " + l.textContent.trim());
                // 8%の確率で追加ポーズ（800-1500ms）、それ以外は500-900ms
                var _wardDelay = (Math.random() < 0.08)
                  ? (800 + Math.floor(Math.random() * 700))
                  : (500 + Math.floor(Math.random() * 400));
                setTimeout(clickNextWardLabel, _wardDelay);
              }
              clickNextWardLabel();
            } else if (pollTries++ < 15) {
              setTimeout(pollForWardLabels, _pd(400)); // 400ms×15回=最大6秒待機（平均は同じ）
            } else {
              console.warn("[AX] batchCity: 6秒タイムアウト → 1件ずつに切り替え");
              safeConfirm(function() { openNextWardModal(); });
            }
          }
          setTimeout(pollForWardLabels, _hd(500));
        }, 700 + Math.floor(Math.random() * 400)); // 近畿クリック後 700-1100ms
      }, 1800 + Math.floor(Math.random() * 600)); // モーダル展開後 1800-2400ms
    }

    function clickItandiRadio(text) {
      var n = norm(text);
      var labels = [].slice.call(document.querySelectorAll("label"));
      var found = null;
      for (var i = 0; i < labels.length; i++) {
        if (norm(labels[i].textContent) === n && isVis(labels[i])) { found = labels[i]; break; }
      }
      // ★ 修正(Bug1): 括弧書き（件数等の付加テキスト）を除去して完全一致を再試行
      if (!found) {
        for (var i = 0; i < labels.length; i++) {
          var lt = norm(labels[i].textContent).replace(/[（(].*$/, "");
          if (lt === n && isVis(labels[i])) { found = labels[i]; break; }
        }
      }
      if (!found) {
        // ★ 修正(Bug1): includes判定だと「淀川区」が「西淀川区」「東淀川区」に誤マッチするため、
        // 区町村名で終わる検索語は前方一致（startsWith）のみ許可する
        var isWardTerm = /[区町村]$/.test(n);
        for (var i = 0; i < labels.length; i++) {
          var lt2 = norm(labels[i].textContent);
          var hit = isWardTerm ? lt2.startsWith(n) : lt2.includes(n);
          if (hit && isVis(labels[i])) { found = labels[i]; break; }
        }
      }
      if (!found) return false;
      var inp = found.querySelector("input[type='radio']");
      if (inp && inp.checked) return true;
      found.click();
      return true;
    }

    function getShortName(wName) {
      var s = wName.replace(/^.+?([^\s　市区郡]+[区町村])$/, "$1");
      return s === wName ? null : s;
    }

    var wardIdx = 0;

    // 1区ずつモーダルを開いて確定 → チップが積み上がる方式（ラジオname=""制約の回避）
    function openNextWardModal() {
      if (wardIdx >= wardNames.length) {
        onDone();
        return;
      }
      var wName = wardNames[wardIdx];
      var isLast = wardIdx === wardNames.length - 1;
      // ward_town_map優先。なければtownAreaFallback（後方互換）を最後の区のみ適用
      var townsForWard = null;
      if (wardTownMap && wardTownMap[wName] && wardTownMap[wName].length) {
        townsForWard = wardTownMap[wName];
      } else if (isLast && townAreaFallback) {
        townsForWard = [townAreaFallback];
      }
      wardIdx++;

      var opened = clickBtn("所在地で絞り込む") || clickBtn("所在地を絞り込む")
                || clickBtn("所在地で絞り込み") || clickBtn("エリアで絞り込む")
                || clickBtn("エリアを絞り込む") || clickBtn("エリアで絞り込み")
                || clickBtn("地域で絞り込む") || clickBtn("地域を絞り込む")
                || clickBtn("地域で絞り込み");
      if (!opened) {
        console.log("[AX] selectItandiArea: modal button not found for " + wName);
        setTimeout(openNextWardModal, 800 + Math.floor(Math.random() * 400));
        return;
      }

      setTimeout(function () {
        var regionInp = document.querySelector("input[type='radio'][name='regionName']");
        if (!regionInp || !regionInp.checked) clickItandiRadio("近畿");

        setTimeout(function () {
          var prefInp = document.querySelector("input[type='radio'][name='prefectureId']");
          if (!prefInp || !prefInp.checked) clickItandiRadio("大阪府") || clickItandiRadio("大阪");

          setTimeout(function () {
            var shortName = getShortName(wName);
            var clicked = clickItandiRadio(wName) || (shortName ? clickItandiRadio(shortName) : false);

            function afterWardSelected() {
              if (townsForWard && townsForWard.length) {
                // 全域チェックを外してから個別町域を選択（全域時は個別選択が無効になる）
                setTimeout(function () {
                  var zenLbl = [].slice.call(document.querySelectorAll("label")).find(function (l) {
                    return l.textContent.trim() === "全域" && l.querySelector("input[type='checkbox']") && isVis(l);
                  });
                  var zenInp = zenLbl && zenLbl.querySelector("input");
                  if (zenInp && zenInp.checked) {
                    zenLbl.click();
                    console.log("[AX] 全域チェックを解除");
                  }
                  setTimeout(function () {
                    // 町域checkboxラベルを全取得（スクロール外含む・visibilityチェックなし）
                    var allCbLabels = [].slice.call(document.querySelectorAll("label")).filter(function (l) {
                      return l.querySelector("input[type='checkbox']");
                    });
                    var totalSelected = 0;
                    townsForWard.forEach(function (town) {
                      var tn = norm(town);
                      // スマートマッチ: 完全一致 → 前方一致（〇〇1丁目等）→ 部分一致
                      var matches = allCbLabels.filter(function (l) { return norm(l.textContent.trim()) === tn; });
                      if (!matches.length) {
                        matches = allCbLabels.filter(function (l) { return norm(l.textContent.trim()).startsWith(tn); });
                      }
                      if (!matches.length) {
                        matches = allCbLabels.filter(function (l) { return norm(l.textContent.trim()).includes(tn); });
                      }
                      matches.forEach(function (l) {
                        var inp = l.querySelector("input");
                        if (!inp || !inp.checked) { l.click(); totalSelected++; }
                      });
                      console.log("[AX] 町域選択: " + town + " → " + matches.length + "件");
                    });
                    console.log("[AX] 町域合計: " + totalSelected + "件選択");
                    setTimeout(function () {
                      safeConfirm(function () { setTimeout(openNextWardModal, 700 + Math.floor(Math.random() * 400)); });
                    }, 800 + Math.floor(Math.random() * 400));
                  }, 700 + Math.floor(Math.random() * 400)); // 全域解除後 → 町域チェック開始まで
                }, 700 + Math.floor(Math.random() * 400)); // 区ラジオ選択後 → 全域チェック解除まで
              } else {
                setTimeout(function () {
                  safeConfirm(function () { setTimeout(openNextWardModal, 700 + Math.floor(Math.random() * 400)); });
                }, 700 + Math.floor(Math.random() * 400));
              }
            }

            if (!clicked) {
              console.log("[AX] selectItandiArea: ward not found, retry: " + wName);
              setTimeout(function () {
                var retryResult = clickItandiRadio(wName) || (shortName ? clickItandiRadio(shortName) : false);
                if (!retryResult) {
                  console.warn('[itandi] openNextWardModal: retry failed, aborting');
                  return;
                }
                setTimeout(afterWardSelected, 400 + Math.floor(Math.random() * 300));
              }, 800 + Math.floor(Math.random() * 400));
            } else {
              setTimeout(afterWardSelected, 400 + Math.floor(Math.random() * 300));
            }
          }, 800 + Math.floor(Math.random() * 400)); // 大阪府クリック後 → 区ラジオ選択まで
        }, 700 + Math.floor(Math.random() * 400)); // 近畿クリック後 → 大阪府クリックまで
      }, 1800 + Math.floor(Math.random() * 600)); // モーダル展開後 1800-2400ms
    }

    if (batchCity) {
      openBatchCityModal();
    } else {
      openNextWardModal();
    }
    return true;
  }

  // ── 路線・駅モーダル ─────────────────────────────────────────────────────
  // 戻り値: boolean（モーダルを開けたか）
  // onError: 路線選択失敗時のコールバック（省略時はonDoneにフォールバック）
  // selectAllStations: 「梅田まで電車1本」（popup.js resolveDirectCommute）→ 各路線の駅リストに出た駅をすべて選択する
  function selectItandiLines(lineNames, stationNames, onDone, onError, selectAllStations) {
    if (!lineNames || !lineNames.length) return false;
    var opened = clickBtn("路線・駅で絞り込む") || clickBtn("路線・駅を絞り込む")
              || clickBtn("路線・駅で絞り込み") || clickBtn("路線で絞り込む")
              || clickBtn("路線で絞り込み") || clickBtn("沿線・駅で絞り込む")
              || clickBtn("沿線・駅で絞り込み") || clickBtn("沿線・駅を絞り込む");
    if (!opened) return false;

    var stNames = (stationNames || []).map(function (s) { return s.replace(/駅$/, "").trim(); }).filter(Boolean);
    var _abort = typeof onError === "function" ? onError : onDone;

    // ── ポーリングで近畿→大阪府→路線リスト描画を待つ（固定遅延→ポーリングに置換）──
    var _kinkiPolls = 0;
    function pollKinki() {
      if (clickNav("近畿")) { setTimeout(pollOsaka, _hd(100)); return; }
      if (++_kinkiPolls >= 25) {
        console.warn("[AX] selectItandiLines: 近畿タブ5s未発見 → 中断");
        if (_itAudit) _itAudit.click_fails.push({ what: "line_modal", text: "近畿" });
        _abort(); return;
      }
      setTimeout(pollKinki, _pd(200));
    }
    function pollOsaka() {
      var _p = 0;
      function _poll() {
        if (clickNav("大阪府")) { setTimeout(pollLineList, _hd(100)); return; }
        if (++_p >= 25) {
          console.warn("[AX] selectItandiLines: 大阪府タブ5s未発見 → 中断");
          if (_itAudit) _itAudit.click_fails.push({ what: "line_modal", text: "大阪府" });
          _abort(); return;
        }
        setTimeout(_poll, _pd(200));
      }
      _poll();
    }
    function pollLineList() {
      var _p = 0;
      function _poll() {
        // ダイアログ内のチェックボックスのみ対象（メインフォームの間取り等に誤反応しないため）
        var _dlg = document.querySelector('[role="dialog"]')
                || document.querySelector('[class*="Modal"]')
                || document.querySelector('[class*="modal"]');
        var root = _dlg || document;
        var hasLineLabels = [].slice.call(root.querySelectorAll("label")).some(function(l) {
          return l.querySelector("input[type='checkbox']") && isVis(l);
        });
        if (hasLineLabels && _dlg) { startClickLines(_dlg); return; }
        if (hasLineLabels && !_dlg) {
          console.warn('[itandi] pollLineList: dialog not found, aborting');
          _abort(); return;
        }
        if (++_p >= 25) {
          console.warn("[AX] selectItandiLines: 路線リスト5s未描画 → 中断");
          if (_itAudit) _itAudit.click_fails.push({ what: "line_modal", text: "路線リスト" });
          _abort(); return;
        }
        setTimeout(_poll, _pd(200));
      }
      _poll();
    }
    // 駅ラベル検索（路線名への誤ヒット防止のため完全一致優先）
    // エイリアス全候補を試す（難波↔なんば 等の表記ゆれ対応）
    function tryClickStation(name) {
      var aliases = getStationAliases(name);
      for (var ai = 0; ai < aliases.length; ai++) {
        var n = norm(aliases[ai]);
        var lbl = [].slice.call(document.querySelectorAll("label")).find(function (l) {
          return norm(l.textContent.trim()) === n;
        });
        if (!lbl) {
          lbl = [].slice.call(document.querySelectorAll("label")).find(function (l) {
            var inp = l.querySelector("input[type='checkbox']");
            var txt = l.textContent.trim();
            var nt = norm(txt), nn = norm(n);
            return inp && nt.length <= 8 && nt.includes(nn) && (nt.length - nn.length) <= 1;
          });
        }
        if (lbl) {
          try { lbl.scrollIntoView({ behavior: "instant", block: "nearest" }); } catch (e) {}
          var inp = lbl.querySelector("input[type='checkbox']");
          if (!inp && lbl.htmlFor) inp = document.getElementById(lbl.htmlFor);
          if (inp) { if (!inp.checked) inp.click(); } else { lbl.click(); }
          console.log("[AX] 駅クリック: " + name + (aliases[ai] !== name ? " (alias→" + aliases[ai] + ")" : ""));
          return true;
        }
      }
      return false;
    }

    function startClickLines(dlg) {
      var lineIdx = 0;
      var anyLineClicked = false;
      // ★ 修正: itandi BBは路線ごとに駅リストを切り替えるため、
      // 全路線クリック後まとめて選択しても最後の路線の駅しか選択できないバグを修正。
      // 路線ごとにクリック→1500ms待機→その路線の駅を選択 の順に処理する。
      var _selectedSt = new Set(); // 選択完了した駅の正規化名（重複クリック防止）
      // 駅リストと路線リストはどちらも checkbox 付き label。路線一覧が出た時点のラベル文言を路線として覚え、
      // 駅の全選択ではそれ以外（＝路線クリック後に出た駅）だけを押す。React の再描画でノードが替わっても文言で判定できる
      var _lineLabelTexts = {};
      [].slice.call(dlg.querySelectorAll("label")).forEach(function(l) {
        if (l.querySelector("input[type='checkbox']")) _lineLabelTexts[norm(l.textContent.replace(/\s+/g, ""))] = true;
      });
      var _allSelectedCount = 0;
      function selectAllStationsOfLine(done) {
        var root = document.querySelector('[role="dialog"]') || dlg;
        function stationLabels() {
          return [].slice.call(root.querySelectorAll("label")).filter(function(l) {
            if (!l.querySelector("input[type='checkbox']") || !isVis(l)) return false;
            var t = norm(l.textContent.replace(/\s+/g, ""));
            return t && !_lineLabelTexts[t] && !/線|電鉄|鉄道|モノレール/.test(t);
          });
        }
        var labels = stationLabels();
        if (!labels.length) { console.log("[AX] 電車1本: 駅リストなし（路線のみ選択）"); done(); return; }
        // 「すべて選択」系があれば先に押し、残った未選択だけを1件ずつ押す（全選択後に個別を押してトグル解除しない）
        var allLbl = labels.find(function(l) { return /^(?:全て|すべて|全駅)(?:選択)?$|全選択/.test(norm(l.textContent.replace(/\s+/g, ""))); });
        var i = 0, list = [];
        function clickNext() {
          if (i >= list.length) {
            var checked = stationLabels().filter(function(l) { var inp = l.querySelector("input[type='checkbox']"); return inp && inp.checked; }).length;
            _allSelectedCount += checked;
            console.log("[AX] 電車1本: " + lineNames[lineIdx - 1] + " の駅 " + checked + "/" + stationLabels().length + " 選択");
            done(); return;
          }
          var inp = list[i++].querySelector("input[type='checkbox']");
          if (inp && !inp.checked) inp.click();
          setTimeout(clickNext, 40 + Math.floor(Math.random() * 60));
        }
        function collectAndClick() {
          list = stationLabels().filter(function(l) {
            var inp = l.querySelector("input[type='checkbox']");
            return l !== allLbl && inp && !inp.checked;
          });
          clickNext();
        }
        var allInp = allLbl && allLbl.querySelector("input[type='checkbox']");
        if (allInp && !allInp.checked) { allInp.click(); setTimeout(collectAndClick, _hd(400)); }
        else collectAndClick();
      }
      function clickNextLine() {
        if (lineIdx >= lineNames.length) {
          if (!anyLineClicked) {
            console.warn("[AX] selectItandiLines: 路線が1本も選択できなかった → 中断");
            _abort(); return;
          }
          // 全路線・駅の選択完了 → 確定
          var _missing = selectAllStations ? [] : stNames.filter(function(s) { return !_selectedSt.has(norm(s)); });
          if (selectAllStations) console.log("[AX] 電車1本: 沿線の駅を計" + _allSelectedCount + "駅選択");
          if (_missing.length) console.log("[AX] 選択できなかった駅: " + _missing.join(", "));
          // 検索の点検: 押せた駅・最後まで押せなかった駅（最後に試した路線・ラベル数・見本）
          if (_itAudit) {
            _itAudit.stations_ok = stNames.filter(function (s) { return _selectedSt.has(norm(s)); }).slice(0, 60);
            _missing.slice(0, 20).forEach(function (s) {
              var d = _itDiag[norm(s)] || {};
              _itAudit.stations_missing.push({ name: s, line: d.line || null, label_count: d.label_count != null ? d.label_count : null, sample: d.sample || [] });
            });
            _itStep("lines_done", "路線" + lineNames.length + "・駅 " + _itAudit.stations_ok.length + "/" + stNames.length);
          }
          setTimeout(function () {
            clickBtn("確定");
            setTimeout(onDone, _sd(1500));
          }, 600 + Math.floor(Math.random() * 300));
          return;
        }
        var clicked = clickLabel(lineNames[lineIdx], dlg);
        if (clicked) anyLineClicked = true;
        else if (_itAudit) _itAudit.lines_missing.push({ name: lineNames[lineIdx], label_count: _itLabelCount(dlg), sample: _itLabelSample(dlg, 6) });
        lineIdx++;

        if (selectAllStations) {
          // 路線が見つからなかった時は駅リストが前の路線のままなので押さない
          if (!clicked) { setTimeout(clickNextLine, _hd(300)); return; }
          setTimeout(function() {
            selectAllStationsOfLine(function() { setTimeout(clickNextLine, 400 + Math.floor(Math.random() * 400)); });
          }, 900 + Math.floor(Math.random() * 600));
          return;
        }

        if (!stNames.length) {
          // 駅指定なし → 路線だけ選択して次へ
          setTimeout(clickNextLine, 600 + Math.floor(Math.random() * 400));
          return;
        }

        // 路線クリック後、人間らしいランダム待機（900〜2200ms）してから駅を選択
        setTimeout(function() {
          // 駅を1件ずつランダム遅延でクリック（一気押し防止）
          var _stIdx = 0;
          var _lineKey = lineNames[lineIdx - 1];
          function clickNextStation() {
            if (_stIdx >= stNames.length) {
              // 全駅試行後 → JR駅フォールバック
              stNames.forEach(function(sn) {
                if (!_selectedSt.has(norm(sn)) && sn.startsWith("JR")) {
                  console.log("[AX] 駅未発見(JR駅): " + sn + " → JR沿線フォールバック試行");
                  var jrLabels = [].slice.call(document.querySelectorAll("label")).filter(function(l) {
                    var inp = l.querySelector("input[type='checkbox']");
                    return inp && !inp.checked && norm(l.textContent).includes("JR") && isVis(l);
                  });
                  jrLabels.forEach(function(l) { l.click(); });
                  if (jrLabels.length && tryClickStation(sn)) { _selectedSt.add(norm(sn)); }
                }
              });
              setTimeout(clickNextLine, 500 + Math.floor(Math.random() * 700));
              return;
            }
            var sn = stNames[_stIdx++];
            var _clickedNow = false;
            if (!_selectedSt.has(norm(sn))) {
              if (tryClickStation(sn)) {
                _selectedSt.add(norm(sn));
                _clickedNow = true;
              } else {
                var _diagDlg = document.querySelector('[role="dialog"]') || document;
                var _diagLbls = [].slice.call(_diagDlg.querySelectorAll("label")).filter(function(l) { return l.querySelector("input[type='checkbox']"); });
                console.log("[AX] 駅未発見: " + sn + " | route=" + _lineKey + " | label数=" + _diagLbls.length + " | サンプル:", _diagLbls.slice(0,6).map(function(l){return '"'+l.textContent.replace(/\s+/g,'').slice(0,20)+'"';}).join(', '));
                _itDiag[norm(sn)] = { line: _lineKey, label_count: _diagLbls.length, sample: _diagLbls.slice(0, 6).map(function (l) { return l.textContent.replace(/\s+/g, "").slice(0, 20); }) };
              }
            }
            // 実際に駅を押した時だけ 300〜800ms ランダム待機（人間らしい操作）。
            // 2026-09-14 竹内（SATOKO♪ 事例）「途中で止まって、また動き出す」: 旧は選択済みの駅・この路線に無い駅でも毎回 300〜800ms 待ち、
            //   路線ごとに全駅名を回すため「路線数×駅数×0.55秒」の空回り（何も押さない数十秒）で止まって見え、多い時は 150秒の見張りに掛かっていた。
            //   押していない時は待たずに次へ（押す操作の間隔は変えない）
            setTimeout(clickNextStation, _clickedNow ? 300 + Math.floor(Math.random() * 500) : 0);
          }
          clickNextStation();
        }, 900 + Math.floor(Math.random() * 1300));
      }
      clickNextLine();
    }
    pollKinki();
    return true;
  }

  var STRUCTURE_MAP = {
    "木造": "wooden", "木造一部RC造": "wooden",
    "鉄骨造": "steel", "S造": "steel", "重量鉄骨造": "steel",
    "軽量鉄骨造": "lightweight_steel",
    "鉄筋コンクリート造": "rc", "RC": "rc", "RC造": "rc",
    "鉄骨鉄筋コンクリート造": "src", "SRC": "src", "SRC造": "src",
    "ブロック": "block",
    "鉄筋ブロック": "reinforcing_block",
    "PC": "pc", "PC造": "pc",
    "HPC": "hpc", "HPC造": "hpc",
    "ALC": "alc", "ALC造": "alc",
    "CFT": "cft", "CFT造": "cft",
  };
  // DBキー → itandi BB サイドバーのラベルテキスト（IDセレクタ失敗時のフォールバック用）
  var STRUCTURE_LABEL_MAP = {
    "鉄骨鉄筋コンクリート造": "SRC",
    "鉄筋コンクリート造": "RC",
    "鉄骨造": "鉄骨造",
    "軽量鉄骨造": "軽量鉄骨造",
    "木造": "木造",
    "ブロック": "ブロック",
    "鉄筋ブロック": "鉄筋ブロック",
    "PC": "PC", "PC造": "PC",
    "HPC": "HPC", "HPC造": "HPC",
    "ALC": "ALC", "ALC造": "ALC",
    "CFT": "CFT", "CFT造": "CFT",
    "S造": "鉄骨造", "重量鉄骨造": "鉄骨造",
    "SRC": "SRC", "SRC造": "SRC",
    "RC": "RC", "RC造": "RC",
  };

  var VALID_LAYOUTS = ["1R","1K","1DK","1LDK","2K","2DK","2LDK","3K","3DK","3LDK","4K","4DK","4LDK","5K_OVER"];

  // モーダル完了後に入力する条件（専有面積・築年数・間取り・構造・ペット・駅徒歩）
  function fillRemainingFields(cond) {
    // 専有面積（フィールド名はfloor_area_amount:gteq / lteq）
    if (cond.area_min) {
      var areaMinEl = document.querySelector('input[name="floor_area_amount:gteq"]');
      if (areaMinEl) setReactVal(areaMinEl, cond.area_min);
    }
    if (cond.area_max) {
      var areaMaxEl = document.querySelector('input[name="floor_area_amount:lteq"]');
      if (areaMaxEl) setReactVal(areaMaxEl, cond.area_max);
    }
    if (cond.walk_minutes) {
      var walkEl = document.querySelector('input[name="station_walk_minutes:lteq"]');
      if (walkEl) setReactVal(walkEl, cond.walk_minutes);
    }
    if (cond.building_age) {
      var ageEl = document.querySelector('input[name="building_age:lteq"]');
      if (ageEl) setReactVal(ageEl, cond.building_age);
    }
    if (cond.floor_plan) {
      var FLOOR_RANK_IT = ["1R","1K","1DK","1LDK","2K","2DK","2LDK","3K","3DK","3LDK","4K","4DK","4LDK","5K_OVER"];
      var FLOOR_TEXT_IT = {
        "1R":"1R","ワンルーム":"1R","1K":"1K","1DK":"1DK","1LDK":"1LDK",
        "2K":"2K","2DK":"2DK","2LDK":"2LDK",
        "3K":"3K","3DK":"3DK","3LDK":"3LDK",
        "4K":"4K","4DK":"4DK","4LDK":"4LDK",
        "5K以上":"5K_OVER","5K":"5K_OVER","5K_OVER":"5K_OVER"
      };
      // SLDKはitandiに存在しないため代替間取りIDへ展開
      // 1SLDK → 1LDK + 2DK + 2LDK
      var SLDK_SUBSTITUTE_IT = {
        "1SLDK":["1LDK","2DK","2LDK"],
        "2SLDK":["2LDK","3DK","3LDK"],
        "3SLDK":["3LDK","4DK","4LDK"]
      };
      var SLDK_UPPER_IT = {
        "1SLDK":"2LDK","2SLDK":"3LDK","3SLDK":"4LDK"
      };
      // ID直接選択が失敗した場合（itandi BBがDOM更新でIDを変えた等）にラベルテキストで探すフォールバック
      function tickFloor(id) {
        var el = document.querySelector('input[name="room_layout:in"][id="' + id + '"]');
        if (!el) {
          var labelText = id === "5K_OVER" ? "5K以上" : id;
          var lbl = [].slice.call(document.querySelectorAll("label")).find(function(l) {
            var t = l.textContent.trim().replace(/\s+/g, "");
            return (t === labelText || t === id) && isVis(l);
          });
          if (lbl) {
            el = lbl.querySelector("input[type='checkbox']");
            if (!el && lbl.htmlFor) el = document.getElementById(lbl.htmlFor);
          }
          if (!el) { console.warn("[AX] 間取りCB未発見: " + id); return; }
          console.log("[AX] 間取りCB labelフォールバック成功: " + id);
        }
        tick(el);
      }
      // 短縮表記を正規化: "1L以上" → "1LDK以上"、"2L〜3L" → "2LDK〜3LDK"
      var fpStr = cond.floor_plan.trim().replace(/(\d)L(?!\w)/g, '$1LDK');
      var ijouMatch  = fpStr.match(/^(.+?)以上$/);
      var rangeMatch = fpStr.match(/^(.+?)[～〜](.+?)$/);
      if (ijouMatch) {
        var baseKey = FLOOR_TEXT_IT[ijouMatch[1].trim()] || ijouMatch[1].trim();
        var baseIdx = FLOOR_RANK_IT.indexOf(baseKey);
        if (baseIdx >= 0) {
          for (var ri = baseIdx; ri < FLOOR_RANK_IT.length; ri++) {
            tickFloor(FLOOR_RANK_IT[ri]);
          }
        }
      } else if (rangeMatch) {
        // 「1DK～1LDK」→ 1DKから1LDKまでの範囲を全選択
        var fromRaw = rangeMatch[1].trim();
        var toRaw   = rangeMatch[2].trim();
        if (SLDK_SUBSTITUTE_IT[fromRaw]) {
          // 1SLDK〜2LDK → 1LDK + 2DK + 2LDK
          SLDK_SUBSTITUTE_IT[fromRaw].forEach(function(id) { tickFloor(id); });
          // toFloorが展開上限より上なら残り範囲も追加
          var upperKey = SLDK_UPPER_IT[fromRaw];
          var upperIdx = FLOOR_RANK_IT.indexOf(upperKey);
          var toIdx = FLOOR_RANK_IT.indexOf(FLOOR_TEXT_IT[toRaw] || toRaw);
          if (upperIdx >= 0 && toIdx > upperIdx) {
            for (var ri = upperIdx + 1; ri <= toIdx; ri++) {
              tickFloor(FLOOR_RANK_IT[ri]);
            }
          }
        } else {
          var fromKey = FLOOR_TEXT_IT[fromRaw] || fromRaw;
          var toKey   = FLOOR_TEXT_IT[toRaw]   || toRaw;
          var fromIdx = FLOOR_RANK_IT.indexOf(fromKey);
          var toIdx   = FLOOR_RANK_IT.indexOf(toKey);
          if (fromIdx < 0 || toIdx < 0) {
            console.warn("[AX] itandi rangeMatch: unknown floor plan, skipping", fromKey, toKey);
          } else {
            if (fromIdx > toIdx) { var tmp = fromIdx; fromIdx = toIdx; toIdx = tmp; }
            for (var ri = fromIdx; ri <= toIdx; ri++) {
              tickFloor(FLOOR_RANK_IT[ri]);
            }
          }
        }
      } else {
        // もしくは・または等の接続詞でも分割し、修飾語付き文字列からも間取りを抽出
        var itFloorKeys = Object.keys(FLOOR_TEXT_IT).sort(function(a,b){ return b.length - a.length; });
        function extractFloorIT(token) {
          if (SLDK_SUBSTITUTE_IT[token]) {
            SLDK_SUBSTITUTE_IT[token].forEach(function(id) { tickFloor(id); });
            return null;
          }
          if (FLOOR_TEXT_IT[token]) return FLOOR_TEXT_IT[token];
          for (var ki = 0; ki < itFloorKeys.length; ki++) {
            if (token.indexOf(itFloorKeys[ki]) >= 0) return FLOOR_TEXT_IT[itFloorKeys[ki]];
          }
          return null;
        }
        fpStr.split(/[・,、\/\.\s]+|もしくは|または|もしくわ|あるいは/).forEach(function (plan) {
          plan = plan.trim();
          var id = extractFloorIT(plan);
          if (id && VALID_LAYOUTS.indexOf(id) !== -1) {
            tickFloor(id);
          }
        });
      }
    }
    // 広げて検索：LDK選択済みの場合、同室数DKも追加チェック
    if (cond.is_wide) {
      ["1LDK","2LDK","3LDK","4LDK"].forEach(function(ldk) {
        var ldkEl = document.querySelector('input[name="room_layout:in"][id="' + ldk + '"]');
        if (ldkEl && ldkEl.checked) {
          var dk = ldk.replace("LDK", "DK");
          var dkEl = document.querySelector('input[name="room_layout:in"][id="' + dk + '"]');
          if (dkEl && !dkEl.checked) tick(dkEl);
        }
      });
    }
    if (cond.structure_types && cond.structure_types.length) {
      cond.structure_types.forEach(function (s) {
        var v = STRUCTURE_MAP[s];
        // ① IDセレクタで直接チェック（最安定）
        var el = v ? document.querySelector('input[name="structure_type:in"][id="' + v + '"]') : null;
        if (el) { tick(el); return; }
        // ② ラベルテキストでフォールバック（itandi BB サイドバー上の表示名で探す）
        var labelText = STRUCTURE_LABEL_MAP[s] || s;
        if (clickLabel(labelText)) {
          console.log("[AX] 構造チェック(label):", labelText);
          return;
        }
        // ③ 元のキー名でも試す
        if (labelText !== s) clickLabel(s);
      });
    }
    if (cond.pet_ok) {
      var petEl = document.querySelector('input[name="option_id:all_in"][id="22010"]');
      function tryTickPet() {
        if (petEl) { tick(petEl); return true; }
        // isVis不要で直接探す（セクション折り畳み中でも対応）
        var lbl = [].slice.call(document.querySelectorAll("label")).find(function(l) {
          return l.textContent.trim() === "ペット相談";
        });
        if (!lbl) return false;
        var inp = lbl.querySelector("input[type='checkbox']");
        if (inp) { if (!inp.checked) inp.click(); } else lbl.click();
        console.log("[AX] ペット相談チェック完了");
        return true;
      }
      if (!tryTickPet()) {
        // セクションが折り畳まれている → 「入居条件（その他）」を展開して再試行
        var sectionToggle = [].slice.call(document.querySelectorAll("button,[role='button'],div,li")).find(function(el) {
          return el.textContent.includes("入居条件") && el.textContent.includes("その他") && isVis(el);
        });
        if (sectionToggle) {
          sectionToggle.click();
          setTimeout(function() {
            petEl = document.querySelector('input[name="option_id:all_in"][id="22010"]');
            if (!tryTickPet()) clickLabel("ペット相談");
          }, _sd(700)); // 0.70〜0.95秒。検索を押す待ち（1.0〜1.35秒）より必ず先に終わる（前後が入れ替わらない）
        } else {
          clickLabel("ペット相談");
        }
      }
    }
    if (cond.preferences && /バス.*トイレ別|トイレ別|バストイレ別/i.test(cond.preferences)) {
      var bathEl = document.querySelector('input[name="option_id:all_in"][id="11010"]');
      if (bathEl) tick(bathEl); else clickLabel("バス・トイレ別");
    }
    // 敷金・礼金なし
    if (cond.shikirei_free) {
      var skiLabel = [].slice.call(document.querySelectorAll('label')).find(function(l) {
        var t = l.textContent.replace(/[\s　]/g, '');
        return t === '敷金・礼金なし' || t === '敷金礼金なし' || t === '敷礼なし';
      });
      if (skiLabel) {
        var skiInp = skiLabel.querySelector('input[type="checkbox"]');
        if (skiInp && !skiInp.checked) skiInp.click();
        else if (!skiInp) skiLabel.click();
        console.log('[AX] 敷金・礼金なし チェック完了(itandi)');
      }
    }
  }

  // v2.5.45「条件削除」を押す。確かめの窓（window.confirm）が出る作りでもページが止まらないように、押す間だけ「はい」で答える。
  //   画面の中の確かめ（role=dialog に 削除する/OK/はい）が出たら人と同じくそれを押す（出なければ何もしない）
  function _itClickReset(btn) {
    var _oc = window.confirm;
    try { window.confirm = function () { _itStep("reset_confirm", "confirm"); return true; }; btn.click(); }
    finally { window.confirm = _oc; }
    setTimeout(function () {
      try {
        var dlg = document.querySelector("[role=\"dialog\"]");
        if (!dlg || !isVis(dlg) || dlg.querySelector("input[name=\"regionName\"]")) return;
        var ok = [].slice.call(dlg.querySelectorAll("button")).filter(isVis).find(function (b) { return /^(削除する|削除|OK|はい|実行)$/.test(norm(b.textContent)); });
        if (ok) { ok.click(); _itStep("reset_confirm", norm(ok.textContent).slice(0, 10)); }
      } catch (e) {}
    }, _hd(350));
  }

  // v2.5.45 検索のボタンを押してよいか（件数の数え直しを待つ）。done(null)＝押してよい／done({code, ja})＝押さない
  function _itSearchBtn() {
    var n = norm("検索");
    var btns = [].slice.call(document.querySelectorAll("button")).filter(isVis);
    return btns.find(function (b) { return norm(b.textContent) === n; }) || btns.find(function (b) { return norm(b.textContent).includes(n) && !/条件|保存/.test(b.textContent); }) || null;
  }
  function _itBlockTexts() {
    // 画面の赤い文（検索のボタンの近くの「正しく入力されていない…」「賃料（上限）は5桁以内…」「該当物件数が多すぎます…」）
    var out = [];
    try {
      [].slice.call(document.querySelectorAll("p, span, div, li")).forEach(function (el) {
        if (out.length >= 8 || el.children.length > 2) return;
        var t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 120) return;
        if (/正しく入力されていない|で入力して下さい|で入力してください|桁以内|該当物件数が多すぎ|件以内になるように/.test(t) && isVis(el) && out.indexOf(t) < 0) out.push(t);
      });
    } catch (e) {}
    return out;
  }
  function _itSearchState() {
    var b = _itSearchBtn();
    return { found: !!b, disabled: !!(b && (b.disabled || b.getAttribute("aria-disabled") === "true")), texts: _itBlockTexts(), btn: b };
  }
  function _itWaitSearchReady(done) {
    var FG = _itFG();
    if (!FG) { done(null, _itSearchBtn()); return; }
    var until = Date.now() + FG.SEARCH_READY_WAIT_MS;
    (function look() {
      var st = _itSearchState();
      var why = FG.searchBlock(st);
      if (!why) { done(null, st.btn); return; }
      if (Date.now() >= until) { done(why, st.btn, st.texts); return; }
      setTimeout(look, _pd(700));
    })();
  }

  // ── v2.5.46 前のお客様の条件を1つずつ外す（ボタンに頼らない）──
  // 2026-09-30 竹内「（ITANDI に）消去ボタンは無いので、リアプロのように、一度入っているのを全部抜いて、新しいお客さんに切り替わるたびにお客さんの条件入れたら出来る」
  //   v2.5.45 は「条件削除」のボタンを探して押す形だった（無ければ前の所在地・駅のチップが積み上がる）。
  //   ここでは ①所在地・路線/駅のチップ（見出しと「〜で絞り込み」のボタンの間）を1つずつ×で外す ②打つ欄（家賃・面積・駅徒歩・築年数ほか）を空に
  //   ③間取り・構造・設備・敷金/礼金なしのチェックを外す → 読み戻して空になったことを確かめてから入れる。空にならない欄があれば
  //   その欄の名前を付けて失敗（AXLX_RESET_FAILED）＝このお客様の ITANDI は飛ばす（前の条件が混ざった検索をしない）。
  //   チップの DOM は画面の文字（extension_snapshots）でしか確かめられていない → 外せなかった時は部品の形（tag・class）を点検の reset.hint に残す
  function _itFormRoot() {
    var r = document.querySelector('input[name="rent:lteq"]');
    return (r && r.closest && r.closest("form")) || null;
  }
  function _itInDialog(el) { return !!(el && el.closest && el.closest('[role="dialog"]')); }
  function _itVisAny(el) { try { var r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; } catch (e) { return false; } }
  function _itFilterBtn(rowDef) {
    var names = rowDef.buttons.map(norm);
    return [].slice.call(document.querySelectorAll("button, [role='button']")).filter(function (b) { return isVis(b) && !_itInDialog(b); })
      .find(function (b) { return names.indexOf(norm(b.textContent)) >= 0; }) || null;
  }
  // 「所在地」「路線・駅」の行: ボタンから上へ、見出しの文字で始まる一番近い入れ物（他の行の絞り込みボタン・家賃の欄を含む所まで上がらない）
  function _itFilterRow(rowDef) {
    var FG = _itFG();
    var btn = _itFilterBtn(rowDef);
    if (!btn) return null;
    var others = FG.FILTER_ROWS.filter(function (r) { return r.key !== rowDef.key; });
    var sq = function (x) { return String(x || "").replace(/[\s　]+/g, ""); };
    var lab = sq(rowDef.label), bt = sq(btn.textContent);
    var el = btn.parentElement;
    for (var i = 0; el && i < 8; i++, el = el.parentElement) {
      if (el.querySelector('input[name="rent:lteq"]')) break;
      var hasOther = others.some(function (o) { var ob = _itFilterBtn(o); return ob && el.contains(ob); });
      if (hasOther) break;
      // 見出しで始まり、ボタンの前に何かある（ボタンだけの入れ物「所在地で絞り込み」も「所在地」で始まるので、それは行にしない）
      var tx = sq(el.textContent);
      if (tx.indexOf(lab) === 0 && tx.indexOf(bt) > 0) return { row: el, btn: btn };
    }
    // 行が決まらない時は読めない扱い（上の大きな入れ物を行にすると、他の欄の見出しをチップと取り違えて毎回「消せない」になる）
    return null;
  }
  // 行の中のチップの文字（ボタンの中の文字は除く）。返り値 [{ name, node }]
  function _itChipNodes(rowDef, found) {
    var FG = _itFG();
    var f = found || _itFilterRow(rowDef);
    if (!f) return null;
    var nodes = [];
    try {
      var w = document.createTreeWalker(f.row, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = w.nextNode())) {
        if (f.btn.contains(n)) continue;
        var t = (n.nodeValue || "").trim();
        if (!t) continue;
        var pe = n.parentElement;
        if (pe && !_itVisAny(pe)) continue;
        nodes.push({ text: t, node: n });
      }
    } catch (e) { return null; }
    var names = FG.chipNames(nodes.map(function (x) { return x.text; }), rowDef.key);
    return names.map(function (nm) {
      var hit = nodes.find(function (x) { return x.text.replace(/[\s　]+/g, "").normalize("NFKC") === nm; });
      return { name: nm, node: hit ? hit.node : null };
    });
  }
  // 1つのチップの「外す」部品（×・削除のアイコン）。チップの入れ物は名前を1つだけ含む所まで
  function _itChipDeleteCtl(chip, row, filterBtn) {
    var FG = _itFG();
    if (!chip.node || !chip.node.parentElement) return null;
    var el = chip.node.parentElement;
    for (var up = 0; el && el !== row && up < 4; up++, el = el.parentElement) {
      if (el.contains(filterBtn)) break;
      var cands = [].slice.call(el.querySelectorAll("button, [role='button'], svg, [aria-label], [title], [class*='elete'], [class*='emove'], [class*='lose'], [class*='lear'], [class*='ancel']"));
      var ctl = cands.find(function (d) {
        if (d.contains(chip.node) || d === filterBtn || d.contains(filterBtn) || !_itVisAny(d)) return false;
        return FG.isDeleteControl({ tag: d.tagName, text: d.textContent, aria: d.getAttribute("aria-label"), title: d.getAttribute("title"), cls: String(d.getAttribute("class") || ""), role: d.getAttribute("role") });
      });
      if (ctl) return ctl;
    }
    // 外す部品が無い時: チップそのものがボタン（押すと外れる作り）ならそれ
    var b = chip.node.parentElement.closest ? chip.node.parentElement.closest("button, [role='button']") : null;
    if (b && b !== filterBtn && row.contains(b) && !b.contains(filterBtn)) return b;
    return null;
  }
  // 部品の形（外せなかった時の手掛かり・名前は入れない）
  function _itDomHint(chip) {
    var out = [];
    try {
      var el = chip && chip.node ? chip.node.parentElement : null;
      for (var i = 0; el && i < 4; i++, el = el.parentElement) {
        out.push(String(el.tagName).toLowerCase() + (el.getAttribute("class") ? "." + String(el.getAttribute("class")).trim().split(/\s+/).slice(0, 3).join(".") : "") + (el.getAttribute("role") ? "[role=" + el.getAttribute("role") + "]" : "") + "(" + el.children.length + ")");
      }
    } catch (e) {}
    return out.join(" < ").slice(0, 240);
  }
  // 人が押した形（svg は click() が無い＝ MouseEvent を送る）
  function _itPress(el) {
    ["mousedown", "mouseup", "click"].forEach(function (t) {
      try { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    });
  }
  // 押した後に確かめの窓（削除しますか）が出たら「はい」側・絞り込みの窓が開いたら閉じる（Escape は使わない）
  function _itAfterPress() {
    try {
      var dlg = document.querySelector('[role="dialog"]');
      if (!dlg || !isVis(dlg)) return;
      var ok = [].slice.call(dlg.querySelectorAll("button")).filter(isVis).find(function (b) { return /^(削除する|削除|OK|はい|実行)$/.test(norm(b.textContent)); });
      if (ok) { ok.click(); return; }
      var cl = dlg.querySelector('button[aria-label="閉じる"], button[aria-label="close"], button[aria-label="Close"]');
      if (cl) cl.click();
    } catch (e) {}
  }
  // 読み戻し（純関数 leftovers に渡す形）
  function _itReadResetState() {
    var FG = _itFG();
    var root = _itFormRoot();
    var st = { chips: {}, texts: [], checks: [], unreadable: [] };
    FG.FILTER_ROWS.forEach(function (r) {
      var cs = _itChipNodes(r);
      if (cs === null) { st.unreadable.push(r.key); st.chips[r.key] = []; }
      else st.chips[r.key] = cs.map(function (c) { return c.name; });
    });
    var seen = [];
    FG.CLEAR_TEXT_FIELDS.forEach(function (d) {
      var el = (root || document).querySelector('input[name="' + d.name + '"]');
      if (el) { seen.push(el); st.texts.push({ name: d.name, value: el.value }); }
    });
    // フォームの中のその他の打つ欄（物件名・部屋番号・管理会社など・並びと更新日は除く）
    if (root) {
      [].slice.call(root.querySelectorAll("input[name]")).forEach(function (el) {
        var ty = String(el.type || "text").toLowerCase();
        if (["text", "search", "number", "tel", ""].indexOf(ty) < 0 || seen.indexOf(el) >= 0 || _itInDialog(el)) return;
        if (FG.keepTextName(el.name)) return;
        st.texts.push({ name: el.name, value: el.value });
      });
    }
    FG.CLEAR_CHECK_NAMES.forEach(function (d) {
      [].slice.call((root || document).querySelectorAll('input[type="checkbox"][name="' + d.name + '"]:checked')).forEach(function (inp) {
        if (_itInDialog(inp)) return;
        var lbl = inp.closest ? inp.closest("label") : null;
        st.checks.push({ name: d.name, label: lbl ? lbl.textContent.replace(/\s+/g, "").slice(0, 20) : String(inp.id || inp.value || ""), el: inp });
      });
    });
    [].slice.call((root || document).querySelectorAll("label")).forEach(function (l) {
      var t = (l.textContent || "").replace(/[\s　]/g, "");
      if (FG.CLEAR_CHECK_LABELS.indexOf(t) < 0 || _itInDialog(l)) return;
      var inp = l.querySelector('input[type="checkbox"]') || (l.htmlFor ? document.getElementById(l.htmlFor) : null);
      if (inp && inp.checked) st.checks.push({ name: "", label: t, el: inp });
    });
    return st;
  }
  function _itPlainState(st) {
    return { chips: st.chips, texts: st.texts.map(function (t) { return { name: t.name, value: t.value }; }), checks: st.checks.map(function (c) { return { name: c.name, label: c.label }; }) };
  }
  // 1つずつ外す（人の間を空けて順に）。done() は全部の操作が終わった後に1回
  function _itClearOnce(done, ops) {
    var FG = _itFG();
    var root = _itFormRoot();
    var queue = [];
    var st = _itReadResetState();
    // ① 打つ欄を空に
    st.texts.forEach(function (t) {
      if (FG.isEmptyValue(t.value) || FG.keepTextName(t.name)) return;
      queue.push(function () {
        var el = (root || document).querySelector('input[name="' + t.name + '"]');
        if (el && !FG.isEmptyValue(el.value)) { setReactVal(el, ""); _itLeave(el); ops.push("text:" + t.name); }
      });
    });
    // ② チェックを外す（label の中の input を押す＝React に届く）
    st.checks.forEach(function (c) {
      queue.push(function () { if (c.el && c.el.checked) { c.el.click(); ops.push("check:" + (c.name || c.label)); } });
    });
    // ③ チップを1つずつ外す（外すたびに並びが変わるので、押す時に読み直して先頭を外す）
    FG.FILTER_ROWS.forEach(function (r) {
      var n = (st.chips[r.key] || []).length;
      for (var i = 0; i < n; i++) {
        queue.push(function () {
          var f = _itFilterRow(r);
          var cs = f ? _itChipNodes(r, f) : null;
          if (!cs || !cs.length) return;
          for (var k = 0; k < cs.length; k++) {
            var ctl = _itChipDeleteCtl(cs[k], f.row, f.btn);
            if (ctl) { _itPress(ctl); ops.push("chip:" + r.key); setTimeout(_itAfterPress, _hd(250)); return; }
          }
          ops.push("chip_no_ctl:" + r.key);
        });
      }
    });
    var i = 0;
    (function next() {
      if (i >= queue.length) { done(queue.length); return; }
      try { queue[i++](); } catch (e) { ops.push("err:" + String((e && e.message) || e).slice(0, 40)); }
      setTimeout(next, _hd(FG.RESET_STEP_MS));
    })();
  }
  // done({ ok, summary, hint, error })
  function _itResetForm(done) {
    var FG = _itFG();
    if (!FG || !FG.leftovers) { done({ ok: true, summary: null, skipped: "module_missing" }); return; }
    var ops = [];
    var before;
    try { before = _itPlainState(_itReadResetState()); }
    catch (e0) { done({ ok: false, summary: null, error: "読み戻しで例外: " + String((e0 && e0.message) || e0).slice(0, 80) }); return; }
    var t0 = Date.now();
    // 「条件削除」等のボタンがあれば先に押す（無い画面が普通・押しても下の手順で必ず確かめる）
    var startDelay = 0;
    var rb = [].slice.call(document.querySelectorAll("button")).find(function (b) { return FG.isResetLabel(b.textContent) && isVis(b) && !_itInDialog(b); });
    if (rb) { _itClickReset(rb); ops.push("reset_btn:" + rb.textContent.trim().slice(0, 10)); startDelay = _sd(900); if (_itAudit) _itAudit.reset_btn = rb.textContent.trim().slice(0, 20); }
    var pass = 0;
    function verify() { try {
      var afterSt = _itReadResetState();
      var after = _itPlainState(afterSt);
      var summary = FG.resetSummary(before, after);
      var left = summary.leftover;
      if (left.length && pass < 2) { run(); return; } // もう1回だけ（外すと並びが変わる・遅れて描き直す画面）
      summary.ops = ops.length;
      summary.ms = Date.now() - t0;
      if (afterSt.unreadable.length) summary.unreadable = afterSt.unreadable;
      var hint = null;
      if (left.length) {
        hint = {};
        FG.FILTER_ROWS.forEach(function (r) { var cs = _itChipNodes(r); if (cs && cs.length) hint[r.key] = _itDomHint(cs[0]); });
        hint.ops = ops.slice(-12);
      }
      done({ ok: !left.length, summary: summary, hint: hint });
    } catch (e) { done({ ok: false, summary: null, error: "外した後の読み戻しで例外: " + String((e && e.message) || e).slice(0, 80) }); } }
    function run() {
      pass++;
      try { _itClearOnce(function (n) { setTimeout(verify, n ? _sd(600) : 0); }, ops); }
      catch (e1) { done({ ok: false, summary: null, error: "外す途中で例外: " + String((e1 && e1.message) || e1).slice(0, 80) }); }
    }
    setTimeout(function () { try { run(); } catch (e) { done({ ok: false, summary: null, error: String((e && e.message) || e).slice(0, 100) }); } }, startDelay);
  }
  // 入れた後のチップ（このお客様の条件だけか）
  function _itAfterFillChips(cond, hasArea, hasLines, wardNames) {
    var FG = _itFG();
    if (!FG || !FG.foreignChips) return null;
    var st = _itReadResetState();
    var stations = [];
    (cond.station_names || []).forEach(function (s) { getStationAliases(String(s).replace(/駅$/, "")).forEach(function (a) { stations.push(a); }); });
    var chk = FG.foreignChips(st.chips, { mode: hasArea ? "area" : hasLines ? "station" : "none", wards: wardNames, stations: stations, selectAll: !!cond.select_all_line_stations });
    return { wards: (st.chips.wards || []).slice(0, 30), stations: (st.chips.stations || []).slice(0, 60), foreign: chk.foreign, unmatched_stations: chk.unmatched_stations };
  }

  // 2026-10-01 案内モード（<html data-axlx-guide> が "0" 以外）の間は拡張が入力も検索もしない（page-script.js の _guideOn と同じ）
  function _guideOn() { return document.documentElement.getAttribute("data-axlx-guide") !== "0"; }

  // 2026-09-18 竹内（一括検索の混線）: 直前に受け取った「誰の自動入力か」。fill が開始時に取り込む
  var _pendingFillCid = null;
  var _lastFillReq = null; // v2.5.45 直前の自動入力の依頼 { key, at }（同じ依頼の2回目を動かさない）

  function fill(cond) {
    // 240秒ウォッチドッグ: フリーズ/例外時にbackground.jsを強制解放
    // background.js の待ち上限（FILL_DONE_TIMEOUT_MS.itandi=245秒）より5秒短くする。
    // 2026-09-12 竹内: 85秒→150秒（路線ごとの駅選択・「電車1本」の沿線全駅選択で85秒に届くため）
    // 2026-09-14 竹内「時間かかっても大丈夫なのでタイムアウトが原因なら時間をのばす」: 150秒→240秒（駅の多い広げて検索・電車1本の安全幅）
    // 2026-09-18 竹内（一括検索の混線）: この入力を始めた時の顧客 ID を fill-done にそのまま載せて返す
    var _fillCid = _pendingFillCid;
    // 検索の点検: popup が載せた run_id（ブレインの時だけ）
    _itAuditReset(cond && cond._audit_run_id);
    var _myRunId = _itRunId;
    _itStep("fill_start", cond && cond.area_mode);
    // v2.5.45: 時間切れ・失敗で返した後は、この回の続き（遅れて動くタイマー）が検索を押さない（次のお客様の入力と重ねない）
    var _dead = false;
    var _watchdog = setTimeout(function () {
      console.warn("[AX] watchdog: 240s timeout — fill-done強制送信");
      _dead = true;
      // skip: 検索を押していない → background はこのサイトを飛ばす（押していない検索の結果を5分待たない）
      var wmsg = { from: "aixlinx-fill-done", error: "watchdog-timeout", skip: true };
      if (_fillCid) wmsg.customerId = _fillCid;
      if (_myRunId && _myRunId === _itRunId) { wmsg.runId = _myRunId; _itStep("watchdog", "240秒"); wmsg.audit = _itPack(); }
      window.postMessage(wmsg, "*");
    }, 240000);
    function _safeDone(errMsg) {
      if (_dead) return; // 時間切れで返した後・もう返した後は2回目を送らない
      _dead = true;
      clearTimeout(_watchdog);
      var msg = { from: "aixlinx-fill-done" };
      if (_fillCid) msg.customerId = _fillCid;
      // v2.5.45: ここで返す失敗はどれも検索を押す前（所在地・路線・更新日・例外・押せない検索）→ skip（そのサイトを飛ばす）
      if (errMsg) { msg.error = errMsg; msg.skip = true; }
      if (_myRunId && _myRunId === _itRunId) { msg.runId = _myRunId; if (errMsg) _itStep("done_error", errMsg); msg.audit = _itPack(); }
      window.postMessage(msg, "*");
    }

    // 非ブロッキング警告トースト（alert()はJS実行を止めるため自動モードで使用禁止）
    function showItandiWarnToast(msg) {
      console.log('[AX] ' + msg);
      var t = document.createElement('div');
      t.textContent = '[AX] ' + msg;
      t.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;'
        + 'background:#c0392b;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;'
        + 'max-width:80vw;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.4);';
      document.body.appendChild(t);
      setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 5000);
    }

    // v2.5.46 前のお客様の条件を1つずつ外して、空になったのを読み戻してから入れる（ITANDI に消去のボタンは無い・竹内 9/30）。
    //   空にならない欄があれば、その欄の名前を付けて返す（このお客様の ITANDI は飛ばす＝前の条件が混ざった検索をしない）
    _itStep("reset_start", null);
    _itResetForm(function (res) {
      if (_dead) return;
      if (_itAudit) {
        _itAudit.reset = res && res.summary ? { cleared: res.summary.cleared, leftover: res.summary.leftover, ops: res.summary.ops, ms: res.summary.ms } : null;
        if (_itAudit.reset && res.summary.unreadable) _itAudit.reset.unreadable = res.summary.unreadable;
        if (_itAudit.reset && res.summary.leftover_other && res.summary.leftover_other.length) _itAudit.reset.leftover_other = res.summary.leftover_other;
        if (_itAudit.reset && res.hint) _itAudit.reset.hint = res.hint;
      }
      if (!res || !res.ok) {
        var _rf = (res && res.summary && _itFG().resetFailText(res.summary)) || ("前の条件を消せない: " + ((res && res.error) || "理由不明"));
        if (_itAudit) _itAudit.reset_fail = _rf;
        _itStep("reset_fail", (res && res.summary ? res.summary.leftover.join(",") : (res && res.error) || "").slice(0, 100));
        console.warn("[AX] itandi " + _rf + "（このお客様の ITANDI は検索しない）", res && res.hint);
        showItandiWarnToast(_rf);
        _safeDone("AXLX_RESET_FAILED: " + _rf.replace(/^前の条件を消せない: /, ""));
        return;
      }
      _itStep("reset", res.summary ? "外した " + res.summary.cleared.length + "欄・" + res.summary.ops + "操作" : "module_missing");
      console.log("[AX] itandi 前の条件を外した", res.summary ? res.summary.cleared : "(form-guard なし)");
      setTimeout(_afterReset, _hd(300));
    });

    function _afterReset() { try {

    // 未登録地名の警告（NEIGHBORHOOD_WARD_MAPに未登録のトークンをコンソールに表示）
    if (cond.unknown_tokens && cond.unknown_tokens.length) {
      console.log("[AX] ⚠️ 未登録地名（スキップ）: " + cond.unknown_tokens.join(", "));
      console.log("[AX] → popup.js の NEIGHBORHOOD_WARD_MAP に追加が必要です");
    }

    // ── area_mode: webappトグル/ポップアップの明示指定が絶対ルール（自動判定より優先）──
    if (cond.area_mode === "ward") {
      cond.itandi_lines  = [];
      cond.station_names = null;
    } else if (cond.area_mode === "station") {
      cond.ward_name     = null;
      cond.ward_names    = null;
      cond.ward_town_map = null;
    }
    console.log("[AX] 場所モード判定(itandi)", {
      area_mode: cond.area_mode, wards: cond.ward_names || cond.ward_name,
      lines: cond.itandi_lines, stations: cond.station_names });

    // reclassifyLineTokens: station_namesに路線名が混入している場合はitandi_linesへ移動
    (function reclassifyLineTokens() {
      if (!cond.station_names || !cond.station_names.length) return;
      var remaining = [];
      cond.station_names.forEach(function(tok) {
        if (tok.length >= 3 && /線$/.test(tok)) {
          if (!cond.itandi_lines) cond.itandi_lines = [];
          if (cond.itandi_lines.indexOf(tok) === -1) {
            cond.itandi_lines.push(tok);
            console.log('[AX] reclassify: station_names → itandi_lines:', tok);
          }
        } else {
          remaining.push(tok);
        }
      });
      cond.station_names = remaining;
    })();

    // ── STEP 1: 賃料（最初に入力）────────────────────────────────────────
    if (cond.rent_max) {
      var rentVal = cond.rent_max > 1000 ? cond.rent_max / 10000 : cond.rent_max;
      // v2.5.45: ITANDI は「5桁以内」。84,999円→「8.4999」は弾かれて検索のボタンが押せなくなる → 5文字以内（8.499）に切り下げ
      if (_itFG()) { var _rt = _itFG().rentText(cond.rent_max, "max"); if (_rt) rentVal = _rt; }
      var rentEl = document.querySelector('input[name="rent:lteq"]');
      if (rentEl) { setReactVal(rentEl, rentVal); _itLeave(rentEl); }
    }
    // 賃料下限（一時調整 v2.5.6）: 面積と同じ命名規則 name:gteq。欄が無ければ何もしない
    if (cond.rent_min) {
      var rentMinVal = cond.rent_min > 1000 ? cond.rent_min / 10000 : cond.rent_min;
      if (_itFG()) { var _rtm = _itFG().rentText(cond.rent_min, "min"); if (_rtm) rentMinVal = _rtm; }
      var rentMinEl = document.querySelector('input[name="rent:gteq"]');
      if (rentMinEl) { setReactVal(rentMinEl, rentMinVal); _itLeave(rentMinEl); console.log('[AX] itandi 賃料下限:', rentMinVal + '万'); }
      else console.warn('[AX] itandi 賃料下限の欄(rent:gteq)が見つかりません');
    }
    tick(document.querySelector('input[name="totalRentCheck"]'));

    // ── STEP 2 & 3: 所在地 or 路線・駅モーダル → 完了後に残り条件 → 検索 ──
    var wardNames = cond.ward_names && cond.ward_names.length ? cond.ward_names : (cond.ward_name ? [cond.ward_name] : []);
    var hasArea  = wardNames.length > 0;
    var hasLines = !!(cond.itandi_lines && cond.itandi_lines.length);
    if (_itAudit) { _itAudit.area_path = hasArea ? "area" : hasLines ? "station" : "none"; _itStep("location", _itAudit.area_path); }

    setTimeout(function () {

      function afterModal() {
        // 間取り input が現れるまで最大3秒ポーリング（固定500ms待機ではReact再レンダリングが保証されない）
        var _afterModalPolled = 0;
        var _afterModalPoll = setInterval(function() {
          _afterModalPolled += 100;
          var layoutInput = document.querySelector("input[name='room_layout:in']") ||
                            document.querySelector("input[name*='layout']");
          if (layoutInput || _afterModalPolled >= 3000) {
            clearInterval(_afterModalPoll);
            // v2.5.34: 更新日（募集条件更新 N日以内）を先に入れる。後の fillRemainingFields のペットの欄を開くクリックが
            //   打っている途中の欄から focus を奪わないように（欄を離れると一覧の入力が戻ることがある）
            if (_dead) return;
            _itFillUpdateDays(cond, function (udOk, udErr) {
            if (_dead) return;
            if (!udOk) { showItandiWarnToast(udErr); _safeDone(udErr); return; }
            // v2.5.45: ここで投げた例外は _itFillUpdateDays の中で黙って捨てられ（settled の後の onErr）、240秒の時間切れになっていた
            //   （9/28・9/30 の区のお客様の watchdog-timeout: 最後の段が update_days）→ 捕まえて理由付きで返す
            try { fillRemainingFields(cond); }
            catch (errR) { console.error("[AX] 残りの条件の入力で例外", errR); _safeDone("fill-exception(remaining): " + String((errR && errR.message) || errR).slice(0, 100)); return; }
            setTimeout(function () { try {
              if (_dead) return;
              // v2.5.45: 押す前にボタンと画面の赤い文を見る（押せない disabled のボタンを click() しても「押せた」になり、一覧は前のお客様の結果のまま5分待っていた）
              _itWaitSearchReady(function (why, btn, texts) { try {
                if (_dead) return;
                // 検索の点検: 押す直前のフォームを読み戻す・検索ボタンが押せたか
                if (_itAudit) _itAudit.form = _itReadForm();
                // v2.5.46 入れた後のチップ（このお客様の条件だけか・前の区・駅が混ざっていないか）を点検に残す。
                //   外した後に空を確かめているので、混ざるのは入れる途中の誤り（別の区を押した等）だけ → 検索は止めず札（reset_fail）にする
                if (_itAudit) { try {
                  var _ac = _itAfterFillChips(cond, hasArea, hasLines, wardNames);
                  if (_ac) {
                    _itAudit.reset = _itAudit.reset || {};
                    _itAudit.reset.after = _ac;
                    if (_ac.foreign.length) { _itAudit.reset_fail = ("入れた後に前の条件が混ざっている: " + _ac.foreign.slice(0, 6).join("・")).slice(0, 160); _itStep("reset_mixed", _ac.foreign.slice(0, 4).join(",")); }
                  }
                } catch (eAc) {} }
                if (why) {
                  if (_itAudit) { _itAudit.search_clicked = false; _itAudit.search_blocked = { code: why.code, texts: (texts || []).slice(0, 4) }; }
                  _itStep("search_blocked", why.code);
                  console.warn("[AX] itandi 検索を押さない: " + why.ja, texts || []);
                  _safeDone("AXLX_SEARCH_BLOCKED: " + why.ja);
                  return;
                }
                // 2026-10-01 入力の途中で案内モードに切り替わった時も、検索は押さない（押すのはスタッフ）
                if (_guideOn()) { _itStep("guide_mode", "検索はスタッフ"); _safeDone("AXLX_SEARCH_BLOCKED: guide-mode: 検索はスタッフが押す"); return; }
                var _searched = false;
                if (btn) { btn.click(); _searched = true; } else _searched = clickBtn("検索");
                if (_itAudit) {
                  _itAudit.search_clicked = !!_searched;
                  if (!_searched) _itAudit.click_fails.push({ what: "search", text: "検索", sample: [].slice.call(document.querySelectorAll("button")).filter(isVis).map(function (b) { return b.textContent.trim().slice(0, 20); }).slice(0, 8) });
                }
                if (!_searched) { _safeDone("AXLX_SEARCH_BLOCKED: 検索のボタンが見つからない"); return; }
                setTimeout(function () {
                  _safeDone();
                }, 500);
              } catch (errS) { _safeDone("fill-exception(search): " + String((errS && errS.message) || errS).slice(0, 100)); } });
            } catch (errT) { _safeDone("fill-exception(search): " + String((errT && errT.message) || errT).slice(0, 100)); } }, _sd(1000)); // 検索ボタンを押すまで: 1.0〜1.35秒（ペットの欄を開く待ち 0.70〜0.95秒より必ず後）
            }); // _itFillUpdateDays
          }
        }, 100);
      }

      if (hasArea) {
        var opened = selectItandiArea(wardNames, cond.ward_town_map || null, cond.town_area || null, afterModal);
        if (!opened) {
          var _errA = '所在地で絞り込みボタンが見つかりませんでした';
          console.warn('[AX] ' + _errA);
          showItandiWarnToast(_errA);
          _safeDone(_errA);
        }

      } else if (hasLines) {
        var stNames = cond.station_names || (cond.station_name ? [cond.station_name] : []);
        var opened = selectItandiLines(cond.itandi_lines, stNames, afterModal, function() {
          console.warn('[AX] 路線選択失敗 → fill-done(error)');
          _safeDone('itandi路線選択失敗');
        }, !!cond.select_all_line_stations);
        if (!opened) {
          var _errL = '路線・駅で絞り込みボタンが見つかりませんでした';
          console.warn('[AX] ' + _errL);
          showItandiWarnToast(_errL);
          _safeDone(_errL);
        }

      } else {
        var _errE = '所在地または路線・駅の情報がありません';
        console.warn('[AX] ' + _errE);
        showItandiWarnToast(_errE);
        _safeDone(_errE);
      }

    }, _hd(800));

    } catch(err) {
      console.error('[AX] fill exception', err);
      _safeDone('fill-exception: ' + String(err));
    }
    } // _afterReset（v2.5.46: 前の条件を外して確かめた後）
  }

  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "axlx-itandi-fill-exec") return;
    // v2.5.45: 同じ依頼が2回届く（popup の iframe が background の tabs.sendMessage と underbar の中継の両方で switch-customer を受け、
    //   自動入力を2回押す）→ 同じフォームを2本の入力が同時に触っていた（点検の段 location・lines_done・update_days が毎回2つ・fill-done も2回）。
    //   同じ条件が8秒以内にもう一度来たら2回目は動かさない（誰の分かの ID だけ受け取る）
    var FG = _itFG();
    var _key = FG ? FG.fillKey(e.data.conditions) : null;
    var _now = Date.now();
    if (FG && FG.isDuplicateFill(_lastFillReq, _key, _now)) {
      if (!_pendingFillCid && e.data.customerId) _pendingFillCid = e.data.customerId;
      console.log("[AX] itandi 同じ自動入力の2回目は動かさない（" + (_now - _lastFillReq.at) + "ms 後）");
      _itStep("dup_fill", (_now - _lastFillReq.at) + "ms");
      return;
    }
    _lastFillReq = { key: _key, at: _now };
    // 2026-09-18: 誰の入力かを覚えてから実行する（fill が fill-done に載せて返す）
    _pendingFillCid = e.data.customerId || null;
    // 2026-10-01 竹内「ITANDIも画面表示光らせるようにする。検索の画面の入力は手動でそれ以外は今まで通りに」:
    //   案内モード（itandi-guide.js が <html data-axlx-guide="1"> を付ける・既定オン）の時は入力しない・押さない・前の条件も外さない。
    //   案内（光らせてスタッフが入れる）に条件を渡し、待っている側には「検索を押していない」（skip）で完了を返す
    //   （一括の流れが5分待たない・itandi-bulk-dl が自動の送信を始めない＝skip の回は armed にしない）。
    //   既定は案内（印が付く前に依頼が届いても自動で入れない＝安全側）。OFF の印（"0"）が付いている時だけ今まで通り入力する
    if (_guideOn()) {
      var _gCid = e.data.customerId || null;
      window.postMessage({ from: "axlx-itandi-guide-start", conditions: e.data.conditions || {}, customerId: _gCid }, "*");
      var _gDone = { from: "aixlinx-fill-done", error: "guide-mode: 案内モードのため拡張は入力していません（スタッフが入力して検索）", skip: true };
      if (_gCid) _gDone.customerId = _gCid;
      window.postMessage(_gDone, "*");
      return;
    }
    fill(e.data.conditions);
  });
})();
