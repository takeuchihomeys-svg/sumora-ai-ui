/**
 * 自動モード弱点の細分化（2026-11-16）
 *
 * ★ 竹内さん「今弱い部分もこの画像分析で改善／連携して強化／細かく細分化／
 *   弱点は統括Proが判断して細かく改善／完全に人間の動き／変なバグも細かく改善」:
 *
 *   決定論で弱点を原子に分け、Pro が「どの原子から直すか」を判断する材料にする。
 *   画像flashが読む → 材料 → Proが原子単位で次手 → 拡張が人間らしく動く。
 */

export type WeakAtom = {
  /** 原子ID（再現に使える短い鍵） */
  id: string;
  /** 人間向け名 */
  name: string;
  /** いまの度（分かれば） */
  score?: number | null;
  /** 目標 */
  need?: number | null;
  /** どの層で直すか */
  layer: "flash" | "bundle" | "extension" | "human" | "pro";
  /** 次手（1行） */
  next: string;
};

/** 統括の根拠行から弱点原子を抜く（推測で埋めない・取れない物は出さない） */
export function atomsFromEvidence(
  evidence: Array<{ label?: string; value?: string }> | null | undefined,
): WeakAtom[] {
  const ev = Array.isArray(evidence) ? evidence : [];
  const val = (re: RegExp) => {
    const hit = ev.find((e) => re.test(String(e.label || "")));
    return hit ? String(hit.value || "") : "";
  };
  const out: WeakAtom[] = [];

  const human = val(/自動モードの人間らしさ|人間らしさの再現/);
  const mCursor = human.match(/カーソル\s*(\d+)/);
  const mPoint = human.match(/押した位置\s*(\d+)/);
  const hand0 = /手の形\s*0|手の形なし|⚠ 手の形/.test(human) || /手の形なし/.test(val(/人間らしさの再現|通常録画→完全再現/));
  if (mCursor) {
    const s = Number(mCursor[1]);
    out.push({
      id: "cursor_pct",
      name: "カーソル記録%",
      score: s,
      need: 70,
      layer: s < 70 ? "extension" : "bundle",
      next: s < 70 ? "押しは必ずカーソル経由（直click禁止）・束のaimを使う" : "維持",
    });
  }
  if (mPoint) {
    const s = Number(mPoint[1]);
    out.push({
      id: "point_pct",
      name: "押した位置記録%",
      score: s,
      need: 60,
      layer: s < 60 ? "flash" : "bundle",
      next: s < 60 ? "通常画像から位置をflashで読む→aim自動引き→押し後に録画へ残す" : "維持",
    });
  }
  if (hand0) {
    out.push({
      id: "hand_cs",
      name: "手の形(cs=pointer)",
      score: 0,
      need: 1,
      layer: "human",
      next: "通常モードでボタン1回録画（cs=pointer）",
    });
  }

  const prec = val(/精度|欄×観点|細かく学ぶ/);
  const weakNames = [
    { re: /route_id\[\]/, id: "route_id", name: "route_id[]（沿線）" },
    { re: /city_code\[\]|区を選ぶ/, id: "city_code", name: "区・city_code[]" },
    { re: /確定してリスト/, id: "confirm_list", name: "確定してリストへ" },
    { re: /rental_cost2|賃料/, id: "rental_cost2", name: "賃料(rental_cost2)" },
    { re: /required_time|徒歩/, id: "required_time", name: "徒歩(required_time)" },
    { re: /transportation_id|移動手段/, id: "transportation_id", name: "移動手段" },
    { re: /structured_date|築年/, id: "structured_date", name: "築年" },
    { re: /update_date|更新日/, id: "update_date", name: "更新日" },
    { re: /room_layout/, id: "room_layout", name: "間取り" },
  ];
  for (const w of weakNames) {
    if (!w.re.test(prec) && !w.re.test(val(/弱い部分|自動モードの最新課題|足りない土台/))) continue;
    out.push({
      id: "field:" + w.id,
      name: w.name,
      layer: "flash",
      next: "通常画像flashで位置・種類・押し方を読む→束→拡張がカーソルで押す",
    });
  }

  const link = val(/学習→自動の連携|連携のボトルネック|改善までの一連/);
  if (/自動で使う|段階5|read_count=0|拡張が束/.test(link) || /自動走行がまだ無い/.test(link)) {
    out.push({
      id: "link_auto",
      name: "学習→自動の一連",
      layer: "human",
      next: /read_count=0|拡張が束未読|段階4/.test(link)
        ? "拡張再読込（最新束）→自動1回"
        : "自動モードで1回検索→効果を数字で確認",
    });
  }

  const unmatched = val(/通常モードの画像×押した位置|画像にあるが押していない/);
  const mImg = unmatched.match(/画像にあるが押していない\s*(\d+)/) || val(/通常録画→完全再現/).match(/画像にあるが押していない\s*(\d+)/);
  if (mImg && Number(mImg[1]) > 0) {
    out.push({
      id: "image_unpressed",
      name: "画像にあるが押していない欄",
      score: Number(mImg[1]),
      layer: "flash",
      next: "画像位置→要素探索（_screenAimOf）で自動も押せるようにする",
    });
  }

  // 変バグの見張り（DB根拠がある物だけ）
  if (/押さず|直書き|typedOnChoose|選ぶ欄に打ち/.test(human + prec + val(/足りない土台/))) {
    out.push({
      id: "bug_direct_write",
      name: "直書き／押さず変化",
      layer: "extension",
      next: "value代入禁止・chooseSelectLikeHuman／カーソル→開く→選ぶ",
    });
  }
  if (/外し\/選びが区別できない|unknown\s*\d+/.test(val(/押した操作の中身|足りない土台|土台の細分化/))) {
    out.push({
      id: "bug_toggle_unknown",
      name: "区の外し/選びが区別できない",
      layer: "extension",
      next: "was/now を録画に残す・くれあ型の外しを学ぶ",
    });
  }

  /**
   * ★ 2026-11-16 KAORI→他客: 現場の誤りを型として常時監視（1客の直しで終わらせない）。
   *   根拠が関連語を含む時だけ出す（推測で埋めない）。
   */
  const rootBlob =
    human + prec + link + unmatched +
    val(/足りない土台|変バグ|弱点|通常録画|改善までの一連|現場/);
  if (/沿線|route_id|駅.*1|途中で次|early|複数.*進/.test(rootBlob)) {
    out.push({
      id: "bug_early_multi",
      name: "複数選択の途中で次へ進む",
      layer: "extension",
      next: "want.every（全部checked）まで次段に進まない・他客でも同じ",
    });
  }
  if (/ペット|絞り込み条件|eq_rm|畳|直接入力|見えない.*click/.test(rootBlob)) {
    out.push({
      id: "bug_collapsed_direct",
      name: "畳み欄を開かず直押し／直接入力",
      layer: "extension",
      next: "絞り込み条件＋等を開いてから選択（_ensureFieldVisible）・カーソル経由",
    });
  }
  if (/見切れ|築年|structured_date|画面外|スクロール/.test(rootBlob)) {
    out.push({
      id: "bug_select_offscreen",
      name: "見切れ位置でSELECTを選ぶ",
      layer: "extension",
      next: "SELECTはscrollIntoView centerしてから選ぶ",
    });
  }
  if (/プルダウン|上下逆|fake.?dd|一覧の位置/.test(rootBlob)) {
    out.push({
      id: "bug_dropdown_flip",
      name: "プルダウン一覧の上下位置ずれ",
      layer: "extension",
      next: "下余白不足なら一覧を上に出す（並びは上→下のまま）",
    });
  }
  if (/カーソル\s*\d+|直click|aim|押した位置/.test(rootBlob)) {
    out.push({
      id: "bug_cursor_no_aim",
      name: "カーソル無aim／直click残",
      layer: "extension",
      next: "enqueueはaim自動引き・押しは_humanPointerClick必須・学んだ位置を使う",
    });
  }

  // ★ 2026-11-16: 完了→次客を原子に細分化（統括Proが把握）
  const handoff = val(/完了→次客|一連ロック|pipeline_busy|次客/);
  if (handoff) {
    const pairs: Array<{ re: RegExp; id: string; name: string; next: string }> = [
      { re: /次客切替失敗|switch_fail/, id: "handoff_switch", name: "次客切替失敗", next: "一連ロック解除を待ってから switch・pipeline_busy なら強制解除して再送" },
      { re: /送る相手不一致|owner_mismatch/, id: "handoff_owner", name: "送る相手不一致", next: "一連中は送る相手を上書きしない・fillにcustomerIdを載せる" },
      { re: /入力開始なし|no_fill_start/, id: "handoff_nofill", name: "条件入力が始まらない", next: "fill-started待ちとタブ健全性を直し、ロック解除してから次へ" },
      { re: /送付完了待ち切れ|batch_timeout/, id: "handoff_batch", name: "送付完了待ち切れ", next: "batch-done/timeout の両方で一連ロックを外してから次客へ" },
      { re: /一連ロック拒否|pipeline_busy/, id: "handoff_busy", name: "一連ロック拒否", next: "storageを正として再判定・bgが解除完了をawait" },
      { re: /強制ページ更新|tab_reload/, id: "handoff_reload", name: "強制ページ更新", next: "別客fill中は reload_skip・fillRunning を見てから更新" },
      { re: /完了理解不足|flow_handoff_gap/, id: "handoff_flow_gap", name: "完了理解不足", next: "flow_done_place〜ready_next が揃うまで次客へ渡さない" },
    ];
    let any = false;
    for (const p of pairs) {
      if (!p.re.test(handoff)) continue;
      any = true;
      out.push({ id: p.id, name: p.name, layer: "extension", next: p.next });
    }
    if (!any && /異常|回/.test(handoff)) {
      out.push({
        id: "handoff_generic",
        name: "完了→次客",
        layer: "extension",
        next: "search_audits の switch_fail / owner_mismatch を見て原子ごとに直す",
      });
    }
  }

  // ★ 2026-11-17 F45: 完了理解台帳の抜け
  const flow = val(/完了理解|流れ台帳|flow_done_|flow_gap_|一連完了|次客へ渡してよい/);
  if (flow) {
    const pairs: Array<{ re: RegExp; id: string; name: string; next: string }> = [
      { re: /未完了あり|flow_gap_|印なし/, id: "flow_gap", name: "一連の完了印が欠けている", next: "2.8.80で place→conditions→search→fill_done→ready_next を1つずつ残す" },
      { re: /場所完了|place/, id: "flow_place", name: "場所段の完了理解", next: "place_ready と flow_done_place が同時に残るか確認" },
      { re: /検索完了|search/, id: "flow_search", name: "検索段の完了理解", next: "search_press_ok と flow_done_search が残るか確認" },
    ];
    let any = false;
    for (const p of pairs) {
      if (!p.re.test(flow)) continue;
      any = true;
      out.push({ id: p.id, name: p.name, layer: "extension", next: p.next });
    }
    if (!any) {
      out.push({
        id: "flow_generic",
        name: "完了理解",
        layer: "extension",
        next: "flow_understand_ledger と series_done を監査で確認",
      });
    }
  }

  return out.slice(0, 16);
}

/** Pro / evidence 用の短い一覧行 */
export function atomsLine(atoms: WeakAtom[]): string {
  if (!atoms.length) return "弱点原子なし（根拠不足）";
  return atoms
    .map((a, i) => `${i + 1}.${a.name}${a.score != null ? `(${a.score}${a.need != null ? "/" + a.need : ""})` : ""}→${a.layer}:${a.next}`)
    .join(" ／ ");
}
