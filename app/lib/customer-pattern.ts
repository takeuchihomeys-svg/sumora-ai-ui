// app/lib/customer-pattern.ts（純関数・DB/LLM なし・画面とサーバーで共用できる）
// お客様の「型（パターン）」を決める1か所。物件の採点の重みを型ごとに変える時・型ごとの一致率を毎週測る時に同じ物差しを使う。
//
// 2026-10-06 竹内さん「パターンによって採点基準パターンかえているか　またお客さんのパターンは何パターンあるか調査できるか
//   徹底的に調査して仕上げる　分析力上げるため」
//
// ■ 2つに分ける（一覧と詳細で食い違わない・重くしない）
//   customerPatternOf(conditions)       … 条件欄だけで決まる軸（一覧・詳細・3分のまとめ・監査が同じ列で同じ答え）
//   conversationPatternOf(signals)      … 会話の数え（持ち込み・送った回数・内覧・見積書）で決まる軸。呼ぶ側が数えて渡す（この関数は数えない）
//
// ■ 軸（どれも決定論・語は既存の読み方に寄せる）
//   household … single（1K・1R・ワンルーム／一人の語）／pair（1DK・1LDK・2DK／二人・同棲・カップルの語）／family（2LDK以上／子供・家族・3人以上の語）／unknown
//               householdLayoutOf（star-rank-pickup・hook-lean の「1LDK以上」）とは pair+family ＝ 1LDK以上 で揃う（isHouseholdType）
//   budget    … 家賃の上限（rent_max → max_rent）: low（6万未満）／mid（6〜8万）／upper（8〜11万）／high（11万以上）／unknown
//   focus     … 重視点の集合（初期費用・広さ・新しさ・駅近・通勤・設備・ペット・階・審査）。recommendation-gaps.customerWants の話題＋列
//               primaryFocus … 1つに決める時の順（ペット＞初期費用＞新しさ＞広さ＞設備＞駅近＞通勤＞なし）。順は「点で効かせられる強さ」の順
//   urgency   … urgent（30日以内に入居・すぐ）／normal／open（未定・いつでも）／unknown（parseMoveInWant を登録日で読む）
//   firmness  … 絶対の要望の数（requirement_strength の must・NG 欄の節の数・「絶対／必須」の節）→ firm（2以上）／some（1）／loose（0）
//   student   … 学生・新社会人の語
//   patternKey … 採点に使う粗い型 = household × 初期費用の有無（回数が足りる粗さ。scripts/audit-customer-pattern.ts で決めた）
import { customerWants, type CustomerWantInput, type TopicKey } from "./recommendation-gaps";
import { parseMoveInWant } from "./move-in-want";

export type Household = "single" | "pair" | "family" | "unknown";
export type Budget = "low" | "mid" | "upper" | "high" | "unknown";
export type Focus = "pet" | "initial" | "new" | "space" | "equip" | "station" | "commute" | "floor" | "screening";
export type Urgency = "urgent" | "normal" | "open" | "unknown";
export type Firmness = "firm" | "some" | "loose";

export type PatternConditions = NonNullable<CustomerWantInput["conditions"]> & {
  layout?: string | null; desired_area?: string | null; commute_station?: string | null; commute_minutes?: number | null;
  requirement_strength?: unknown; created_at?: string | null;
};

export type CustomerPattern = {
  household: Household;
  /** household の決め手（text＝自由文の語・layout＝間取り・none） */
  householdFrom: "text" | "layout" | "none";
  budget: Budget;
  rentMax: number | null;
  focus: Focus[];
  primaryFocus: Focus | "none";
  urgency: Urgency;
  firmness: Firmness;
  mustCount: number;
  student: boolean;
  /** 採点に使う粗い型（household の 一人/二人以上 × 初期費用） */
  patternKey: PatternKey;
};

export type PatternKey = "一人" | "一人×初期費用" | "二人以上" | "二人以上×初期費用" | "不明";
export const PATTERN_KEYS: readonly PatternKey[] = ["一人", "一人×初期費用", "二人以上", "二人以上×初期費用", "不明"];

export const HOUSEHOLD_JA: Record<Household, string> = { single: "一人", pair: "二人", family: "家族", unknown: "不明" };
export const BUDGET_JA: Record<Budget, string> = { low: "6万未満", mid: "6〜8万", upper: "8〜11万", high: "11万以上", unknown: "不明" };
export const FOCUS_JA: Record<Focus | "none", string> = {
  pet: "ペット", initial: "初期費用", new: "新しさ", space: "広さ", equip: "設備", station: "駅近", commute: "通勤", floor: "階", screening: "審査", none: "なし",
};
export const URGENCY_JA: Record<Urgency, string> = { urgent: "急ぎ（30日以内）", normal: "ふつう", open: "未定・いつでも", unknown: "不明" };

const nf = (s: unknown) => String(s ?? "").normalize("NFKC");
const freeText = (c: PatternConditions) => nf([c.preferences, c.ng_points, c.other_requests, c.additional_conditions, c.raw_format_text].filter(Boolean).join("\n"));

// 世帯の語（自由文）。「二人入居可」は二人。「一人暮らし」「単身」は一人。家族は子供・3人以上
const FAMILY_RE = /子供|子ども|こども|お子様|お子さん|赤ちゃん|乳児|幼児|小学生|中学生|家族[0-9３-９三四五]|[3-9３-９三四五]\s*人(?:家族|暮らし|で(?:住|入居))|ファミリー|妊娠|出産/;
const PAIR_RE = /[2２二]\s*人(?:入居|暮らし|で(?:住|入居)|住まい)|ふたり|カップル|同棲|夫婦|彼氏|彼女|婚約|新婚|パートナー|結婚/;
const SINGLE_RE = /一人暮らし|ひとり暮らし|[1１一]\s*人暮らし|単身|一人で住|ひとりで住/;
const STUDENT_RE = /学生|大学|専門学校|短大|院生|新卒|新社会人|入学|内定/;

/**
 * 間取りの希望 → 世帯（1K・1R・ワンルーム＝一人／1DK・1LDK・2DK＝二人／2LDK以上・3DK以上＝家族）。「1K、1LDK」のように混ざる時は小さい方。
 *   一人／二人以上の線は star-rank-pickup.householdLayoutOf（DK を言い 1K・1R・ワンルームを含まない＝1LDK以上の型）と同じ（1DK も二人以上の側）
 */
export function householdOfLayout(fp: string | null | undefined): Household {
  const s = nf(fp).toUpperCase().replace(/\s/g, "");
  if (!s || /特に|なし|無し|こだわり|問わ|指定な/.test(s)) return "unknown";
  if (/1K|1R|ワンルーム|ワンケー/.test(s)) return "single";
  // 2K・3K など DK の無い型は householdLayoutOf が二人以上にしないので「不明」に置く（実データ 0〜1人）
  if (!/DK/.test(s)) return "unknown";
  // 「1LDK〜2LDK」「1DK以上」は二人（小さい方）
  if (/1S?L?DK|2S?DK/.test(s)) return "pair";
  return "family";
}

/** 家賃の上限 → 帯 */
export function budgetOf(rentMax: number | null | undefined): Budget {
  const r = typeof rentMax === "number" && Number.isFinite(rentMax) && rentMax > 10_000 ? rentMax : null;
  if (r == null) return "unknown";
  if (r < 60_000) return "low";
  if (r < 80_000) return "mid";
  if (r < 110_000) return "upper";
  return "high";
}

const EQUIP_TOPICS: TopicKey[] = ["bath_toilet", "washbasin", "laundry_in", "autolock", "delivery_box", "security", "bath_dryer", "reheating", "internet", "kitchen", "storage", "parking", "corner", "sunny", "furnished"];
const FOCUS_ORDER: Focus[] = ["pet", "initial", "new", "space", "equip", "station", "commute", "floor", "screening"];

/** 絶対の要望の数（requirement_strength の must・NG 欄の節・自由文の「絶対／必須」の節） */
export function mustCountOf(c: PatternConditions): number {
  let n = 0;
  const rs = c.requirement_strength;
  if (rs && typeof rs === "object") for (const v of Object.values(rs as Record<string, unknown>)) if ((v as { strength?: string } | null)?.strength === "must") n++;
  const ng = nf(c.ng_points).split(/[、,。\n・／/]/).map((x) => x.trim()).filter((x) => x.length >= 2 && !/^(?:特に)?(?:なし|無し|ない|ありません)$/.test(x));
  n += ng.length;
  const free = nf([c.preferences, c.other_requests, c.additional_conditions].filter(Boolean).join("\n"));
  n += free.split(/[、,。\n]/).filter((x) => /絶対|必須|マスト|譲れない|でないと(?:困|無理|ダメ)|じゃないと(?:困|無理|ダメ)/.test(x)).length;
  return n;
}

/** 条件欄だけで決まる型（会話は見ない） */
export function customerPatternOf(c: PatternConditions | null | undefined, opts: { today?: string | Date } = {}): CustomerPattern {
  const cond: PatternConditions = c ?? {};
  const t = freeText(cond);
  // 世帯: 自由文の語 → 間取り
  let household: Household = "unknown", householdFrom: CustomerPattern["householdFrom"] = "none";
  if (FAMILY_RE.test(t)) { household = "family"; householdFrom = "text"; }
  else if (PAIR_RE.test(t)) { household = "pair"; householdFrom = "text"; }
  else if (SINGLE_RE.test(t)) { household = "single"; householdFrom = "text"; }
  else {
    const h = householdOfLayout(cond.floor_plan ?? cond.layout ?? null);
    if (h !== "unknown") { household = h; householdFrom = "layout"; }
  }
  const rentMax = (typeof cond.rent_max === "number" && cond.rent_max > 0 ? cond.rent_max : typeof cond.max_rent === "number" && cond.max_rent > 0 ? cond.max_rent : null);
  const budget = budgetOf(rentMax);
  // 重視点
  // 条件フォームの原文（raw_format_text）は見出し（「初期費用の限度額」「審査に不安な事がある方」）が語に当たるので読まない＝👑 の状況（STAR_SITUATION_COLUMNS）と同じ列
  const topics = new Set(customerWants({ conditions: { ...cond, raw_format_text: null } }).map((w) => w.key as TopicKey));
  const focus = new Set<Focus>();
  if (cond.pet === true || topics.has("pet")) focus.add("pet");
  if (topics.has("low_initial") || topics.has("zero_deposit") || topics.has("free_rent")) focus.add("initial");
  if (topics.has("new_build")) focus.add("new");
  if (topics.has("spacious") || (cond.floor_area_min != null && cond.floor_area_min > 0)) focus.add("space");
  if (EQUIP_TOPICS.some((k) => topics.has(k))) focus.add("equip");
  if (topics.has("station_near")) focus.add("station");
  if (topics.has("commute") || !!nf(cond.commute_station).trim()) focus.add("commute");
  if (topics.has("floor2")) focus.add("floor");
  if (topics.has("screening")) focus.add("screening");
  const focusList = FOCUS_ORDER.filter((f) => focus.has(f));
  const primaryFocus = (focusList.find((f) => f !== "screening") ?? "none") as Focus | "none";
  // 急ぎ
  let urgency: Urgency = "unknown";
  const mv = nf(cond.move_in_time).trim();
  if (mv) {
    const w = parseMoveInWant(mv, { registeredAt: cond.created_at ?? null, today: cond.created_at ?? opts.today });
    if (w.kind === "asap") urgency = "urgent";
    else if (w.kind === "none" || w.kind === "vague" || w.kind === "after") urgency = w.kind === "none" ? "open" : "normal";
    else if (w.kind === "by" && w.wantBy) {
      const base = Date.parse(String(cond.created_at ?? opts.today ?? new Date().toISOString()));
      const days = (Date.parse(w.wantBy) - (Number.isFinite(base) ? base : Date.now())) / 864e5;
      urgency = days <= 30 ? "urgent" : "normal";
    } else urgency = "normal";
  }
  const mustCount = mustCountOf(cond);
  const firmness: Firmness = mustCount >= 2 ? "firm" : mustCount === 1 ? "some" : "loose";
  const student = STUDENT_RE.test(t);
  return { household, householdFrom, budget, rentMax, focus: focusList, primaryFocus, urgency, firmness, mustCount, student, patternKey: patternKeyOf(household, focus.has("initial")) };
}

/** 1LDK以上の型（star-rank-pickup.householdLayoutOf・hook-lean の household と同じ側） */
export const isHouseholdType = (h: Household) => h === "pair" || h === "family";

export function patternKeyOf(h: Household, initial: boolean): PatternKey {
  if (h === "unknown") return "不明";
  const base = isHouseholdType(h) ? "二人以上" : "一人";
  return (initial ? `${base}×初期費用` : base) as PatternKey;
}

// ─── 会話も要る軸（呼ぶ側が数えて渡す）──────────────────────────────────────
export type ConversationSignals = {
  /** お客様が送った物件の URL（SUUMO 等）・物件の画像の数 */
  broughtProperties: number;
  /** その時点までにお客様に送った物件の数 */
  sentBefore: number;
  /** 内覧の約束・見積書の送付が既にあったか */
  viewingBefore?: boolean;
  estimateBefore?: boolean;
};
export type Stage = "new" | "proposing" | "deep";
export type ConversationPattern = { bringsOwn: boolean; stage: Stage };
/** 持ち込み型（2件以上持ち込んだ）・段（送付0＝新規／送付あり＝提案中／内覧・見積書あり＝深い） */
export function conversationPatternOf(s: ConversationSignals): ConversationPattern {
  const stage: Stage = s.viewingBefore || s.estimateBefore ? "deep" : s.sentBefore > 0 ? "proposing" : "new";
  return { bringsOwn: s.broughtProperties >= 2, stage };
}
