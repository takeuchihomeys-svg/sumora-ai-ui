// chrome-extension/commute-candidates.js — 「◯◯まで一本」「◯◯まで◯分以内」「◯◯に通勤」の候補の駅を出す（UMD・self.AxlxCommuteCandidates）
//
// 2026-09-25 竹内「地図の部分や沿線の部分の位置関係の強化は拡張ツールでも理解できるようにする。例えば梅田駅まで電車で一本の場合、
//   梅田駅や大阪梅田駅に一本で通える沿線を全て理解して、そこの駅を理解していれば分かるし、位置関係も理解していれば、
//   電車で何分以内で通える駅かも分かる」
//
// ■ 仕組み
//   路線のつながりは osaka-transit.js（self.AxlxOsakaTransit・サーバーの app/lib/transit-route.ts と同じデータ・同じ関数の自動生成）。
//   ここは「お客様の条件から目的地を読む → 候補の駅を並べる → 拡張の辞書の駅名に戻す」だけ（純関数の build と、画面の render）。
//
// ■ 既存の検索を壊さない（候補として見せてスタッフが選ぶ）
//   - 自動の流れ（popup.js の「電車1本」resolveDirectCommute＝沿線を選んで全駅／「◯分」の TRANSIT_GRAPH の展開）は変えていない。
//   - 押した時だけ一時調整の「駅」欄に駅名を入れる（手で打った時と同じ input の出来事を出す）。そこから先は今までの駅の入力と同じで、
//     リアプロ／itandi／レインズの駅名・路線名は拡張の既存の対応表（STATION_LINE_MAP → LINE_ROUTE_MAP・ITANDI_LINE_MAP_FILL・REINS_LINE_MAP）を通る。
//     ここでサイトの表記は一切作らない（3サイトの表記を混ぜない）。
//   - 駅名は拡張の辞書（STATION_LINE_MAP・学習済みの駅）にある言い方だけ入れる（「なんば」は乗る路線で なんば／JR難波／大阪難波 を選び分ける）。
//     辞書に無い駅（兵庫・京都の一部）は入れずに数だけ見せる。
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AxlxCommuteCandidates = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  // osaka-transit の路線名 → 拡張の STATION_LINE_MAP の路線名（リアプロ内部名）。駅名の言い方を選び分けるためだけに使う
  var LINE_TO_EXT = {
    "JR神戸線": ["東海道本線"],
    "JR宝塚線": ["福知山線"],
    "JRゆめ咲線": ["桜島線"],
  };
  function extLinesFor(line) { return LINE_TO_EXT[line] || [line]; }

  /** お客様の行 → 読む文（通勤の列・希望エリア・条件欄） */
  function customerTexts(c) {
    c = c || {};
    var out = [];
    var st = String(c.commute_station || "").trim();
    if (st) {
      var mins = Number(c.commute_minutes);
      out.push(mins > 0 ? st + "まで" + mins + "分" : st + "へ通勤");
    }
    ["desired_area", "area", "preferences", "other_requests", "additional_conditions"].forEach(function (k) {
      if (c[k] && typeof c[k] === "string") out.push(c[k]);
    });
    return out.join("\n");
  }

  /**
   * 1駅を拡張の辞書の言い方に戻す。routeLines は乗る路線（osaka-transit の名前）。
   * deps.extLinesOf(言い方) → 拡張の辞書のその駅の路線（リアプロ内部名）の配列。辞書に無ければ null。
   */
  function pickExtNames(T, station, routeLines, deps) {
    var names = T.extNames(station).filter(function (w) { return !!deps.extLinesOf(w); });
    if (!names.length) return [];
    var want = [];
    (routeLines || []).forEach(function (l) { extLinesFor(l).forEach(function (x) { if (want.indexOf(x) < 0) want.push(x); }); });
    var hit = names.filter(function (w) { return (deps.extLinesOf(w) || []).some(function (l) { return want.indexOf(l) >= 0; }); });
    return hit.length ? hit : [names[0]];
  }

  function uniq(arr) { var s = {}; return arr.filter(function (x) { if (s[x]) return false; s[x] = 1; return true; }); }

  /**
   * 候補の駅（純関数・画面なし）。
   * opts: { minutes?: number（◯分の上書き）, maxTransfers?: number（既定 1）}
   * 戻り値: { asks, blocks: [{ kind: "one"|"time", target, word, title, members(拡張名), routes?: [{label, stations:[{station, ext[]}]}],
   *           stations: [{station, ext[], minutes?, transfers?, lines?}], extCount, missing: [駅] }] }
   */
  function build(T, customer, deps, opts) {
    opts = opts || {};
    var asks = T.commuteAsks(customerTexts(customer));
    var blocks = [];
    asks.forEach(function (a) {
      var g = T.groupOf(a.target);
      if (!g) return;
      var members = uniq([].concat.apply([], g.members.map(function (m) { return pickExtNames(T, m, T.linesOf(m), deps); })));
      if (a.oneRide || a.minutes == null) {
        var one = T.oneRideStations(a.target);
        if (one) {
          var missing = [];
          var routes = one.routes.map(function (r) {
            return {
              label: r.kind === "line" ? T.shortLineName(r.route) : r.route,
              stations: r.stations.map(function (s) {
                var ext = pickExtNames(T, s, r.lines, deps);
                if (!ext.length && missing.indexOf(s) < 0) missing.push(s);
                return { station: s, ext: ext };
              }),
            };
          });
          var all = [];
          routes.forEach(function (r) { r.stations.forEach(function (s) { all = all.concat(s.ext); }); });
          all = uniq(all);
          blocks.push({
            kind: "one", target: a.target, word: a.word, members: members, routes: routes,
            title: a.word + "まで一本（乗り換えなし）" + (a.oneRide ? "" : "・「" + a.source + "」から"),
            stations: one.stations.map(function (x) { return { station: x.station, ext: [] }; }),
            extCount: all.length, missing: missing, allExt: all,
          });
        }
      }
      if (a.minutes != null) {
        var mins = opts.minutes || a.minutes;
        var maxT = opts.maxTransfers != null ? opts.maxTransfers : 1;
        var w = T.stationsWithin(a.target, mins, { maxTransfers: maxT });
        if (w) {
          var miss = [];
          var list = w.stations.map(function (s) {
            var ext = pickExtNames(T, s.station, s.lines, deps);
            if (!ext.length) miss.push(s.station);
            return { station: s.station, ext: ext, minutes: s.minutes, transfers: s.transfers, lines: s.lines };
          });
          var allT = uniq([].concat.apply([], list.map(function (s) { return s.ext; })));
          blocks.push({
            kind: "time", target: a.target, word: a.word, members: members, minutes: mins, maxTransfers: maxT,
            title: a.word + "まで" + mins + "分以内（乗り換え" + (maxT === 0 ? "なし" : maxT + "回まで") + "）",
            stations: list, extCount: allT.length, missing: miss, allExt: allT,
          });
        }
      }
    });
    return { asks: asks, blocks: blocks };
  }

  /** 駅欄の今の文字から、通勤の言い方（「梅田まで電車1本」「梅田30分」）の語を外し、駅名を足す */
  function mergeStationField(current, add) {
    var toks = String(current || "").split(/[、,・\/\s　]+/).filter(Boolean)
      // 「分」は数字＋分だけ外す（反証レビュー 2026-09-25: 「分」だけだと駅欄の 河内国分 まで消えていた）
      .filter(function (t) { return !/まで|一本|1本|１本|[0-9０-９]+\s*分|通勤|通学|直通|乗り?換|アクセス/.test(t); });
    return uniq(toks.concat(add)).join("・");
  }

  // ───────────────────────── 画面 ─────────────────────────

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]; }); }

  /**
   * box に候補を描く。deps: { extLinesOf(w), onAdd(names: string[], label: string) }
   * 目的地が読めない（通勤の言い方が無い）お客様は何も出さない。
   */
  function render(box, T, customer, deps, opts) {
    if (!box) return null;
    if (!T) { box.style.display = "none"; box.innerHTML = ""; return null; }
    var res = build(T, customer, deps, opts);
    if (!res.blocks.length) { box.style.display = "none"; box.innerHTML = ""; return res; }
    var html = res.blocks.map(function (b, bi) {
      var head = '<div class="cc-head"><span class="cc-title">' + (b.kind === "one" ? "🚃 " : "⏱ ") + esc(b.title) + "</span>" +
        '<span class="cc-count">' + b.extCount + "駅" + (b.missing.length ? "（辞書に無い " + b.missing.length + "駅は入れない）" : "") + "</span></div>";
      var ctrl = "";
      if (b.kind === "time") {
        ctrl = '<div class="cc-ctrl">' +
          '<select class="cc-min" data-b="' + bi + '">' + [10, 15, 20, 25, 30, 40, 45, 60].map(function (m) { return '<option value="' + m + '"' + (m === b.minutes ? " selected" : "") + ">" + m + "分以内</option>"; }).join("") +
          (([10, 15, 20, 25, 30, 40, 45, 60].indexOf(b.minutes) < 0) ? '<option value="' + b.minutes + '" selected>' + b.minutes + "分以内</option>" : "") + "</select>" +
          '<select class="cc-tr" data-b="' + bi + '">' + [0, 1, 2].map(function (n) { return '<option value="' + n + '"' + (n === b.maxTransfers ? " selected" : "") + ">" + (n === 0 ? "乗り換えなし" : "乗り換え" + n + "回まで") + "</option>"; }).join("") + "</select></div>";
      }
      var body;
      if (b.kind === "one") {
        body = '<div class="cc-chips">' + b.routes.map(function (r, ri) {
          var n = uniq([].concat.apply([], r.stations.map(function (s) { return s.ext; }))).length;
          return '<button type="button" class="cc-chip" data-b="' + bi + '" data-r="' + ri + '" title="' + esc(r.stations.map(function (s) { return s.station; }).join(" ")) + '">＋' + esc(r.label) + " " + n + "</button>";
        }).join("") + "</div>";
      } else {
        body = '<div class="cc-list">' + b.stations.map(function (s, si) {
          var dis = s.ext.length ? "" : " cc-none";
          return '<button type="button" class="cc-st' + dis + '" data-b="' + bi + '" data-s="' + si + '" title="' + esc((s.lines || []).map(T.shortLineName).join("→")) + '">' +
            esc(s.station) + "<small>" + s.minutes + "分" + (s.transfers ? "・乗" + s.transfers : "") + "</small></button>";
        }).join("") + "</div>";
      }
      var all = '<button type="button" class="cc-all" data-b="' + bi + '">＋全部を駅に入れる（' + b.extCount + "駅＋" + esc(b.members.join("・")) + "）</button>";
      return '<div class="cc-block">' + head + ctrl + body + all + "</div>";
    }).join("") + '<div class="cc-note">押すと「駅」欄に入ります（手で入れた時と同じ扱い）。自動の検索（電車1本・◯分の展開）はそのまま。</div>';
    box.innerHTML = html;
    box.style.display = "block";

    var add = function (names, label) { if (names.length && deps.onAdd) deps.onAdd(uniq(names), label); };
    Array.prototype.forEach.call(box.querySelectorAll(".cc-chip"), function (btn) {
      btn.onclick = function () {
        var b = res.blocks[Number(btn.dataset.b)], r = b.routes[Number(btn.dataset.r)];
        add(b.members.concat([].concat.apply([], r.stations.map(function (s) { return s.ext; }))), r.label);
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll(".cc-st"), function (btn) {
      btn.onclick = function () {
        var s = res.blocks[Number(btn.dataset.b)].stations[Number(btn.dataset.s)];
        add(s.ext, s.station);
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll(".cc-all"), function (btn) {
      btn.onclick = function () {
        var b = res.blocks[Number(btn.dataset.b)];
        add(b.members.concat(b.allExt), b.title);
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll(".cc-min, .cc-tr"), function (sel) {
      sel.onchange = function () {
        var bi = sel.dataset.b;
        var m = box.querySelector('.cc-min[data-b="' + bi + '"]'), tr = box.querySelector('.cc-tr[data-b="' + bi + '"]');
        render(box, T, customer, deps, { minutes: Number(m && m.value), maxTransfers: Number(tr && tr.value) });
      };
    });
    return res;
  }

  return { build: build, render: render, customerTexts: customerTexts, pickExtNames: pickExtNames, mergeStationField: mergeStationField };
});
