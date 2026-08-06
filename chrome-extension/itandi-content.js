(function () {
  "use strict";

  var injected = false;

  function injectPageScript() {
    if (injected) return;
    injected = true;
    try {
      var s = document.createElement("script");
      s.src = chrome.runtime.getURL("itandi-page-script.js");
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      injected = false;
    }
  }

  // ── 物件リストから情報を収集（スクレイプ支援） ───────────────────────────────
  function _scrapeItandiPropertiesFromPage() {
    var results = [];
    var seen = new Set();

    // 「物件資料」ボタンを持つ物件カードを特定（itandi-bulk-dl.js と同じアプローチ）
    var materialBtns = Array.from(document.querySelectorAll("button")).filter(function (btn) {
      return btn.textContent.trim() === "物件資料";
    });

    materialBtns.forEach(function (btn) {
      // 物件URLから物件IDを取得
      var el = btn;
      var propUrl = null;
      var propId = null;
      for (var i = 0; i < 15 && el; i++) {
        var links = Array.from(el.querySelectorAll("a[href]"));
        for (var j = 0; j < links.length; j++) {
          var m = (links[j].getAttribute("href") || "").match(/\/rent_rooms\/(\d+)/);
          if (m) { propId = m[1]; propUrl = links[j].href; break; }
        }
        if (propId) break;
        el = el.parentElement;
      }

      if (!propId || seen.has(propId)) return;
      seen.add(propId);

      // 物件カードのルート要素まで遡る（十分に広い範囲を取得）
      var container = btn;
      for (var i = 0; i < 15 && container.parentElement; i++) {
        container = container.parentElement;
      }

      var text = container.textContent || "";

      // 建物名
      var name = "";
      var nameEl = container.querySelector("h1,h2,h3,h4,h5,[class*='name'],[class*='title'],[class*='building'],[class*='property-name']");
      if (nameEl) name = nameEl.textContent.trim().slice(0, 50);

      // 家賃（万円→円変換）
      var rent = null;
      var manMatch = text.match(/([\d.]+)\s*万円/);
      if (manMatch) rent = Math.round(parseFloat(manMatch[1]) * 10000);

      // 管理費
      var managementFee = null;
      var mgmtMatch = text.match(/管理費\s*([\d,，]+)\s*円/);
      if (mgmtMatch) managementFee = parseInt(mgmtMatch[1].replace(/[,，]/g, ""), 10);
      if (!managementFee) {
        var mgmtManMatch = text.match(/管理費\s*([\d.]+)\s*万円/);
        if (mgmtManMatch) managementFee = Math.round(parseFloat(mgmtManMatch[1]) * 10000);
      }

      // 間取り
      var floorPlan = null;
      var fpMatch = text.match(/\b(ワンルーム|[1-9][RKDL]{1,4}K?)\b/);
      if (fpMatch) floorPlan = fpMatch[1];

      // 面積
      var area = null;
      var areaMatch = text.match(/([\d.]+)\s*(?:m²|㎡|m2)/);
      if (areaMatch) area = parseFloat(areaMatch[1]);

      // 駅情報
      var stationInfo = null;
      var stMatch = text.match(/([^\s]{2,}線)\s+([^\s]+駅)\s+徒歩(\d+)分/);
      if (!stMatch) stMatch = text.match(/([^\s]+線)\s*([^\s]+駅)\s*徒歩(\d+)分/);
      if (stMatch) stationInfo = stMatch[1] + " " + stMatch[2] + " 徒歩" + stMatch[3] + "分";

      results.push({
        building_name: name || ("物件" + propId),
        rent: rent,
        management_fee: managementFee,
        floor_plan: floorPlan,
        area: area,
        station_info: stationInfo,
        url: propUrl || ("https://itandibb.com/rent_rooms/" + propId),
      });
    });

    console.log("[itandi-content] scrape: " + results.length + "件 (物件資料ボタン=" + materialBtns.length + "件)");
    return results;
  }

  // 次ページボタンをクリック（クリックできた場合は true を返す）
  function _clickItandiNextPage() {
    var btns = Array.from(document.querySelectorAll("button,a[href]"));
    var nextBtn = btns.find(function (b) {
      if (b.tagName === "BUTTON" && b.disabled) return false;
      var t = b.textContent.trim();
      return t === "次へ" || t === "次のページ" || t === ">" || t === "›" || t === "→";
    });
    if (!nextBtn) {
      // aria-label で探す
      nextBtn = Array.from(document.querySelectorAll("[aria-label]")).find(function (el) {
        var label = el.getAttribute("aria-label") || "";
        return label.includes("次") || label.toLowerCase().includes("next");
      }) || null;
    }
    if (nextBtn && !nextBtn.disabled) {
      nextBtn.click();
      return true;
    }
    return false;
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      // ── itandi スクレイプ ─────────────────────────────────────────────────
      if (msg.type === "axlx-scrape-itandi") {
        var props = _scrapeItandiPropertiesFromPage();
        sendResponse({ properties: props });
        return true;
      }
      // ── itandi 次ページ ───────────────────────────────────────────────────
      if (msg.type === "axlx-click-next-page-itandi") {
        var clicked = _clickItandiNextPage();
        sendResponse({ clicked: clicked });
        return true;
      }
      // ── autofill ─────────────────────────────────────────────────────────
      if (msg.type !== "axlx-itandi-autofill") return;
      try { injectPageScript(); } catch (e) { sendResponse({ ok: false }); return true; }
      setTimeout(function () {
        window.dispatchEvent(new CustomEvent("axlx-itandi-fill", { detail: msg.conditions }));
      }, 200);
      // sendResponse を返すことで background.js が「送信成功」と判定できるようにする
      sendResponse({ ok: true });
      return true;
    });
  }

  // 修正4: itandi-page-script.js の検索実行完了シグナルを background.js へ中継する
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.from !== "aixlinx-fill-done") return;
    try {
      chrome.runtime.sendMessage({ type: "axlx-fill-done", site: "itandi" }, function () {
        void chrome.runtime.lastError; // background が待機していない場合は無視
      });
    } catch (err) {
      // 拡張リロード等で context が失われた場合は無視
    }
  });

  // underbar.js経由のpostMessageも受け取る（iframe内でchrome.tabsが使えないため）
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.from !== "aixlinx-itandi-fill") return;
    try { injectPageScript(); } catch (e2) { return; }
    setTimeout(function () {
      window.dispatchEvent(new CustomEvent("axlx-itandi-fill", { detail: e.data.conditions }));
    }, 200);
  });

  // URLパラメータ検知：?sumora_cid=<ID> でページを開いたとき自動入力をトリガー
  (function () {
    var _cid = new URLSearchParams(window.location.search).get("sumora_cid");
    if (!_cid) return;

    function _buildConditions(c) {
      return {
        rent_max:       c.rent_max || c.max_rent || null,
        rent_min:       c.rent_min || null,
        walk_minutes:   c.walk_minutes || null,
        building_age:   c.building_age || null,
        floor_plan:     c.floor_plan || c.layout || null,
        is_wide:        false,
        area_min:       c.floor_area_min || c.area_min || c.min_area || null,
        area_max:       c.floor_area_max || c.area_max || c.max_area || null,
        structure_types: (c.building_structure || c.structure || "")
          .split(/[,、・\/\.\s]+/).map(function (s) { return s.trim(); }).filter(Boolean),
        pet_ok:         !!(c.pet),
        preferences:    c.preferences || c.notes || null,
        ward_name:      c.desired_area || c.area || null,
        ward_names:     null,
        ward_town_map:  null,
        town_area:      null,
        itandi_lines:   [],
        station_names:  [],
        unknown_tokens: null,
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
            console.warn("[itandi-content] sumora_cid not found:", _cid);
            return;
          }
          try { injectPageScript(); } catch (e) { return; }
          setTimeout(function () {
            window.dispatchEvent(
              new CustomEvent("axlx-itandi-fill", { detail: _buildConditions(c) })
            );
          }, 600);
        })
        .catch(function (e) {
          console.warn("[itandi-content] URLパラメータ自動入力エラー:", e);
        });
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", _run);
    } else {
      setTimeout(_run, 300);
    }
  })();
})();
