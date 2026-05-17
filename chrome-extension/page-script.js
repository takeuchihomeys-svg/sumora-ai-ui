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
      var on = vals.indexOf(cb.value) >= 0;
      if (cb.checked !== on) {
        cb.checked = on;
        cb.dispatchEvent(new Event("change", {bubbles:true}));
      }
    });
  }
  function fillRealpro(cond) {
    if (!cond) return;
    if (cond.rent_min) setSelVal("rental_cost1", nearestDown(RENT_OPTS, cond.rent_min));
    if (cond.rent_max) setSelVal("rental_cost2", nearestUp(RENT_OPTS, cond.rent_max));
    if (cond.walk_minutes) {
      setSelVal("transportation_id", "1");
      setTxtVal("required_time", cond.walk_minutes);
    }
    if (cond.building_age) setSelVal("structured_date", nearestUp(AGE_OPTS, cond.building_age));
    if (cond.floor_plan) {
      var plans = cond.floor_plan.split(/[,、・\/\s]+/).map(function(s){return s.trim();}).filter(Boolean);
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
  }

  window.addEventListener("message", function(e) {
    if (!e.data || e.data.from !== "aixlinx-fill") return;
    fillRealpro(e.data.conditions);
  });
})();
