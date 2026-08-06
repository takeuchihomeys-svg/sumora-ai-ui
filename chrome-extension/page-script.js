(function(){
  try {
    var di = Object.getOwnPropertyDescriptor(Window.prototype, 'innerWidth');
    if (di && di.get) Object.defineProperty(window, 'innerWidth', {
      get: function(){ return Math.max(di.get.call(window), 1300); },
      configurable: true
    });
  } catch(e){}
  try {
    var do2 = Object.getOwnPropertyDescriptor(Window.prototype, 'outerWidth');
    if (do2 && do2.get) Object.defineProperty(window, 'outerWidth', {
      get: function(){ return Math.max(do2.get.call(window), 1300); },
      configurable: true
    });
  } catch(e){}

  window.addEventListener('resize', function() {
    function tryClick(delay) {
      setTimeout(function() {
        var all = document.querySelectorAll('a,button,input,div,span,td,p');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (!el.offsetParent) continue;
          var txt = (el.textContent || el.value || '').trim();
          if (txt.indexOf('検索条件を表示') >= 0) {
            el.click();
            return;
          }
        }
      }, delay);
    }
    tryClick(300);
    tryClick(800);
    tryClick(1800);
  });

  // ── リアプロ自動入力 ──────────────────────────────────────────────
  var RENT_OPTS = [-1,20000,25000,30000,35000,40000,45000,50000,55000,60000,65000,70000,75000,80000,85000,90000,95000,100000,110000,120000,130000,140000,150000,160000,170000,180000,190000,200000,250000,300000,350000,400000,450000,500000,600000,700000,800000,900000,1000000];
  var AGE_OPTS  = [-1,1,3,5,7,10,15,20,25,30,35,40,45,50];
  var AREA_OPTS = [-1,15,20,25,30,35,40,45,50,55,60,70,80,100];
  var STRUCTURE_MAP = {
    "鉄骨鉄筋コンクリート造":"1","SRC":"1","SRC造":"1",
    "鉄筋コンクリート造":"2","RC":"2","RC造":"2",
    "鉄骨造":"3","S造":"3",
    "重量鉄骨造":"4",
    "軽量鉄骨造":"5",
    "木造":"6",
    "木造一部RC造":"7"
  };
  var FLOOR_MAP = {
    "ワンルーム":"1","1R":"1","スタジオタイプ":"2","スタジオ":"2",
    "1K":"3","1DK":"4","1LDK":"6",
    "2K":"7","2DK":"8","2LDK":"9",
    "3K":"10","3DK":"11","3LDK":"12",
    "4K":"13","4DK":"14","4LDK":"15",
    "5K":"16","5DK":"17","5LDK":"18",
    "6LDK":"19","メゾネット":"21","テナント":"20"
  };

  // route_id → リアプロ路線名（モーダルのボタンテキストと一致）
  var ROUTE_LINE_MAP = {
    "6701":"大阪市高速軌道御堂筋線","6702":"大阪市高速軌道谷町線",
    "6703":"大阪市高速軌道四つ橋線","6704":"大阪市高速軌道中央線",
    "6705":"大阪市高速軌道千日前線","6706":"大阪市高速軌道堺筋線",
    "6707":"大阪市高速軌道南港ポートタウン線","6699":"大阪市高速軌道今里筋線",
    "6768":"大阪市高速軌道長堀鶴見緑地線","6711":"北大阪急行南北線",
    "6603":"大阪環状線","6767":"JR東西線",
    "6645":"片町線","6604":"桜島線","6650":"おおさか東線",
    "6426":"関西本線","6647":"阪和線","6605":"福知山線","6171":"東海道本線",
    "6541":"近鉄大阪線","6551":"近鉄難波・奈良線",
    "6555":"近鉄南大阪線","6557":"近鉄長野線","6558":"近鉄道明寺線","6563":"近鉄けいはんな線",
    "6651":"京阪電気鉄道京阪線","6658":"京阪電気鉄道中之島線","6652":"京阪電気鉄道交野線",
    "6661":"阪急電鉄京都線","6662":"阪急電鉄千里線","6664":"阪急電鉄神戸線",
    "6668":"阪急電鉄宝塚線","6669":"阪急電鉄箕面線",
    "6671":"阪神電鉄本線","6673":"阪神電鉄阪神なんば線",
    "6681":"南海電鉄南海本線",
    "6686":"南海電鉄高野線","6694":"南海電鉄泉北線",
    "6691":"南海電鉄空港線","6766":"南海電鉄汐見橋線","6684":"南海電鉄多奈川線","6683":"南海電鉄高師浜線",
    "6689":"阪堺電気軌道阪堺線","6690":"阪堺電気軌道上町線",
    "6709":"大阪モノレール本線","6772":"大阪モノレール彩都線",
    "6676":"能勢電鉄","6713":"水間鉄道水間線","6648":"関西空港線",
  };

  function nearestUp(opts, val) {
    for (var i = 0; i < opts.length; i++) {
      if (opts[i] !== -1 && opts[i] >= val) return String(opts[i]);
    }
    return String(opts[opts.length - 1]);
  }
  function nearestDown(opts, val) {
    var best = "-1";
    for (var i = 0; i < opts.length; i++) {
      if (opts[i] !== -1 && opts[i] <= val) best = String(opts[i]);
    }
    return best;
  }
  function setSelVal(name, val) {
    var el = document.querySelector('select[name="' + name + '"]');
    if (!el || val == null) return;
    el.value = String(val);
    el.dispatchEvent(new Event("change", {bubbles:true}));
  }
  function setTxtVal(name, val) {
    var el = document.querySelector('input[name="' + name + '"]');
    if (!el || val == null) return;
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, String(val));
    el.dispatchEvent(new Event("input",  {bubbles:true}));
    el.dispatchEvent(new Event("change", {bubbles:true}));
  }
  function setCheckboxes(name, vals) {
    var svals = (vals || []).map(String);
    var cbs = document.querySelectorAll('input[name="' + name + '"]');
    cbs.forEach(function(cb) {
      var shouldCheck = svals.indexOf(String(cb.value)) >= 0;
      if (cb.checked !== shouldCheck) cb.click();
    });
  }

  function getDirectText(el) {
    var t = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) t += n.textContent;
    }
    return t.replace(/\s+/g, '').replace(/駅$/, '');
  }

  function fireClick(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // スペース除去＋全角英数→半角
  function norm(t) {
    return (t || '').replace(/\s+/g, '').replace(/[Ａ-Ｚａ-ｚ０-９＋－＊／]/g, function(c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
  }

  // position:fixed のモーダル内要素は offsetParent=null になるため BoundingClientRect で判定
  function isVisible(el) {
    try {
      var s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false; // display:none祖先の検出
      return true;
    } catch(e) { return false; }
  }

  // テキストで要素を探してクリック（完全一致→包含の順）
  // DIVのonclickはel.click()の方が確実（診断でgo_search等がDIVと判明）
  function clickByText(candidates) {
    var els = Array.prototype.slice.call(
      document.querySelectorAll('a,button,div,span,td,li,p,label')
    );
    for (var ci = 0; ci < candidates.length; ci++) {
      var cand = norm(candidates[ci]);
      // 完全一致
      for (var i = 0; i < els.length; i++) {
        if (!isVisible(els[i])) continue;
        if (norm(els[i].textContent) === cand) {
          els[i].click(); return true;
        }
      }
    }
    for (var ci = 0; ci < candidates.length; ci++) {
      var cand = norm(candidates[ci]);
      // 包含（短すぎる候補は除外）
      if (cand.length < 5) continue;
      for (var i = 0; i < els.length; i++) {
        if (!isVisible(els[i])) continue;
        if (norm(els[i].textContent).indexOf(cand) >= 0) {
          els[i].click(); return true;
        }
      }
    }
    return false;
  }

  // ────────────────────────────────────────────────────────────────────
  // waitForClick: 要素が出るまでリトライして、成功したら onDone を呼ぶ
  // tryFn    : function() → boolean（true=成功）
  // onDone   : 成功後に呼ぶコールバック
  // maxTries : 最大リトライ数（デフォルト30回 = 約15秒）
  // retryMs  : リトライ間隔ms（デフォルト500ms）
  // pauseMs  : 成功後 onDone を呼ぶまでの待機ms（デフォルト600ms）
  // onFail   : maxTries超過時に呼ぶコールバック
  //            （省略時も静かに停止せず notifyDone を送る — fill-done タイムアウト対策）
  // ────────────────────────────────────────────────────────────────────
  function waitForClick(tryFn, onDone, maxTries, retryMs, pauseMs, onFail) {
    maxTries = maxTries !== undefined ? maxTries : 30;
    retryMs  = retryMs  !== undefined ? retryMs  : 500;
    pauseMs  = pauseMs  !== undefined ? pauseMs  : 600;
    var tries = 0;
    function attempt() {
      var ok = false;
      try {
        ok = tryFn();
      } catch (err) {
        // tryFn内の例外で静かに死ぬと fill-done が永遠に来ない → 失敗扱いで打ち切る
        console.error('[AX] waitForClick: tryFn例外 → 打ち切り', err);
        if (onFail) {
          try { onFail(); return; } catch (e2) { console.error('[AX] waitForClick: onFail例外', e2); }
        }
        notifyDone('waitForClick: tryFn例外: ' + (err && err.message));
        return;
      }
      if (ok) {
        setTimeout(function() {
          try {
            onDone();
          } catch (err) {
            console.error('[AX] waitForClick: onDone例外 → fill-done送信', err);
            notifyDone('waitForClick: onDone例外: ' + (err && err.message));
          }
        }, pauseMs);
      } else if (tries < maxTries) {
        tries++;
        setTimeout(attempt, retryMs);
      } else {
        if (onFail) {
          try {
            onFail();
          } catch (err) {
            console.error('[AX] waitForClick: onFail例外 → fill-done送信', err);
            notifyDone('waitForClick: onFail例外: ' + (err && err.message));
          }
        } else {
          // onFail未指定: 従来は「静かに停止」で fill-done が来ずタイムアウトしていた
          console.warn('[AX] waitForClick: タイムアウト（onFail未指定）→ fill-done送信');
          notifyDone('waitForClick timeout');
        }
      }
    }
    attempt();
  }

  // fill-done は1回の fillRealpro につき1回だけ送る（多重送信防止）
  // フェイルセーフ watchdog: 何らかの理由で全経路が沈黙しても必ず送信される
  var _doneNotified = false;
  var _watchdogTimer = null;

  // errMsg を渡すと fill-done メッセージに error フィールドが付き、
  // content.js → background.js へ中継されてログ・デバッグ材料になる。
  // 正常系は引数なしで呼ぶこと。
  function notifyDone(errMsg) {
    if (_doneNotified) return;
    _doneNotified = true;
    if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
    var msg = { from: 'aixlinx-fill-done' };
    if (errMsg) msg.error = String(errMsg).slice(0, 300);
    window.postMessage(msg, '*');
  }

  // 非ブロッキング警告表示（alert() はモーダルブロッキングで無人運転時に
  // fill-done の配送まで止めてしまうため使用禁止）
  function showWarnToast(msg) {
    try {
      console.warn('[AX] ' + msg);
      var t = document.createElement('div');
      t.textContent = '⚠️ ' + msg;
      t.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;' +
        'background:#c0392b;color:#fff;padding:12px 16px;border-radius:8px;' +
        'font-size:13px;max-width:340px;box-shadow:0 4px 12px rgba(0,0,0,.3);white-space:pre-wrap;';
      document.body.appendChild(t);
      setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 15000);
    } catch (e) { /* 表示失敗は無視 */ }
  }

  // next_step_button2 がY状態（市区郡選択済み）か確認
  // 診断確認: Y状態=クラス town_search_Y が独立で付く（next_action とは別クラス）
  // NG: '.next_action_town_search_Y'（アンダースコアで繋げると一致しない）
  function isWardButtonY() {
    var btn = document.querySelector('div.next_step_button2');
    return btn ? btn.classList.contains('town_search_Y') : false;
  }

  // 市区郡チェックボックス（city_code[]）が1つ以上 checked か確認（DOMフォールバック）
  function isWardChecked() {
    if (isWardButtonY()) return true; // ボタンY状態が最も確実
    return document.querySelectorAll('label input[name="city_code[]"]:checked').length > 0;
  }

  // 完全マウスイベントシーケンスでクリック（mousedown→mouseup→click）
  // サイト独自のイベントデリゲーションがmousedownを待っている場合に対応
  function simulateClick(el) {
    el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, view:window}));
    el.dispatchEvent(new MouseEvent('mouseup',   {bubbles:true, cancelable:true, view:window}));
    el.dispatchEvent(new MouseEvent('click',     {bubbles:true, cancelable:true, view:window}));
  }

  // 市区郡ラベルを安全にクリック（city_code[]を持つlabel限定・checked済みは再クリックしない）
  function clickWardPrecise(texts) {
    var allLabels = Array.prototype.slice.call(document.querySelectorAll('label'));
    var wardLabels = allLabels.filter(function(l) {
      return !!l.querySelector('input[name="city_code[]"]');
    });
    if (wardLabels.length === 0) return false; // まだ市区郡ページに到達していない
    for (var ci = 0; ci < texts.length; ci++) {
      var t = norm(texts[ci]);
      for (var i = 0; i < wardLabels.length; i++) {
        var ltxt = norm(wardLabels[i].textContent);
        if (ltxt !== t && !ltxt.includes(t) && !t.includes(ltxt)) continue;
        var inp = wardLabels[i].querySelector('input[name="city_code[]"]');
        if (inp && inp.checked && isWardButtonY()) { return true; } // 選択済みかつボタンY → 成功
        if (inp && inp.checked) {
          // DOM上はcheckedだがボタンがN → サイト内部状態が未反映 → 再クリックで登録し直す
          simulateClick(wardLabels[i]);
          return true;
        }
        // 未選択 → フルイベントシーケンスでクリック
        simulateClick(wardLabels[i]);
        return true;
      }
    }
    return false;
  }

  // 旧 alertStop は alert() ブロッキングにより無人運転で fill-done が届かなくなるため廃止。
  // タイムアウト時は各モーダル経路のフォールバック関数（条件なし検索）を使うこと。

  // 検索ボタンをクリック
  // リアプロは DIV.go_search が実際の検索ボタン（診断で確認済み）
  function clickSearch() {
    // 優先: div.go_search（リアプロのメイン検索ボタン）
    var goDivs = Array.prototype.slice.call(
      document.querySelectorAll('div.go_search, div.go_search_submit')
    );
    for (var i = 0; i < goDivs.length; i++) {
      if (goDivs[i].offsetParent) { goDivs[i].click(); notifyDone(); return; }
    }
    // フォールバック: button/a テキスト一致
    var SEARCH_TEXTS = ['住居検索', '検索', '物件を検索する', '条件で検索'];
    var allBtns = Array.prototype.slice.call(
      document.querySelectorAll('button,input[type="submit"],a')
    );
    for (var si = 0; si < SEARCH_TEXTS.length; si++) {
      for (var i = 0; i < allBtns.length; i++) {
        var b = allBtns[i];
        if (!b.offsetParent) continue;
        var txt = (b.textContent || b.value || '').replace(/\s+/g, '');
        if (txt === SEARCH_TEXTS[si]) { b.click(); notifyDone(); return; }
      }
    }
    notifyDone('clickSearch: 検索ボタンが見つかりません（フォーム折りたたみ/モーダル遮蔽の可能性）');
  }

  // 路線ボタンをクリック（リアプロモーダル: LABEL.one_line 構造確認済み）
  function clickLineButtons(routeIds) {
    if (!routeIds || !routeIds.length) return;
    // label.one_line を優先（診断で確認した実DOM構造）
    var labels = Array.prototype.slice.call(document.querySelectorAll('label.one_line'));
    routeIds.forEach(function(id) {
      var lineName = ROUTE_LINE_MAP[id];
      if (!lineName) return;
      var lineNorm = norm(lineName);
      var found = false;
      // PASS1: label.one_line 完全一致
      for (var i = 0; i < labels.length && !found; i++) {
        if (!isVisible(labels[i])) continue;
        var lNorm = norm(labels[i].textContent);
        if (lNorm === lineNorm) {
          var cb = labels[i].querySelector('input[type="checkbox"]');
          if (cb) { if (!cb.checked) cb.click(); }
          else { labels[i].click(); }
          found = true;
        }
      }
      // PASS2: 短縮名サフィックス一致（"御堂筋線" → "大阪市高速軌道御堂筋線"）
      for (var i = 0; i < labels.length && !found; i++) {
        if (!isVisible(labels[i])) continue;
        var lNorm = norm(labels[i].textContent);
        if (lNorm.length >= 4 && lineNorm.endsWith(lNorm)) {
          var cb = labels[i].querySelector('input[type="checkbox"]');
          if (cb) { if (!cb.checked) cb.click(); }
          else { labels[i].click(); }
          found = true;
        }
      }
    });
  }

  // 駅名でボタン/チェックボックスをクリック
  function selectStationsByName(names) {
    if (!names || !names.length) return;
    names.forEach(function(name) {
      var clean = name.replace(/駅$/, '').trim();
      if (!clean) return;
      var found = false;

      // STEP1: label+checkbox（フォーム方式）
      var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
      for (var i = 0; i < labels.length && !found; i++) {
        if (!isVisible(labels[i])) continue;
        var txt = labels[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if (txt === clean) {
          var inp = labels[i].querySelector('input[type="checkbox"]');
          if (!inp && labels[i].htmlFor) inp = document.getElementById(labels[i].htmlFor);
          if (inp && !inp.checked) { inp.click(); found = true; }
        }
      }
      if (found) return;

      var els = Array.prototype.slice.call(
        document.querySelectorAll('a,button,td,li,span,div,p')
      );

      // STEP2: 直接テキスト 完全一致
      for (var i = 0; i < els.length && !found; i++) {
        if (!isVisible(els[i])) continue;
        if (getDirectText(els[i]) === clean) { fireClick(els[i]); found = true; }
      }
      if (found) return;

      // STEP3: 全テキスト完全一致かつ葉ノード
      for (var i = 0; i < els.length && !found; i++) {
        if (!isVisible(els[i])) continue;
        var ft = els[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if (ft === clean && els[i].children.length === 0) { fireClick(els[i]); found = true; }
      }
      if (found) return;

      // STEP4: 直接テキスト 前方一致
      for (var i = 0; i < els.length && !found; i++) {
        if (!isVisible(els[i])) continue;
        var dt = getDirectText(els[i]);
        if (dt.length >= 2 && clean.length >= 2 &&
            (dt.startsWith(clean) || clean.startsWith(dt))) {
          fireClick(els[i]); found = true;
        }
      }
      if (found) return;

      // STEP5: label 前方一致フォールバック
      for (var i = 0; i < labels.length && !found; i++) {
        if (!isVisible(labels[i])) continue;
        var txt = labels[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if ((txt.startsWith(clean) || clean.startsWith(txt)) && txt.length >= 2) {
          var inp = labels[i].querySelector('input[type="checkbox"]');
          if (!inp && labels[i].htmlFor) inp = document.getElementById(labels[i].htmlFor);
          if (inp && !inp.checked) { inp.click(); found = true; }
        }
      }
    });
  }

  // 詳細地域（町丁目レベル）のチェックボックスを選択する
  // DevTools調査済: 町字ボタンは label.one_town > input[type="checkbox"][name="town_code[]"]
  function clickDetailArea(name) {
    if (!name) return false;
    var clean = name.trim();

    // PASS0: label.one_town 直接狙い撃ち（DevTools調査済）
    // 「近いの何個か選択」: 完全一致・前方一致・双方向前方一致をまとめてクリック
    // 例: clean="喜連西" → "喜連西"(完全) + "喜連"(双方向:喜連西.startsWith(喜連)) を同時に選択
    var townLabels = Array.prototype.slice.call(document.querySelectorAll('label.one_town'));
    var pass0clicked = false;
    for (var pi = 0; pi < townLabels.length; pi++) {
      var ptxt = townLabels[pi].textContent.replace(/\s+/g, '');
      var ok = ptxt === clean ||
               ptxt.startsWith(clean) ||
               ptxt.includes(clean) ||
               (ptxt.length >= 2 && clean.startsWith(ptxt));
      if (!ok) continue;
      var pinp = townLabels[pi].querySelector('input[type="checkbox"]');
      if (pinp && !pinp.checked) { pinp.click(); pass0clicked = true; }
      else if (pinp && pinp.checked) { pass0clicked = true; } // checked済みも成功（再クリック禁止）
      else if (!pinp) { townLabels[pi].click(); pass0clicked = true; }
    }
    if (pass0clicked) return true;

    function tryLabel(matchFn) {
      var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
      for (var i = 0; i < labels.length; i++) {
        if (!isVisible(labels[i])) continue;
        var txt = labels[i].textContent.replace(/\s+/g, '');
        if (matchFn(txt)) {
          var inp = labels[i].querySelector('input[type="checkbox"]');
          if (!inp && labels[i].htmlFor) inp = document.getElementById(labels[i].htmlFor);
          if (inp && !inp.checked) { inp.click(); return true; }
          labels[i].click(); return true;
        }
      }
      return false;
    }
    function tryEl(matchFn) {
      var els = Array.prototype.slice.call(document.querySelectorAll('a,div,span,td,li,button,p'));
      for (var i = 0; i < els.length; i++) {
        if (!isVisible(els[i])) continue;
        var txt = els[i].textContent.replace(/\s+/g, '');
        if (matchFn(txt)) { els[i].click(); return true; }
      }
      return false;
    }

    // PASS1: 完全一致
    if (tryLabel(function(t){ return t === clean; })) return true;
    if (tryEl(function(t){ return t === clean; })) return true;
    // PASS2: 前方一致（「喜連西1丁目〜5丁目」等）
    if (tryLabel(function(t){ return t.startsWith(clean); })) return true;
    if (tryEl(function(t){ return t.startsWith(clean); })) return true;
    // PASS3: 部分一致（要素テキストに地名が含まれる）
    if (tryLabel(function(t){ return t.includes(clean); })) return true;
    if (tryEl(function(t){ return t.includes(clean); })) return true;
    // PASS4: 逆部分一致（地名が要素テキストを含む — 短いラベル向け）
    if (clean.length >= 2) {
      if (tryLabel(function(t){ return t.length >= 2 && clean.includes(t); })) return true;
      if (tryEl(function(t){ return t.length >= 2 && clean.includes(t); })) return true;
    }
    // PASS5: 強制クリック（isVisible()が position:fixed モーダル内で誤判定する場合のフォールバック）
    function tryForce(matchFn) {
      var all = Array.prototype.slice.call(document.querySelectorAll('label,a,div,span,td,li,button,p'));
      for (var i = 0; i < all.length; i++) {
        var txt = all[i].textContent.replace(/\s+/g, '');
        if (!matchFn(txt)) continue;
        if (all[i].tagName === 'LABEL') {
          var inp = all[i].querySelector('input[type="checkbox"]');
          if (!inp && all[i].htmlFor) inp = document.getElementById(all[i].htmlFor);
          if (inp && !inp.checked) { inp.click(); return true; }
        }
        try { all[i].click(); return true; } catch(e) {}
      }
      return false;
    }
    if (tryForce(function(t){ return t === clean; })) return true;
    if (tryForce(function(t){ return t.startsWith(clean); })) return true;
    if (tryForce(function(t){ return t.includes(clean); })) return true;
    if (clean.length >= 2) {
      if (tryForce(function(t){ return t.length >= 2 && clean.includes(t); })) return true;
    }
    return false;
  }

  function fillRealpro(cond) {
    // fill-done 保証: 実行開始時にフラグをリセットし、85秒のフェイルセーフを仕掛ける
    // （background.js 側のタイムアウト90秒より必ず先に発火させる）
    _doneNotified = false;
    if (_watchdogTimer) clearTimeout(_watchdogTimer);
    _watchdogTimer = setTimeout(function() {
      // 条件入力が未完了のまま clickSearch すると全件検索→LINE誤送信になるため検索しない。
      // error付きdoneでbackground.jsがスクレイプを中止するので前回結果の誤スクレイプも起きない。
      console.warn('[AX] フェイルセーフ: 85秒経過 → 検索せず fill-done(error) 送信');
      notifyDone('watchdog-timeout: 85秒以内に条件入力が完了しませんでした（全件検索防止のため中止）');
    }, 85000);

    if (!cond) { notifyDone(); return; }

    // 連続検索対応: モーダルを閉じる → フォームを手動クリア → 条件入力 の順で実行
    // ※ リセットボタンはページ遷移を引き起こすため使用しない（ページ遷移するとスクリプトが死ぬ）
    function _doReset(callback) {
      // Step0: 検索結果ページでフォームが折りたたまれている場合→「検索条件を表示」をクリックして展開
      // ポップアップ展開時はresizeイベントが発火して自動クリックされるが、
      // background.jsからの自動実行時はresizeが起きないためここで明示的に展開する
      var showFormDelay = 0;
      var allEls0 = [].slice.call(document.querySelectorAll("a,button,div,span,td,p"));
      var showFormBtn = null;
      for (var si0 = 0; si0 < allEls0.length; si0++) {
        var se0 = allEls0[si0];
        if (!se0.offsetParent) continue;
        var _t0 = (se0.textContent || '').trim();
        if (_t0 === '検索条件を表示' || _t0 === '▼検索条件を表示' || _t0 === '▶検索条件を表示') { showFormBtn = se0; break; }
      }
      if (showFormBtn) {
        try { showFormBtn.click(); showFormDelay = 800; console.log("[AX] 検索条件を表示 クリック → フォーム展開待機"); }
        catch (e) { console.error("[AX] _doReset: 検索条件を表示クリックで例外（続行）", e); }
      }

      setTimeout(function() {

      // Step1: 開いているモーダルを先に閉じる
      var closeBtn = [].slice.call(document.querySelectorAll("a, button, div, span")).find(function(el) {
        var t = (el.textContent || "").trim();
        return (t === "× とじる" || t === "×とじる" || t === "とじる" || t === "閉じる") && el.offsetParent !== null;
      });
      var closeDelay = 0;
      if (closeBtn) {
        // click() の同期例外で callback 未到達（= fill-done 永久欠落）にならないよう try-catch
        try { closeBtn.click(); closeDelay = 400; console.log("[AX] モーダルを閉じました"); }
        catch (err) { console.error("[AX] _doReset: モーダル閉じで例外（続行）", err); }
      }

      setTimeout(function() {
        try {
        // Step2: フォームを直接手動クリア（ページ遷移なし・確実にリセット）
        // チェックボックス系：市区郡・沿線・駅・間取り・構造・設備をすべてリセット
        // 修正: route_id[]（沿線）と station_code[]（駅）が抜けており、
        // 前顧客の沿線・駅選択が残ったまま次顧客の検索が実行されるバグがあった
        var checkboxNames = [
          "city_code[]", "town_code[]",
          "route_id[]", "station_code[]",
          "room_layout_id[]", "structured_type[]", "eq_rm[]",
        ];
        checkboxNames.forEach(function(name) {
          [].slice.call(document.querySelectorAll("input[name='" + name + "']:checked"))
            .forEach(function(cb) { cb.checked = false; cb.dispatchEvent(new Event("change", {bubbles:true})); });
        });

        // セレクト系をリセット（structured_date=築年数 / square_meter=面積 も select要素）
        // update_date: 前顧客の更新日フィルターが残留すると次顧客の検索が絞られるバグの修正
        var selectNames = ["rental_cost1", "rental_cost2", "transportation_id",
                           "structured_date", "square_meter_l", "square_meter_h",
                           "update_date"];
        selectNames.forEach(function(name) {
          var el = document.querySelector("select[name='" + name + "']");
          if (el) { el.selectedIndex = 0; el.dispatchEvent(new Event("change", {bubbles:true})); }
        });

        // テキスト・数値入力をクリア（required_timeのみ input 要素）
        var textNames = ["required_time"];
        textNames.forEach(function(name) {
          var el = document.querySelector("input[name='" + name + "']");
          if (el && el.value) { el.value = ""; el.dispatchEvent(new Event("change", {bubbles:true})); }
        });

        console.log("[AX] フォーム手動クリア完了 → 条件入力開始");
        } catch (err) {
          // クリア失敗でも条件入力は続行する（静かに停止すると fill-done が来なくなる）
          console.error("[AX] _doReset クリア中の例外（続行）", err);
        }
        setTimeout(callback, 300); // 短い安定待機のみ
      }, closeDelay);

      }, showFormDelay); // Step0: 検索条件を表示 展開待機
    }

    _doReset(function() {

    setTimeout(function() {
    try { // fill-done 保証: 本体で例外が起きても必ず notifyDone する

    // 未登録地名の警告（NEIGHBORHOOD_WARD_MAPに未登録のトークン）
    if (cond.unknown_tokens && cond.unknown_tokens.length) {
      console.log("[AX] ⚠️ 未登録地名（スキップ）: " + cond.unknown_tokens.join(", "));
      console.log("[AX] → popup.js の NEIGHBORHOOD_WARD_MAP に追加が必要です");
    }

    // ── 防御: station_names に路線名が混入していた場合、沿線(route_ids)に再分類する ──
    // 学習データ汚染等で「御堂筋線」が駅名として渡ってくると、駅リストに存在せず
    // 「指定の駅が選択できませんでした」で停止していた。ROUTE_LINE_MAP と照合し、
    // 路線名と判定できるトークンは route_ids に移して沿線ボタンクリックで処理する。
    // ※ 将来拡張ポイント: ここで判定できない「〜線」トークンは popup.js 側の
    //   /api/token-resolve（DeepSeek-V3 → Claude web_search の2段判定）で
    //   線名/駅名を解決できる。page-script はページ文脈で外部APIを呼べないため
    //   API判定は popup.js（resolveUnknownTokensWithAI）側に実装済み。
    (function reclassifyLineTokens() {
      var names = cond.station_names || [];
      if (!names.length) return;
      var keep = [];
      for (var i = 0; i < names.length; i++) {
        var token = String(names[i]).trim();
        var matchedId = null;
        if (/線$/.test(token) && token.length >= 3) {
          // 正規化: 「大阪市高速電気軌道」(大阪メトロ現名称) → 「大阪市高速軌道」(リアプロ内部名)
          var normTok = token.replace("大阪市高速電気軌道", "大阪市高速軌道");
          for (var id in ROUTE_LINE_MAP) {
            var ln = ROUTE_LINE_MAP[id];
            if (ln === normTok || ln.endsWith(normTok) || normTok.endsWith(ln)) { matchedId = id; break; }
          }
        }
        if (matchedId) {
          cond.route_ids = cond.route_ids || [];
          if (cond.route_ids.indexOf(matchedId) === -1) cond.route_ids.push(matchedId);
          console.log("[AX] 路線名を検出 → 駅から沿線に再分類: " + token + " → route_id " + matchedId);
        } else {
          keep.push(names[i]);
        }
      }
      cond.station_names = keep;
    })();

    // ── area_mode: webappトグル/ポップアップの明示指定が絶対ルール（自動判定より優先）──
    // "ward"    → 所在地モーダルのみ使用。駅/沿線の軸を完全に消す
    // "station" → 沿線・駅モーダルのみ使用。所在地の軸を完全に消す
    // "auto" / undefined → 何も消さない（従来の自動判定）
    // ※ resolve-search-conditions は同じ desired_area から city_codes と
    //   station_names/route_ids の両方を埋めるため、負けた軸をここで一括抹消しないと
    //   後段の駅名入力・隣駅展開・detail_ward モーダルが誤発火する。
    //   路線名再分類 IIFE の後に置くこと（ward モード時に再分類された route_ids も消すため）。

    // suppression前スナップショット: area_mode抹消で軸が空になったか判定するため
    var _hadAreaBeforeSuppress = !!(
      (cond.station_names && cond.station_names.length) ||
      (cond.route_ids && cond.route_ids.length) ||
      (cond.city_codes && cond.city_codes.length) ||
      cond.detail_ward ||
      (cond.desired_area && String(cond.desired_area).trim())
    );

    if (cond.area_mode === "ward") {
      cond.station_names = [];
      cond.route_ids    = [];
    } else if (cond.area_mode === "station") {
      cond.city_codes  = [];
      cond.detail_ward = null;
      cond.detail_area = null;
    }

    var hasStation   = cond.station_names && cond.station_names.length > 0;
    var hasRoutes    = cond.route_ids && cond.route_ids.length > 0;
    var hasCities    = cond.city_codes && cond.city_codes.length > 0;
    var hasModalWard = !!(cond.detail_ward);   // 所在地モーダルを使う（ピンポイント・広げて両方）
    var hasDetailArea = !!(cond.detail_area) || !!(cond.town_names && cond.town_names.length > 0);  // 町字まで選択
    // town_names: 複数町字配列（Supabase property_customers.town_names から）。detail_area と共存可。
    var townNamesList = (cond.town_names && cond.town_names.length > 0)
      ? cond.town_names : (cond.detail_area ? [cond.detail_area] : []);

    // ── 場所モード判定の一元化（優先順位: station > route > area > none）──────
    // リアプロは駅×所在地がAND条件になるため、駅/沿線がある場合は地域を使わない
    // area_mode が明示指定されている場合はユーザー意図を最優先する
    function decideLocationMode(c) {
      if (c.area_mode === "ward") {
        return ((c.city_codes && c.city_codes.length > 0) || c.detail_ward) ? "area" : "none";
      }
      if (c.area_mode === "station") {
        if (c.station_names && c.station_names.length > 0) return "station";
        if (c.route_ids && c.route_ids.length > 0)         return "route";
        return "none";
      }
      // auto（従来: station > route > area > none）
      if (c.station_names && c.station_names.length > 0) return "station";
      if (c.route_ids && c.route_ids.length > 0)         return "route";
      if ((c.city_codes && c.city_codes.length > 0) || c.detail_ward) return "area";
      return "none";
    }
    var locationMode = decideLocationMode(cond);
    console.log("[AX] 場所モード判定: " + locationMode,
      { area_mode: cond.area_mode, stations: cond.station_names, routes: cond.route_ids,
        cities: cond.city_codes, ward: cond.detail_ward });

    // ── T=0ms: 基本条件 ──────────────────────────────────────────────
    if (cond.rent_min) setSelVal("rental_cost1", nearestDown(RENT_OPTS, cond.rent_min));
    if (cond.rent_max) setSelVal("rental_cost2", nearestUp(RENT_OPTS, cond.rent_max));
    if (cond.area_min) setSelVal("square_meter_l", nearestDown(AREA_OPTS, cond.area_min));
    if (cond.area_max) setSelVal("square_meter_h", nearestUp(AREA_OPTS, cond.area_max));
    var feeCb = document.querySelector('input[name="include_common_fee"]');
    if (feeCb && !feeCb.checked) feeCb.click();
    if (cond.walk_minutes) {
      setSelVal("transportation_id", "1");
      setTxtVal("required_time", cond.walk_minutes);
    }
    if (cond.building_age) setSelVal("structured_date", nearestUp(AGE_OPTS, cond.building_age));
    if (cond.floor_plan) {
      var FLOOR_RANK = [
        "1R","ワンルーム","スタジオタイプ","スタジオ",
        "1K","1DK","1LDK",
        "2K","2DK","2LDK",
        "3K","3DK","3LDK",
        "4K","4DK","4LDK",
        "5K","5DK","5LDK",
        "6LDK","メゾネット"
      ];
      var fpStr = cond.floor_plan.trim();
      var vals = [];
      var ijouMatch = fpStr.match(/^(.+?)以上$/);
      var rangeMatch = fpStr.match(/^(.+?)[～〜](.+?)$/);
      if (ijouMatch) {
        // 「3LDK以上」→ 3LDK〜メゾネットを全選択
        var baseFloor = ijouMatch[1].trim();
        var baseIdx = FLOOR_RANK.indexOf(baseFloor);
        if (baseIdx >= 0) {
          for (var ri = baseIdx; ri < FLOOR_RANK.length; ri++) {
            var fv = FLOOR_MAP[FLOOR_RANK[ri]];
            if (fv && vals.indexOf(fv) < 0) vals.push(fv);
          }
        }
      } else if (rangeMatch) {
        // 「1DK～1LDK」→ 1DKから1LDKまでの範囲を全選択
        var fromFloor = rangeMatch[1].trim();
        var toFloor   = rangeMatch[2].trim();
        var fromIdx = FLOOR_RANK.indexOf(fromFloor);
        var toIdx   = FLOOR_RANK.indexOf(toFloor);
        if (fromIdx < 0) fromIdx = 0;
        if (toIdx < 0) toIdx = fromIdx;
        if (fromIdx > toIdx) { var tmp = fromIdx; fromIdx = toIdx; toIdx = tmp; }
        for (var ri = fromIdx; ri <= toIdx; ri++) {
          var fv = FLOOR_MAP[FLOOR_RANK[ri]];
          if (fv && vals.indexOf(fv) < 0) vals.push(fv);
        }
      } else {
        // カンマ・もしくは・または等で分割し、各トークン内からFLOOR_MAPキーを抽出
        // 例: "2LDKもしくは、ちょっと広めの1LDK" → ["2LDK", "1LDK"]
        var floorKeys = Object.keys(FLOOR_MAP).sort(function(a,b){ return b.length - a.length; });
        function extractFloor(token) {
          if (FLOOR_MAP[token]) return FLOOR_MAP[token];
          for (var ki = 0; ki < floorKeys.length; ki++) {
            if (token.indexOf(floorKeys[ki]) >= 0) return FLOOR_MAP[floorKeys[ki]];
          }
          return null;
        }
        var rawTokens = fpStr.split(/[,、・\/\.\s]+|もしくは|または|もしくわ|あるいは/)
          .map(function(s){ return s.trim(); }).filter(Boolean);
        rawTokens.forEach(function(t) {
          var v = extractFloor(t);
          if (v && vals.indexOf(v) < 0) vals.push(v);
        });
      }
      // 広げて検索：LDK → 同室数DKも追加（1LDK→1DK, 2LDK→2DK等）
      if (cond.is_wide) {
        FLOOR_RANK.forEach(function(rank) {
          var v = FLOOR_MAP[rank];
          if (v && vals.indexOf(v) >= 0 && /LDK$/.test(rank)) {
            var dkKey = rank.replace("LDK", "DK");
            var dkVal = FLOOR_MAP[dkKey];
            if (dkVal && vals.indexOf(dkVal) < 0) vals.push(dkVal);
          }
        });
      }
      if (vals.length) setCheckboxes("room_layout_id[]", vals);
    }
    if (cond.structure_types && cond.structure_types.length > 0) {
      var sVals = cond.structure_types.map(function(s){ return STRUCTURE_MAP[s]; }).filter(Boolean);
      if (sVals.length) setCheckboxes("structured_type[]", sVals);
    }
    if (cond.pet_ok) {
      var petCb = document.querySelector('input[name="eq_rm[]"][value="113"]');
      if (petCb && !petCb.checked) petCb.click();
    }
    if (cond.rp_update_days) {
      // 更新日フィルター（update_date select: 1/3/7/14日以内）
      // 検索フォームページにのみ存在するため、存在確認してからセット
      var updEl = document.querySelector('select[name="update_date"]');
      if (updEl) {
        setSelVal("update_date", String(cond.rp_update_days));
        console.log("[AX] 更新日セット:", cond.rp_update_days + "日以内");
      } else {
        console.log("[AX] 更新日フィールド未検出（検索フォームページ以外）");
      }
    }

    // ── T=150ms: 所在地絞り込み（直接チェック — モーダルを使わない場合のみ）─────
    // detail_ward がある場合はモーダル経由で選択するのでスキップ
    // 駅・沿線指定がある場合は所在地をセットしない（リアプロはAND条件になり検索結果が出なくなる）
    // locationMode === "area" は「駅・沿線なし かつ (city_codes or detail_ward)あり」なので
    // !hasModalWard との組み合わせで従来の hasCities && !hasModalWard && !hasStation && !hasRoutes と等価
    if (locationMode === "area" && !hasModalWard) {
      var prefCb = document.querySelector('input[name="pref_code"][value="27"]');
      if (prefCb && !prefCb.checked) {
        prefCb.checked = true;
        prefCb.dispatchEvent(new Event("change", {bubbles:true}));
      }
      setTimeout(function() { setCheckboxes("city_code[]", cond.city_codes); }, 150);
    }

    // 沿線・駅なし（locationMode: area または none）
    if (locationMode === "area" || locationMode === "none") {
      if (locationMode === "none") {
        // area_mode抹消等で場所条件が空になった場合 → 全件検索せず中止（fallbackSearchWithoutAreaと同方針）
        if (_hadAreaBeforeSuppress) {
          var errNone = "area_mode=" + (cond.area_mode || "auto") +
            " 指定により場所条件が空になりました（全件検索防止のため中止）";
          showWarnToast(errNone);
          notifyDone(errNone);
          return;
        }
        // 本当に場所条件ゼロの顧客（desired_area自体が空）のみ: 従来どおり可視化して検索
        var warnNone = "場所条件なしで検索します（家賃・間取り等のみ）。";
        if (cond.unknown_tokens && cond.unknown_tokens.length) {
          warnNone = "未解決の地名: " + cond.unknown_tokens.join("、") + "\n" + warnNone;
        }
        showWarnToast(warnNone);
        setTimeout(clickSearch, 300);
        return;
      }
      if (hasModalWard) {
        // ── ポーリング方式（waitForClick）──────────────────────────────
        // 各ステップ: 要素が見つかるまで500msごとにリトライ
        //             見つかったら600ms後に次のステップを起動
        // 人間が画面を見て確認してから押すのと同等の動き
        var wardFull  = cond.detail_ward || "";
        var wardShort = wardFull.replace(/^大阪市|^大阪府/, "");
        var detailAreaName = cond.detail_area || "";
        // town_names が優先: 複数町字を全てクリック。detail_area 単体は後方互換で残す
        var townNamesForStep5 = (cond.town_names && cond.town_names.length > 0)
          ? cond.town_names : (detailAreaName ? [detailAreaName] : []);

        function closeAreaModal() {
          var d = document.querySelector('div.this_window_close');
          if (d && isVisible(d)) { d.click(); return true; }
          return clickByText(['確定してリストへ', '×とじる', '× とじる', 'とじる', '閉じる']);
        }

        // 所在地モーダル操作がタイムアウトした場合のフォールバック:
        // city_codes があれば直接チェックボックス方式に降格して検索を継続する（区レベルで検索）。
        // city_codes も無い場合のみ全件検索防止のため中止する。
        function fallbackSearchWithoutArea(msg) {
          try { closeAreaModal(); } catch (e) { /* ignore */ }
          var codes = (cond.city_codes || []).map(String);
          if (codes.length > 0) {
            // 町丁目モーダルは失敗したが区コードがある → 直接チェックで代替（ピンポイントが区レベルに降格）
            showWarnToast('所在地モーダル失敗 → 市区コードで代替検索: ' + msg);
            var prefCb2 = document.querySelector('input[name="pref_code"][value="27"]');
            if (prefCb2 && !prefCb2.checked) {
              prefCb2.checked = true;
              prefCb2.dispatchEvent(new Event('change', {bubbles:true}));
            }
            setTimeout(function() {
              try { setCheckboxes('city_code[]', codes); } catch (e) { console.error('[AX] fallback setCheckboxes例外', e); }
              setTimeout(function() {
                // 1つ以上実際にチェックされた場合のみ検索（全件検索防止）
                var applied = document.querySelectorAll('input[name="city_code[]"]:checked').length;
                if (applied > 0) {
                  clickSearch();
                } else {
                  var em = '所在地フォールバック失敗: city_codeチェック未反映（全件検索防止のため中止）: ' + msg;
                  showWarnToast(em);
                  notifyDone(em);
                }
              }, 700);
            }, 300);
            return;
          }
          // city_codes もない → 全件検索になるため中止
          var errMsg = '所在地モーダル操作失敗（全件検索防止のため中止）: ' + msg;
          showWarnToast(errMsg);
          notifyDone(errMsg);
        }

        // 「詳細な地域の設定へ進む」ボタン
        // 診断確認: class=next_action_town_search_Y のときだけ機能する
        // → Y状態を確認してからクリック・N状態なら市区郡を再クリック
        var nextBtnAttempts = 0;
        function clickNextStepBtn() {
          if (document.querySelectorAll('label.one_town').length > 0) {
            console.log('[AX] clickNextStepBtn: 町字ページ表示確認 → 完了');
            return true;
          }
          if (nextBtnAttempts % 2 === 0) {
            var btnEl = document.querySelector('div.next_step_button2');
            var isY = btnEl ? btnEl.classList.contains('town_search_Y') : false;
            if (isY) {
              simulateClick(btnEl);
              console.log('[AX] clickNextStepBtn: Y確認→クリック (試行=' + nextBtnAttempts + ')');
            } else {
              console.log('[AX] clickNextStepBtn: N待機 (試行=' + nextBtnAttempts + ')');
            }
          }
          nextBtnAttempts++;
          return false;
        }

        // 市区郡ボタンを確実にY状態にしてからコールバック
        // 診断実証済み: native .click()でdeselect→300ms→simulateClickでselect→400ms→Y確認
        function ensureWardButtonY(callback) {
          if (isWardButtonY()) { callback(); return; }
          var wardLbls = Array.prototype.slice.call(document.querySelectorAll('label')).filter(function(l){
            return !!l.querySelector('input[name="city_code[]"]');
          });
          var wTarget = null;
          var searchTerms = [wardFull, wardShort];
          for (var ci = 0; ci < searchTerms.length && !wTarget; ci++) {
            var t = norm(searchTerms[ci]);
            for (var i = 0; i < wardLbls.length; i++) {
              var ltxt = norm(wardLbls[i].textContent);
              if (ltxt === t || ltxt.includes(t) || t.includes(ltxt)) { wTarget = wardLbls[i]; break; }
            }
          }
          if (!wTarget) { console.log('[AX] ensureWardButtonY: ラベル見つからず → proceed'); callback(); return; }
          var wInp = wTarget.querySelector('input[name="city_code[]"]');
          if (wInp && wInp.checked) {
            wTarget.click();
            console.log('[AX] ensureWardButtonY: checked→deselect 300ms待機');
          }
          setTimeout(function() {
            simulateClick(wTarget);
            console.log('[AX] ensureWardButtonY: simulateClick→select 400ms待機');
            setTimeout(function() {
              if (isWardButtonY()) {
                console.log('[AX] ensureWardButtonY: Y確認 → callback');
                callback();
              } else {
                waitForClick(isWardButtonY, callback, 15, 300, 300, function() {
                  console.log('[AX] ensureWardButtonY: タイムアウト → 強制callback');
                  callback();
                });
              }
            }, 400);
          }, 300);
        }

        // STEP1: 「所在地絞り込み＋」が出るまで待ってクリック
        waitForClick(
          function() { return clickByText(['所在地絞り込み＋', '所在地絞り込み+', '所在地絞り込み']); },
          function() {
            console.log('[AX] STEP1完了: 所在地絞り込みクリック済');
            // STEP2+3を統合: 市区郡直接クリックと大阪府クリックを同時にポーリング
            // ケースA: モーダルが市区郡ページ表示中 → 大阪府をスキップして市区郡を直接クリック
            // ケースB: モーダルが都道府県ページ表示中 → 大阪府をクリック
            var prefClicked = false;

            function doAfterWard() {
              console.log('[AX] STEP3完了: 市区郡クリック済 → next_step_button2 確認');
              if (hasDetailArea) {
                // STEP3後確認: div.next_step_button2 が見えることを確認
                // 見えない場合 = 市区郡がトグルで解除された → 再クリックして再選択
                function startSTEP4() {
                  waitForClick(clickNextStepBtn,
                    function() {
                      console.log('[AX] STEP4完了: 詳細な地域へ進むクリック済 → 町字待機 detailArea:', detailAreaName);
                      // STEP5: 町字（例:「喜連西」）が出るまで待ってクリック
                      waitForClick(
                        function() {
                          var n = document.querySelectorAll('label.one_town').length;
                          console.log('[AX] STEP5 poll: label.one_town=' + n + '個 townNames:', townNamesForStep5);
                          if (n === 0) return false;
                          // 複数町字を全てクリック（townNamesForStep5 配列を順次処理）
                          var clicked = false;
                          for (var ti = 0; ti < townNamesForStep5.length; ti++) {
                            if (clickDetailArea(townNamesForStep5[ti])) clicked = true;
                          }
                          return clicked;
                        },
                        function() {
                          console.log('[AX] STEP5完了: 町字クリック済 → 閉じる待機');
                          waitForClick(closeAreaModal, function() {
                            console.log('[AX] STEP6完了: モーダル閉じた → 検索');
                            setTimeout(clickSearch, 800);
                          },
                          20, 500, 600,
                          function() {
                            // 閉じるボタンが見つからなくても検索を試みる（clickSearch が必ず notifyDone）
                            console.warn('[AX] STEP6: モーダルを閉じられず → そのまま検索');
                            setTimeout(clickSearch, 800);
                          });
                        },
                        30, 500, 600,
                        function() { fallbackSearchWithoutArea('「' + townNamesForStep5.join('、') + '」の地域ボタンが見つかりませんでした。'); }
                      );
                    },
                    30, 500, 600,
                    function() { fallbackSearchWithoutArea('「詳細な地域の設定へ進む」ボタンが見つかりませんでした。'); }
                  );
                }

                // 300ms後にボタンY状態を確認してSTEP4へ
                setTimeout(function() {
                  if (isWardButtonY()) {
                    console.log('[AX] STEP3後確認: ボタンY確認 → STEP4へ');
                    startSTEP4();
                  } else {
                    console.log('[AX] STEP3後確認: N状態 → ensureWardButtonY');
                    ensureWardButtonY(startSTEP4);
                  }
                }, 300);
              } else {
                // 広げて検索: 市区郡まで選択して閉じる（詳細地域には進まない）
                waitForClick(closeAreaModal, function() {
                  setTimeout(clickSearch, 800);
                },
                20, 500, 600,
                function() {
                  console.warn('[AX] モーダルを閉じられず → そのまま検索');
                  setTimeout(clickSearch, 800);
                });
              }
            }

            // 500msごとにポーリング:
            //   最優先: city_code[]が既にchecked = 市区郡選択済み → 再クリック禁止（トグルで解除になるため）
            //   次優先: city_code[]を持つlabelを安全クリック（大阪府記憶済みケース）
            //   最後: 大阪府をクリック（初回ケース）
            waitForClick(
              function() {
                // 最優先: 既に町字ページ表示中（モーダル記憶）→ 大阪府ブレッドクラムを誤クリックしないよう先にチェック
                if (document.querySelectorAll('label.one_town').length > 0) {
                  prefClicked = false;
                  console.log('[AX] STEP2: 既に町字ページ → STEP4へ直行');
                  return true;
                }
                if (isWardChecked()) {
                  // 連続検索対策: checked済みが「今回の顧客の区」か検証する。
                  // 前顧客の選択が残っているとそのまま検索されてしまうため、
                  // checked値が今回の city_codes に含まれない場合は解除して選び直す
                  var checkedInputs = Array.prototype.slice.call(document.querySelectorAll('label input[name="city_code[]"]:checked'));
                  var wantCodes = (cond.city_codes || []).map(String);
                  var staleInputs = checkedInputs.filter(function(inp) { return wantCodes.indexOf(String(inp.value)) === -1; });
                  if (wantCodes.length === 0 || checkedInputs.length === 0 || staleInputs.length === 0) {
                    // 検証不能（期待コードなし/チェックボックス未描画）または一致 → 従来通りスキップ
                    prefClicked = false; console.log('[AX] STEP2: city_code[]選択済みを検出 → 再クリックスキップ'); return true;
                  }
                  console.log('[AX] STEP2: 前顧客のcity_code残留を検出（' + staleInputs.length + '件）→ 解除して選び直し');
                  staleInputs.forEach(function(inp) {
                    var lbl = inp.closest ? inp.closest('label') : null;
                    if (lbl) simulateClick(lbl); // トグルで解除
                  });
                  if (clickWardPrecise([wardFull, wardShort])) { prefClicked = false; return true; }
                  return false; // 市区郡ラベル未描画 → 次ポーリングで再試行
                }
                if (clickWardPrecise([wardFull, wardShort])) { prefClicked = false; return true; }
                if (clickByText(['大阪府'])) { prefClicked = true; return true; }
                return false;
              },
              function() {
                if (!prefClicked) {
                  // 市区郡選択済みOR直接クリック完了 → 次のステップへ
                  doAfterWard();
                } else {
                  // 大阪府クリック後 → 市区郡ページへ遷移を待ってクリック
                  waitForClick(
                    function() { return clickWardPrecise([wardFull, wardShort]); },
                    doAfterWard,
                    30, 500, 600,
                    function() { fallbackSearchWithoutArea('「' + wardFull + '」の市区郡ボタンが見つかりませんでした。'); }
                  );
                }
              },
              30, 500, 600,
              function() { fallbackSearchWithoutArea('大阪府または市区郡の選択ができませんでした。'); }
            );
          },
          30, 500, 600,
          function() { fallbackSearchWithoutArea('「所在地絞り込み」ボタンが見つかりませんでした。'); }
        );
      } else {
        // area && !hasModalWard: 直接チェック（T=150ms）反映後に検索（none は上で処理済み）
        setTimeout(function() { clickSearch(); }, 700);
      }
      return;
    }

    // ── ここから locationMode === "station" || "route" ──────────────────────
    // 駅+地域併記時: リアプロはAND条件になるため地域条件は捨てる（仕様維持）が、
    // 黙って捨てず必ず可視化する
    if ((locationMode === "station" || locationMode === "route") &&
        (hasModalWard || hasCities)) {
      console.log("[AX] 駅/沿線条件を優先し、地域条件（" +
        (cond.detail_ward || (cond.city_codes || []).join(",")) + "）はスキップ");
      showWarnToast("駅条件を優先し、地域条件はスキップしました。");
    }

    // 沿線 form state を事前セット（モーダルを開いた時に反映される可能性あり）
    if (hasRoutes) {
      setCheckboxes("route_id[]", cond.route_ids);
    }

    // 沿線・駅モーダル：waitForClick方式（必ず駅が選択されるまでリトライ）
    function closeStationModal() {
      var d = document.querySelector('div.this_window_close');
      if (d && isVisible(d)) { d.click(); return true; }
      return clickByText(['確定してリストへ', '×とじる', '× とじる', 'とじる']);
    }

    // 沿線・駅モーダル操作がタイムアウトした場合のフォールバック:
    // 全件検索（エリアなし）を送信するのは誤物件LINE送信の原因になるためnotifyDone(error)で中止する。
    // fallbackSearchWithoutArea と同じ方針: エリア条件が解決できない場合は検索しない。
    function fallbackSearchWithoutStation(msg) {
      var errMsg = '沿線・駅モーダル操作失敗（全件検索防止のため中止）: ' + msg;
      showWarnToast(errMsg);
      try { closeStationModal(); } catch (e) { /* ignore */ }
      notifyDone(errMsg);
    }

    // STEP A: 「沿線・駅絞り込み＋」が出るまで待ってクリック
    waitForClick(
      function() {
        var clsTargets = ['click_menu', 'one_slide_search_box'];
        for (var ci = 0; ci < clsTargets.length; ci++) {
          var divs = Array.prototype.slice.call(document.querySelectorAll('div.' + clsTargets[ci]));
          for (var i = 0; i < divs.length; i++) {
            if (!isVisible(divs[i])) continue;
            var t = divs[i].textContent.replace(/\s+/g, '');
            if (t.includes('沿線・駅絞り込み')) {
              divs[i].click(); return true;
            }
          }
        }
        return clickByText(['沿線・駅絞り込み＋', '沿線・駅絞り込み+', '沿線・駅絞り込み']);
      },
      function() {
        // STEP B: 路線ボタン（label.one_line）が描画されたらクリック
        var stationPageDirect = false;
        waitForClick(
          function() {
            var labels = Array.prototype.slice.call(document.querySelectorAll('label.one_line'));
            var vis = labels.filter(function(l) { return isVisible(l); });
            if (!vis.length) {
              // 駅ページが直接表示されている場合（モーダルが前回の状態を記憶）
              var stationInputs = Array.prototype.slice.call(document.querySelectorAll('input[name="station_code[]"]'));
              var visStationInputs = stationInputs.filter(function(i) { return isVisible(i); });
              if (visStationInputs.length) {
                console.log('[AX] STEP B: 駅ページが直接表示 → stationPageDirect=true');
                stationPageDirect = true;
                return true;
              }
              return false; // まだ描画されていない
            }
            if (hasRoutes) clickLineButtons(cond.route_ids);
            return true;
          },
          function() {
            // STEP C: 「駅の設定へ進む」が出るまで待ってクリック
            waitForClick(
              function() {
                if (stationPageDirect) { console.log('[AX] STEP C: 駅ページ直接表示 → スキップ'); return true; }
                return clickByText(['駅の設定へ進む', '駅の設定へ進む›', '駅の設定へ進む>']);
              },
              function() {
                if (!hasStation) {
                  // 駅指定なし → そのまま閉じて検索
                  waitForClick(closeStationModal, function() { setTimeout(clickSearch, 800); },
                    20, 500, 600,
                    function() {
                      console.warn('[AX] 沿線モーダルを閉じられず → そのまま検索');
                      setTimeout(clickSearch, 800);
                    });
                  return;
                }
                var stNamesStr = (cond.station_names || []).join('・');
                // STEP D: 駅ページが描画され、かつ指定駅が選択されるまでリトライ
                waitForClick(
                  function() {
                    var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
                    var vis = labels.filter(function(l) { return isVisible(l); });
                    if (!vis.length) return false; // 駅リストがまだ描画されていない
                    selectStationsByName(cond.station_names);
                    // 指定駅のいずれかがチェックされたか確認
                    return (cond.station_names || []).some(function(sn) {
                      var clean = sn.replace(/駅$/, '').trim();
                      return vis.some(function(l) {
                        var txt = l.textContent.replace(/\s+/g, '').replace(/駅$/, '');
                        if (txt !== clean && !txt.includes(clean) && !clean.includes(txt)) return false;
                        var inp = l.querySelector('input[type="checkbox"]');
                        if (!inp && l.htmlFor) inp = document.getElementById(l.htmlFor);
                        return inp && inp.checked;
                      });
                    });
                  },
                  function() {
                    // STEP E: 駅が選択された → モーダルを閉じる
                    waitForClick(closeStationModal, function() {
                      // STEP F: 検索実行（駅が確定してから）
                      setTimeout(clickSearch, 800);
                    },
                    20, 500, 600,
                    function() {
                      console.warn('[AX] 駅モーダルを閉じられず → そのまま検索');
                      setTimeout(clickSearch, 800);
                    });
                  },
                  30, 500, 600,
                  function() { fallbackSearchWithoutStation('指定の駅が選択できませんでした。\n駅: ' + stNamesStr); }
                );
              },
              30, 500, 600,
              function() { fallbackSearchWithoutStation('「駅の設定へ進む」ボタンが見つかりませんでした。'); }
            );
          },
          30, 500, 600,
          function() { fallbackSearchWithoutStation('路線一覧が表示されませんでした。'); }
        );
      },
      30, 500, 600,
      function() { fallbackSearchWithoutStation('「沿線・駅絞り込み」ボタンが見つかりませんでした。'); }
    );

    } catch (err) {
      // 本体の同期例外（不正な条件データ等）でも fill-done を必ず送る
      console.error('[AX] fillRealpro 本体例外 → fill-done送信', err);
      notifyDone('fillRealpro: ' + ((err && err.message) || String(err)));
    }
    }, 0); // _doReset内で待機済みのため即時実行
    }); // _doReset end
  }

  window.addEventListener("message", function(e) {
    if (!e.data || e.data.from !== "aixlinx-fill") return;
    try {
      fillRealpro(e.data.conditions);
    } catch (err) {
      // fill-done 保証: 同期例外でも必ず完了シグナルを送る
      console.error('[AX] fillRealpro 同期例外 → fill-done送信', err);
      notifyDone('fillRealpro listener: ' + ((err && err.message) || String(err)));
    }
  });
})();
