/**
 * 自動録画から「問題・足りない土台・強化に必要」を細部で出す（2026-11-17 統括Pro）
 *
 *   竹内さん「自動モードの録画を送っていけば何が問題で何が土台として足りないのか
 *     何が強化にあたって必要なのか細部を見つけて強化できるように仕組み化」
 *
 * ★ 入力は監査 steps / 関所 / human_like の実数字だけ。推測で弱点を作らない。
 * ⚠ 純関数。
 */

export type DiagnoseAtom = {
  id: string;
  /** 何が問題か */
  problem: string;
  /** 足りない土台（F番号や仕組み名） */
  missing_foundation: string;
  /** 強化に必要な次手 */
  need: string;
  /** free | ext | flash | human */
  cost: "free" | "ext" | "flash" | "human";
  evidence?: string;
};

export type AutoRecDiagnose = {
  atoms: DiagnoseAtom[];
  line: string;
  /** 地域↔駅 */
  place: {
    mixed: boolean;
    clear_miss: boolean;
    mode: string | null;
    by: string | null;
  };
};

export type DiagnoseInput = {
  steps?: Array<{ k?: string; m?: string; d?: string | null } | string> | null;
  gate?: {
    extraStation?: boolean;
    extraWard?: boolean;
    placeMixed?: boolean;
    area_ok_by?: string | null;
    areaMode?: string | null;
    errors?: string[];
  } | null;
  humanLike?: {
    withPoint?: number;
    withCursor?: number;
    rows?: number;
    changedWithoutClick?: number;
  } | null;
  aimAri?: number | null;
  aimNashi?: number | null;
  learnWarmN?: number | null;
  visionPhotoOk?: boolean | null;
};

function stepText(s: { k?: string; m?: string; d?: string | null } | string): string {
  if (typeof s === "string") return s;
  return [s.k, s.m, s.d].filter(Boolean).join(" ");
}

/**
 * 自動録画・関所・印から診断原子を出す。
 */
export function diagnoseAutoRecording(inp: DiagnoseInput): AutoRecDiagnose {
  const atoms: DiagnoseAtom[] = [];
  const push = (a: DiagnoseAtom) => {
    if (atoms.some((x) => x.id === a.id)) return;
    atoms.push(a);
  };

  const steps = Array.isArray(inp.steps) ? inp.steps : [];
  const joined = steps.map(stepText).join("\n");
  const gate = inp.gate || {};
  const hl = inp.humanLike;
  const pointPct = hl && hl.rows ? Math.round(((hl.withPoint || 0) / hl.rows) * 100) : null;
  const cursorPct = hl && hl.rows ? Math.round(((hl.withCursor || 0) / hl.rows) * 100) : null;
  const aimAri = Number(inp.aimAri) || 0;
  const aimNashi = Number(inp.aimNashi) || 0;
  const warmN = Number(inp.learnWarmN) || 0;

  const mixed =
    gate.placeMixed === true
    || gate.area_ok_by === "both"
    || (gate.extraStation === true && gate.extraWard === true)
    || /place_mixed|AREA_MIX|地域と駅が同時|area_ok_by=both/.test(joined);
  const clearMiss =
    gate.extraStation === true
    || gate.extraWard === true
    || /extraStation|extraWard|外し忘れ|gate_station_defer|place_side_clear/.test(joined)
    || /所在地検索なのに駅|駅・沿線検索なのに所在地/.test((gate.errors || []).join(" "));

  // ── 地域 ↔ 駅 ──
  if (mixed) {
    push({
      id: "place_xor_mixed",
      problem: "地域と駅が同時に入っている（検索が壊れる）",
      missing_foundation: "F52_place_xor（どちらか一方の関所）",
      need: "area_modeに従い反対側を外してから検索。both を許可しない",
      cost: "ext",
      evidence: gate.area_ok_by || "both",
    });
  }
  if (clearMiss && !mixed) {
    push({
      id: "place_clear_miss",
      problem: gate.extraStation
        ? "所在地検索なのに駅・沿線が残っている（外し忘れ）"
        : "駅検索なのに所在地が残っている（外し忘れ）",
      missing_foundation: "F30/F44系・place_side_clear の完走",
      need: "検索前に反対側をカーソルで外す（setCheckboxes空の直外し禁止は駅側）",
      cost: "ext",
      evidence: (gate.errors || []).slice(0, 2).join("／"),
    });
  }
  if (/日本橋|駅\/地域|station_area|誤判定/.test(joined)) {
    push({
      id: "place_token_kind",
      problem: "語の種別（駅か地域か）が取り違えられている疑い",
      missing_foundation: "FB駅/地域誤判定の構造化＋area_mode正本",
      need: "フィードバックで『あるべき＝駅|地域』と語を残し、マップ/判定を直す",
      cost: "human",
    });
  }

  // ── 押す・aim・warm ──
  if (aimNashi > 0 && aimAri === 0) {
    push({
      id: "aim_all_miss",
      problem: `aim無ばかり（有${aimAri}/無${aimNashi}）`,
      missing_foundation: "F15/F16 learn_warm→aim",
      need: "束再取得→learn_warm→押し直前にaim再引き",
      cost: "ext",
    });
  }
  if (warmN < 1 && /fill_start|cursor_aim/.test(joined)) {
    push({
      id: "learn_warm_missing",
      problem: "learn_warm印が無いのに押しが進んでいる",
      missing_foundation: "F16_learn_warm",
      need: "fill先頭の反映関所で warm を必ず残す",
      cost: "ext",
    });
  }
  if (pointPct != null && pointPct < 60) {
    push({
      id: "point_pct_low",
      problem: `押した位置${pointPct}%（要≥60）`,
      missing_foundation: "F51 aim_press_record・_fireAt→axlx-rec-point",
      need: "拡張≥2.8.86再読込→自動1回で point_fields を残す",
      cost: "ext",
    });
  }
  if (cursorPct != null && cursorPct < 70) {
    push({
      id: "cursor_low",
      problem: `カーソル${cursorPct}%（要≥70）`,
      missing_foundation: "F27 op_path・_humanPointerClick",
      need: "直click禁止・カーソル経由必須",
      cost: "ext",
    });
  }
  if ((hl?.changedWithoutClick || 0) > 0) {
    push({
      id: "direct_write",
      problem: `押さず変化${hl!.changedWithoutClick}件`,
      missing_foundation: "直書き禁止土台",
      need: "chooseSelectLikeHuman / カーソル→開く→押す",
      cost: "ext",
    });
  }

  // ── 間取り部分完了・物件取得・検索生存（HONOKA 2026-11-18）──
  if (/layout_grasp_partial|layout_pre_search_miss|間取りが足りない|need_select_more/.test(joined)) {
    push({
      id: "layout_partial",
      problem: "間取りが一部だけ入ったのに完了扱い／検索へ進んだ",
      missing_foundation: "layout全hit関所（missingWant＋layout_pre_search）",
      need: "欲しい間取りが全部 check されるまで conditions_ready / 検索しない",
      cost: "ext",
    });
  }
  if (/blocked_need_fill_done|search_armed|pagehide生存|status=started|fill_done_gap/.test(joined)
    || (/物件取得|Case C|pending/.test(joined) && /無し|失敗|不発|started/.test(joined))) {
    push({
      id: "property_path_break",
      problem: "検索後に物件取得が始まらない（fill-done/pending切れ）",
      missing_foundation: "axlx-search-armed→axlx_pending_auto_send→Case C",
      need: "検索click直前に生存印。リロード後も Case C でPDF押し",
      cost: "ext",
    });
  }
  if (/all-filtered|all_sent|送付済みで飛ば|acq_all_sent|送付済除外/.test(joined)
    && /詰ま|止ま|失敗|started|進まない/.test(joined)) {
    push({
      id: "sent_stuck_misread",
      problem: "送付済みを『詰まり』と誤認している／次へ進めていない",
      missing_foundation: "送付済み把握台帳（acq_sent_*／all_sent→次頁）",
      need: "送付済み＝送ったと把握。飛ばしを数え、未送付／次頁／客完了へ進む",
      cost: "ext",
    });
  }
  if (/送付済み/.test(joined) && !/把握|sent_marked|sent_loaded|acq_sent/.test(joined)) {
    push({
      id: "sent_ungrasped",
      problem: "送付済み行があるのに把握印が無い",
      missing_foundation: "sent_loaded→sent_marked→filter の把握",
      need: "DB送付済を読み画面印を付け、把握してからPDF押し",
      cost: "ext",
    });
  }
  if (/in_view.:false|画面外aim|search_press.*in_view/.test(joined)) {
    push({
      id: "search_offscreen",
      problem: "検索ボタン／カーソルが画面外",
      missing_foundation: "検索前スクロール＋画面外aim破棄",
      need: "再スクロール後に再測、外れていれば欄中央",
      cost: "ext",
    });
  }

  // ── 写真・統括材料 ──
  if (inp.visionPhotoOk === false) {
    push({
      id: "vision_photo",
      problem: "写真が統括に届いていない（vision段1）",
      missing_foundation: "F49_vision_photo_reach",
      need: "本番デプロイ→束再生成→photo_in_storage>0",
      cost: "free",
    });
  }

  const place = {
    mixed,
    clear_miss: clearMiss,
    mode: gate.areaMode || null,
    by: gate.area_ok_by || null,
  };

  const line = atoms.length
    ? `診断${atoms.length}件: ` + atoms.slice(0, 4).map((a) => a.problem).join("／")
    : "診断: 大きな弱所原子なし（印の範囲）";

  return { atoms: atoms.slice(0, 12), line, place };
}
