// chrome-extension/send-pairing.js
// 「PDF の並び」と「説明文の並び」を位置（index）で対応づけるのをやめる。
//
// 2026-09-18 竹内「SATOKOさんのURL開いたらMATSUOさんの物件が出てきた」:
//   3サイトとも「送る PDF の配列」と「説明文の配列」を別々に作り、slice / [j] の
//   位置で対応させていた。片方だけ1件落ちると、そこから後ろが全部1つずつズレる。
//     リアプロ … getSelectedUrls() は「checked かつ http(s) の href あり」で絞るのに
//                 説明文は「checked」だけで作っていた（href の無い行でズレる）
//     itandi   … PDF 取得に失敗した行は pdfBase64List に push されないのに、
//                 説明文は propertyInfos[j]（＝成功分の位置）で引いていた
//     レインズ … 説明文は targets 全件、PDF は成功分だけ（件数まで食い違う）
//
// 直し: 1件 = 1つの組（{ url|pdf, summary, data }）にしてから分ける。
//       同じ組から urls / summaries / pool を作るので、構造的にズレようがない。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxSendPairing = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  function isHttpUrl(u) {
    return typeof u === "string" && /^https?:\/\//.test(u);
  }

  // 「送れる行」の判定はここだけ。
  // 一覧を作る側と送る側が別々の条件で絞ると、その差分だけ後ろが全部ズレる。
  function isSendableTarget(t) {
    return !!(t && t.cb && t.cb.checked && t.btn && isHttpUrl(t.btn.href));
  }

  function selectSendableTargets(tracked) {
    var out = [];
    var list = tracked || [];
    for (var i = 0; i < list.length; i++) {
      if (isSendableTarget(list[i])) out.push(list[i]);
    }
    return out;
  }

  // 中身（url / pdf）が欠けた組は送らない。
  // ズレたまま送るより「その1件が出ない」方が被害が小さい。
  function hasPayload(item) {
    if (!item) return false;
    if (typeof item.pdf === "string") return item.pdf.length > 0;
    if (item.pdf != null) return false;
    return isHttpUrl(item.url);
  }

  // 欠けた組を落とし、【1】【2】… の番号を 1 から詰め直す。
  // rank は「実際に送る並び」と必ず一致する（落ちた分だけ番号が飛ぶのを防ぐ）。
  function prepareItems(rawItems) {
    var list = rawItems || [];
    var kept = [];
    var dropped = 0;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!hasPayload(it)) { dropped++; continue; }
      var copy = {};
      for (var k in it) {
        if (Object.prototype.hasOwnProperty.call(it, k)) copy[k] = it[k];
      }
      copy.rank = kept.length + 1;
      kept.push(copy);
    }
    return { items: kept, dropped: dropped };
  }

  // 組のまま分ける。呼び出し側は必ず同じ chunk から urls / summaries / pool を作る。
  function splitBatches(items, size) {
    var n = (typeof size === "number" && size > 0) ? Math.floor(size) : 10;
    var list = items || [];
    var out = [];
    for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  // 組の並びから1つの欄を取り出す（必ず同じ配列から作らせるための入口）。
  function pluck(items, field) {
    return (items || []).map(function (it) { return it ? it[field] : undefined; });
  }

  return {
    isHttpUrl: isHttpUrl,
    isSendableTarget: isSendableTarget,
    selectSendableTargets: selectSendableTargets,
    hasPayload: hasPayload,
    prepareItems: prepareItems,
    splitBatches: splitBatches,
    pluck: pluck,
  };
});
