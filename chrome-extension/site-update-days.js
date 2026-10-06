// site-update-days.js — 「更新日（N日以内）」の手の指定をサイトごとに分ける（2026-10-06 v2.5.76）
//
// 竹内「itandiで検索したら連動してリアプロも1日となってしまっているので itandi・リアプロそれぞれの更新日にする必要がある」:
//   原因: popup の更新日の欄（#adj-update-days）は1つで、リアプロ・ITANDI のどちらで開いても、手で選び直すとお客様の
//   rp_update_days（1つの列）に書いていた。ITANDI で「1日」にすると rp_update_days=1 になり、次にリアプロを開くと「1日以内」が入った。
//   → 列をサイトごとに分ける: リアプロ＝rp_update_days（今まで通り）／ITANDI＝itandi_update_days（新しい列・migrate-schema）。
//     欄に入れる値も、手で選び直した時に書く列も、今開いているサイトの物だけ。手の指定が無ければ今まで通り前回物件を出した日から計算。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && !root.AxlxSiteUpdateDays) root.AxlxSiteUpdateDays = api;
})(typeof self !== "undefined" ? self : this, function () {
  /** サイトの手の指定の列 */
  function keyFor(site) { return site === "itandi" ? "itandi_update_days" : "rp_update_days"; }
  /** そのサイトの手の指定（無ければ null）。ITANDI はリアプロの値を使わない */
  function manualFor(c, site) {
    if (!c) return null;
    var v = Number(c[keyFor(site)]);
    return isFinite(v) && v > 0 ? v : null;
  }
  /** 欄に入れる値（手の指定 → 無ければ calc() の自動の値）。文字列（select の value） */
  function fieldValueFor(c, site, calc) {
    var m = manualFor(c, site);
    if (m) return String(m);
    return calc ? String(calc() || "") : "";
  }
  /** 手で選び直した時に書く PATCH の中身（そのサイトの列だけ） */
  function patchFor(c, site, value) {
    var n = Number(value);
    var next = value && isFinite(n) && n > 0 ? n : null;
    var o = { id: c && c.id };
    o[keyFor(site)] = next;
    return { body: o, key: keyFor(site), next: next, changed: manualFor(c, site) !== next };
  }
  return { keyFor: keyFor, manualFor: manualFor, fieldValueFor: fieldValueFor, patchFor: patchFor };
});
