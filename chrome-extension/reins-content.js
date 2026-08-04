(function () {
  "use strict";

  var injected = false;

  function injectPageScript() {
    if (injected) return;
    injected = true;
    try {
      var s = document.createElement("script");
      s.src = chrome.runtime.getURL("reins-page-script.js");
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      injected = false;
    }
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg.type !== "axlx-reins-autofill") return;
      try { injectPageScript(); } catch (e) { return; }
      setTimeout(function () {
        window.dispatchEvent(
          new CustomEvent("axlx-reins-fill", { detail: msg.conditions })
        );
      }, 200);
    });
  }

  // URLパラメータ検知：?sumora_cid=<ID> でページを開いたとき自動入力をトリガー
  (function () {
    var _cid = new URLSearchParams(window.location.search).get("sumora_cid");
    if (!_cid) return;

    function _buildConditions(c) {
      return {
        rent_max:            c.rent_max || c.max_rent || null,
        rent_min:            c.rent_min || null,
        walk_minutes:        c.walk_minutes || null,
        building_age:        c.building_age || null,
        floor_plan:          c.floor_plan || c.layout || null,
        is_wide:             false,
        area_min:            c.floor_area_min || c.area_min || c.min_area || null,
        area_max:            c.floor_area_max || c.area_max || c.max_area || null,
        pet_ok:              !!(c.pet),
        ward_name:           c.desired_area || c.area || null,
        ward_names:          [],
        reins_station_pairs: [],
        reins_line:          null,
        station_name:        null,
        reins_reg_date:      null,
      };
    }

    function _run() {
      fetch("https://sumora-ai-ui.vercel.app/api/property-customers", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (list) {
          var c = Array.isArray(list)
            ? list.find(function (x) { return String(x.id) === String(_cid); })
            : null;
          if (!c) {
            console.warn("[reins-content] sumora_cid not found:", _cid);
            return;
          }
          try { injectPageScript(); } catch (e) { return; }
          setTimeout(function () {
            window.dispatchEvent(
              new CustomEvent("axlx-reins-fill", { detail: _buildConditions(c) })
            );
          }, 600);
        })
        .catch(function (e) {
          console.warn("[reins-content] URLパラメータ自動入力エラー:", e);
        });
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", _run);
    } else {
      setTimeout(_run, 300);
    }
  })();
})();
