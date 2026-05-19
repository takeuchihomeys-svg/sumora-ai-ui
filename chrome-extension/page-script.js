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
  // 駅名（文字列）でラベル一致するチェックボックスを選択
  // 駅名でボタン/チェックボックスをクリック（完全一致→前方一致の順）
  function selectStationsByName(names) {
    if (!names || !names.length) return;
    names.forEach(function(name) {
      var clean = name.replace(/駅$/, '').trim();
      if (!clean) return;
      var found = false;

      // ── パターン1: label > checkbox（フォーム方式） ──
      var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
      for (var i = 0; i < labels.length; i++) {
        var lblTxt = labels[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if (lblTxt === clean) {
          var inp = labels[i].querySelector('input[type="checkbox"]');
          if (!inp && labels[i].htmlFor) inp = document.getElementById(labels[i].htmlFor);
          if (inp && !inp.checked) { inp.click(); found = true; break; }
        }
      }
      if (found) return;

      // ── パターン2: リアプロ 駅ボタン（a/button/div/span/td等） ──
      // 駅名は短い（2〜12文字程度）ので textContent 長さでフィルタ
      var candidates = Array.prototype.slice.call(
        document.querySelectorAll('a, button, td, li, span, div')
      ).filter(function(el) {
        if (!el.offsetParent) return false;
        var txt = el.textContent.replace(/\s+/g, '');
        return txt.length >= 2 && txt.length <= 15;
      });

      // 完全一致
      for (var i = 0; i < candidates.length; i++) {
        var txt = candidates[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if (txt === clean) { candidates[i].click(); found = true; break; }
      }
      if (found) return;

      // 前方・逆前方一致（"東花"→"東花園" / "若江"→"若江岩田" 等）
      for (var i = 0; i < candidates.length; i++) {
        var txt = candidates[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if (txt.length >= 2 && clean.length >= 2 &&
            (txt.startsWith(clean) || clean.startsWith(txt))) {
          candidates[i].click(); found = true; break;
        }
      }
      if (found) return;

      // パターン1 前方一致フォールバック
      for (var i = 0; i < labels.length; i++) {
        var lblTxt = labels[i].textContent.replace(/\s+/g, '').replace(/駅$/, '');
        if ((lblTxt.startsWith(clean) || clean.startsWith(lblTxt)) && lblTxt.length >= 2) {
          var inp = labels[i].querySelector('input[type="checkbox"]');
          if (!inp && labels[i].htmlFor) inp = document.getElementById(labels[i].htmlFor);
          if (inp && !inp.checked) { inp.click(); found = true; break; }
        }
      }
    });
  }

  function fillRealpro(cond) {
    if (!cond) return;
    if (cond.rent_min) setSelVal("rental_cost1", nearestDown(RENT_OPTS, cond.rent_min));
    if (cond.rent_max) setSelVal("rental_cost2", nearestUp(RENT_OPTS, cond.rent_max));
    // 管理費・共益費含む を常にON
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
    // 所在地（city_code[]）
    if (cond.city_codes && cond.city_codes.length > 0) {
      var prefCb = document.querySelector('input[name="pref_code"][value="27"]');
      if (prefCb && !prefCb.checked) {
        prefCb.checked = true;
        prefCb.dispatchEvent(new Event("change", {bubbles:true}));
      }
      setTimeout(function() { setCheckboxes("city_code[]", cond.city_codes); }, 150);
    }
    // 沿線（route_id[]）
    if (cond.route_ids && cond.route_ids.length > 0) {
      setCheckboxes("route_id[]", cond.route_ids);
    }
    // 駅選択：沿線チェック後 DOM 更新を待ってボタンをクリック
    if (cond.station_names && cond.station_names.length > 0) {
      setTimeout(function() {
        selectStationsByName(cond.station_names);
        // 駅選択後にモーダル「×とじる」を閉じる
        setTimeout(function() {
          var allEl = Array.prototype.slice.call(document.querySelectorAll('a, button, div, span'));
          for (var i = 0; i < allEl.length; i++) {
            if (!allEl[i].offsetParent) continue;
            var txt = allEl[i].textContent.replace(/\s+/g, '');
            if (txt === '×とじる' || txt === 'とじる') { allEl[i].click(); break; }
          }
        }, 600);
      }, 500);
    }
    // 物件構造（structured_type[]）
    if (cond.structure_types && cond.structure_types.length > 0) {
      var sVals = cond.structure_types.map(function(s){ return STRUCTURE_MAP[s]; }).filter(Boolean);
      if (sVals.length) setCheckboxes("structured_type[]", sVals);
    }
    // ペット相談（eq_rm[] value=113）
    if (cond.pet_ok) {
      var petCb = document.querySelector('input[name="eq_rm[]"][value="113"]');
      if (petCb && !petCb.checked) petCb.click();
    }
    // 検索ボタン自動クリック（駅あり: 駅選択600ms+モーダル閉じ600ms+余裕600ms=1800ms）
    var searchDelay = (cond.station_names && cond.station_names.length) ? 1800 : 600;
    setTimeout(function() {
      var allBtns = Array.prototype.slice.call(
        document.querySelectorAll('button, input[type="submit"], a')
      );
      var btn = allBtns.find(function(b) {
        var txt = (b.textContent || b.value || '').replace(/\s+/g, '');
        return txt === '検索' || txt === '物件を検索する' || txt === '条件で検索';
      });
      if (btn) btn.click();
    }, searchDelay);
  }

  window.addEventListener("message", function(e) {
    if (!e.data || e.data.from !== "aixlinx-fill") return;
    fillRealpro(e.data.conditions);
  });
})();
