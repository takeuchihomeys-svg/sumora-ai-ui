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
    var cbs = document.querySelectorAll('input[name="' + name + '"]');
    cbs.forEach(function(cb) {
      var shouldCheck = vals.indexOf(cb.value) >= 0;
      if (cb.checked !== shouldCheck) {
        cb.click();
      }
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
        if (!els[i].offsetParent) continue;
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
        if (!els[i].offsetParent) continue;
        if (norm(els[i].textContent).indexOf(cand) >= 0) {
          els[i].click(); return true;
        }
      }
    }
    return false;
  }

  // 検索ボタンをクリック
  // リアプロは DIV.go_search が実際の検索ボタン（診断で確認済み）
  function clickSearch() {
    // 優先: div.go_search（リアプロのメイン検索ボタン）
    var goDivs = Array.prototype.slice.call(
      document.querySelectorAll('div.go_search, div.go_search_submit')
    );
    for (var i = 0; i < goDivs.length; i++) {
      if (goDivs[i].offsetParent) { goDivs[i].click(); return; }
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
        if (txt === SEARCH_TEXTS[si]) { b.click(); return; }
      }
    }
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
        if (!labels[i].offsetParent) continue;
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
        if (!labels[i].offsetParent) continue;
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
        if (!labels[i].offsetParent) continue;
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
        if (!els[i].offsetParent) continue;
        if (getDirectText(els[i]) === clean) { fireClick(els[i]); found = true; }
      }
      if (found) return;

      // STEP3: 全テキスト完全一致かつ葉ノード
      for (var i = 0; i < els.length && !found; i++) {
        if (!els[i].offsetParent) continue;
        var ft = els[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if (ft === clean && els[i].children.length === 0) { fireClick(els[i]); found = true; }
      }
      if (found) return;

      // STEP4: 直接テキスト 前方一致
      for (var i = 0; i < els.length && !found; i++) {
        if (!els[i].offsetParent) continue;
        var dt = getDirectText(els[i]);
        if (dt.length >= 2 && clean.length >= 2 &&
            (dt.startsWith(clean) || clean.startsWith(dt))) {
          fireClick(els[i]); found = true;
        }
      }
      if (found) return;

      // STEP5: label 前方一致フォールバック
      for (var i = 0; i < labels.length && !found; i++) {
        if (!labels[i].offsetParent) continue;
        var txt = labels[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if ((txt.startsWith(clean) || clean.startsWith(txt)) && txt.length >= 2) {
          var inp = labels[i].querySelector('input[type="checkbox"]');
          if (!inp && labels[i].htmlFor) inp = document.getElementById(labels[i].htmlFor);
          if (inp && !inp.checked) { inp.click(); found = true; }
        }
      }
    });
  }

  // 詳細地域（町丁目レベル）のチェックボックスを選択する（4段階フォールバック）
  function clickDetailArea(name) {
    if (!name) return false;
    var clean = name.trim();

    function tryLabel(matchFn) {
      var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
      for (var i = 0; i < labels.length; i++) {
        if (!labels[i].offsetParent) continue;
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
      var els = Array.prototype.slice.call(document.querySelectorAll('a,div,span,td,li,button'));
      for (var i = 0; i < els.length; i++) {
        if (!els[i].offsetParent) continue;
        var txt = els[i].textContent.replace(/\s+/g, '');
        if (matchFn(txt)) { els[i].click(); return true; }
      }
      return false;
    }

    // PASS1: 完全一致
    if (tryLabel(function(t){ return t === clean; })) return true;
    // PASS2: 前方一致（「喜連西1丁目〜5丁目」等）
    if (tryLabel(function(t){ return t.startsWith(clean); })) return true;
    // PASS3: 部分一致（要素テキストに地名が含まれる）
    if (tryLabel(function(t){ return t.includes(clean); })) return true;
    // PASS4: 逆部分一致（地名が要素テキストを含む — 短いラベル向け）
    if (clean.length >= 2) {
      if (tryLabel(function(t){ return t.length >= 2 && clean.includes(t); })) return true;
    }
    // PASS5〜8: label でヒットしなければ div/span/a 等も同順で試みる
    if (tryEl(function(t){ return t === clean; })) return true;
    if (tryEl(function(t){ return t.startsWith(clean); })) return true;
    if (tryEl(function(t){ return t.includes(clean); })) return true;
    return false;
  }

  function fillRealpro(cond) {
    if (!cond) return;

    var hasStation   = cond.station_names && cond.station_names.length > 0;
    var hasRoutes    = cond.route_ids && cond.route_ids.length > 0;
    var hasCities    = cond.city_codes && cond.city_codes.length > 0;
    var hasDetailArea = !!(cond.detail_area);

    // ── T=0ms: 基本条件 ──────────────────────────────────────────────
    if (cond.rent_min) setSelVal("rental_cost1", nearestDown(RENT_OPTS, cond.rent_min));
    if (cond.rent_max) setSelVal("rental_cost2", nearestUp(RENT_OPTS, cond.rent_max));
    var feeCb = document.querySelector('input[name="include_common_fee"]');
    if (feeCb && !feeCb.checked) feeCb.click();
    if (cond.walk_minutes) {
      setSelVal("transportation_id", "1");
      setTxtVal("required_time", cond.walk_minutes);
    }
    if (cond.building_age) setSelVal("structured_date", nearestUp(AGE_OPTS, cond.building_age));
    if (cond.floor_plan) {
      var plans = cond.floor_plan.split(/[,、・\/\.\s]+/).map(function(s){return s.trim();}).filter(Boolean);
      var vals = plans.map(function(p){return FLOOR_MAP[p];}).filter(Boolean);
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

    // ── T=150ms: 所在地絞り込み（直接チェック — 詳細地域なし時のみ）─────
    // ピンポイント+詳細地域の場合はモーダル経由で選択するのでスキップ
    if (hasCities && !hasDetailArea) {
      var prefCb = document.querySelector('input[name="pref_code"][value="27"]');
      if (prefCb && !prefCb.checked) {
        prefCb.checked = true;
        prefCb.dispatchEvent(new Event("change", {bubbles:true}));
      }
      setTimeout(function() { setCheckboxes("city_code[]", cond.city_codes); }, 150);
    }

    // 沿線・駅なし
    if (!hasStation && !hasRoutes) {
      if (hasDetailArea) {
        // ピンポイント：所在地絞り込みモーダルを3ステップで操作
        // 都道府県の設定 → 市区郡の設定（区クリック） → 町字の設定（地名クリック）
        var detailAreaName = cond.detail_area || "";
        var wardFull  = cond.detail_ward || "";                          // 「大阪市平野区」
        var wardShort = wardFull.replace(/^大阪市|^大阪府/, "");         // 「平野区」
        setTimeout(function() {
          clickByText(['所在地絞り込み＋', '所在地絞り込み+', '所在地絞り込み']);
        }, 300);
        setTimeout(function() {
          clickByText(['大阪府']);
        }, 1100);
        setTimeout(function() {
          clickByText([wardFull, wardShort]);
        }, 2000);
        setTimeout(function() {
          clickDetailArea(detailAreaName);
        }, 2800);
        setTimeout(function() {
          var closeDiv = document.querySelector('div.this_window_close');
          if (closeDiv && closeDiv.offsetParent) { closeDiv.click(); return; }
          clickByText(['×とじる', '× とじる', 'とじる', '閉じる']);
        }, 3600);
        setTimeout(function() { clickSearch(); }, 4600);
      } else {
        setTimeout(function() { clickSearch(); }, hasCities ? 700 : 300);
      }
      return;
    }

    // 沿線 form state を事前セット（モーダルを開いた時に反映される可能性あり）
    if (hasRoutes) {
      setCheckboxes("route_id[]", cond.route_ids);
    }

    // ── T=600ms: 「沿線・駅絞り込み ＋」をクリックしてモーダルを開く ──
    setTimeout(function() {
      // click_menu class が実際のクリッカブル要素（診断結果より）
      var clsTargets = ['click_menu', 'one_slide_search_box'];
      var opened = false;
      for (var ci = 0; ci < clsTargets.length && !opened; ci++) {
        var divs = Array.prototype.slice.call(document.querySelectorAll('div.' + clsTargets[ci]));
        for (var i = 0; i < divs.length; i++) {
          if (!divs[i].offsetParent) continue;
          var t = divs[i].textContent.replace(/\s+/g, '');
          if (t === '沿線・駅絞り込み＋' || t === '沿線・駅絞り込み+') {
            divs[i].click(); opened = true; break;
          }
        }
      }
      // フォールバック
      if (!opened) clickByText(['沿線・駅絞り込み＋', '沿線・駅絞り込み+', '沿線・駅絞り込み']);
    }, 600);

    // ── T=1800ms: 路線ボタンをクリック（モーダル内）───────────────────
    setTimeout(function() {
      if (hasRoutes) clickLineButtons(cond.route_ids);
    }, 1800);

    // ── T=2900ms: 「駅の設定へ進む」をクリック ──────────────────────
    setTimeout(function() {
      clickByText(['駅の設定へ進む', '駅の設定へ進む›', '駅の設定へ進む>']);
    }, 2900);

    // ── T=4000ms: 駅ボタンをクリック ────────────────────────────────
    setTimeout(function() {
      if (hasStation) selectStationsByName(cond.station_names);
    }, 4000);

    // ── T=4900ms: モーダルを閉じる（「確定してリストへ」= DIV.this_window_close 診断済み）
    setTimeout(function() {
      // 優先: 確定してリストへ（DIV.this_window_close）
      var closeDiv = document.querySelector('div.this_window_close');
      if (closeDiv && closeDiv.offsetParent) { closeDiv.click(); return; }
      // フォールバック: テキスト一致
      var allEl = Array.prototype.slice.call(document.querySelectorAll('a,button,div,span'));
      for (var i = 0; i < allEl.length; i++) {
        if (!allEl[i].offsetParent) continue;
        var txt = allEl[i].textContent.replace(/\s+/g, '');
        if (txt === '確定してリストへ' || txt === '×とじる' || txt === 'とじる') {
          allEl[i].click(); break;
        }
      }
    }, 4900);

    // ── T=5700ms: 検索実行 ───────────────────────────────────────────
    setTimeout(function() {
      clickSearch();
    }, 5700);
  }

  window.addEventListener("message", function(e) {
    if (!e.data || e.data.from !== "aixlinx-fill") return;
    fillRealpro(e.data.conditions);
  });
})();
