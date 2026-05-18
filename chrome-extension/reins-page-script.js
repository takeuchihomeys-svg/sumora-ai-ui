(function () {
  "use strict";

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

  // 間取タイプ チェックボックス（ラベル名で探す・半角/全角両対応）
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

  // 間取タイプ ラベルマッピング（半角→REINS表記の候補リスト）
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

  function fill(cond) {
    // ① 物件種別1 = 賃貸マンション (select index 5)
    selectByText(getField(5), "賃貸マンション");

    // ② 沿線名1 (index 47) + 駅名FROM/TO (48/49)
    if (cond.reins_line) {
      setVal(getField(47), cond.reins_line);
      var stName = (cond.station_name || "").replace(/駅$/, "").trim();
      if (stName) {
        setVal(getField(48), stName);
        setVal(getField(49), stName);
      }
    }

    // ③ 駅から徒歩 (index 50)
    if (cond.walk_minutes) {
      setVal(getField(50), cond.walk_minutes);
    }

    // ④ 賃料上限 (index 76、万円単位)
    if (cond.rent_max) {
      var rentVal = cond.rent_max > 1000
        ? Math.ceil(cond.rent_max / 10000)
        : cond.rent_max;
      setVal(getField(76), rentVal);
    }

    // ⑤ 間取タイプ チェックボックス
    if (cond.floor_plan) {
      cond.floor_plan.split(/[・,、\/\.\s]+/).forEach(function (p) {
        p = p.trim().toUpperCase();
        // "2LDK" → "LDK" のように数字プレフィックスを除いたキーも試す
        var key = p.replace(/^\d+/, "") || p;
        var candidates = MADORI_LABELS[p] || MADORI_LABELS[key];
        if (!candidates) return;
        candidates.some(function (lbl) { return checkByLabel(lbl); });
      });
    }

    // ⑥ 検索ボタン自動クリック
    setTimeout(function () {
      var btn = [].slice.call(document.querySelectorAll("button")).find(function (b) {
        return b.textContent.trim() === "検索";
      });
      if (btn) btn.click();
    }, 600);
  }

  window.addEventListener("axlx-reins-fill", function (e) {
    fill(e.detail);
  });
})();
