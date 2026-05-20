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
  // itandi診断済みDOM: LABEL.itandi-bb-ui__InputRadio + input[type=radio]
  //   近畿: name=regionName / 大阪府: name=prefectureId / 区市: name=''
  // 戻り値: boolean（モーダルを開けたか）
  function selectItandiArea(wardName, townArea, onDone) {
    if (!wardName) return false;
    var opened = clickBtn("所在地で絞り込み") || clickBtn("エリアで絞り込み") || clickBtn("地域で絞り込み");
    if (!opened) return false;

    // 区名短縮版を用意（「大阪市福島区」→「福島区」）
    var shortName = wardName.replace(/^.+?([^\s　市区郡]+[区町村])$/, "$1");
    if (shortName === wardName) shortName = null;

    // itandiラジオボタン専用クリック: already checked なら触らない
    function clickItandiRadio(text) {
      var n = norm(text);
      var labels = [].slice.call(document.querySelectorAll("label"));
      var found = null;
      for (var i = 0; i < labels.length; i++) {
        if (norm(labels[i].textContent) === n && isVis(labels[i])) { found = labels[i]; break; }
      }
      if (!found) {
        for (var i = 0; i < labels.length; i++) {
          if (norm(labels[i].textContent).includes(n) && isVis(labels[i])) { found = labels[i]; break; }
        }
      }
      if (!found) return false;
      var inp = found.querySelector("input[type='radio']");
      if (inp && inp.checked) return true; // already checked → skip
      found.click(); // label.click()が正解（MUI hidden inputにinp.click()は効かない）
      return true;
    }

    // モーダル描画待ち: 2000ms（1000msでは描画未完了の場合あり）
    setTimeout(function () {
      // 近畿: already checked なら skip（触ると大阪府リストが消える恐れ）
      var regionInp = document.querySelector("input[type='radio'][name='regionName']");
      if (!regionInp || !regionInp.checked) {
        clickItandiRadio("近畿");
      }
      setTimeout(function () {
        // 大阪府: already checked なら skip
        var prefInp = document.querySelector("input[type='radio'][name='prefectureId']");
        if (!prefInp || !prefInp.checked) {
          clickItandiRadio("大阪府") || clickItandiRadio("大阪");
        }
        setTimeout(function () {
          // 区市ラベルをクリック（name='' のラジオ）
          var clicked = clickItandiRadio(wardName) || (shortName ? clickItandiRadio(shortName) : false);
          if (!clicked) {
            // 未発見 → さらに1000ms待ってリトライ
            console.log("[AX] selectItandiArea: ward not found, retry 1000ms");
            setTimeout(function () {
              clickItandiRadio(wardName) || (shortName ? clickItandiRadio(shortName) : false);
              setTimeout(selectTownThenConfirm, 500);
            }, 1000);
          } else {
            setTimeout(selectTownThenConfirm, 500);
          }

          // 町域・丁目選択 → 確定
          function selectTownThenConfirm() {
            if (townArea) {
              var townLabels = [].slice.call(document.querySelectorAll("label")).filter(function(l) {
                return l.textContent.includes(townArea) && l.getBoundingClientRect().height > 0;
              });
              townLabels.forEach(function(l) {
                var inp = l.querySelector("input");
                if (!inp || !inp.checked) l.click();
              });
              console.log("[AX] 町域選択: " + townArea + " " + townLabels.length + "件");
            }
            setTimeout(function() { clickBtn("確定"); setTimeout(onDone, 1500); }, 800);
          }
        }, 1000);
      }, 800);
    }, 2000);
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
    "ブロック": "block",
    "鉄筋ブロック": "reinforcing_block",
    "PC": "pc", "PC造": "pc",
    "HPC": "hpc", "HPC造": "hpc",
    "ALC": "alc", "ALC造": "alc",
    "CFT": "cft", "CFT造": "cft",
  };

  var VALID_LAYOUTS = ["1R","1K","1DK","1LDK","2K","2DK","2LDK","3K","3DK","3LDK","4K","4DK","4LDK","5K_OVER"];

  // モーダル完了後に入力する条件（専有面積・築年数・間取り・構造・ペット・駅徒歩）
  function fillRemainingFields(cond) {
    // 専有面積（フィールド名はfloor_area_amount:gteq / lteq）
    if (cond.area_min) {
      var areaMinEl = document.querySelector('input[name="floor_area_amount:gteq"]');
      if (areaMinEl) setReactVal(areaMinEl, cond.area_min);
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
      var fpStr = cond.floor_plan.trim();
      var ijouMatch = fpStr.match(/^(.+?)以上$/);
      if (ijouMatch) {
        var baseKey = FLOOR_TEXT_IT[ijouMatch[1].trim()] || ijouMatch[1].trim();
        var baseIdx = FLOOR_RANK_IT.indexOf(baseKey);
        if (baseIdx >= 0) {
          for (var ri = baseIdx; ri < FLOOR_RANK_IT.length; ri++) {
            tick(document.querySelector('input[name="room_layout:in"][id="' + FLOOR_RANK_IT[ri] + '"]'));
          }
        }
      } else {
        fpStr.split(/[・,、\/\.\s]+/).forEach(function (plan) {
          plan = plan.trim();
          var id = FLOOR_TEXT_IT[plan] || plan;
          if (VALID_LAYOUTS.indexOf(id) !== -1) {
            tick(document.querySelector('input[name="room_layout:in"][id="' + id + '"]'));
          }
        });
      }
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
        var opened = selectItandiArea(cond.ward_name, cond.town_area || null, afterModal);
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
