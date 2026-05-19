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

  // ナビタブ（li/button/a/span/label）完全一致
  // itandiの地域・都道府県タブはLABELタグ（診断で確認済み）
  function clickNav(text) {
    var n = norm(text);
    var els = [].slice.call(document.querySelectorAll("li, button, a, span, label, div[role='button']"));
    var found = els.find(function (el) {
      return norm(el.textContent) === n && isVis(el);
    });
    if (found) { found.click(); return true; }
    return false;
  }

  // ── 所在地モーダル ───────────────────────────────────────────────────────
  // 戻り値: boolean（モーダルを開けたか）
  function selectItandiArea(wardName, onDone) {
    if (!wardName) return false;
    var opened = clickBtn("所在地で絞り込み") || clickBtn("エリアで絞り込み") || clickBtn("地域で絞り込み");
    if (!opened) return false;

    // 区名短縮版を用意（「大阪市福島区」→「福島区」、「大阪市北区」→「北区」）
    var shortName = wardName.replace(/^.+?([^\s　市区郡]+[区町村])$/, "$1");
    if (shortName === wardName) shortName = null; // 変換できなければnull

    setTimeout(function () {
      // 地方タブがあれば近畿を選択（ない場合は無視して進む）
      clickNav("近畿");
      setTimeout(function () {
        // 都道府県タブを選択
        clickNav("大阪府") || clickNav("大阪");
        setTimeout(function () {
          // フル名で試し、失敗したら区名のみで試みる
          if (!clickLabel(wardName) && shortName) {
            clickLabel(shortName);
          }
          setTimeout(function () {
            clickBtn("確定");
            setTimeout(onDone, 1500);
          }, 1000);
        }, 1000);
      }, 800);
    }, 1000);
    return true;
  }

  // ── 路線・駅モーダル ─────────────────────────────────────────────────────
  // 戻り値: boolean（モーダルを開けたか）
  function selectItandiLines(lineNames, stationNames, onDone) {
    if (!lineNames || !lineNames.length) return false;
    var opened = clickBtn("路線・駅で絞り込み") || clickBtn("路線で絞り込み") || clickBtn("沿線・駅で絞り込み");
    if (!opened) return false;

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
                        setTimeout(onDone, 1500);
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
                  setTimeout(onDone, 1500);
                }
              }, 1500);
              return;
            }
            clickLabel(lineNames[lineIdx]);
            lineIdx++;
            setTimeout(clickNextLine, 800);
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

  // モーダル完了後に入力する条件（専有面積・築年数・間取り・構造・ペット・駅徒歩）
  function fillRemainingFields(cond) {
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
      // CSSセレクターとlabelクリックの両方を試みる
      var petEl = document.querySelector('input[name="option_id:all_in"][id="22010"]');
      if (petEl) tick(petEl); else clickLabel("ペット相談");
    }
    if (cond.preferences && /バス.*トイレ別|トイレ別|バストイレ別/i.test(cond.preferences)) {
      var bathEl = document.querySelector('input[name="option_id:all_in"][id="11010"]');
      if (bathEl) tick(bathEl); else clickLabel("バス・トイレ別");
    }
  }

  function fill(cond) {
    // ── STEP 1: 賃料（最初に入力）────────────────────────────────────────
    if (cond.rent_max) {
      var rentVal = cond.rent_max > 1000 ? Math.floor(cond.rent_max / 10000) : cond.rent_max;
      var rentEl = document.querySelector('input[name="rent:lteq"]');
      if (rentEl) setReactVal(rentEl, rentVal);
    }
    tick(document.querySelector('input[name="totalRentCheck"]'));

    // ── STEP 2 & 3: 所在地 or 路線・駅モーダル → 完了後に残り条件 → 検索 ──
    var hasArea  = !!cond.ward_name;
    var hasLines = !!(cond.itandi_lines && cond.itandi_lines.length);

    setTimeout(function () {

      // モーダル完了コールバック
      function afterModal() {
        // STEP 4〜8: 専有面積・築年数・間取り・構造・ペット
        setTimeout(function () {
          fillRemainingFields(cond);
          // STEP 9: 検索
          setTimeout(function () {
            clickBtn("検索");
          }, 1000);
        }, 500);
      }

      if (hasArea) {
        var opened = selectItandiArea(cond.ward_name, afterModal);
        if (!opened) {
          // モーダルが開けなかった → 検索せずに通知（500エラー防止）
          alert("「所在地で絞り込み」ボタンが見つかりませんでした。\n手動で所在地を選択してから検索してください。");
        }

      } else if (hasLines) {
        var stNames = cond.station_names || (cond.station_name ? [cond.station_name] : []);
        var opened = selectItandiLines(cond.itandi_lines, stNames, afterModal);
        if (!opened) {
          // モーダルが開けなかった → 検索せずに通知（500エラー防止）
          alert("「路線・駅で絞り込み」ボタンが見つかりませんでした。\n手動で路線を選択してから検索してください。");
        }

      } else {
        // 所在地も路線もない → 検索せずに通知（500エラー防止・必須条件未設定）
        alert("所在地または路線・駅の情報がありません。\nお客さんのエリア条件を確認してください。");
      }

    }, 800);
  }

  window.addEventListener("axlx-itandi-fill", function (e) { fill(e.detail); });
})();
