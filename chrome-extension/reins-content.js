(function () {
  "use strict";

  // 2026-09-27 竹内「全て時間ランダムに」: ページの中の物が読み込まれるのを待つ固定の秒数（元より短くしない）。human-wait.js は manifest で先に読む
  function _sd(ms) { var H = (typeof self !== "undefined" ? self : window).AxlxHumanWait; return H ? H.settleDelay(ms) : ms; }

  var injected = false;

  function injectPageScript() {
    if (injected) return;
    injected = true;
    try {
      // 2026-09-27 待ち時間のばらつき（self.AxlxHumanWait）を先にページへ入れる（async=false で入れた順に動く・読めなくても元の値で動く）
      try {
        var hw = document.createElement("script");
        hw.src = chrome.runtime.getURL("human-wait.js");
        hw.async = false;
        (document.head || document.documentElement).appendChild(hw);
      } catch (_) { /* 予備で動く */ }
      var s = document.createElement("script");
      s.async = false;
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
      }, _sd(200));
    });
  }

  // 2026-09-25 検索の点検: reins-page-script.js の完了の合図に run_id が載っている時（＝ブレインの時）だけ background に中継する。
  //   レインズは完了の合図を待つ仕組みが無い（今まで中継していなかった）ので、点検の記録だけに使う（background も待ちは解かない）
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.from !== "aixlinx-fill-done" || !e.data.runId) return;
    try {
      chrome.runtime.sendMessage({ type: "axlx-fill-done", site: "reins", customerId: null, runId: e.data.runId, audit: e.data.audit || null, pageError: e.data.error || null }, function () { void chrome.runtime.lastError; });
    } catch (err) { /* 拡張の再読み込み等 */ }
  });

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
          }, _sd(600));
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
