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

  function norm(s) {
    return String(s)
      .replace(/（/g, "(").replace(/）/g, ")")
      .replace(/〜/g, "~").replace(/～/g, "~")
      .replace(/　/g, " ")
      .trim();
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

  // label内のcheckboxを優先してクリック（React対応・トグル戻り防止）
  function clickLabel(text) {
    var lbl = [].slice.call(document.querySelectorAll("label")).find(function (l) {
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

  // buttonのみ完全一致（誤クリック防止）
  function clickBtn(text) {
    var n = norm(text);
    var found = [].slice.call(document.querySelectorAll("button")).find(function (b) {
      return norm(b.textContent) === n && isVis(b);
    });
    if (found) { found.click(); return true; }
    return false;
  }

  // ナビタブ（li/button/a/span）完全一致
  function clickNav(text) {
    var n = norm(text);
    var els = [].slice.call(document.querySelectorAll("li, button, a, span, div[role='button']"));
    var found = els.find(function (el) {
      return norm(el.textContent) === n && isVis(el);
    });
    if (found) { found.click(); return true; }
    return false;
  }

  // ── 所在地モーダル ────────────────────────────────────────────────────
  // T=0   : 「所在地で絞り込み」ボタン
  // T=900 : 「大阪府」タブ
  // T=1800: 市区チェックボックス
  // T=2700: 「確定」ボタン
  // T=2700+1500=4200: callback（doSearch）
  function selectItandiArea(wardName, callback) {
    if (!wardName) { if (callback) callback(); return; }
    if (!clickBtn("所在地で絞り込み")) { if (callback) callback(); return; }
    setTimeout(function () {
      clickNav("大阪府");
      setTimeout(function () {
        clickLabel(wardName);
        setTimeout(function () {
          clickBtn("確定");
          setTimeout(callback || function () {}, 1500);
        }, 900);
      }, 900);
    }, 900);
  }

  // ── 路線・駅モーダル ─────────────────────────────────────────────────
  // T=0    : 「路線・駅で絞り込み」ボタン
  // T=900  : 「近畿」タブ
  // T=1700 : 「大阪府」タブ
  // T=2500 : 路線チェック（1路線700ms間隔）
  // T=最終路線+1200: 駅チェック開始（1駅600ms間隔）
  // T=最終駅+600  : 「確定」ボタン
  // T=確定+1500   : callback（doSearch）
  function selectItandiLines(lineNames, stationNames, callback) {
    if (!lineNames || !lineNames.length) { if (callback) callback(); return; }
    if (!clickBtn("路線・駅で絞り込み")) { if (callback) callback(); return; }

    var stNames = (stationNames || []).map(function (s) { return s.replace(/駅$/, "").trim(); }).filter(Boolean);

    setTimeout(function () {
      clickNav("近畿");
      setTimeout(function () {
        clickNav("大阪府");
        setTimeout(function () {

          // 路線を1本ずつ順番にクリック
          var lineIdx = 0;
          function clickNextLine() {
            if (lineIdx >= lineNames.length) {
              // 全路線チェック完了 → 駅リスト描画を待つ
              setTimeout(function () {
                if (stNames.length) {
                  // 駅を1つずつ順番にクリック
                  var stIdx = 0;
                  function clickNextStation() {
                    if (stIdx >= stNames.length) {
                      // 全駅チェック完了 → 確定
                      setTimeout(function () {
                        clickBtn("確定");
                        setTimeout(callback || function () {}, 1500);
                      }, 600);
                      return;
                    }
                    clickLabel(stNames[stIdx]);
                    stIdx++;
                    setTimeout(clickNextStation, 600);
                  }
                  clickNextStation();
                } else {
                  // 駅指定なし → 確定
                  clickBtn("確定");
                  setTimeout(callback || function () {}, 1500);
                }
              }, 1200);
              return;
            }
            clickLabel(lineNames[lineIdx]);
            lineIdx++;
            setTimeout(clickNextLine, 700);
          }
          clickNextLine();

        }, 800);
      }, 800);
    }, 900);
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
    // ── 基本条件（即座に入力）────────────────────────────────────────────

    // 賃料上限（itandiは万円単位）
    if (cond.rent_max) {
      var rentVal = cond.rent_max > 1000 ? Math.floor(cond.rent_max / 10000) : cond.rent_max;
      var rentEl = document.querySelector('input[name="rent:lteq"]');
      if (rentEl) setReactVal(rentEl, rentVal);
    }

    // 管理費込みチェック
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

    // ── モーダル操作 → 最後に検索（React state更新を2000ms待つ）──────────
    // 基本条件の入力が落ち着いてからモーダル開始（500ms待機）
    setTimeout(function () {

      // モーダル確定後2000ms待ってから検索ボタンをクリック
      function doSearch() {
        setTimeout(function () { clickBtn("検索"); }, 2000);
      }

      if (cond.ward_name) {
        selectItandiArea(cond.ward_name, doSearch);
      } else if (cond.itandi_lines && cond.itandi_lines.length) {
        var stNames = cond.station_names || (cond.station_name ? [cond.station_name] : []);
        selectItandiLines(cond.itandi_lines, stNames, doSearch);
      } else {
        // エリア・路線なし：基本条件だけで検索（1500ms待ってからクリック）
        setTimeout(function () { clickBtn("検索"); }, 1500);
      }

    }, 500);
  }

  window.addEventListener("axlx-itandi-fill", function (e) { fill(e.detail); });
})();
