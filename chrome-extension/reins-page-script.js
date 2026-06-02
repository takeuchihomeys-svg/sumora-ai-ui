(function () {
  "use strict";

  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // Vue対応 value setter（select/inputどちらも対応）
  function setVal(el, val) {
    if (!el) return;
    var proto = el.tagName === "SELECT"
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, String(val));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // インデックスでフォーム要素取得（input[text/number] + select）
  function getField(idx) {
    return document.querySelectorAll(
      'input[type="text"], input[type="number"], select'
    )[idx];
  }

  // selectをテキストで選択（Vueに通知）
  function selectByText(el, text) {
    if (!el || el.tagName !== "SELECT") return false;
    for (var i = 0; i < el.options.length; i++) {
      if (el.options[i].text.trim() === text) {
        setVal(el, el.options[i].value);
        return true;
      }
    }
    return false;
  }

  // チェックボックス（ラベル名で探す）
  function checkByLabel(text) {
    var labels = [].slice.call(document.querySelectorAll("label"));
    var found = labels.find(function (l) {
      return l.textContent.trim() === text;
    });
    if (!found) return false;
    var inp = found.querySelector('input[type="checkbox"]');
    if (!inp && found.htmlFor) inp = document.getElementById(found.htmlFor);
    if (inp && !inp.checked) inp.click();
    return true;
  }

  // 間取タイプ ラベルマッピング（半角→REINS表記の候補リスト・半角/全角両対応）
  var MADORI_LABELS = {
    "1R":   ["ワンルーム"],
    "R":    ["ワンルーム"],
    "K":    ["K", "Ｋ"],
    "1K":   ["K", "Ｋ"],
    "DK":   ["DK", "ＤＫ"],
    "1DK":  ["DK", "ＤＫ"],
    "LK":   ["LK", "ＬＫ"],
    "1LK":  ["LK", "ＬＫ"],
    "LDK":  ["LDK", "ＬＤＫ"],
    "1LDK": ["LDK", "ＬＤＫ"],
    "SK":   ["SK", "ＳＫ"],
    "SDK":  ["SDK", "ＳＤＫ"],
    "SLK":  ["SLK", "ＳＬＫ"],
    "SLDK": ["SLDK", "ＳＬＤＫ"],
  };

  async function fill(cond) {
    // 連続検索対応: 前回の条件をリセット
    var _resetBtn = [].slice.call(document.querySelectorAll("button, input[type='reset']")).find(function(b) {
      var t = (b.textContent || b.value || "").trim();
      var r = b.getBoundingClientRect();
      return ["条件全削除","条件クリア","全クリア","クリア"].indexOf(t) >= 0 && (r.width > 0 || r.height > 0);
    });
    if (_resetBtn) { _resetBtn.click(); console.log("[AX] 条件リセット実行"); await sleep(600); }

    // 遅延レンダリング対策：最上部にスクロールして全フィールドを確実にレンダリング
    window.scrollTo(0, 0);
    await sleep(800);

    // ① 物件種別1 = 賃貸マンション (select index 5)
    // 入力ガイド（ペット相談等）はこの選択が完了していないと動かないため必ずwaitする
    selectByText(getField(5), "賃貸マンション");
    await sleep(600);

    // ② 所在地1（ward_name）または 沿線名1（reins_line）
    if (cond.ward_name) {
      // 所在地モード: 都道府県名(27) + 所在地名1(28)
      setVal(getField(27), "大阪府");
      await sleep(300);
      setVal(getField(28), cond.ward_name);
    } else if (cond.reins_line) {
      // 沿線モード: 駅ごとに正しい沿線を対応させて入力（最大3駅）
      var sensenIdxs = [47, 54, 61];
      if (cond.reins_station_pairs && cond.reins_station_pairs.length) {
        // 新方式: 駅-沿線ペアを使用（各駅に正しい沿線を入力）
        for (var li = 0; li < cond.reins_station_pairs.length && li < 3; li++) {
          var pair = cond.reins_station_pairs[li];
          var baseIdx = sensenIdxs[li];
          setVal(getField(baseIdx), pair.line);
          await sleep(400);
          var stName = (pair.station || "").replace(/駅$/, "").trim();
          if (stName) {
            setVal(getField(baseIdx + 1), stName);   // 駅名FROM
            setVal(getField(baseIdx + 2), stName);   // 駅名TO
          }
        }
      } else {
        // 旧方式フォールバック（reins_station_pairsがない場合）
        var lines = cond.reins_lines && cond.reins_lines.length ? cond.reins_lines : [cond.reins_line];
        var stName = (cond.station_name || "").replace(/駅$/, "").trim();
        for (var li = 0; li < lines.length && li < 3; li++) {
          var baseIdx = sensenIdxs[li];
          setVal(getField(baseIdx), lines[li]);
          await sleep(400);
          if (stName) {
            setVal(getField(baseIdx + 1), stName);
            setVal(getField(baseIdx + 2), stName);
          }
        }
      }
    }

    // ③ 賃料上限 (index 76、万円単位)
    if (cond.rent_max) {
      var rentVal = cond.rent_max > 1000
        ? Math.ceil(cond.rent_max / 10000)
        : cond.rent_max;
      setVal(getField(76), rentVal);
    }

    // ④ 建物使用部分面積 FROM (index 87, TO index 88)
    // 診断結果: [87]建物使用部分面積FROM / [88]建物使用部分面積TO / [89]間取部屋数FROM / [90]間取部屋数TO
    var areaMin = cond.area_min || null;
    if (!areaMin && cond.floor_plan) {
      var areaMatch = cond.floor_plan.match(/(\d+)\s*(?:平米|㎡|m2)/i);
      if (areaMatch) areaMin = parseInt(areaMatch[1]);
    }
    if (areaMin) {
      setVal(getField(87), areaMin); // FROM（左側）のみ入力・TO(88)は空白のまま
      console.log("[AX] 建物使用部分面積 FROM:", areaMin);
    }

    // ⑤ 間取部屋数 FROM/TO (index 89, 90)
    // ※ 平米表記（30平米以上 等）は間取り条件ではないので除外する
    if (cond.floor_plan) {
      var plans = cond.floor_plan.split(/[・,、\/\.\s]+/).filter(function (p) {
        return !/平米|㎡|m2|m²/i.test(p);
      });
      var roomNums = plans.map(function (p) {
        p = p.trim().toUpperCase();
        if (!p) return null;
        var m = p.match(/^(\d+)/);
        if (m) return parseInt(m[1]);
        if (/^(R|K|DK|LK|LDK|SK|SDK|SLK|SLDK|ワンルーム)/.test(p)) return 1;
        return null;
      }).filter(function (n) { return n !== null; });
      if (roomNums.length) {
        setVal(getField(89), Math.min.apply(null, roomNums));
        setVal(getField(90), Math.max.apply(null, roomNums));
      }
    }

    // ⑥ 間取タイプ チェックボックス（平米表記を除外）
    if (cond.floor_plan) {
      cond.floor_plan.split(/[・,、\/\.\s]+/)
        .filter(function (p) { return !/平米|㎡|m2|m²/i.test(p); })
        .forEach(function (p) {
          p = p.trim().toUpperCase();
          var key = p.replace(/^\d+/, "") || p;
          var candidates = MADORI_LABELS[p] || MADORI_LABELS[key];
          if (!candidates) return;
          candidates.some(function (lbl) { return checkByLabel(lbl); });
        });
    }

    // ⑥ 築年月FROM（「築N年以内」→「YYYY年（和暦）」selectを自動選択）
    if (cond.building_age) {
      var fromYear = new Date().getFullYear() - parseInt(cond.building_age);
      var yearStr = String(fromYear) + "年";
      var yearSels = [].slice.call(document.querySelectorAll("select")).filter(function (s) {
        return [].slice.call(s.options).some(function (o) { return o.text.startsWith("2028年"); });
      });
      if (yearSels.length) {
        var opt = [].slice.call(yearSels[0].options).find(function (o) { return o.text.startsWith(yearStr); });
        if (opt) setVal(yearSels[0], opt.value);
      }
    }

    // ⑦ ペット相談（オプション入力ガイドモーダル経由）
    if (cond.pet_ok) {
      // 設備・条件の「入力ガイド」ボタン = textareaの隣にあるもの
      var allGuideBtns = [].slice.call(document.querySelectorAll("button"))
        .filter(function (b) { return b.textContent.trim() === "入力ガイド"; });
      // 最後の入力ガイドボタンが設備・条件欄のもの（診断結果: index 9）
      var optGuideBtn = allGuideBtns[allGuideBtns.length - 1];
      if (optGuideBtn) {
        optGuideBtn.click();
        await sleep(800);
        checkByLabel("ペット相談");
        await sleep(300);
        var ketteBtn = [].slice.call(document.querySelectorAll("button")).find(function (b) {
          return b.textContent.trim() === "決定";
        });
        if (ketteBtn) ketteBtn.click();
        await sleep(500);
      }
    }

    // ⑧ 登録年月日（radio button）- REINSラベルは全角数字のため変換
    if (cond.reins_reg_date) {
      var regDateLabel = cond.reins_reg_date.replace(/1/g, "１").replace(/3/g, "３");
      var regLabels = [].slice.call(document.querySelectorAll("label"));
      var regFound = regLabels.find(function (l) {
        return l.textContent.trim() === regDateLabel;
      });
      if (regFound) {
        var radio = regFound.querySelector('input[type="radio"]');
        if (!radio && regFound.htmlFor) radio = document.getElementById(regFound.htmlFor);
        if (radio && !radio.checked) radio.click();
      }
    }

    // ⑨ 検索ボタン自動クリック
    await sleep(600);
    var searchBtn = [].slice.call(document.querySelectorAll("button")).find(function (b) {
      return b.textContent.trim() === "検索";
    });
    if (searchBtn) searchBtn.click();
  }

  window.addEventListener("axlx-reins-fill", function (e) {
    fill(e.detail);
  });
})();
