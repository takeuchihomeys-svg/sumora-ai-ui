// app/lib/scoring-learning.ts
// 物件の点（judgeProperty の「50＋札の点の合計」）の重みを、スタッフが選んだ事実から毎週測って提案する純関数（DB・ネット・LLM に触れない）。
//
// 2026-09-25 竹内「自動的に学習されていく仕組みを作る。判定基準をより精度高くしていくために。データを積み重ねていけばかなり質高くなっていく」
//   正解は「スタッフが選んで送った事実」（🌟にした物件・送った物件。memory feedback_property_selection_label）。
//   お客様の反応は使わない（反応なしを外れと数えない）。
//
// ■ 形
//   1回（Episode）＝ スタッフが選んだ場面 1つ。候補（cands）のうち chosen=true がスタッフの選んだ物（1件以上）、false が選ばなかった物（1件以上）。
//   候補は「札（reasonCodes）」と「特徴（feats: 家賃比・徒歩・築年 等）」を持つ。点は 50＋Σ重み(札) で、重みを変えても札は変わらない
//   （judgeProperty の点は必ず 50＋札の点の合計＝property-brain.test.ts が確かめている）→ 札さえ残せば、どの重みでも点を付け直せる。
//
// ■ 決めたこと（動かさない所）
//   ・AD の重みは学習で弱めない（竹内さんの方針: AD 2ヶ月以上は高く・他の約1.3倍）。上げる向きだけ許す。
//     AD 以外の加点の札は「AD 2ヶ月の物件に付く AD の札の合計 ÷ 1.3」を超えて上げない（AD の段は判定で変わるので、呼ぶ側が judgeProperty で作って渡す）。
//   ・外す候補の札（送付済み・家賃の大幅超え）と、材料が無いだけの札（_UNKNOWN・_UNLISTED・要確認）は学ばない
//     （材料の欠けを学ぶと「データがある方が選ばれる」を覚えてしまう）。画像の札（IMAGE_*）は候補に材料が無いので学ばない。
//   ・1回に動かす量は ±MAX_STEP 点まで・動かす札は MAX_CHANGES 個まで・札の向き（加点／減点）は変えない。
//   ・最低件数: その札が「選んだ物と選ばなかった物で違う」回が MIN_EPISODES 回以上ある札だけ。
//   ・差がはっきりした札だけ: 回ごとの「選んだ方が札を持つ率」の平均が 0.5 から |z| ≥ MIN_Z 離れていて、学んだ向きと同じ札だけ。
//   ・確かめてから: 直近の HOLDOUT_FRAC を確かめ用に取っておき（学びに使わない）、そこで相対順位が MIN_GAIN 以上良くなり、
//     3位以内の率が悪くならない時だけ「当たりが良くなった」とする。

// ─── 型 ──────────────────────────────────────────────────────────────────────

export type EpisodeCandidate = {
  /** 候補の見分け（物件名＋号室 等・出力用） */
  key: string;
  chosen: boolean;
  /** judgeProperty の reasonCodes（点は 50＋Σ重み） */
  codes: string[];
  /** 特徴（null＝分からない）。数の大小で比べる */
  feats: Record<string, number | null>;
};

export type Episode = {
  id: string;
  /** 選んだ時刻（ISO）。確かめ用の取り分けは新しい順 */
  at: string;
  /** snapshot（🌟の時点の候補）／pickup（売上サポで送った物）／pool（拡張の回から送った物） */
  source: string;
  /** 条件の種類（low_initial・walk_want 等） */
  segments: string[];
  cands: EpisodeCandidate[];
};

/** 札 → 点（上書き分だけ持つ。無い札は base の点） */
export type WeightMap = Record<string, number>;

export type RankMetrics = {
  episodes: number;
  /** 点の1位にスタッフの選んだ物がある率（同点は按分） */
  top1: number;
  /** 選んだ物の一番良い順位（同点は平均）が3位以内の率 */
  top3: number;
  /** 選んだ物の相対順位の平均（0＝1位・1＝最下位・でたらめ 0.5） */
  relRank: number;
  /** でたらめに並べた時の1位率・3位以内率（比べる物差し） */
  randTop1: number;
  randTop3: number;
  /** 全候補が同点の回 */
  allTied: number;
};

// ─── 設定（動かす量・最低件数・切り替えの条件） ──────────────────────────────

export const LEARNING_CONFIG = {
  /** 点を比べる温度（点の差 10 で選ばれやすさ e 倍） */
  temperature: 10,
  /** 1回に動かす量の上限（点） */
  maxStep: 5,
  /** 1回に動かす札の数の上限 */
  maxChanges: 5,
  /** その札が「選んだ物と選ばなかった物で違う」回の最低数 */
  minEpisodes: 15,
  /** 回ごとの率の平均が 0.5 からどれだけ離れていれば「差がはっきり」か */
  minZ: 2.0,
  /** 確かめ用に取っておく直近の割合 */
  holdoutFrac: 0.25,
  /** 確かめ用の最低の回数（これ未満は提案しても「確かめられない」） */
  minHoldout: 20,
  /** 確かめ用で相対順位がこれ以上良くなった時だけ当たりが良くなったとする */
  minGain: 0.01,
  /** 3位以内の率の悪化の許容 */
  top3Tolerance: 0.0,
  /** 学ぶ回数（勾配の繰り返し・決定論） */
  iterations: 400,
  learningRate: 30,
  /** 今の重みへの引き戻し（大きいほど動かない） */
  l2: 0.0002,
  /** AD 2ヶ月以上の合計 ÷ これ ＝ AD 以外の加点の札の上限 */
  adPriorityRatio: 1.3,
} as const;
export type LearningConfig = { [K in keyof typeof LEARNING_CONFIG]: number };

/**
 * 自動で入れる条件（2026-09-25 時点は「提案だけ」＝ enabled は環境変数 SCORING_LEARNING_AUTO_APPLY=on の時だけ true）。
 * 件数がたまって安定したら切り替える: 全体の回数・確かめ用の回数が十分で、直前の週も「当たりが良くなった」提案だった時だけ。
 */
export const AUTO_APPLY_RULES = {
  minEpisodesTotal: 300,
  minHoldout: 75,
  /** 続けて「当たりが良くなった」週の数（今週を含む） */
  consecutiveAccepted: 2,
} as const;

// ─── 札の扱い（学ぶ札・動かさない札） ────────────────────────────────────────

/**
 * AD の札か（学習で弱めない）。AD_ で始まる札（段が増えても同じ扱い・AD_1_5M・AD_2_5M 等）と利益の札。
 *   AD_UNKNOWN（読めない）は材料の欠けなので学ばない（isFrozenCode）
 */
export function isAdCode(code: string): boolean {
  return (/^AD_/.test(code) && code !== "AD_UNKNOWN") || code === "PROFIT_NEGATIVE";
}
/** 既定の「AD 2ヶ月の物件に付く AD の札」（呼ぶ側が judgeProperty で作れない時の予備） */
export const DEFAULT_AD_TWO_MONTH_CODES = ["AD_HIGH", "AD_COVERS_DISCOUNT"];
/** 外す候補の決まりに関わる札（変えない） */
export const DROP_RULE_CODES = new Set(["ALREADY_SENT", "ALREADY_SENT_SAME_ROOM", "RENT_OVER_130"]);

/** 学ばない札か（外す候補・材料が無いだけ・情報の札・画像・上限の印） */
export function isFrozenCode(code: string): boolean {
  if (DROP_RULE_CODES.has(code)) return true;
  // 2026-09-25 竹内「AD 150%以上は1.15倍、200%以上は1.3倍と重みを付ける」: AD の段は竹内さんが決めた方針。学習では上げも下げもしない（提案の対象から外す）
  if (isAdCode(code)) return true;
  if (/_UNKNOWN$|_UNLISTED$|_ASK$|_OK_MAX$/.test(code)) return true;
  if (/^IMAGE_/.test(code)) return true;
  if (code === "EQUIP_MUST_NG_CAP" || code === "RENT_MAX_UNRELIABLE" || code === "COMMUTE_INFO" || code === "AD_UNKNOWN") return true;
  return false;
}

/** 札の点（上書き → base） */
export function weightOf(code: string, base: (code: string) => number, w: WeightMap | null | undefined): number {
  if (w && Object.prototype.hasOwnProperty.call(w, code)) return w[code];
  return base(code);
}

export function scoreOf(codes: string[], base: (code: string) => number, w?: WeightMap | null): number {
  let s = 50;
  for (const c of codes) s += weightOf(c, base, w);
  return s;
}

/**
 * その札が取ってよい範囲（今の点 from・動かす上限・向き・AD の方針）。
 *   adCap: AD 以外の加点の上限（AD 2ヶ月以上の合計 ÷ 1.3）
 */
export function boundsFor(code: string, from: number, cfg: Pick<LearningConfig, "maxStep">, adCap: number): { lo: number; hi: number } {
  const ad = isAdCode(code);
  let lo = from - cfg.maxStep, hi = from + cfg.maxStep;
  // 向きは変えない（加点の札は 0 未満にしない・減点の札は 0 を超えない・0 の札は動かさない＝学ぶ札ではない）
  if (from > 0) lo = Math.max(lo, 0);
  else if (from < 0) hi = Math.min(hi, 0);
  else { lo = 0; hi = 0; }
  // AD は弱めない
  if (ad && from > 0) lo = Math.max(lo, from);
  if (ad && from < 0) hi = Math.min(hi, from);
  // AD 以外の加点は「AD 2ヶ月の物件の AD の点の合計 ÷ 1.3」を超えない（今すでに超えている札は今の点まで）
  if (!ad && from > 0) hi = Math.min(hi, Math.max(from, Math.floor(adCap)));
  return { lo, hi: Math.max(lo, hi) };
}

// ─── 測る ────────────────────────────────────────────────────────────────────

/** 学びと測りに使える回（選んだ物と選ばなかった物が両方ある） */
export function usableEpisodes(eps: Episode[]): Episode[] {
  return eps.filter((e) => e.cands.some((c) => c.chosen) && e.cands.some((c) => !c.chosen));
}

/** 今の点で、スタッフの選んだ物の順位を測る */
export function rankMetrics(eps: Episode[], base: (code: string) => number, w?: WeightMap | null): RankMetrics {
  const list = usableEpisodes(eps);
  let top1 = 0, top3 = 0, rel = 0, r1 = 0, r3 = 0, tied = 0;
  for (const e of list) {
    const scored = e.cands.map((c) => ({ c, s: scoreOf(c.codes, base, w) }));
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
    rel += relSum / k;
    const nc = scored.length - unchosen.length;
    r1 += nc / n;
    // 選んだ物のどれかが3位以内に入る確率（でたらめ）＝ 1 − C(n−nc,3)/C(n,3)
    const m = Math.min(3, n);
    let miss = 1;
    for (let i = 0; i < m; i++) miss *= Math.max(0, (n - nc - i)) / (n - i);
    r3 += 1 - miss;
  }
  const N = list.length || 1;
  const r = (x: number) => +(x / N).toFixed(4);
  return { episodes: list.length, top1: r(top1), top3: r(top3), relRank: r(rel), randTop1: r(r1), randTop3: r(r3), allTied: tied };
}

export type PairStat = {
  /** 選んだ物と選ばなかった物で値が違った回 */
  episodes: number;
  /** 回ごとの「選んだ方が良い（札を持つ・値が良い）率」の平均 */
  winRate: number;
  /** 0.5 からの離れ（回ごとの率の平均の z） */
  z: number;
};

function summarize(rates: number[]): PairStat {
  const n = rates.length;
  if (!n) return { episodes: 0, winRate: 0.5, z: 0 };
  const mean = rates.reduce((a, x) => a + x, 0) / n;
  const varr = n > 1 ? rates.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) : 0.25;
  // 全部同じ率（分散0）の時は二項の分散（0.25）を下限にする（少ない回で z が無限にならない）
  const sd = Math.sqrt(Math.max(varr, 0.25 / Math.max(1, n)));
  return { episodes: n, winRate: +mean.toFixed(4), z: +((mean - 0.5) / (sd / Math.sqrt(n))).toFixed(3) };
}

/** 回の中で「選んだ方が良い率」（比べられる組が無ければ null） */
function episodeWin(e: Episode, better: (a: EpisodeCandidate, b: EpisodeCandidate) => number | null): number | null {
  let w = 0, k = 0;
  for (const a of e.cands) if (a.chosen) for (const b of e.cands) if (!b.chosen) {
    const r = better(a, b);
    if (r == null) continue;
    w += r; k++;
  }
  return k ? w / k : null;
}

/** 札ごと: 選んだ物と選ばなかった物で札の有無が違う組で、選んだ方が札を持つ率 */
export function codeStats(eps: Episode[]): Record<string, PairStat> {
  const codes = new Set<string>();
  for (const e of eps) for (const c of e.cands) for (const k of c.codes) codes.add(k);
  const out: Record<string, PairStat> = {};
  for (const code of [...codes].sort()) {
    const rates: number[] = [];
    for (const e of usableEpisodes(eps)) {
      const r = episodeWin(e, (a, b) => {
        const ha = a.codes.includes(code), hb = b.codes.includes(code);
        return ha === hb ? null : ha ? 1 : 0;
      });
      if (r != null) rates.push(r);
    }
    out[code] = summarize(rates);
  }
  return out;
}

/** 特徴の良い向き（low＝小さいほど良い・high＝大きいほど良い） */
export const FEATURE_DIRECTIONS: Record<string, "low" | "high"> = {
  rent_ratio: "low", walk: "low", building_age: "low", area_sqm: "high", zero_zero: "high", plan_match: "high",
  ad_months: "high", floor: "high", equipment_count: "high", equip_want_hits: "high", pool_rank: "low", score: "high",
  within_rent: "high", within_walk: "high", within_age: "high", new_build: "high",
};
export const FEATURE_JA: Record<string, string> = {
  rent_ratio: "家賃比（上限に対して・低いほど良い）", walk: "駅徒歩（短いほど良い）", building_age: "築年数（新しいほど良い）",
  area_sqm: "広さ（広いほど良い）", zero_zero: "敷礼0", plan_match: "間取りの一致（本命2・近い1・違う0）", ad_months: "AD（ヶ月）",
  floor: "階（高いほど）", equipment_count: "設備の語の数", equip_want_hits: "希望の設備に合う数", pool_rank: "拡張の並び順（上ほど）",
  score: "今の点", within_rent: "家賃が上限の110%以内", within_walk: "徒歩が希望内", within_age: "築年が希望内", new_build: "築浅（10年以内）",
};

/** 特徴ごと（全体）: 選んだ物と選ばなかった物で値が違う組で、選んだ方が良い率 */
export function featureStats(eps: Episode[]): Record<string, PairStat> {
  const out: Record<string, PairStat> = {};
  for (const f of Object.keys(FEATURE_DIRECTIONS)) {
    const dir = FEATURE_DIRECTIONS[f];
    const rates: number[] = [];
    for (const e of usableEpisodes(eps)) {
      const r = episodeWin(e, (a, b) => {
        const x = a.feats[f], y = b.feats[f];
        if (x == null || y == null || x === y) return null;
        return (dir === "low" ? x < y : x > y) ? 1 : 0;
      });
      if (r != null) rates.push(r);
    }
    out[f] = summarize(rates);
  }
  return out;
}

/** 条件の種類ごとの特徴（例: 初期費用を抑えたい人で敷礼0 を選ぶ率） */
export function segmentFeatureStats(eps: Episode[], minEpisodes = 5): Record<string, { episodes: number; features: Record<string, PairStat> }> {
  const segs = new Set<string>();
  for (const e of eps) for (const s of e.segments) segs.add(s);
  const out: Record<string, { episodes: number; features: Record<string, PairStat> }> = {};
  for (const s of [...segs].sort()) {
    const sub = usableEpisodes(eps.filter((e) => e.segments.includes(s)));
    if (sub.length < minEpisodes) continue;
    const fs = featureStats(sub);
    out[s] = { episodes: sub.length, features: Object.fromEntries(Object.entries(fs).filter(([, v]) => v.episodes >= minEpisodes)) };
  }
  return out;
}

// ─── 学ぶ ────────────────────────────────────────────────────────────────────

/** 確かめ用に取っておく（新しい順に holdoutFrac）。時刻が同じ時は id で決める（決定論） */
export function splitHoldout(eps: Episode[], frac: number = LEARNING_CONFIG.holdoutFrac): { train: Episode[]; holdout: Episode[] } {
  const list = usableEpisodes(eps).slice().sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
  const h = Math.floor(list.length * frac);
  return { train: list.slice(0, list.length - h), holdout: list.slice(list.length - h) };
}

export type WeightChange = { code: string; from: number; to: number; episodes: number; winRate: number; z: number };

export type Proposal = {
  /** 提案した変更（差がはっきりした札だけ・|z| の大きい順） */
  changes: WeightChange[];
  /** 提案の重み（上書き分・base に対して） */
  weights: WeightMap;
  /** 学んだが出さなかった札と理由（件数不足・差がはっきりしない・向きが合わない・上限） */
  skipped: Array<{ code: string; reason: string; episodes: number; winRate: number; z: number }>;
};

/**
 * 重みの提案（決定論）。条件付きロジット（選んだ物 vs 選ばなかった物の点の差）を、今の重みから小さく動かす。
 *   ① 学ぶ札 = 凍結でなく・今の点が 0 でなく・最低件数を満たす札
 *   ② 勾配を iterations 回（各回で範囲 boundsFor に押し込む・今の重みへ l2 で引き戻す）
 *   ③ 整数に丸め、|z| ≥ minZ で、動いた向きが「選んだ方が札を持つ率」の向きと同じ札だけ残す（多くて maxChanges）
 */
export function proposeWeights(train: Episode[], base: (code: string) => number, current: WeightMap | null, cfg: LearningConfig = LEARNING_CONFIG, adTwoMonthCodes: string[] = DEFAULT_AD_TWO_MONTH_CODES): Proposal {
  const eps = usableEpisodes(train);
  const stats = codeStats(eps);
  const w0 = (c: string) => weightOf(c, base, current);
  const adCap = adTwoMonthCodes.reduce((a, c) => a + Math.max(0, w0(c)), 0) / cfg.adPriorityRatio;
  const skipped: Proposal["skipped"] = [];
  const learn: string[] = [];
  for (const [code, st] of Object.entries(stats)) {
    if (isFrozenCode(code)) continue;
    if (w0(code) === 0) continue;
    if (st.episodes < cfg.minEpisodes) { skipped.push({ code, reason: `件数不足（${st.episodes}回 < ${cfg.minEpisodes}）`, ...st }); continue; }
    learn.push(code);
  }
  const w: Record<string, number> = Object.fromEntries(learn.map((c) => [c, w0(c)]));
  const bounds = Object.fromEntries(learn.map((c) => [c, boundsFor(c, w0(c), cfg, adCap)]));
  const T = cfg.temperature;
  const fixedScore = (codes: string[]) => { let s = 50; for (const c of codes) if (!(c in w)) s += w0(c); return s; };
  // 候補ごとの固定分（学ばない札の点）を先に計算
  const pre = eps.map((e) => e.cands.map((c) => ({ c, fixed: fixedScore(c.codes), learnCodes: c.codes.filter((k) => k in w) })));
  for (let it = 0; it < cfg.iterations && learn.length; it++) {
    const grad: Record<string, number> = Object.fromEntries(learn.map((c) => [c, 0]));
    for (const cs of pre) {
      const s = cs.map((x) => x.fixed + x.learnCodes.reduce((a, k) => a + w[k], 0));
      const un = cs.map((x, i) => ({ x, i })).filter((y) => !y.x.c.chosen);
      for (let i = 0; i < cs.length; i++) {
        if (!cs[i].c.chosen) continue;
        // 選んだ物 i ＋ 選ばなかった物 の中での softmax
        const group = [i, ...un.map((y) => y.i)];
        const mx = Math.max(...group.map((j) => s[j] / T));
        const ex = group.map((j) => Math.exp(s[j] / T - mx));
        const Z = ex.reduce((a, x) => a + x, 0);
        const nChosen = cs.filter((x) => x.c.chosen).length;
        for (const k of cs[i].learnCodes) grad[k] += 1 / T / nChosen;
        group.forEach((j, gi) => { const p = ex[gi] / Z; for (const k of cs[j].learnCodes) grad[k] -= p / T / nChosen; });
      }
    }
    for (const k of learn) {
      const g = grad[k] / eps.length - 2 * cfg.l2 * (w[k] - w0(k));
      w[k] = Math.min(bounds[k].hi, Math.max(bounds[k].lo, w[k] + cfg.learningRate * g));
    }
  }
  const cands: WeightChange[] = [];
  for (const code of learn) {
    const to = Math.round(w[code]);
    const from = w0(code);
    const st = stats[code];
    if (to === from) { skipped.push({ code, reason: "動かない（学んでも同じ点）", ...st }); continue; }
    if (Math.abs(st.z) < cfg.minZ) { skipped.push({ code, reason: `差がはっきりしない（|z| ${Math.abs(st.z)} < ${cfg.minZ}）`, ...st }); continue; }
    if ((to > from) !== (st.winRate > 0.5)) { skipped.push({ code, reason: "学んだ向きと選ばれる率の向きが合わない（他の札との重なり）", ...st }); continue; }
    cands.push({ code, from, to, ...st });
  }
  cands.sort((a, b) => Math.abs(b.z) - Math.abs(a.z) || (a.code < b.code ? -1 : 1));
  const changes = cands.slice(0, cfg.maxChanges);
  for (const c of cands.slice(cfg.maxChanges)) skipped.push({ code: c.code, reason: `1回に動かす札の上限（${cfg.maxChanges}個）`, episodes: c.episodes, winRate: c.winRate, z: c.z });
  const weights: WeightMap = { ...(current ?? {}) };
  for (const c of changes) weights[c.code] = c.to;
  return { changes, weights, skipped };
}

export type Evaluation = {
  base: RankMetrics;
  proposed: RankMetrics;
  /** 確かめ用で当たりが良くなったか */
  improved: boolean;
  reason: string;
};

/** 確かめ用の回で、今の重みと提案の重みを比べる */
export function evaluateProposal(holdout: Episode[], base: (code: string) => number, current: WeightMap | null, proposed: WeightMap, cfg: LearningConfig = LEARNING_CONFIG): Evaluation {
  const b = rankMetrics(holdout, base, current);
  const p = rankMetrics(holdout, base, proposed);
  if (b.episodes < cfg.minHoldout) return { base: b, proposed: p, improved: false, reason: `確かめ用の回が少ない（${b.episodes} < ${cfg.minHoldout}）` };
  const gain = +(b.relRank - p.relRank).toFixed(4);
  if (gain < cfg.minGain) return { base: b, proposed: p, improved: false, reason: `相対順位の改善が小さい（${gain} < ${cfg.minGain}）` };
  if (p.top3 < b.top3 - cfg.top3Tolerance) return { base: b, proposed: p, improved: false, reason: `3位以内の率が下がる（${b.top3} → ${p.top3}）` };
  return { base: b, proposed: p, improved: true, reason: `相対順位 ${b.relRank} → ${p.relRank}・3位以内 ${b.top3} → ${p.top3}` };
}

/**
 * 自動で入れてよいか（提案だけの間は enabled=false で常に false）。
 *   prevAccepted: 直前の週から続けて「当たりが良くなった」週の数（今週を含まない）
 */
export function decideAutoApply(input: {
  enabled: boolean; improved: boolean; episodesTotal: number; holdout: number; prevAccepted: number; changes: number;
}, rules = AUTO_APPLY_RULES): { apply: boolean; reason: string } {
  if (!input.improved || input.changes === 0) return { apply: false, reason: "提案なし・または当たりが良くならない" };
  if (!input.enabled) return { apply: false, reason: "提案だけ（SCORING_LEARNING_AUTO_APPLY が on でない）" };
  if (input.episodesTotal < rules.minEpisodesTotal) return { apply: false, reason: `回数が少ない（${input.episodesTotal} < ${rules.minEpisodesTotal}）` };
  if (input.holdout < rules.minHoldout) return { apply: false, reason: `確かめ用が少ない（${input.holdout} < ${rules.minHoldout}）` };
  if (input.prevAccepted + 1 < rules.consecutiveAccepted) return { apply: false, reason: `続けて良くなった週が足りない（${input.prevAccepted + 1} < ${rules.consecutiveAccepted}）` };
  return { apply: true, reason: "件数・確かめ用・続けて良くなった週の条件を満たした" };
}

// ─── 版 ──────────────────────────────────────────────────────────────────────

export type WeightVersion = { version: number; status: "proposed" | "active" | "retired" | "rejected"; weights: WeightMap; created_at?: string };

/** 版の一覧から今の重み（active は1つ・無ければ null＝コードの既定） */
export function activeWeights(versions: WeightVersion[]): WeightVersion | null {
  const act = versions.filter((v) => v.status === "active").sort((a, b) => b.version - a.version);
  return act[0] ?? null;
}

/**
 * 版を切り替えた後の状態（純関数）。target=0 はコードの既定に戻す（active を無くす）。
 *   切り替えた版は active、それまでの active は retired。proposed・rejected はそのまま
 */
export function switchVersion(versions: WeightVersion[], target: number): WeightVersion[] {
  if (target !== 0 && !versions.some((v) => v.version === target)) throw new Error(`版 ${target} がありません`);
  return versions.map((v) => {
    if (v.version === target) return { ...v, status: "active" as const };
    if (v.status === "active") return { ...v, status: "retired" as const };
    return v;
  });
}

/** 前の版に戻す先（今の active より前で、一番新しい retired。無ければ 0＝コードの既定） */
export function previousVersion(versions: WeightVersion[]): number {
  const cur = activeWeights(versions);
  if (!cur) return 0;
  const prev = versions.filter((v) => v.status === "retired" && v.version < cur.version).sort((a, b) => b.version - a.version)[0];
  return prev?.version ?? 0;
}

/** 重みの上書きの形を確かめる（DB から読んだ物を使う前に。壊れていれば null＝今の定数のまま） */
export function sanitizeWeights(raw: unknown, maxAbs = 60): WeightMap | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: WeightMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Z0-9_]{2,64}$/.test(k)) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > maxAbs) return null;
    if (DROP_RULE_CODES.has(k)) continue; // 外す候補の札は版でも変えない
    out[k] = Math.round(v);
  }
  return out;
}
