"use strict";
// score-overlay.js v1.0.0
// 物件検索結果にお客さん条件マッチ度スコアを表示するコンテンツスクリプト
// リアプロ / itandi BB / REINS の3サイト対応
// chrome.storage.session 経由で条件を受け取り、物件カードにバッジを注入する

(function () {
  const BADGE_CLASS = "axlx-score-badge";
  const BAR_ID      = "axlx-score-bar";

  let storedConditions = null;
  let scoreTimer       = null;
  let observing        = false;

  // ── HTML エスケープ ─────────────────────────────────────────────
  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  // ── サイト判定 ────────────────────────────────────────────────
  function getSite() {
    var h = location.hostname;
    if (h.includes("realnetpro")) return "realpro";
    if (h.includes("itandibb"))   return "itandi";
    if (h.includes("reins.jp"))   return "reins";
    return null;
  }

  // ── 物件カード要素を探す（サイト別） ─────────────────────────
  function findPropertyContainers() {
    var site = getSite();

    // ── リアプロ: "印刷用PDF" テキストから親カードを探す ────────
    if (site === "realpro") {
      var cards = new Set();
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.includes("印刷用PDF")) continue;
        var el = node.parentElement;
        for (var i = 0; i < 12 && el && el !== document.body; i++, el = el.parentElement) {
          // 十分な高さ・幅を持つコンテナを物件カードとみなす
          if (el.offsetHeight > 120 && el.offsetWidth > 200) {
            cards.add(el);
            break;
          }
        }
      }
      return Array.from(cards);
    }

    // ── itandi BB: "物件資料" ボタンから /properties/ID を含む親行を探す ─
    if (site === "itandi") {
      var cards = new Set();
      Array.from(document.querySelectorAll("button")).forEach(function (btn) {
        if (btn.textContent.trim() !== "物件資料") return;
        var el = btn.parentElement;
        for (var i = 0; i < 14 && el && el !== document.body; i++, el = el.parentElement) {
          var links = el.querySelectorAll("a[href]");
          for (var j = 0; j < links.length; j++) {
            if (/\/properties\/\w+/.test(links[j].getAttribute("href") || "")) {
              cards.add(el);
              return;
            }
          }
        }
      });
      // フォールバック: 家賃っぽいテキストを持つ大きめのカード系要素
      if (cards.size === 0) {
        var fallbacks = document.querySelectorAll(
          "[class*='property-card'],[class*='PropertyCard'],[class*='bukken'],[class*='room-list-item'],[class*='list-item']"
        );
        Array.from(fallbacks).forEach(function (el) {
          if (el.offsetHeight > 60 && el.offsetWidth > 200) cards.add(el);
        });
      }
      return Array.from(cards);
    }

    // ── REINS: .p-table-body-row（reins-bulk-dl.jsと同じ探索ロジック） ─
    if (site === "reins") {
      var rows = Array.from(document.querySelectorAll(".p-table-body-row"));
      if (rows.length === 0) {
        rows = Array.from(document.querySelectorAll(
          "[class*='table-body-row'],[class*='datatable-row'],[class*='p-row-odd'],[class*='p-row-even']"
        ));
      }
      if (rows.length === 0) {
        rows = Array.from(document.querySelectorAll("[data-p-index]")).filter(function (el) {
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      }
      if (rows.length === 0) {
        rows = Array.from(document.querySelectorAll("[aria-rowindex]")).filter(function (el) {
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      }
      return rows;
    }

    return [];
  }

  // ── スコア計算（テキストパース・API不要・ゼロコスト） ────────
  function scoreFromText(text, c) {
    var score = 0;
    var t = text.replace(/\s+/g, " ");

    // ── 家賃チェック (30点) ──────────────────────────────────
    if (c.rent_max) {
      var m = t.match(/([0-9]+(?:\.[0-9]+)?)\s*万/);
      if (m) {
        var rent = parseFloat(m[1]) * 10000;
        if (rent <= c.rent_max) score += 30;
        else if (rent <= c.rent_max * 1.08) score += 15; // 8%以内オーバーは半点
      } else {
        score += 15; // 家賃情報なし → 中間点
      }
    } else {
      score += 30; // 条件なし → 満点
    }

    // ── 駅徒歩チェック (25点) ─────────────────────────────────
    if (c.walk_minutes) {
      var m2 = t.match(/徒歩\s*([0-9]+)\s*分/);
      if (m2) {
        var walk = parseInt(m2[1]);
        if (walk <= c.walk_minutes) score += 25;
        else if (walk <= c.walk_minutes + 3) score += 12; // 3分以内オーバーは半点
      } else {
        score += 12; // 徒歩情報なし → 中間点
      }
    } else {
      score += 25;
    }

    // ── 間取りチェック (20点) ─────────────────────────────────
    if (c.floor_plan) {
      if (t.includes(c.floor_plan)) {
        score += 20;
      } else {
        // 部屋数だけ合えば半点（「2LDK+S」vs「2LDK」など）
        var fpNum = (c.floor_plan.match(/^([0-9]+)/) || [])[1];
        var tFpMatch = t.match(/([0-9]+)[LDKS]+/i);
        if (fpNum && tFpMatch && fpNum === tFpMatch[1]) score += 10;
        else score += 5;
      }
    } else {
      score += 20;
    }

    // ── 築年数チェック (15点) ─────────────────────────────────
    if (c.building_age) {
      if (t.includes("新築")) {
        score += 15;
      } else {
        var m3 = t.match(/築([0-9]+)年/);
        if (m3) {
          var age = parseInt(m3[1]);
          if (age <= c.building_age) score += 15;
          else if (age <= c.building_age + 5) score += 7;
        } else {
          score += 8; // 築年数情報なし → 中間点
        }
      }
    } else {
      score += 15;
    }

    // ── 広さチェック (10点) ───────────────────────────────────
    if (c.area_min) {
      var m4 = t.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|m²|平米)/);
      if (m4) {
        var area = parseFloat(m4[1]);
        if (area >= c.area_min) score += 10;
        else if (area >= c.area_min * 0.9) score += 5;
      } else {
        score += 5; // 広さ情報なし → 中間点
      }
    } else {
      score += 10;
    }

    return Math.min(100, score);
  }

  // ── スコアに対応する色とラベル ───────────────────────────────
  function scoreStyle(s) {
    if (s >= 85) return { bg: "#2e7d32", label: "◎" }; // 緑: 85点以上
    if (s >= 70) return { bg: "#1565c0", label: "○" }; // 青: 70点以上
    if (s >= 55) return { bg: "#e65100", label: "△" }; // 橙: 55点以上
    return       { bg: "#b71c1c", label: "×" };         // 赤: 55点未満
  }

  // ── バッジを物件カードに注入 ─────────────────────────────────
  function injectBadge(el, score) {
    // 既存バッジを削除（重複防止）
    el.querySelectorAll("." + BADGE_CLASS).forEach(function (b) { b.remove(); });

    var st = scoreStyle(score);
    var badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.style.cssText = [
      "background:" + st.bg + ";color:#fff;",
      "font-size:12px;font-weight:700;",
      "padding:2px 10px;border-radius:10px;",
      "display:inline-block;margin:3px 4px 3px 0;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
      "box-shadow:0 1px 4px rgba(0,0,0,0.25);",
      "white-space:nowrap;vertical-align:middle;",
      "position:relative;z-index:10;flex-shrink:0;",
    ].join("");
    badge.textContent = st.label + " " + score + "点";
    badge.title = "条件マッチ度: " + score + "/100点\n(家賃30 + 徒歩25 + 間取20 + 築年15 + 広さ10)";

    if (el.firstChild) {
      el.insertBefore(badge, el.firstChild);
    } else {
      el.appendChild(badge);
    }
  }

  // ── 全物件カードにスコアを一括適用 ──────────────────────────
  function runScoring() {
    if (!storedConditions) return;
    var cards = findPropertyContainers();
    if (cards.length === 0) return;

    var scored = 0;
    cards.forEach(function (card) {
      var text = (card.innerText || "").trim();
      if (text.length < 20) return;
      var score = scoreFromText(text, storedConditions);
      injectBadge(card, score);
      scored++;
    });

    if (scored > 0) {
      console.log("[AX-SCORE] " + scored + "件にスコアを表示");
    }
  }

  // ── 条件バー（ページ上部固定・お客さん名+条件一覧を表示） ───
  function showConditionBar() {
    if (!storedConditions) return;
    var c = storedConditions;

    var existing = document.getElementById(BAR_ID);
    if (existing) existing.remove();

    var conds = [];
    if (c.rent_max)     conds.push("家賃〜" + Math.floor(c.rent_max / 10000) + "万");
    if (c.walk_minutes) conds.push("徒歩" + c.walk_minutes + "分");
    if (c.floor_plan)   conds.push(c.floor_plan);
    if (c.building_age) conds.push("築" + c.building_age + "年");
    if (c.area_min)     conds.push(c.area_min + "㎡〜");

    var bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.style.cssText = [
      "position:fixed;top:0;left:50%;transform:translateX(-50%);",
      "z-index:2147483640;",
      "background:rgba(13,27,62,0.94);color:#fff;",
      "padding:5px 14px;border-radius:0 0 10px 10px;",
      "font-size:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
      "display:flex;align-items:center;gap:8px;flex-wrap:nowrap;",
      "box-shadow:0 2px 10px rgba(0,0,0,0.4);",
      "max-width:800px;",
    ].join("");

    bar.innerHTML =
      "<span style='font-weight:700;color:#64b5f6;flex-shrink:0;'>&#128100; " + esc(c.customer_name || "") + ":</span>" +
      "<span style='color:#e0e0e0;'>" + conds.map(esc).join("&nbsp;/&nbsp;") + "</span>" +
      "<span style='margin-left:6px;display:flex;gap:3px;flex-shrink:0;'>" +
        "<span style='background:#2e7d32;color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;'>&#9675;85+</span>" +
        "<span style='background:#1565c0;color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;'>&#9675;70+</span>" +
        "<span style='background:#e65100;color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;'>&#9651;55+</span>" +
        "<span style='background:#b71c1c;color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;'>&#215;-54</span>" +
      "</span>" +
      "<button id='axlx-score-close' style='margin-left:8px;background:none;border:none;color:#aaa;cursor:pointer;font-size:15px;padding:0 3px;line-height:1;flex-shrink:0;' title='閉じる'>&#10005;</button>";

    document.body.appendChild(bar);

    document.getElementById("axlx-score-close").addEventListener("click", function () {
      bar.remove();
    });
  }

  // ── chrome.storage.session から条件を読み込んでスコア実行 ───
  function loadAndScore() {
    try {
      chrome.storage.session.get("axlx_score_data", function (data) {
        if (!data || !data.axlx_score_data) return;
        storedConditions = data.axlx_score_data;
        showConditionBar();
        runScoring();
        startObserver();
      });
    } catch (e) {
      // ストレージ未対応環境は無視
    }
  }

  // ── MutationObserver: 検索結果が更新されたら自動でスコア再表示 ─
  function startObserver() {
    if (observing || !document.body) return;
    observing = true;
    var obs = new MutationObserver(function () {
      if (!storedConditions) return;
      if (scoreTimer) clearTimeout(scoreTimer);
      scoreTimer = setTimeout(runScoring, 900);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── chrome.storage.onChanged: 顧客切り替え時に即反映 ────────
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "session" || !changes.axlx_score_data) return;
    storedConditions = changes.axlx_score_data.newValue;
    if (!storedConditions) return;
    showConditionBar();
    setTimeout(runScoring, 500);
    startObserver();
  });

  // ── chrome.runtime.onMessage: popup.js からの直接トリガー ───
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type !== "axlx-score-results") return;
    if (!msg.conditions) return;
    storedConditions = msg.conditions;
    try {
      chrome.storage.session.set({ axlx_score_data: storedConditions });
    } catch (e) { /* ignore */ }
    showConditionBar();
    setTimeout(runScoring, 300);
    startObserver();
  });

  // ── 初期化 ───────────────────────────────────────────────────
  function init() {
    startObserver(); // 先にObserverを起動（ページロード中に条件が揃う前に結果が来る場合に備える）
    loadAndScore();  // ストレージから条件を非同期で読み込んでスコア実行
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
