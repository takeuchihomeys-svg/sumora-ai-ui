// app/lib/recommend-star-rank.ts
// 🌟（物件オススメ＝送る束の中の「一番オススメ」1件）の並べ方。ピックアップ（束に入れる段）の点とは別。純関数・DB/LLM 依存なし。
//
// 2026-10-06 竹内さんの決定（⑰ の調査 scripts/audit-recommend-reasons.ts の後）:
//   ・束の中の一番は「合い方」が主軸: 間取りの一致・広さ（束の一番）・築年（束の一番新しい）・RC・設備の数／希望の設備・敷礼0
//   ・AD は大きな点でなく「線」（AD 1.5ヶ月以上を優先の段）
//   ・例外（竹内さん原文）「状況によって刺さる物件がない場合などは低いADの物件をオススメにするばあもある。
//     お客さんと内覧くむために、内覧組むことが優先的」＝線の上に合う物が無い時は、線の下でも合う物を🌟にしてよい
//
// 調査の数（242回・180日）: スタッフの🌟は束の中で 構造RC寄り 76%・AD 60%・設備の数 53%・築年 42%・広さ 36% が一番（ランダム 29〜34%）。
//   家賃の上限寄りは理由にならない（27%・ランダム 29%）。点の1位≠🌟の回の点差の最大は AD（+1,141点・61回）。
//
// 使い方: 束の候補（判定済みの札 codes と事実）を渡す → 並び（一番オススメが先頭）と、それぞれの理由。

export type StarCandidate = {
  /** 見分け（物件名＋号室など） */
  key: string;
  /** judgeProperty の札 */
  codes: readonly string[];
  /** 札の点（50＋Σ）＝ピックアップの点 */
  score: number;
  /** 札 → 点（AD の家族の点を外すのに使う） */
  pointsOf: (code: string) => number;
  areaSqm?: number | null;
  buildingAge?: number | null;
  /** RC / SRC / 鉄骨 / 軽量鉄骨 / 木造 */
  structure?: string | null;
  equipmentCount?: number | null;
  /** お客様の希望の設備に合う数 */
  equipWantHits?: number | null;
  /** AD（ヶ月）。null＝分からない */
  adMonths?: number | null;
  /** 2026-10-06 状況で重みを変える材料（無ければ比べない）: 敷金礼金とも0／駅徒歩（分）／今すぐ入れるか（open＝空室・later＝退去予定・建築中）／設備の鍵（listing-equipment の鍵） */
  zeroZero?: boolean | null;
  walkMinutes?: number | null;
  vacancy?: "open" | "later" | null;
  /** 階（号室・資料から） */
  floor?: number | null;
  equipmentKeys?: readonly string[] | null;
  /** 2026-10-06d リノベーション済み（資料の文字・listing-renovation.renovationOfText）。null＝分からない */
  renovated?: boolean | null;
  /** 2026-10-06d 敷金＋礼金（ヶ月・資料の表）。同点の分け方（初期費用面）にだけ使う */
  initialMonths?: number | null;
  /** 保留・送らない物（審査中・NG 等）は呼ぶ側で外す。ここでは見ない（2026-10-06e 保留の理由が初期費用だけで AD が高い行は呼ぶ側が候補に残す・star-rank-pickup.starOpenRow） */
};

export type StarRankRule = {
  adLine: number; overrideMargin: number; areaBest: number; ageBest: number; structureRc: number; structureWood: number; equipRankMax: number; equipWantEach: number; adNeverBelow: number;
  /** 2026-10-06d 同点（同じ段・同じ合い方）を AD → 初期費用面で分ける（false＝元の並び） */
  tieBreak?: boolean;
  /** 2026-10-06d リノベ済みの部屋を「新しさ」の比べでこの築年とみなす（null＝リノベを見ない）。renoScope で効かせる所 */
  renoAge?: number | "newest" | null;
  /** household＝1LDK以上の希望の「一番新しい +15」だけ・all＝束の一番新しい（ageBest）にも */
  renoScope?: "household" | "all";
};
export const STAR_RANK_RULE: Readonly<StarRankRule> = {
  /** AD の線（これ以上を優先の段に） */
  adLine: 1.5,
  /** 線の下の物を🌟にする差（合い方の点がこれ以上高ければ「刺さる」として線を越える）＝内覧を組むのが優先 */
  overrideMargin: 15,
  /** 束の中で一番広い */
  areaBest: 15,
  /** 束の中で一番新しい */
  ageBest: 8,
  /** 構造 */
  structureRc: 6,
  structureWood: -6,
  /** 設備の数（束の中の順位で 0〜） */
  equipRankMax: 6,
  /** 希望の設備に合う数 1つあたり */
  equipWantEach: 4,
  /** AD 1未満は🌟にしない（他に何も無い時だけ） */
  adNeverBelow: 1,
  /**
   * 2026-10-06d 竹内「同点ならadが高いや初期費用面をみてさらにわける」: 同じ段・同じ合い方の点は starTieBreak（AD → 敷礼0 → フリーレント → 敷礼の月数）。
   *   当て直し（scripts/audit-star-fit-d.ts・新着1件を外した 231回）: 1位が同点 53回で 28→30%・全体 新だけ当たり1／旧だけ0（後3割 49→50%・直した束 50→52%）
   */
  tieBreak: true,
  /**
   * 2026-10-06d 竹内「ほかにものベーション物件を押している場合もあるから注意」: 1LDK以上の希望の「一番新しい +15」は、リノベ済みの部屋を築0（一番新しい側）とみなす。
   *   スタッフの🌟の本文が「リノベ」の10回のうち7回が1LDK以上の希望で、🌟は築35〜42年（束の一番新しいは築2〜22年）＝築年だけだと +15 が逆に効く。
   *   当て直し: 物件名の「（フルリノベーション）」と資料の文字で読めた分だけで 新だけ当たり1／旧だけ0（後3割・live は変わらない）。
   *   🌟の本文のリノベを🌟だけに付けた上限でも 3／0。築10・築15 とみなすと 0／0（束の一番新しいは築2〜22年）。全員（ageBest）にも効かせても同じ数＝広げない（お客様による）
   *   ⚠ 本番の 👑 は物件名と説明文だけで読む（資料の文字 pdf_text は売上サポの行の読み出しに無い）
   */
  renoAge: 0,
  renoScope: "household",
};

const isAdCode = (k: string) => /^(AD_|PROFIT_)/.test(k);

/** 束の中の順位（0＝一番良い・1＝一番悪い・値なし／比べる相手なし null） */
function rankIn(vals: Array<number | null | undefined>, v: number | null | undefined, dir: "high" | "low"): number | null {
  if (v == null) return null;
  const xs = vals.filter((x): x is number => x != null);
  if (xs.length < 2) return null;
  return xs.filter((x) => (dir === "high" ? x > v : x < v)).length / (xs.length - 1);
}

export type StarRanked = { key: string; fit: number; tier: "line" | "below" | "never"; reasons: string[] };

// ─── 状況で重みを変える（2026-10-06 竹内「お客さんの状況に連動して、評価基準も変動できていればより正確に」）──────────
/**
 * お客様の今の状況（希望の話題・入居の急ぎ）。どの項目も「その話題をお客様が言っている時だけ」束の中の比べに足し点を付ける。
 *   wantTopics … recommendation-gaps の話題の鍵（low_initial・zero_deposit・spacious・new_build・station_near・bath_toilet …）
 *   moveInUrgent … 入居を急ぐ（今月・来月・即・急ぎ・絶対の期限）
 */
export type StarSituation = { zero: boolean; spacious: boolean; newBuild: boolean; stationNear: boolean; floorHigh: boolean; moveInUrgent: boolean; equipKeys: string[]; /** 2026-10-06c 1LDK以上（1K・1R を含まない）の間取りを希望＝二人以上・広い間取りの型 */ household?: boolean;
  /** 2026-10-06f 築古（old-building-age の線以上・リノベ済みを除く）をオススメの点で下げる（初期費用重視の型・築年の列なし・「古くても良い」と言っていない）。recommend-score が見る */
  oldAgeAvoid?: boolean };
/** 話題の鍵 → 設備の鍵（listing-equipment） */
const TOPIC_EQUIP: Record<string, string[]> = {
  bath_toilet: ["bath_toilet"], washbasin: ["washbasin"], laundry_in: ["laundry_in"], autolock: ["autolock"], security: ["autolock", "monitor_intercom"],
  delivery_box: ["delivery_box"], bath_dryer: ["bath_dryer"], reheating: ["reheating"], internet: ["net_free"], corner: ["corner"], sunny: ["south"],
  parking: ["parking"], storage: ["walk_in_closet"],
};
export function starSituationOf(input: { wantTopics?: readonly string[] | null; moveInUrgent?: boolean | null; household?: boolean | null; oldAgeAvoid?: boolean | null }): StarSituation {
  const w = new Set((input.wantTopics ?? []).map(String));
  return {
    zero: w.has("low_initial") || w.has("zero_deposit"),
    spacious: w.has("spacious"),
    newBuild: w.has("new_build"),
    stationNear: w.has("station_near"),
    floorHigh: w.has("floor2"),
    moveInUrgent: !!input.moveInUrgent || false,
    equipKeys: [...new Set([...w].flatMap((k) => TOPIC_EQUIP[k] ?? []))],
    household: !!input.household,
    oldAgeAvoid: !!input.oldAgeAvoid,
  };
}
export type StarSituationRule = { zero: number; spacious: number; newBuild: number; stationNear: number; floorHigh: number; vacantNow: number; equipEach: number; newBuildHousehold?: number };
/**
 * 状況の足し点（0＝その状況では何も変えない）。決め方は scripts/audit-star-rank-situation.ts の当て直し（244回・180日・スタッフの🌟との1位一致）:
 *   入れた物（対の比べで「状況ありだけ当たり」＞「なしだけ当たり」・全体と後3割の両方で上がる物だけ）
 *     zero 15 … 初期費用・敷礼0を言っているお客様は、束の中で敷礼0の物（🌟が敷礼0 73%・ランダム 62%）
 *     floorHigh 15 … 2階以上を言っているお客様は、束の中で一番高い階（🌟 46%・ランダム 28%／言っていない人は 22%・26%）
 *     → 合わせて 32%→35%（後3割 42%→46%・live 48%→48%）・状況ありだけ当たり 6・なしだけ当たり 0（条件欄だけで決めた時）
 *   止めた物（測って下がった・揺れの内）:
 *     vacantNow … 入居を急ぐお客様の🌟は空室の物が少ない（43%・ランダム 56%）＝退去予定の部屋を申込誘導で推している（recommend-cta の「刺さるが退去予定」）。足すと 32→30%
 *     spacious … 広さを言っている人ほど「一番広い」は選ばれない（27%・ランダム 24%・足すと 32→30%）。広さは状況によらず areaBest で見ている
 *     stationNear・newBuild・equipEach … 揺れの内（±2回）
 *   2026-10-06c 型で分けた当て直し（scripts/audit-star-mismatch-why.ts・物差しを直した束 232回）:
 *     newBuildHousehold 15 … 1LDK以上（1K・1R を含まない）の間取りを希望するお客様は、束の中で一番新しい物（🌟が一番新しい 60%・ランダム 35%・60回）。
 *       一人暮らし（1K 等）は 33%・ランダム 33% で築年を見ていない＝全員に築年を足すと下がる（築年 15/20/25 は新だけ当たり≒旧だけ当たり）。
 *       前7割 37→39%・後3割 46→49%・live 47→53%・新だけ当たり 8／旧だけ 2
 *     見送り: 「お客様の条件を見出しで言う」型（敷礼0・駅近・家賃）は回ごとにどれを選ぶかが揺れ、型で決めると上がらない（前7割で上がっても後3割で下がる）
 */
export const STAR_SITUATION_RULE: Readonly<StarSituationRule> = { zero: 15, spacious: 0, newBuild: 0, stationNear: 0, floorHigh: 15, vacantNow: 0, equipEach: 0, newBuildHousehold: 15 };

/** 合い方の点（AD の家族の点を外した札の点＋束の中の相対の足し点） */
export function starFitScores(cands: readonly StarCandidate[], rule = STAR_RANK_RULE, sit?: StarSituation | null, sitRule: Readonly<StarSituationRule> = STAR_SITUATION_RULE): Array<{ fit: number; reasons: string[] }> {
  const areas = cands.map((c) => c.areaSqm), eqs = cands.map((c) => c.equipmentCount);
  // 2026-10-06d 新しさの比べ: リノベ済みの部屋は築年が古くても renoAge とみなす（renoScope の所だけ）
  //   "newest"＝束の一番新しい物と並ぶ（同点の +15 を分け合う・追い越さない）
  const knownAges = cands.map((c) => c.buildingAge).filter((v): v is number => v != null);
  const renoTo: number | null = rule.renoAge == null ? null : rule.renoAge === "newest" ? (knownAges.length ? Math.min(...knownAges) : null) : rule.renoAge;
  const renoAgeOf = (c: StarCandidate) => (renoTo != null && c.renovated === true ? (c.buildingAge == null ? renoTo : Math.min(c.buildingAge, renoTo)) : c.buildingAge);
  const rawAges = cands.map((c) => c.buildingAge), renoAges = cands.map(renoAgeOf);
  const ages = rule.renoAge != null && rule.renoScope === "all" ? renoAges : rawAges;
  const hhAges = rule.renoAge != null ? renoAges : rawAges;
  const ageAt = (i: number) => ages[i], hhAgeAt = (i: number) => hhAges[i];
  const walks = cands.map((c) => c.walkMinutes), floors = cands.map((c) => c.floor);
  // 束の中で値が割れている時だけ足す（全部同じなら差にならない）
  const splits = (vals: Array<unknown>) => new Set(vals.filter((v) => v != null)).size >= 2;
  const zeroSplit = splits(cands.map((c) => c.zeroZero)), vacSplit = splits(cands.map((c) => c.vacancy));
  return cands.map((c, i) => {
    const reasons: string[] = [];
    let fit = 0;
    if (sit) {
      if (sit.zero && sitRule.zero && zeroSplit && c.zeroZero === true) { fit += sitRule.zero; reasons.push("敷礼0（初期費用の希望）"); }
      if (sit.spacious && sitRule.spacious && rankIn(areas, c.areaSqm, "high") === 0) { fit += sitRule.spacious; reasons.push("一番広い（広さの希望）"); }
      if (sit.newBuild && sitRule.newBuild && rankIn(ages, ageAt(i), "low") === 0) { fit += sitRule.newBuild; reasons.push("一番新しい（築浅の希望）"); }
      if (sit.household && sitRule.newBuildHousehold && rankIn(hhAges, hhAgeAt(i), "low") === 0) { fit += sitRule.newBuildHousehold; reasons.push(c.renovated === true && renoTo != null && (c.buildingAge == null || c.buildingAge > renoTo) ? "リノベ済みで一番新しい側（1LDK以上の希望）" : "一番新しい（1LDK以上の希望）"); }
      if (sit.stationNear && sitRule.stationNear && rankIn(walks, c.walkMinutes, "low") === 0) { fit += sitRule.stationNear; reasons.push("駅から一番近い（駅近の希望）"); }
      if (sit.floorHigh && sitRule.floorHigh && rankIn(floors, c.floor, "high") === 0) { fit += sitRule.floorHigh; reasons.push("一番高い階（2階以上の希望）"); }
      if (sit.moveInUrgent && sitRule.vacantNow && vacSplit && c.vacancy === "open") { fit += sitRule.vacantNow; reasons.push("空室ですぐ入れる（入居を急ぐ）"); }
      if (sit.equipKeys.length && sitRule.equipEach && Array.isArray(c.equipmentKeys)) {
        const hit = sit.equipKeys.filter((k) => c.equipmentKeys!.includes(k));
        if (hit.length) { fit += sitRule.equipEach * hit.length; reasons.push(`希望の設備（${hit.join("・")}）`); }
      }
    }
    return { fit, reasons, c, i };
  }).map(({ fit: sitFit, reasons: sitReasons, c, i }) => {
    const reasons: string[] = [];
    let fit = c.score - c.codes.filter(isAdCode).reduce((a, k) => a + c.pointsOf(k), 0);
    if (rankIn(areas, c.areaSqm, "high") === 0) { fit += rule.areaBest; reasons.push("束の中で一番広い"); }
    if (rankIn(ages, ageAt(i), "low") === 0) { fit += rule.ageBest; reasons.push("束の中で一番新しい"); }
    const st = String(c.structure ?? "");
    if (/^(RC|SRC)$/.test(st)) { fit += rule.structureRc; reasons.push("RC"); }
    else if (st === "木造") { fit += rule.structureWood; reasons.push("木造"); }
    const er = rankIn(eqs, c.equipmentCount, "high");
    if (er != null) fit += rule.equipRankMax * (1 - er);
    if (c.equipWantHits) { fit += rule.equipWantEach * c.equipWantHits; reasons.push(`希望の設備 ${c.equipWantHits}`); }
    return { fit: fit + sitFit, reasons: [...reasons, ...sitReasons] };
  });
}

/**
 * 束の中の並び（一番オススメが先頭）。
 *   1) AD が線以上（adLine）の物を先に、その中は合い方の点の順
 *   2) ただし線の下（AD 不明を含む・AD1未満は除く）の物の合い方が、線の上の一番より overrideMargin 以上高ければ先頭に（内覧を組むのが優先）
 *   3) AD 1未満（adNeverBelow 未満）は最後（他に無い時だけ）
 *   同点は元の並び（呼ぶ側の点の順）を保つ
 */
export function rankStarCandidates(cands: readonly StarCandidate[], rule = STAR_RANK_RULE, sit?: StarSituation | null, sitRule: Readonly<StarSituationRule> = STAR_SITUATION_RULE): StarRanked[] {
  const fits = starFitScores(cands, rule, sit, sitRule);
  const rows = cands.map((c, i) => {
    const tier: StarRanked["tier"] = c.adMonths != null && c.adMonths < rule.adNeverBelow ? "never" : c.adMonths != null && c.adMonths >= rule.adLine ? "line" : "below";
    return { key: c.key, fit: fits[i].fit, tier, reasons: fits[i].reasons, i };
  });
  // 2026-10-06d 竹内「同点ならadが高いや初期費用面をみてさらにわける」: 同じ合い方の点は AD（分からない物は後）→ 敷礼0 → フリーレント → 敷金＋礼金が少ない → 元の並び
  const tb = (a: typeof rows[number], b: typeof rows[number]) => (rule.tieBreak ? starTieBreak(cands[a.i], cands[b.i]) : 0);
  const byFit = (a: typeof rows[number], b: typeof rows[number]) => b.fit - a.fit || tb(a, b) || a.i - b.i;
  const line = rows.filter((r) => r.tier === "line").sort(byFit);
  const below = rows.filter((r) => r.tier === "below").sort(byFit);
  const never = rows.filter((r) => r.tier === "never").sort(byFit);
  let head: typeof rows = [];
  if (line.length && below.length && below[0].fit - line[0].fit >= rule.overrideMargin) {
    head = [{ ...below[0], reasons: [...below[0].reasons, "AD は線の下だが合い方が大きく上（内覧を組むのが優先）"] }];
    below.shift();
  }
  const ordered = line.length ? [...head, ...line, ...below, ...never] : [...below, ...never];
  return ordered.map(({ i: _i, ...r }) => r);
}

/**
 * 2026-10-06d 同点（同じ段・同じ合い方の点）の分け方。負＝a が先。
 *   1) AD が高い（分からない物は分かる物の後）
 *   2) 初期費用面: 敷礼0 → フリーレント（札 FREE_RENT*）→ 敷金＋礼金（ヶ月）が少ない
 *   どれでも分からなければ 0（呼ぶ側の元の並び）
 */
export function starTieBreak(a: StarCandidate, b: StarCandidate): number {
  const ad = (c: StarCandidate) => (c.adMonths == null ? -1 : c.adMonths);
  if (ad(a) !== ad(b)) return ad(b) - ad(a);
  const zz = (c: StarCandidate) => (c.zeroZero === true ? 1 : 0);
  if (zz(a) !== zz(b)) return zz(b) - zz(a);
  const fr = (c: StarCandidate) => (c.codes.some((k) => /^FREE_RENT(?:_MATCH)?$/.test(k)) ? 1 : 0);
  if (fr(a) !== fr(b)) return fr(b) - fr(a);
  if (a.initialMonths != null && b.initialMonths != null && a.initialMonths !== b.initialMonths) return a.initialMonths - b.initialMonths;
  return 0;
}

// ─── 切り替え（2026-10-06 竹内さん「A: 今切り替える」・いつでも戻せる）────────────────────────────
/**
 * 🌟（売上サポの 👑＝一番オススメ）の決め方。
 *   fit    … この並べ方（合い方が主軸・AD は線）。既定
 *   legacy … 今までの決め方（合計＝判定の点＋画像の加点の1位・pickup-best.compareOverall）
 * サーバーは環境変数 STAR_RANK_MODE（`off` で legacy）を読んで画面へ値で渡す（画面は環境変数を読まない・サーバー専用の部品を import しない）。
 */
export type StarRankMode = "fit" | "legacy";
export function starRankMode(raw: unknown): StarRankMode {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "off" || s === "legacy" || s === "old" || s === "0" || s === "false" ? "legacy" : "fit";
}
/** まとめ（property_pickup_completions.result.basis_rule）に残す決まりの名前（fit の時）。重みを変えたら版を上げる */
// 2026-10-06b 状況の足し点（STAR_SITUATION_RULE・敷礼0／2階以上）を入れた
// 2026-10-06c 1LDK以上の希望なら束の中で一番新しい物に +15（newBuildHousehold）
// 2026-10-06d 同点を AD → 初期費用面で分ける（tieBreak）・1LDK以上の「一番新しい」でリノベ済みを築0とみなす（renoAge）
// 2026-10-06e 保留でも理由が初期費用だけ（INITIAL_COST_NOT_ZERO）で AD が線（star-rank-pickup.SOFT_HOLD_AD_LINE）以上の行を候補に（pickup-best.pickCustomerBest）
// 2026-10-06f 初期費用重視の方に築31年以上（リノベ済みを除く）−15（old-building-age.OLD_AGE_RULE・recommend-score・OLD_AGE_MODE=off で止める）
export const STAR_FIT_RULE_TAG = "star-fit@2026-10-06f";
