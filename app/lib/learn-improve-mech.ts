/**
 * 学習改善を「仕組み」で細かく回す（2026-11-16 竹内さん）
 *
 *   「統括の部分より学習できるように学習面の強化を細かくおこなう」
 *   「細かくまなんでいく」「学習改善の部分も仕組み強化」「統括の学習力も強化」
 *   「仕組みで強化していく形」「ここの部分の強化でできるように仕組みの部分強化」
 *
 * ★ なぜ要るか
 *   「弱い所を読む」だけでは粗い。欄ごとに**観点**（種類・位置・click→change・
 *   カーソル・外し/選び・場面）へ分解し、足りない観点だけを次手にする。
 *   統括の学習力＝この細分化を次手・自己点検に**仕組みとして**効かせること。
 *
 * ⚠ 純関数。DBに書かない・サイトを触らない。
 * ⚠ learn-supervisor から import しない（循環参照を避ける）。
 */

const KNOWN_SELECT_RE =
  /^(rental_cost|update_date|square_meter|structured_date|transportation_id|required_time)/i;

function isKnownSelectField(name: string): boolean {
  return KNOWN_SELECT_RE.test(String(name || "").trim());
}

/**
 * ★ 2026-11-16 竹内さん「度だが必要なら補強して細かい部分も強化」「細部までこだわった改善」
 *   「弱い部分を見つけたら統括はそこを改善」「人間の動きのように細かい部分にこだわって」:
 *   完了線・弱判定の「度」を1か所に集約。緩いと細部が未達のまま「ほぼ」になり、
 *   厳しすぎると課題が増えすぎるので、人間らしさの細部が測れる線にそろえる。
 */
export const DETAIL_DEGREE = {
  /** カーソル記録％の完了線 */
  CURSOR_OK: 70,
  /** 押した位置％の完了線（細部こだわりで 50→60 に補強） */
  POINT_OK: 60,
  /** 欄×観点平均の完了線 */
  FINE_AVG_OK: 70,
  /** この点未満の欄は「弱い部分」→ 必ず改善課題へ */
  WEAK_FIELD: 80,
} as const;

/** 細部の度（統括根拠用1行） */
export function detailDegreeLine(opt?: {
  cursorPct?: number | null;
  pointPct?: number | null;
  fineAvg?: number | null;
  weakFields?: string[];
}): string {
  const d = DETAIL_DEGREE;
  const bits: string[] = [
    `度: カーソル≥${d.CURSOR_OK}・押した位置≥${d.POINT_OK}・欄×観点≥${d.FINE_AVG_OK}・欄${d.WEAK_FIELD}未満は弱い`,
  ];
  if (opt?.cursorPct != null) {
    bits.push(opt.cursorPct >= d.CURSOR_OK ? `カーソル${opt.cursorPct}%✓` : `⚠カーソル${opt.cursorPct}%`);
  }
  if (opt?.pointPct != null) {
    bits.push(opt.pointPct >= d.POINT_OK ? `位置${opt.pointPct}%✓` : `⚠位置${opt.pointPct}%`);
  }
  if (opt?.fineAvg != null) {
    bits.push(opt.fineAvg >= d.FINE_AVG_OK ? `欄×観点${opt.fineAvg}%✓` : `⚠欄×観点${opt.fineAvg}%`);
  }
  if (opt?.weakFields?.length) {
    bits.push(`弱い欄: ${opt.weakFields.slice(0, 4).join("・")}`);
  }
  return bits.join("／");
}

/** 弱い欄（細部未達）を列挙 → 統括が改善課題に載せる */
export function weakDetailFields(
  statuses: ReadonlyArray<FieldLearnStatus>,
  threshold = DETAIL_DEGREE.WEAK_FIELD,
): string[] {
  return statuses
    .filter((s) => s.score < threshold)
    .sort((a, b) => a.score - b.score)
    .map((s) => s.field);
}

/** 1欄を細かく学ぶ観点 */
export type LearnFacet =
  | "kind"          // 欄の種類（select/text/checkbox）
  | "position"      // 押す位置
  | "click_change"  // 押してから値が変わる
  | "cursor"        // カーソル接近・手の形
  | "toggle"        // 外し/選び（was/now）
  | "scene";        // どの場面の手順か

export const FACET_JA: Record<LearnFacet, string> = {
  kind: "種類",
  position: "位置",
  click_change: "押して変化",
  cursor: "カーソル",
  toggle: "外し/選び",
  scene: "場面",
};

/** 1欄×1観点の抜け */
export type FieldLearnGap = {
  field: string;
  facet: LearnFacet;
  /** 足りない理由（実データ寄り） */
  why: string;
  /** どう学ぶか（仕組みの次手） */
  how: string;
  /** 優先（小さいほど先） */
  priority: number;
};

export type FieldLearnStatus = {
  field: string;
  /** 分かっている観点 */
  ok: LearnFacet[];
  /** 足りない観点 */
  gaps: FieldLearnGap[];
  /** 0〜100（観点が揃うほど高い） */
  score: number;
};

export type FineLearnInput = {
  /** 自動の課題欄・直書き疑いなど、細かく学ぶ対象 */
  fields: string[];
  /** 画像で位置が取れた欄 */
  imagePositionFields?: string[];
  /** 操作で種類が分かっている欄（ops の select/checkbox 等） */
  opsKindFields?: string[];
  /** click→change が取れている欄 */
  clickChangeFields?: string[];
  /** 押さず変化（直書き疑い）欄 */
  directWriteFields?: string[];
  /** 押し直し欄 */
  reclickFields?: string[];
  /** was/now で外し/選びが分かる件数（全体） */
  toggleOff?: number;
  toggleOn?: number;
  toggleUnknown?: number;
  /** カーソル記録％（全体・人間らしさ） */
  cursorPct?: number | null;
  /** 押した位置％（全体） */
  pointPct?: number | null;
  /** 手の形回数 */
  handClicks?: number;
  /** 場面に紐づいた欄 */
  sceneLinkedFields?: string[];
};

/**
 * 1欄について、足りない学習観点を細分化する（純関数）。
 */
export function fineGapsForField(
  field: string,
  inp: FineLearnInput,
): FieldLearnGap[] {
  const f = String(field || "").trim();
  if (!f) return [];
  const gaps: FieldLearnGap[] = [];
  const isSelect = isKnownSelectField(f);
  const isWard = /city_code|区を選ぶ|one_city|町字|ward/i.test(f);
  const hasImgPos = (inp.imagePositionFields || []).includes(f);
  const hasOpsKind = (inp.opsKindFields || []).includes(f) || isSelect;
  const hasClickChange = (inp.clickChangeFields || []).includes(f);
  const isDirect = (inp.directWriteFields || []).includes(f);
  const isReclick = (inp.reclickFields || []).includes(f);
  const sceneOk = (inp.sceneLinkedFields || []).includes(f);
  const offN = inp.toggleOff ?? 0;
  const onN = inp.toggleOn ?? 0;
  const unkN = inp.toggleUnknown ?? 0;
  const cursorPct = inp.cursorPct;
  const pointPct = inp.pointPct;
  const hand = inp.handClicks ?? 0;

  // 種類: 既知selectは「再判定不要」＝ok扱い。それ以外は ops 種類が無いと抜け
  if (!hasOpsKind && !isSelect) {
    gaps.push({
      field: f,
      facet: "kind",
      why: "操作の種類がまだ薄い（Visionだけで決めない）",
      how: "通常録画の操作（shot_ops.w）から種類を確定する",
      priority: 2,
    });
  } else if (isSelect) {
    // 仕組み①: select は種類学習をスキップし、位置・押し方へ
  }

  if (!hasImgPos && (pointPct == null || pointPct < DETAIL_DEGREE.POINT_OK || isDirect || isReclick || isSelect)) {
    gaps.push({
      field: f,
      facet: "position",
      why: hasImgPos ? "位置はあるが再現が薄い" : "押す位置が束／画像に足りない",
      how: isSelect
        ? "仕組み①: 通常画像・point_fields から位置を学ぶ（種類の再判定はしない）"
        : "通常モード最新画像から位置を読む（photo_learn・newest）",
      priority: 1,
    });
  }

  if (isDirect || !hasClickChange) {
    gaps.push({
      field: f,
      facet: "click_change",
      why: isDirect
        ? "押さず変化（直書き疑い）→ 人間の押し方になっていない"
        : "click→change の並びが薄い",
      how: "通常の同欄で click のあとに change が続く押し方を学び、直書きをやめる",
      priority: isDirect ? 0 : 2,
    });
  }

  if ((cursorPct != null && cursorPct < DETAIL_DEGREE.CURSOR_OK) || hand === 0) {
    gaps.push({
      field: f,
      facet: "cursor",
      why: [
        cursorPct != null && cursorPct < DETAIL_DEGREE.CURSOR_OK ? `カーソル${cursorPct}%` : null,
        hand === 0 ? "手の形0" : null,
      ].filter(Boolean).join("・") || "カーソル記録が薄い",
      how: "通常でカーソル軌跡・cs=pointer を録画し、自動の前に同じ接近を写す",
      priority: 3,
    });
  }

  if (isWard || /city_code|区/.test(f)) {
    if (offN === 0 && onN === 0 && unkN > 0) {
      gaps.push({
        field: f,
        facet: "toggle",
        why: `外し/選びが区別できない（unknown ${unkN}）`,
        how: "仕組み②: was/now 付きで区を1つ外す・1つ選ぶを通常録画する",
        priority: 0,
      });
    } else if (isReclick || offN > 0) {
      gaps.push({
        field: f,
        facet: "toggle",
        why: offN > 0
          ? `前客の残りを外す型が要る（外し${offN}）`
          : "区の押し直し → 外し型が未学習の可能性",
        how: "仕組み②: 条件外だけOFF・条件内（北・中央・西など）は触らない",
        priority: 0,
      });
    }
  }

  if (!sceneOk) {
    gaps.push({
      field: f,
      facet: "scene",
      why: "どの場面の手順か紐づきが薄い",
      how: "仕組み③: 区を選ぶ＝所在地／賃料＝条件 など場面の手本と突き合わせる",
      priority: 4,
    });
  }

  return gaps.sort((a, b) => a.priority - b.priority);
}

/**
 * 対象欄すべてを細かく採点する。
 */
export function scoreFieldsFine(inp: FineLearnInput): FieldLearnStatus[] {
  const fields = [...new Set((inp.fields || []).map(String).filter(Boolean))].slice(0, 12);
  const allFacets: LearnFacet[] = ["kind", "position", "click_change", "cursor", "toggle", "scene"];
  return fields.map((field) => {
    const gaps = fineGapsForField(field, inp);
    const gapFacets = new Set(gaps.map((g) => g.facet));
    // ward 以外は toggle 観点を「対象外＝ok」扱い
    const isWard = /city_code|区を選ぶ|one_city|町字|ward/i.test(field);
    const relevant = allFacets.filter((fc) => fc !== "toggle" || isWard);
    const ok = relevant.filter((fc) => !gapFacets.has(fc));
    const score = relevant.length
      ? Math.round((ok.length / relevant.length) * 100)
      : 100;
    return { field, ok, gaps, score };
  });
}

/** 細かく学ぶ次手（優先順・最大 n 件） */
export function fineLearnNextSteps(
  statuses: ReadonlyArray<FieldLearnStatus>,
  limit = 8,
): FieldLearnGap[] {
  const all = statuses.flatMap((s) => s.gaps);
  // 同 facet+近い how は畳むが、欄は残す
  const seen = new Set<string>();
  const out: FieldLearnGap[] = [];
  for (const g of all.sort((a, b) => a.priority - b.priority || a.field.localeCompare(b.field))) {
    const k = `${g.facet}|${g.field}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
    if (out.length >= limit) break;
  }
  return out;
}

/** 統括根拠用の1行 */
export function fineLearnEvidenceLine(statuses: ReadonlyArray<FieldLearnStatus>): string {
  if (!statuses.length) return "細かく学ぶ対象欄なし";
  const avg = Math.round(statuses.reduce((s, x) => s + x.score, 0) / statuses.length);
  const weak = [...statuses].sort((a, b) => a.score - b.score).slice(0, 4);
  const parts = weak.map((s) => {
    const g = s.gaps.slice(0, 2).map((x) => FACET_JA[x.facet]).join("・");
    return `${s.field}${s.score}%${g ? `(要:${g})` : ""}`;
  });
  return `欄×観点 平均${avg}%／弱い: ${parts.join("・")}`;
}

/**
 * 自動録画の操作列から「制御のずれ」を検知する（2026-11-16 竹内さん）
 *   ・家賃を連続で3回以上押している（誤った多重押し）
 *   ・条件入力らしき列なのに間取りが1回も無い
 * ⚠ 純関数。わざと1回押すのは OK（streak&lt;3）。
 */
/**
 * 監査ステップから「場所の前に検索した」ずれを検知（2026-11-16）
 *   例: search_guard_press / search が place_ready・basic_after_place・ward_verified より先
 */
export function detectSearchBeforePlace(
  stepKeys: ReadonlyArray<string>,
): { earlySearch: boolean; line: string } {
  const keys = stepKeys.map((k) => String(k || ""));
  const placeIdx = keys.findIndex((k) =>
    /place_ready|basic_after_place|area_all_done|ward_verified|station_confirm|location:(area|station)/.test(k),
  );
  const searchIdx = keys.findIndex((k) =>
    /^(page:)?search$|search_guard_press|search_backup_press|search_block_/.test(k) || k === "search" || k.endsWith(":search"),
  );
  const guardEarly = keys.some((k, i) => {
    if (!/search_guard_press|search_backup_press/.test(k)) return false;
    if (placeIdx < 0) return true;
    return i < placeIdx;
  });
  const searchEarly = searchIdx >= 0 && (placeIdx < 0 || searchIdx < placeIdx);
  const earlySearch = guardEarly || searchEarly;
  return {
    earlySearch,
    line: earlySearch
      ? "制御ずれ: 場所の前に検索しようとした（地域/駅→条件→検索の順を守る）"
      : "検索順OK（場所→条件→検索）",
  };
}

/**
 * 続き客で「前の地域/駅を外して新しい条件を選ぶ」が薄い・誤残しを検知（2026-11-16）
 *   ・場所パスなのに clear/やり直し印が無い
 *   ・area_preclear_keep だけで force が無い（前客を人が選んだと誤認して残した疑い）
 */
/**
 * 間取り・敷礼など基本条件の前に検索したずれ（2026-11-16）
 *   実測: search_guard_press → basic_after_place → gate_warn → search
 *   v2.8.17: 控え保険は search_backup_press（条件完了後のみ）。旧25秒保険の早期押しも検知する。
 */
export function detectSearchBeforeBasic(
  stepKeys: ReadonlyArray<string>,
): { earlySearch: boolean; line: string } {
  const keys = stepKeys.map((k) => String(k || ""));
  const basicIdx = keys.findIndex((k) => /conditions_ready|basic_after_place/.test(k));
  const guardIdx = keys.findIndex((k) => /search_guard_press|search_backup_press/.test(k));
  const earlySearch = guardIdx >= 0 && (basicIdx < 0 || guardIdx < basicIdx);
  return {
    earlySearch,
    line: earlySearch
      ? "制御ずれ: 基本条件（間取り・敷礼）の前に保険で検索した"
      : "検索順OK（場所→基本条件→検索）",
  };
}

export function detectPlaceNotRedone(
  stepKeys: ReadonlyArray<string>,
): { weak: boolean; line: string } {
  const keys = stepKeys.map((k) => String(k || ""));
  const hasPlacePath = keys.some((k) =>
    /location:(area|station)|ward_verified|station_confirm|place_ready|basic_after_place/.test(k),
  );
  const hasClearOrRedo = keys.some((k) =>
    /place_redo|place_side_clear|area_preclear_force|area_prev_clear_force|station_preclear_force|clear_done|clear_checks|area_preclear(?!_keep)|area_prev_clear(?!_force)/.test(k),
  );
  const keptAsHuman = keys.some((k) => /area_preclear_keep|area_keep_human/.test(k));
  const forced = keys.some((k) =>
    /place_redo|place_side_clear|area_preclear_force|area_prev_clear_force|station_preclear_force/.test(k),
  );
  const weak = (hasPlacePath && !hasClearOrRedo) || (keptAsHuman && !forced);
  return {
    weak,
    line: weak
      ? "弱い: 続き客の所在地/駅のやり直しが薄い（前客の地域・駅が残る可能性）→ 外してから新条件を選ぶ"
      : "所在地/駅のやり直しOK（前を外してから新しい条件）",
  };
}

export function detectAutoControlSlips(fieldSeqs: ReadonlyArray<ReadonlyArray<string>>): {
  rentMultiRuns: number;
  layoutMissRuns: number;
  line: string;
} {
  let rentMultiRuns = 0;
  let layoutMissRuns = 0;
  for (const seq of fieldSeqs) {
    const names = seq.map((s) => String(s || ""));
    let streak = 0;
    let maxRent = 0;
    let hasRent = false;
    let hasLayout = false;
    let hasCond = false;
    for (const f of names) {
      if (/rental_cost2|家賃/.test(f)) {
        hasRent = true;
        hasCond = true;
        streak += 1;
        if (streak > maxRent) maxRent = streak;
      } else {
        streak = 0;
      }
      if (/room_layout|間取り/.test(f)) hasLayout = true;
      if (/structured_date|required_time|update_date|include_common/.test(f)) hasCond = true;
    }
    if (maxRent >= 3) rentMultiRuns += 1;
    if (hasCond && hasRent && !hasLayout) layoutMissRuns += 1;
  }
  const parts: string[] = [];
  if (rentMultiRuns) parts.push(`家賃連続押し${rentMultiRuns}回分`);
  if (layoutMissRuns) parts.push(`間取り抜け${layoutMissRuns}回分`);
  return {
    rentMultiRuns,
    layoutMissRuns,
    line: parts.length
      ? `制御ずれ: ${parts.join("・")}（押し直しはずれ欄だけ・間取りは実行時DOM）`
      : "制御ずれなし（家賃連打・間取り抜けなし）",
  };
}

/**
 * 細かい抜け → 統括 learning_tasks 向けヒント。
 *   photo_learn は「位置が足りない欄」を優先し、toggle 抜けは build_foundation。
 */
export function fineGapsToTaskHints(gaps: ReadonlyArray<FieldLearnGap>): Array<{
  kind: "photo_learn" | "build_foundation" | "need_human" | "fix_scene";
  what: string;
  why: string;
  fields?: string[];
}> {
  const out: Array<{
    kind: "photo_learn" | "build_foundation" | "need_human" | "fix_scene";
    what: string;
    why: string;
    fields?: string[];
  }> = [];
  const posFields = gaps.filter((g) => g.facet === "position" || g.facet === "click_change").map((g) => g.field);
  const uniqPos = [...new Set(posFields)].slice(0, 8);
  if (uniqPos.length) {
    out.push({
      kind: "photo_learn",
      what: "欄を細かく学ぶ（位置・押して変化）",
      why: `観点: ${gaps.filter((g) => uniqPos.includes(g.field) && (g.facet === "position" || g.facet === "click_change")).slice(0, 4).map((g) => `${g.field}:${FACET_JA[g.facet]}`).join("・")}`,
      fields: uniqPos,
    });
  }
  const toggleGaps = gaps.filter((g) => g.facet === "toggle");
  if (toggleGaps.length) {
    out.push({
      kind: "build_foundation",
      what: "区の外し/選びを細かく学ぶ土台（was/now・くれあ型）",
      why: toggleGaps.slice(0, 2).map((g) => g.why).join("／"),
      fields: [...new Set(toggleGaps.map((g) => g.field))].slice(0, 4),
    });
  }
  const cursorGaps = gaps.filter((g) => g.facet === "cursor");
  if (cursorGaps.length) {
    out.push({
      kind: "need_human",
      what: "カーソル・手の形を通常録画で細かく取る",
      why: cursorGaps[0]?.why || "カーソル記録が薄い",
    });
  }
  const sceneGaps = gaps.filter((g) => g.facet === "scene");
  if (sceneGaps.length) {
    out.push({
      kind: "fix_scene",
      what: "欄と場面の紐づきを細かく直す",
      why: `場面未紐づき: ${[...new Set(sceneGaps.map((g) => g.field))].slice(0, 4).join("・")}`,
      fields: [...new Set(sceneGaps.map((g) => g.field))].slice(0, 6),
    });
  }
  return out;
}

/**
 * 統括の「学習力」（仕組みを次手に効かせているか）0〜100。
 *   表示だけの仕組み理解では点を上げない。課題 why に仕組みが効いているかで測る。
 */
export function supervisorLearnPower(opt: {
  mechanismsInEvidence: boolean;
  photoLearnUsesSelectMech: boolean;
  hasFineLearnEvidence: boolean;
  toggleMechApplied: boolean;
  softCapWhenNotHuman: boolean;
  /** 精度上げと一連が連携しているか（仕組み⑧） */
  precisionLinked?: boolean;
  /**
   * 仕組み⑩: 弱い部分を見つけたら改善課題に載せているか
   *   （見つけただけで終わらせない・細部まで改善）
   */
  weakThenImproveApplied?: boolean;
}): { score: number; line: string; missing: string[] } {
  const checks: Array<{ ok: boolean; label: string; w: number }> = [
    { ok: opt.mechanismsInEvidence, label: "仕組みを根拠に持つ", w: 12 },
    { ok: opt.photoLearnUsesSelectMech, label: "仕組み①が課題に効く", w: 18 },
    { ok: opt.hasFineLearnEvidence, label: "欄×観点で細かく学ぶ", w: 18 },
    { ok: opt.toggleMechApplied, label: "仕組み②（外し/was）が課題か検知", w: 12 },
    { ok: opt.softCapWhenNotHuman, label: "人間らしさ未完なら材料点を抑える", w: 12 },
    { ok: opt.precisionLinked !== false, label: "精度上げと一連を連携", w: 13 },
    { ok: opt.weakThenImproveApplied !== false, label: "弱い部分→改善課題に載せる", w: 15 },
  ];
  const score = checks.reduce((s, c) => s + (c.ok ? c.w : 0), 0);
  const missing = checks.filter((c) => !c.ok).map((c) => c.label);
  return {
    score,
    line: `統括の学習力 ${score}/100${missing.length ? `／足りない: ${missing.join("・")}` : "／仕組みで学習改善を回せる"}`,
    missing,
  };
}

/** 精度レバー（次に精度を上げる一手） */
export type PrecisionLever = {
  kind: "photo_learn" | "build_foundation" | "need_human" | "need_ext_reload" | "need_auto_run" | "verify_improve" | "fix_scene";
  what: string;
  why: string;
  /** 精度への効き（大きいほど先） */
  lift: number;
};

/**
 * ★ 2026-11-16 竹内さん「いま自動モードどこまで完成度あがったのかな／完成度わかればよりよい
 *   完成度も理解して学習する仕組みを統括もつ」:
 *   完成度を1本の数字＋内訳で出し、統括が「何を学べば完成度が上がるか」を決める。
 *
 *   配点（合計100）:
 *     一連（束→拡張→自動→効果）40／人間らしさの再現 25／欄×観点 15／精度 10／人間として可 10
 */
export type AutoCompletion = {
  score: number;
  grade: "まだ早い" | "土台づくり" | "もう少し" | "ほぼ" | "完成に近い";
  parts: Array<{ label: string; score: number; max: number; remain?: string }>;
  remain: string[];
  line: string;
  /** 完成度を上げるために次に学ぶ／やる事（統括の学習に効かせる） */
  learnHint: string;
};

export function measureAutoCompletion(opt: {
  improveSteps?: Array<{ n: number; ok: boolean; name?: string }> | null;
  bottleneckN?: number | null;
  reproducePct?: number | null;
  reproduceRemain?: string[];
  fineAvg?: number | null;
  precisionScore?: number | null;
  humanAutoOk?: boolean;
  challengeN?: number;
}): AutoCompletion {
  const steps = Array.isArray(opt.improveSteps) ? opt.improveSteps : [];
  const okN = steps.length ? steps.filter((s) => s.ok).length : (
    opt.bottleneckN == null ? 0 : Math.max(0, Math.min(6, opt.bottleneckN - 1))
  );
  const stepMax = 6;
  const pipelineScore = Math.round((okN / stepMax) * 40);
  const stuckName = steps.find((s) => !s.ok)?.name
    || (opt.bottleneckN != null ? `段階${opt.bottleneckN}` : null);

  const repro = typeof opt.reproducePct === "number" ? opt.reproducePct : null;
  const reproScore = repro != null ? Math.round((repro / 100) * 25) : 0;

  const fine = typeof opt.fineAvg === "number" ? opt.fineAvg : null;
  const fineScore = fine != null ? Math.round((fine / 100) * 15) : 0;

  const prec = typeof opt.precisionScore === "number" ? opt.precisionScore : null;
  const precScore = prec != null ? Math.round((prec / 100) * 10) : 0;

  const humanOk = opt.humanAutoOk === true;
  const humanScore = humanOk ? 10 : 0;

  const score = Math.max(0, Math.min(100, pipelineScore + reproScore + fineScore + precScore + humanScore));
  const grade: AutoCompletion["grade"] =
    score >= 85 ? "完成に近い"
      : score >= 70 ? "ほぼ"
        : score >= 45 ? "もう少し"
          : score >= 25 ? "土台づくり"
            : "まだ早い";

  const remain: string[] = [];
  if (stuckName) remain.push(`一連: ${stuckName}で停止（${okN}/${stepMax}）`);
  for (const r of (opt.reproduceRemain || []).slice(0, 4)) remain.push(`再現: ${r}`);
  if (fine != null && fine < DETAIL_DEGREE.FINE_AVG_OK) {
    remain.push(`欄×観点 ${fine}%（要≥${DETAIL_DEGREE.FINE_AVG_OK}）`);
  }
  if (prec != null && prec < DETAIL_DEGREE.FINE_AVG_OK) {
    remain.push(`精度 ${prec}%（要≥${DETAIL_DEGREE.FINE_AVG_OK}）`);
  }
  if (!humanOk) remain.push("人間として自動: まだ不可");
  if ((opt.challengeN ?? 0) > 0) remain.push(`課題欄 ${(opt.challengeN)}件`);

  const parts: AutoCompletion["parts"] = [
    {
      label: "一連（束→拡張→自動→効果）",
      score: pipelineScore,
      max: 40,
      remain: stuckName ? `${stuckName}で停止` : undefined,
    },
    {
      label: "人間らしさの再現",
      score: reproScore,
      max: 25,
      remain: repro != null ? `${repro}%` : "未測",
    },
    {
      label: "欄×観点",
      score: fineScore,
      max: 15,
      remain: fine != null ? `${fine}%` : "未測",
    },
    {
      label: "精度",
      score: precScore,
      max: 10,
      remain: prec != null ? `${prec}%` : "未測",
    },
    {
      label: "人間として自動できるか",
      score: humanScore,
      max: 10,
      remain: humanOk ? "可" : "不可",
    },
  ];

  /**
   * 学習ヒント: 一連が段階4〜6で止まっている時は**そこが先**（完成度のボトルネック）。
   *   それ以外は内訳で一番薄いパートから学ぶ。
   */
  const bn = opt.bottleneckN ?? null;
  const weakest = [...parts].sort((a, b) => (a.score / a.max) - (b.score / b.max))[0];
  let learnHint = "完成度の低い所から学ぶ";
  if (bn === 4) {
    learnHint = "完成度↑: 拡張再読込（段階4）→学んだ物が現場に届く";
  } else if (bn === 5) {
    learnHint = "完成度↑: 自動1回（段階5）→効果を数字で測る";
  } else if (bn === 6) {
    learnHint = "完成度↑: 効果確認（課題欄が減ったか）";
  } else if (weakest?.label.includes("一連")) {
    learnHint = "完成度↑: 一連の止まっている段階を先に進める";
  } else if (weakest?.label.includes("再現")) {
    learnHint = `完成度↑: 再現の残りを通常から学ぶ（${(opt.reproduceRemain || []).slice(0, 2).join("・") || "カーソル・位置・手の形"}）`;
  } else if (weakest?.label.includes("欄")) {
    learnHint = "完成度↑: 弱い欄を観点ごとに細かく学ぶ（位置・押して変化・外し）";
  } else if (weakest?.label.includes("精度")) {
    learnHint = "完成度↑: 精度レバーに沿って学ぶ（一連と連携）";
  } else if (weakest?.label.includes("人間として")) {
    learnHint = "完成度↑: 再現・反映・完走の線を満たすまで学ぶ（渡してよいにはしない）";
  }

  const line = `自動モード完成度 ${score}/100（${grade}）／一連${okN}/${stepMax}・再現${repro ?? "?"}％・欄×観点${fine ?? "?"}％・精度${prec ?? "?"}％・人間として${humanOk ? "可" : "不可"}`;

  return { score, grade, parts, remain: remain.slice(0, 8), line, learnHint };
}

/**
 * ★ 2026-11-16「より精度上げれるように／精度上げる部分も強化／統括これらの部分ちゃんと連携」:
 *   精度 = 欄×観点の細かさ × 人間らしさの再現 × 現場の完走 × 課題の少なさ。
 *   測ってから上げる。一連（段階）と食い違う次手は出さない（連携）。
 */
export function measurePrecision(opt: {
  fineStatuses?: ReadonlyArray<FieldLearnStatus>;
  reproducePct?: number | null;
  auditFinishRate?: number | null;
  challengeFieldCount?: number;
}): {
  score: number;
  fineAvg: number | null;
  reproducePct: number | null;
  auditRate: number | null;
  challengeN: number;
  line: string;
} {
  const fineAvg = opt.fineStatuses && opt.fineStatuses.length
    ? Math.round(opt.fineStatuses.reduce((s, x) => s + x.score, 0) / opt.fineStatuses.length)
    : null;
  const repro = typeof opt.reproducePct === "number" ? opt.reproducePct : null;
  const audit = typeof opt.auditFinishRate === "number" ? opt.auditFinishRate : null;
  const ch = Math.max(0, Number(opt.challengeFieldCount) || 0);
  /** 課題が多いほど精度を下げる（8欄で最大25点減） */
  const challengePenalty = Math.min(25, ch * 3);
  const parts: Array<{ v: number; w: number }> = [];
  if (fineAvg != null) parts.push({ v: fineAvg, w: 35 });
  if (repro != null) parts.push({ v: repro, w: 35 });
  if (audit != null) parts.push({ v: audit, w: 20 });
  const base = parts.length
    ? Math.round(parts.reduce((s, p) => s + p.v * p.w, 0) / parts.reduce((s, p) => s + p.w, 0))
    : 0;
  const score = Math.max(0, Math.min(100, base - challengePenalty));
  const bits = [
    fineAvg != null ? `欄×観点${fineAvg}%` : null,
    repro != null ? `再現${repro}%` : null,
    audit != null ? `完走${audit}%` : null,
    ch > 0 ? `課題欄${ch}` : null,
  ].filter(Boolean);
  return {
    score,
    fineAvg,
    reproducePct: repro,
    auditRate: audit,
    challengeN: ch,
    line: `精度 ${score}/100（${bits.join("・") || "材料不足"}）`,
  };
}

/**
 * 精度を上げるレバーを、一連の段階と**連携**して並べる。
 *   ⚠ 段階4〜5で止まっているのに photo_learn を最先頭にしない（学んでも自動に届かない）。
 *   ⚠ 段階が手前なら、欄×観点の弱い所から細かく上げる。
 */
export function precisionLeversLinked(opt: {
  precision: ReturnType<typeof measurePrecision>;
  fineStatuses?: ReadonlyArray<FieldLearnStatus>;
  bottleneckN?: number | null;
  reproduceRemain?: string[];
  hasToggleUnknown?: boolean;
}): PrecisionLever[] {
  const bn = opt.bottleneckN ?? null;
  const levers: PrecisionLever[] = [];
  const p = opt.precision;

  // 一連との連携（反映・使うが先）
  if (bn === 4) {
    levers.push({
      kind: "need_ext_reload",
      what: "拡張再読込で束を取り直し、精度向上を現場に届ける",
      why: `精度${p.score}%でも段階4停止 → 学んだ欄×観点が拡張に届いていない（連携）`,
      lift: 100,
    });
  } else if (bn === 5) {
    levers.push({
      kind: "need_auto_run",
      what: "自動1回で精度の効果を現場の数字で測る",
      why: `精度${p.score}%・段階5 → 新束のあと自動が無いと精度が上がったか分からない（連携）`,
      lift: 100,
    });
  } else if (bn === 6 || (p.challengeN > 0 && (bn == null || bn >= 6))) {
    levers.push({
      kind: "verify_improve",
      what: "効果確認で精度（課題欄・再現）が上がったか確かめる",
      why: `精度${p.score}%／課題欄${p.challengeN} → 現場の記録で精度を測る（点数だけで判断しない）`,
      lift: 90,
    });
  }

  // 細かく学ぶレバー（段階が手前、または課題が残っている時）
  const allowFine = bn == null || bn <= 3 || bn === 6 || (bn >= 4 && p.fineAvg != null && p.fineAvg < 50);
  if (allowFine && opt.fineStatuses?.length) {
    const steps = fineLearnNextSteps(opt.fineStatuses, 4);
    for (const g of steps) {
      const kind: PrecisionLever["kind"] =
        g.facet === "toggle" ? "build_foundation"
          : g.facet === "cursor" ? "need_human"
            : g.facet === "scene" ? "fix_scene"
              : "photo_learn";
      levers.push({
        kind,
        what: `精度↑ ${g.field} の${FACET_JA[g.facet]}を細かく学ぶ`,
        why: `${g.why}／精度${p.score}%を上げる（仕組み⑥）`,
        lift: bn != null && bn >= 4 ? 40 - g.priority : 80 - g.priority,
      });
    }
  }

  if (opt.hasToggleUnknown) {
    levers.push({
      kind: "build_foundation",
      what: "was/now で外し精度を上げる土台",
      why: `外し/選びが区別できないと区の精度が上がらない（仕組み②・連携）`,
      lift: bn != null && bn >= 4 ? 35 : 70,
    });
  }

  const remain = opt.reproduceRemain || [];
  if (remain.some((x) => /手の形/.test(x))) {
    levers.push({
      kind: "need_human",
      what: "手の形を通常録画して再現精度を上げる",
      why: `再現の残りに手の形 → 精度の再現側が止まる`,
      lift: 55,
    });
  }
  if (remain.some((x) => /カーソル|押した位置/.test(x)) && (bn == null || bn <= 3 || bn === 6)) {
    levers.push({
      kind: "photo_learn",
      what: "カーソル・押した位置を通常から学び再現精度を上げる",
      why: `再現残り: ${remain.filter((x) => /カーソル|押した位置/.test(x)).join("・")}`,
      lift: 60,
    });
  }

  levers.sort((a, b) => b.lift - a.lift);
  // 同 kind は最初の1つ
  const seen = new Set<string>();
  return levers.filter((l) => {
    const k = l.kind + "|" + l.what.slice(0, 24);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 6);
}

/** 精度根拠の1行＋連携ヒント */
export function precisionEvidenceLine(
  precision: ReturnType<typeof measurePrecision>,
  levers: ReadonlyArray<PrecisionLever>,
  bottleneckN?: number | null,
): string {
  const top = levers[0];
  const link =
    bottleneckN === 4 ? "連携: 拡張再読込が先（学んでも届かない）"
      : bottleneckN === 5 ? "連携: 自動1回が先（効果を測れない）"
        : bottleneckN === 6 ? "連携: 効果確認で精度を数字で見る"
          : "連携: 欄×観点→土台→再現→一連で精度を上げる";
  return `${precision.line}／${link}`
    + (top ? `／次: ${top.what}` : "");
}

/** 精度レバー → learning_tasks への変換（一連と重複しにくい形） */
export function precisionLeversToTasks(
  levers: ReadonlyArray<PrecisionLever>,
): Array<{ kind: string; what: string; why: string; cost: string }> {
  return levers.slice(0, 4).map((l) => ({
    kind: l.kind,
    what: l.what,
    why: l.why,
    cost: l.kind === "photo_learn"
      ? "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）"
      : l.kind === "need_human" || l.kind === "need_ext_reload" || l.kind === "need_auto_run"
        ? "無料（人の手間だけ）"
        : "無料",
  }));
}
