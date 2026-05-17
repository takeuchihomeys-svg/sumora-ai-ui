(function () {
  "use strict";

  function setReactVal(el, val) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, String(val));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function tick(el) {
    if (el && !el.checked) el.click();
  }

  // getBoundingClientRect で判定（position:fixed のモーダル要素も正しく検出）
  function isVis(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  // label のみ（チェックボックス用）
  function clickLabel(text) {
    var found = [].slice.call(document.querySelectorAll("label")).find(function (l) {
      return l.textContent.trim() === text && isVis(l);
    });
    if (found) { found.click(); return true; }
    return false;
  }

  // button のみ
  function clickBtn(text) {
    var found = [].slice.call(document.querySelectorAll("button")).find(function (b) {
      return b.textContent.trim() === text && isVis(b);
    });
    if (found) { found.click(); return true; }
    return false;
  }

  // label・button・li・span・a を横断して探す（モーダルナビ用）
  function clickAny(text) {
    var els = [].slice.call(document.querySelectorAll("label, button, li, span, a, div[role='button'], div[role='option']"));
    var found = els.find(function (el) {
      return el.textContent.trim() === text && isVis(el);
    });
    if (found) { found.click(); return true; }
    return false;
  }

  // 所在地モーダル: 所在地で絞り込み → 大阪府 → 市区 → 確定
  function selectItandiArea(wardName, callback) {
    if (!wardName) { if (callback) callback(); return; }
    if (!clickBtn("所在地で絞り込み")) { if (callback) callback(); return; }
    setTimeout(function () {
      clickAny("大阪府");
      setTimeout(function () {
        clickAny(wardName) || clickLabel(wardName);
        setTimeout(function () {
          clickBtn("確定");
          setTimeout(callback || function () {}, 500);
        }, 500);
      }, 500);
    }, 700);
  }

  // 路線・駅モーダル: 路線・駅で絞り込み → 近畿 → 大阪府 → 路線チェック → 確定
  function selectItandiLines(lineNames, callback) {
    if (!lineNames || !lineNames.length) { if (callback) callback(); return; }
    if (!clickBtn("路線・駅で絞り込み")) { if (callback) callback(); return; }
    setTimeout(function () {
      clickAny("近畿");
      setTimeout(function () {
        clickAny("大阪府");
        setTimeout(function () {
          lineNames.forEach(function (line) { clickAny(line) || clickLabel(line); });
          setTimeout(function () {
            clickBtn("確定");
            setTimeout(callback || function () {}, 500);
          }, 500);
        }, 500);
      }, 500);
    }, 700);
  }

  var STRUCTURE_MAP = {
    "木造": "wooden", "木造一部RC造": "wooden",
    "鉄骨造": "steel", "S造": "steel", "重量鉄骨造": "steel",
    "軽量鉄骨造": "lightweight_steel",
    "鉄筋コンクリート造": "rc", "RC": "rc", "RC造": "rc",
    "鉄骨鉄筋コンクリート造": "src", "SRC": "src", "SRC造": "src",
  };

  var VALID_LAYOUTS = ["1R","1K","1DK","1LDK","2K","2DK","2LDK","3K","3DK","3LDK","4K","4DK","4LDK","5K_OVER"];

  function fill(cond) {
    // 賃料上限（itandiは万円単位）
    if (cond.rent_max) {
      var rentVal = cond.rent_max > 1000 ? Math.floor(cond.rent_max / 10000) : cond.rent_max;
      var rentEl = document.querySelector('input[name="rent:lteq"]');
      if (rentEl) setReactVal(rentEl, rentVal);
    }

    // 管理費・共益費込み（常にチェック）
    tick(document.querySelector('input[name="totalRentCheck"]'));

    // 駅徒歩
    if (cond.walk_minutes) {
      var walkEl = document.querySelector('input[name="station_walk_minutes:lteq"]');
      if (walkEl) setReactVal(walkEl, cond.walk_minutes);
    }

    // 築年数
    if (cond.building_age) {
      var ageEl = document.querySelector('input[name="building_age:lteq"]');
      if (ageEl) setReactVal(ageEl, cond.building_age);
    }

    // 間取り
    if (cond.floor_plan) {
      cond.floor_plan.split(/[・,、\/\.\s]+/).forEach(function (plan) {
        plan = plan.trim();
        if (VALID_LAYOUTS.indexOf(plan) !== -1) {
          tick(document.querySelector('input[name="room_layout:in"][id="' + plan + '"]'));
        }
      });
    }

    // 構造
    if (cond.structure_types && cond.structure_types.length) {
      cond.structure_types.forEach(function (s) {
        var v = STRUCTURE_MAP[s];
        if (v) tick(document.querySelector('input[name="structure_type:in"][id="' + v + '"]'));
      });
    }

    // ペット相談
    if (cond.pet_ok) {
      tick(document.querySelector('input[name="option_id:all_in"][id="22010"]'));
    }

    // バス・トイレ別
    if (cond.preferences && /バス.*トイレ別|トイレ別|バストイレ別/i.test(cond.preferences)) {
      tick(document.querySelector('input[name="option_id:all_in"][id="11010"]'));
    }

    // 所在地 or 路線・駅モーダル → 最後に検索ボタン自動クリック
    setTimeout(function () {
      function doSearch() {
        setTimeout(function () { clickBtn("検索"); }, 500);
      }
      if (cond.ward_name) {
        selectItandiArea(cond.ward_name, doSearch);
      } else if (cond.itandi_lines && cond.itandi_lines.length) {
        selectItandiLines(cond.itandi_lines, doSearch);
      } else {
        doSearch();
      }
    }, 300);
  }

  window.addEventListener("axlx-itandi-fill", function (e) { fill(e.detail); });
})();
