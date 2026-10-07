// chrome-extension/search-focus.js — 「このお客様を物件検索の一番上へ」の印（純関数・v2.5.86）
//
// 2026-10-06 竹内（会話「H0N0KA.」・物件提案中・18:21「もう少し家賃上げて良いので、新大阪、東三国でありそうですか？😭」）:
//   「ここ（会話の上の状態の帯）広げたところに物件検索ボタンを出す。そうすると拡張ツール繰り上げられるようにする。」
//   「スマホで押しても連携して拡張ツールのお客さんの一番上に繰り上がるようにする」
//
// 形:
//   ・ウェブアプリの帯の「🔍 物件検索」を押す → サーバーの表 property_search_focus に印（押した時刻・押した端末）を1行（お客様ごとに上書き）
//   ・拡張は一覧（/api/property-customers?view=list）の各行の search_focus＝{ at, by, device } を読み、
//     効いている印のお客様を一覧の一番上の「📌 会話から物件検索」に出す（新しく押された順）
//   ・同じ PC の Chrome で押した時は、拡張に直接も渡す（webapp-bridge → background）。リアプロ／ITANDI のタブを前に出して、そのお客様を開く
//
// 印が消える時（サーバーで消す書き込みはしない＝この関数が「効いているか」を決める）:
//   ① 押した後にそのお客様で検索した（last_pinpoint_search_at／last_wide_search_at が押した時刻より後・案内の ▶ を押すと記録される）
//   ② 押した後にそのお客様へ物件を送った（last_property_sent_at が押した時刻より後）
//   ③ 押してから TTL_MS（24時間）経った
//   もう一度押せば時刻が新しくなり、また一番上に出る。
//
// v2.5.88 2026-10-07 竹内「それにする　設計知見と協力しておこなう」:
//   ・AIX【物件を探す】を送った時も同じ印が付く（device="aix"・サーバーの log-aix-usage が置く）。札は「AIX物件を探す」
//   ・印のお客様を開いた時、決め手の条件（closing-target・「気に入った部屋より家賃−5千」「カウンターキッチン」等）を
//     /api/property-search-focus?customer_id= で読み、一時調整の欄に「この回だけ」入れる（登録の条件・保存した一時調整は変えない）。
//     サイトで絞れない設備は欄に入れず帯に出すだけ（採点は property-brain が加点）。closingNote／closingKey はその純関数
(function (root) {
  "use strict";

  var TTL_MS = 24 * 60 * 60 * 1000;

  function _ms(v) {
    if (v == null || v === "") return NaN;
    var t = typeof v === "number" ? v : Date.parse(String(v));
    return Number.isFinite(t) ? t : NaN;
  }

  /**
   * 印が効いているか（純）。c＝お客様の行（search_focus・last_*_search_at・last_property_sent_at を読む）
   * 返す: { active, reason }（reason: none | expired | searched | sent | active）
   */
  function focusState(c, nowMs) {
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var f = c && c.search_focus;
    var at = _ms(f && f.at);
    if (!Number.isFinite(at)) return { active: false, reason: "none" };
    if (now - at >= TTL_MS) return { active: false, reason: "expired" };
    var searched = Math.max(_ms(c.last_pinpoint_search_at) || 0, _ms(c.last_wide_search_at) || 0);
    if (searched > at) return { active: false, reason: "searched" };
    var sent = _ms(c.last_property_sent_at);
    if (Number.isFinite(sent) && sent > at) return { active: false, reason: "sent" };
    return { active: true, reason: "active" };
  }

  function isActive(c, nowMs) { return focusState(c, nowMs).active; }

  /** 一番上に出すお客様（効いている印だけ・新しく押された順） */
  function pinnedCustomers(customers, nowMs) {
    return (customers || [])
      .filter(function (c) { return isActive(c, nowMs); })
      .sort(function (a, b) { return _ms(b.search_focus.at) - _ms(a.search_focus.at); });
  }

  /**
   * 軽い取り直し（/api/property-search-focus の marks）を手元の一覧に重ねる（純・新しい配列を返す）。
   *   marks＝[{ property_customer_id, at, by, device }]。marks に無いお客様の印は外す（サーバーで24時間を過ぎた物）
   *   返す: { customers, missing }（missing＝一覧に居ないお客様の id＝一覧を取り直す合図）
   */
  function mergeMarks(customers, marks) {
    var byId = {};
    (marks || []).forEach(function (m) { if (m && m.property_customer_id) byId[String(m.property_customer_id)] = m; });
    var seen = {};
    var out = (customers || []).map(function (c) {
      var m = byId[String(c.id)];
      if (m) seen[String(c.id)] = true;
      var next = m ? { at: m.at, by: m.by || null, device: m.device || null } : null;
      var cur = c.search_focus || null;
      if (!next && !cur) return c;
      if (next && cur && cur.at === next.at) return c;
      var o = Object.assign({}, c);
      o.search_focus = next;
      return o;
    });
    var missing = Object.keys(byId).filter(function (id) { return !seen[id]; });
    return { customers: out, missing: missing };
  }

  /** 印の署名（変わった時だけ描き直す） */
  function marksSig(marks) {
    return (marks || []).map(function (m) { return String(m.property_customer_id) + "@" + String(m.at); }).sort().join("|");
  }

  /** 「10/6 18:40 スマホ」の形（一覧の札・JST） */
  function label(f) {
    var t = _ms(f && f.at);
    if (!Number.isFinite(t)) return "";
    var d = new Date(t + 9 * 3600 * 1000);
    var hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0");
    var dev = f.device === "phone" ? "スマホ" : f.device === "pc" ? "PC" : f.device === "aix" ? "AIX物件を探す" : "";
    // AIX の印は by にも同じ名前が入る（二重に出さない）
    var by = f.by && !(f.device === "aix" && /AIX/.test(f.by)) ? "・" + f.by : "";
    return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + " " + hh + ":" + mm + (dev ? " " + dev : "") + by;
  }

  /** 決め手の条件の覚えの鍵（お客様×印の時刻＝押し直したら読み直す）。効いていない印は null＝読まない */
  function closingKey(c, nowMs) {
    if (!isActive(c, nowMs)) return null;
    return String(c.id) + "@" + String(c.search_focus.at);
  }

  /**
   * 帯の1行（純）。cl＝サーバーの closing（{ kinds_ja, favorite, search_override, equipment }）。describe＝AxlxSearchOverride.describe
   *   例「🎯 決め手の条件（この回だけ）: 家賃〜7.6万・1LDK／設備: カウンターキッチン（バウスフラッツ新大阪 1002 が基準）」。何も無ければ ""
   */
  function closingNote(cl, describe) {
    if (!cl || typeof cl !== "object") return "";
    var p = [];
    if (cl.search_override && typeof describe === "function") {
      var d = describe(cl.search_override);
      if (d && d !== "上書きなし") p.push(d);
    }
    var eq = Array.isArray(cl.equipment) ? cl.equipment.filter(function (x) { return typeof x === "string" && x; }) : [];
    if (eq.length) p.push("設備: " + eq.join("・") + "（サイトでは絞らず採点で上げる）");
    if (!p.length) return "";
    var kinds = Array.isArray(cl.kinds_ja) && cl.kinds_ja.length ? "［" + cl.kinds_ja.join("・") + "］" : "";
    return "🎯 決め手の条件" + kinds + "（この回だけ）: " + p.join("／") + (cl.favorite ? "（" + cl.favorite + " が基準）" : "");
  }

  var api = { closingKey: closingKey, closingNote: closingNote, TTL_MS: TTL_MS, focusState: focusState, isActive: isActive, pinnedCustomers: pinnedCustomers, mergeMarks: mergeMarks, marksSig: marksSig, label: label };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AxlxSearchFocus = api;
})(typeof self !== "undefined" ? self : globalThis);
