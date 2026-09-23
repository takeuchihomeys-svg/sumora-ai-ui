// app/lib/property-brain.ts
// 物件検索ブレイン（純関数・DB 依存なし）。
//
// 2026-09-23 竹内「Deepsheekで物件検索のブレインをつくる。敷金礼金0円や初期費用抑えたいひとは敷金礼金0でADも高くて、
//   割引が出来るお部屋で。お客さんの理想の条件のお部屋なら決まる等。…AD−見積書の割引金額が利益となるから利益面も理解できるようにする」
//
// ■ 何をするか
//   拡張が集めた物件（リアプロの表の文字＝説明文）と、お客様の条件・過去にスタッフが送った物件の傾向・見積書の割引額を
//   突き合わせて、物件ごとに pass（通す）／hold（保留・送るが印を付ける）／drop（外す候補）と点数・理由コードを出す。
//   判定は**全部決定論**（LLM は使わない）。画像（間取り図）から取る有無だけ別ファイル（property-brain-image.ts）が DeepSeek で読み、
//   applyImageFacts で足す。
//
// ■ 線は実データから（2026-09-23 の実測・365日）
//   - 物件オススメ（🌟）の 56% が敷礼0の語。「初期費用を抑えたい」お客様へは 68.6%（それ以外 49.8%）
//     ＝ 敷礼0 は最強の軸だが**過半にとどまる**ので、敷礼ありは hold（送るが印）であって drop ではない。
//   - 家賃/rent_max の中央値 0.84〜0.89。110% 超は 2〜3%…だが実送信で **0 にはならない**（>1.10 が 57件・>1.30 が 29件）。
//     しかもその 52件は1人（3日で123件・別のお客様と同じ物件が29件＝別人の検索が混ざった疑い）と
//     rent_max < rent_min のフォーム入力誤りの人に集中している。
//     → 家賃は「上限の異常値を捨てる」規則を先に置き、超過は hold。**1.30 超だけ drop 候補**（それでも影の運用では落とさない）。
//   - 間取り: 候補の間取りが希望文に含まれないのが 17〜21%（1LDK希望→1DK が 1,465件、2LDK・3LDK希望→1K が 512件）。
//     希望文は「1LDK以上」「2LDK〜」「1K.1DK.1LDK」「1LDKか2LDK」「30平米以上」の自由文なので、範囲・集合に正規化してから比べる。
//     不一致は hold 止まり（drop にすると実送信の 17% を落とす）。
//   - AD: 取れた分の分布は 1ヶ月 13%／2ヶ月 45%／3ヶ月以上 42%。AD=0 は一度も記録されていない（書式の取りこぼしと区別できない）
//     → **不明は減点しない**。AD が高い物件は加点（竹内「ADちゃんと高い物件か」）。
//   - 割引: AIX【見積書送る】本文の「N円割引」は中央値 42,000円（Q1 28,000／Q3 68,000・213通）。
//     estimate_action_log は 0行（書き手も無い）ので使わない。利益 = AD円 − 割引 で、負なら hold（落とさない）。
//
// ■ 出口の原則（設計知見「出口の決定論」「誤削除0」）
//   drop は「実送信でほぼ0の形」だけ: 送付済みの建物・家賃比 1.30 超（上限が正しい時だけ）。
//   それ以外は hold。hold は送る（印を付けるだけ）。
//   影の運用（既定）では drop も落とさず印だけ＝誤削除の実測が溜まってから PROPERTY_BRAIN_DROP=on にする。

import { parseRentFromSummary, parseWalkMinutesFromSummary } from "./property-summary-parse";

// ─── 型 ──────────────────────────────────────────────────────────────────────

/** リアプロの表の文字（説明文）から読んだ事実。取れない項目は null（不明は減点しない） */
export type PropertyFacts = {
  name: string;
  rank: number | null;
  rentYen: number | null;
  adminFeeYen: number | null;
  /** 敷金（ヶ月）。「なし」= 0。不明 = null */
  depositMonths: number | null;
  /** 礼金（ヶ月）。「なし」= 0。不明 = null */
  keyMoneyMonths: number | null;
  adMonths: number | null;
  /** 表に円で書いてある AD（「AD 100,000円」）。ヶ月表記の時は null */
  adYen: number | null;
  walkMinutes: number | null;
  floorPlan: string | null;
  /** 築年数（新築 = 0）。不明 = null */
  buildingAge: number | null;
  rawText: string;
};

/** 拡張の buildPropertyData が付けてくる構造化データ（あれば説明文の読みを補う） */
export type PropertyDataLike = {
  rank?: number | null;
  name?: string | null;
  rent?: number | null;
  floor_plan?: string | null;
  walk_minutes?: number | null;
  ad_months?: number | null;
  ad_yen?: number | null;
  deposit_months?: number | null;
  key_money_months?: number | null;
};

/** 間取りの希望（自由文を正規化した物） */
export type FloorPlanWant = {
  /** 希望なし・読めない → 何でも一致 */
  any: boolean;
  /** 列挙された間取り（正規形 "1LDK" など） */
  plans: string[];
  /** 「1LDK以上」「2LDK〜」の下限（rankFloorPlan の値） */
  minRank: number | null;
  /** 「1DK〜2K」の上限 */
  maxRank: number | null;
  /** 「30平米以上」 */
  sqmMin: number | null;
  raw: string;
};

/** 画像（間取り図）でしか分からない希望。true/false/null（読めない） */
export type ImageWantKey = "bath_toilet_separate" | "separate_washstand" | "storage" | "south_facing" | "floor_2_plus";
export type ImageFacts = Partial<Record<ImageWantKey, boolean | null>>;

export type CustomerLike = {
  rent_max?: number | null;
  max_rent?: number | null;
  rent_min?: number | null;
  floor_plan?: string | null;
  layout?: string | null;
  walk_minutes?: number | null;
  building_age?: number | null;
  initial_cost_limit?: number | null;
  preferences?: string | null;
  ng_points?: string | null;
  other_requests?: string | null;
  additional_conditions?: string | null;
  pet?: boolean | null;
};

export type SentRowLike = { property_name?: string | null; rent?: number | null };
export type PatternRowLike = { selling_points?: string[] | null; selection_label?: string | null };

export type CustomerProfile = {
  /** 使ってよい上限（異常値なら null） */
  rentMax: number | null;
  /** rentMax を捨てた理由（RENT_MAX_UNRELIABLE など） */
  notes: string[];
  floorPlanWant: FloorPlanWant;
  walkMax: number | null;
  buildingAgeMax: number | null;
  initialCostLimit: number | null;
  wantsLowInitialCost: boolean;
  /** wantsLowInitialCost の出所（form / history / none） */
  lowInitialCostSource: "form" | "history" | "none";
  pet: boolean;
  imageWants: ImageWantKey[];
  history: {
    sentCount: number;
    sentBuildings: Set<string>;
    /** 過去に送った物件の 家賃/rentMax の中央値（材料が無ければ null） */
    rentRatioMedian: number | null;
    sellingPointsSelected: Record<string, number>;
  };
  discountYen: number;
  confidence: "high" | "mid" | "low";
};

export type Verdict = "pass" | "hold" | "drop";

export type Judgment = {
  index: number;
  rank: number | null;
  name: string;
  verdict: Verdict;
  score: number;
  reasonCodes: string[];
  /** hold / drop にした理由コードだけ（LINE の1行はこれを先に見せる） */
  flagCodes: string[];
  /** 理由の短い日本語（外す・保留の理由が先・良い点が後） */
  reasonsJa: string[];
  confidence: "high" | "mid" | "low";
  missing: string[];
  adYen: number | null;
  profitYen: number | null;
  /** 画像で確かめたい希望（あれば画像の読み取りに回す） */
  imageChecks: ImageWantKey[];
  facts: PropertyFacts;
};

// ─── 定数 ────────────────────────────────────────────────────────────────────

/**
 * 見積書の割引額の既定値（円）。
 * 出所: aix_usage_logs（aix_type=estimate_sheet）の本文「N円割引」213通の中央値（2026-09-23 実測・Q1 28,000／Q3 68,000）。
 * お客様ごとの実物が取れた時はそれを使う。
 */
export const DEFAULT_DISCOUNT_YEN = 42_000;
/** これ未満の rent_max はフォームの入力誤りとみなして使わない（実データ: rent_max 22,000 < rent_min 50,000 の人がいた） */
export const RENT_MAX_SANE_MIN = 30_000;
/** 家賃比の線（実データ: >1.10 は 3.5%・>1.30 は 1.8%。どちらも0ではないので hold／drop候補 に留める） */
export const RENT_RATIO_HOLD = 1.10;
export const RENT_RATIO_DROP = 1.30;

export const REASON_JA: Record<string, string> = {
  RENT_OK: "家賃は上限内",
  RENT_SLIGHTLY_OVER: "家賃が上限を1割まで超過",
  RENT_OVER_110: "家賃が上限を1割超",
  RENT_OVER_130: "家賃が上限を3割超",
  RENT_ABOVE_USUAL: "このお客様に送ってきた家賃帯より高め",
  RENT_UNKNOWN: "家賃が読めない",
  RENT_MAX_UNRELIABLE: "家賃上限が使えない（入力誤りの疑い）",
  ZERO_ZERO_MATCH: "敷礼0（初期費用を抑えたい希望に一致）",
  ZERO_ZERO: "敷礼0",
  INITIAL_COST_NOT_ZERO: "敷金か礼金あり（初期費用を抑えたい希望）",
  INITIAL_COST_OVER_LIMIT: "敷礼が初期費用の上限を超える",
  INITIAL_COST_UNKNOWN: "敷礼が読めない",
  FLOOR_PLAN_MATCH: "間取り一致",
  FLOOR_PLAN_NEAR: "間取りが近い（部屋数は同じ）",
  FLOOR_PLAN_MISMATCH: "間取りが希望と違う",
  WALK_OK: "徒歩は希望内",
  WALK_SLIGHTLY_OVER: "徒歩が希望を少し超過",
  WALK_OVER: "徒歩が希望の1.5倍超",
  BUILDING_AGE_OK: "築年は希望内",
  BUILDING_AGE_SLIGHTLY_OVER: "築年が希望を少し超過",
  BUILDING_AGE_OVER: "築年が希望超過",
  ALREADY_SENT: "この建物は送付済み",
  AD_UNKNOWN: "ADが読めない",
  AD_HIGH: "ADが高い（2ヶ月以上）",
  AD_COVERS_DISCOUNT: "ADで割引をまかなえる",
  PROFIT_NEGATIVE: "ADより割引が大きい（利益が出ない）",
  PET_NG: "ペット不可の記載",
  IMAGE_BATH_TOILET_SEPARATE_OK: "バストイレ別（間取り図）",
  IMAGE_BATH_TOILET_SEPARATE_NG: "バストイレ別でない（間取り図）",
  IMAGE_SEPARATE_WASHSTAND_OK: "独立洗面あり（間取り図）",
  IMAGE_SEPARATE_WASHSTAND_NG: "独立洗面なし（間取り図）",
  IMAGE_STORAGE_OK: "収納あり（間取り図）",
  IMAGE_STORAGE_NG: "収納なし（間取り図）",
  IMAGE_SOUTH_FACING_OK: "南向き（間取り図）",
  IMAGE_SOUTH_FACING_NG: "南向きでない（間取り図）",
  IMAGE_FLOOR_2_PLUS_OK: "2階以上（資料）",
  IMAGE_FLOOR_2_PLUS_NG: "1階（資料）",
};

// ─── 小さな道具 ──────────────────────────────────────────────────────────────

function toHalfWidth(s: string): string {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ．，]/g, (c) => {
    if (c === "．") return ".";
    if (c === "，") return ",";
    return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
  });
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 建物名の正規化（【N】・空白・全角英数を落とす）。送付済みの照合に使う */
export function normalizeBuildingName(name: string | null | undefined): string {
  return toHalfWidth(String(name ?? ""))
    .replace(/^【\d+】\s*/u, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 「Nヶ月」「なし」「－」→ ヶ月。読めなければ null */
export function parseMonths(t: string | null | undefined): number | null {
  if (t == null) return null;
  const s = toHalfWidth(String(t)).trim();
  if (s === "なし" || s === "無し" || s === "－" || s === "-" || s === "0" || s === "無") return 0;
  const m = s.match(/(\d+(?:\.\d+)?)\s*[ヶかカケ]?\s*月/);
  return m ? parseFloat(m[1]) : null;
}

// ─── 説明文 → 事実 ───────────────────────────────────────────────────────────

/**
 * 拡張の説明文（buildPropertySummary の形）から事実を読む。
 *   【N】物件名
 *   58,000円（家賃のセルの文字そのまま。管理費が並ぶことがある）
 *   1K
 *   敷1ヶ月 礼なし
 *   ○○駅 徒歩5分
 *   AD 2ヶ月
 * 行の位置ではなく中身で探す。data（buildPropertyData）があれば補う。
 */
export function parsePropertyFacts(summary: string | null | undefined, data?: PropertyDataLike | null): PropertyFacts {
  const raw = String(summary ?? "");
  const lines = raw.split("\n").map((l) => toHalfWidth(l).trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const rankM = first.match(/^【(\d+)】/);
  const name = first.replace(/^【\d+】\s*/u, "").trim() || String(data?.name ?? "") || "物件";
  const rest = lines.slice(1);
  const restText = rest.join("\n");

  // 家賃・管理費
  const rentYen = num(data?.rent) ?? parseRentFromSummary(raw);
  let adminFeeYen: number | null = null;
  const adm = restText.replace(/,/g, "").match(/(?:管理費|共益費)\s*[:：]?\s*(\d+)\s*円/);
  if (adm) adminFeeYen = parseInt(adm[1], 10);

  // 敷金・礼金（「敷1ヶ月 礼なし」「敷金 なし 礼金 1ヶ月」「敷0 礼0」）
  let depositMonths = num(data?.deposit_months);
  let keyMoneyMonths = num(data?.key_money_months);
  const dk = restText.match(/敷(?:金)?\s*[:：]?\s*(なし|無し|－|-|\d+(?:\.\d+)?\s*[ヶかカケ]?月|\d+)\s*[\/／ ]*\s*礼(?:金)?\s*[:：]?\s*(なし|無し|－|-|\d+(?:\.\d+)?\s*[ヶかカケ]?月|\d+)/);
  if (dk) {
    if (depositMonths == null) depositMonths = parseMonths(dk[1]);
    if (keyMoneyMonths == null) keyMoneyMonths = parseMonths(dk[2]);
  }

  // AD（「AD 2ヶ月」「AD 0.5ヶ月」「AD 100,000円」「広告料 1ヶ月」）
  let adMonths = num(data?.ad_months);
  let adYen = num(data?.ad_yen);
  const adLine = rest.find((l) => /^(AD|広告料)/i.test(l));
  if (adLine) {
    const m = adLine.match(/(\d+(?:\.\d+)?)\s*[ヶかカケ]?\s*月/);
    const y = adLine.replace(/,/g, "").match(/(\d+)\s*円/);
    if (m && adMonths == null) adMonths = parseFloat(m[1]);
    else if (!m && y && adYen == null) adYen = parseInt(y[1], 10);
  }
  // 拡張の itandi 側の変換ミス（「AD 30,000円」→ ad_months=30）は物理的にありえない値として捨てる
  if (adMonths != null && adMonths > 12) adMonths = null;

  const walkMinutes = num(data?.walk_minutes) ?? parseWalkMinutesFromSummary(raw);

  // 間取り（名前の行は見ない）
  let floorPlan: string | null = data?.floor_plan ? normalizeFloorPlanToken(String(data.floor_plan)) : null;
  if (!floorPlan) {
    for (const l of rest) {
      const fp = normalizeFloorPlanToken(l);
      if (fp) { floorPlan = fp; break; }
    }
  }

  // 築年
  let buildingAge: number | null = null;
  const age = restText.match(/築\s*(\d+)\s*年/);
  if (age) buildingAge = parseInt(age[1], 10);
  else if (/新築/.test(restText)) buildingAge = 0;

  return {
    name, rank: rankM ? parseInt(rankM[1], 10) : num(data?.rank),
    rentYen, adminFeeYen, depositMonths, keyMoneyMonths, adMonths, adYen, walkMinutes, floorPlan, buildingAge,
    rawText: raw,
  };
}

// ─── 間取り ──────────────────────────────────────────────────────────────────

const PLAN_TYPES = ["R", "K", "DK", "LDK"] as const;
const TYPE_INDEX: Record<string, number> = { R: 0, K: 1, DK: 2, LDK: 3, SK: 1, SDK: 2, SLDK: 3 };

/** 文字列の中の最初の間取りを正規形（"1LDK"）で返す。S 付き（1SLDK）は S を落として 1LDK 扱い */
export function normalizeFloorPlanToken(s: string | null | undefined): string | null {
  const t = toHalfWidth(String(s ?? "")).toUpperCase().replace(/ワンルーム|1ルーム|１ルーム/g, "1R");
  const m = t.match(/([1-9])\s*(SLDK|LDK|SDK|DK|SK|K|R)(?![A-Z])/);
  if (!m) return null;
  const type = m[2].replace(/^S(?=.)/, "");
  return `${m[1]}${type}`;
}

/** 間取りを順序（部屋数×10＋種別）にする。比較用 */
export function rankFloorPlan(plan: string | null | undefined): number | null {
  const p = normalizeFloorPlanToken(plan);
  if (!p) return null;
  const rooms = parseInt(p[0], 10);
  const type = p.slice(1);
  const ti = TYPE_INDEX[type];
  if (ti == null) return null;
  return rooms * 10 + ti;
}

/**
 * お客様の希望（自由文）を範囲・集合に正規化する。
 * 実データの形: 「1LDK」「1LDK以上」「2LDK〜」「1K.1DK.1LDK」「1LDKか2LDK」「1LDK　2DK 2LDK」「1DK〜2K」
 *               「30平米以上」「1LDK以上、33平米以上」「希望なし」「3LDK(厳しければ2LDK)」「1K(7畳)以上」
 */
export function normalizeFloorPlanWant(text: string | null | undefined): FloorPlanWant {
  const raw = String(text ?? "");
  const t = toHalfWidth(raw).toUpperCase().replace(/ワンルーム|1ルーム/g, "1R");
  const out: FloorPlanWant = { any: false, plans: [], minRank: null, maxRank: null, sqmMin: null, raw };
  const sq = t.match(/(\d+)\s*(平米|㎡|M2)\s*以上/);
  if (sq) out.sqmMin = parseInt(sq[1], 10);

  const re = /([1-9])\s*(SLDK|LDK|SDK|DK|SK|K|R)(?![A-Z])/g;
  const found: Array<{ plan: string; end: number; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const plan = normalizeFloorPlanToken(m[0]);
    if (plan) found.push({ plan, start: m.index, end: m.index + m[0].length });
  }
  if (found.length === 0) { out.any = true; return out; }

  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    const after = t.slice(f.end, f.end + 12);
    const r = rankFloorPlan(f.plan);
    // 「1LDK以上」「1LDK〜」「1K(7畳)以上」
    if (/^\s*(\([^)]*\))?\s*(以上|〜|～|~|-|から)/.test(after) && r != null) {
      const next = found[i + 1];
      const between = next ? t.slice(f.end, next.start) : "";
      // 「1DK〜2K」= 範囲。「〜」の直後に別の間取りがあれば上限
      if (next && /^\s*(〜|～|~|-|から)\s*$/.test(between)) {
        out.minRank = out.minRank == null ? r : Math.min(out.minRank, r);
        const r2 = rankFloorPlan(next.plan);
        if (r2 != null) out.maxRank = out.maxRank == null ? r2 : Math.max(out.maxRank, r2);
        if (!out.plans.includes(f.plan)) out.plans.push(f.plan);
        if (!out.plans.includes(next.plan)) out.plans.push(next.plan);
        i++;
        continue;
      }
      out.minRank = out.minRank == null ? r : Math.min(out.minRank, r);
    }
    if (!out.plans.includes(f.plan)) out.plans.push(f.plan);
  }
  return out;
}

export type FloorPlanMatch = "match" | "near" | "mismatch" | "unknown";

export function matchFloorPlan(want: FloorPlanWant, plan: string | null | undefined): FloorPlanMatch {
  const p = normalizeFloorPlanToken(plan);
  if (!p || want.any) return "unknown";
  if (want.plans.includes(p)) return "match";
  const r = rankFloorPlan(p);
  if (r != null && want.minRank != null && r >= want.minRank && (want.maxRank == null || r <= want.maxRank)) return "match";
  // 部屋数が同じなら「近い」（実データ: 1LDK 希望に 1DK を 1,465件送っている）
  const rooms = parseInt(p[0], 10);
  const wantRooms = want.plans.map((w) => parseInt(w[0], 10));
  if (wantRooms.includes(rooms)) return "near";
  if (want.minRank != null && rooms >= Math.floor(want.minRank / 10)) return "near";
  return "mismatch";
}

// ─── お客様の希望の読み取り ───────────────────────────────────────────────────

const LOW_INITIAL_COST_RE = /敷金礼金|敷礼|敷金.{0,3}礼金|ゼロゼロ|フリーレント|初期費用.{0,14}(抑え|おさえ|安く|少な|なし|無し|0円|ゼロ|かからない|安い|削減|限度額)|(抑え|安く|安い).{0,8}初期費用|初期費用.{0,4}(できるだけ|なるべく|極力)/;
/** これがある欄は「抑えたい」ではない（実データ: 「敷金礼金の負担がさらに増えてもよい」「初期費用はまだ考えていない」） */
const LOW_INITIAL_COST_NEG_RE = /増えてもよい|増えても良い|こだわらない|気にしない|まだ考えていない|特になし|かかっても/;

/** フォームの文字から「初期費用を抑えたい」を読む */
export function detectWantsLowInitialCost(c: CustomerLike): boolean {
  const fields = [c.preferences, c.other_requests, c.ng_points, c.additional_conditions];
  for (const f of fields) {
    const s = String(f ?? "");
    if (!s) continue;
    if (LOW_INITIAL_COST_RE.test(s) && !LOW_INITIAL_COST_NEG_RE.test(s)) return true;
  }
  const lim = num(c.initial_cost_limit);
  // 0 は「未入力」と区別できない（実データで 0 の人に「負担が増えてもよい」がいた）ので 1〜150,000 だけ
  if (lim != null && lim >= 1 && lim <= 150_000) return true;
  return false;
}

const IMAGE_WANT_RES: Array<[ImageWantKey, RegExp]> = [
  ["bath_toilet_separate", /バス.?トイレ.?別|風呂.?トイレ.?別|お?風呂と?トイレ.?(別|セパレート)|セパレート|バストイレ別/],
  ["separate_washstand", /独立洗面/],
  ["storage", /収納|クローゼット|ウォークイン/],
  ["south_facing", /南向き/],
  ["floor_2_plus", /1階.{0,4}(NG|不可|嫌|以外|×)|2階以上|１階.{0,4}(NG|不可)/],
];

/** 画像（間取り図）でしか分からない希望を拾う */
export function detectImageWants(c: CustomerLike): ImageWantKey[] {
  const text = [c.preferences, c.other_requests, c.ng_points, c.additional_conditions].map((s) => String(s ?? "")).join("\n");
  const out: ImageWantKey[] = [];
  for (const [key, re] of IMAGE_WANT_RES) if (re.test(text)) out.push(key);
  return out;
}

/** 見積書の本文から割引額（円）を読む。「🌟26,500円割引させて頂き」 */
export function parseDiscountYen(text: string | null | undefined): number | null {
  const t = toHalfWidth(String(text ?? "")).replace(/,/g, "");
  const m = t.match(/(\d{3,7})\s*円\s*割引/);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return v >= 1_000 && v <= 500_000 ? v : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ─── お客様のプロフィール ───────────────────────────────────────────────────

/**
 * 条件・過去にスタッフが送った物件・選定パターン・割引額から、判定に使うプロフィールを作る。
 * ⚠ customer_reaction（お客様の反応）は使わない。正解は「スタッフが選んで送った事実」（メモリ feedback_property_selection_label）。
 */
export function buildCustomerProfile(
  customer: CustomerLike,
  sentRows: SentRowLike[] = [],
  patternRows: PatternRowLike[] = [],
  discountYen: number | null = null,
): CustomerProfile {
  const notes: string[] = [];
  let rentMax = num(customer.rent_max) ?? num(customer.max_rent);
  const rentMin = num(customer.rent_min);
  if (rentMax != null && rentMax <= 0) rentMax = null;
  if (rentMax != null && (rentMax < RENT_MAX_SANE_MIN || (rentMin != null && rentMin > 0 && rentMax < rentMin))) {
    notes.push("RENT_MAX_UNRELIABLE");
    rentMax = null;
  }

  const sentBuildings = new Set<string>();
  const ratios: number[] = [];
  for (const r of sentRows) {
    const n = normalizeBuildingName(r.property_name);
    if (n) sentBuildings.add(n);
    const rent = num(r.rent);
    if (rent != null && rent > 0 && rentMax != null) ratios.push(rent / rentMax);
  }

  const sellingPointsSelected: Record<string, number> = {};
  let selectedRows = 0;
  for (const p of patternRows) {
    if (p.selection_label !== "selected") continue;   // not_selected の語彙は selected と噛み合わない（実データ）ので使わない
    selectedRows++;
    for (const pt of p.selling_points ?? []) sellingPointsSelected[pt] = (sellingPointsSelected[pt] ?? 0) + 1;
  }

  let wantsLowInitialCost = detectWantsLowInitialCost(customer);
  let lowInitialCostSource: CustomerProfile["lowInitialCostSource"] = wantsLowInitialCost ? "form" : "none";
  // フォームに無くても、このお客様に選んで送った物件の過半が「敷礼0円」なら抑えたい人（3件以上ある時だけ）
  if (!wantsLowInitialCost && selectedRows >= 3 && (sellingPointsSelected["敷礼0円"] ?? 0) * 2 > selectedRows) {
    wantsLowInitialCost = true;
    lowInitialCostSource = "history";
  }

  const walkMax = num(customer.walk_minutes);
  const buildingAgeMax = num(customer.building_age);
  const lim = num(customer.initial_cost_limit);

  const confidence: CustomerProfile["confidence"] = rentMax == null ? "low" : (sentRows.length >= 3 ? "high" : "mid");

  return {
    rentMax, notes,
    floorPlanWant: normalizeFloorPlanWant(customer.floor_plan ?? customer.layout),
    walkMax: walkMax != null && walkMax > 0 ? walkMax : null,
    buildingAgeMax: buildingAgeMax != null && buildingAgeMax > 0 ? buildingAgeMax : null,
    initialCostLimit: lim != null && lim > 0 ? lim : null,
    wantsLowInitialCost, lowInitialCostSource,
    pet: customer.pet === true,
    imageWants: detectImageWants(customer),
    history: { sentCount: sentRows.length, sentBuildings, rentRatioMedian: median(ratios), sellingPointsSelected },
    discountYen: discountYen != null && discountYen > 0 ? discountYen : DEFAULT_DISCOUNT_YEN,
    confidence,
  };
}

// ─── 判定 ────────────────────────────────────────────────────────────────────

/** AD を円にする（表が円ならそれ・ヶ月なら 家賃×ヶ月。管理費は含めない） */
export function computeAdYen(f: PropertyFacts): number | null {
  if (f.adYen != null) return f.adYen;
  if (f.adMonths != null && f.rentYen != null) return Math.round(f.adMonths * f.rentYen);
  return null;
}

export function judgeProperty(facts: PropertyFacts, profile: CustomerProfile, index = 0): Judgment {
  let score = 50;
  const codes: string[] = [];
  const holds: string[] = [];
  const drops: string[] = [];
  const missing: string[] = [];
  const add = (code: string, delta: number, kind?: "hold" | "drop") => {
    codes.push(code);
    score += delta;
    if (kind === "hold") holds.push(code);
    if (kind === "drop") drops.push(code);
  };

  // 家賃（管理費が読めた時は足す）
  if (profile.rentMax == null) {
    if (profile.notes.includes("RENT_MAX_UNRELIABLE")) codes.push("RENT_MAX_UNRELIABLE");
    missing.push("rent_max");
  } else if (facts.rentYen == null) {
    add("RENT_UNKNOWN", 0); missing.push("rent");
  } else {
    const total = facts.rentYen + (facts.adminFeeYen ?? 0);
    const ratio = total / profile.rentMax;
    if (ratio <= 1.0) add("RENT_OK", 15);
    else if (ratio <= RENT_RATIO_HOLD) add("RENT_SLIGHTLY_OVER", 0);
    else if (ratio <= RENT_RATIO_DROP) add("RENT_OVER_110", -20, "hold");
    else add("RENT_OVER_130", -35, "drop");
    const med = profile.history.rentRatioMedian;
    if (med != null && ratio > med + 0.15) add("RENT_ABOVE_USUAL", -5);
  }

  // 敷金・礼金
  const dep = facts.depositMonths, key = facts.keyMoneyMonths;
  if (dep == null || key == null) {
    add("INITIAL_COST_UNKNOWN", 0); missing.push("deposit_key_money");
  } else if (dep === 0 && key === 0) {
    add(profile.wantsLowInitialCost ? "ZERO_ZERO_MATCH" : "ZERO_ZERO", profile.wantsLowInitialCost ? 20 : 8);
  } else if (profile.wantsLowInitialCost) {
    add("INITIAL_COST_NOT_ZERO", -15, "hold");
  }
  if (profile.initialCostLimit != null && facts.rentYen != null && dep != null && key != null) {
    const initial = (dep + key) * facts.rentYen;
    if (initial > profile.initialCostLimit * 1.2) add("INITIAL_COST_OVER_LIMIT", -10, "hold");
  }

  // 間取り
  const fpm = matchFloorPlan(profile.floorPlanWant, facts.floorPlan);
  if (fpm === "match") add("FLOOR_PLAN_MATCH", 15);
  else if (fpm === "near") add("FLOOR_PLAN_NEAR", 5);
  else if (fpm === "mismatch") add("FLOOR_PLAN_MISMATCH", -15, "hold");
  else if (facts.floorPlan == null) missing.push("floor_plan");

  // 徒歩
  if (profile.walkMax != null && facts.walkMinutes != null) {
    if (facts.walkMinutes <= profile.walkMax) add("WALK_OK", 10);
    else if (facts.walkMinutes <= profile.walkMax * 1.5) add("WALK_SLIGHTLY_OVER", -5);
    else add("WALK_OVER", -15, "hold");
  } else if (profile.walkMax != null) missing.push("walk");

  // 築年
  if (profile.buildingAgeMax != null && facts.buildingAge != null) {
    if (facts.buildingAge <= profile.buildingAgeMax) add("BUILDING_AGE_OK", 5);
    else if (facts.buildingAge <= profile.buildingAgeMax + 3) add("BUILDING_AGE_SLIGHTLY_OVER", -3);
    else add("BUILDING_AGE_OVER", -10, "hold");
  } else if (profile.buildingAgeMax != null) missing.push("building_age");

  // 送付済みの建物（サーバーの skip-sent と同じ線。スタッフモードでは呼ばれない）
  if (profile.history.sentBuildings.has(normalizeBuildingName(facts.name))) add("ALREADY_SENT", -30, "drop");

  // AD と利益（AD円 − 割引）
  const adYen = computeAdYen(facts);
  let profitYen: number | null = null;
  if (adYen == null) {
    add("AD_UNKNOWN", 0); missing.push("ad");
  } else {
    profitYen = adYen - profile.discountYen;
    if (profitYen < 0) add("PROFIT_NEGATIVE", -10, "hold");
    else add("AD_COVERS_DISCOUNT", 5);
    if (facts.adMonths != null && facts.adMonths >= 2) add("AD_HIGH", 5);
  }

  // ペット
  if (profile.pet && /ペット不可|ペット×|ペットNG/.test(facts.rawText)) add("PET_NG", -15, "hold");

  score = Math.max(0, Math.min(100, score));
  const verdict: Verdict = drops.length > 0 ? "drop" : (holds.length > 0 || score < 40 ? "hold" : "pass");
  // 理由の日本語は「外す・保留の理由」を先に、良い点は後に（LINE の1行は先頭2つを見せる）
  const flagCodes = [...drops, ...holds];
  const positives = codes.filter((c) => ["ZERO_ZERO_MATCH", "AD_HIGH", "FLOOR_PLAN_MATCH"].includes(c));
  const reasonsJa = [...flagCodes, ...positives].map((c) => REASON_JA[c] ?? c);

  return {
    index, rank: facts.rank, name: facts.name, verdict, score, reasonCodes: codes, flagCodes, reasonsJa,
    confidence: profile.confidence, missing, adYen, profitYen,
    imageChecks: verdict === "drop" ? [] : profile.imageWants,
    facts,
  };
}

/** 画像（間取り図）の読み取り結果を判定に足す。false は hold（落とさない）・true は加点・null は何もしない */
export function applyImageFacts(j: Judgment, img: ImageFacts | null | undefined): Judgment {
  if (!img) return j;
  const codes = [...j.reasonCodes];
  const flagCodes = [...j.flagCodes];
  let score = j.score;
  let hold = j.verdict === "hold";
  for (const key of j.imageChecks) {
    const v = img[key];
    if (v == null) continue;
    const code = `IMAGE_${key.toUpperCase()}_${v ? "OK" : "NG"}`;
    codes.push(code);
    if (v) score += 5; else { score -= 10; hold = true; flagCodes.push(code); }
  }
  score = Math.max(0, Math.min(100, score));
  const verdict: Verdict = j.verdict === "drop" ? "drop" : (hold || score < 40 ? "hold" : "pass");
  const positives = codes.filter((c) => ["ZERO_ZERO_MATCH", "AD_HIGH", "FLOOR_PLAN_MATCH"].includes(c) || /^IMAGE_.*_OK$/.test(c));
  const reasonsJa = [...flagCodes, ...positives].map((c) => REASON_JA[c] ?? c);
  return { ...j, score, verdict, reasonCodes: codes, flagCodes, reasonsJa };
}

// ─── まとめ（LINE の末尾・コンソール用） ─────────────────────────────────────

export function countVerdicts(js: Judgment[]): { pass: number; hold: number; drop: number } {
  const c = { pass: 0, hold: 0, drop: 0 };
  for (const j of js) c[j.verdict]++;
  return c;
}

/** 物件ごとの1行（「〇〇（家賃が上限を3割超・送付済み）」） */
export function formatJudgmentBrief(j: Judgment): string {
  // 外す・保留の物は「なぜ外すか」だけを見せる（良い点を混ぜると読み手が迷う）
  const src = j.verdict === "pass" ? j.reasonsJa : j.flagCodes.map((c) => REASON_JA[c] ?? c);
  const why = src.length ? src.slice(0, 2).join("・") : `${j.score}点`;
  return `${j.name}（${why}）`;
}

/**
 * 売上番長の説明文の末尾に付ける1ブロック。
 * applyDrop=false（影の運用）: 全件送っている前提で「外す候補」を見せる。
 * applyDrop=true: 実際に外した物件を理由付きで残す（一覧から消えた物が分かるように）。
 */
export function formatBrainNoteLine(js: Judgment[], applyDrop: boolean): string {
  if (js.length === 0) return "";
  const c = countVerdicts(js);
  const drops = js.filter((j) => j.verdict === "drop");
  const holds = js.filter((j) => j.verdict === "hold");
  const head = `🧠 ブレイン判定 ${js.length}件（通す${c.pass}・保留${c.hold}・${applyDrop ? "外した" : "外す候補"}${c.drop}）`;
  const parts = [head];
  if (drops.length) parts.push(`${applyDrop ? "ブレインが見送った" : "外す候補"}: ${drops.map(formatJudgmentBrief).join("／")}`);
  if (holds.length) parts.push(`保留: ${holds.slice(0, 5).map(formatJudgmentBrief).join("／")}${holds.length > 5 ? ` ほか${holds.length - 5}件` : ""}`);
  return parts.join("\n");
}
