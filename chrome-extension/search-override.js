// chrome-extension/search-override.js（self.AxlxSearchOverride・純関数・chrome.* を使わない）
// AIXツールのメモ欄の検索の指示（web_brain のコマンドの payload.search_override）を「その回だけ」お客様の条件と一時調整の欄に重ねる。
//
// 2026-09-27 竹内「ここに条件を送ったら、それに連動して検索されるようにする。例えば『大正駅で検索する』なら駅は大正駅だけで検索、
//   『1LDKで検索する』なら1LDKで検索。これは拡張ツールの一時調整の部分で合わせる形。ゆくゆくは拡張ツールの AIX モードで使えるようにしていく」
//
// 形はサーバーの app/lib/search-override.ts の SearchOverride と同じ:
//   { v:1, location:{mode:"only"|"add", stations[], lines[], areas[]}|null, floor_plan, rent_max, rent_min（円）, walk_minutes, building_age,
//     area_min, area_max（㎡）, pet:true|null, site, is_wide }
//   null の欄＝お客様の登録の条件のまま。駅・路線・区はお客様の希望エリアと同じ書き方（「大正」「御堂筋線」「大阪市大正区」）で来るので、
//   サイトごとの表記（リアプロ／itandi／レインズ）は今までの対応表（STATION_LINE_MAP → 各サイトの表）がそのまま直す。
//
// 決まり（書き換えない物）:
//   ・お客様の登録の条件（DB）・拡張に保存した一時調整（localStorage の tempAdj_{id}）には書かない
//   ・background はお客様の写し（applyToCustomer）を作ってその回だけ使う／popup は一時調整の欄に値を入れるだけ（input の出来事を出さない＝履歴に保存しない）
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AxlxSearchOverride = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var SITES = ["realnetpro", "itandi", "reins"];
  var FLOOR_PLAN_RE = /^(?:[1-9](?:R|K|DK|LDK|SK|SDK|SLDK))(?:以上|〜[1-9](?:R|K|DK|LDK|SK|SDK|SLDK)|(?:・[1-9](?:R|K|DK|LDK|SK|SDK|SLDK)){0,5})?$/;
  var SAFE_NAME_RE = /^[^<>{}"'`\\\n\r\t]{1,24}$/;

  function strArr(v, n) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length && out.length < n; i++) {
      var s = typeof v[i] === "string" ? v[i].trim() : "";
      if (s && SAFE_NAME_RE.test(s) && out.indexOf(s) < 0) out.push(s);
    }
    return out;
  }
  function num(v, lo, hi) {
    var n = typeof v === "number" ? v : (v == null || v === "" ? NaN : Number(v));
    return isFinite(n) && n >= lo && n <= hi ? n : null;
  }

  /** payload の search_override を読む（サーバーで関所を通してあるが、拡張でも形だけ確かめる）。上書きが1つも無ければ null */
  function sanitize(x) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return null;
    var ov = { v: 1, location: null, floor_plan: null, rent_max: null, rent_min: null, walk_minutes: null, building_age: null, area_min: null, area_max: null, pet: null, site: null, is_wide: null };
    var loc = x.location && typeof x.location === "object" ? x.location : null;
    if (loc) {
      var st = strArr(loc.stations, 10), ln = strArr(loc.lines, 5), ar = strArr(loc.areas, 10);
      if (st.length || ln.length || ar.length) ov.location = { mode: loc.mode === "add" ? "add" : "only", stations: st, lines: ln, areas: ar };
    }
    if (typeof x.floor_plan === "string" && FLOOR_PLAN_RE.test(x.floor_plan)) ov.floor_plan = x.floor_plan;
    ov.rent_max = num(x.rent_max, 10000, 500000);
    ov.rent_min = num(x.rent_min, 10000, 500000);
    if (ov.rent_max != null && ov.rent_min != null && ov.rent_min >= ov.rent_max) ov.rent_min = null;
    ov.walk_minutes = num(x.walk_minutes, 1, 30);
    ov.building_age = num(x.building_age, 1, 60);
    ov.area_min = num(x.area_min, 10, 200);
    ov.area_max = num(x.area_max, 10, 200);
    if (ov.area_min != null && ov.area_max != null && ov.area_min >= ov.area_max) ov.area_min = null;
    ov.pet = x.pet === true ? true : null;
    ov.site = SITES.indexOf(x.site) >= 0 ? x.site : null;
    ov.is_wide = typeof x.is_wide === "boolean" ? x.is_wide : null;
    return isEmpty(ov) ? null : ov;
  }

  function isEmpty(ov) {
    if (!ov) return true;
    return !ov.location && !ov.floor_plan && ov.rent_max == null && ov.rent_min == null && ov.walk_minutes == null &&
      ov.building_age == null && ov.area_min == null && ov.area_max == null && ov.pet == null;
  }

  function splitArea(s) {
    return String(s || "").split(/[・、,]+/).map(function (t) { return t.trim(); }).filter(Boolean);
  }
  function uniq(arr) {
    var out = [];
    arr.forEach(function (t) { if (t && out.indexOf(t) < 0) out.push(t); });
    return out;
  }

  /**
   * お客様の写しに上書きを重ねる（元のお客様は変えない）。background の一括検索（_runBatchSearch）が使う＝
   *   _buildBatchConditions（レインズ・popup が答えない時の予備・結果の照合）と検索の点検（customer_snapshot）が同じ値を見る。
   * 場所: only＝希望エリアをこの場所だけに置き換え（area_mode は駅だけ→station・地域だけ→ward・両方→both）
   *       add ＝登録の希望エリアに足す（駅の登録に地域を足す・地域の登録に駅を足す時は both）
   */
  function applyToCustomer(c, ov) {
    if (!c || !ov) return c;
    var out = Object.assign({}, c);
    var loc = ov.location;
    if (loc) {
      var stTokens = loc.stations.concat(loc.lines);
      var wdTokens = loc.areas.slice();
      var hasSt = stTokens.length > 0, hasWd = wdTokens.length > 0;
      if (loc.mode === "add") {
        var reg = c.areas && c.areas.length ? c.areas.slice() : splitArea(c.desired_area || c.area);
        out.desired_area = uniq(reg.concat(stTokens, wdTokens)).join("・");
        var m = c.area_mode || null;
        if ((m === "station" && hasWd) || (m === "ward" && hasSt)) out.area_mode = "both";
      } else {
        out.desired_area = uniq(stTokens.concat(wdTokens)).join("・");
        out.area_mode = hasSt && hasWd ? "both" : hasSt ? "station" : "ward";
        out.lines = [];
        out.stations = [];
      }
      out.area = out.desired_area;
      out.areas = null; // _buildBatchConditions は areas があれば desired_area より先に使う
    }
    if (ov.floor_plan) { out.floor_plan = ov.floor_plan; out.layout = ov.floor_plan; }
    if (ov.rent_max != null) { out.rent_max = ov.rent_max; out.max_rent = ov.rent_max; }
    if (ov.rent_min != null) { out.rent_min = ov.rent_min; out.min_rent = ov.rent_min; }
    if (ov.walk_minutes != null) out.walk_minutes = ov.walk_minutes;
    if (ov.building_age != null) out.building_age = ov.building_age;
    if (ov.area_min != null) out.floor_area_min = ov.area_min;
    if (ov.area_max != null) out.floor_area_max = ov.area_max;
    if (ov.pet) out.pet = true;
    out._search_override = ov;
    return out;
  }

  /**
   * 一時調整の欄（popup の adj-form）に入れる値。current は今の欄の値（preloadAdjForm でお客様の登録の条件が入った状態）。
   *   pass: area_mode=both の2回（ward／station）のどちらか（null＝1回だけ）。その回の軸でない欄は空にする。
   *   返す edited は「最後に手で編集した欄」の代わり（リアプロの computeTempAdjOverride が見る＝一時調整優先で検索軸を決める）。
   *   値を入れない欄は undefined（触らない＝登録のまま）
   */
  function formValues(ov, current, pass) {
    var cur = current || {};
    var r = {};
    var loc = ov && ov.location;
    if (loc) {
      var st = loc.stations.concat(loc.lines), wd = loc.areas.slice();
      var station, ward;
      if (loc.mode === "add") {
        station = uniq(splitArea(cur.station).concat(st)).join("・");
        ward = uniq(splitArea(cur.ward).concat(wd)).join("・");
      } else {
        station = st.join("・");
        ward = wd.join("・");
      }
      if (pass === "ward") station = "";
      if (pass === "station") ward = "";
      r.station = station;
      r.ward = ward;
      r.edited = station && !ward ? "station" : ward && !station ? "ward" : null;
    }
    if (ov && ov.floor_plan) r.floor = ov.floor_plan;
    if (ov && ov.rent_max != null) r.rent_max = String(ov.rent_max);
    if (ov && ov.rent_min != null) r.rent_min = String(ov.rent_min);
    if (ov && ov.walk_minutes != null) r.walk = String(ov.walk_minutes);
    if (ov && ov.building_age != null) r.age = String(ov.building_age);
    if (ov && ov.area_min != null) r.area_min = String(ov.area_min);
    if (ov && ov.area_max != null) r.area_max = String(ov.area_max);
    if (ov && ov.pet) r.pet = true;
    return r;
  }

  function man(yen) { return (Math.round(Number(yen) / 1000) / 10) + "万"; }

  /** 短い説明（コンソール・検索の点検の段・帯） */
  function describe(ov) {
    if (!ov) return "上書きなし";
    var p = [];
    var loc = ov.location;
    if (loc) {
      var names = loc.stations.map(function (s) { return s + "駅"; }).concat(loc.lines, loc.areas.map(function (a) { return a.replace(/^大阪市/, ""); }));
      p.push(names.join("・") + (loc.mode === "add" ? "を足す" : "だけ"));
    }
    if (ov.floor_plan) p.push(ov.floor_plan);
    if (ov.rent_max != null || ov.rent_min != null) p.push("家賃" + (ov.rent_min != null ? man(ov.rent_min) + "〜" : "〜") + (ov.rent_max != null ? man(ov.rent_max) : ""));
    if (ov.walk_minutes != null) p.push("徒歩" + ov.walk_minutes + "分");
    if (ov.building_age != null) p.push("築" + ov.building_age + "年");
    if (ov.area_min != null || ov.area_max != null) p.push((ov.area_min != null ? ov.area_min : "") + "〜" + (ov.area_max != null ? ov.area_max : "") + "㎡");
    if (ov.pet) p.push("ペット相談");
    return p.join("・") || "上書きなし";
  }

  return { sanitize: sanitize, isEmpty: isEmpty, applyToCustomer: applyToCustomer, formValues: formValues, describe: describe, FLOOR_PLAN_RE: FLOOR_PLAN_RE };
});
