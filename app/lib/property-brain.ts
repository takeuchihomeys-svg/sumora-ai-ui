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
//   - AD: 取れた分の分布は 1ヶ月 13%／2ヶ月 45%／3ヶ月以上 42%。
//     → **不明は減点しない**。AD が高い物件は加点（竹内「ADちゃんと高い物件か」）。
//     2026-09-25 監査: 「AD=0 は一度も記録されていない」は読み方の取りこぼしだった。itandi の資料は「広告費 なし」と書く（売上サポ id 57・62）
//     → 資料に「なし・0」と書いてある時は adMonths=0（不明の null と分ける）で AD_NONE −5。家賃が読めれば利益も負（PROFIT_NEGATIVE）
//   - 割引: AIX【見積書送る】本文の「N円割引」は中央値 42,000円（Q1 28,000／Q3 68,000・213通）。
//     estimate_action_log は 0行（書き手も無い）ので使わない。利益 = AD円 − 割引 で、負なら hold（落とさない）。
//
// ■ 出口の原則（設計知見「出口の決定論」「誤削除0」）
//   drop は「実送信でほぼ0の形」だけ: 送付済みの建物・家賃比 1.30 超（上限が正しい時だけ）。
//   それ以外は hold。hold は送る（印を付けるだけ）。
//   影の運用（既定）では drop も落とさず印だけ＝誤削除の実測が溜まってから PROPERTY_BRAIN_DROP=on にする。

import { parseRentFromSummary, parseWalkMinutesFromSummary } from "./property-summary-parse";
import { isGenericBuildingName } from "./generic-building-name";
import { EQUIP_LABELS, conditionalFloorOf, parseEquipmentWants, BATH_TOILET_WANT_RE, BATH_TOILET_NOT_REQUIRED_RE, type EquipmentMatch, type EquipKey } from "./listing-equipment";
import { compareMoveIn, CONDITION_KEYS, CONDITION_LABELS, type ConditionKey, type ListingTerms } from "./listing-terms";
import { parseMoveInWant, type MoveInWant } from "./move-in-want";

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
  /** 2026-09-25 専有面積（㎡）。説明文の「25.62㎡」か資料の文字層。不明 = null */
  areaSqm?: number | null;
  /** 2026-09-25 号室（1行目の「303号室」）。送付済みの照合を建物でなく部屋で見るため。不明は持たない */
  roomNo?: string | null;
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
  /** 2026-09-25 「1DKも可」「(厳しければ2LDK)」の型（本命の plans・範囲には入れない）。無ければ持たない */
  alt?: string[];
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
  /** 入居時期の自由文（「11月上旬」「即入居」「未定」）。move-in-want.ts で 'YYYY-MM-DD' に直す */
  move_in_time?: string | null;
  /** 登録日（年の無い「7月」を何年と読むかの基準） */
  created_at?: string | null;
  /** 2026-09-25: 広さの下限（㎡）・条件フォームの原文（「1DKも可」が列に入っていない人がいる） */
  floor_area_min?: number | null;
  raw_format_text?: string | null;
};

/** delivery / source は sent_properties の列（無い呼び出し元は今まで通り全部を送付として扱う） */
export type SentRowLike = { property_name?: string | null; rent?: number | null; delivery?: string | null; source?: string | null; room_no?: string | null };

/**
 * お客様に届いた送付か（売上番長グループへの共有だけの行は false）。GET /api/property-pickups の送った履歴と同じ線:
 *   delivery = 'customer'、または delivery が無く source が line_group でない
 * 2026-09-24: 拡張の「売上番長に送る」は同じ回の物件を delivery='shared' で sent_properties に残す。
 *   送付済みの照合に入れると、その回の物件が自分自身の共有で「送付済み」になる（id 50〜67 の「物件」18件は全部この共有だった）
 */
export function isCustomerDelivery(r: SentRowLike): boolean {
  if (r.delivery === "shared") return false;
  if (r.delivery == null && r.source === "line_group") return false;
  return true;
}
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
  /** 画像の × を必須の × として上限20にする希望（バス・トイレ別は「できれば」と書いた時以外） */
  imageMust?: ImageWantKey[];
  history: {
    sentCount: number;
    sentBuildings: Set<string>;
    /**
     * 2026-09-25 建物 → 送った号室（号室の分からない送付は ""）。任務B: 実際の🌟 121件のうち 9件が「送付済みの建物」で外す候補になり、
     *   うち 4件は同じ建物の**別の部屋**（101→102 など＝新しい空室）だった → 号室が分かって違う時は外す候補にしない
     */
    sentRooms?: Map<string, Set<string>>;
    /** 過去に送った物件の 家賃/rentMax の中央値（材料が無ければ null） */
    rentRatioMedian: number | null;
    /** 中央値の元になった送付の件数（2026-09-25: 3件未満の中央値では RENT_ABOVE_USUAL を付けない） */
    rentRatioN?: number;
    sellingPointsSelected: Record<string, number>;
  };
  discountYen: number;
  confidence: "high" | "mid" | "low";
  /** 入居時期の希望（kind=by・asap の時だけ資料の入居時期と照らす） */
  moveInWant?: MoveInWant;
  /** 入居の条件（楽器・法人・外国籍…）。条件欄にその語がある物だけ */
  conditionWants?: ConditionKey[];
  /** 条件欄に「更新料」「定期借家・契約期間」「フリーレント」の語がある（札を出すかどうか） */
  mentions?: { renewal: boolean; contract: boolean; freeRent: boolean };
  /** 2026-09-25 家賃の下限（使える時だけ・上限より小さい） */
  rentMin?: number | null;
  /** 2026-09-25 「1DKも可」「厳しければ2LDK」の間取り（本命より少し低い点。本命に入っている型は入れない） */
  floorPlanAlt?: FloorPlanWant | null;
  /** 2026-09-25 広さの下限（㎡・列 floor_area_min か間取りの希望の「30平米以上」） */
  sqmMin?: number | null;
  /** 2026-09-25 築年の列が空で、自由文に「新築」「築浅」「新しめ」がある時の年数の目安（情報の札だけ） */
  ageTextMax?: { years: number; word: string } | null;
  /** 2026-09-25 案B お客様が書いた条件の強さ（築浅の自由文・駅近・家賃を低くしたい）。readWrittenWants。無い呼び出し元は「書いていない」扱い */
  written?: WrittenWants;
};

/** 希望の強さ（必須・絶対・マスト＝strong／できれば・あれば＝soft） */
export type WantStrength = "strong" | "normal" | "soft";
/**
 * 2026-09-25 案B お客様が「書いた」条件（scripts/audit-fit-balance.ts の readWants と同じ読み方）。
 *   ageText: 自由文の「新築・築浅・新しめ・築N年以内」の強さ（年数は profile.ageTextMax）／ageColumn: 築年の列
 *   walkText: 自由文の「駅近・駅チカ・徒歩N分以内」（max は徒歩の列 → 文の N 分 → 10分）／walkColumn: 徒歩の列だけ
 *   rentCheap: 自由文「家賃は低い方が良い・安く・抑えたい」（家賃の上限が使える時だけ）
 */
export type WrittenWants = {
  ageText: { strength: WantStrength } | null;
  ageColumn: boolean;
  walkText: { max: number; strength: WantStrength } | null;
  walkColumn: boolean;
  rentCheap: { strength: WantStrength } | null;
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
  /** imageChecks のうち画像の × で上限20にする希望（無い古い判定は バス・トイレ別 を必須とみなす） */
  imageMust?: ImageWantKey[];
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
/**
 * 2026-09-25 任務B: 家賃の超過を比だけで切ると、予算が低いお客様ほど厳しい（上限 5万円なら 1万円の超過で 1.2倍＝保留）。
 *   実際の🌟（465通）の超過は中央値 5,000円・1万円以内が 79.8%・2万円超は 5.1%。
 *   → 比が線を越えても、超過が金額で小さい時は一段ゆるめる: 上限＋1万円以内は保留にしない（0点）、上限＋2万円以内は外す候補にしない（保留）
 */
export const RENT_OVER_SOFT_YEN = 10_000;
export const RENT_OVER_DROP_MIN_YEN = 20_000;

/**
 * 2026-09-25 竹内「広げて検索した場合も、お客さんの希望の方が点数少し大きく。隣の駅だからって点数が大幅に低くならないように。家賃とかでもそう」
 *   拡張の「広げて検索」の幅（chrome-extension/resolution-core.js resolveConditionsLocal ⑧・popup.js と同じ算術）:
 *     家賃の上限 ＋5,000円（上限 10万円以下）／＋10,000円（10万円超）・築年 ＋5年・LDK の希望に同じ部屋数の DK・駅は同じ路線の前後1駅。
 *   その幅の内側は「希望どおり」より少しだけ低い点にし、幅の外から今までの減点・保留にする。
 *   実送信（sent_properties 2,205件・46人・家賃だけ）: 上限内 94.8%／上限〜幅 2.0%／幅〜1.10 0件／1.10〜1.30 1.6%／1.30超 1.6%
 *   ＝幅の内側は実際に送っていて、幅の外で 1.10 以内は 0件（拡張が幅の上で切るので）
 */
export function wideRentBuffer(rentMax: number): number {
  return rentMax <= 100_000 ? 5_000 : 10_000;
}
export const WIDE_AGE_YEARS = 5;
/** 拡張の広さの幅（popup.js buildCondData の −5㎡。⚠ 2026-09-25 時点で手順の表示だけで自動入力には入っていない） */
export const WIDE_SQM = 5;
/**
 * 点の上限（下限 0）。2026-09-25 に 130→200: 条件が全部合う物件は AD なしで 50＋156＝156 前後に届き、130 で切ると
 *   AD の差（1ヶ月 +15／2ヶ月 +30／3ヶ月 +35）が消えていた（竹内「AD は報酬なので重要・200%以上は追加で点」）。
 *   200 は加点の現実的な合計（家賃15・敷礼0 20・間取り15・広さ3・徒歩10・築年5・入居5・設備15・エリア10・通勤8・AD35）＝ 191 の上
 */
export const SCORE_MAX = 200;

export const REASON_JA: Record<string, string> = {
  RENT_OK: "家賃は上限内",
  RENT_WIDE: "家賃が広げた検索の幅の中（上限＋5千円／10万円超は＋1万円まで・管理費込み）",
  RENT_SLIGHTLY_OVER: "家賃が上限を少し超過（1割まで・または1万円まで）",
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
  FLOOR_PLAN_WIDE: "間取りが広げた検索の型（LDK の希望に同じ部屋数の DK）",
  FLOOR_PLAN_MISMATCH: "間取りが希望と違う",
  // 2026-09-25 任務B（実際の🌟で「間取り不一致」の保留が 35件・うち希望より大きい間取り 5人9件・2DK↔1LDK 4人5件）
  FLOOR_PLAN_SAME_CLASS: "間取りが希望と同じ広さの級（2DK↔1LDK）",
  FLOOR_PLAN_LARGER: "間取りが希望より広い",
  WALK_OK: "徒歩は希望内",
  WALK_SLIGHTLY_OVER: "徒歩が希望を少し超過",
  WALK_OVER: "徒歩が希望の1.5倍超",
  BUILDING_AGE_OK: "築年は希望内",
  BUILDING_AGE_SLIGHTLY_OVER: "築年が希望を少し超過",
  BUILDING_AGE_WIDE: "築年が広げた検索の幅の中（希望＋5年まで）",
  BUILDING_AGE_OVER: "築年が希望超過",
  ALREADY_SENT: "この建物は送付済み",
  ALREADY_SENT_OTHER_ROOM: "同じ建物を送付済み（この部屋は送った部屋に無い・号室を確認）",
  ALREADY_SENT_SAME_ROOM: "この部屋は送付済み（送り直しか確認）",
  AD_UNKNOWN: "要確認: AD（読めない・0点）",
  AD_NONE: "AD なし（資料に「広告費 なし」）",
  AD_HIGH: "ADが高い（2ヶ月以上）",
  AD_1M: "AD 1ヶ月以上",
  AD_1_5M: "AD 1.5ヶ月以上",
  AD_2_5M: "AD 2.5ヶ月以上",
  AD_VERY_HIGH: "AD 3ヶ月以上",
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
  // 2026-09-25 資料の表の「募集の条件」（listing-terms.ts）。書いていない時は 0点の要確認・drop には使わない
  MOVE_IN_OK: "入居時期が希望に間に合う（資料）",
  MOVE_IN_LATE: "入居できるのが希望より2週間超遅い（資料）",
  MOVE_IN_UNKNOWN: "要確認: 入居時期（相談・居住中・記載なし）",
  CONTRACT_FIXED: "定期借家（資料）",
  CONTRACT_NORMAL: "普通借家（資料）",
  CONTRACT_UNKNOWN: "要確認: 契約の種類",
  RENEWAL_FEE_NONE: "更新料なし（資料）",
  RENEWAL_FEE_SET: "更新料あり（資料）",
  RENEWAL_FEE_UNKNOWN: "要確認: 更新料",
  FREE_RENT_MATCH: "フリーレントあり（初期費用を抑えたい希望）",
  FREE_RENT: "フリーレントあり（資料）",
  FREE_RENT_UNLISTED: "要確認: フリーレント",
  // 2026-09-25 竹内「家賃の下限入れる」「1DKも可の場合、1DKも入れるが評価はお客さんの希望の間取りの方が点数少し高め」
  RENT_BELOW_MIN: "家賃が下限よりかなり安い（下限の85%未満）",
  FLOOR_PLAN_ALT_MATCH: "間取りが「も可」の型に一致（本命ではない）",
  SQM_OK: "広さは希望以上",
  SQM_SLIGHTLY_UNDER: "広さが希望を少し下回る（9割以上）",
  SQM_WIDE: "広さが広げた検索の幅の中（希望−5㎡まで）",
  SQM_UNDER: "広さが希望の9割未満",
  SQM_UNKNOWN: "要確認: 広さ",
  BUILDING_AGE_TEXT_OK: "築年が「築浅・新築」の希望に合う",
  BUILDING_AGE_TEXT_OVER: "築年が「築浅・新築」の希望より古い",
  // 2026-09-25 竹内「エリアの部分、把握できれば理想」「通勤の部分も沿線の知識」（area-want.ts・osaka-geo.ts・transit-route.ts）
  AREA_STATION_MATCH: "希望の駅",
  AREA_STATION_WIDE: "広げた検索の駅（希望の駅の隣・同じ路線）",
  AREA_STATION_2STOPS: "希望の駅から同じ路線で2駅",
  AREA_WARD_MATCH: "希望の区・市",
  AREA_WARD_WIDE: "広げた検索の区（難波・心斎橋の3区）",
  AREA_LINE_MATCH: "希望の路線の駅",
  AREA_NEAR: "希望のエリアから2km以内",
  AREA_REGION_MATCH: "希望の範囲（大阪市内・環状線内 等）",
  AREA_CLOSE: "希望のエリアに近い（4km以内・隣の区）",
  AREA_FAR: "希望のエリアから離れている",
  AREA_EXCLUDED: "希望外のエリア（◯◯以外）",
  AREA_UNKNOWN: "要確認: 物件の場所",
  AREA_DIRECTION_NG: "希望の方角（◯◯より北 等）と違う",
  COMMUTE_OK: "通勤が希望の時間内",
  COMMUTE_SLIGHTLY_OVER: "通勤が希望を少し超える",
  COMMUTE_OVER: "通勤が希望の時間を超える",
  COMMUTE_INFO: "通勤の所要（目安）",
  COMMUTE_UNKNOWN: "要確認: 通勤の所要",
  // 2026-09-25 案B（竹内「お客さんの希望に合っていたら加点する重み付け・AD のように」「お客さん毎の条件で加点も変動」）
  //   書いた条件だけ重くする札（writtenWeightCodes）。_MUST＝必須・絶対（×1.3）／_SOFT＝できれば（×0.6）
  ZERO_ZERO_INFERRED: "敷礼0（送った物件から初期費用を抑えたい方と推した）",
  AGE_W5: "築5年以内（築浅の希望）", AGE_W10: "築10年以内（築浅の希望）", AGE_W15: "築15年以内（築浅の希望）", AGE_W_OLD: "築15年超（築浅の希望）",
  AGE_W5_MUST: "築5年以内（築浅が必須）", AGE_W10_MUST: "築10年以内（築浅が必須）", AGE_W15_MUST: "築15年以内（築浅が必須）",
  AGE_W5_SOFT: "築5年以内（できれば築浅）", AGE_W10_SOFT: "築10年以内（できれば築浅）", AGE_W15_SOFT: "築15年以内（できれば築浅）",
  AGE_COL_W5: "築5年以内（築年の希望の中でも新しい）", AGE_COL_W10: "築10年以内（築年の希望の中でも新しい）",
  AGE_N5: "築5年以内（築年は書いていない）", AGE_N10: "築10年以内（築年は書いていない）",
  WALK_NEAR_W5: "徒歩5分以内（駅近の希望）", WALK_NEAR_W7: "徒歩7分以内（駅近の希望）",
  WALK_NEAR_W5_MUST: "徒歩5分以内（駅近が必須）", WALK_NEAR_W7_MUST: "徒歩7分以内（駅近が必須）",
  WALK_NEAR_W5_SOFT: "徒歩5分以内（できれば駅近）", WALK_NEAR_W7_SOFT: "徒歩7分以内（できれば駅近）",
  WALK_NEAR_N: "徒歩5分以内（駅近は書いていない）",
  WALK_TEXT_OK: "徒歩が「駅近」の希望内", WALK_TEXT_OVER: "徒歩が「駅近」の希望を超える（15分以内）", WALK_TEXT_FAR: "徒歩が「駅近」の希望を大きく超える（15分超）",
  RENT_CHEAP_W80: "家賃が上限の8割以下（家賃を低くしたい希望）", RENT_CHEAP_W90: "家賃が上限の9割以下（家賃を低くしたい希望）", RENT_CHEAP_W95: "家賃が上限の95%以下（家賃を低くしたい希望）",
  RENT_CHEAP_W80_MUST: "家賃が上限の8割以下（家賃を低くが必須）", RENT_CHEAP_W90_MUST: "家賃が上限の9割以下（家賃を低くが必須）", RENT_CHEAP_W95_MUST: "家賃が上限の95%以下（家賃を低くが必須）",
  RENT_CHEAP_W80_SOFT: "家賃が上限の8割以下（できれば家賃を低く）", RENT_CHEAP_W90_SOFT: "家賃が上限の9割以下（できれば家賃を低く）", RENT_CHEAP_W95_SOFT: "家賃が上限の95%以下（できれば家賃を低く）",
  AD_UNDER_1M: "AD 1ヶ月未満（報酬が少ない）",
  FIT_ALL: "書いた条件に全部合う", FIT_ALL_HALF: "書いた条件（2つ）に全部合う", FIT_ONE_MISS: "書いた条件のうち1つだけ外れ", FIT_ONE_MISS_HALF: "書いた条件（2つ）のうち1つだけ外れ",
};

/**
 * 入居の条件（楽器・法人・外国籍…）の理由コード。CONDITION_<KEY>_OK / _NG / _ASK / _UNLISTED。
 * 2026-09-25: 条件欄にその語がある時だけ付ける。不可は −10 で保留（外す候補にはしない）・可は +3・相談と記載なしは 0点の要確認
 */
export const CONDITION_CODE_KEYS: Record<ConditionKey, string> = {
  instrument: "INSTRUMENT", corporate: "CORPORATE", foreigner: "FOREIGNER", student: "STUDENT", office: "OFFICE",
  singleOnly: "SINGLE", twoPerson: "TWO_PERSON", roomShare: "ROOM_SHARE", children: "CHILDREN",
};
/**
 * 2026-09-25 竹内「条件が合わない物件が AD だけで最上位にならないように」:
 *   保留・外す候補の札（条件の外れ）がある物件は、AD の段の札を「_HELD」（0点）に替える＝札は残して AD は見えるが点に入れない。
 *   実データ（property_pickups・新しい配点）: 入居が遅い保留（AD 2.2ヶ月・106点）が通す物件（AD 1.5ヶ月・100点）より上、
 *   2階以上×の保留（AD 2ヶ月・109点）が通す物件（AD 1ヶ月・109〜111点）と並んでいた → どちらも AD の段の点が理由。
 *   半分にする案は「保留 −10 ＋ AD 3ヶ月の半分 13」で条件の同じ通す物件（AD 不明）を上回るので採らない。
 *   保留の中の並びは条件の点で決まる（AD では上下しない）。スタッフの🌟が保留だった回（🌟の本文で判定 64/670）は AD の分かる物が1件だけで、
 *   「条件外を AD で選んでいる」とは言えない（scripts/audit-ad-hold-line.ts）
 */
export const AD_TIER_CODES = ["AD_1M", "AD_1_5M", "AD_HIGH", "AD_2_5M", "AD_VERY_HIGH"] as const;
export const AD_HELD_SUFFIX = "_HELD";
/** AD の段の札を保留の形（_HELD・0点）にする／戻す。それ以外の札はそのまま */
export function settleHeldAd(codes: string[], held: boolean): string[] {
  return codes.map((c) => {
    const base = c.endsWith(AD_HELD_SUFFIX) ? c.slice(0, -AD_HELD_SUFFIX.length) : c;
    if (!(AD_TIER_CODES as readonly string[]).includes(base)) return c;
    return held ? `${base}${AD_HELD_SUFFIX}` : base;
  });
}

export const CONDITION_OK_POINTS = 3;
export const CONDITION_NG_POINTS = -10;
function conditionKeyOfCode(k: string): ConditionKey | null {
  return (Object.keys(CONDITION_CODE_KEYS) as ConditionKey[]).find((c) => CONDITION_CODE_KEYS[c] === k) ?? null;
}

/**
 * 資料の設備欄との照合（listing-equipment.ts）の理由コード。EQUIP_<KEY>_OK / _NG / _UNLISTED（KEY は EquipKey の大文字・階の範囲は FLOOR）。
 * 2026-09-24 竹内「宅配BOX付きなども条件なのにそこちゃんと入れていない」「設備面も見るように」:
 *   × は −10 で保留（外す候補にはしない）・必須（strong）の × は上限20点（画像で分析と同じ決まり）・
 *   ○ と ○〔建〕 は +3（合計 +15 まで。越えた分は _OK_MAX で 0点）・－（記載なし）は 0点で「要確認: 宅配ボックス」の札。
 *   ペット相談（△）は _ASK で 0点（相談は可とは限らない）
 */
export const EQUIP_OK_POINTS = 3;
export const EQUIP_OK_MAX_TOTAL = 15;
export const EQUIP_NG_POINTS = -10;
export const EQUIP_STRONG_NG_CAP = 20;
export const EQUIP_CAP_CODE = "EQUIP_MUST_NG_CAP";

export function equipKeyLabel(key: string): string {
  // 2026-09-25 案B: 強さの付いた ○ の札（EQUIP_<KEY>_MUST_OK・_SOFT_OK）は KEY の後ろに _MUST／_SOFT が付く
  if (/_MUST$/.test(key)) return `${equipKeyLabel(key.slice(0, -5))}（必須）`;
  if (/_SOFT$/.test(key)) return `${equipKeyLabel(key.slice(0, -5))}（できれば）`;
  // 「無いほうがよい」希望（ロフトNG 等）は KEY_NOT（画面の1行の「ロフトNG○」と同じ言い方にする）
  if (/_NOT$/.test(key)) return `${equipKeyLabel(key.slice(0, -4))}NG`;
  const k = key.toLowerCase();
  if (k === "floor") return "階の希望";
  return EQUIP_LABELS[k as EquipKey] ?? key;
}

/** 理由コードの日本語（EQUIP_* は項目名から作る・それ以外は REASON_JA）。知らないコードはそのまま */
export function reasonJa(code: string): string {
  if (REASON_JA[code]) return REASON_JA[code];
  if (code.endsWith(AD_HELD_SUFFIX) && REASON_JA[code.slice(0, -AD_HELD_SUFFIX.length)]) return `${REASON_JA[code.slice(0, -AD_HELD_SUFFIX.length)]}（保留の物件なので点に入れない）`;
  if (code === EQUIP_CAP_CODE) return `必須の条件が資料で×（上限${EQUIP_STRONG_NG_CAP}点）`;
  const cm = code.match(/^CONDITION_(.+?)_(OK|NG|ASK|UNLISTED)$/);
  if (cm) {
    const ck = conditionKeyOfCode(cm[1]);
    const label = ck ? CONDITION_LABELS[ck] : cm[1];
    switch (cm[2]) {
      case "OK": return `${label}○（資料）`;
      case "NG": return `${label}不可（資料）`;
      case "ASK": return `${label}は相談（要確認）`;
      default: return `要確認: ${label}`;
    }
  }
  const m = code.match(/^EQUIP_(.+?)_(OK_MAX|OK|NG|UNLISTED|ASK|NEAR)$/);
  if (!m) return code;
  const label = equipKeyLabel(m[1]);
  switch (m[2]) {
    case "OK": return `${label}○（資料）`;
    case "OK_MAX": return `${label}○（資料・加点は上限）`;
    case "NG": return `${label}×（資料）`;
    case "ASK": return `${label}は相談（要確認）`;
    case "NEAR": return `${label}が希望より一段下（資料）`;
    default: return `要確認: ${label}`;
  }
}

/**
 * 照合の行 → 理由コード（同じコードは1つだけ・○ の加点は合計 +15 まで）。
 * 2026-09-25 案B: ○ の点は希望の強さで変える（必須 +5 EQUIP_<KEY>_MUST_OK／普通 +3 EQUIP_<KEY>_OK／できれば +2 EQUIP_<KEY>_SOFT_OK）。
 *   合計 +15 を越える ○ は今まで通り _OK_MAX（0点）。案（audit-fit-balance）は越えた分を端数で足すが、札の点を固定にするため丸ごと 0点にした
 */
export function equipmentReasonCodes(m: EquipmentMatch | null | undefined): string[] {
  if (!m) return [];
  const out: string[] = [];
  let okPts = 0;
  // 2026-09-25 必須の ○ を先に数える（並び順のせいで必須の ○ が +15 の上限に当たって 0点になるのを防ぐ）
  const rank = (r: EquipmentMatch["rows"][number]) => (r.want.strong ? 0 : r.want.soft ? 2 : 1);
  const rows = [...m.rows].sort((a, b) => rank(a) - rank(b));
  for (const r of rows) {
    // mode=ng（「ロフトNG」）は別のコード（EQUIP_LOFT_NOT_OK＝ロフトが無い＝希望どおり）。同じ KEY だと「ロフト○」と読めて逆の意味になる
    const KEY = String(r.want.key).toUpperCase() + (r.want.mode === "ng" ? "_NOT" : "");
    const okCode = r.want.strong ? `EQUIP_${KEY}_MUST_OK` : r.want.soft ? `EQUIP_${KEY}_SOFT_OK` : `EQUIP_${KEY}_OK`;
    const okPt = r.want.strong ? EQUIP_OK_POINTS_MUST : r.want.soft ? EQUIP_OK_POINTS_SOFT : EQUIP_OK_POINTS;
    let code: string;
    if (r.result === "ng") code = `EQUIP_${KEY}_NG`;
    else if (r.result === "unlisted") code = `EQUIP_${KEY}_UNLISTED`;
    // 構造の一段下（鉄筋の希望に鉄骨）は「少し低い」（0点・保留にしない）。ペット相談の △ とは別のコード
    else if (r.mark === "△" && r.want.key === "structure") code = `EQUIP_${KEY}_NEAR`;
    else if (r.mark === "△") code = `EQUIP_${KEY}_ASK`;
    else if (okPts + okPt <= EQUIP_OK_MAX_TOTAL) code = okCode;
    else code = `EQUIP_${KEY}_OK_MAX`;
    if (out.includes(code)) continue;
    if (code === okCode) okPts += okPt;
    out.push(code);
  }
  if (m.strongNg) out.push(EQUIP_CAP_CODE);
  return out;
}

/**
 * 理由コードごとの点（judgeProperty の add の点と同じ。基準 50 点に足す・上限 SCORE_MAX（200）・下限 0）。
 * 2026-09-24 竹内「今回なんで外されているのか理由が分かれば大きい」: 画面で「どの理由で何点」を出すために表にした。
 *   judgeProperty の点を変えたらここも変える（property-brain.test.ts が全コードで 50＋合計＝score を確かめる）。
 *   画像の読み取り（IMAGE_*）は applyImageFacts: _OK +5・_NG −10（imageReasonPoints）
 */
export const BASE_SCORE = 50;
export const REASON_POINTS: Record<string, number> = {
  RENT_OK: 15, RENT_SLIGHTLY_OVER: 0, RENT_OVER_110: -20, RENT_OVER_130: -35, RENT_ABOVE_USUAL: -5, RENT_UNKNOWN: 0, RENT_MAX_UNRELIABLE: 0,
  ZERO_ZERO_MATCH: 20, ZERO_ZERO: 8, INITIAL_COST_NOT_ZERO: -15, INITIAL_COST_OVER_LIMIT: -10, INITIAL_COST_UNKNOWN: 0,
  FLOOR_PLAN_MATCH: 15, FLOOR_PLAN_NEAR: 5, FLOOR_PLAN_MISMATCH: -15,
  WALK_OK: 10, WALK_SLIGHTLY_OVER: -5, WALK_OVER: -15,
  BUILDING_AGE_OK: 5, BUILDING_AGE_SLIGHTLY_OVER: -3, BUILDING_AGE_OVER: -10,
  ALREADY_SENT: -30,
  // 2026-09-25 竹内「AD は2ヶ月以上だと点数が高い形。ほかの項目より AD は1.3倍ほど価値ある」→
  //   竹内「AD 150%以上は1.15倍、200%以上は1.3倍と重みを付ける。ここ分ける」:
  //   基準の1段＝ほかの項目の同じ段（家賃が上限内・間取り一致の +15）。1ヶ月〜1.5ヶ月未満 +15（1.0倍）／
  //   1.5ヶ月以上 +17（15×1.15・AD_1M 15 ＋ AD_1_5M 2）／2ヶ月以上 +20（15×1.3・AD_HIGH 単独）。2.5ヶ月・3ヶ月以上は札だけ（0点・2ヶ月以上は1.3倍で一律）。
  //   割引をまかなえる（AD_COVERS_DISCOUNT）は段と二重に数えるので 0点の知らせ。AD 不明は 0点の「要確認」・AD なし −5・利益が出ない −10 保留は今まで通り。
  //   保留・外す候補の物件の AD は *_HELD の札で 0点（条件が合わない物件を AD だけで上げない）
  AD_UNKNOWN: 0, PROFIT_NEGATIVE: -10, AD_COVERS_DISCOUNT: 0, AD_1M: 15, AD_1_5M: 2, AD_HIGH: 20, AD_2_5M: 0, AD_VERY_HIGH: 0,
  PET_NG: -15,
  // 2026-09-25 資料の表の募集の条件（listing-terms.ts）
  MOVE_IN_OK: 5, MOVE_IN_LATE: -10, MOVE_IN_UNKNOWN: 0,
  CONTRACT_FIXED: -5, CONTRACT_NORMAL: 0, CONTRACT_UNKNOWN: 0,
  RENEWAL_FEE_NONE: 0, RENEWAL_FEE_SET: 0, RENEWAL_FEE_UNKNOWN: 0,
  FREE_RENT_MATCH: 3, FREE_RENT: 0, FREE_RENT_UNLISTED: 0,
  // 2026-09-25 家賃下限・間取りの「も可」・広さ・築浅の自由文（下限と築浅は情報の札。保留にしない）
  RENT_BELOW_MIN: -3,
  FLOOR_PLAN_ALT_MATCH: 8,
  SQM_OK: 3, SQM_SLIGHTLY_UNDER: 0, SQM_UNDER: -10, SQM_UNKNOWN: 0,
  // 2026-09-25 案B: 築浅の自由文の○×は 0点の札（全部合うの数に入る）。点は段の札（AGE_W*）で数える（旧 ○ +3）
  BUILDING_AGE_TEXT_OK: 0, BUILDING_AGE_TEXT_OVER: 0,
  // 2026-09-25 エリア・通勤（外す候補にしない。以外に当たる時だけ保留）
  AREA_STATION_MATCH: 10, AREA_WARD_MATCH: 8, AREA_LINE_MATCH: 6, AREA_NEAR: 5, AREA_REGION_MATCH: 3, AREA_CLOSE: 2, AREA_FAR: -3,
  AREA_EXCLUDED: -10, AREA_UNKNOWN: 0, AREA_DIRECTION_NG: -3,
  COMMUTE_OK: 8, COMMUTE_SLIGHTLY_OVER: 0, COMMUTE_OVER: -5, COMMUTE_INFO: 0, COMMUTE_UNKNOWN: 0,
  // 2026-09-25 拡張の「広げて検索」の幅の内側（希望どおりより少しだけ低い・保留にしない）。
  //   駅: 希望 +10 ／隣（拡張が広げる前後1駅）+8 ／同じ路線で2駅 +6（今までは距離で +5〜+2 だった）
  //   家賃: 上限内 +15 ／幅の中 +10（今までは 0）・間取り: 本命 +15 ／LDK→同じ部屋数の DK +8（今までは近い +5）
  //   築年: 希望内 +5 ／＋5年まで +2（今までは ＋3年まで −3・＋4〜5年は −10 保留）・広さ: 9割以上 0 ／−5㎡まで −3（今までは −10 保留）
  AREA_STATION_WIDE: 8, AREA_STATION_2STOPS: 6, AREA_WARD_WIDE: 6,
  RENT_WIDE: 10, FLOOR_PLAN_WIDE: 8, BUILDING_AGE_WIDE: 2, SQM_WIDE: -3,
  // 2026-09-25 監査（任務A・B）: 保留・外す候補にしない札。
  //   同じ建物の別の部屋 −3（旧: 建物で −30 の外す候補）・2DK↔1LDK +8（旧: 不一致 −15 保留）・希望より広い間取り +5（旧: 不一致 −15 保留）
  //   AD なし −5（旧: 不明と同じ 0点で AD 0.5ヶ月より上に並んでいた）
  ALREADY_SENT_OTHER_ROOM: -3, FLOOR_PLAN_SAME_CLASS: 8, FLOOR_PLAN_LARGER: 5,
  // AD なし: 旧 −5 → 2026-09-25 案B −10（竹内「AD 1未満は点数低く・なかなかお勧めしない」）
  AD_NONE: -10,
  // 号室を読んで初めて当たる「同じ部屋を送付済み」（旧は当たらなかった形）は保留 −10（外す候補にしない）
  ALREADY_SENT_SAME_ROOM: -10,
  // ── 2026-09-25 案B（竹内さん決定・scripts/audit-fit-balance.ts の PLAN_B・例の25問は fit-balance.test.ts）──────────────
  //   竹内「お客さんの希望に合っていたら点数加点する重み付け・AD のように」「全部の条件当てはまっていたらさらに加点」
  //   「お客さんにベストな物件が一番オススメ」「AD 低ければ利益にならないので AD も重要」「AD 1未満は点数低く・なかなかお勧めしない」
  //   「初期費用を抑えたいお客さんには敷金礼金0円が加点・お客さん毎の条件で加点も変動」
  //   → お客様が**書いた**条件だけ重くする（書いていない条件は軽く）。点は今まで通り「50＋札の点の合計」（上限200）。
  //   倍率（築年・徒歩・家賃の安さ）: 必須 ×1.3（_MUST）・できれば ×0.6（_SOFT）を丸めた値を札ごとに持つ（札の点は固定＝付け直せる）
  // 敷礼0: 書いた人 +20（ZERO_ZERO_MATCH）・送った物件から推した人 +14・書いていない人 +8（ZERO_ZERO）
  ZERO_ZERO_INFERRED: 14,
  // 築年（自由文の「築浅・新築・築N年以内」を書いた人）: 5年以内 +12／10年以内 +8／15年以内 +3／15年超 −3（BUILDING_AGE_TEXT_* は 0点の○×の札に）
  AGE_W5: 12, AGE_W10: 8, AGE_W15: 3, AGE_W_OLD: -3,
  AGE_W5_MUST: 16, AGE_W10_MUST: 10, AGE_W15_MUST: 4,
  AGE_W5_SOFT: 7, AGE_W10_SOFT: 5, AGE_W15_SOFT: 2,
  // 築年の列を書いた人（BUILDING_AGE_OK +5 に上乗せ・合計 5年以内 12／10年以内 8／それ以外 5＝案の max(5, 段)）
  AGE_COL_W5: 7, AGE_COL_W10: 3,
  // 築年を書いていない人（軽く）: 5年以内 +3／10年以内 +1
  AGE_N5: 3, AGE_N10: 1,
  // 駅近を書いた人: 徒歩5分以内 +5／7分以内 +2（徒歩の列だけの人は今まで通り WALK_OK）。書いていない人 5分以内 +2
  WALK_NEAR_W5: 5, WALK_NEAR_W7: 2, WALK_NEAR_W5_MUST: 7, WALK_NEAR_W7_MUST: 3, WALK_NEAR_W5_SOFT: 3, WALK_NEAR_W7_SOFT: 1,
  WALK_NEAR_N: 2,
  // 駅近を書いたが徒歩の列が空の人: 希望内 +10（WALK_OK と同じ）／15分以内 −3／15分超 −8（保留にしない）
  WALK_TEXT_OK: 10, WALK_TEXT_OVER: -3, WALK_TEXT_FAR: -8,
  // 家賃を低くしたい人（自由文「家賃は低い方が良い」）: 上限の 0.8 以下 +8／0.9 以下 +5／0.95 以下 +2
  RENT_CHEAP_W80: 8, RENT_CHEAP_W90: 5, RENT_CHEAP_W95: 2,
  RENT_CHEAP_W80_MUST: 10, RENT_CHEAP_W90_MUST: 7, RENT_CHEAP_W95_MUST: 3,
  RENT_CHEAP_W80_SOFT: 5, RENT_CHEAP_W90_SOFT: 3, RENT_CHEAP_W95_SOFT: 1,
  // AD 1ヶ月未満（0 より大きく 1 未満・利益が出ない保留の札が無い時）−8。AD なしは −10（旧 −5）。AD 不明は 0 のまま
  AD_UNDER_1M: -8,
  // 全部合う +15・1つだけ外れ +5（書いた条件のうち読めた物で数える・条件2つなら半分・保留の物件には付けない）
  FIT_ALL: 15, FIT_ALL_HALF: 8, FIT_ONE_MISS: 5, FIT_ONE_MISS_HALF: 3,
};

/** 設備 ○ の点（案B: 必須 +5／普通 +3／できれば +2・合計 +15 まで）。札は EQUIP_<KEY>_MUST_OK／EQUIP_<KEY>_OK／EQUIP_<KEY>_SOFT_OK */
export const EQUIP_OK_POINTS_MUST = 5;
export const EQUIP_OK_POINTS_SOFT = 2;
/**
 * 2026-09-25 重みの版（scoring_weights の active・app/lib/scoring-learning-server.ts の applyActiveScoringWeights が入れる）。
 *   null ＝ この表の定数のまま（DB が読めない時・版が無い時）。札の点だけを上書きする（札の付け方・保留／外す候補の決まりは変えない）
 */
let reasonPointOverrides: Record<string, number> | null = null;
export function setReasonPointOverrides(m: Record<string, number> | null): void {
  reasonPointOverrides = m && Object.keys(m).length ? { ...m } : null;
}
export function getReasonPointOverrides(): Record<string, number> | null {
  return reasonPointOverrides;
}

/** 理由コードの点（画像の読み取り IMAGE_*_OK/_NG も含む）。知らないコードは 0。重みの版があればそちら */
export function reasonPoints(code: string): number {
  if (reasonPointOverrides && Object.prototype.hasOwnProperty.call(reasonPointOverrides, code)) return reasonPointOverrides[code];
  return baseReasonPoints(code);
}
/** コードの定数の点（重みの版を見ない・学習の基準） */
export function baseReasonPoints(code: string): number {
  if (/^IMAGE_.*_OK$/.test(code)) return 5;
  if (/^IMAGE_.*_NG$/.test(code)) return -10;
  if (/^EQUIP_.*_MUST_OK$/.test(code)) return EQUIP_OK_POINTS_MUST;
  if (/^EQUIP_.*_SOFT_OK$/.test(code)) return EQUIP_OK_POINTS_SOFT;
  if (/^EQUIP_.*_OK$/.test(code)) return EQUIP_OK_POINTS;
  if (/^EQUIP_.*_NG$/.test(code)) return EQUIP_NG_POINTS;
  if (/^EQUIP_/.test(code)) return 0; // _UNLISTED・_ASK・_OK_MAX・上限の印（上限20は reasonPoints の外）
  if (/^CONDITION_.*_OK$/.test(code)) return CONDITION_OK_POINTS;
  if (/^CONDITION_.*_NG$/.test(code)) return CONDITION_NG_POINTS;
  if (/^CONDITION_/.test(code)) return 0; // _ASK・_UNLISTED
  return REASON_POINTS[code] ?? 0;
}

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
    // 2026-09-25: 🌟 の付いた番号（【1🌟★】）も落とす（売上サポは🌟を付けた後の説明文を読むので、旧は🌟の物件が送付済みに当たらなかった）
    .replace(/^【\s*\d+\s*(?:🌟|★|☆)*\s*】\s*/u, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 部屋番号の表記ゆれをそろえる（「0403」「403号室」「４０３」→ "403"）。読めなければ "" */
export function normalizeRoomKey(raw: string | null | undefined): string {
  const m = toHalfWidth(String(raw ?? "")).match(/(\d{1,5})\s*号?室?\s*$/);
  return m ? m[1].replace(/^0+(?=\d)/, "") : "";
}

/** 「セレニティ照ヶ丘 303号室」「X 303」→ 建物名と号室（sent-property-filter の parseSummaryHead と同じ線・号室が無ければ room=""） */
export function splitBuildingRoom(name: string | null | undefined): { building: string; room: string } {
  const s = toHalfWidth(String(name ?? "")).replace(/^【\s*\d+\s*(?:🌟|★|☆)*\s*】\s*/u, "").trim();
  const m = s.match(/[\s　]+(\d{1,4})(?:号室?)?$/) ?? s.match(/(\d{1,4})号室$/);
  if (!m) return { building: s, room: "" };
  const building = s.slice(0, m.index ?? 0).trim();
  return building ? { building, room: normalizeRoomKey(m[1]) } : { building: s, room: "" };
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
  // 【1🌟★】（🌟 の順位付けの後の説明文）も番号として読む
  const rankM = first.match(/^【\s*(\d+)\s*(?:🌟|★|☆)*\s*】/u);
  const name = first.replace(/^【\s*\d+\s*(?:🌟|★|☆)*\s*】\s*/u, "").trim() || String(data?.name ?? "") || "物件";
  const roomNo = splitBuildingRoom(name).room || null;
  const rest = lines.slice(1);
  const restText = rest.join("\n");

  // 家賃・管理費
  const rentYen = num(data?.rent) ?? parseRentFromSummary(raw);
  let adminFeeYen: number | null = null;
  const adm = restText.replace(/,/g, "").match(/(?:管理費|共益費)\s*[:：]?\s*(\d+)\s*円/);
  if (adm) adminFeeYen = parseInt(adm[1], 10);
  else if (/(?:管理費|共益費)[・･‧]?(?:共益費)?\s*[:：]?\s*(?:なし|無し|－|-|0円)/.test(restText)) adminFeeYen = 0;
  // 2026-09-24: リアプロの説明文は「75,000円 10,000円」（家賃の後ろに管理費が言葉なしで並ぶ）。読まずに家賃だけで上限と比べていた
  //   （id 34〜45 の全件が「家賃は上限内 +15」・実際は 85,000円で上限 80,000円を超えていた）。
  //   pickup-dedupe の adminFeeOf と同じ線: 行の1つ目の金額が家賃と同じで、2つ目が家賃より小さく 10万円以下の時だけ
  if (adminFeeYen == null && rentYen != null) {
    for (const l of rest) {
      const amounts = [...l.replace(/,/g, "").matchAll(/(\d+)\s*円/g)].map((m) => parseInt(m[1], 10));
      if (amounts.length >= 2 && amounts[0] === rentYen && amounts[1] < rentYen && amounts[1] <= 100_000) { adminFeeYen = amounts[1]; break; }
    }
  }

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
  const adLine = rest.find((l) => /^(A\s?D|広告料|広告費)/i.test(l));
  if (adLine) {
    const m = adLine.match(/(\d+(?:\.\d+)?)\s*[ヶかカケ]?\s*月/);
    const y = adLine.replace(/,/g, "").match(/(\d+)\s*円/);
    const pct = adLine.match(/(\d+(?:\.\d+)?)\s*[%％]/);
    if (m && adMonths == null) adMonths = parseFloat(m[1]);
    else if (!m && pct && adMonths == null) adMonths = parseFloat(pct[1]) / 100;
    else if (!m && y && adYen == null) adYen = parseInt(y[1], 10);
    // 2026-09-25 「AD なし」（資料の「広告費 なし」を補った行）＝ 0（読めない null と分ける）
    else if (!m && !y && adMonths == null && adYen == null && /^(?:A\s?D|広告料|広告費)\s*[:：]?\s*(?:なし|無し|無|0)\s*$/i.test(adLine)) adMonths = 0;
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

  // 専有面積（「1K 25.62㎡」「21.09m2」）。読めた時だけ持つ（無い行の形は今まで通り）
  const sq = restText.match(/(\d{1,3}(?:\.\d{1,2})?)\s*(?:㎡|m2|m²|平米)/i);
  const areaSqm = sq ? parseFloat(sq[1]) : null;

  return {
    name, rank: rankM ? parseInt(rankM[1], 10) : num(data?.rank),
    rentYen, adminFeeYen, depositMonths, keyMoneyMonths, adMonths, adYen, walkMinutes, floorPlan, buildingAge,
    ...(areaSqm != null && areaSqm >= 5 && areaSqm <= 500 ? { areaSqm } : {}),
    ...(roomNo ? { roomNo } : {}),
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

  // 2026-09-25 竹内「1DKも可の場合、1DKも入れるが評価はお客さんの希望の間取りの方が点数少し高め」:
  //   「1DKも可」「1DKでもOK」「(厳しければ2LDK)」の型は alt に分ける（本命＝それ以外の型）。全部が「も可」なら本命として読む
  const isAlt = (f: { start: number; end: number }) =>
    ALT_AFTER_RE.test(t.slice(f.end, f.end + 14)) || ALT_BEFORE_RE.test(t.slice(Math.max(0, f.start - 10), f.start));
  const altFound = found.filter(isAlt);
  if (altFound.length > 0 && altFound.length < found.length) {
    out.alt = [...new Set(altFound.map((f) => f.plan))];
    found.splice(0, found.length, ...found.filter((f) => !isAlt(f)));
  }

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

/** 間取りの型の後ろの「も可」（「1DKも可」「1DKでもOK」「1DK(7帖以上)も可」「1DKも検討」） */
const ALT_AFTER_RE = /^\s*(?:[(（][^)）]{0,8}[)）])?\s*(?:も|でも)\s*(?:可|OK|大丈夫|良い|よい|いい|検討|アリ|あり|かまわない|構わない)/;
/** 間取りの型の前の「厳しければ」「無ければ」「妥協して」 */
const ALT_BEFORE_RE = /(?:厳しければ|難しければ|無ければ|なければ|妥協して|最悪|第二希望[:：]?)\s*$/;

/**
 * additional_conditions は条件の記録（「[9/19 18:23|auto] 間取り: 1LDK・2LDK」）が時系列で並ぶ。前の回の間取りは今の希望ではない
 *   （実例: 「条件を1LDKから1DKに変更」→ 後で 1LDK に戻した）ので、「間取り:」の欄は最後の1つだけ残す
 */
function additionalWithoutOldPlans(s: string | null | undefined): string {
  const lines = String(s ?? "").split("\n");
  const idx = lines.map((l, i) => (/間取り?\s*[:：]/.test(l) ? i : -1)).filter((i) => i >= 0);
  const last = idx.length ? idx[idx.length - 1] : -1;
  return lines.map((l, i) => (i !== last ? l.replace(/間取り?\s*[:：][^/\n]*/g, "") : l)).join("\n");
}
/** 条件フォームの原文の間取りの行（「【希望の広さ・間取り】⇒1K 1DK 1LDK」）。質問の例（「間取り(1K、1LDKなど)」）は外す */
function formPlanLines(s: string | null | undefined): string {
  return String(s ?? "").split("\n").filter((l) => /間取|広さ/.test(l)).map((l) => l.replace(/[(（][^)）]*など[)）]/g, "")).join("\n");
}
/**
 * 条件フォームの「希望」の行に並べた型（「【希望の広さ・間取り】⇒1K 1DK 1LDK」）は本命（竹内「本命＝列・希望と書かれた方」）。
 *   列の型が全部その行にある時だけ、行の型を本命に足す（列と食い違う古いフォームは使わない）
 */
export function formWantPlans(c: CustomerLike, main: FloorPlanWant): string[] {
  if (main.any) return [];
  const out: string[] = [];
  for (const l of formPlanLines(c.raw_format_text).split("\n")) {
    if (!/希望/.test(l)) continue;
    const w = normalizeFloorPlanWant(l.replace(/^[^⇒:：】]*[⇒:：】]/, ""));
    if (w.any || !main.plans.every((p) => w.plans.includes(p))) continue;
    for (const p of w.plans) if (!main.plans.includes(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * 2026-09-25: 条件欄の自由文・条件フォームの原文にある間取りの型のうち、本命（floor_plan の列）に入っていない物＝「も可」の型。
 *   例: 列「1LDK」・自由文「1DKも可」「1LDK or 2K」→ 1DK・2K。NG 欄（ng_points）と「1Kは嫌」「1R NG」は入れない。
 *   列の中の「も可」（normalizeFloorPlanWant の alt）も合わせる。何も無ければ null
 */
export function parseFloorPlanAlt(c: CustomerLike, main: FloorPlanWant): FloorPlanWant | null {
  const plans: string[] = [...(main.alt ?? [])];
  const text = [c.preferences, c.other_requests, additionalWithoutOldPlans(c.additional_conditions), formPlanLines(c.raw_format_text)].map((s) => toHalfWidth(String(s ?? "")).toUpperCase()).join("\n");
  const re = /([1-9])\s*(SLDK|LDK|SDK|DK|SK|K|R)(?![A-Z])/g;
  const toks: Array<{ plan: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const plan = normalizeFloorPlanToken(m[0]);
    if (plan) toks.push({ plan, start: m.index, end: m.index + m[0].length });
  }
  const LIST_SEP_RE = /^\s*(?:OR|か|または|もしくは|、|・|\/|／|,|，|&|と)?\s*$/;
  for (const k of toks) {
    const after = text.slice(k.end, k.end + 8);
    if (/^\s*(?:は|が)?\s*(?:NG|不可|嫌|いや|避け|×|以外|なし|無し|ダメ|だめ|狭|せまい|に住|在住|から)/.test(after)) continue;
    if (!main.any && matchFloorPlan({ ...main, alt: undefined }, k.plan) === "match") continue;
    // 「も可」の言い方か、別の型と並べて書いてある時だけ（「今1Kに住んでいて」のような話は入れない）
    const marked = ALT_AFTER_RE.test(text.slice(k.end, k.end + 14)) || ALT_BEFORE_RE.test(text.slice(Math.max(0, k.start - 10), k.start));
    const listed = toks.some((o) => o !== k && ((o.end <= k.start && k.start - o.end <= 6 && LIST_SEP_RE.test(text.slice(o.end, k.start))) || (k.end <= o.start && o.start - k.end <= 6 && LIST_SEP_RE.test(text.slice(k.end, o.start)))));
    if (!marked && !listed) continue;
    if (!plans.includes(k.plan)) plans.push(k.plan);
  }
  if (!plans.length) return null;
  return { any: false, plans, minRank: null, maxRank: null, sqmMin: null, raw: plans.join("・") };
}

export type FloorPlanMatch = "match" | "near" | "mismatch" | "unknown";

/**
 * 拡張の「広げて検索」が足す間取りか（LDK の希望に同じ部屋数の DK。page-script.js・itandi-page-script.js・reins-page-script.js の is_wide と同じ）。
 *   本命に合う物は呼ぶ側で先に見る（ここは DK と LDK の組だけ）
 */
export function isWideFloorPlan(want: FloorPlanWant, plan: string | null | undefined): boolean {
  const p = normalizeFloorPlanToken(plan);
  if (!p || want.any || !/^[1-9]DK$/.test(p)) return false;
  return want.plans.includes(`${p[0]}LDK`);
}

/**
 * 2026-09-25 任務B: 2DK と 1LDK は同じ広さの級（実際の🌟で 2DK↔1LDK の入れ替えが 4人・5件。1人に偏らない）。
 *   本命・「も可」・広げた検索の型に合わない時だけ呼ぶ。2K↔1LDK は 12件が1人に集中していたので入れない（過学習を避ける）
 */
export function isSameClassPlan(want: FloorPlanWant, plan: string | null | undefined): boolean {
  const p = normalizeFloorPlanToken(plan);
  if (!p || want.any) return false;
  return (p === "2DK" && want.plans.includes("1LDK")) || (p === "1LDK" && want.plans.includes("2DK"));
}

/**
 * 2026-09-25 任務B: 希望より大きい間取り（1LDK→2LDK・2LDK→3LDK・1R→2DK）は実際の🌟で 5人・9件。不一致の保留ではなく「広い」の加点にする。
 *   部屋数が希望のどれより多い時だけ（同じ部屋数の型違いは matchFloorPlan の near）。上限を書いた希望（「1DK〜2K」）は上限の意味があるので当てない
 */
export function isLargerPlan(want: FloorPlanWant, plan: string | null | undefined): boolean {
  const p = normalizeFloorPlanToken(plan);
  if (!p || want.any || want.maxRank != null || want.plans.length === 0) return false;
  const rooms = parseInt(p[0], 10);
  return want.plans.every((w) => rooms > parseInt(w[0], 10));
}

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
  // バス・トイレ別は bathToiletWantOf（条件欄の読み取り parseEquipmentWants を正にする）で決める。この式は予備の節の読み取りだけに使う
  ["bath_toilet_separate", BATH_TOILET_WANT_RE],
  ["separate_washstand", /独立洗面/],
  ["storage", /収納|クローゼット|ウォークイン/],
  ["south_facing", /南向き/],
  // 2026-09-25 監査 E3: 「2階以上はエレベーター必須」は階の希望ではない（2階以上**なら**エレベーターが要る）→ detectImageWants で条件の節を先に消す
  //   （反証レビュー: 旧の否定先読み「2階以上(?!は…)」だと「2階以上は必須」「2階以上は希望」まで落としていた）
  ["floor_2_plus", /1階.{0,4}(NG|不可|嫌|以外|×)|2階以上|１階.{0,4}(NG|不可)/],
];

/** 「N階以上は／なら〜（別の設備）」の条件の節（conditionalFloorOf が数を返す節だけ）を消す。「2階以上は必須」は残す */
function stripConditionalFloorClauses(text: string): string {
  return text.replace(/(?:[0-9０-９]{1,2}|[一二三四五六七八九十]{1,2})階以上[^、。，,\n]*/g, (m) => (conditionalFloorOf(m) != null ? "" : m));
}

/**
 * バス・トイレ別の希望（画像で確かめるか・画像の × を必須の × にするか）。
 * 2026-09-25 本番の全お客様に当てた監査で、設備欄の読み取り（parseEquipmentWants）と画像の側の式が割れていた:
 *   ①「トイレ風呂別」「トイレとバスが別」「浴室トイレ別」（17人）を画像の側だけ読めない（設備欄は必須・画像は確かめない）
 *   ②「バストイレ別・出来れば築浅」を、画像の側は「・」で割らずに節ごと「できれば」と読み、設備欄は必須・画像は普通の希望
 *   → 条件欄の読み取り（parseEquipmentWants の bath_toilet）を正にする。そこで読まない所（additional_conditions の「希望:」以外＝
 *     フォームの回答の貼り付け）だけ、同じ式・同じ区切り（「バス・トイレ」の「・」は割らない）で節を見る
 */
function bathToiletWantOf(c: CustomerLike): { want: boolean; must: boolean } {
  const w = parseEquipmentWants({ preferences: c.preferences, ng_points: c.ng_points, other_requests: c.other_requests, additional_conditions: c.additional_conditions })
    .wants.find((x) => x.key === "bath_toilet");
  if (w) return w.mode === "must" ? { want: true, must: w.strong } : { want: false, must: false };
  const text = [c.preferences, c.other_requests, c.additional_conditions].map((s) => String(s ?? "")).join("\n").normalize("NFKC")
    .replace(/(バス|風呂|浴室|トイレ)[・･‧](トイレ|バス|風呂|浴室)/g, "$1$2");
  const cls = text.split(/[、。,，\n／/・]/).filter((cl) => BATH_TOILET_WANT_RE.test(cl) && !BATH_TOILET_NOT_REQUIRED_RE.test(cl));
  return { want: cls.length > 0, must: cls.some((cl) => !WANT_SOFT_RE.test(cl)) };
}

/**
 * 画像の × を必須の × として扱う希望。2026-09-25 竹内「バストイレ別希望していたら、一緒の場合はかなり減点・他に物件があれば入れないレベル（NG）」:
 *   バス・トイレ別は「必須」と書いていなくても必須。「できれば」「あれば」等と書いた節だけ普通の希望（bathToiletWantOf＝設備欄と同じ読み取り）
 */
export function detectImageMust(c: CustomerLike): ImageWantKey[] {
  return bathToiletWantOf(c).must ? ["bath_toilet_separate"] : [];
}

/** 画像（間取り図）でしか分からない希望を拾う */
export function detectImageWants(c: CustomerLike): ImageWantKey[] {
  const text = stripConditionalFloorClauses([c.preferences, c.other_requests, c.ng_points, c.additional_conditions].map((s) => String(s ?? "")).join("\n"));
  const out: ImageWantKey[] = [];
  for (const [key, re] of IMAGE_WANT_RES) {
    if (key === "bath_toilet_separate") { if (bathToiletWantOf(c).want) out.push(key); continue; }
    if (re.test(text)) out.push(key);
  }
  return out;
}

/**
 * 入居の条件（楽器・法人・外国籍…）の希望を条件欄から拾う。NG 欄（ng_points）は見ない（「子供の声NG」は子供の入居ではない）。
 * 否定（「楽器は使わない」「法人契約ではない」）は外す。語が無ければ照らさない（書いていない条件で物件を疑わない）
 */
const CONDITION_WANT_RES: Record<ConditionKey, RegExp> = {
  instrument: /楽器|ピアノ|ギター|ドラム|バイオリン|DTM/i,
  corporate: /法人(?:契約|名義)?|社宅/,
  foreigner: /外国(?:籍|人)|留学生/,
  student: /学生/,
  office: /事務所|SOHO/i,
  singleOnly: /単身/,
  twoPerson: /二人入居|2人入居|同棲|カップル|夫婦|二人暮らし|2人暮らし/,
  roomShare: /ルームシェア/,
  children: /子供|子ども|こども|お子様|お子さん|赤ちゃん|乳児|幼児/,
};
const CONDITION_WANT_NEG_RE = /(?:楽器|ピアノ|ギター|法人(?:契約)?|子供|子ども)(?:は|の)?(?:なし|無し|不要|いない|いません|使わない|弾かない|しない|ではない|じゃない)/g;

export function detectConditionWants(c: CustomerLike): ConditionKey[] {
  const text = toHalfWidth([c.preferences, c.other_requests, c.additional_conditions].map((s) => String(s ?? "")).join("\n")).replace(CONDITION_WANT_NEG_RE, "");
  return CONDITION_KEYS.filter((k) => CONDITION_WANT_RES[k].test(text));
}

/** 条件欄（NG 欄も含む）に「更新料」「定期借家・契約期間」「フリーレント」の語があるか */
export function detectTermMentions(c: CustomerLike): { renewal: boolean; contract: boolean; freeRent: boolean } {
  const text = [c.preferences, c.other_requests, c.additional_conditions, c.ng_points].map((s) => String(s ?? "")).join("\n");
  return { renewal: /更新料/.test(text), contract: /定期借家|定借|契約期間|短期/.test(text), freeRent: /フリーレント/.test(text) };
}

/**
 * 広さの列が空の人の自由文・フォームの「25平米以上」「40㎡」「広さ: 35㎡以上」→ ㎡の下限。
 *   「以下」「まで」は下限ではないので読まない。条件の記録（additional_conditions）は最後の「広さ:」だけ
 */
export function sqmFromText(c: CustomerLike): number | null {
  const add = String(c.additional_conditions ?? "").split("\n");
  const lastIdx = add.map((l, i) => (/広さ\s*[:：]/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  const addText = add.map((l, i) => (i !== lastIdx ? l.replace(/広さ\s*[:：][^/\n]*/g, "") : l)).join("\n");
  const text = toHalfWidth([c.preferences, c.other_requests, addText, formPlanLines(c.raw_format_text)].map((s) => String(s ?? "")).join("\n"));
  for (const m of text.matchAll(/(\d{2,3}(?:\.\d)?)\s*(?:平米|㎡|m2|M2|平方メートル)\s*(以上|〜|~|から|程度|くらい|ぐらい|前後|以下|まで|未満)?/g)) {
    if (/以下|まで|未満/.test(m[2] ?? "")) continue;
    const v = parseFloat(m[1]);
    if (v >= 15 && v <= 150) return v;
  }
  return null;
}

/**
 * 築年の列が空の人の「新築」「築浅」「新しめ」「築15年以内」（自由文）→ 年数の目安。情報の札だけに使う（線は実送信で確かめていないので点を大きくしない）。
 *   否定（「新築じゃなくても」「古くても」「築浅にこだわらない」）は読まない
 */
export function detectAgeText(c: CustomerLike): { years: number; word: string } | null {
  const text = toHalfWidth([c.preferences, c.other_requests, c.additional_conditions].map((s) => String(s ?? "")).join("\n"));
  if (/(?:新築|築浅)(?:じゃ|で)?(?:なくても|は?こだわらない|でなくても)|古くても|築年数?(?:は)?(?:気にしない|こだわらない|問わない)/.test(text)) return null;
  const n = text.match(/築\s*(\d{1,2})\s*年\s*(?:以内|まで|未満|以下)/);
  if (n) { const y = parseInt(n[1], 10); if (y > 0 && y <= 60) return { years: y, word: n[0] }; }
  if (/新築/.test(text)) return { years: 3, word: "新築" };
  if (/築浅/.test(text)) return { years: 10, word: "築浅" };
  const w = text.match(/新しめ|新しい物件|比較的新しい|新しい(?:お部屋|部屋|建物|マンション)/);
  if (w) return { years: 15, word: w[0] };
  return null;
}

// ─── 2026-09-25 案B お客様が書いた条件（強さ）と重み ─────────────────────────────

const WANT_STRONG_RE = /必須|絶対|マスト/;
const WANT_SOFT_RE = /できれば|出来れば|あれば|理想|なお可|だと嬉しい|だとうれしい|優先度(?:は)?低|こだわらない/;
/**
 * 駅近の自由文（「駅近」「駅チカ」「駅から近い」「徒歩N分以内」）。
 * 2026-09-25 全お客様 303人の条件欄で確かめた: 「姫路駅近」は駅の名前＋近く（場所の希望）で、駅近の希望ではない
 *   → 「駅近」の直前が漢字・カタカナ（駅の名前）の時は読まない（「できるだけ駅近」「希望: 駅近」は読む）
 */
export const WALK_TEXT_RE = /(?<![一-龥ァ-ヶ])(?:駅近|駅チカ|駅ちか)|駅から近|駅まで近|駅(?:から|まで)?徒歩\s*\d{1,2}\s*分以内|徒歩\s*\d{1,2}\s*分以内/;
/**
 * 家賃を低くしたい（「家賃は低い方が良い」「賃料を抑えたい」）。
 * 2026-09-25 全お客様 303人の文で確かめた（audit-fit-balance）: 「初期費用はできるだけ安い方が良い」（初期費用の話）・「家賃の値下げ交渉」・
 *   「場所を変えると家賃や初期費用〜」（相談）は家賃の安さの希望ではない → 同じ節に「初期・交渉・相談」がある時は読まない。家賃の語が無い「安い方が良い」も読まない
 */
export const RENT_CHEAP_RE = /(?:家賃|賃料|月々|毎月)[^、。,\n]{0,12}(?:低い|低め|安い|安め|安く|抑え|おさえ|下げ)/;
const RENT_CHEAP_NEG_RE = /交渉|相談|高くても|こだわらない|気にしない/;
/**
 * 家賃の安さの節か。「初期」は家賃の語と安さの語の**間**にある時だけ除く（「家賃や初期費用が安くなる物件」＝両方の話）。
 * 2026-09-25 全お客様の条件欄で確かめた: 「初期費用・家賃はできるだけ安いほうが良い」（家賃も安くしたい）を旧は節の中の「初期」で落としていた
 */
export function isRentCheapClause(cl: string): boolean {
  const m = cl.match(RENT_CHEAP_RE);
  return !!m && !/初期/.test(m[0]) && !RENT_CHEAP_NEG_RE.test(cl);
}
function wantClauseOf(text: string, re: RegExp): string | null {
  for (const cl of text.split(/[、。,，\n／/・]/)) if (re.test(cl)) return cl;
  return null;
}
const strengthOfClause = (cl: string | null): WantStrength => (!cl ? "normal" : WANT_STRONG_RE.test(cl) ? "strong" : WANT_SOFT_RE.test(cl) ? "soft" : "normal");

/** お客様が書いた条件（強さ）を読む。材料は buildCustomerProfile と同じ条件欄（自由文は preferences・other_requests・additional_conditions） */
export function readWrittenWants(c: CustomerLike, p: { rentMax: number | null; walkMax: number | null; buildingAgeMax: number | null; ageTextMax?: { years: number; word: string } | null }): WrittenWants {
  const t = [c.preferences, c.other_requests, c.additional_conditions].filter(Boolean).map((s) => String(s).normalize("NFKC")).join("\n");
  const ageCl = wantClauseOf(t, /新築|築浅|新しめ|新しい|築\s*\d{1,2}\s*年/);
  const walkCl = wantClauseOf(t, WALK_TEXT_RE);
  const walkN = walkCl?.match(/徒歩\s*(\d{1,2})\s*分/);
  const cheapCl = t.split(/[、。,，\n／/]/).find(isRentCheapClause) ?? null;
  return {
    ageText: p.buildingAgeMax == null && p.ageTextMax ? { strength: strengthOfClause(ageCl) } : null,
    ageColumn: p.buildingAgeMax != null,
    walkText: walkCl ? { max: p.walkMax ?? (walkN ? parseInt(walkN[1], 10) : 10), strength: strengthOfClause(walkCl) } : null,
    walkColumn: p.walkMax != null,
    rentCheap: cheapCl && p.rentMax != null ? { strength: strengthOfClause(cheapCl) } : null,
  };
}

const strengthSuffix = (s: WantStrength) => (s === "strong" ? "_MUST" : s === "soft" ? "_SOFT" : "");

/** 案B の重みを決める物件の値（judgeProperty の facts から・例のテストは直接） */
export type WeightFacts = { buildingAge: number | null; walkMinutes: number | null; /** 家賃（管理費込み）÷ 上限 */ rentRatio: number | null; /** AD の月数（円は家賃で月数に直した物） */ adMonths: number | null };

/**
 * 2026-09-25 案B: 書いた条件の重み・AD 1ヶ月未満の札（純関数）。codes は judgeProperty が付けた札（保留の _HELD 前でも後でもよい）。
 *   返すのは足す札だけ（scripts/audit-fit-balance.ts の scorePlan と同じ決まり）:
 *   - 築年: 自由文の築浅を書いた人は段（AGE_W5/10/15/_OLD・強さ）。築年の列の人は希望内の時だけ上乗せ（AGE_COL_W5/10）。書いていない人は軽く（AGE_N5/10）
 *   - 徒歩: 駅近を書いた人は 5分以内・7分以内の上乗せ（強さ）。徒歩の列が無ければ ○×（WALK_TEXT_OK/OVER/FAR）もここで。書いていない人は 5分以内 +2
 *   - 家賃を低くしたい人: 上限の 0.8／0.9／0.95 以下（強さ）
 *   - AD 1ヶ月未満（0 より大きく 1 未満・段の札も「なし」も無い・利益が出ない保留でない時）
 */
export function writtenWeightCodes(codes: readonly string[], f: WeightFacts, w: WrittenWants | null | undefined): string[] {
  const out: string[] = [];
  const W: WrittenWants = w ?? { ageText: null, ageColumn: false, walkText: null, walkColumn: false, rentCheap: null };
  const a = f.buildingAge;
  if (a != null) {
    const tier = a <= 5 ? 0 : a <= 10 ? 1 : a <= 15 ? 2 : 3;
    if (W.ageText) out.push(tier === 3 ? "AGE_W_OLD" : `${["AGE_W5", "AGE_W10", "AGE_W15"][tier]}${strengthSuffix(W.ageText.strength)}`);
    else if (W.ageColumn) { if (codes.includes("BUILDING_AGE_OK") && tier <= 1) out.push(tier === 0 ? "AGE_COL_W5" : "AGE_COL_W10"); }
    else if (a <= 5) out.push("AGE_N5");
    else if (a <= 10) out.push("AGE_N10");
  }
  const wk = f.walkMinutes;
  if (W.walkText && wk != null) {
    const sfx = strengthSuffix(W.walkText.strength);
    if (wk <= 5) out.push(`WALK_NEAR_W5${sfx}`);
    else if (wk <= 7) out.push(`WALK_NEAR_W7${sfx}`);
    // 徒歩の列の札（WALK_OK 等）が無い人（列が空・自由文だけ）は ○× もここで（保留にしない）
    if (!codes.some((c) => /^WALK_(?:OK|SLIGHTLY_OVER|OVER)$/.test(c))) out.push(wk <= W.walkText.max ? "WALK_TEXT_OK" : wk <= 15 ? "WALK_TEXT_OVER" : "WALK_TEXT_FAR");
  } else if (!W.walkText && !W.walkColumn && wk != null && wk <= 5) out.push("WALK_NEAR_N");
  const r = f.rentRatio;
  if (W.rentCheap && r != null && r <= 1) {
    const base = r <= 0.8 ? "RENT_CHEAP_W80" : r <= 0.9 ? "RENT_CHEAP_W90" : r <= 0.95 ? "RENT_CHEAP_W95" : null;
    if (base) out.push(`${base}${strengthSuffix(W.rentCheap.strength)}`);
  }
  const am = f.adMonths;
  const hasTier = codes.some((c) => /^(?:AD_1M|AD_1_5M|AD_HIGH|AD_2_5M|AD_VERY_HIGH)(?:_HELD)?$/.test(c) || c === "AD_UNKNOWN" || c === "AD_NONE");
  if (am != null && am > 0 && am + 0.01 < 1 && !hasTier && !codes.includes("PROFIT_NEGATIVE")) out.push("AD_UNDER_1M");
  return out;
}

/** 書いた条件の種類と、その札の合い方（ok＝合う／wide＝広げた検索の幅の中／soft_ng・ng＝外れ／unread＝読めない・要確認）。条件の札でなければ null */
export type FitVerdict = "ok" | "wide" | "soft_ng" | "ng" | "unread";
const FIT_TABLE: Record<string, [string, FitVerdict]> = {
  RENT_OK: ["家賃", "ok"], RENT_WIDE: ["家賃", "wide"], RENT_SLIGHTLY_OVER: ["家賃", "soft_ng"], RENT_OVER_110: ["家賃", "ng"], RENT_OVER_130: ["家賃", "ng"], RENT_UNKNOWN: ["家賃", "unread"],
  ZERO_ZERO_MATCH: ["初期費用（敷礼0）", "ok"], INITIAL_COST_NOT_ZERO: ["初期費用（敷礼0）", "ng"], INITIAL_COST_OVER_LIMIT: ["初期費用の上限", "ng"],
  FLOOR_PLAN_MATCH: ["間取り", "ok"], FLOOR_PLAN_ALT_MATCH: ["間取り", "ok"], FLOOR_PLAN_WIDE: ["間取り", "wide"], FLOOR_PLAN_NEAR: ["間取り", "wide"],
  FLOOR_PLAN_SAME_CLASS: ["間取り", "wide"], FLOOR_PLAN_LARGER: ["間取り", "wide"], FLOOR_PLAN_MISMATCH: ["間取り", "ng"],
  SQM_OK: ["広さ", "ok"], SQM_SLIGHTLY_UNDER: ["広さ", "wide"], SQM_WIDE: ["広さ", "wide"], SQM_UNDER: ["広さ", "ng"], SQM_UNKNOWN: ["広さ", "unread"],
  WALK_OK: ["徒歩", "ok"], WALK_SLIGHTLY_OVER: ["徒歩", "soft_ng"], WALK_OVER: ["徒歩", "ng"],
  WALK_TEXT_OK: ["徒歩", "ok"], WALK_TEXT_OVER: ["徒歩", "soft_ng"], WALK_TEXT_FAR: ["徒歩", "soft_ng"],
  BUILDING_AGE_OK: ["築年", "ok"], BUILDING_AGE_WIDE: ["築年", "wide"], BUILDING_AGE_SLIGHTLY_OVER: ["築年", "soft_ng"], BUILDING_AGE_OVER: ["築年", "ng"],
  BUILDING_AGE_TEXT_OK: ["築年", "ok"], BUILDING_AGE_TEXT_OVER: ["築年", "soft_ng"],
  AREA_STATION_MATCH: ["エリア", "ok"], AREA_WARD_MATCH: ["エリア", "ok"], AREA_LINE_MATCH: ["エリア", "ok"], AREA_REGION_MATCH: ["エリア", "ok"],
  AREA_STATION_WIDE: ["エリア", "wide"], AREA_WARD_WIDE: ["エリア", "wide"], AREA_STATION_2STOPS: ["エリア", "wide"], AREA_NEAR: ["エリア", "wide"], AREA_CLOSE: ["エリア", "wide"],
  AREA_FAR: ["エリア", "soft_ng"], AREA_DIRECTION_NG: ["エリア", "soft_ng"], AREA_EXCLUDED: ["エリア", "ng"], AREA_UNKNOWN: ["エリア", "unread"],
  COMMUTE_OK: ["通勤", "ok"], COMMUTE_SLIGHTLY_OVER: ["通勤", "wide"], COMMUTE_OVER: ["通勤", "soft_ng"], COMMUTE_UNKNOWN: ["通勤", "unread"],
  MOVE_IN_OK: ["入居時期", "ok"], MOVE_IN_LATE: ["入居時期", "ng"], MOVE_IN_UNKNOWN: ["入居時期", "unread"],
  PET_NG: ["ペット", "ng"],
};
export function fitVerdictOf(code: string): { fam: string; v: FitVerdict } | null {
  const c = code.endsWith(AD_HELD_SUFFIX) ? code.slice(0, -AD_HELD_SUFFIX.length) : code;
  const t = FIT_TABLE[c];
  if (t) return { fam: t[0], v: t[1] };
  let m = c.match(/^EQUIP_(.+?)(?:_MUST|_SOFT)?_(OK_MAX|OK|NG|NEAR|ASK|UNLISTED)$/);
  if (m && c !== EQUIP_CAP_CODE) return { fam: `設備:${m[1]}`, v: m[2] === "OK" || m[2] === "OK_MAX" ? "ok" : m[2] === "NG" ? "ng" : m[2] === "NEAR" ? "wide" : "unread" };
  m = c.match(/^CONDITION_(.+?)_(OK|NG|ASK|UNLISTED)$/);
  if (m) return { fam: `入居の条件:${m[1]}`, v: m[2] === "OK" ? "ok" : m[2] === "NG" ? "ng" : "unread" };
  m = c.match(/^IMAGE_(.+?)_(OK|NG)$/);
  if (m) return { fam: `画像:${m[1]}`, v: m[2] === "OK" ? "ok" : "ng" };
  return null;
}

export const FIT_CODES = ["FIT_ALL", "FIT_ALL_HALF", "FIT_ONE_MISS", "FIT_ONE_MISS_HALF"] as const;
/** 全部合う・1つだけ外れの数え方（画面の「全部合う」の行もこれ） */
export type FitSummary = { n: number; miss: number; held: boolean; code: (typeof FIT_CODES)[number] | null; families: Array<{ fam: string; v: FitVerdict }> };
/**
 * 書いた条件の合い方を数える（純関数）。種類ごとに一番良い合い方を採る（同じ種類に ○ と × があれば ○）。
 *   読めない・要確認は数えない／幅の内側は外れに数えない／条件3つ以上で満額・2つなら半分・1つ以下は付けない／保留・外す候補の物件には付けない
 */
export function summarizeFit(codes: readonly string[]): FitSummary {
  const rank: Record<FitVerdict, number> = { ok: 4, wide: 3, soft_ng: 2, ng: 1, unread: 0 };
  const fam = new Map<string, FitVerdict>();
  for (const code of codes) {
    const f = fitVerdictOf(code);
    if (!f) continue;
    const prev = fam.get(f.fam);
    if (!prev || rank[f.v] > rank[prev]) fam.set(f.fam, f.v);
  }
  const families = [...fam.entries()].map(([k, v]) => ({ fam: k, v }));
  const judged = families.filter((x) => x.v !== "unread");
  const n = judged.length;
  const miss = judged.filter((x) => x.v === "soft_ng" || x.v === "ng").length;
  const held = codes.some((c) => DROP_REASON_CODES.has(c) || isHoldCode(c));
  let code: FitSummary["code"] = null;
  if (!held && n >= 2) {
    const half = n === 2;
    if (miss === 0) code = half ? "FIT_ALL_HALF" : "FIT_ALL";
    else if (miss === 1) code = half ? "FIT_ONE_MISS_HALF" : "FIT_ONE_MISS";
  }
  return { n, miss, held, code, families };
}
/** 全部合うの札を付け直す（前の FIT_* を外して、今の札で数え直す）。judgeProperty・applyImageFacts・applyEquipmentMatch の3か所で通す */
export function settleFitBonus(codes: readonly string[]): string[] {
  const base = codes.filter((c) => !(FIT_CODES as readonly string[]).includes(c));
  const s = summarizeFit(base);
  return s.code ? [...base, s.code] : base;
}

/** 札から点（50＋合計・0〜SCORE_MAX・必須の × は上限20）。judgeProperty・applyImageFacts・applyEquipmentMatch と同じ */
export function scoreFromCodes(codes: readonly string[]): number {
  const s = Math.max(0, Math.min(SCORE_MAX, BASE_SCORE + codes.reduce((a, c) => a + reasonPoints(c), 0)));
  return codes.includes(EQUIP_CAP_CODE) ? Math.min(s, EQUIP_STRONG_NG_CAP) : s;
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
  opts: { today?: Date | string } = {},
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
  const sentRooms = new Map<string, Set<string>>();
  const ratios: number[] = [];
  for (const r of sentRows) {
    // 2026-09-25: 建物名に号室が付いた送付（「X 201号室」）も建物で持つ（号室は room_no・無ければ名前の末尾から）
    const split = splitBuildingRoom(r.property_name);
    const n = normalizeBuildingName(split.building);
    // 2026-09-24: 一般名（「物件」＝拡張が itandi で名前を取れなかった送付）は建物が分からないので送付済みに入れない
    //   （入れると今回の「物件」全件が ALREADY_SENT −30 で外す候補 20 点に横並びになった・HONOKA さんの回 id 50〜67）
    //   グループに共有しただけの行（delivery='shared'）も入れない（お客様には届いていない・同じ回の共有で自分自身が送付済みになる）
    if (n && !isGenericBuildingName(r.property_name) && isCustomerDelivery(r)) {
      // sentBuildings は今まで通り名前そのまま（号室付きの名前は号室付きのまま）＝外す候補の当たり方は増やさない。号室の照合は sentRooms で
      sentBuildings.add(normalizeBuildingName(r.property_name));
      const room = normalizeRoomKey(r.room_no) || split.room;
      if (!sentRooms.has(n)) sentRooms.set(n, new Set());
      sentRooms.get(n)!.add(room);
    }
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
  const floorPlanWant = normalizeFloorPlanWant(customer.floor_plan ?? customer.layout);
  // フォームの「希望」の行に並べた型は本命に足す（列の型が全部入っている時だけ）
  const fromForm = formWantPlans(customer, floorPlanWant);
  if (fromForm.length) floorPlanWant.plans = [...floorPlanWant.plans, ...fromForm];
  const areaMin = num(customer.floor_area_min);
  const sqmMin = areaMin != null && areaMin >= 10 && areaMin <= 200 ? areaMin : (floorPlanWant.sqmMin ?? sqmFromText(customer));
  const walkMaxUse = walkMax != null && walkMax > 0 ? walkMax : null;
  const ageMaxUse = buildingAgeMax != null && buildingAgeMax > 0 ? buildingAgeMax : null;
  const ageTextMax = ageMaxUse != null ? null : detectAgeText(customer);

  return {
    rentMax, notes,
    written: readWrittenWants(customer, { rentMax, walkMax: walkMaxUse, buildingAgeMax: ageMaxUse, ageTextMax }),
    // 下限は上限より小さい時だけ。上限が入力誤り（上限＜下限・3万未満）の人は下限も信じない
    rentMin: rentMin != null && rentMin >= 10_000 && !notes.includes("RENT_MAX_UNRELIABLE") && (rentMax == null || rentMin < rentMax) ? rentMin : null,
    floorPlanAlt: parseFloorPlanAlt(customer, floorPlanWant),
    sqmMin: sqmMin ?? null,
    ageTextMax,
    floorPlanWant,
    walkMax: walkMaxUse,
    buildingAgeMax: ageMaxUse,
    initialCostLimit: lim != null && lim > 0 ? lim : null,
    wantsLowInitialCost, lowInitialCostSource,
    pet: customer.pet === true,
    imageWants: detectImageWants(customer),
    imageMust: detectImageMust(customer),
    history: { sentCount: sentRows.length, sentBuildings, sentRooms, rentRatioMedian: median(ratios), rentRatioN: ratios.length, sellingPointsSelected },
    discountYen: discountYen != null && discountYen > 0 ? discountYen : DEFAULT_DISCOUNT_YEN,
    confidence,
    moveInWant: parseMoveInWant(customer.move_in_time, { registeredAt: customer.created_at ?? null, today: opts.today }),
    conditionWants: detectConditionWants(customer),
    mentions: detectTermMentions(customer),
  };
}

/**
 * 資料の表から読んだ募集の条件（listing-terms.ts）で、説明文・拡張の値が無い所だけ埋める（敷金・礼金・築年）。
 * 埋めた項目名を返す（画面の「資料から」の印・監査用）。facts を書き換える
 */
export function fillFactsFromTerms(facts: PropertyFacts, t: ListingTerms | null | undefined): string[] {
  if (!t || !t.hasText) return [];
  const filled: string[] = [];
  if (facts.depositMonths == null && t.depositMonths != null) { facts.depositMonths = t.depositMonths; filled.push("deposit"); }
  if (facts.keyMoneyMonths == null && t.keyMoneyMonths != null) { facts.keyMoneyMonths = t.keyMoneyMonths; filled.push("keyMoney"); }
  if (facts.buildingAge == null && t.buildingAgeYears != null) { facts.buildingAge = t.buildingAgeYears; filled.push("buildingAge"); }
  return filled;
}

export type TermsMatch = {
  /** 入居時期の照合（希望が by・asap の時だけ。それ以外は null） */
  moveIn: "ok" | "late" | "unknown" | null;
  /** 入居の条件（条件欄にある物だけ・二人入居は設備の照合で決まっていれば入れない） */
  conditions: Array<{ key: ConditionKey; status: "ok" | "ng" | "consult" | "unlisted" }>;
};

/** 募集の条件とお客様の希望の照合（judgeProperty の札と画面の ○× の元・同じ関数） */
export function matchListingTerms(t: ListingTerms, profile: CustomerProfile, opts: { today?: Date | string; equipment?: EquipmentMatch | null } = {}): TermsMatch {
  const w = profile.moveInWant;
  const moveIn = w && (w.kind === "by" || w.kind === "asap") && w.wantBy ? compareMoveIn(t.moveIn, w.wantBy, { today: opts.today }) : null;
  // 二人入居は設備の照合（listing-equipment の two_person）と重ねない: 設備側で ○/× が決まっていれば terms は付けない。
  //   設備側が「記載なし」で terms も記載なしなら、設備側の「要確認」1つだけにする（terms で決まった時は judgeProperty が設備側の要確認を外す）
  const eqTwo = (opts.equipment?.rows ?? []).find((r) => r.want.key === "two_person");
  const conditions = (profile.conditionWants ?? [])
    .filter((k) => !(k === "twoPerson" && eqTwo && (eqTwo.result !== "unlisted" || t.conditions.twoPerson.status === "unlisted")))
    .map((k) => ({ key: k, status: t.conditions[k].status }));
  return { moveIn, conditions };
}

/** 募集の条件の札（judgeProperty が足す物・点は reasonPoints） */
export function termsReasonCodes(t: ListingTerms | null | undefined, profile: CustomerProfile, opts: { today?: Date | string; equipment?: EquipmentMatch | null } = {}): string[] {
  if (!t || !t.hasText) return [];
  const out: string[] = [];
  const m = matchListingTerms(t, profile, opts);
  if (m.moveIn === "ok") out.push("MOVE_IN_OK");
  else if (m.moveIn === "late") out.push("MOVE_IN_LATE");
  else if (m.moveIn === "unknown") out.push("MOVE_IN_UNKNOWN");
  const men = profile.mentions ?? { renewal: false, contract: false, freeRent: false };
  if (t.contract.kind === "fixed") out.push("CONTRACT_FIXED");
  else if (men.contract) out.push(t.contract.kind === "normal" ? "CONTRACT_NORMAL" : "CONTRACT_UNKNOWN");
  if (men.renewal) {
    const k = t.renewalFee.kind;
    out.push(k === "none" ? "RENEWAL_FEE_NONE" : k === "months" || k === "yen" ? "RENEWAL_FEE_SET" : "RENEWAL_FEE_UNKNOWN");
  }
  if (t.freeRent) out.push(profile.wantsLowInitialCost ? "FREE_RENT_MATCH" : "FREE_RENT");
  else if (men.freeRent) out.push("FREE_RENT_UNLISTED");
  for (const c of m.conditions) {
    const K = CONDITION_CODE_KEYS[c.key];
    out.push(`CONDITION_${K}_${c.status === "ok" ? "OK" : c.status === "ng" ? "NG" : c.status === "consult" ? "ASK" : "UNLISTED"}`);
  }
  return out;
}

// ─── 判定 ────────────────────────────────────────────────────────────────────

/** AD を円にする（表が円ならそれ・ヶ月なら 家賃×ヶ月。管理費は含めない） */
export function computeAdYen(f: PropertyFacts): number | null {
  if (f.adYen != null) return f.adYen;
  if (f.adMonths != null && f.rentYen != null) return Math.round(f.adMonths * f.rentYen);
  return null;
}

/** 画像（間取り図）で確かめる希望 → 資料の設備欄のキー（設備欄で決まった物は画像で二重に数えない） */
const IMAGE_TO_EQUIP: Partial<Record<ImageWantKey, EquipKey>> = {
  bath_toilet_separate: "bath_toilet", separate_washstand: "washbasin", south_facing: "south", floor_2_plus: "floor2",
};

export type JudgeOptions = {
  /** 資料の設備欄との照合（listing-equipment.ts の matchEquipment。拡張の判定は説明文から読めた分だけ） */
  equipment?: EquipmentMatch | null;
  /**
   * 資料の表から読んだ募集の条件（listing-terms.ts の parseListingTerms）。2026-09-25 売上サポ（recordPickupBatch）だけが渡す。
   *   入居時期（MOVE_IN_*）・定期借家（CONTRACT_*）・更新料（RENEWAL_FEE_*）・フリーレント（FREE_RENT_*）・入居の条件（CONDITION_*）。
   *   敷礼・築年は呼ぶ側で fillFactsFromTerms により facts を埋める（既存の INITIAL_COST_*・BUILDING_AGE_* の線のまま）
   */
  terms?: ListingTerms | null;
  /** 入居時期の照合の基準日（既定は今） */
  today?: Date | string;
  /** 2026-09-25 エリア・通勤の札（area-want.ts の locationReasonCodes。売上サポの recordPickupBatch だけが渡す） */
  locationCodes?: string[] | null;
};

/** 「送ってきた家賃帯より高め」を見るのに要る送付の件数（1〜2件の中央値は1件の家賃そのもの） */
export const RENT_USUAL_MIN_SENT = 3;

/** 家賃の下限の線（下限の 85% 未満で情報の札） */
export const RENT_MIN_RATIO = 0.85;

export function judgeProperty(facts: PropertyFacts, profile: CustomerProfile, index = 0, opts: JudgeOptions = {}): Judgment {
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
    // 広げた検索の幅: 管理費込みで 上限＋幅 以内、または家賃だけなら 上限＋幅 以内（＝拡張の広げた検索が拾う物・サイトの賃料の欄は管理費を含まない）で管理費込み1割以内。
    //   反証レビュー 2026-09-25: 旧は2つ目を「家賃だけ上限内」にしていたので、83,000円＋管理費3,000円（計86,000・広げた検索で拾う）が 0点、
    //   78,000円＋管理費9,000円（計87,000・高い方）が +10 と、安い方が低くなっていた
    const wideCap = profile.rentMax + wideRentBuffer(profile.rentMax);
    const inWide = total <= wideCap || (facts.rentYen <= wideCap && ratio <= RENT_RATIO_HOLD);
    // 超過額（管理費込み）。比の線に加えて金額の線（上限＋1万円までは保留にしない・＋2万円までは外す候補にしない）
    const overYen = total - profile.rentMax;
    if (ratio <= 1.0) add("RENT_OK", 15);
    else if (inWide) add("RENT_WIDE", reasonPoints("RENT_WIDE"));
    else if (ratio <= RENT_RATIO_HOLD || overYen <= RENT_OVER_SOFT_YEN) add("RENT_SLIGHTLY_OVER", 0);
    else if (ratio <= RENT_RATIO_DROP || overYen <= RENT_OVER_DROP_MIN_YEN) add("RENT_OVER_110", -20, "hold");
    else add("RENT_OVER_130", -35, "drop");
    const med = profile.history.rentRatioMedian;
    // 2026-09-25 YUMA テスト（お客様B）: 送付1件（58,000円）の中央値で、上限内（7万円）の物件がほぼ全部 −5 になっていた → 3件以上の時だけ
    if (med != null && (profile.history.rentRatioN ?? RENT_USUAL_MIN_SENT) >= RENT_USUAL_MIN_SENT && ratio > med + 0.15) add("RENT_ABOVE_USUAL", -5);
  }
  // 家賃の下限（2026-09-25 竹内「家賃の下限入れる」）: 下限の 85% 未満の時だけ情報の札（−3・保留にしない。安い物件を外す理由にはしない）
  if (profile.rentMin != null && facts.rentYen != null) {
    const total = facts.rentYen + (facts.adminFeeYen ?? 0);
    if (total < profile.rentMin * RENT_MIN_RATIO) add("RENT_BELOW_MIN", reasonPoints("RENT_BELOW_MIN"));
  }

  // 敷金・礼金
  const dep = facts.depositMonths, key = facts.keyMoneyMonths;
  if (dep == null || key == null) {
    add("INITIAL_COST_UNKNOWN", 0); missing.push("deposit_key_money");
  } else if (dep === 0 && key === 0) {
    // 2026-09-25 案B: 書いた人 +20／送った物件から推した人 +14（ZERO_ZERO_INFERRED・全部合うの数に入れない）／書いていない人 +8
    const zz = !profile.wantsLowInitialCost ? "ZERO_ZERO" : profile.lowInitialCostSource === "history" ? "ZERO_ZERO_INFERRED" : "ZERO_ZERO_MATCH";
    add(zz, reasonPoints(zz));
  } else if (profile.wantsLowInitialCost) {
    add("INITIAL_COST_NOT_ZERO", -15, "hold");
  }
  if (profile.initialCostLimit != null && facts.rentYen != null && dep != null && key != null) {
    const initial = (dep + key) * facts.rentYen;
    if (initial > profile.initialCostLimit * 1.2) add("INITIAL_COST_OVER_LIMIT", -10, "hold");
  }

  // 間取り
  const fpm = matchFloorPlan(profile.floorPlanWant, facts.floorPlan);
  // 「1DKも可」の型（本命より少し低い +8）。本命に合う時・型が読めない時は見ない
  const fpAlt = fpm !== "match" && !!profile.floorPlanAlt && facts.floorPlan != null && matchFloorPlan(profile.floorPlanAlt, facts.floorPlan) === "match";
  if (fpm === "match") add("FLOOR_PLAN_MATCH", 15);
  else if (fpAlt) add("FLOOR_PLAN_ALT_MATCH", reasonPoints("FLOOR_PLAN_ALT_MATCH"));
  else if (isWideFloorPlan(profile.floorPlanWant, facts.floorPlan)) add("FLOOR_PLAN_WIDE", reasonPoints("FLOOR_PLAN_WIDE"));
  else if (fpm === "near") add("FLOOR_PLAN_NEAR", 5);
  else if (isSameClassPlan(profile.floorPlanWant, facts.floorPlan)) add("FLOOR_PLAN_SAME_CLASS", reasonPoints("FLOOR_PLAN_SAME_CLASS"));
  else if (isLargerPlan(profile.floorPlanWant, facts.floorPlan)) add("FLOOR_PLAN_LARGER", reasonPoints("FLOOR_PLAN_LARGER"));
  else if (fpm === "mismatch") add("FLOOR_PLAN_MISMATCH", -15, "hold");
  else if (facts.floorPlan == null) missing.push("floor_plan");

  // 広さ（希望の㎡以上）: 9割未満は保留・9割以上は 0点・読めない時は 0点の要確認
  if (profile.sqmMin != null) {
    const a = facts.areaSqm ?? null;
    if (a == null) add("SQM_UNKNOWN", 0);
    else if (a >= profile.sqmMin) add("SQM_OK", reasonPoints("SQM_OK"));
    else if (a >= profile.sqmMin * 0.9) add("SQM_SLIGHTLY_UNDER", 0);
    // 広げた検索の広さ（−5㎡まで）は情報の札（保留にしない）
    else if (a >= profile.sqmMin - WIDE_SQM) add("SQM_WIDE", reasonPoints("SQM_WIDE"));
    else add("SQM_UNDER", reasonPoints("SQM_UNDER"), "hold");
  }

  // 徒歩
  if (profile.walkMax != null && facts.walkMinutes != null) {
    if (facts.walkMinutes <= profile.walkMax) add("WALK_OK", 10);
    else if (facts.walkMinutes <= profile.walkMax * 1.5) add("WALK_SLIGHTLY_OVER", -5);
    else add("WALK_OVER", -15, "hold");
  } else if (profile.walkMax != null) missing.push("walk");

  // 築年
  if (profile.buildingAgeMax != null && facts.buildingAge != null) {
    if (facts.buildingAge <= profile.buildingAgeMax) add("BUILDING_AGE_OK", 5);
    // 広げた検索の築年（＋5年まで）は少しだけ低い +2（旧: ＋3年まで −3・＋4〜5年は保留）。BUILDING_AGE_SLIGHTLY_OVER は保存済みの行のために表に残す
    else if (facts.buildingAge <= profile.buildingAgeMax + WIDE_AGE_YEARS) add("BUILDING_AGE_WIDE", reasonPoints("BUILDING_AGE_WIDE"));
    else add("BUILDING_AGE_OVER", -10, "hold");
  } else if (profile.buildingAgeMax != null) missing.push("building_age");
  // 築年の列が空で自由文に「新築・築浅」: 情報の札だけ（合えば +3・古くても 0点）
  if (profile.buildingAgeMax == null && profile.ageTextMax && facts.buildingAge != null) {
    if (facts.buildingAge <= profile.ageTextMax.years) add("BUILDING_AGE_TEXT_OK", reasonPoints("BUILDING_AGE_TEXT_OK"));
    else add("BUILDING_AGE_TEXT_OVER", 0);
  }

  // 送付済みの建物（サーバーの skip-sent と同じ線。スタッフモードでは呼ばれない）
  //   名前が一般名（「物件」等）の物件は照合しない（どの建物か分からない＝送付済みと判断しない・迷う物は残す側）
  //   2026-09-25 任務B: 号室で見る。同じ部屋（号室が一致）は今まで通り外す候補。号室が分かって、その建物で送った部屋に無い時は
  //   ALREADY_SENT_OTHER_ROOM（−3・情報の札）＝同じ建物の新しい空室（実際の🌟で 101→102・205/306→305・1003→202 を外す候補にしていた）。
  //   号室が分からない時は今まで通り（名前が一致すれば外す候補）。外す候補は増やさない（名前の一致は旧と同じ線）
  if (!isGenericBuildingName(facts.name)) {
    const split = splitBuildingRoom(facts.name);
    const room = normalizeRoomKey(facts.roomNo) || split.room;
    const rooms = profile.history.sentRooms?.get(normalizeBuildingName(split.building));
    const nameHit = profile.history.sentBuildings.has(normalizeBuildingName(facts.name));
    // 同じ部屋: 旧の線（名前の一致）でも当たる時だけ外す候補。号室を読んで初めて当たる時（リアプロの「X 303号室」＝旧は名前が合わず当たらなかった）は
    //   保留（ALREADY_SENT_SAME_ROOM）に留める＝外す候補を増やさない。実際の🌟にも同じ部屋を日をおいて送り直した物がある（任務B 5件）
    if (room && rooms?.has(room)) add(nameHit ? "ALREADY_SENT" : "ALREADY_SENT_SAME_ROOM", nameHit ? -30 : reasonPoints("ALREADY_SENT_SAME_ROOM"), nameHit ? "drop" : "hold");
    else if (room && rooms) add("ALREADY_SENT_OTHER_ROOM", reasonPoints("ALREADY_SENT_OTHER_ROOM"));
    else if (nameHit) add("ALREADY_SENT", -30, "drop");
    else if (rooms) add("ALREADY_SENT_OTHER_ROOM", reasonPoints("ALREADY_SENT_OTHER_ROOM"));
  }

  // AD と利益（AD円 − 割引）
  // 2026-09-24 竹内「AD の価値をもっと上げる。AD は報酬なので重要。AD 2ヶ月以上（200%以上）なら追加で点数を上げる」:
  //   → 2026-09-25 段に（REASON_POINTS の説明: 1ヶ月 7／1.5ヶ月 10／2ヶ月 20／2.5ヶ月 23／3ヶ月以上 26・まかなえるは 0点の知らせ）。
  //   条件（家賃・間取り）の hold/drop は AD で覆さない。保留・外す候補の物件は AD の段を _HELD（0点）にする（settleHeldAd・判定の最後）
  const adYen = computeAdYen(facts);
  let profitYen: number | null = null;
  // 月数が無く円だけの時は家賃で月数に直す（「AD 160,000円・家賃 80,000円」＝2ヶ月）
  const adMonthsEff = facts.adMonths ?? (facts.adYen != null && facts.rentYen ? facts.adYen / facts.rentYen : null);
  // 2026-09-25 任務B: 月数だけあって家賃が読めない時（候補プールで AD が読めた分は全部この形）も AD の段の点は付ける。
  //   利益（AD円−割引）と AD_COVERS_DISCOUNT／PROFIT_NEGATIVE は円にできる時だけ（家賃が要る）
  if (adYen == null && adMonthsEff == null) {
    add("AD_UNKNOWN", 0); missing.push("ad");
  } else {
    if (adYen != null) {
      profitYen = adYen - profile.discountYen;
      if (profitYen < 0) add("PROFIT_NEGATIVE", -10, "hold");
      else add("AD_COVERS_DISCOUNT", reasonPoints("AD_COVERS_DISCOUNT"));
    }
    // 資料に「広告費 なし」＝ AD 0（読めない null とは別）。AD 0.5ヶ月（利益が出ない −10）より下に並ぶよう −5 を足す
    if (adMonthsEff != null && adMonthsEff <= 0) add("AD_NONE", reasonPoints("AD_NONE"));
    // 2026-09-25 段（重ねて足す・REASON_POINTS の説明）: 1ヶ月 7 ／1.5ヶ月 10 ／2ヶ月 20 ／2.5ヶ月 23 ／3ヶ月以上 26。
    //   0.01 の余裕は「AD 250%」→2.5 の丸め・円÷家賃の割り算の端数（159,999円/80,000円）で段を落とさないため
    const am = adMonthsEff != null ? adMonthsEff + 0.01 : null;
    if (am != null && am >= 1 && am < 2) add("AD_1M", reasonPoints("AD_1M"));
    if (am != null && am >= 1.5 && am < 2) add("AD_1_5M", reasonPoints("AD_1_5M"));
    if (am != null && am >= 2) add("AD_HIGH", reasonPoints("AD_HIGH"));
    if (am != null && am >= 2.5) add("AD_2_5M", reasonPoints("AD_2_5M"));
    if (am != null && am >= 3) add("AD_VERY_HIGH", reasonPoints("AD_VERY_HIGH"));
  }

  // ペット: 設備欄の照合でペットが決まった（可・相談・不可）時はそちら（EQUIP_PET_*）で数え、説明文の語は見ない（二重に数えない）。
  //   決まらない時（資料が無い・記載なし）だけ今まで通り説明文の「ペット不可」を見る
  const eq = opts.equipment ?? null;
  const petDecided = !!eq?.rows.some((r) => r.want.key === "pet" && r.result !== "unlisted");
  if (profile.pet && !petDecided && /ペット不可|ペット×|ペットNG/.test(facts.rawText)) add("PET_NG", -15, "hold");

  // 資料の表の募集の条件（入居時期の遅れ・定期借家・入居の条件の不可は保留・記載なしは 0点の要確認）。drop には使わない
  const termCodes = termsReasonCodes(opts.terms, profile, { today: opts.today, equipment: eq });
  for (const code of termCodes) add(code, reasonPoints(code), isHoldCode(code) ? "hold" : undefined);
  // 二人入居を資料の表（terms）で決めた時は、設備の照合の「二人入居－（記載なし）」を外す（同じ希望を2つの札にしない）
  const twoDecidedByTerms = termCodes.some((c) => /^CONDITION_TWO_PERSON_(OK|NG|ASK)$/.test(c));

  // 資料の設備欄（× は保留・○ は +3 で合計 +15 まで・－ は 0点の要確認）。drop には使わない
  for (const code of equipmentReasonCodes(eq)) {
    if (twoDecidedByTerms && code === "EQUIP_TWO_PERSON_UNLISTED") continue;
    add(code, reasonPoints(code), /_NG$/.test(code) ? "hold" : undefined);
  }

  // エリア・通勤（area-want.ts の locationReasonCodes。呼ぶ側が計算して渡す＝この部品は大きな駅の表を持たない）
  for (const code of opts.locationCodes ?? []) {
    if (!/^(?:AREA|COMMUTE)_/.test(code) || codes.includes(code)) continue;
    add(code, reasonPoints(code), isHoldCode(code) ? "hold" : undefined);
  }

  // 2026-09-25 案B: 書いた条件の重み（築年の段・駅近・家賃の安さ）と AD 1ヶ月未満（writtenWeightCodes・純関数）
  const rentTotal = facts.rentYen != null ? facts.rentYen + (facts.adminFeeYen ?? 0) : null;
  for (const code of writtenWeightCodes(codes, {
    buildingAge: facts.buildingAge, walkMinutes: facts.walkMinutes,
    rentRatio: rentTotal != null && profile.rentMax ? rentTotal / profile.rentMax : null, adMonths: adMonthsEff,
  }, profile.written)) add(code, reasonPoints(code));

  // 上限は SCORE_MAX（200・旧 130・その前は 100）。条件が全部合う物件は AD なしで 150 台に届き、130 で切ると AD の差（1ヶ月／2ヶ月／3ヶ月）が消えるため。
  //   100 を超える分は「AD の上乗せ」＝報酬の差がそのまま順位に出る（竹内 2026-09-24）
  // 条件の外れ（保留・外す候補の札）がある物件は AD の段を点に入れない（settleHeldAd・札は _HELD で残す）
  if (holds.length || drops.length) {
    const settled = settleHeldAd(codes, true);
    for (let k = 0; k < codes.length; k++) codes[k] = settled[k];
  }
  // 2026-09-25 案B: 全部合う +15・1つだけ外れ +5（保留・外す候補には付けない・settleFitBonus）
  const fitted = settleFitBonus(codes);
  codes.splice(0, codes.length, ...fitted);
  // 点は常に 50＋札の点の合計（重みの版があれば版の点）。上限 SCORE_MAX・必須（strong）の × は上限 20（scoreFromCodes）
  score = scoreFromCodes(codes);
  const verdict: Verdict = drops.length > 0 ? "drop" : (holds.length > 0 || score < 40 ? "hold" : "pass");
  // 理由の日本語は「外す・保留の理由」を先に、良い点は後に（LINE の1行は先頭2つを見せる）
  const flagCodes = [...drops, ...holds];
  const positives = codes.filter((c) => isNewPositive(c) || POSITIVE_BASE_CODES.includes(c) || /^EQUIP_.*_OK$/.test(c) || /^(?:MOVE_IN_OK|FREE_RENT_MATCH)$|^CONDITION_.*_OK$/.test(c));
  const reasonsJa = [...flagCodes, ...codes.filter(isNewInfo), ...positives].map(reasonJa);
  // 設備欄で ○/× が決まった希望は画像で確かめ直さない（同じ希望を二重に数えない）
  const decided = new Set<string>((eq?.rows ?? []).filter((r) => r.result !== "unlisted").map((r) => r.want.key));
  const imageChecks = profile.imageWants.filter((k) => { const e = IMAGE_TO_EQUIP[k]; return !(e && decided.has(e)); });

  return {
    index, rank: facts.rank, name: facts.name, verdict, score, reasonCodes: codes, flagCodes, reasonsJa,
    confidence: profile.confidence, missing, adYen, profitYen,
    imageChecks: verdict === "drop" ? [] : imageChecks,
    imageMust: profile.imageMust ?? [],
    facts,
  };
}

/**
 * この部屋（号室まで）をこのお客様に送付済みか。judgeProperty の ALREADY_SENT / ALREADY_SENT_SAME_ROOM と同じ線（号室が分からない時は建物名の一致）。
 * 2026-09-25 売上サポの同じ建物の間引き（pickup-dedupe の isSent）で、送付済みの部屋を「残す部屋」に選ばないために使う
 */
export function isSentRoom(facts: Pick<PropertyFacts, "name" | "roomNo">, profile: CustomerProfile): boolean {
  if (isGenericBuildingName(facts.name)) return false;
  const split = splitBuildingRoom(facts.name);
  const room = normalizeRoomKey(facts.roomNo) || split.room;
  const rooms = profile.history.sentRooms?.get(normalizeBuildingName(split.building));
  if (room && rooms?.has(room)) return true;
  if (room && rooms) return false;
  return profile.history.sentBuildings.has(normalizeBuildingName(facts.name));
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
    // 2026-09-25 竹内「バストイレ別を希望していたら、一緒の場合はかなり減点。他に物件があれば入れないレベル（NG）」:
    //   間取り図でバス・トイレが一緒と読めた時も、資料の設備欄の × と同じく必須の × の上限（20点）を掛ける
    if (!v && (j.imageMust ?? ["bath_toilet_separate"]).includes(key) && !codes.includes(EQUIP_CAP_CODE)) codes.push(EQUIP_CAP_CODE);
  }
  // 画像の × で条件の外れが増えた物件も AD の段を点に入れない（judgeProperty と同じ settleHeldAd）
  if (flagCodes.length) {
    const settled = settleHeldAd(codes, true);
    for (let k = 0; k < codes.length; k++) codes[k] = settled[k];
  }
  // 2026-09-25 案B: 画像の ○× も書いた条件の合い方に入る → 全部合うの札を付け直す（× で保留になれば外れる）
  const fitted = settleFitBonus(codes);
  codes.splice(0, codes.length, ...fitted);
  // 2026-09-25 反証レビュー: j.score は上限 200 で丸めた後の値なので、そこから足し引きすると「50＋札の合計」とずれる
  //   （素点 230 の物件に画像の × −10 で 190＝本当は 220→200）。札が決まった後に 50＋合計 で付け直す。
  //   必須の × の上限20も素点から掛け直す（反証レビュー 2026-09-24・scoreFromCodes）
  score = scoreFromCodes(codes);
  const verdict: Verdict = j.verdict === "drop" ? "drop" : (hold || score < 40 ? "hold" : "pass");
  const positives = codes.filter((c) => isNewPositive(c) || POSITIVE_BASE_CODES.includes(c) || /^IMAGE_.*_OK$/.test(c) || /^EQUIP_.*_OK$/.test(c) || /^(?:MOVE_IN_OK|FREE_RENT_MATCH)$|^CONDITION_.*_OK$/.test(c));
  const reasonsJa = [...flagCodes, ...codes.filter(isNewInfo), ...positives].map(reasonJa);
  return { ...j, score, verdict, reasonCodes: codes, flagCodes, reasonsJa };
}

/** 理由の日本語に良い点として出す札（AD の段は 1.5ヶ月・2.5ヶ月も） */
const POSITIVE_BASE_CODES = ["ZERO_ZERO_MATCH", "AD_VERY_HIGH", "AD_2_5M", "AD_HIGH", "AD_1_5M", "AD_1M", "FLOOR_PLAN_MATCH"];

/** 2026-09-25 に足した加点の札（理由の日本語に出す） */
function isNewPositive(c: string): boolean {
  return /^(?:FLOOR_PLAN_ALT_MATCH|FLOOR_PLAN_SAME_CLASS|FLOOR_PLAN_LARGER|SQM_OK|BUILDING_AGE_TEXT_OK|AREA_STATION_MATCH|AREA_WARD_MATCH|AREA_LINE_MATCH|AREA_NEAR|AREA_REGION_MATCH|AREA_CLOSE|COMMUTE_OK)$/.test(c)
    // 広げた検索の幅の内側（希望より少しだけ低い加点）
    || /^(?:RENT_WIDE|FLOOR_PLAN_WIDE|BUILDING_AGE_WIDE|AREA_STATION_WIDE|AREA_STATION_2STOPS|AREA_WARD_WIDE)$/.test(c)
    // 案B（書いた条件の重み・全部合う）
    || /^(?:ZERO_ZERO_INFERRED|AGE_W5|AGE_W10|AGE_W15|AGE_COL_W5|AGE_COL_W10|WALK_NEAR_W5|WALK_NEAR_W7|WALK_TEXT_OK|RENT_CHEAP_W80|RENT_CHEAP_W90|RENT_CHEAP_W95)(?:_MUST|_SOFT)?$|^FIT_(?:ALL|ALL_HALF|ONE_MISS|ONE_MISS_HALF)$/.test(c);
}
/** 2026-09-25 に足した情報の札（減点するが保留にしない物・理由の日本語で保留の後に出す） */
function isNewInfo(c: string): boolean {
  return /^(?:RENT_BELOW_MIN|AREA_FAR|AREA_DIRECTION_NG|COMMUTE_OVER|SQM_UNKNOWN|AREA_UNKNOWN|COMMUTE_UNKNOWN|SQM_WIDE|ALREADY_SENT_OTHER_ROOM|AD_NONE|AD_UNDER_1M|AGE_W_OLD|WALK_TEXT_OVER|WALK_TEXT_FAR)$/.test(c);
}

/** judgeProperty で「外す（drop）」「保留（hold）」にするコード（IMAGE_*_NG・EQUIP_*_NG は hold） */
export const DROP_REASON_CODES = new Set(["ALREADY_SENT", "RENT_OVER_130"]);
export const HOLD_REASON_CODES = new Set([
  "RENT_OVER_110", "INITIAL_COST_NOT_ZERO", "INITIAL_COST_OVER_LIMIT", "FLOOR_PLAN_MISMATCH", "WALK_OVER", "BUILDING_AGE_OVER", "PROFIT_NEGATIVE", "PET_NG",
  "MOVE_IN_LATE", "CONTRACT_FIXED", // 2026-09-25 資料の表の募集の条件
  "SQM_UNDER", "AREA_EXCLUDED", // 2026-09-25 広さの9割未満・希望外のエリア（以外）
  "ALREADY_SENT_SAME_ROOM", // 2026-09-25 号室で初めて当たる同じ部屋（外す候補にしない）
]);
const isHoldCode = (c: string) => HOLD_REASON_CODES.has(c) || /^(?:IMAGE|EQUIP|CONDITION)_.*_NG$/.test(c);

/**
 * 保存済みの判定（理由コード）に、資料の設備欄の照合を付け直す（決定論）。
 * 2026-09-24: 既存の行（HONOKA さんの id 50〜67）は説明文が古い形で、judgeProperty をやり直すと家賃・徒歩・AD の材料が消える
 *   → 元のコードは残し、①前の EQUIP_* を外す ②設備欄で決まった希望の IMAGE_*（バストイレ別・独立洗面・南向き・2階以上）を外す（二重に数えない）
 *   ③設備欄でペットが決まったら PET_NG を外す ④新しい EQUIP_* を足す。点は 50＋合計（0〜SCORE_MAX・必須の × は上限20）、
 *   verdict は drop のコードがあれば drop・hold のコードか 40 点未満で hold
 */
export function applyEquipmentMatch(
  j: { reasonCodes: string[] },
  m: EquipmentMatch | null | undefined,
): { score: number; verdict: Verdict; reasonCodes: string[]; flagCodes: string[]; reasonsJa: string[] } {
  const decided = new Set<string>((m?.rows ?? []).filter((r) => r.result !== "unlisted").map((r) => r.want.key));
  const imageDecided = (c: string) => {
    const k = (Object.keys(IMAGE_TO_EQUIP) as ImageWantKey[]).find((ik) => c === `IMAGE_${ik.toUpperCase()}_OK` || c === `IMAGE_${ik.toUpperCase()}_NG`);
    return !!k && decided.has(IMAGE_TO_EQUIP[k] as string);
  };
  // 設備欄で二人入居が決まったら資料の表の CONDITION_TWO_PERSON_* を外す（二重に数えない・matchListingTerms と同じ決まり）
  let codes = j.reasonCodes.filter((c) => !c.startsWith("EQUIP_") && !imageDecided(c) && !(c === "PET_NG" && decided.has("pet"))
    && !(c.startsWith("CONDITION_TWO_PERSON_") && decided.has("two_person")));
  const twoByTerms = codes.some((c) => /^CONDITION_TWO_PERSON_(OK|NG|ASK)$/.test(c));
  codes.push(...equipmentReasonCodes(m).filter((c) => !(twoByTerms && c === "EQUIP_TWO_PERSON_UNLISTED")));
  // 付け直しで条件の外れが増えた／無くなった時は AD の段の札を合わせる（保留・外す候補なら _HELD の0点）
  codes = settleHeldAd(codes, codes.some((c) => DROP_REASON_CODES.has(c) || isHoldCode(c)));
  // 2026-09-25 案B: 設備の ○× が変わったら全部合うの札も付け直す
  codes = settleFitBonus(codes);
  const score = scoreFromCodes(codes);
  const drops = codes.filter((c) => DROP_REASON_CODES.has(c));
  const holds = codes.filter(isHoldCode);
  const verdict: Verdict = drops.length > 0 ? "drop" : (holds.length > 0 || score < 40 ? "hold" : "pass");
  const flagCodes = [...drops, ...holds];
  const positives = codes.filter((c) => isNewPositive(c) || POSITIVE_BASE_CODES.includes(c) || /^(?:IMAGE|EQUIP)_.*_OK$/.test(c) || /^(?:MOVE_IN_OK|FREE_RENT_MATCH)$|^CONDITION_.*_OK$/.test(c));
  return { score, verdict, reasonCodes: codes, flagCodes, reasonsJa: [...flagCodes, ...codes.filter(isNewInfo), ...positives].map(reasonJa) };
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
  const src = j.verdict === "pass" ? j.reasonsJa : j.flagCodes.map(reasonJa);
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
