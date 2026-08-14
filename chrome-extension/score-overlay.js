"use strict";
// score-overlay.js v1.0.0
// 物件検索結果にお客さん条件マッチ度スコアを表示するコンテンツスクリプト
// リアプロ / itandi BB / REINS の3サイト対応
// chrome.storage.session 経由で条件を受け取り、物件カードにバッジを注入する

(function () {
  const BADGE_CLASS = "axlx-score-badge";
  const BAR_ID      = "axlx-score-bar";

  let storedConditions   = null;
  let scoreTimer         = null;
  let observing          = false;
  let sentPropertiesList = null;  // null=未取得, Array=取得済み
  let sentFetching       = false; // 重複フェッチ防止フラグ
  let evalCache          = {};    // AI評価キャッシュ（キー: 顧客ID|物件名|号室|家賃 → 結果 or Promise）
                                  // MutationObserver 再実行での重複APIコールを防ぐ。顧客切替時にリセット

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

  // ── 送済みバッジを物件カードに注入 ──────────────────────────
  var DUP_BADGE_CLASS = "axlx-dup-badge";

  function injectDupBadge(el, sentAt) {
    el.querySelectorAll("." + DUP_BADGE_CLASS).forEach(function (b) { b.remove(); });

    var d   = new Date(sentAt);
    var lbl = (d.getMonth() + 1) + "月" + d.getDate() + "日";

    var badge = document.createElement("span");
    badge.className = DUP_BADGE_CLASS;
    badge.style.cssText = [
      "background:#c62828;color:#fff;",
      "font-size:11px;font-weight:700;",
      "padding:2px 8px;border-radius:10px;",
      "display:inline-block;margin:3px 4px 3px 0;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
      "box-shadow:0 1px 4px rgba(0,0,0,0.3);",
      "white-space:nowrap;vertical-align:middle;",
      "position:relative;z-index:11;flex-shrink:0;",
    ].join("");
    badge.textContent = "送済み " + lbl;
    badge.title       = "この物件は " + lbl + " に送信済みです";

    // スコアバッジの直後に挿入（なければ先頭）
    var scoreBadge = el.querySelector("." + BADGE_CLASS);
    if (scoreBadge && scoreBadge.nextSibling) {
      el.insertBefore(badge, scoreBadge.nextSibling);
    } else if (scoreBadge) {
      el.appendChild(badge);
    } else if (el.firstChild) {
      el.insertBefore(badge, el.firstChild);
    } else {
      el.appendChild(badge);
    }
  }

  // ── 号室番号をカードテキストから抽出 ──────────────────────
  function extractRoomNo(text) {
    // "101号室", "B202号室", "1-201号室" など
    var m = text.match(/([A-Za-z0-9\-]{1,6})\s*号室/);
    if (m) return m[1] + "号室";
    // 4桁数字 (e.g. "0101") — REINS 等で号室表記なしの場合
    var m2 = text.match(/\b(0[1-9]\d{2}|\d{3,4})\b/);
    return m2 ? m2[1] : null;
  }

  // ── 送済みリストをAPIから1回だけ取得 ─────────────────────
  function fetchSentProperties(propertyCustomerId) {
    if (sentFetching || !propertyCustomerId) return;
    sentFetching       = true;
    sentPropertiesList = null;

    var url = "https://sumora-ai-ui.vercel.app/api/check-property-duplicate" +
              "?property_customer_id=" + encodeURIComponent(String(propertyCustomerId));
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        sentPropertiesList = Array.isArray(data.list) ? data.list : [];
        sentFetching       = false;
        if (sentPropertiesList.length > 0) runDupCheck();
      })
      .catch(function () {
        sentPropertiesList = [];
        sentFetching       = false;
      });
  }

  // ── 検索フォームにお客さんの条件を自動入力（リアプロ・itandi・REINS対応） ─
  function autoFillSearchForm(conditions) {
    if (!conditions) return;
    var site = getSite();
    if (!site) return;

    var filled = false;

    // 家賃上限
    if (conditions.rent_max) {
      var rentInput = document.querySelector(
        'input[name*="rent_max"], input[name*="賃料上限"], input[placeholder*="賃料上限"], input[id*="rent_max"]'
      );
      if (rentInput) {
        rentInput.value = Math.floor(conditions.rent_max / 1000).toString();
        rentInput.dispatchEvent(new Event("change", { bubbles: true }));
        filled = true;
      }
    }
    // エリア（テキスト入力）
    if (conditions.area) {
      var areaInput = document.querySelector(
        'input[name*="area"], input[name*="エリア"], input[placeholder*="エリア"]'
      );
      if (areaInput) {
        areaInput.value = conditions.area;
        areaInput.dispatchEvent(new Event("input", { bubbles: true }));
        filled = true;
      }
    }
    // 駅徒歩（条件以下で最大の選択肢を選ぶ）
    if (conditions.walk_minutes) {
      var walkSelect = document.querySelector('select[name*="walk"], select[name*="徒歩"]');
      if (walkSelect) {
        var opts = Array.from(walkSelect.options).filter(function (o) {
          var v = parseInt(o.value, 10);
          return !isNaN(v) && v <= conditions.walk_minutes;
        });
        var best = opts.length > 0 ? opts[opts.length - 1] : null;
        if (best) {
          walkSelect.value = best.value;
          walkSelect.dispatchEvent(new Event("change", { bubbles: true }));
          filled = true;
        }
      }
    }

    if (filled) {
      console.log("[score-overlay] 検索条件を自動入力しました:", conditions);
    }
  }

  // ── 物件をAIスコアで評価する（evaluate-property API呼び出し） ───────
  async function evaluateProperty(propertyCustomerId, propertyInfo) {
    try {
      var res = await fetch("https://sumora-ai-ui.vercel.app/api/evaluate-property", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_customer_id: propertyCustomerId, property: propertyInfo }),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // ── カードテキストから evaluate-property 用の物件情報を抽出 ──────────
  function extractPropertyInfo(card) {
    var text = (card.innerText || "").trim();
    var t = text.replace(/\s+/g, " ");

    // 物件名: カードテキストの先頭行（自前バッジの文言は除外）
    var lines = text.split("\n").map(function (s) { return s.trim(); }).filter(function (s) {
      return s &&
        !/^[◎○△×]\s*[0-9]+点/.test(s) &&  // スコアバッジ
        !/^送済み/.test(s) &&               // 送済みバッジ
        !/^★/.test(s);                     // AI評価バッジ
    });
    var cardName = (lines[0] || "").slice(0, 60);

    var cardRoomNo = extractRoomNo(text) || "";

    var mRent = t.match(/([0-9]+(?:\.[0-9]+)?)\s*万/);
    var cardRent = mRent ? Math.round(parseFloat(mRent[1]) * 10000) : null;

    var mFp = t.match(/([0-9]+\s*(?:SLDK|SDK|LDK|DK|K|R))(?![A-Za-z])/i) || t.match(/(ワンルーム)/);
    var cardFloorPlan = mFp ? mFp[1].replace(/\s/g, "") : null;

    var mWalk = t.match(/徒歩\s*([0-9]+)\s*分/);
    var cardWalkMins = mWalk ? parseInt(mWalk[1], 10) : null;

    var mAreaSqm = t.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|m²|平米)/);
    var cardAreaSqm = mAreaSqm ? parseFloat(mAreaSqm[1]) : null;

    // AD（広告料）: "AD1ヶ月" / "AD100%" 等
    var cardAdMonths = null;
    var mAd = t.match(/AD\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:ヶ月|ヵ月|カ月|か月|ケ月)/i);
    var mAdPct = t.match(/AD\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)\s*[%％]/i);
    if (mAd) cardAdMonths = parseFloat(mAd[1]);
    else if (mAdPct) cardAdMonths = parseFloat(mAdPct[1]) / 100;

    return {
      name: cardName,
      room_no: cardRoomNo,
      rent: cardRent,
      floor_plan: cardFloorPlan,
      walk_minutes: cardWalkMins,
      area_sqm: cardAreaSqm,
      ad_months: cardAdMonths,
    };
  }

  // ── AI評価バッジを物件カードに注入 ──────────────────────────
  var EVAL_BADGE_CLASS = "sumora-score-badge";

  function injectEvalBadge(card, result) {
    var existingBadge = card.querySelector("." + EVAL_BADGE_CLASS);
    if (existingBadge) existingBadge.remove();

    var badge = document.createElement("div");
    badge.className = EVAL_BADGE_CLASS;
    var scoreColor = result.score >= 70 ? "#22c55e" : result.score >= 40 ? "#f59e0b" : "#ef4444";
    badge.style.cssText =
      "position:absolute;top:4px;left:4px;background:" + scoreColor + ";color:#fff;" +
      "font-size:11px;font-weight:bold;padding:2px 6px;border-radius:4px;z-index:9999;line-height:1.4;";
    badge.textContent = "★" + result.score;
    if (result.is_duplicate) badge.textContent += " 送済";
    var ngFlags = result.ng_flags || [];
    if (ngFlags.length > 0) {
      badge.title = ngFlags.join(", ");
      badge.style.textDecoration = "line-through";
    }
    card.style.position = "relative";
    card.appendChild(badge);
  }

  // ── 全カードにAI評価スコアを適用（evaluate-property API） ────────
  function runAiEvaluation() {
    if (!storedConditions || !storedConditions.property_customer_id) return;
    var pcid = storedConditions.property_customer_id;
    var cards = findPropertyContainers();

    cards.forEach(function (card) {
      var text = (card.innerText || "").trim();
      if (text.length < 20) return;

      var info = extractPropertyInfo(card);
      if (info.rent == null) return; // rent は API 必須項目（無いと400）

      var key = pcid + "|" + info.name + "|" + info.room_no + "|" + info.rent;
      var cached = evalCache[key];
      if (cached && typeof cached.then === "function") return; // フェッチ中
      if (cached && cached.failed) return;                     // 失敗済み → 再試行しない
      if (cached) { injectEvalBadge(card, cached); return; }   // キャッシュ → バッジ再注入のみ

      evalCache[key] = evaluateProperty(pcid, {
        name: info.name,
        room_no: info.room_no,
        rent: info.rent,
        floor_plan: info.floor_plan || undefined,
        walk_minutes: info.walk_minutes || undefined,
        area_sqm: info.area_sqm || undefined,
        ad_months: info.ad_months || undefined,
      }).then(function (result) {
        if (!result || typeof result.score !== "number") {
          evalCache[key] = { failed: true };
          return;
        }
        evalCache[key] = result;
        injectEvalBadge(card, result);
      });
    });
  }

  // ── 全カードに送済みバッジを適用 ─────────────────────────
  function runDupCheck() {
    if (!sentPropertiesList || sentPropertiesList.length === 0) return;
    var cards = findPropertyContainers();
    cards.forEach(function (card) {
      var text   = (card.innerText || "").trim();
      var roomNo = extractRoomNo(text);
      if (!roomNo) return;
      var rn = roomNo.trim().toLowerCase();
      var match = null;
      for (var i = 0; i < sentPropertiesList.length; i++) {
        var row = sentPropertiesList[i];
        if (row.room_no && row.room_no.trim().toLowerCase() === rn) {
          match = row;
          break;
        }
      }
      if (match) injectDupBadge(card, match.sent_at);
    });
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
    // 送済みバッジも合わせて適用（フェッチ済みの場合のみ）
    runDupCheck();
    // AI評価スコアも合わせて適用（キャッシュ付き・重複APIコールなし）
    runAiEvaluation();
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
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.session) return;
    try {
      chrome.storage.session.get("axlx_score_data", function (data) {
        if (!data || !data.axlx_score_data) return;
        storedConditions = data.axlx_score_data;
        // 顧客が変わった場合は送済みリスト・AI評価キャッシュをリセットしてフェッチ
        if (storedConditions.property_customer_id) {
          sentPropertiesList = null;
          sentFetching       = false;
          evalCache          = {};
          fetchSentProperties(storedConditions.property_customer_id);
          autoFillSearchForm(storedConditions);
        }
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
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "session" || !changes.axlx_score_data) return;
        storedConditions = changes.axlx_score_data.newValue;
        if (!storedConditions) return;
        // 顧客切り替えを検出したら送済みリスト・AI評価キャッシュをリセット・再フェッチ
        if (storedConditions.property_customer_id) {
          sentPropertiesList = null;
          sentFetching       = false;
          evalCache          = {};
          fetchSentProperties(storedConditions.property_customer_id);
          autoFillSearchForm(storedConditions);
        }
        showConditionBar();
        setTimeout(runScoring, 500);
        startObserver();
      });
    } catch (e) {
      // Extension context invalidated 等ではスキップ
    }
  }

  // ── chrome.runtime.onMessage: popup.js からの直接トリガー ───
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg.type !== "axlx-score-results") return;
      if (!msg.conditions) return;
      storedConditions = msg.conditions;
      try {
        if (chrome.storage && chrome.storage.session) {
          chrome.storage.session.set({ axlx_score_data: storedConditions });
        }
      } catch (e) { /* ignore */ }
      showConditionBar();
      setTimeout(runScoring, 300);
      startObserver();
    });
  }

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
