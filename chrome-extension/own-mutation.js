// own-mutation.js — 拡張が自分で書いた変化だけの MutationObserver の記録か（2026-10-06 v2.5.72）
//
// 竹内「拡張ツールの光ってるモードがなぜかかなり重い」「自動検索じゃなくてスタッフが押して検索しているのに、自動検索のときと同じくらい重い」:
//   原因（コードを読んで確かめた）: 一覧のページで5つの見張り（MutationObserver: score-overlay・bulk-dl・content.js・realpro-guide・underbar）が
//   互いの書き込みに反応し合って止まらなかった。
//   ・score-overlay の runScoring は毎回すべての行の点の札を外して付け直す → 自分の見張りが反応 → 900ms 後にまた runScoring … が
//     ページを開いている間ずっと続く（1回ごとに全行の innerText＝画面の組み直し×3・行ごとの AI 評価の札も付け直し）
//   ・その書き込みのたびに content.js（class/style の変化まで見る）が画面の全文字をたどり、bulk-dl が印刷用PDF を数え直し、
//     案内（realpro-guide）が一覧の行を読み直して光を描き直す
//   検索の仕方（自動・手）に関係なく一覧が出ていれば回るので、手で押した検索でも自動と同じ重さだった。
//   → 各見張りの最初で「拡張が書いた物（id・class が axlx / aixlinx / sumora- で始まる）だけの変化」なら何もしない。
//     keep に当たる物（例: ブレインの下見の札＝案内が光らせ直す合図）は自分の物でも反応する。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && !root.AxlxOwnMut) root.AxlxOwnMut = api;
})(typeof self !== "undefined" ? self : this, function () {
  var OWN_RE = /^(axlx|aixlinx|sumora-)/;

  function ownName(el) {
    if (!el || el.nodeType !== 1) return "";
    var id = el.id || "";
    if (id && OWN_RE.test(id)) return id;
    var c = typeof el.className === "string" ? el.className : (el.getAttribute ? el.getAttribute("class") || "" : "");
    var parts = String(c || "").split(/\s+/);
    for (var i = 0; i < parts.length; i++) if (parts[i] && OWN_RE.test(parts[i])) return parts[i];
    return "";
  }
  /** el かその上（6段まで）が拡張の物か。文字のノードは親で見る。返すのは当たった名前（無ければ ""） */
  function ownAncestor(n) {
    if (n && n.nodeType === 3) n = n.parentNode;
    for (var k = 0; n && k < 7; n = n.parentNode, k++) {
      var nm = ownName(n);
      if (nm) return nm;
    }
    return "";
  }
  function classDiffOnlyOwn(oldValue, el) {
    var a = String(oldValue || "").split(/\s+/).filter(Boolean);
    var now = el && typeof el.className === "string" ? el.className : "";
    var b = String(now || "").split(/\s+/).filter(Boolean);
    var diff = a.filter(function (x) { return b.indexOf(x) < 0; }).concat(b.filter(function (x) { return a.indexOf(x) < 0; }));
    return diff.length > 0 && diff.every(function (x) { return OWN_RE.test(x); });
  }
  /**
   * 1つの記録が拡張の物だけか。keep（正規表現）に当たる拡張の物は「拡張の物ではない」扱い（反応する）。
   *   childList: 足した・外したノードが全部拡張の物（かその中）／attributes: 拡張の物の属性・拡張の class だけの付け外し・data-axlx の属性
   */
  function isOwnRecord(m, keep) {
    if (!m) return true;
    var hitKeep = function (nm) { return !!(nm && keep && keep.test(nm)); };
    if (m.type === "attributes") {
      var tn = ownAncestor(m.target);
      if (tn) return !hitKeep(tn);
      if (m.attributeName && m.attributeName.indexOf("data-axlx") === 0) return !(keep && keep.test(m.attributeName));
      if (m.attributeName === "class" && m.oldValue != null) return classDiffOnlyOwn(m.oldValue, m.target);
      return false;
    }
    var tgt = ownAncestor(m.target);
    if (tgt) return !hitKeep(tgt);
    var nodes = [];
    var add = m.addedNodes || [], rem = m.removedNodes || [];
    for (var i = 0; i < add.length; i++) nodes.push(add[i]);
    for (var j = 0; j < rem.length; j++) nodes.push(rem[j]);
    if (!nodes.length) return true;
    for (var k = 0; k < nodes.length; k++) {
      var nm = ownName(nodes[k]) || (nodes[k] && nodes[k].nodeType === 3 ? "" : "");
      if (!nm || hitKeep(nm)) return false;
    }
    return true;
  }
  /** 記録の束が全部拡張の物か（true なら見張りは何もしない） */
  function onlyOwn(muts, keep) {
    if (!muts || !muts.length) return true;
    for (var i = 0; i < muts.length; i++) if (!isOwnRecord(muts[i], keep)) return false;
    return true;
  }
  return { onlyOwn: onlyOwn, isOwnRecord: isOwnRecord, ownName: ownName, ownAncestor: ownAncestor, OWN_RE: OWN_RE };
});
