// chrome-extension/learn-refresh-gate.js
// 学習束を「強制取り直すか」の判定（純関数・chrome.* なし）
//
// 2026-11-22 竹内さん「すぐ反映できるように／ポップアップを開かなくても」:
//   束・手順書は DB にあっても、拡張が取らないと自動に乗らない。
//   ポップアップ依存を減らすため、更新直後・手順書欠・needs_auto・束薄い時は force。
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxLearnRefreshGate = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  /**
   * storage スナップショットから「autofill／心拍で force 取込すべきか」を返す。
   * @param {object} st chrome.storage.local の一部
   * @param {{ serverRulesV?: string }|null} [opts] サーバー light の playbook_rules_v（任意）
   * @returns {{ force: boolean, reason: string }}
   */
  function shouldForceLearnRefresh(st, opts) {
    st = st || {};
    opts = opts || {};
    if (st.axlx_learn_after_update) {
      return { force: true, reason: "after_update" };
    }
    if (st.axlx_learn_needs_auto) {
      return { force: true, reason: "needs_auto" };
    }
    if (!st.axlx_learn_ver) {
      return { force: true, reason: "no_ver" };
    }
    /**
     * ★ 2026-11-23: 手順書の決まり版だけ変わった時（generated_at 据え置き穴）も force。
     *   attach-playbook が rules_v を上げても generated_at が同じだと same_version で止まる実測への土台。
     */
    try {
      var serverRv = opts.serverRulesV != null ? String(opts.serverRulesV) : "";
      var localRv = "";
      if (st.axlx_learn_playbook && typeof st.axlx_learn_playbook === "object") {
        localRv = String(st.axlx_learn_playbook.rules_v || "");
      }
      if (serverRv && localRv && serverRv !== localRv) {
        return { force: true, reason: "playbook_rules_v_stale" };
      }
      if (serverRv && !localRv && st.axlx_learn_playbook) {
        return { force: true, reason: "playbook_rules_v_missing_local" };
      }
    } catch (_) {}
    var scrN = 0;
    try {
      if (st.axlx_learn_screen && typeof st.axlx_learn_screen === "object") {
        scrN = Object.keys(st.axlx_learn_screen).length;
      }
    } catch (_) { scrN = 0; }
    if (scrN === 0) return { force: true, reason: "screen_empty" };

    var solid0 = 0;
    try {
      if (st.axlx_learn_link && typeof st.axlx_learn_link.screen_solid === "number") {
        solid0 = Number(st.axlx_learn_link.screen_solid) || 0;
      }
    } catch (_) { solid0 = 0; }
    if (solid0 <= 0) return { force: true, reason: "solid0" };

    var nextN = 0, ptsN = 0;
    try { nextN = Object.keys(st.axlx_learn_next || {}).length; } catch (_) {}
    try { ptsN = Object.keys(st.axlx_learn_points || {}).length; } catch (_) {}
    if (nextN === 0) return { force: true, reason: "next_empty" };
    if (ptsN === 0) return { force: true, reason: "points_empty" };

    var pb = st.axlx_learn_playbook;
    if (!pb || typeof pb !== "object") {
      return { force: true, reason: "playbook_missing" };
    }
    var _site = String((opts && opts.site) || st.axlx_learn_for_site || "").toLowerCase();
    var _isItandiOrReins = (_site === "itandi" || _site === "reins");
    if (!Array.isArray(pb.rules) || (!_isItandiOrReins && pb.rules.length < 1)) {
      return { force: true, reason: "playbook_no_rules" };
    }
    // build_v7 以降は一連の流れが必須。古い手元の手順書のまま押し始めない
    var bv = Number(pb.build_v) || 0;
    var fs = pb.flow_series;
    if (bv >= 7 && (!Array.isArray(fs) || fs.length < 5)) {
      return { force: true, reason: "playbook_no_flow_series" };
    }
    if (bv > 0 && bv < 7) {
      return { force: true, reason: "playbook_build_old" };
    }

    return { force: false, reason: "ok" };
  }

  /**
   * ページ起動時に裏で取り直すか（タブを開いただけでも新束へ寄せる）。
   * 連続リロードで連打しないよう、呼び出し側で throttle する。
   */
  function shouldBootLearnRefresh(st) {
    var g = shouldForceLearnRefresh(st || {});
    if (g.force) return g;
    return { force: false, reason: "boot_ok" };
  }

  /**
   * モード切替で「自動の道が開いた」か（通常→自動/AIX）。
   * @param {object|null} oldVal storage change oldValue
   * @param {object|null} newVal storage change newValue
   * @param {string} key autoModeAt | aixMode | aiMode
   */
  function modeOpenedForLearn(key, oldVal, newVal) {
    if (key === "autoModeAt") {
      var o = Number(oldVal) || 0;
      var n = Number(newVal) || 0;
      return n > 0 && n !== o;
    }
    if (key === "aixMode" || key === "aiMode") {
      return !!newVal && !oldVal;
    }
    return false;
  }

  return {
    shouldForceLearnRefresh: shouldForceLearnRefresh,
    shouldBootLearnRefresh: shouldBootLearnRefresh,
    modeOpenedForLearn: modeOpenedForLearn,
  };
});
