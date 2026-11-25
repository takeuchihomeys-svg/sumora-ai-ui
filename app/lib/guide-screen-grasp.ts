/**
 * 手順書×画面照会の段ごと完了線（2026-11-22）
 *
 * ★ なぜ細部まで改善できていなかったか:
 *   1. 「コードを入れた／検索まで印あり」で改善完了とみなし、一覧・並べ替え・次の段の
 *      **本番監査実証**を完了線にしていなかった
 *   2. 印が途中で消える穴（staff早期クローズ・live印未配線）を測る土台が無かった
 *   3. 駅後は経路依存なのに、未実証と「欠け」を区別できていなかった
 *
 * → 段ごとに required / when_station / when_list を定義し、監査 steps で測る。
 *   コード配線だけでは ok にしない。本番の印が揃って初めて完了。
 */

export type GuideGraspNeed = "always" | "when_station" | "when_area" | "when_list" | "when_clear";

export type GuideGraspPhaseDef = {
  id: string;
  label: string;
  need: GuideGraspNeed;
  /** 監査 steps の k に当たる正規表現 */
  re: RegExp;
};

/** 手順書 flow_series と揃えた段（正本） */
export const GUIDE_SCREEN_PHASES: GuideGraspPhaseDef[] = [
  { id: "after_clear", label: "外し後", need: "when_clear", re: /guide_phase_after_clear|flow_series_.*after_clear/ },
  { id: "after_confirm", label: "確定後", need: "always", re: /guide_phase_after_confirm|flow_series_.*after_confirm/ },
  { id: "after_station", label: "駅後", need: "when_station", re: /guide_phase_after_station|flow_series_.*after_station|guide_phase_station_skip/ },
  { id: "after_area", label: "地域後", need: "when_area", re: /guide_phase_after_area|flow_series_.*after_area|guide_phase_area_skip/ },
  { id: "after_place", label: "場所後", need: "always", re: /guide_phase_ok[^\n|]*after_place|flow_series_[^\n|]*after_place|page:guide_phase_after_place|guide_phase_after_place(?![^\n|]*guide_plan_miss\b)/ },
  { id: "before_search", label: "検索前", need: "always", re: /guide_phase_ok[^\n|]*before_search|flow_series_[^\n|]*before_search|page:guide_phase_before_search|guide_phase_before_search(?![^\n|]*guide_plan_miss\b)/ },
  { id: "after_search", label: "検索後", need: "always", re: /guide_phase_after_search|flow_series_[^\n|]*after_search|dl:after_search|page:guide_phase_after_search|page:flow_series_(?:at|ok)[^\n|]*after_search|search_customer_grasp_ok|guide_phase_after_search_screen/ },
  { id: "list", label: "一覧", need: "when_list", re: /list_flow|dl:list_flow|flow_series_.*\blist\b|dl:flow_atom_ok_after_search_rows/ },
  /** 検索把握→人間待ち→並べ替えカーソル開始（待ち予約だけでは未完・go か menu が要る） */
  { id: "search_to_sort", label: "検索→並べ替え", need: "when_list", re: /search_to_sort|dl:search_to_sort|dl:sort_cursor_go|dl:flow_atom_ok_sort_cursor/ },
  /** 並べ替え本体（cursor_wait だけでは完了にしない） */
  { id: "sort", label: "並べ替えAD高低", need: "when_list", re: /dl:sort_menu|dl:sort_head|dl:sort_ad|dl:sort_hilo|dl:sort_done|sort_hilo|sort_ad_hover|sort_head_hover/ },
  /** 次頁は次ボタンがある回だけ必須にすると測りにくい → 一覧経路では任意だが印があれば加点（完了線は list+sort） */
  { id: "next", label: "次頁", need: "when_list", re: /next_flow|before_next|after_next|dl:next_flow/ },
  /** 次客渡しは連続時の印。欠でも単発の完了は落とさない（任意） */
  { id: "handoff", label: "次客渡し", need: "when_clear", re: /handoff|list_handoff|dl:handoff|series_done|flow_handoff/ },
];

export type GuideGraspPhaseResult = {
  id: string;
  label: string;
  need: GuideGraspNeed;
  required: boolean;
  hit: boolean;
  status: "ok" | "miss" | "na";
};

export type GuideScreenGraspAudit = {
  ok: boolean;
  /** 必須のうち揃った数 */
  done: number;
  /** 必須の数 */
  total: number;
  missing: string[];
  phases: GuideGraspPhaseResult[];
  path: { wantStation: boolean; wantList: boolean };
  line: string;
  next: string;
  /** 改善完了と言ってよいか（コード配線だけでは不可） */
  improve_complete: boolean;
};

function stepKeys(steps: unknown[]): string[] {
  return (Array.isArray(steps) ? steps : []).map((s) => {
    if (typeof s === "string") return s;
    const o = s as { k?: string; d?: string };
    return `${o.k || ""} ${o.d || ""}`;
  });
}

/** 監査1本から経路を推定 */
export function inferGuideGraspPath(steps: unknown[]): {
  wantStation: boolean;
  wantArea: boolean;
  wantList: boolean;
  wantClear: boolean;
} {
  const keys = stepKeys(steps);
  const joined = keys.join("|");
  // ⚠ 外し原子の station_* や ward_* で誤検知しない（guide_phase 印だけを正本）
  const wantStation = /guide_phase_after_station|guide_phase_station_skip|flow_series_[^\s]*after_station/.test(joined);
  const wantArea = /guide_phase_after_area|guide_phase_area_skip|flow_series_[^\s]*after_area/.test(joined);
  // 検索後把握があれば一覧＋並べ替えが必須（次頁・handoff は任意）
  const wantList = /guide_phase_after_search|dl:after_search|dl:search_to_sort|dl:list_flow|dl:sort_|page:guide_phase_after_search/.test(joined);
  const wantClear = /guide_phase_after_clear|flow_series_[^\s]*after_clear/.test(joined);
  return { wantStation, wantArea, wantList, wantClear };
}

/**
 * 純関数: 1監査の steps から手順書×画面照会の完了を測る。
 * コードがあるだけでは ok にしない。印が必須段に揃って初めて improve_complete。
 *
 * 完了線（一覧経路）:
 *   確定後・（駅後|地域後）・場所後・検索前・検索後・一覧・検索→並べ替え・並べ替え
 * 次頁は任意（印があれば done に含むが欠でも完了を落とさない）。
 */
export function auditGuideScreenGrasp(opt: {
  steps?: unknown[];
  wantStation?: boolean;
  wantArea?: boolean;
  wantList?: boolean;
  wantClear?: boolean;
}): GuideScreenGraspAudit {
  const keys = stepKeys(opt.steps || []);
  const inferred = inferGuideGraspPath(opt.steps || []);
  const wantStation = opt.wantStation != null ? !!opt.wantStation : inferred.wantStation;
  const wantArea = opt.wantArea != null ? !!opt.wantArea : inferred.wantArea;
  const wantList = opt.wantList != null ? !!opt.wantList : inferred.wantList;
  const wantClear = opt.wantClear != null ? !!opt.wantClear : inferred.wantClear;

  const phases: GuideGraspPhaseResult[] = GUIDE_SCREEN_PHASES.map((p) => {
    let required = false;
    if (p.need === "always") required = true;
    else if (p.need === "when_station") required = wantStation;
    else if (p.need === "when_area") required = wantArea;
    else if (p.need === "when_clear") {
      // 外し後は連続時必須。handoff は任意（印があれば加点のみ）
      required = wantClear && p.id === "after_clear";
    }
    else if (p.need === "when_list") {
      // 次頁は任意（測るが欠でも完了を落とさない）
      required = wantList && p.id !== "next";
    }
    const hit = keys.some((k) => p.re.test(k));
    const status: GuideGraspPhaseResult["status"] = !required ? (hit ? "ok" : "na") : hit ? "ok" : "miss";
    return {
      id: p.id,
      label: p.label,
      need: p.need,
      required,
      hit,
      status,
    };
  });

  // 場所は駅か地域のどちらか必須（両方不要なら after_place だけでよい）
  if (!wantStation && !wantArea) {
    const st = phases.find((p) => p.id === "after_station");
    const ar = phases.find((p) => p.id === "after_area");
    if (st) { st.required = false; st.status = st.hit ? "ok" : "na"; }
    if (ar) { ar.required = false; ar.status = ar.hit ? "ok" : "na"; }
  }

  const required = phases.filter((p) => p.required);
  const missing = required.filter((p) => !p.hit).map((p) => p.label);
  const done = required.filter((p) => p.hit).length;
  const total = required.length;
  const improve_complete = total > 0 && missing.length === 0;

  const line =
    `手順書×画面照会 ${done}/${total}✓`
    + (missing.length ? ` 欠=${missing.join("・")}` : " 全必須段OK")
    + `（経路:駅${wantStation ? "要" : "-"}・地域${wantArea ? "要" : "-"}・一覧${wantList ? "要" : "-"}）`
    + `（完了線: 必須段の本番監査印が全て揃う・コード配線だけでは不可）`;

  const next = improve_complete
    ? "維持（次客でも段ごとの印を監査で確かめる）"
    : missing.length
      ? `未達段を1つずつ強化→拡張再読込→自動1回→監査で印確認（先=${missing[0]}）`
      : "拡張再読込→スタッフ/自動1回→search_audits で段印を読む";

  return {
    ok: improve_complete,
    done,
    total,
    missing,
    phases,
    path: { wantStation, wantList },
    line,
    next,
    improve_complete,
  };
}

/** 複数監査から「いちばん進んだ回」で測る（最新の staff/aix 優先） */
export function auditGuideScreenGraspFromAudits(
  audits: Array<{ steps?: unknown; mode?: string | null; ext_version?: string | null }>,
): GuideScreenGraspAudit {
  const preferred = [...audits].sort((a, b) => {
    const score = (m: string | null | undefined) =>
      /brain_aix|aix|auto/.test(String(m || "")) ? 2 : /brain_staff|staff/.test(String(m || "")) ? 1 : 0;
    return score(b.mode) - score(a.mode);
  });
  let best: GuideScreenGraspAudit | null = null;
  for (const a of preferred) {
    const r = auditGuideScreenGrasp({ steps: Array.isArray(a.steps) ? a.steps : [] });
    if (!best || r.done > best.done || (r.improve_complete && !best.improve_complete)) best = r;
    if (r.improve_complete) return r;
  }
  return best || auditGuideScreenGrasp({ steps: [] });
}
