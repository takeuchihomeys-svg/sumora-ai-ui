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

  // label内のcheckboxを優先（React対応）
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

  // buttonのみ完全一致
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

  // ── 所在地モーダル ───────────────────────────────────────────────────────
  // 戻り値: boolean（モーダルを開けたか）
  // ボタンが見つからない場合は何もしない（呼び出し元のsafetyTimerが検索する）
  function selectItandiArea(wardName, onDone) {
    if (!wardName) return false;
    // ボタンテキスト候補（表記ゆれ対応）
    var opened = clickBtn("所在地で絞り込み") || clickBtn("エリアで絞り込み") || clickBtn("地域で絞り込み");
    if (!opened) return false; // モーダル開けず → safetyTimerに任せる

    setTimeout(function () {
      clickNav("大阪府");
      setTimeout(function () {
        clickLabel(wardName);
        setTimeout(function () {
          clickBtn("確定");
          setTimeout(onDone, 2000); // 確定後2000ms待ってから検索
        }, 1000);
      }, 1000);
    }, 1000);
    return true;
  }

  // ── 路線・駅モーダル ─────────────────────────────────────────────────────
  // 戻り値: boolean（モーダルを開けたか）
  function selectItandiLines(lineNames, stationNames, onDone) {
    if (!lineNames || !lineNames.length) return false;
    var opened = clickBtn("路線・駅で絞り込み") || clickBtn("路線で絞り込み") || clickBtn("沿線・駅で絞り込み");
    if (!opened) return false; // モーダル開けず → safetyTimerに任せる

    var stNames = (stationNames || []).map(function (s) { return s.replace(/駅$/, "").trim(); }).filter(Boolean);

    setTimeout(function () {
      clickNav("近畿");
      setTimeout(function () {
        clickNav("大阪府");
        setTimeout(function () {

          // 路線を1本ずつ順番にクリック（React再レンダリング対策）
          var lineIdx = 0;
          function clickNextLine() {
            if (lineIdx >= lineNames.length) {
              // 全路線完了 → 駅リスト描画待ち
              setTimeout(function () {
                if (stNames.length) {
                  var stIdx = 0;
                  function clickNextStation() {
                    if (stIdx >= stNames.length) {
                      // 全駅完了 → 確定
                      setTimeout(function () {
                        clickBtn("確定");
                        setTimeout(onDone, 2000); // 確定後2000ms待ってから検索
                      }, 700);
                      return;
                    }
                    clickLabel(stNames[stIdx]);
                    stIdx++;
                    setTimeout(clickNextStation, 700);
                  }
                  clickNextStation();
                } else {
                  // 駅なし → 確定
                  clickBtn("確定");
                  setTimeout(onDone, 2000);
                }
              }, 1500); // 路線チェック後、駅リスト描画を十分待つ
              return;
            }
            clickLabel(lineNames[lineIdx]);
            lineIdx++;
            setTimeout(clickNextLine, 800); // 路線ごとに800ms待機
          }
          clickNextLine();

        }, 1000);
      }, 900);
    }, 1000);
    return true;
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
    // ── 基本条件を入力 ────────────────────────────────────────────────────

    if (cond.rent_max) {
      var rentVal = cond.rent_max > 1000 ? Math.floor(cond.rent_max / 10000) : cond.rent_max;
      var rentEl = document.querySelector('input[name="rent:lteq"]');
      if (rentEl) setReactVal(rentEl, rentVal);
    }
    tick(document.querySelector('input[name="totalRentCheck"]'));
    if (cond.walk_minutes) {
      var walkEl = document.querySelector('input[name="station_walk_minutes:lteq"]');
      if (walkEl) setReactVal(walkEl, cond.walk_minutes);
    }
    if (cond.building_age) {
      var ageEl = document.querySelector('input[name="building_age:lteq"]');
      if (ageEl) setReactVal(ageEl, cond.building_age);
    }
    if (cond.floor_plan) {
      cond.floor_plan.split(/[・,、\/\.\s]+/).forEach(function (plan) {
        plan = plan.trim();
        if (VALID_LAYOUTS.indexOf(plan) !== -1) {
          tick(document.querySelector('input[name="room_layout:in"][id="' + plan + '"]'));
        }
      });
    }
    if (cond.structure_types && cond.structure_types.length) {
      cond.structure_types.forEach(function (s) {
        var v = STRUCTURE_MAP[s];
        if (v) tick(document.querySelector('input[name="structure_type:in"][id="' + v + '"]'));
      });
    }
    if (cond.pet_ok) {
      tick(document.querySelector('input[name="option_id:all_in"][id="22010"]'));
    }
    if (cond.preferences && /バス.*トイレ別|トイレ別|バストイレ別/i.test(cond.preferences)) {
      tick(document.querySelector('input[name="option_id:all_in"][id="11010"]'));
    }

    // ── モーダル操作 + 検索 ───────────────────────────────────────────────
    setTimeout(function () {

      // searchFired フラグで二重発火を防止
      var searchFired = false;
      function doSearch() {
        if (searchFired) return;
        searchFired = true;
        clickBtn("検索");
      }

      var hasArea  = !!cond.ward_name;
      var hasLines = !!(cond.itandi_lines && cond.itandi_lines.length);

      if (hasArea) {
        var opened = selectItandiArea(cond.ward_name, doSearch);
        if (!opened) {
          // モーダル開けなかった → 5秒後に検索（基本条件のみ）
          setTimeout(doSearch, 5000);
        }
        // 安全網: モーダル操作が何らかの理由で完了しなくても15秒後に必ず検索
        setTimeout(doSearch, 15000);

      } else if (hasLines) {
        var stNames = cond.station_names || (cond.station_name ? [cond.station_name] : []);
        var opened = selectItandiLines(cond.itandi_lines, stNames, doSearch);
        if (!opened) {
          // モーダル開けなかった → 5秒後に検索
          setTimeout(doSearch, 5000);
        }
        // 安全網: 15秒後に必ず検索
        setTimeout(doSearch, 15000);

      } else {
        // エリアも路線もない → 2秒後に検索（基本条件のみ）
        setTimeout(doSearch, 2000);
      }

    }, 600);
  }

  window.addEventListener("axlx-itandi-fill", function (e) { fill(e.detail); });
})();
