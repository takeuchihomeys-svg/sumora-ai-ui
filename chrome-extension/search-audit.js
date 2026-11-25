// chrome-extension/search-audit.js
// 検索の点検（拡張側）: ブレインモードで検索した1回ごとに「入れようとした条件・実際に入った値・結果」を
// /api/search-audits に送る。純関数＋送信の1関数＋1回ごとの記録（tracker）。self.AxlxSearchAudit。
//
// 2026-09-25 竹内「ブレインモードで物件自動検索や一括検索した際に、検索がちゃんとされていなかったら原因を見つけられるようにする。
//   0件だった場合ちゃんと検索されていない可能性があるし、お客さんの条件とずれた検索をしていた可能性がある。
//   ブレインモードに拡張ツール連携していた時。DeepSeek の API で行う。そうすればずっと拡張ツール側も成長していく」
//
// 決まり:
//   ・送るのはブレインの時だけ（AxlxModeCore.behavior の searchAudit）。サーバーも brain!==true なら何もしない（二重の歯止め）
//   ・送信は5秒で切る・失敗しても検索は止めない（戻り値で成否だけ返す・例外を投げない）
//   ・お客様の名前・電話は送らない（customer_snapshot は条件の欄だけ・自由記述の中の長い数字は伏せる）
//   ・page-script の audit は 8KB まで（見本の配列から削る）
// 読み込む所: background.js（import）・popup.html（script）・manifest の content_scripts の先頭（bulk-dl.js が件数表示の読み取りに使う）
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (root) { root.AxlxSearchAudit = api; }
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  "use strict";

  var API_BASE = "https://sumora-ai-ui.vercel.app";
  var SEND_TIMEOUT_MS = 5000;
  // 2026-09-27 v2.5.31: 操作ごとの時刻（ページの段・資料の送信の段）を足したので 40 → 120
  var MAX_STEPS = 120;
  var MAX_AUDIT_BYTES = 8192;
  // 入れようとした駅の名前の上限（サーバーの screen-watch-expect.ts INTENT_STATION_CAP と同じ）
  var STATION_NAMES_MAX = 300;

  // お客様の条件のうち写す欄（名前・電話・LINE の ID は入れない）
  var SNAPSHOT_FIELDS = [
    "desired_area", "area_mode", "rent_max", "max_rent", "rent_min", "floor_plan", "layout", "walk_minutes", "building_age",
    "floor_area_min", "commute_station", "commute_minutes", "pet", "rp_update_days", "last_property_sent_at", "property_viewed_at",
    "status", "preferences", "ng_points",
  ];
  // 入れようとした条件のうち写す欄
  var INTENDED_FIELDS = [
    "area_mode", "rent_max", "rent_min", "walk_minutes", "building_age", "floor_plan", "rp_update_days", "is_wide",
    "station_names", "route_ids", "city_codes", "detail_ward", "detail_area", "town_names", "itandi_lines", "ward_names", "ward_name",
    "reins_station_pairs", "reins_line", "unknown_tokens", "area_min", "area_max", "structure_types", "pet_ok", "shikirei_free",
    "select_all_line_stations", "sort_order", "max_pages",
    // 2026-09-29 v2.5.39 通勤の到達時間で選んだ駅（数だけ・commute-reach reachAudit の形）
    "commute",
  ];

  // ── v2.5.48 同じ「お客様の切り替え」が2回届く（popup の iframe は background の tabs.sendMessage を
  //   ①chrome.runtime.onMessage で直接 ②underbar.js の中継（postMessage）の2つで受ける）──
  // 2026-09-30 本番（search_audits・ITANDI の一括の回すべて）: 6〜13秒遅れで trigger=single の行が付き、ページの段が全部そちらに付いた
  //   ＝自動入力を2回押していた。2回目は点検の控え（_pendingAuditCtx）が1回目に使われた後なので run_id が新しく作られ、
  //   ページ側の「同じ条件の2回目は動かさない」（itandi-form-guard fillKey）も run_id の違いで外れた。区のお客様は2本が所在地の窓でぶつかり 240秒の watchdog。
  //   直し: 入口（popup）で同じ お客様×サイト×点検の回 の2回目を受けない。受け取りはほぼ同時なので窓は短く（入れ直し＝9秒以上後 は通す）
  var SWITCH_DUP_WINDOW_MS = 4000;
  function switchKey(d) {
    var x = d || {};
    return [x.customerId == null ? "" : String(x.customerId), x.site || "", x.auditRunId || "", x.is_wide ? "w" : "p", x.areaMode || ""].join("|");
  }
  /** prev: { key, at }。同じ鍵が windowMs 以内なら2回目（true） */
  function isDuplicateSwitch(prev, key, now, windowMs) {
    if (!prev || !key || prev.key !== key) return false;
    var w = windowMs == null ? SWITCH_DUP_WINDOW_MS : windowMs;
    var d = Number(now) - Number(prev.at);
    return d >= 0 && d < w;
  }

  function newRunId(now) {
    var t = typeof now === "number" ? now : Date.now();
    return "sa_" + t.toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  // 自由記述の中の電話番号らしい数字（10桁以上・ハイフン込み）を伏せる
  function maskDigits(s) {
    return String(s).replace(/\d[\d\-‐－ー ]{8,}\d/g, "＊＊＊");
  }

  // 2026-09-29 v2.5.41: 日時の欄は伏せない。maskDigits は「2026-09-26T02:50…」の日付を電話番号の形（数字とハイフン10字以上）として
  //   「＊＊＊T02:50…」にしていた → サーバーの点検が前回物件を出した日を読めず、更新日の「決まり」が毎回「指定なし」になり
  //   UPDATE_DAYS differs の誤警報が 9/22〜 の 90件になっていた。日時（ISO の形）は個人の情報ではないのでそのまま送る
  var DATE_FIELDS = { last_property_sent_at: true, property_viewed_at: true };
  var ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

  function snapshotCustomer(c) {
    if (!c || typeof c !== "object") return null;
    var out = {};
    for (var i = 0; i < SNAPSHOT_FIELDS.length; i++) {
      var k = SNAPSHOT_FIELDS[i];
      var v = c[k];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v === "string" && DATE_FIELDS[k] && ISO_RE.test(v.trim())) { out[k] = v.trim().slice(0, 40); continue; }
      if (typeof v === "string") v = maskDigits(v).slice(0, 400);
      out[k] = v;
    }
    return out;
  }

  // 一時調整の上書き（search-override.js の形）を点検用に小さく写す（名前・電話は元から無い）
  function overrideForAudit(ov) {
    if (!ov || typeof ov !== "object") return null;
    var out = {};
    ["location", "floor_plan", "rent_max", "rent_min", "walk_minutes", "building_age", "area_min", "area_max", "pet", "site", "is_wide"].forEach(function (k) {
      if (ov[k] !== undefined && ov[k] !== null) out[k] = ov[k];
    });
    return Object.keys(out).length ? out : null;
  }
  function withOverride(snap, ovr) {
    if (!ovr) return snap;
    var o = snap || {};
    o._search_override = ovr;
    return o;
  }

  function capArray(a, n) {
    return Array.isArray(a) ? a.slice(0, n) : a;
  }

  function pickIntended(cond) {
    if (!cond || typeof cond !== "object") return null;
    var out = {};
    for (var i = 0; i < INTENDED_FIELDS.length; i++) {
      var k = INTENDED_FIELDS[i];
      var v = cond[k];
      if (v === undefined) continue;
      // 2026-09-29 見張り（決め方のズレ）: 通勤の到達駅（最大240）と表の期待を比べるため、駅の名前だけ 80 → 300
      if (Array.isArray(v)) v = capArray(v, k === "station_names" ? STATION_NAMES_MAX : 80);
      else if (typeof v === "string") v = v.slice(0, 300);
      out[k] = v;
    }
    return out;
  }

  /**
   * ★ 2026-11-20 (2.8.143) 実測 audit #1551: 120段を超えると先頭から落ち、begin・fill_done と
   *   「所在地の小窓が失敗→区で代替」の理由（page:fallback_area）が消えて、統括が原因を追えなかった。
   *   → 回の始まり・終わり・代替の理由は残し、それ以外の古い段から落とす（全部が残す段なら先頭から）。
   */
  /** flow_series_plan / order / gap / reset / skip も flow_series_ で残す */
  var KEEP_STEP = /^(begin|bulk_kick|bulk_done_resend|dl:one_send_ms|dl:pdf_click_nocap|bulk_end_now|page:perf_|page:gate_prev_leftover|page:gate_stop_basic|dl:result_verify|page:result_expect|page:leftover_|fill_done|finish|result|human_search|search_override|customer_think|reset_before_fill|server_behind|post_send_clear|post_send_clear_gap|handoff_loop|handoff_atom_|series_done|loop_advance|loop_who_grasp|loop_task_list|dl:sort_|dl:sort_head_|dl:sort_panel_|dl:search_to_sort|dl:search_grasp_|dl:search_confirm_|dl:search_press_wait|dl:after_search|dl:search_armed|dl:search_customer_|dl:flow_atom_|dl:list_flow_|dl:next_flow_|dl:handoff_|dl:loop_handoff_grasp|dl:loop_phase_req|dl:pointer_cancel|dl:next_move_premature_block|dl:list_page_one_only|dl:list_no_next_advance|dl:all_sent_|dl:loop_advance|dl:loop_who_grasp|dl:handoff_grasp|dl:stale_grasp_drop|dl:legacy_blocked_no_screen|dl:screen_ok_path|dl:armed_wait_screen|dl:list_wait_screen|dl:pipeline_silence_|dl:timeout_bridge_|dl:send_bar_|dl:estate_stuck_|dl:bulk_alive|dl:panel_snap_|dl:page_display_|dl:page_displayed_|dl:sort_gate_need_page|dl:page_nav_|dl:nav_timing|page:(stuck_recover_retry|stuck_best_act|stuck_shot_req|screen_task_grasp|screen_poll_|pipeline_silence_|pipeline_screen_|timeout_bridge_|clear_watch_|clear_stuck_timeout|silence_watch_|silence_stuck_|silence_task_advance|silence_flush|stale_grasp_drop|foundation_gate|foundation_aim_warm|learn_warm|score_gate|strengthen_loop|strengthen_aim_rewarm|flow_subdivide_|search_results_ready|search_press_wait_results|search_press_baseline|page_display_|page_displayed_|page_nav_|toggle_repress|list_page_one_only|toggle_direct|hidden_wait_|fallback_|area_all_done|modal_confirm_fallback|human_search|fill_start|fill_begin|page_ver|switch_grasp|fee_skip|search_armed|search_customer_grasp_|search_grasp_reload_resume|search_grasp_|search_press_ok|leftover_|force_clear_place|station_clear_continue|station_clear_reopen_after|station_back_force_try|station_clear_cursor|station_clear_back|station_back_wrong|line_clear_after|ward_detail_skip|ward_btn_y_timeout|ward_clear_one_ng|ward_clear_one_done|ward_hidden_diag|clear_one_ng|clear_one_done|clear_field_ng|clear_field_done|clear_one_grasp|clear_field_grasp|station_clear_one_grasp|line_clear_one_grasp|station_clear_one_ng|line_clear_one_ng|clear_done|clear_then_fill_|one_task_|now_action|task_now|task_done|task_next|task_now|task_done|task_next|guide_task_link|task_transition_grasp|task_transition_gate|task_api_refresh|next_move_premature_block|clear_method_api_|clear_method_ledger|clear_method_ok|clear_method_gap|place_keep|place_redo|cursor_resume|pointer_cancel|post_send_cancel|post_send_clear|clear_cancelled|station_grasp_like_guide|station_route_from_map|station_no_route|guide_plan_linked|guide_plan_miss|guide_plan_act|station_primary_only|line_primary_only|guide_clear_|guide_clear_grasp|guide_fill_gate|guide_fill_fixed|guide_fill_still_gap|guide_phase_|guide_detail_ledger|flow_series_|list_handoff_seen|place_xor|location|place_mixed|place_side_clear|place_xor_plan|place_xor_gate|place_xor_miss|place_xor_violation|now_customer|next_customer_grasp|next_move_grasp|loop_phase_grasp|loop_who_grasp|loop_task_list|loop_advance)|sw_restart_restored|dl:ad_sort_reload|human_reset_press|human_reset_wait|quiet_on|quiet_off|quiet_defer|quiet_inherit|dl:quiet_|reset_clear_marks|tab_reload|tab_check|autofill_dead_kick)/;

  /**
   * ★ 2026-11-20 (2.8.145) 手順書の決まりの確かめ（app/lib/auto-procedure-rules.ts の verify）に使う段。
   *   実測 audit #1551（2.8.142・120段）: 先頭が落ちて page:playbook_seen・page:cursor_one・page:flow_done_place が消え、
   *   決まり playbook_read・one_cursor を「守れていない」と誤って数えた。
   *   → 普通の段より後に落とし、落とす時も同じ種類の段を最低1つ残す（同じ種類が後にもある物から落とす）。
   *   ⚠ 決まりの verify に段を足したらここにも足す（checkRulesInCode が食い違いを止める）。
   */
  // ★ 2.8.281 統括Pro通し点検: 外し（station_clear・ward_clear・line_clear）・dl:auto_force・次客の把握を、上限で最初に捨てる側から外す（重複だけ落とす側へ）
  var RULE_STEP = /^(fill_progress|bulk_phase|bulk_kick|bulk_done_resend|stale_prev_lock_dropped|switch_timeout|autofill_dead_kick|popup_fallback|kick_clamp|stale_done_skip|bulk_all_done|bulk_pos|reset_press|reset_wait|reset_verified|reset_shot|reset_not_empty|reset_fallback|ajax_settle|reset_clean_skip_clear|reset_count_same|dl:auto_force|dl:next_customer_grasp|dl:next_move_grasp|page:(station_clear_|ward_clear_|line_clear_|station_then_line_clear)|customer_think|reset_before_fill|server_behind|post_send_clear|post_send_clear_gap|handoff_loop|handoff_atom_|series_done|dl:sort_|dl:sort_head_|dl:sort_panel_|dl:search_to_sort|dl:search_grasp_|dl:search_confirm_|dl:search_press_wait|dl:after_search|dl:search_armed|dl:search_customer_|dl:flow_atom_|dl:list_flow_|dl:next_flow_|dl:handoff_|dl:next_move_premature_block|dl:list_page_one_only|dl:list_no_next_advance|dl:all_sent_|dl:loop_advance|dl:loop_who_grasp|dl:handoff_grasp|dl:stale_grasp_drop|dl:legacy_blocked_no_screen|dl:screen_ok_path|dl:armed_wait_screen|dl:list_wait_screen|dl:pipeline_silence_|dl:timeout_bridge_|dl:send_bar_|dl:estate_stuck_|dl:bulk_alive|dl:panel_snap_|dl:page_display_|dl:page_displayed_|dl:sort_gate_need_page|dl:page_nav_|dl:nav_timing|page:(stuck_recover_retry|stuck_best_act|stuck_shot_req|screen_task_grasp|screen_poll_|pipeline_silence_|pipeline_screen_|timeout_bridge_|clear_watch_|clear_stuck_timeout|silence_watch_|silence_stuck_|silence_task_advance|silence_flush|stale_grasp_drop|foundation_gate|foundation_aim_warm|learn_warm|score_gate|strengthen_loop|strengthen_aim_rewarm|flow_subdivide_|search_results_ready|search_press_wait_results|search_press_baseline|page_display_|page_displayed_|page_nav_|playbook_seen|list_page_one_only|playbook_none|playbook_behind|cursor_one|cursor_two|cursor_old|hidden_press|clear_stage|modal_confirm|confirm_press_ok|search_cursor|search_armed|search_customer_grasp_|search_grasp_reload_resume|search_grasp_|search_press_ok|flow_done_|flow_gap_|area_all_done|place_ready|conditions_ready|pet_panel_confirm|walk_seal_|ward_btn_y_|ward_detail_skip|next_step|ward_clear_one|clear_one|clear_field|station_clear_one|line_clear_one|clear_done|station_clear_continue|station_clear_reopen_after|station_back_force_try|station_clear_cursor|station_clear_back|station_back_wrong|line_clear_after|clear_then_fill_|one_task_|now_action|task_now|task_done|task_next|task_now|task_done|task_next|guide_task_link|task_transition_grasp|task_transition_gate|task_api_refresh|next_move_premature_block|clear_method_api_|clear_method_ledger|clear_method_ok|clear_method_gap|place_keep|place_redo|cursor_resume|pointer_cancel|post_send_wait|post_send_clear|station_grasp_like_guide|station_route_from_map|station_no_route|guide_plan_linked|guide_plan_miss|guide_plan_act|station_primary_only|line_primary_only|guide_clear_|guide_clear_grasp|guide_fill_gate|guide_fill_fixed|guide_fill_still_gap|guide_phase_|flow_series_|list_handoff_seen|place_xor|location|place_mixed|place_side_clear|place_xor_plan|place_xor_gate|place_xor_miss|place_xor_violation|now_customer|next_customer_grasp|next_move_grasp|loop_phase_grasp|loop_who_grasp|loop_task_list|loop_advance|cond_one_|fill_start|leftover_|force_clear_place|fee_skip)|loop_advance|loop_who_grasp|loop_task_list|dl:loop_handoff_grasp|dl:loop_phase_req|dl:pointer_cancel|dl:handoff_grasp|dl:task_transition_grasp|dl:guide_task_link|dl:list_flow_grasp|human_reset_press|human_reset_wait)/;

  function _stepKey(s) { return String((s && s.k) || ""); }

  /**
   * ★ 2.8.297 手順書が「反映されたか」を後から確かめる段（回の始まり・どの版か・手順書を読んだか・学習の反映）。
   *   実測 audit #1654: 同じ段（dl:sort_gate_wait_rows 等・約98件）が120段の上限を埋め、最後の手段の「先頭から落とす」で
   *   begin・bulk_pos・page_ver・playbook_seen が消え、check-playbook-reflect が「反映されていない」と誤って読んだ。
   *   → この段は最後の手段でも落とさない（回の途中の段から落とす）。
   */
  var PIN_STEP = /^(begin|bulk_pos|fill_done|page:(page_ver|playbook_|learn_reflect_|learn_refresh_))/;
  /** 待ち・間・見張りの繰り返し（同じ種類・同じ中身が続く時だけ n 回にまとめる）。押した・押せたの記録（reset_press 等）は数を残すのでまとめない */
  var COLLAPSE_STEP = /^(dl:|page:)[a-z0-9_]*(wait|gap|poll|watch|tick|rows)[a-z0-9_]*$/;

  // 段の記録（最大 MAX_STEPS 件）。落とす順: 普通の段 → 決まりの段の重複（後にも同じ種類がある物） → 残す段以外 → 守る段以外 → 先頭
  function pushStep(steps, k, d, now) {
    var list = Array.isArray(steps) ? steps : [];
    var kk = String(k).slice(0, 40);
    var dd = d == null ? null : String(d).slice(0, 160);
    var at = typeof now === "number" ? now : Date.now();
    /**
     * ★ 2.8.297 直前と同じ段（同じ種類・同じ中身）はまとめる（n 回・最後の時刻 to）。
     *   待ち（sort_gate_wait_rows 等）の繰り返しで上限が埋まり、肝心の段が落ちるのを防ぐ。
     *   ⚠ 守る段（begin・playbook_seen 等）はまとめない（1回ずつ時刻を残す）。
     */
    if (COLLAPSE_STEP.test(kk) && !PIN_STEP.test(kk)) {
      // 実測 #1654: 2種類の待ちが交互（A,B,A,B…・各49回・中身は同じ）に並んだ → 直前だけでなく、直近6段の中の同じ種類と比べる
      for (var b = list.length - 1, lim = Math.max(0, list.length - 6); b >= lim; b--) {
        var prev = list[b];
        if (prev && prev.k === kk) {
          if ((prev.d == null ? null : prev.d) === dd) {
            prev.n = (prev.n || 1) + 1;
            prev.to = at;
            return list;
          }
          break; // 同じ種類で中身が違う＝別の段として足す
        }
      }
    }
    list.push({ at: at, k: kk, d: dd });
    while (list.length > MAX_STEPS) {
      var drop = -1, i, key;
      for (i = 0; i < list.length && drop < 0; i++) {
        key = _stepKey(list[i]);
        if (!KEEP_STEP.test(key) && !RULE_STEP.test(key)) drop = i;
      }
      for (i = 0; i < list.length && drop < 0; i++) {
        key = _stepKey(list[i]);
        if (KEEP_STEP.test(key) || !RULE_STEP.test(key)) continue;
        for (var j = i + 1; j < list.length; j++) { if (_stepKey(list[j]) === key) { drop = i; break; } }
      }
      for (i = 0; i < list.length && drop < 0; i++) {
        key = _stepKey(list[i]);
        if (!KEEP_STEP.test(key) && !PIN_STEP.test(key)) drop = i;
      }
      // 残す段だけになった時も、守る段（begin・playbook_seen 等）は落とさず、守る段以外の一番古い段から落とす
      for (i = 0; i < list.length && drop < 0; i++) {
        if (!PIN_STEP.test(_stepKey(list[i]))) drop = i;
      }
      list.splice(drop < 0 ? 0 : drop, 1);
    }
    return list;
  }

  /**
   * ★ 2026-11-20 (2.8.143) 実測 audit #1552: 自動モード中に人が検索を押した回（page-script の human_ 印）は
   *   一覧の結果が来ないことがあり、6分後に idle_close（bad）で閉じて「止まった」と数えられていた。
   */
  function isHumanSearchAudit(audit, runId) {
    if (/^human_/.test(String(runId || ""))) return true;
    return !!(audit && audit.no_run_id === true && /^human_/.test(String(audit.local_run_id || "")));
  }

  /** 6分の閉じ処理: 人が押した検索で入力の誤りが無い回は「区切り」として閉じる（止まりにしない） */
  function softenIdleClose(run, extra) {
    if (!extra || extra.error_kind !== "idle_close") return { soft: false, extra: extra };
    if (run && run.human_search && !run.fill_error) {
      return { soft: true, extra: {}, note: "人が押した検索のあと結果の合図が来ないまま6分 → 区切りとして閉じる（止まりではない）" };
    }
    return { soft: false, extra: extra };
  }

  /**
   * ページの段を1回だけ足す。ページは積み上げた一覧を進捗のたびに丸ごと送るので、
   * そのまま足すと同じ段が重なり MAX_STEPS で後ろ（止まった所）が押し出される（2026-11-19 audit #1513）。
   */
  function pushPageStep(r, k, d, at) {
    if (!r._pageSeen || typeof r._pageSeen !== "object" || (r._pageSeenN || 0) > 1500) { r._pageSeen = {}; r._pageSeenN = 0; }
    var key = String(k).slice(0, 28) + "|" + String(at || "") + "|" + (d == null ? "" : String(d).slice(0, 60));
    if (r._pageSeen[key]) return;
    r._pageSeen[key] = 1;
    r._pageSeenN = (r._pageSeenN || 0) + 1;
    pushStep(r.steps, "page:" + String(k).slice(0, 28), d == null ? null : String(d).slice(0, 100), at || Date.now());
  }

  function byteLen(obj) {
    try { return JSON.stringify(obj).length; } catch (_) { return Infinity; }
  }

  // page-script の audit を 8KB に収める（見本・読み戻しの配列を短くしていく）
  function clampAudit(audit, maxBytes) {
    var lim = maxBytes || MAX_AUDIT_BYTES;
    if (!audit || typeof audit !== "object") return null;
    var a;
    try { a = JSON.parse(JSON.stringify(audit)); } catch (_) { return null; }
    if (byteLen(a) <= lim) return a;
    var caps = [12, 6, 3, 0];
    for (var ci = 0; ci < caps.length && byteLen(a) > lim; ci++) {
      var n = caps[ci];
      ["stations_missing", "lines_missing", "click_fails"].forEach(function (key) {
        if (!Array.isArray(a[key])) return;
        a[key] = a[key].slice(0, Math.max(n, 1)).map(function (m) {
          if (m && Array.isArray(m.sample)) m.sample = m.sample.slice(0, n);
          return m;
        });
      });
      if (a.form) {
        ["stations", "lines", "wards", "layouts"].forEach(function (key) {
          if (Array.isArray(a.form[key]) && a.form[key].length > n * 4) a.form[key] = a.form[key].slice(0, Math.max(n * 4, 4));
        });
      }
      if (Array.isArray(a.stations_ok) && a.stations_ok.length > n * 4) a.stations_ok = a.stations_ok.slice(0, Math.max(n * 4, 4));
      if (Array.isArray(a.steps)) a.steps = a.steps.slice(-Math.max(n * 2, 4));
      if (Array.isArray(a.ops)) a.ops = a.ops.slice(-Math.max(n * 3, 6));
      if (a.stall && a.stall.form) {
        ["stations", "lines", "wards", "layouts"].forEach(function (key) {
          if (Array.isArray(a.stall.form[key]) && a.stall.form[key].length > n) a.stall.form[key] = a.stall.form[key].slice(0, Math.max(n, 2));
        });
      }
    }
    if (byteLen(a) > lim) return { v: a.v || 1, truncated: true, search_clicked: a.search_clicked, area_path: a.area_path || null };
    a.truncated = true;
    return a;
  }

  // 件数表示の生の文字を探す（画面の文字全体から・純関数）。
  //   リアプロ・itandi の件数表示の場所（DOM の名前）は確かめていないので、文字の形で探し、生の文字をそのまま残す（点検で人が確かめられるように）
  function readCountText(text) {
    var s = String(text || "").normalize ? String(text || "").normalize("NFKC") : String(text || "");
    if (!s) return { text: null, number: null };
    var lines = s.split(/\n+/);
    var pats = [
      /(該当(?:する)?物件(?:は|が)?\s*(?:ありません|見つかりません|0\s*件))/,
      /(検索結果\s*[:：]?\s*([\d,]+)\s*件)/,
      /(該当\s*[:：]?\s*([\d,]+)\s*件)/,
      /(全\s*([\d,]+)\s*件)/,
      /(([\d,]+)\s*件中)/,
      /(([\d,]+)\s*件\s*(?:見つかりました|ヒット))/,
    ];
    for (var p = 0; p < pats.length; p++) {
      for (var i = 0; i < lines.length && i < 4000; i++) {
        var line = lines[i];
        if (line.length > 200) continue;
        var m = line.match(pats[p]);
        if (m) {
          var num = p === 0 ? 0 : Number(String(m[2] || "").replace(/,/g, ""));
          return { text: line.trim().slice(0, 80), number: isFinite(num) ? num : null };
        }
      }
    }
    return { text: null, number: null };
  }

  // 動作モード → mode の札（brain_normal / brain_staff / brain_aix）。ブレインでなければ null
  function modeLabel(state) {
    if (!state) return null;
    // 2026-11-11 竹内さん「AIXモードだとピンポイントで検索して物件なかったら広げて検索にするようになっているか」:
    //   AIX（選んだお客さんを自動で検索）はブレイン OFF でも点検を送るので、**AIX の時は brain が無くても札を付ける**
    //   （`aix_customer`）。広げて検索の判定（decideWiden）は mode が brain_staff の時だけ止める。
    if (state.mode === "ai") return "brain_aix";
    if (!state.brain) return null;
    return state.mode === "staff" ? "brain_staff" : state.mode === "aix" ? "brain_aix" : "brain_normal";
  }

  // 拡張の設定の automationApiKey（サーバーに AUTOMATION_API_KEY がある時の合言葉・background._automationHeaders と同じ）
  function automationKey() {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) { resolve(null); return; }
        chrome.storage.local.get(["automationApiKey"], function (st) { resolve((st && st.automationApiKey) || null); });
      } catch (_) { resolve(null); }
    });
  }

  // 送る（5秒で切る・失敗しても投げない）
  function post(body, opts) {
    var o = opts || {};
    var base = o.apiBase || API_BASE;
    var f = o.fetch || (typeof fetch !== "undefined" ? fetch : null);
    if (!f || !body || !body.run_id) return Promise.resolve({ ok: false, reason: "no-fetch-or-id" });
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, o.timeoutMs || SEND_TIMEOUT_MS) : null;
    try {
      var keyP = o.fetch ? Promise.resolve(null) : automationKey();
      return keyP.then(function (key) {
        var headers = { "Content-Type": "application/json" };
        if (key) headers["x-automation-key"] = key;
        return f(base + "/api/search-audits", {
          method: "POST",
          headers: headers,
          body: JSON.stringify(body),
          signal: ctrl ? ctrl.signal : undefined,
        });
      }).then(function (res) {
        if (timer) clearTimeout(timer);
        return { ok: !!(res && res.ok), status: res && res.status };
      }, function (e) {
        if (timer) clearTimeout(timer);
        return { ok: false, reason: String((e && e.message) || e) };
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      return Promise.resolve({ ok: false, reason: String((e && e.message) || e) });
    }
  }

  function siteKey(site) {
    var s = String(site || "").toLowerCase();
    if (s === "realnetpro" || s === "realpro" || s === "リアプロ") return "realpro";
    if (s === "itandi") return "itandi";
    if (s === "reins" || s === "レインズ") return "reins";
    return s || null;
  }

  /**
   * 1回ごとの記録（background.js が1つ持つ）。
   *   opts.post(body) … 送る関数（既定は上の post）
   *   opts.now()      … 時刻
   *   opts.extVersion … 拡張の版
   * begin で started を送り、fill / result を足し、finish で finished を1回だけ送る。
   */
  function createTracker(opts) {
    var o = opts || {};
    var send = o.post || function (b) { return post(b); };
    var now = o.now || function () { return Date.now(); };
    var runs = new Map();

    function sweepOld() {
      var t = now();
      runs.forEach(function (r, id) { if (t - r.started_at > 60 * 60 * 1000) runs.delete(id); });
    }

    function begin(ctx) {
      sweepOld();
      var id = ctx.run_id || newRunId(now());
      var run = {
        run_id: id,
        site: siteKey(ctx.site),
        property_customer_id: ctx.customer_id != null ? String(ctx.customer_id) : null,
        trigger: ctx.trigger || "single",
        mode: ctx.mode || null,
        command_id: ctx.command_id || null,
        // 2026-09-27: 渡されない時は null（分からない）。null は started／finished で送っても サーバーが欄を書かない
        //   （popup が started で入れた広げての値を finished の false で上書きしない）
        is_wide: ctx.is_wide == null ? null : !!ctx.is_wide,
        area_mode: ctx.area_mode || null,
        pass: ctx.pass || null,
        steps: [],
        started_at: now(),
        filled: null,
        result: null,
        finished: false,
      };
      pushStep(run.steps, "begin", run.trigger, now());
      // 2026-09-27 AIXツールのメモの検索の指示（その回だけの一時調整）で検索した回は、どの上書きかを残す
      //   （customer_snapshot は上書きを重ねた後の条件＝決定論の点検が「条件と違う」と誤って言わない。元の指示は _search_override に）
      var ovr = overrideForAudit(ctx.search_override);
      if (ovr) pushStep(run.steps, "search_override", JSON.stringify(ovr).slice(0, 400), now());
      runs.set(id, run);
      if (ctx.post_started !== false) {
        run._startedP = send({
          phase: "started", brain: true, run_id: id, site: run.site, mode: run.mode, trigger: run.trigger,
          property_customer_id: run.property_customer_id, command_id: run.command_id, is_wide: run.is_wide,
          area_mode: run.area_mode, pass: run.pass, ext_version: o.extVersion || null,
          customer_snapshot: ctx.customer ? withOverride(snapshotCustomer(ctx.customer), ovr) : null,
          intended: ctx.intended ? pickIntended(ctx.intended) : null,
        });
      }
      return run;
    }

    function get(id) { return id ? runs.get(id) || null : null; }

    // まだ終わっていない一番新しい回（お客様・サイトで探す）
    function findOpen(customerId, site) {
      var best = null;
      var sk = siteKey(site);
      runs.forEach(function (r) {
        if (r.finished) return;
        if (customerId != null && r.property_customer_id !== String(customerId)) return;
        if (sk && r.site && r.site !== sk) return;
        if (!best || r.started_at > best.started_at) best = r;
      });
      return best;
    }

    function step(id, k, d) {
      var r = get(id);
      if (r) pushStep(r.steps, k, d, now());
    }

    /** 同じサイトでまだ開いている「人が押した検索」の回（exceptId 以外）。次の回が始まったら区切りとして閉じる */
    function openHumanSearchRuns(site, exceptId) {
      var sk = siteKey(site);
      var out = [];
      runs.forEach(function (r) {
        if (r.finished || !r.human_search || r.run_id === exceptId) return;
        if (sk && r.site && r.site !== sk) return;
        out.push(r.run_id);
      });
      return out;
    }

    function attachFill(id, fill) {
      var r = get(id);
      if (!r) return null;
      if (isHumanSearchAudit(fill && fill.audit, r.run_id)) r.human_search = true;
      r.filled = fill && fill.audit ? clampAudit(fill.audit) : r.filled;
      if (fill && fill.error) r.fill_error = String(fill.error).slice(0, 300);
      pushStep(r.steps, "fill_done", fill && fill.error ? "error: " + String(fill.error).slice(0, 100) : "ok", now());
      if (r.filled && Array.isArray(r.filled.steps)) {
        r.filled.steps.forEach(function (s) { if (s && s.k) pushPageStep(r, s.k, s.d, s.at || now()); });
        delete r.filled.steps;
      }
      return r;
    }

    /**
     * ★ 2026-11-16 統括Pro「stepsが届いていない36回」:
     *   fill-done 前に途中の段を足す（完走前に止まっても「最後の段: none」を防ぐ）。
     */
    function attachProgress(id, steps) {
      var r = get(id);
      if (!r || r.finished) return null;
      var list = Array.isArray(steps) ? steps : [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s || !s.k) continue;
        pushPageStep(r, s.k, s.d, s.at || now());
      }
      /**
       * ★ 2026-11-20 (2.8.136) 実測 audit #1544: 120段のうち約45段が fill_progress で、検索の前後（一連の後半）が押し出されていた。
       *   → 進捗の印は最後の1つだけ残す（前の fill_progress を消してから足す）。
       */
      for (var fp = r.steps.length - 1; fp >= 0; fp--) {
        if (r.steps[fp] && r.steps[fp].k === "fill_progress") { r.steps.splice(fp, 1); break; }
      }
      pushStep(r.steps, "fill_progress", "n=" + list.length, now());
      /**
       * ★ 2026-11-17 連携: 途中段を DB の started 行へも書く（fill-done が来なくても none にしない）。
       *   3秒に1回まで（通信過多防止）。
       */
      try {
        if (!r._progDbAt) r._progDbAt = 0;
        if (now() - r._progDbAt >= 3000) {
          r._progDbAt = now();
          sendProgress(r);
        }
      } catch (_) {}
      return r;
    }

    /**
     * ★ 2.8.267 DB 実測 #1631（一括1人目・steps 0 のまま started）:
     *   started と progress を同時に投げると、行ができる前に progress が着いて no_row で捨てられる。
     *   → started の送信が終わってから progress を送る。
     */
    function sendProgress(r) {
      var go = function () {
        try { send({ phase: "progress", brain: true, run_id: r.run_id, site: r.site, mode: r.mode, steps: r.steps.slice(-40) }); } catch (_) {}
      };
      try {
        if (r._startedP && typeof r._startedP.then === "function") { r._startedP.then(go, go); return; }
      } catch (_) {}
      go();
    }

    /**
     * ★ 2.8.265: 今までの段を DB の started 行へすぐ書く（一括の段の切り替わり・止まる前の最後の段を残す）。1秒に1回まで。
     */
    function flush(id) {
      var r = get(id);
      if (!r || r.finished) return null;
      try {
        if (!r._flushAt) r._flushAt = 0;
        if (now() - r._flushAt < 1000) { flushSoon(id, 1000); return r; }
        r._flushAt = now();
        sendProgress(r);
      } catch (_) {}
      return r;
    }

    /**
     * ★ 2.8.267 DB 実測 #1631／#1633: 裏で足した段（前客の待ち・一覧／送付の dl: 段）は手元に溜まるだけで、
     *   回が閉じられないと DB に1段も残らなかった（一覧で4分詰まった記録が0段）。
     *   → 段を足したら delayMs 後にまとめて1回送る（同じ回の予約は1つだけ）。
     */
    function flushSoon(id, delayMs) {
      var r = get(id);
      if (!r || r.finished || r._soonT) return;
      try {
        r._soonT = setTimeout(function () {
          r._soonT = null;
          if (r.finished) return;
          r._flushAt = 0;
          flush(r.run_id);
        }, delayMs == null ? 3000 : delayMs);
      } catch (_) { r._soonT = null; }
    }

    function attachResult(id, result) {
      var r = get(id);
      if (!r) return null;
      // 2026-09-27 v2.5.31: bulk-dl の操作の時刻（結果を見た・並び替え・ページ・資料の送信の束）は段（steps）に "dl:" を付けて並べる
      var res = Object.assign({}, result || {});
      if (Array.isArray(res.timings)) {
        res.timings.forEach(function (s) { if (s && s.k) pushStep(r.steps, "dl:" + s.k, s.d, s.at || now()); });
      }
      delete res.timings;
      result = res;
      r.result = Object.assign({}, r.result || {}, result || {});
      pushStep(r.steps, "result", "rows=" + (result && result.read_rows) + " sent=" + (result && result.sent_count), now());
      return r;
    }

    function finish(id, extra) {
      var r = get(id);
      if (!r || r.finished) return Promise.resolve({ ok: false, reason: r ? "already" : "unknown" });
      r.finished = true;
      var x = extra || {};
      if (x.result) r.result = Object.assign({}, r.result || {}, x.result);
      var err = x.error || r.fill_error || null;
      pushStep(r.steps, "finish", err ? "error" : "ok", now());
      var body = {
        phase: "finished", brain: true, run_id: r.run_id, site: r.site, mode: r.mode, trigger: r.trigger,
        property_customer_id: r.property_customer_id, command_id: r.command_id, is_wide: r.is_wide, area_mode: r.area_mode, pass: r.pass,
        ext_version: o.extVersion || null,
        filled: r.filled, steps: r.steps.slice(-MAX_STEPS), result: r.result,
        error: err ? String(err).slice(0, 500) : null, error_kind: x.error_kind || null, page_url: x.page_url || (r.result && r.result.url) || null,
      };
      runs.delete(r.run_id);
      return send(body);
    }

    /**
     * ★ 2.8.293 DB 実測 #1651（2026-11-25 18:05 一括・てんさん）: 開始の5段だけで started のまま、
     *   物件の取得は 18:18 まで続いたのに、並べ替え・取得の段が1つも残らなかった。
     *   回はこの Service Worker のメモリにだけあり、起き直すと消え、後から届いた段は全部捨てられていた。
     *   → 開いている回を書き出して（exportOpen）、起き直した時に戻す（adopt）。
     *   ⚠ 戻すのは1時間以内の回だけ（sweepOld と同じ）。送信中の紐・タイマーは持ち越さない。
     */
    function exportOpen() {
      var out = [];
      runs.forEach(function (r) {
        if (!r || r.finished) return;
        out.push({
          run_id: r.run_id, site: r.site, property_customer_id: r.property_customer_id, trigger: r.trigger,
          mode: r.mode, command_id: r.command_id, is_wide: r.is_wide, area_mode: r.area_mode, pass: r.pass,
          steps: (r.steps || []).slice(-MAX_STEPS), started_at: r.started_at, filled: r.filled || null,
          result: r.result || null, human_search: !!r.human_search, fill_error: r.fill_error || null,
        });
      });
      return out;
    }

    function adopt(saved) {
      if (!saved || typeof saved !== "object" || !saved.run_id) return null;
      if (runs.has(saved.run_id)) return null;
      var started = Number(saved.started_at) || 0;
      if (!started || now() - started > 60 * 60 * 1000) return null;
      var run = {
        run_id: String(saved.run_id), site: saved.site || null,
        property_customer_id: saved.property_customer_id != null ? String(saved.property_customer_id) : null,
        trigger: saved.trigger || "single", mode: saved.mode || null, command_id: saved.command_id || null,
        is_wide: saved.is_wide == null ? null : !!saved.is_wide, area_mode: saved.area_mode || null, pass: saved.pass || null,
        steps: Array.isArray(saved.steps) ? saved.steps.slice(-MAX_STEPS) : [],
        started_at: started, filled: saved.filled || null, result: saved.result || null, finished: false,
      };
      if (saved.human_search) run.human_search = true;
      if (saved.fill_error) run.fill_error = String(saved.fill_error).slice(0, 300);
      runs.set(run.run_id, run);
      return run;
    }

    return { begin: begin, get: get, findOpen: findOpen, step: step, openHumanSearchRuns: openHumanSearchRuns, attachFill: attachFill, attachProgress: attachProgress, flush: flush, flushSoon: flushSoon, attachResult: attachResult, finish: finish, exportOpen: exportOpen, adopt: adopt, _runs: runs };
  }

  return {
    API_BASE: API_BASE,
    SEND_TIMEOUT_MS: SEND_TIMEOUT_MS,
    MAX_STEPS: MAX_STEPS,
    MAX_AUDIT_BYTES: MAX_AUDIT_BYTES,
    STATION_NAMES_MAX: STATION_NAMES_MAX,
    SNAPSHOT_FIELDS: SNAPSHOT_FIELDS,
    newRunId: newRunId,
    SWITCH_DUP_WINDOW_MS: SWITCH_DUP_WINDOW_MS, switchKey: switchKey, isDuplicateSwitch: isDuplicateSwitch,
    maskDigits: maskDigits,
    snapshotCustomer: snapshotCustomer,
    pickIntended: pickIntended,
    pushStep: pushStep,
    KEEP_STEP: KEEP_STEP,
    RULE_STEP: RULE_STEP,
    isHumanSearchAudit: isHumanSearchAudit,
    softenIdleClose: softenIdleClose,
    clampAudit: clampAudit,
    readCountText: readCountText,
    modeLabel: modeLabel,
    siteKey: siteKey,
    post: post,
    createTracker: createTracker,
  };
});
