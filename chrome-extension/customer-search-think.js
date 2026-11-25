/**
 * 客ごとの検索思考（決定論・LLMなし）— background / page 共用の写し
 * 正本: app/lib/customer-search-think.ts（テストで同じケースを通す）
 */
(function (root) {
  "use strict";

  function wantFromAreaMode(areaMode, desiredArea) {
    var m = String(areaMode || "").toLowerCase();
    if (m === "station" || m === "stations") return "station";
    if (m === "ward" || m === "area" || m === "city") return "area";
    var d = String(desiredArea || "");
    if (/駅/.test(d) && !/[市区町村]/.test(d.replace(/駅/g, ""))) return "station";
    if (/[市区]/.test(d) || /区、|区・/.test(d)) return "area";
    if (d.trim()) return "area";
    return "none";
  }

  function thinkCustomerSearch(input) {
    input = input || {};
    var cid = String(input.customerId || "").trim();
    var placeMode = wantFromAreaMode(input.areaMode, input.desiredArea);
    var prevCid = String(input.prevCid || "").trim();
    var prevWant = String(input.prevWantMode || "").toLowerCase();
    var seen = String(input.playbookSeenRv || "").trim();
    var code = String(input.codePlaybookRv || "").trim();
    var reasons = [];
    var switched = !!(prevCid && cid && prevCid !== cid);
    var forceClearStations = placeMode === "area" && (switched || prevWant === "station");
    if (forceClearStations) {
      reasons.push(switched ? "前客" + prevCid.slice(0, 8) + "→地域：駅残を開いて外す" : "前客が駅モード→地域：駅残を開いて外す");
    }
    var forceClearWards = placeMode === "station" && (switched || prevWant === "area" || prevWant === "ward");
    if (forceClearWards) {
      reasons.push(switched ? "前客" + prevCid.slice(0, 8) + "→駅：区・町残を外す" : "前客が地域→駅：区・町残を外す");
    }
    var playbookStale = !!(code && seen && seen !== code);
    if (playbookStale) reasons.push("手順書旧版 seen=" + seen.slice(0, 8) + "≠code=" + code.slice(0, 8));
    if (!seen && code) reasons.push("手順書未読（playbook_seen無し）");
    var designatedLock = !!cid;
    if (designatedLock) reasons.push("指定客ロック cid=" + cid.slice(0, 8));
    var summary =
      "客思 place=" + placeMode +
      (forceClearStations ? " clearSt=Y" : "") +
      (forceClearWards ? " clearWd=Y" : "") +
      (playbookStale ? " pb=stale" : seen ? " pb=ok" : " pb=?") +
      (reasons.length ? "／" + reasons.join("・") : "");
    return {
      placeMode: placeMode,
      forceClearStations: forceClearStations,
      forceClearWards: forceClearWards,
      playbookStale: playbookStale,
      designatedLock: designatedLock,
      reasons: reasons,
      summary: summary.slice(0, 220),
    };
  }

  var api = { thinkCustomerSearch: thinkCustomerSearch };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AxlxCustomerSearchThink = api;
})(typeof self !== "undefined" ? self : globalThis);
