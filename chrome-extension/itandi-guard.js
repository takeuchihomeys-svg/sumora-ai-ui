// chrome-extension/itandi-guard.js（self.AxlxItandiGuard・純関数・chrome.* を使わない）
// ITANDI の1回の検索の「物件数の上限」と「条件が効いていない検索」の見分け。
//
// 2026-09-30 竹内「ITANDI も一回での上限を作る。物件数で。リアプロがページ数で上限作っているように ITANDI でも上限作るのと、
//   ITANDI で条件指定ちゃんとできていなければ件数多すぎるバグ（3000件以上の表示など）される可能性あるので、ITANDI 検索ちゃんとできていなければ、
//   そこ修正するか、修正効かなければ拡張ツールの部分が問題なのか ITANDI への登録がちゃんと入らなかったのかが原因となるので…次改善できるように学習できる形が理想」
//
// ■ 物件数の上限（MAX_ROWS）: リアプロの max_pages（5ページ）と同じ考えで、ITANDI は1回で選ぶ物件の数に上限を置く。
//   値の出所（2026-09-30 本番の property_candidate_pools・site=itandi・8/1〜・同じお客様で15分以内を1回と数えた 116回）:
//   1回の物件数 中央値 2・p90 8・p95 17・上位 126, 45, 41, 20, 18 …。50 なら普段の検索は1回も切れず、切れるのは 126件の1回だけ
//   （条件が効いていない形の回）。資料は1件ずつモーダルを開いて取るので、上限が無いと 126件＝数十分サイトを触り続ける
// ■ 条件が効いていない（evaluate）: ダウンロード・読み取りに進む前に、1ページ目の行（家賃・間取り・所在地）と件数の文字で決める。
//   線は見張り（app/lib/screen-watch.ts）の wrong_conditions と同じ考え:
//     ・件数 3,000 超（COUNT_MAX＝見張りの countAbsMax の既定と同じ）
//     ・読めた行が MIN_JUDGED 行以上で、その半分以上（OUTSIDE_RATE）が条件の外（家賃が上限の1割超・希望に無い間取り・希望の区の外）
//   迷ったら止めない（行が少ない・条件が読めない・広げての回は家賃を緩く・間取りと区は見ない）。
//   止めた時は1回だけ入れ直し（background・人の間で）→ 直らなければそのお客様の ITANDI は見送り＋★物件出し★に1行。
//   原因の分け方（拡張側／ITANDI 側／判断つかず）はサーバーの点検（app/lib/search-audit-check.ts itandiGuardCause）
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AxlxItandiGuard = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  /** 1回（お客様×ITANDI）で選ぶ物件の上限（上の分布から・普段の検索は切れない） */
  var MAX_ROWS = 50;
  /** 件数の文字がこれを超えたら条件が効いていない（見張りの countAbsMax の既定と同じ） */
  var COUNT_MAX = 3000;
  /** 行で決める時に要る行の数（少ない時は決めない＝止めない） */
  var MIN_JUDGED = 6;
  /** 条件の外の行の割合（これ以上なら止める） */
  var OUTSIDE_RATE = 0.5;
  /** 家賃: 上限のこの倍まで中（管理費は入れない・ITANDI の賃料の欄と同じ） */
  var RENT_SLACK = 1.10;
  /** 広げての回の家賃（広げては上限も少し上げるので、倍を大きく・間取りと区は見ない） */
  var RENT_SLACK_WIDE = 1.5;

  function toHalf(s) {
    return String(s == null ? "" : s).replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); });
  }
  function nfkc(s) { var t = String(s == null ? "" : s); return t.normalize ? t.normalize("NFKC") : toHalf(t); }

  /**
   * 画面の文字から件数を読む（ITANDI の件数の出し方は実物で確かめていないので広く読む・読めなければ null）。
   *   ・「3000件以上」「3,000 件以上」→ 3000・over
   *   ・「検索結果 1,234件」「1,234件中」「全1,234件」「該当 1,234件」→ 1234
   *   ・拡張の帯（「12件を選択中」）・送付の文（「送付済み」「送信」）の行は読まない
   */
  function readCount(text) {
    var s = nfkc(text);
    if (!s) return { number: null, text: null, over: false };
    var lines = s.split(/\n+/);
    var best = null;
    for (var i = 0; i < lines.length && i < 4000; i++) {
      var line = lines[i].trim();
      if (!line || line.length > 60) continue;
      if (/選択中|送付済|送信|ダウンロード|飛ばし|axlx/i.test(line)) continue;
      var m = line.match(/([\d,]{1,9})\s*件\s*以上/);
      if (m) {
        var n0 = Number(m[1].replace(/,/g, ""));
        if (isFinite(n0)) return { number: n0, text: line.slice(0, 80), over: true };
      }
      var m2 = line.match(/(?:検索結果|該当|全|物件数|ヒット)\s*[:：]?\s*([\d,]{1,9})\s*件/) || line.match(/([\d,]{1,9})\s*件\s*(?:中|見つかりました|ヒット|の物件)/);
      if (m2) {
        var n = Number(m2[1].replace(/,/g, ""));
        if (isFinite(n) && (best == null || n > best.number)) best = { number: n, text: line.slice(0, 80), over: false };
      }
    }
    return best || { number: null, text: null, over: false };
  }

  /** 間取りの札（「1K」「1ＬＤＫ」「ワンルーム」→ 1R） */
  function layoutKey(s) {
    var t = nfkc(s).toUpperCase().replace(/\s+/g, "");
    if (!t) return "";
    if (/ワンルーム|^1R$/.test(t)) return "1R";
    var m = t.match(/^([1-9])(S?)(LDK|DK|LK|K|R)$/);
    return m ? m[1] + m[3] : "";
  }
  /** お客様の間取りの条件（「1K,1DK,1LDK」「1K・1DK」「1LDK以上」）→ 札の集まり。「以上」「〜」がある時は見ない（null） */
  function wantLayouts(floorPlan) {
    var s = nfkc(floorPlan);
    if (!s || /以上|〜|~|から|以下/.test(s)) return null;
    var out = [], unknown = false;
    s.split(/[,、・/／\s]+/).forEach(function (p) {
      if (!p) return;
      var k = layoutKey(p);
      if (!k) { unknown = true; return; }
      if (out.indexOf(k) < 0) out.push(k);
    });
    // 読めない札が1つでもある（「1LDK・2D」の打ち間違い等）時は間取りで決めない（迷ったら止めない）
    return out.length && !unknown ? out : null;
  }
  /** お客様の家賃の上限 → 円（8・8.5 は万円・80000 は円）。読めなければ null */
  function rentMaxYen(v) {
    if (v == null || v === "") return null;
    var n = Number(String(v).replace(/[,円万\s]/g, ""));
    if (!isFinite(n) || n <= 0) return null;
    return n < 1000 ? Math.round(n * 10000) : Math.round(n);
  }
  /** 希望の区（区のモードの時だけ）「浪速区・西区」→ ["浪速区","西区"]。駅・地名だけ・区の無い時は null（見ない） */
  function wantWards(desiredArea, areaMode) {
    if (areaMode !== "ward") return null;
    var s = nfkc(desiredArea);
    var out = [];
    var re = /([^\s、,・/／()（）]{1,4}区)/g, m;
    while ((m = re.exec(s))) { var w = m[1].replace(/^(?:大阪市|大阪府)/, ""); if (w.length >= 2 && out.indexOf(w) < 0) out.push(w); }
    return out.length ? out : null;
  }

  /**
   * 1ページ目の行と件数から「条件が効いていない検索」かを決める（純関数）。
   * @param {{ rows: Array<{rentYen?:number|null, layout?:string|null, address?:string|null, name?:string|null, room?:string|null}>,
   *           count?: {number:number|null, over?:boolean}|null,
   *           cond: {rent_max?:any, floor_plan?:string|null, desired_area?:string|null, area_mode?:string|null}|null,
   *           isWide?: boolean }} input
   * @returns {{ suspect:boolean, reasons:string[], judged:number, outside:{rent:number, layout:number, area:number, any:number}, count:number|null, samples:string[] }}
   */
  function evaluate(input) {
    var i = input || {};
    var rows = Array.isArray(i.rows) ? i.rows : [];
    var cond = i.cond || {};
    var wide = !!i.isWide;
    var rMax = rentMaxYen(cond.rent_max != null ? cond.rent_max : cond.max_rent);
    var lays = wide ? null : wantLayouts(cond.floor_plan || cond.layout);
    var wards = wide ? null : wantWards(cond.desired_area, cond.area_mode);
    var out = { suspect: false, reasons: [], judged: 0, outside: { rent: 0, layout: 0, area: 0, any: 0 }, count: null, samples: [] };
    var cnt = i.count && typeof i.count.number === "number" && isFinite(i.count.number) ? i.count.number : null;
    out.count = cnt;
    if (cnt != null && (cnt > COUNT_MAX || (i.count.over && cnt >= COUNT_MAX))) out.reasons.push("count_over");
    var slack = wide ? RENT_SLACK_WIDE : RENT_SLACK;
    rows.forEach(function (r) {
      if (!r) return;
      var judged = false, bad = [];
      if (rMax != null && typeof r.rentYen === "number" && isFinite(r.rentYen) && r.rentYen > 0) {
        judged = true;
        if (r.rentYen > rMax * slack) { out.outside.rent++; bad.push("家賃" + Math.round(r.rentYen / 1000) / 10 + "万"); }
      }
      if (lays) {
        var lk = layoutKey(r.layout);
        if (lk) { judged = true; if (lays.indexOf(lk) < 0) { out.outside.layout++; bad.push(lk); } }
      }
      if (wards && r.address) {
        judged = true;
        var addr = nfkc(r.address);
        var hit = wards.some(function (w) { return addr.indexOf(w) >= 0; });
        if (!hit) { out.outside.area++; bad.push("所在地の区が違う"); }
      }
      if (!judged) return;
      out.judged++;
      if (bad.length) {
        out.outside.any++;
        if (out.samples.length < 5) out.samples.push(String(r.name || "物件").slice(0, 30) + (r.room ? " " + r.room : "") + "（" + bad.join("・") + "）");
      }
    });
    if (out.judged >= MIN_JUDGED && out.outside.any / out.judged >= OUTSIDE_RATE) {
      if (out.outside.rent / out.judged >= OUTSIDE_RATE / 2) out.reasons.push("rent_outside");
      if (out.outside.layout / out.judged >= OUTSIDE_RATE / 2) out.reasons.push("layout_outside");
      if (out.outside.area / out.judged >= OUTSIDE_RATE / 2) out.reasons.push("area_outside");
      if (out.reasons.indexOf("rent_outside") < 0 && out.reasons.indexOf("layout_outside") < 0 && out.reasons.indexOf("area_outside") < 0) out.reasons.push("rows_outside");
    }
    out.suspect = out.reasons.length > 0;
    return out;
  }

  /** このページで選んでよい行の数（上限までの残り）。上限を超えた分は選ばない */
  function capForPage(alreadyPicked, onPage, max) {
    var m = max == null ? MAX_ROWS : max;
    var left = Math.max(0, m - (Number(alreadyPicked) || 0));
    return Math.min(Math.max(0, Number(onPage) || 0), left);
  }

  /** 入れ直しの前の間（ミリ秒）: 人が結果を見て「おかしい」と思い、条件の画面に戻るまで。9〜22秒・揺らす */
  function retryGapMs(rng) {
    var r = typeof rng === "function" ? rng() : Math.random();
    return Math.round(9000 + r * 13000);
  }

  var REASON_JA = {
    count_over: "件数が 3,000件を超えている",
    rent_outside: "家賃が上限を超える物件が多い",
    layout_outside: "希望に無い間取りが多い",
    area_outside: "希望の区の外の物件が多い",
    rows_outside: "条件の外の物件が多い",
  };
  function reasonsJa(reasons) {
    return (Array.isArray(reasons) ? reasons : []).map(function (k) { return REASON_JA[k] || k; }).join("・");
  }

  /** ★物件出し★への1行（入れ直しても直らず見送った時） */
  function skipNotice(customerName, reasons) {
    var who = customerName ? String(customerName).replace(/さん$/, "") + "さんの" : "";
    return "⚠【ITANDI 見送り】" + who + "ITANDI の検索に条件が効いていない形でした（" + (reasonsJa(reasons) || "条件の外の物件が多い") +
      "）。条件を入れ直しても直らないため、今回の ITANDI は見送りました（資料はダウンロードしていません）";
  }

  // ── v2.5.48 送る相手（誰の物件か）は「この入力を始めさせた一括の回のお客様」で決める ──
  // 2026-09-30 本番（search_audits 252・258・265／property_pickups 16:39・16:51・16:53・17:30）:
  //   🐥 さん・yasuki さんの ITANDI の一覧（34件）が ℳ さんに、YUMA の一覧（15件）が yasuki さんに付いた。
  //   旧は送る直前に popup（無ければ storage の最後に選んだお客様）へ「今のお客様は？」と聞いていた＝別の所が持つ状態を後から読む形。
  //   background は入力の直前に必ず axlx-set-fill-customer（誰の入力か）を ITANDI のタブへ送るので、それを「入力を始めた合図」の時に結び、
  //   自動の送信はその人で送る。popup の答えが同じ人なら popup の名前・条件を使い、違う人なら popup の名前・条件は使わない（条件の文は別の人の物）。
  /** set-fill-customer が届いてから入力を始めた合図までの上限（popup の読み直し最長6秒＋人の間＋余裕）。これを過ぎた合図は手の検索として結ばない */
  var FILL_BIND_WINDOW_MS = 90000;
  /**
   * 入力を始めた合図（autofill-initiated）の時に、その回のお客様を決める。
   *   fillCtx: { id, name, at }（axlx-set-fill-customer を受けた時の控え）／ 無い・古い → null（手の検索＝今まで通り popup に聞く）
   */
  function bindFillCustomer(fillCtx, now, windowMs) {
    var c = fillCtx || null;
    if (!c || c.id == null || String(c.id) === "") return null;
    var w = windowMs == null ? FILL_BIND_WINDOW_MS : windowMs;
    var age = Number(now) - Number(c.at);
    if (!(age >= 0 && age <= w)) return null;
    return { id: String(c.id), name: c.name ? String(c.name) : null };
  }
  /**
   * 送る相手。popup: { name, id, conditions }（popup／storage の答え）・bound: bindFillCustomer の答え（無ければ null）
   *   → { name, id, conditions, source: "popup"|"batch", mismatch: 取り違えていた popup の id か null }
   */
  function sendCustomer(popup, bound) {
    var p = popup || {};
    var pid = p.id != null && String(p.id) !== "" ? String(p.id) : null;
    if (!bound || !bound.id) return { name: p.name || null, id: pid, conditions: p.conditions || null, source: "popup", mismatch: null };
    if (pid === String(bound.id)) return { name: p.name || bound.name || null, id: pid, conditions: p.conditions || null, source: "batch", mismatch: null };
    // 別の人（か答えなし）: 一括の回のお客様で送る。popup の名前・条件は別の人の物なので使わない
    return { name: bound.name || null, id: String(bound.id), conditions: null, source: "batch", mismatch: pid || "(none)" };
  }

  return {
    FILL_BIND_WINDOW_MS: FILL_BIND_WINDOW_MS, bindFillCustomer: bindFillCustomer, sendCustomer: sendCustomer,
    MAX_ROWS: MAX_ROWS, COUNT_MAX: COUNT_MAX, MIN_JUDGED: MIN_JUDGED, OUTSIDE_RATE: OUTSIDE_RATE, RENT_SLACK: RENT_SLACK, RENT_SLACK_WIDE: RENT_SLACK_WIDE,
    readCount: readCount, layoutKey: layoutKey, wantLayouts: wantLayouts, rentMaxYen: rentMaxYen, wantWards: wantWards,
    evaluate: evaluate, capForPage: capForPage, retryGapMs: retryGapMs, reasonsJa: reasonsJa, skipNotice: skipNotice,
  };
});
