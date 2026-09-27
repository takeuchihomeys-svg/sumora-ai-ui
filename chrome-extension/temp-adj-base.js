// chrome-extension/temp-adj-base.js — 一時調整の履歴を「その時の登録の条件」と結ぶ（純関数・self.AxlxTempAdjBase）
//
// 2026-09-27 竹内（未桜さん: お客様が「大国町エリアで1Kでできたら7畳以上」と言い直し、登録の条件は大国町・1K に変わったのに、
//   拡張の検索は前の一時調整〈九条・大正の駅・8万〉で入力されていた＝search_audits 35 の intended が station_names ["九条","大正"]・rent_max 80000）
//   「このような場合は一時調整じゃなくて、そもそもの条件を修正する。そうすればお客さんが気に入る物件見つかるまで物件検索できる」。
// 旧: お客様を開くたびに、保存した一時調整（tempAdj_{id} の先頭）を登録の条件の上に必ず戻していた（restoreTempAdj）。
//   自動の一括（AIX・自動便・AIXツール）の切替（axlx-switch-customer）でも戻していた＝登録の条件を直しても古い一時調整で検索し続ける。
// 新: 一時調整を保存する時に「その時の登録の条件」の鍵（base）を一緒に残し、開いた時の登録の条件と同じ時だけ戻す。
//   登録の条件が変わった（お客様の言い直し・ブレインの自動反映・スタッフの編集）＝一時調整はもう古い → 戻さない（チップは残る＝押せば使える）。
//   base の無い古い履歴（v2.5.35 以前に保存した物）は、いつの登録の条件の上の調整か分からないので戻さない（チップは残る）。
(function (root) {
  "use strict";

  // 検索に効く登録の条件（一時調整の欄が上書きする物＋軸）
  var FIELDS = ["desired_area", "area_mode", "rent_min", "rent_max", "floor_area_min", "floor_area_max", "floor_plan"];

  function normVal(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return String(v);
    return String(v).normalize ? String(v).normalize("NFKC").replace(/\s+/g, "").trim() : String(v).trim();
  }

  /** 登録の条件の鍵（同じ条件なら同じ文字列） */
  function baseKey(c) {
    if (!c) return "";
    return FIELDS.map(function (f) { return f + "=" + normVal(c[f]); }).join("|");
  }

  /** 保存した一時調整を、開いたお客様の登録の条件の上に戻してよいか */
  function shouldRestore(entry, c) {
    if (!entry || !c) return false;
    if (!entry.base) return false; // 古い履歴（base なし）は戻さない
    return entry.base === baseKey(c);
  }

  var api = { FIELDS: FIELDS, baseKey: baseKey, shouldRestore: shouldRestore };
  root.AxlxTempAdjBase = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
