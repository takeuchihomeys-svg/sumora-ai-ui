// app/lib/customer-pref-weights.ts
// お客様ごとの「こだわりの強さ」に合わせて、札の点に倍率を掛ける純関数（DB・ネット・LLM に触れない）。
//
// 2026-09-29 竹内「スコアリング、お客さんの希望の条件によってさらに細かく加点の部分変動してお客さんに合ったスコアリング」→
//   「行う。実際に今までお客さんに送った物件の部分で実績してもできるから、その点も併せて分析すればよりスコアリング強化できる」
//   例: バス・トイレ別を何度も言うお客様は、その札（EQUIP_BATH_TOILET_*）の点を大きく。
//   倍率の元の値は「今までお客様に実際に送った物件」（スタッフが選んで送った事実＝正解・memory feedback_property_selection_label）から学ぶ。
//
// ■ 形
//   倍率の表（PrefWeightTable）は **条件の種類（家族・recommend-score-drift.codeFamily）× こだわりの強さ（strong／stated）** で1か所に持つ。
//   お客様1人の強さ（customerStrength.byFamily の level）と表から、札 → 倍率 の関数（prefWeightResolver）を作り、
//   judgeProperty（property-brain）の opts.prefWeight に渡すと、その札の点が round(点 × 倍率) になる。渡さなければ今まで通りの点。
//   書いていない条件（level none）は常に ×1（お客様が書いていない条件をスタッフの選び方の癖で重くしない）。
//
// ■ 決めたこと（scoring-learning.ts と同じ安全の決まり・動かさない所）
//   ・AD の札（AD_・PROFIT_）は倍率を掛けない（竹内さんの方針: AD は弱めない・feedback_ad_scoring）。家族 ad は表に入れない
//   ・材料が無いだけの札（_UNKNOWN・_UNLISTED・_ASK）・外す候補の札・FIT・SEARCH・IMAGE（scoring-learning.isFrozenCode）は ×1 のまま
//   ・倍率は minMult〜maxMult（1.0〜2.0）・目盛り grid（0.25）・1回の学習で動かすのは ±maxStep（0.5）まで
//   ・倍率は加点の札だけに掛ける（減点の札・0点の札は ×1）。こだわりで「合う物を上げる」向きだけ（2026-09-29 反証レビュー:
//     減点も ×2 にすると RENT_OVER_110 −20 → −40 で通す／保留の 40点の線を割り、保留に落ちる物件が出る＝順位の当て直しでは見えない）
//   ・AD 以外の加点は、倍率を掛けても「AD 2ヶ月の札の点の合計 ÷ 1.3」（scoring-learning.adCapOf・今は floor(20÷1.3)=15点）を超えない
//     （今すでに超えている札は今の点まで）。scoring-learning.boundsFor と同じ線（2026-09-29 反証レビュー: 倍率に上限が無いと
//     FLOOR_PLAN_MATCH 15 × 2 = 30 が AD_HIGH 20 を超え、AD の比率が相対的に弱まる＝feedback_ad_scoring に反する）
//   ・学ぶのに要るのは回数だけでなくお客様の人数（minCustomers）。1人から数える回は maxRoundsPerCustomer まで（回の多いお客様1〜2人の
//     スタッフの癖で表のマスが動かないように・2026-09-29 反証レビュー: エリア strong 8回が 3人だった）
//   ・学ぶのは、その 条件 × 強さ で「選んだ物と選ばなかった物で満たすかが違う回」が minRounds 以上あり、その回で相対順位が minGain 以上良くなる時だけ
//   ・確かめてから: 古い holdoutFrac 以外で学び、新しい holdoutFrac で確かめる。全体で良くならなければ使わない。
//     帯（こだわりの強さ・家賃の帯・新規／継続・材料）ごとに出し、**悪くなる帯が1つでもあれば全体で使わない**（帯ごとの使い分けはしない）。
//     通す／保留（40点の線）が変わる物件が出たら使わない（件数を出して竹内さんが決める）
//   ・画像の加点（pickup-image-bonus）には掛けない: あちらは希望の 必須／NG（+5・−10）と ふつう（+3・−5）で既に強さの段を持っていて、
//     倍率を掛けると強さを二重に数える。設備の家族は候補に値が無く学べる回が 0（2026-09-29）なので、学んだ倍率も無い
//
// ■ 2026-09-29 当て直し（scripts/backtest-customer-pref-weights.ts・400日・383回・109人・読むだけ）
//   ・時期で分ける（古い 269回で学び・新しい 114回で確かめ）: 学ぶ期間の候補に条件の札は間取りしか無く（家賃・エリア・築年は 9月後半の売上サポの回だけ＝
//     全部確かめ側に寄る）、間取り × stated（32回）は倍率を動かしても順位が変わらない → 変更なし・相対順位 0.435 → 0.435（全部の帯で ±0）
//   ・お客様で分ける（A 186回で学び B 197回で確かめ／逆）: A→B は 間取り × stated ×1.25（学べる 35回で 0.508 → 0.497）が学ばれ、確かめ用は
//     0.447 → 0.446（+0.001・👑一致 29% → 29%・10位以内 87% → 87%）。B→A は変更なし。倍率の下限を 0.5 まで許すと「家賃 stated ×0.5」
//     「家賃 strong ×0.5」（こだわりを弱める向き）が片方の分け方でだけ学ばれた＝雑音 → 下限を 1.0 にした
//   → 良くなる帯が無い（最大 +0.014・新規 17回）ので LEARNED_PREF_WEIGHTS は空・PREF_WEIGHTS_DEFAULT_ON=false。
//     材料が揃う売上サポの回（9/24〜・5回）が増えてから同じスクリプトで当て直す（判定と帯の線はこのファイルの1か所）
// ■ 2026-09-29 反証レビューの後の当て直し（AD の線・加点だけ・人数 8人／1人 3回・その回の時点で読める条件だけ・鍵は物件顧客 ID）: 383回・108人
//   ・その回の時点で読めない欄を外した（自由文 raw_format_text 380回・preferences 317回・additional_conditions 187回・NG 103回 等）→ 強さは
//     条件欄の履歴と発言・言い直しが中心になった（強い 10人・普通 21人・弱い 77人）
//   ・時期で分ける: 変更なし（間取り stated 34回は動かない・FLOOR_PLAN_MATCH 15点は AD の線で上がらない）0.435 → 0.435・👑 28%・10位以内 77%
//   ・お客様で分ける A→B（170 で学び 213 で確かめ）: 変更なし 0.450 → 0.450／B→A（213 で学び 170 で確かめ）: 変更なし 0.458 → 0.458
//     （家賃 stated 12回は 7人で人数不足・エリア strong は 6回）。前の版の「間取り stated ×1.25」は AD の線（15点）の上だったので今は学べない
//   ・通す／保留が変わる候補 0件・悪くなる帯 0。→ 表は空のまま・既定は使わない

import { codeFamily, familiesOf, familyOk, FAMILY_SKIP, type StrengthLevel } from "./recommend-score-drift";
import { isFrozenCode, usableEpisodes, splitHoldout, adCapOf, type Episode } from "./scoring-learning";
import { reasonPoints, passLineScore } from "./property-brain";

export type PrefLevel = "strong" | "stated";
/** 条件の種類（家族） → 強さ → 倍率（無い所は 1.0） */
export type PrefWeightTable = Record<string, Partial<Record<PrefLevel, number>>>;

export const PREF_WEIGHT_CONFIG = {
  /**
   * 倍率の下限・上限・目盛り。下限 1.0＝書いた条件を弱める向きには学ばない（案B「お客様が書いた条件だけ重くする」と同じ向き。
   *   2026-09-29 お客様で分けた当て直しで 0.5 まで許すと「家賃 stated ×0.5」「家賃 strong ×0.5」と、こだわりを弱める向きだけが学ばれ、
   *   もう片方の分け方では学ばれなかった＝雑音）
   */
  minMult: 1.0,
  maxMult: 2.0,
  grid: 0.25,
  /** 1回の学習で動かす量の上限（倍率） */
  maxStep: 0.5,
  /** その 条件 × 強さ で学べる回（選んだ物と選ばなかった物で満たすかが違う回）の最低数 */
  minRounds: 10,
  /** その 条件 × 強さ で学べる回に要るお客様の人数（回の多い1〜2人の癖で動かさない） */
  minCustomers: 8,
  /** 1人のお客様から数える学べる回の上限（新しい方から） */
  maxRoundsPerCustomer: 3,
  /** 学べる回で相対順位がこれ以上良くなる時だけ動かす */
  minGain: 0.01,
  /** 確かめ用（新しい順）の割合と最低の回数 */
  holdoutFrac: 0.3,
  minHoldout: 20,
  /**
   * 帯ごとの判定に要る回数と、帯で悪くなったとする線（相対順位の悪化。0.002 未満は同点の按分の揺れ＝雑音）。
   *   注: bandTolerance は 2026-09-29 のお客様で分けた当て直し（A→B）で「家賃 7〜10万 n100 −0.0001」が出た**後に**入れた線（結果を見てから
   *   決めた＝反証レビューの指摘）。−0.0001 は同点の按分の揺れで、線の有無で全体の判定は変わらない（全体の改善が 0.01 未満）
   */
  bandMinRounds: 10,
  bandTolerance: 0.002,
  /** 通す／保留（40点の線）が変わってよい候補の数（0＝1件でも変われば使わない。変えるなら竹内さんが件数を見て決める） */
  maxVerdictFlips: 0,
  /** 3位以内の率の悪化の許容（全体） */
  top3Tolerance: 0.0,
  /** 学びの繰り返し（家族 × 強さ を順に・決定論） */
  passes: 2,
  /** 点の上限（property-brain.SCORE_MAX と同じ） */
  scoreMax: 200,
} as const;
export type PrefWeightConfig = { [K in keyof typeof PREF_WEIGHT_CONFIG]: number };

/** 倍率を掛けない条件の種類（条件でない札 ＋ AD） */
export const PREF_FAMILY_SKIP: ReadonlySet<string> = new Set([...FAMILY_SKIP, "ad"]);
export function isPrefFamily(f: string | null | undefined): f is string {
  return !!f && !PREF_FAMILY_SKIP.has(f);
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const clampMult = (m: number, cfg: Pick<PrefWeightConfig, "minMult" | "maxMult"> = PREF_WEIGHT_CONFIG) => Math.min(cfg.maxMult, Math.max(cfg.minMult, m));

/** 表の倍率（none・表に無い・AD 等は 1） */
export function prefMultiplier(family: string | null | undefined, level: StrengthLevel | null | undefined, table: PrefWeightTable | null | undefined, cfg: PrefWeightConfig = PREF_WEIGHT_CONFIG): number {
  if (!isPrefFamily(family) || !level || level === "none" || !table) return 1;
  const m = table[family]?.[level];
  if (typeof m !== "number" || !Number.isFinite(m)) return 1;
  return clampMult(m, cfg);
}

/** お客様の強さ（customerStrength.byFamily か、家族 → level の表） */
export type StrengthMap = Record<string, StrengthLevel | { level: StrengthLevel }>;
export function levelOf(strength: StrengthMap | null | undefined, family: string): StrengthLevel {
  const v = strength?.[family];
  if (!v) return "none";
  return typeof v === "string" ? v : v.level ?? "none";
}

/**
 * 札 → 倍率（凍結の札・条件でない札・書いていない条件・減点／0点の札は 1）。判定（judgeProperty の opts.prefWeight）に渡す。
 *   pointsOf: 札の今の点（既定は property-brain.reasonPoints＝判定と同じ点）。倍率を掛けた点が AD の線（adCapOf(pointsOf)・切り捨て）を
 *   超えないように倍率を小さくする（今すでに線を超えている札は ×1）。呼ぶ側は round(点 × 倍率) で点にする（scoreFromCodes・prefScoreOf）
 */
export function prefWeightResolver(strength: StrengthMap | null | undefined, table: PrefWeightTable | null | undefined, cfg: PrefWeightConfig = PREF_WEIGHT_CONFIG, pointsOf: (code: string) => number = reasonPoints): (code: string) => number {
  const cache = new Map<string, number>();
  const cap = Math.floor(adCapOf(pointsOf));
  return (code: string) => {
    const hit = cache.get(code);
    if (hit != null) return hit;
    let m = 1;
    if (!isFrozenCode(code)) {
      const f = codeFamily(code);
      const p = pointsOf(code);
      if (isPrefFamily(f) && p > 0) {
        m = prefMultiplier(f, levelOf(strength, f), table, cfg);
        // AD の線: round(p × m) ≤ max(p, cap)
        const maxPts = Math.max(p, cap);
        if (p * m > maxPts) m = maxPts / p;
      }
    }
    cache.set(code, m);
    return m;
  };
}

/** 倍率の表に「効く所」があるか（全部 1 なら渡す意味が無い＝渡さない） */
export function tableHasEffect(table: PrefWeightTable | null | undefined): boolean {
  if (!table) return false;
  for (const [f, lv] of Object.entries(table)) {
    if (!isPrefFamily(f)) continue;
    for (const m of Object.values(lv ?? {})) if (typeof m === "number" && m !== 1) return true;
  }
  return false;
}

/** 点（50＋Σ round(札の点 × 倍率)・0〜scoreMax）。property-brain.scoreFromCodes と同じ足し方（必須の × の上限20はここでは見ない） */
export function prefScoreOf(codes: ReadonlyArray<string>, base: (code: string) => number, weight: ((code: string) => number) | null | undefined, scoreMax: number = PREF_WEIGHT_CONFIG.scoreMax): number {
  let s = 50;
  for (const c of codes) s += weight ? Math.round(base(c) * weight(c)) : base(c);
  return Math.max(0, Math.min(scoreMax, s));
}

// ─── 測る ────────────────────────────────────────────────────────────────────

export type PrefRankMetrics = {
  episodes: number;
  /** 点の1位（👑）にスタッフの選んだ物がある率（同点は按分） */
  top1: number;
  /** 選んだ物の一番良い順位が3位以内・10位以内の率 */
  top3: number;
  top10: number;
  /** 選んだ物の相対順位の平均（0＝1位・でたらめ 0.5） */
  relRank: number;
  allTied: number;
};

/** 回ごとの倍率の関数（お客様の強さ × 表）を受け取り、スタッフの選んだ物の順位を測る */
export function prefRankMetrics(eps: ReadonlyArray<Episode>, base: (code: string) => number, resolverOf: (e: Episode) => ((code: string) => number) | null, scoreMax: number = PREF_WEIGHT_CONFIG.scoreMax): PrefRankMetrics {
  const list = usableEpisodes([...eps]);
  let top1 = 0, top3 = 0, top10 = 0, rel = 0, tied = 0;
  for (const e of list) {
    const w = resolverOf(e);
    const scored = e.cands.map((c) => ({ c, s: prefScoreOf(c.codes, base, w, scoreMax) }));
    const n = scored.length;
    const max = Math.max(...scored.map((x) => x.s));
    const atTop = scored.filter((x) => x.s === max);
    top1 += atTop.filter((x) => x.c.chosen).length / atTop.length;
    if (atTop.length === n) tied++;
    const unchosen = scored.filter((x) => !x.c.chosen);
    let bestPos = Infinity, relSum = 0, k = 0;
    for (const x of scored.filter((y) => y.c.chosen)) {
      const gt = scored.filter((y) => y !== x && y.s > x.s).length;
      const eq = scored.filter((y) => y !== x && y.s === x.s).length;
      bestPos = Math.min(bestPos, 1 + gt + eq / 2);
      const gtU = unchosen.filter((y) => y.s > x.s).length, eqU = unchosen.filter((y) => y.s === x.s).length;
      relSum += (gtU + eqU / 2) / unchosen.length; k++;
    }
    if (bestPos <= 3) top3++;
    if (bestPos <= 10) top10++;
    rel += relSum / k;
  }
  const N = list.length || 1;
  const r = (x: number) => +(x / N).toFixed(4);
  return { episodes: list.length, top1: r(top1), top3: r(top3), top10: r(top10), relRank: r(rel), allTied: tied };
}

/**
 * 通す／保留の 40点の線（property-brain.passLineScore）を、倍率で越えた候補の数（保留の札による保留は札が同じなので変わらない＝点の線だけ見る）。
 *   倍率は加点にしか掛けないので向きは「保留 → 通す」だけのはずだが、両方数える
 */
export function prefVerdictFlips(eps: ReadonlyArray<Episode>, base: (code: string) => number, resolverOf: (e: Episode) => ((code: string) => number) | null, scoreMax: number = PREF_WEIGHT_CONFIG.scoreMax): { toPass: number; toHold: number; candidates: number } {
  let toPass = 0, toHold = 0, candidates = 0;
  for (const e of eps) {
    const w = resolverOf(e);
    for (const c of e.cands) {
      candidates++;
      if (!w) continue;
      const b = passLineScore(c.codes, prefScoreOf(c.codes, base, null, scoreMax)) >= 40;
      const a = passLineScore(c.codes, prefScoreOf(c.codes, base, w, scoreMax)) >= 40;
      if (!b && a) toPass++;
      if (b && !a) toHold++;
    }
  }
  return { toPass, toHold, candidates };
}

// ─── 学ぶ ────────────────────────────────────────────────────────────────────

/** 回のお客様の見分け（build-customer-pref-episodes の customerKey＝物件顧客 ID の先頭8文字。無ければ id の2番目） */
export function customerKeyOf(e: Episode): string {
  return String((e as Episode & { customerKey?: string }).customerKey ?? e.id.split(":")[1] ?? e.id);
}

/** 1人のお客様から数える回を max まで（新しい方から）に絞る（並びは元の順） */
export function capRoundsPerCustomer(rounds: ReadonlyArray<Episode>, max: number): Episode[] {
  const keep = new Set<Episode>();
  const byCust = new Map<string, Episode[]>();
  for (const e of rounds) { const k = customerKeyOf(e); (byCust.get(k) ?? byCust.set(k, []).get(k)!).push(e); }
  for (const list of byCust.values()) for (const e of [...list].sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1)).slice(0, max)) keep.add(e);
  return rounds.filter((e) => keep.has(e));
}

/** 回 × 家族 → その回のお客様のこだわりの強さ */
export type StrengthOf = (e: Episode, family: string) => StrengthLevel;

/** その 条件 × 強さ で学べる回（お客様の強さが level で、選んだ物と選ばなかった物で「満たす／満たさない」が違う回） */
export function learnableRounds(eps: ReadonlyArray<Episode>, family: string, level: PrefLevel, strengthOf: StrengthOf): Episode[] {
  const out: Episode[] = [];
  for (const e of usableEpisodes([...eps])) {
    if (strengthOf(e, family) !== level) continue;
    const oks = e.cands.map((c) => familyOk(familiesOf(c.codes)[family]));
    const chosen = e.cands.map((c, i) => (c.chosen ? oks[i] : null)).filter((x): x is boolean => x != null);
    const other = e.cands.map((c, i) => (!c.chosen ? oks[i] : null)).filter((x): x is boolean => x != null);
    if (!chosen.length || !other.length) continue;
    if (chosen.some((a) => other.some((b) => a !== b))) out.push(e);
  }
  return out;
}

export type PrefWeightChange = { family: string; level: PrefLevel; from: number; to: number; rounds: number; relBefore: number; relAfter: number };
export type PrefLearnResult = {
  table: PrefWeightTable;
  changes: PrefWeightChange[];
  skipped: Array<{ family: string; level: PrefLevel; rounds: number; reason: string }>;
};

/** 表をコピーして1か所だけ変える */
function withMult(table: PrefWeightTable, family: string, level: PrefLevel, m: number): PrefWeightTable {
  return { ...table, [family]: { ...(table[family] ?? {}), [level]: m } };
}

/**
 * 倍率の表を学ぶ（決定論）。条件の種類 × 強さ を学べる回の多い順に、目盛りの候補（今の値 ±maxStep・minMult〜maxMult）から
 *   その 条件 × 強さ の学べる回で相対順位が一番良くなる倍率を選ぶ。良くなる量が minGain 未満なら動かさない。passes 回まわす。
 *   AD・条件でない札・書いていない条件（none）は学ばない
 */
export function learnPrefWeights(train: ReadonlyArray<Episode>, base: (code: string) => number, strengthOf: StrengthOf, current: PrefWeightTable | null = null, cfg: PrefWeightConfig = PREF_WEIGHT_CONFIG): PrefLearnResult {
  const eps = usableEpisodes([...train]);
  const families = new Set<string>();
  for (const e of eps) for (const c of e.cands) for (const k of c.codes) { const f = codeFamily(k); if (isPrefFamily(f) && !isFrozenCode(k)) families.add(f); }
  const cells: Array<{ family: string; level: PrefLevel; rounds: Episode[] }> = [];
  for (const f of [...families].sort()) for (const lv of ["strong", "stated"] as const) cells.push({ family: f, level: lv, rounds: capRoundsPerCustomer(learnableRounds(eps, f, lv, strengthOf), cfg.maxRoundsPerCustomer) });
  cells.sort((a, b) => b.rounds.length - a.rounds.length || a.family.localeCompare(b.family) || (a.level < b.level ? -1 : 1));

  let table: PrefWeightTable = JSON.parse(JSON.stringify(current ?? {}));
  const changes = new Map<string, PrefWeightChange>();
  const skipped: PrefLearnResult["skipped"] = [];
  const strengthMapOf = (e: Episode): StrengthMap => {
    const m: StrengthMap = {};
    for (const f of families) m[f] = strengthOf(e, f);
    return m;
  };
  const rel = (rounds: Episode[], t: PrefWeightTable) => prefRankMetrics(rounds, base, (e) => prefWeightResolver(strengthMapOf(e), t, cfg, base), cfg.scoreMax).relRank;

  for (let pass = 0; pass < cfg.passes; pass++) {
    for (const cell of cells) {
      const key = `${cell.family}|${cell.level}`;
      if (cell.rounds.length < cfg.minRounds) { if (pass === 0) skipped.push({ family: cell.family, level: cell.level, rounds: cell.rounds.length, reason: `件数不足（${cell.rounds.length}回 < ${cfg.minRounds}）` }); continue; }
      const people = new Set(cell.rounds.map(customerKeyOf)).size;
      if (people < cfg.minCustomers) { if (pass === 0) skipped.push({ family: cell.family, level: cell.level, rounds: cell.rounds.length, reason: `人数不足（${people}人 < ${cfg.minCustomers}）` }); continue; }
      const from = prefMultiplier(cell.family, cell.level, current, cfg);
      const cur = prefMultiplier(cell.family, cell.level, table, cfg);
      const before = rel(cell.rounds, table);
      let best = { m: cur, rel: before };
      const lo = clampMult(from - cfg.maxStep, cfg), hi = clampMult(from + cfg.maxStep, cfg);
      for (let m = cfg.minMult; m <= cfg.maxMult + 1e-9; m = r2(m + cfg.grid)) {
        if (m < lo - 1e-9 || m > hi + 1e-9 || Math.abs(m - cur) < 1e-9) continue;
        const rr = rel(cell.rounds, withMult(table, cell.family, cell.level, m));
        // 同じ良さなら 1 に近い方（動かさない方）
        if (rr < best.rel - 1e-9 || (Math.abs(rr - best.rel) < 1e-9 && Math.abs(m - 1) < Math.abs(best.m - 1))) best = { m, rel: rr };
      }
      const gain = +(before - best.rel).toFixed(4);
      if (best.m === cur || gain < cfg.minGain) {
        if (pass === 0 && !changes.has(key)) skipped.push({ family: cell.family, level: cell.level, rounds: cell.rounds.length, reason: best.m === cur ? "動かない（学んでも同じ順位）" : `良くなる量が小さい（${gain} < ${cfg.minGain}）` });
        continue;
      }
      table = withMult(table, cell.family, cell.level, best.m);
      changes.set(key, { family: cell.family, level: cell.level, from, to: best.m, rounds: cell.rounds.length, relBefore: changes.get(key)?.relBefore ?? before, relAfter: best.rel });
    }
  }
  return { table, changes: [...changes.values()], skipped };
}

// ─── 当て直し（学ぶ期間と確かめる期間を分ける・帯ごと） ──────────────────────

export type BandsOf = (e: Episode) => Record<string, string>;

/** 回の帯（お客様のこだわりの強さ・家賃の帯・新規／継続・材料）。build-customer-pref-episodes の出力（klass・meta）から */
export function defaultBandsOf(e: Episode & { klass?: string | null; meta?: { rentMax?: number | null; priorSends?: number | null } | null }): Record<string, string> {
  const rent = e.meta?.rentMax;
  const prior = e.meta?.priorSends;
  return {
    "こだわり": e.klass ?? "不明",
    "家賃": rent == null ? "不明" : rent < 70_000 ? "〜7万" : rent < 100_000 ? "7〜10万" : "10万〜",
    "新規/継続": prior == null ? "不明" : prior === 0 ? "新規" : "継続",
    "材料": e.source,
  };
}

export type BandResult = { band: string; value: string; n: number; base: PrefRankMetrics; weighted: PrefRankMetrics; gain: number; use: boolean; note: string };
export type PrefBacktest = {
  train: number; holdout: number;
  learned: PrefLearnResult;
  /** 確かめ用（新しい holdoutFrac）の全体 */
  base: PrefRankMetrics; weighted: PrefRankMetrics; gain: number;
  /** 学んだ期間（参考・学びに使った回なので良く出る） */
  trainBase: PrefRankMetrics; trainWeighted: PrefRankMetrics;
  bands: BandResult[];
  /** 確かめ用で通す／保留（40点の線）が変わった候補 */
  verdictFlips: { toPass: number; toHold: number; candidates: number };
  decision: { enable: boolean; reason: string };
};

/**
 * 過去で当て直す: 古い (1−holdoutFrac) で学び、新しい holdoutFrac で「実際に送った物件の順位」「👑が送った物件と一致する率」「10位以内の率」を
 *   今の点と比べる。帯ごとにも出し、悪くなる帯（n ≥ bandMinRounds で相対順位が bandTolerance を超えて悪化）が1つでもあれば使わない
 */
export type Splitter = (eps: Episode[], cfg: PrefWeightConfig) => { train: Episode[]; holdout: Episode[] };
/** 既定の分け方: 新しい holdoutFrac を確かめ用（scoring-learning.splitHoldout） */
export const splitByTime: Splitter = (eps, cfg) => splitHoldout(eps, cfg.holdoutFrac);
/**
 * お客様で分ける（時期で分けると、材料の揃う新しい回が全部確かめ用に寄る＝学ぶ期間に条件の札が無い・2026-09-29）。
 *   customerKey の文字の和 % folds === fold のお客様を確かめ用に（決定論）。同じお客様の回は学ぶ側と確かめ側に分かれない
 */
export const splitByCustomer = (fold: number, folds = 2): Splitter => (eps) => {
  const keyOf = customerKeyOf;
  const h = (k: string) => { let x = 0; for (const ch of k) x = (x * 31 + ch.charCodeAt(0)) % 1_000_003; return x; };
  const list = usableEpisodes(eps).slice().sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
  return { train: list.filter((e) => h(keyOf(e)) % folds !== fold), holdout: list.filter((e) => h(keyOf(e)) % folds === fold) };
};

export function backtestPrefWeights(eps: ReadonlyArray<Episode>, base: (code: string) => number, strengthOf: StrengthOf, bandsOf: BandsOf = defaultBandsOf as BandsOf, cfg: PrefWeightConfig = PREF_WEIGHT_CONFIG, current: PrefWeightTable | null = null, split: Splitter = splitByTime): PrefBacktest {
  const { train, holdout } = split([...eps], cfg);
  const learned = learnPrefWeights(train, base, strengthOf, current, cfg);
  const families = new Set<string>();
  for (const e of eps) for (const c of e.cands) for (const k of c.codes) { const f = codeFamily(k); if (isPrefFamily(f)) families.add(f); }
  const strengthMapOf = (e: Episode): StrengthMap => { const m: StrengthMap = {}; for (const f of families) m[f] = strengthOf(e, f); return m; };
  const baseResolver = (e: Episode) => (current ? prefWeightResolver(strengthMapOf(e), current, cfg, base) : null);
  const weightedResolver = (e: Episode) => prefWeightResolver(strengthMapOf(e), learned.table, cfg, base);
  const b = prefRankMetrics(holdout, base, baseResolver, cfg.scoreMax);
  const w = prefRankMetrics(holdout, base, weightedResolver, cfg.scoreMax);
  const tb = prefRankMetrics(train, base, baseResolver, cfg.scoreMax);
  const tw = prefRankMetrics(train, base, weightedResolver, cfg.scoreMax);
  const gain = +(b.relRank - w.relRank).toFixed(4);

  const bands: BandResult[] = [];
  const groups = new Map<string, Episode[]>();
  for (const e of holdout) for (const [band, value] of Object.entries(bandsOf(e))) { const k = `${band}|${value}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(e); }
  for (const [k, list] of [...groups].sort((x, y) => x[0].localeCompare(y[0]))) {
    const [band, value] = k.split("|");
    const bb = prefRankMetrics(list, base, baseResolver, cfg.scoreMax), ww = prefRankMetrics(list, base, weightedResolver, cfg.scoreMax);
    const g = +(bb.relRank - ww.relRank).toFixed(4);
    const enough = list.length >= cfg.bandMinRounds;
    const worse = enough && g < -cfg.bandTolerance;
    bands.push({ band, value, n: list.length, base: bb, weighted: ww, gain: g, use: enough && !worse && g > cfg.bandTolerance, note: !enough ? `回が少ない（${list.length} < ${cfg.bandMinRounds}）` : worse ? "悪くなる（使わない）" : g > cfg.bandTolerance ? "良くなる" : "変わらない" });
  }

  // 通す／保留の線: 今の点（current）→ 学んだ表 で変わる候補
  const flips = prefVerdictFlips(holdout, base, weightedResolver, cfg.scoreMax);
  const flipsBase = current ? prefVerdictFlips(holdout, base, baseResolver, cfg.scoreMax) : { toPass: 0, toHold: 0, candidates: flips.candidates };
  const verdictFlips = { toPass: Math.max(0, flips.toPass - flipsBase.toPass), toHold: Math.max(0, flips.toHold - flipsBase.toHold), candidates: flips.candidates };
  const worseBands = bands.filter((r) => r.note === "悪くなる（使わない）");

  let enable = false, reason: string;
  if (!learned.changes.length) reason = "学べる 条件 × 強さ が無い（件数・人数の不足か、動かしても順位が変わらない）";
  else if (holdout.length < cfg.minHoldout) reason = `確かめ用の回が少ない（${holdout.length} < ${cfg.minHoldout}）`;
  else if (gain < cfg.minGain) reason = `確かめ用で相対順位の改善が小さい（${gain} < ${cfg.minGain}）`;
  else if (w.top3 < b.top3 - cfg.top3Tolerance) reason = `確かめ用で3位以内の率が下がる（${b.top3} → ${w.top3}）`;
  else if (worseBands.length) reason = `悪くなる帯がある（${worseBands.map((r) => `${r.band}=${r.value} ${r.gain}`).join("・")}）`;
  else if (verdictFlips.toPass + verdictFlips.toHold > cfg.maxVerdictFlips) reason = `通す／保留が変わる候補がある（保留→通す ${verdictFlips.toPass}件・通す→保留 ${verdictFlips.toHold}件）`;
  else { enable = true; reason = `確かめ用で相対順位 ${b.relRank} → ${w.relRank}・👑一致 ${b.top1} → ${w.top1}・10位以内 ${b.top10} → ${w.top10}`; }
  return { train: train.length, holdout: holdout.length, learned, base: b, weighted: w, gain, trainBase: tb, trainWeighted: tw, bands, verdictFlips, decision: { enable, reason } };
}

// ─── 学んだ表・切り替え ───────────────────────────────────────────────────────

/**
 * 2026-09-29 の当て直し（scripts/backtest-customer-pref-weights.ts・400日・383回・109人）で学んだ表。
 *   結果: 空。時期で分けると変更なし、お客様で分けると片方だけ 間取り × stated ×1.25 が学ばれたが確かめ用で +0.001（線 0.01 未満）。
 *   反証レビューの後の当て直し（AD の線・人数の線・その回の時点の条件）では、どの分け方でも変更なし（上の見出しの ■ を参照）。
 *   表が空の間は prefWeightResolver は全部 ×1 ＝ 判定の点は今まで通り。次に材料が増えたら同スクリプトで当て直して、良くなった時だけここに書く
 */
export const LEARNED_PREF_WEIGHTS: PrefWeightTable = {};

/** 当て直しで「良くなる」と出た時だけ true（2026-09-29: 良くならないので false） */
export const PREF_WEIGHTS_DEFAULT_ON = false;

/** 使うか（環境変数 CUSTOMER_PREF_WEIGHTS: on＝使う・off＝使わない・無ければ PREF_WEIGHTS_DEFAULT_ON） */
export function prefWeightsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.CUSTOMER_PREF_WEIGHTS ?? "").trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true") return true;
  if (v === "off" || v === "0" || v === "false") return false;
  return PREF_WEIGHTS_DEFAULT_ON;
}

/** 判定に渡す倍率の関数（使わない・表に効く所が無い時は null＝今まで通り） */
export function prefWeightForJudge(strength: StrengthMap | null | undefined, table: PrefWeightTable = LEARNED_PREF_WEIGHTS, env?: Record<string, string | undefined>): ((code: string) => number) | null {
  if (!prefWeightsEnabled(env) || !tableHasEffect(table) || !strength) return null;
  return prefWeightResolver(strength, table);
}
// 注（2026-09-29 反証レビュー）: 判定の後で点を付け直す関数（applyImageFacts・applyEquipmentMatch・rejudgeWithoutDiscount・dropDiscountFromRow・
//   applyAdRulesToRow・applyRoomJoToRow 等・pickup-card-view.scoreGapNote）は prefWeight を受け取る。本番に繋ぐ時は、判定に渡した物と同じ関数を
//   全部に渡す（渡さないと倍率なしの点に静かに戻る・scoreGapNote は「今の配点では X点」を出す）
