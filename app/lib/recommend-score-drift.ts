// app/lib/recommend-score-drift.ts
// スタッフが実際に送った物件（物件オススメ🌟・物件ピックアップ・画像）と、その回の採点（点・札・順位・👑）を並べ、
// 「採点のズレ」を数える純関数（DB・ネット・LLM に触れない。読むだけの分析の材料。重みはここでは直さない）。
//
// 2026-09-28 竹内「実際どの物件をオススメでスタッフは送っているかで、そこの特徴、お客さん毎に対してどこの点を訴求するかの部分
//   併せて、お客さんの条件に対してのスコアリングのズレを見つける（お客さん毎に何か、特にこだわり条件が強い場合スコアリングの
//   加点が変わる、そこの率を分析するのと、分析する為の仕組を作る）」
//   正解は「スタッフが選んで送った事実」（memory feedback_property_selection_label）。お客様の返信の有無は使わない。
//   重みを直すのは竹内さんの判断（ここは直す前の材料だけ）。週1回の重みの学習（scoring-learning.ts）とは別の読み方:
//   あちらは札1枚ごとの「選んだ方が持つ率」、こちらは **条件の種類（家族）ごと × お客様のこだわりの強さごと** に
//   「👑 と選んだ物のどちらが、その条件で点を取っていたか」「選んだ物はその条件を満たす率が候補全体よりどれだけ高いか」を数える。
//
// ■ 決めたこと
//   ・札 → 条件の種類（家族）は codeFamily の1か所（家賃・初期費用・間取り・徒歩・築年・広さ・エリア・通勤・AD・設備ごと・条件ごと…）。
//     画像の札（IMAGE_BATH_TOILET_SEPARATE_OK 等）は設備の家族に寄せる（同じ条件を資料と画像の2つで数えない）。
//   ・札の状態は codeState: 点の符号で ok／ng、0点は名前で（_OK・_MATCH は ok・_NG・_OVER は ng）。
//     _UNKNOWN・_UNLISTED・_ASK・_INFO は「分からない」（満たす・満たさないのどちらにも数えない）。
//     _HELD（保留で 0点にした AD・ピンポイント）は元の札の状態で読む（AD が高いこと自体は変わらない）。
//     AD は段で読む（2ヶ月以上 ok・1〜1.5ヶ月は中・1ヶ月未満／なし ng）。
//   ・👑 は回に印があればそれ（売上サポのまとめの best_id）、無ければ点の単独1位。1位が同点なら 👑 なし（比べない）。
//   ・全部同点の回（材料が薄い回）は「比べられない」に数えて、率から外す。
//   ・お客様のこだわりの強さは決定論（customerStrength）: 条件欄の構造・自由文・強い言い方（絶対・必須・NG…）・NG 欄・
//     お客様の発言での繰り返し・条件の言い直し（property_condition_history）から、条件の種類ごとに strong／stated／none。
//   ・訴求は🌟の本文から recommendation-gaps.appealTopics（話題の語彙は1つ＝三方を同じ言葉で見る）。

import { baseReasonPoints } from "./property-brain";
import { TOPICS, appealTopics, isUsableCustomerText, type TopicKey } from "./recommendation-gaps";
import { toHalf } from "./candidate-facts";

// ─── 札 → 条件の種類（家族） ──────────────────────────────────────────────────

/** 画像の札の鍵 → 設備の鍵（同じ条件を資料と画像で別々に数えない） */
const IMAGE_KEY_ALIAS: Record<string, string> = {
  bath_toilet_separate: "bath_toilet", separate_washstand: "washbasin", floor_2_plus: "floor2",
};
const EQUIP_SUFFIX = /_(?:MUST_OK|SOFT_OK|OK_MAX|OK|MUST_NG|SOFT_NG|NG|NOT_UNLISTED|UNLISTED|ASK|NEAR)$/;

/** 札 → 条件の種類。数えない札（送付済み・全部合う・ピンポイント・上限の印）は null ではなく種類名を返し、FAMILY_SKIP で外す */
export function codeFamily(code: string): string | null {
  const c = String(code ?? "").replace(/_HELD$/, "");
  if (!c) return null;
  if (/^RENT_/.test(c)) return "rent";
  if (/^(?:ZERO_ZERO|INITIAL_COST_|FREE_RENT)/.test(c)) return "initial_cost";
  if (/^FLOOR_PLAN_/.test(c)) return "floor_plan";
  if (/^WALK_/.test(c)) return "walk";
  if (/^(?:BUILDING_AGE_|AGE_)/.test(c)) return "age";
  if (/^(?:SQM_|ROOM_JO_)/.test(c)) return "size";
  if (/^AREA_/.test(c)) return "area";
  if (/^COMMUTE_/.test(c)) return "commute";
  if (/^(?:AD_|PROFIT_)/.test(c)) return "ad";
  if (/^MOVE_IN_/.test(c)) return "move_in";
  if (/^(?:CONTRACT_|RENEWAL_FEE_)/.test(c)) return "contract";
  if (/^PET_/.test(c)) return "pet";
  if (/^ALREADY_SENT/.test(c)) return "already_sent";
  if (/^FIT_/.test(c)) return "fit";
  if (/^SEARCH_PINPOINT/.test(c)) return "pinpoint";
  if (c === "EQUIP_MUST_NG_CAP") return "cap";
  if (/^EQUIP_/.test(c)) {
    const key = c.replace(/^EQUIP_/, "").replace(EQUIP_SUFFIX, "").toLowerCase();
    return key === "pet" ? "pet" : `equip:${key}`;
  }
  if (/^IMAGE_/.test(c)) {
    const key = c.replace(/^IMAGE_/, "").replace(/_(?:OK|NG)$/, "").toLowerCase();
    return `equip:${IMAGE_KEY_ALIAS[key] ?? key}`;
  }
  if (/^CONDITION_/.test(c)) return `cond:${c.replace(/^CONDITION_/, "").replace(/_(?:OK|NG|ASK|UNLISTED)$/, "").toLowerCase()}`;
  return "other";
}

/** 比べる時に外す種類（条件ではない札・他の札から決まる札・上限の印） */
export const FAMILY_SKIP = new Set(["already_sent", "fit", "pinpoint", "cap", "other", "contract"]);

export const FAMILY_JA: Record<string, string> = {
  rent: "家賃", initial_cost: "初期費用（敷礼0）", floor_plan: "間取り", walk: "駅徒歩", age: "築年", size: "広さ・帖数", area: "エリア",
  commute: "通勤", ad: "AD", move_in: "入居時期", pet: "ペット", contract: "契約の形",
  "equip:bath_toilet": "バス・トイレ別", "equip:washbasin": "独立洗面台", "equip:autolock": "オートロック", "equip:delivery_box": "宅配ボックス",
  "equip:floor2": "2階以上", "equip:floor": "階数", "equip:net_free": "ネット無料", "equip:parking": "駐車場", "equip:bath_dryer": "浴室乾燥機",
  "equip:gas_stove": "ガスコンロ", "equip:aircon": "エアコン", "equip:elevator": "エレベーター", "equip:structure": "構造（RC 等）",
  "equip:bldg_type": "建物の種類", "equip:bike_parking": "駐輪場", "equip:two_person": "二人入居", "equip:counter_kitchen": "対面キッチン",
  "equip:no_guarantor": "保証人不要", "equip:laundry_in": "室内洗濯機置場", "equip:reheating": "追い焚き", "equip:corner": "角部屋",
  "equip:south": "南向き",
};
export const familyJa = (f: string) => FAMILY_JA[f] ?? f;

export type CodeState = "ok" | "mid" | "ng" | "unknown" | "info";

/** 札1枚の状態（満たす／中／満たさない／分からない／知らせ） */
export function codeState(code: string): CodeState {
  const c = String(code ?? "").replace(/_HELD$/, "");
  if (/_(?:UNKNOWN|UNLISTED|NOT_UNLISTED|ASK|INFO)$|UNRELIABLE/.test(c)) return "unknown";
  if (codeFamily(c) === "ad") {
    if (/^AD_(?:HIGH|2_5M|VERY_HIGH|ASSUMED_AGENT)$/.test(c)) return "ok";
    if (/^AD_(?:1M|1_5M)$/.test(c)) return "mid";
    if (/^(?:AD_UNDER_1M(?:_NEVER|_FALLBACK)?|AD_NONE|PROFIT_NEGATIVE)$/.test(c)) return "ng";
    return "info";
  }
  if (/_OK_MAX$/.test(c)) return "ok";
  // 広げた検索の幅の中（家賃・駅・間取り・築年・広さ）は「中」
  if (/_(?:WIDE|NEAR|2STOPS|SAME_CLASS|SLIGHTLY_OVER|SLIGHTLY_UNDER|CLOSE)$/.test(c)) return "mid";
  const p = baseReasonPoints(c);
  if (p > 0) return "ok";
  if (p < 0) return "ng";
  if (/(?:_OK|_MATCH)$/.test(c)) return "ok";
  if (/(?:_NG|_OVER|_MISMATCH)$/.test(c)) return "ng";
  return "info";
}

export type FamilyView = { state: "ok" | "mid" | "ng" | "mixed" | "unknown"; points: number; codes: string[] };

/** 候補1件の札 → 条件の種類ごとの状態と点（点は定数の点＝baseReasonPoints。_HELD は 0点） */
export function familiesOf(codes: ReadonlyArray<string>): Record<string, FamilyView> {
  const out: Record<string, FamilyView> = {};
  for (const code of codes ?? []) {
    const f = codeFamily(code);
    if (!f || FAMILY_SKIP.has(f)) continue;
    const v = (out[f] ??= { state: "unknown", points: 0, codes: [] });
    v.codes.push(code);
    v.points += /_HELD$/.test(code) ? 0 : baseReasonPoints(code);
  }
  for (const v of Object.values(out)) {
    const st = v.codes.map(codeState);
    const ok = st.includes("ok"), ng = st.includes("ng"), mid = st.includes("mid");
    v.state = ok && ng ? "mixed" : ng ? "ng" : ok ? "ok" : mid ? "mid" : "unknown";
  }
  return out;
}
/** 満たす（ok）か。分からない・無い時は null（数えない） */
export function familyOk(v: FamilyView | undefined): boolean | null {
  if (!v || v.state === "unknown") return null;
  return v.state === "ok";
}

// ─── 1回（スタッフが選んだ回） ───────────────────────────────────────────────

export type DriftCand = {
  key: string;
  /** 採点の点（売上サポは合計＝判定＋画像の加点・🌟の回は付け直した点）。無ければ null */
  score: number | null;
  codes: string[];
  /** スタッフがお客様に送った（選んだ）物 */
  chosen: boolean;
  /** 送った物のうち🌟（物件オススメで1件に絞った物）。あれば比べる相手はこれ */
  star?: boolean;
  /** 👑（売上サポのまとめの一番）。印が無い回は点の単独1位 */
  crown?: boolean;
  /** 保存された順位（売上サポの complete_rank）。無ければ null */
  rank?: number | null;
  /** 送った経路（pickup・recommendation・staff_image 等。選んだ物だけ） */
  via?: string | null;
  /** 候補の値で決まる話題（recommendation-gaps.factTopics の yes／no）。採点の札とは別に「物件が満たすか」を見る */
  facts?: { yes: TopicKey[]; no: TopicKey[] } | null;
};
export type DriftRound = {
  id: string;
  /** pickup（売上サポの採点そのまま）／snapshot（🌟の時点の候補を付け直し）／pool（拡張の回を付け直し） */
  source: string;
  at: string;
  /** お客様の見分け（会話 ID の先頭など・報告に名前を出さない） */
  customerKey: string;
  cands: DriftCand[];
  /** 送った文（🌟の本文など）。訴求を読む */
  appealText?: string | null;
};

/**
 * kind: weight＝両方の物件でその条件が読めていて点が違う（重みの話）／material＝片方が読めていない・札が無い（材料の欠けの話）。
 *   材料の欠けで付いた差を「重みのズレ」と数えると、材料の多い物件を上に置く癖を重みのせいにしてしまう
 */
export type FamilyDiff = { family: string; chosenPts: number; crownPts: number; delta: number; chosenState: FamilyView["state"] | "absent"; crownState: FamilyView["state"] | "absent"; kind: "weight" | "material" };
export type RoundOutcome = {
  id: string;
  source: string;
  n: number;
  /** 点のある候補の数 */
  scored: number;
  /** 全部同点（比べられない） */
  allTied: boolean;
  chosenKeys: string[];
  /** 比べる選んだ物（🌟があれば🌟・無ければ送った物の中で点の一番高い物） */
  mainKey: string | null;
  /** その物の点の順位（同点は平均・1 始まり） */
  chosenPos: number | null;
  /** その物の保存された順位（売上サポの complete_rank） */
  chosenStoredRank: number | null;
  crownKey: string | null;
  /** 👑 を選んだ（🌟がある回は 👑＝🌟 か・無い回は 👑 を送ったか。null＝👑 が決まらない回） */
  crownChosen: boolean | null;
  /** 👑 の点 − 選んだ物（一番点の高い物）の点。👑 を選んだ・👑 なしは null */
  gap: number | null;
  /** 👑 を選ばなかった回の、条件の種類ごとの差（選んだ物 − 👑。点の差が 0 でも状態が違えば入れる） */
  diffs: FamilyDiff[];
  /** 👑 だけが持つ札・選んだ物だけが持つ札 */
  crownOnlyCodes: string[];
  chosenOnlyCodes: string[];
};

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** 👑（印 → 点の単独1位）。1位が同点・点が無い時は null */
export function crownOf(round: Pick<DriftRound, "cands">): DriftCand | null {
  const marked = round.cands.find((c) => c.crown);
  if (marked) return marked;
  const scored = round.cands.filter((c) => isNum(c.score));
  if (scored.length < 2) return null;
  const top = Math.max(...scored.map((c) => c.score as number));
  const tops = scored.filter((c) => c.score === top);
  return tops.length === 1 ? tops[0] : null;
}

/** 1回の結果（選んだ物は採点で何位か・👑 と違う時はどの条件で差がついたか） */
export function roundOutcome(round: DriftRound): RoundOutcome {
  const scored = round.cands.filter((c) => isNum(c.score));
  const chosen = round.cands.filter((c) => c.chosen);
  const allTied = scored.length >= 2 && new Set(scored.map((c) => c.score)).size === 1;
  const posOf = (c: DriftCand) => {
    if (!isNum(c.score) || scored.length < 2) return null;
    const gt = scored.filter((o) => o !== c && (o.score as number) > (c.score as number)).length;
    const eq = scored.filter((o) => o !== c && o.score === c.score).length;
    return 1 + gt + eq / 2;
  };
  const crown = allTied ? (round.cands.find((c) => c.crown) ?? null) : crownOf(round);
  const star = chosen.find((c) => c.star) ?? null;
  const bestChosen = star ?? [...chosen].sort((a, b) => (isNum(b.score) ? b.score : -1e9) - (isNum(a.score) ? a.score : -1e9))[0] ?? null;
  const crownChosen = crown ? (star ? crown === star : chosen.includes(crown)) : null;
  let gap: number | null = null;
  const diffs: FamilyDiff[] = [];
  let crownOnlyCodes: string[] = [], chosenOnlyCodes: string[] = [];
  if (crown && bestChosen && !crownChosen) {
    if (isNum(crown.score) && isNum(bestChosen.score)) gap = crown.score - bestChosen.score;
    const fc = familiesOf(bestChosen.codes), fk = familiesOf(crown.codes);
    for (const f of [...new Set([...Object.keys(fc), ...Object.keys(fk)])].sort()) {
      const a = fc[f] as FamilyView | undefined, b = fk[f] as FamilyView | undefined;
      const cs: FamilyDiff["chosenState"] = a ? a.state : "absent", ks: FamilyDiff["crownState"] = b ? b.state : "absent";
      const material = cs === "absent" || cs === "unknown" || ks === "absent" || ks === "unknown";
      const d: FamilyDiff = { family: f, chosenPts: a?.points ?? 0, crownPts: b?.points ?? 0, delta: (a?.points ?? 0) - (b?.points ?? 0), chosenState: cs, crownState: ks, kind: material ? "material" : "weight" };
      if (d.delta !== 0 || d.chosenState !== d.crownState) diffs.push(d);
    }
    const cs = new Set(bestChosen.codes), ks = new Set(crown.codes);
    crownOnlyCodes = [...ks].filter((k) => !cs.has(k));
    chosenOnlyCodes = [...cs].filter((k) => !ks.has(k));
  }
  return {
    id: round.id, source: round.source, n: round.cands.length, scored: scored.length, allTied,
    chosenKeys: chosen.map((c) => c.key),
    mainKey: bestChosen?.key ?? null,
    chosenPos: bestChosen ? posOf(bestChosen) : null,
    chosenStoredRank: bestChosen && isNum(bestChosen.rank) ? bestChosen.rank : null,
    crownKey: crown?.key ?? null, crownChosen, gap, diffs, crownOnlyCodes, chosenOnlyCodes,
  };
}

// ─── お客様のこだわりの強さ ──────────────────────────────────────────────────

/** 条件の種類 ↔ 話題（recommendation-gaps の語彙）。お客様の文・🌟の本文を条件の種類に寄せる */
export const FAMILY_TOPICS: Record<string, TopicKey[]> = {
  rent: ["rent"], initial_cost: ["zero_deposit", "low_initial", "free_rent"], floor_plan: ["layout"], walk: ["station_near"],
  age: ["new_build"], size: ["spacious"], commute: ["commute"], pet: ["pet"], move_in: ["move_in"],
  "equip:bath_toilet": ["bath_toilet"], "equip:washbasin": ["washbasin"], "equip:laundry_in": ["laundry_in"], "equip:autolock": ["autolock"],
  "equip:delivery_box": ["delivery_box"], "equip:floor2": ["floor2"], "equip:parking": ["parking"], "equip:south": ["sunny"],
  "equip:gas_stove": ["kitchen"], "equip:bath_dryer": ["bath_dryer"], "equip:reheating": ["reheating"], "equip:net_free": ["internet"],
  "equip:corner": ["corner"], "equip:structure": ["quiet"],
};
const TOPIC_FAMILY: Partial<Record<TopicKey, string>> = Object.fromEntries(
  Object.entries(FAMILY_TOPICS).flatMap(([f, ts]) => ts.map((t) => [t, f])),
) as Partial<Record<TopicKey, string>>;
/** 話題 → 条件の種類（採点に札の無い話題は null＝周辺環境・審査・収納 等） */
export const topicFamily = (t: TopicKey): string | null => TOPIC_FAMILY[t] ?? null;

/** 強い言い方（同じ行にあれば「必須」とみなす） */
export const EMPHASIS_RE = /絶対|必須|マスト|譲れ|必ず|だけは|NG|不可|無理|嫌|避け|ダメ|駄目|外せ|最低限|でないと|じゃないと/;
/** 言い直し（property_condition_history.changed_field）→ 条件の種類 */
const HISTORY_FAMILY: Record<string, string> = {
  rent_max: "rent", max_rent: "rent", rent_min: "rent", floor_plan: "floor_plan", layout: "floor_plan", walk_minutes: "walk",
  building_age: "age", floor_area_min: "size", floor_area_max: "size", desired_area: "area", area_mode: "area", initial_cost_limit: "initial_cost",
  commute_station: "commute", commute_minutes: "commute", pet: "pet", move_in_time: "move_in",
};

/**
 * NG 欄の項目 → 条件の種類。実物の NG 欄（property_customers.ng_points 154人・2026-09-28）の書き方から:
 *   「1階NG」「4階以下NG[必須]」「3階未満NG」「敷礼なし」「礼金あり」「独立洗面なし」「木造NG」「築年数が古い物件はNG」「ペット可NG」
 *   「インターネット不可」「エレベーターなし」「バストイレ同室」「トイレに扉がない」「洗濯機置き場がリビングにあるのはNG」
 *   「洋室が小さい物件」「カウンターキッチン不可」「西成区」「〇〇より北のエリア」「環状線沿線」
 */
export const NG_ITEM_FAMILY: ReadonlyArray<[RegExp, string]> = [
  [/[1-9一二三四五]\s*階|階(?:未満|以下)/, "equip:floor2"],
  [/敷|礼金|初期費用/, "initial_cost"],
  [/独立洗面|洗面/, "equip:washbasin"],
  [/木造|鉄骨|構造|アパート/, "equip:structure"],
  [/築|古い|汚い/, "age"],
  [/ペット|動物/, "pet"],
  [/インターネット|ネット|Wi-?Fi/i, "equip:net_free"],
  [/エレベーター|階段/, "equip:elevator"],
  [/バス\s*トイレ|ユニット|3点|トイレ(?:に)?扉|脱衣所にトイレ|アメニティ|アメセパ/, "equip:bath_toilet"],
  [/洗濯機/, "equip:laundry_in"],
  [/狭い|小さい|広さ/, "size"],
  [/カウンターキッチン/, "equip:counter_kitchen"],
  [/コンロ|(?<!カウンター)キッチン/, "equip:gas_stove"],
  [/区|市|エリア|駅|沿線|線|周辺|方面|[北南東西]/, "area"],
];

export type StrengthLevel = "strong" | "stated" | "none";
export type FamilyStrength = { level: StrengthLevel; score: number; signals: string[] };
export type CustomerStrength = {
  byFamily: Record<string, FamilyStrength>;
  /** NG 欄の項目数 */
  ngCount: number;
  /** 強い言い方の行の数（条件欄の自由文） */
  emphasisCount: number;
  /** 条件の言い直しの数（履歴の行） */
  restatements: number;
  /** お客様の発言の数（使える文だけ） */
  messages: number;
  /** 希望を書いた条件の種類の数 */
  wantFamilies: number;
  /** こだわりの強さの指数（下の klass の元） */
  index: number;
  klass: "強い" | "普通" | "弱い";
};

export type StrengthInput = {
  conditions?: Record<string, unknown> | null;
  /** お客様の発言（その回より前だけを渡す） */
  messages?: ReadonlyArray<string> | null;
  /** 条件の言い直し（その回より前だけを渡す） */
  history?: ReadonlyArray<{ changed_field: string }> | null;
};

const str = (v: unknown) => (v == null ? "" : String(v));
const posNum = (v: unknown) => { const n = typeof v === "number" ? v : parseFloat(str(v)); return Number.isFinite(n) && n > 0; };
const topicRe = (k: TopicKey) => TOPICS.find((t) => t.key === k)?.want ?? null;

/**
 * お客様1人（その回の時点）のこだわりの強さ。点（score）の足し方:
 *   条件欄の構造（家賃の上限・間取り・徒歩・築年・広さ・エリア・初期費用・通勤・ペット・入居時期）+1／自由文の希望 +1／
 *   強い言い方の行・NG 欄 +2／発言で触れた回数（最大 +2）／言い直し（最大 +2）。3 以上＝strong・1〜2＝stated・0＝none
 */
export function customerStrength(input: StrengthInput): CustomerStrength {
  const c = input.conditions ?? {};
  const byFamily: Record<string, FamilyStrength> = {};
  const add = (f: string, pts: number, why: string) => {
    const v = (byFamily[f] ??= { level: "none", score: 0, signals: [] });
    v.score += pts; v.signals.push(why);
  };
  // 構造
  if (posNum(c.rent_max) || posNum(c.max_rent)) add("rent", 1, "条件欄: 家賃の上限");
  if (str(c.floor_plan).trim() || str(c.layout).trim()) add("floor_plan", 1, "条件欄: 間取り");
  if (posNum(c.walk_minutes)) add("walk", 1, "条件欄: 徒歩");
  if (posNum(c.building_age)) add("age", 1, "条件欄: 築年");
  if (posNum(c.floor_area_min)) add("size", 1, "条件欄: 広さ");
  if (str(c.desired_area).trim()) add("area", 1, "条件欄: エリア");
  if (posNum(c.initial_cost_limit)) add("initial_cost", 1, "条件欄: 初期費用の上限");
  if (str(c.commute_station).trim()) add("commute", 1, "条件欄: 通勤");
  if (c.pet === true) add("pet", 1, "条件欄: ペット");
  if (str(c.move_in_time).trim() && !/未定|特になし|いつでも/.test(str(c.move_in_time))) add("move_in", 1, "条件欄: 入居時期");
  // 自由文（行ごと・強い言い方の行は +2）。NG 欄は全部の行が強い
  const freeLines = toHalf([c.preferences, c.other_requests, c.additional_conditions, c.raw_format_text].map(str).filter(Boolean).join("\n"))
    .split(/[\n。]/).map((s) => s.trim()).filter(Boolean);
  const ngLines = toHalf(str(c.ng_points)).split(/[\n。]/).map((s) => s.trim()).filter(Boolean);
  const ngCount = toHalf(str(c.ng_points)).split(/[\n、,，・/／]/).map((s) => s.trim()).filter((s) => s && !/^(?:特に)?(?:なし|無し|ない)$/.test(s)).length;
  let emphasisCount = 0;
  const seenFree = new Set<string>(), seenStrong = new Set<string>();
  for (const [line, isNg] of [...freeLines.map((l) => [l, false] as const), ...ngLines.map((l) => [l, true] as const)]) {
    const strong = isNg || EMPHASIS_RE.test(line);
    if (strong && !isNg) emphasisCount++;
    // 「カウンターキッチン」は対面キッチンの種類（話題の語彙の『キッチン』＝ガスコンロに寄せない）
    const lineForTopics = line.replace(/カウンターキッチン|対面キッチン/g, "");
    const fams = new Set(Object.entries(FAMILY_TOPICS).filter(([, topics]) => topics.some((t) => topicRe(t)?.test(lineForTopics))).map(([f]) => f));
    if (lineForTopics !== line) fams.add("equip:counter_kitchen");
    // NG 欄は項目そのものが「嫌な物」（「1階NG」「木造NG」「敷礼なし」）＝希望の言い方の語彙では拾えないので NG の語で寄せる
    if (isNg) for (const [re, f] of NG_ITEM_FAMILY) if (re.test(line)) fams.add(f);
    for (const f of fams) {
      if (!seenFree.has(f)) { seenFree.add(f); add(f, 1, isNg ? "NG 欄の項目" : "自由文"); }
      if (strong && !seenStrong.has(f)) { seenStrong.add(f); add(f, 2, isNg ? "NG 欄" : "強い言い方"); }
    }
  }
  // 発言で触れた回数
  const msgs = (input.messages ?? []).filter(isUsableCustomerText).map((m) => toHalf(m));
  for (const [f, topics] of Object.entries(FAMILY_TOPICS)) {
    const k = msgs.filter((m) => topics.some((t) => topicRe(t)?.test(m))).length;
    if (k) add(f, Math.min(2, k), `発言 ${k}回`);
  }
  // 言い直し
  const hist = new Map<string, number>();
  for (const h of input.history ?? []) { const f = HISTORY_FAMILY[h.changed_field]; if (f) hist.set(f, (hist.get(f) ?? 0) + 1); }
  for (const [f, k] of hist) add(f, Math.min(2, k), `言い直し ${k}回`);
  for (const v of Object.values(byFamily)) v.level = v.score >= 3 ? "strong" : v.score >= 1 ? "stated" : "none";
  const restatements = [...hist.values()].reduce((a, x) => a + x, 0);
  const wantFamilies = Object.keys(byFamily).length;
  const strongFamilies = Object.values(byFamily).filter((v) => v.level === "strong").length;
  const index = ngCount + emphasisCount + Math.min(4, restatements) + strongFamilies;
  return { byFamily, ngCount, emphasisCount, restatements, messages: msgs.length, wantFamilies, index, klass: index >= 6 ? "強い" : index >= 3 ? "普通" : "弱い" };
}
export const strengthLevelOf = (s: CustomerStrength | null | undefined, family: string): StrengthLevel => s?.byFamily[family]?.level ?? "none";

// ─── 訴求（送った文）と採点 ──────────────────────────────────────────────────

export type AppealView = {
  topics: TopicKey[];
  /** 訴求した話題のうち、採点に条件の種類がある物 */
  scoredFamilies: string[];
  /** 訴求した話題のうち、選んだ物の札に無い（採点が見ていない）物。採点に種類の無い話題も含む */
  unscoredTopics: TopicKey[];
  /** うち、採点に種類はあるがこの物件では読めていない（材料の欠け） */
  blindTopics: TopicKey[];
  /** うち、採点に種類が無い（周辺環境・審査・収納 等） */
  noFamilyTopics: TopicKey[];
};
/** 送った文の訴求と、選んだ物の札を並べる */
export function appealVsScore(text: string | null | undefined, chosenCodes: ReadonlyArray<string>): AppealView {
  const topics = appealTopics(text);
  const fams = familiesOf(chosenCodes);
  const scoredFamilies: string[] = [], unscoredTopics: TopicKey[] = [], blindTopics: TopicKey[] = [], noFamilyTopics: TopicKey[] = [];
  for (const t of topics) {
    const f = topicFamily(t);
    if (f && fams[f] && fams[f].state !== "unknown") { if (!scoredFamilies.includes(f)) scoredFamilies.push(f); continue; }
    unscoredTopics.push(t);
    (f ? blindTopics : noFamilyTopics).push(t);
  }
  return { topics, scoredFamilies, unscoredTopics, blindTopics, noFamilyTopics };
}

// ─── 条件の種類 × こだわりの強さ ごとの率 ─────────────────────────────────────

export type DriftRow = {
  family: string;
  level: StrengthLevel | "all";
  /** 比べられた回（その条件で候補の誰かが満たす／満たさないが分かり、選んだ物と選ばなかった物がある回） */
  rounds: number;
  /** 選んだ物がその条件を満たす率（回ごとの平均）・候補全体で満たす率・👑 が満たす率（👑 が決まる回だけ） */
  chosenOk: number | null;
  poolOk: number | null;
  crownOk: number | null;
  crownRounds: number;
  /** 👑 を選ばなかった回で、その条件の点が 選んだ物＞👑（スタッフがその条件を取った）／👑＞選んだ物（点がその条件で 👑 に付いた） */
  chosenAdv: number;
  crownAdv: number;
  /** 👑 と違う回で、材料の欠け（片方が読めていない）で点が 👑 に付いた回（重みのズレには数えない） */
  materialCrownAdv: number;
  /** 選んだ物が満たし 👑 が満たさず、それでも 👑 が上だった回の点の差（入れ替わるのに要った点）の中央値 */
  flipGapMedian: number | null;
  flipRounds: number;
  verdict: "足りない候補" | "強すぎる候補" | "ずれは小さい" | "材料不足";
};

export const DRIFT_CONFIG = { minRounds: 3, mustChosenOk: 0.85, liftMin: 0.15, crownLagMin: 0.15 } as const;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r3 = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 1000);

/**
 * 条件の種類ごと（強さ別と全体）の率。strengthOf は回ごとにお客様のその条件の強さを返す（分からなければ "none"）。
 *   判定の線（DRIFT_CONFIG）: 足りない候補＝選んだ物がほぼ満たし（0.85 以上）、候補全体より 0.15 以上高く、👑 は 0.15 以上低い
 *   （または 👑 と違う回でスタッフがその条件を取った方が多い）。強すぎる候補＝👑 と違う回で点がその条件で 👑 に付いた方が
 * *   スタッフが取った方の2倍＋2 以上（かつ 3回以上）多く、選んだ物の満たす率が候補全体と変わらない（0.05 以内）。
 */
export function familyDrift(rounds: ReadonlyArray<DriftRound>, strengthOf: (r: DriftRound, family: string) => StrengthLevel = () => "none", cfg = DRIFT_CONFIG): DriftRow[] {
  type Acc = { chosenOk: number[]; poolOk: number[]; crownOk: number[]; chosenAdv: number; crownAdv: number; matAdv: number; flip: number[] };
  const acc = new Map<string, Acc>();
  const get = (k: string) => { let a = acc.get(k); if (!a) { a = { chosenOk: [], poolOk: [], crownOk: [], chosenAdv: 0, crownAdv: 0, matAdv: 0, flip: [] }; acc.set(k, a); } return a; };
  for (const r of rounds) {
    const out = roundOutcome(r);
    if (out.allTied || !r.cands.some((c) => c.chosen) || !r.cands.some((c) => !c.chosen)) continue;
    const fam = r.cands.map((c) => familiesOf(c.codes));
    const families = new Set(fam.flatMap((f) => Object.keys(f)));
    const crown = crownOf(r);
    const crownIdx = crown ? r.cands.indexOf(crown) : -1;
    for (const f of families) {
      const oks = fam.map((x) => familyOk(x[f]));
      if (!oks.some((x) => x != null)) continue;
      const chosenVals = r.cands.map((c, i) => (c.chosen ? oks[i] : null)).filter((x): x is boolean => x != null);
      if (!chosenVals.length) continue;
      const poolVals = oks.filter((x): x is boolean => x != null);
      for (const lvl of [strengthOf(r, f), "all"] as const) {
        const a = get(`${f}|${lvl}`);
        a.chosenOk.push(chosenVals.filter(Boolean).length / chosenVals.length);
        a.poolOk.push(poolVals.filter(Boolean).length / poolVals.length);
        if (crownIdx >= 0 && oks[crownIdx] != null) a.crownOk.push(oks[crownIdx] ? 1 : 0);
        if (out.crownChosen === false) {
          const d = out.diffs.find((x) => x.family === f);
          if (d && d.kind === "weight") {
            if (d.delta > 0) a.chosenAdv++;
            if (d.delta < 0) a.crownAdv++;
            if (d.chosenState === "ok" && d.crownState !== "ok" && out.gap != null && out.gap >= 0) a.flip.push(out.gap);
          }
        }
      }
    }
    // 材料の欠けで 👑 に付いた点（選んだ物の側が読めていない時も数える＝上の「比べられる」の外でも）
    if (out.crownChosen === false) {
      for (const d of out.diffs) {
        if (d.kind !== "material" || d.delta >= 0) continue;
        for (const lvl of [strengthOf(r, d.family), "all"] as const) get(`${d.family}|${lvl}`).matAdv++;
      }
    }
  }
  const rows: DriftRow[] = [];
  for (const [k, a] of acc) {
    const [family, level] = k.split("|") as [string, DriftRow["level"]];
    const chosenOk = mean(a.chosenOk), poolOk = mean(a.poolOk), crownOk = mean(a.crownOk);
    let verdict: DriftRow["verdict"] = "ずれは小さい";
    if (a.chosenOk.length < cfg.minRounds) verdict = "材料不足";
    else if (chosenOk != null && poolOk != null && chosenOk >= cfg.mustChosenOk && chosenOk - poolOk >= cfg.liftMin
      && ((crownOk != null && a.crownOk.length >= cfg.minRounds && crownOk <= chosenOk - cfg.crownLagMin) || a.chosenAdv > a.crownAdv)) verdict = "足りない候補";
    else if (a.crownAdv >= cfg.minRounds && a.crownAdv >= 2 * a.chosenAdv + 2 && chosenOk != null && poolOk != null && chosenOk - poolOk <= 0.05) verdict = "強すぎる候補";
    rows.push({
      family, level, rounds: a.chosenOk.length, chosenOk: r3(chosenOk), poolOk: r3(poolOk), crownOk: r3(crownOk), crownRounds: a.crownOk.length,
      chosenAdv: a.chosenAdv, crownAdv: a.crownAdv, materialCrownAdv: a.matAdv, flipGapMedian: median(a.flip), flipRounds: a.flip.length, verdict,
    });
  }
  const lvOrder = { strong: 0, stated: 1, none: 2, all: 3 } as const;
  return rows.sort((x, y) => x.family.localeCompare(y.family) || lvOrder[x.level] - lvOrder[y.level]);
}

// ─── まとめ ──────────────────────────────────────────────────────────────────

export type DriftSummary = {
  rounds: number;
  comparable: number;
  allTied: number;
  /** 👑 が決まった回・👑 を選んだ回 */
  crownRounds: number;
  crownChosen: number;
  /** 選んだ物の順位（点で並べた・一番良い物）が1位／3位以内の回（比べられる回のうち） */
  top1: number;
  top3: number;
  /** 選んだ物の相対順位の平均（0＝1位・1＝最下位・でたらめ 0.5） */
  relRank: number | null;
  /** 👑 と違う回で、👑 だけが持つ札・選んだ物だけが持つ札の多い順 */
  crownOnlyTop: Array<[string, number]>;
  chosenOnlyTop: Array<[string, number]>;
};
export function summarizeRounds(rounds: ReadonlyArray<DriftRound>, topN = 12): DriftSummary {
  let comparable = 0, allTied = 0, crownRounds = 0, crownChosen = 0, top1 = 0, top3 = 0;
  const rel: number[] = [];
  const ko = new Map<string, number>(), co = new Map<string, number>();
  for (const r of rounds) {
    const o = roundOutcome(r);
    if (o.allTied) { allTied++; continue; }
    if (o.chosenPos == null) continue;
    comparable++;
    if (o.chosenPos <= 1) top1++;
    if (o.chosenPos <= 3) top3++;
    if (o.scored > 1) rel.push((o.chosenPos - 1) / (o.scored - 1));
    if (o.crownChosen != null) { crownRounds++; if (o.crownChosen) crownChosen++; }
    if (o.crownChosen === false) {
      for (const k of o.crownOnlyCodes) ko.set(k, (ko.get(k) ?? 0) + 1);
      for (const k of o.chosenOnlyCodes) co.set(k, (co.get(k) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN);
  return { rounds: rounds.length, comparable, allTied, crownRounds, crownChosen, top1, top3, relRank: r3(mean(rel)), crownOnlyTop: top(ko), chosenOnlyTop: top(co) };
}

// ─── 物件の値で見る（採点の札とは別に「選んだ物は条件を満たすか」） ─────────────

export type TopicFactRow = {
  topic: TopicKey;
  level: StrengthLevel | "all";
  rounds: number;
  /** 選んだ物が満たす率・候補全体で満たす率・👑 が満たす率（回ごとの平均） */
  chosenHas: number | null;
  poolHas: number | null;
  crownHas: number | null;
  crownRounds: number;
  /** その話題が採点の札（条件の種類）にあるか */
  scored: boolean;
  verdict: "スタッフが揃える" | "差なし" | "材料不足";
};

/**
 * 候補の値（facts）で、話題ごと × 強さごとに「選んだ物が満たす率」と「候補全体」「👑」を比べる。
 *   設備の話題は「語がある＝満たす」だけ分かる（語が無いのは『無い』ではない）ので、その候補に設備の語が1つも無い時は数えない。
 *   スタッフが揃える＝選んだ物が 0.85 以上満たし、候補全体より 0.15 以上高い（こだわりに合わせて選んでいる）
 */
export function topicFactDrift(rounds: ReadonlyArray<DriftRound>, strengthOf: (r: DriftRound, topic: TopicKey) => StrengthLevel = () => "none", cfg = DRIFT_CONFIG): TopicFactRow[] {
  const EQUIP_TOPICS = new Set<TopicKey>(["bath_toilet", "washbasin", "laundry_in", "autolock", "delivery_box", "security", "kitchen", "bath_dryer", "reheating", "internet", "storage", "corner", "sunny", "parking", "furnished"]);
  const acc = new Map<string, { c: number[]; p: number[]; k: number[] }>();
  for (const r of rounds) {
    const out = roundOutcome(r);
    if (!r.cands.some((c) => c.chosen) || !r.cands.some((c) => !c.chosen) || !r.cands.some((c) => c.facts)) continue;
    const crown = out.allTied ? null : crownOf(r);
    const topics = new Set<TopicKey>(r.cands.flatMap((c) => [...(c.facts?.yes ?? []), ...(c.facts?.no ?? [])]));
    for (const t of topics) {
      const val = (c: DriftCand): boolean | null => {
        const f = c.facts;
        if (!f) return null;
        if (f.yes.includes(t)) return true;
        if (f.no.includes(t)) return false;
        if (EQUIP_TOPICS.has(t) && f.yes.some((y) => EQUIP_TOPICS.has(y))) return false;
        return null;
      };
      const vals = r.cands.map(val);
      const ch = r.cands.map((c, i) => (c.chosen ? vals[i] : null)).filter((x): x is boolean => x != null);
      const pool = vals.filter((x): x is boolean => x != null);
      if (!ch.length || pool.length < 2) continue;
      for (const lvl of [strengthOf(r, t), "all"] as const) {
        const k = `${t}|${lvl}`;
        const a = acc.get(k) ?? { c: [], p: [], k: [] };
        a.c.push(ch.filter(Boolean).length / ch.length);
        a.p.push(pool.filter(Boolean).length / pool.length);
        const kv = crown ? val(crown) : null;
        if (kv != null) a.k.push(kv ? 1 : 0);
        acc.set(k, a);
      }
    }
  }
  const rows: TopicFactRow[] = [];
  for (const [k, a] of acc) {
    const [topic, level] = k.split("|") as [TopicKey, TopicFactRow["level"]];
    const c = mean(a.c), p = mean(a.p);
    const verdict: TopicFactRow["verdict"] = a.c.length < cfg.minRounds ? "材料不足"
      : c != null && p != null && c >= cfg.mustChosenOk && c - p >= cfg.liftMin ? "スタッフが揃える" : "差なし";
    rows.push({ topic, level, rounds: a.c.length, chosenHas: r3(c), poolHas: r3(p), crownHas: r3(mean(a.k)), crownRounds: a.k.length, scored: topicFamily(topic) != null, verdict });
  }
  const lvOrder = { strong: 0, stated: 1, none: 2, all: 3 } as const;
  return rows.sort((x, y) => x.topic.localeCompare(y.topic) || lvOrder[x.level] - lvOrder[y.level]);
}

/** 話題 → そのお客様の強さ（話題が条件の種類に無ければ none） */
export function strengthLevelOfTopic(s: CustomerStrength | null | undefined, t: TopicKey): StrengthLevel {
  const f = topicFamily(t);
  return f ? strengthLevelOf(s, f) : "none";
}
