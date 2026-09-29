// app/lib/pickup-review-order.ts（純関数・画面とサーバーで共用。サーバーの部品は import しない）
// 売上サポのピックアップ画面で、1回分の物件の並び順と「なぜその点・なぜ外す候補か」の札を決める。
//
// 2026-09-24 竹内（HONOKA さんの itandi の回・property_pickups id 50〜67）:
//   「並び順は物件オススメが一番上でスコアリング順にする」
//     → 🌟★（一番オススメ）→ 🌟 → 印なし、同じ印の中は点（score）の高い順、同点は元の順位（【N】）
//   「外す候補 20 と出てるが、なんで全部外す候補 20 でばらつきないのか。今回なんで外されているのか理由が分かれば大きい」
//     → 点の横に理由の札（減点・外す理由が先・何点引いたか）。材料が読めずに点が動かない時は「材料なし」も札で出す
//       （点が横並びの原因は『材料が無い』か『同じ理由が全件に当たった』のどちらか。画面で一目で分かるように）
import { BASE_SCORE, reasonJa, reasonPoints, ngHitCodes } from "./property-brain";
import { PICKUP_AIX_MAX } from "./pickup-aix-handoff";
import { compareOverall } from "./pickup-best";
// 2026-09-28 竹内「審査中と出ているのは物件ピックアップのチェックのところに入れない」「新規のお客さんは AD1 を入れない・AD2 以上を優先」（純関数）
import { listingDealStatus } from "./listing-deal-status";
import { selectByAdPriority, isFirstProposalRound } from "./pickup-ad-priority";

/** 2026-09-27 判定・画像で分析の点・回の時刻（あれば）も並びに使う（pickup-best.compareOverall） */
export type ReviewOrderRow = { id: number; rank: number; recommended: number; score: number | null; verdict?: string | null; created_at?: string | null; reason_codes?: string[] | null; image_analysis?: { match?: unknown; match_raw?: unknown; [k: string]: unknown } | null };

/**
 * 並びの比べ方: 点の高い順（点なしは最後）→ 同点は DeepSeek の🌟★／🌟 → 順位 → id。
 * 2026-09-25 竹内（野口さんの回: 162点に🌟★・164点に🌟）: 「お客さんにベストな物件が一番オススメ」。🌟★ は DeepSeek が回ごとに選んだ印で
 *   点と連動していなかった → 並びは点を先にし、DeepSeek の選び方は「点が並んだ時の順番」にだけ使う（1点でも差があれば点の順）。
 *   一番オススメ（👑）は pickCustomerBest の決まり（画像で分析が要るお客様は画像の点）で決め、sortForReview の bestId で先頭に置く
 */
export function compareForReview(a: ReviewOrderRow, z: ReviewOrderRow): number {
  // 2026-09-27 竹内「画像で分析の部分も上の部分にまとめる。まとめたうえで結果をだす」: 👑・まとめの順位と同じ1本の並び
  //   （判定の点 → 判定 → 画像で分析の点 → 上限前の点 →「合う」の数 → 🌟★/🌟 → 新しい回 → 順位 → id）
  return compareOverall(a, z);
}

/** 1回分の物件を画面の並びにする（元の配列は変えない）。bestId（👑 一番オススメ）があればそれを先頭に */
export function sortForReview<T extends ReviewOrderRow>(items: ReadonlyArray<T>, bestId?: number | null): T[] {
  const sorted = items.slice().sort(compareForReview);
  if (bestId == null) return sorted;
  const i = sorted.findIndex((x) => x.id === bestId);
  return i > 0 ? [sorted[i], ...sorted.slice(0, i), ...sorted.slice(i + 1)] : sorted;
}

// ── AIX に渡す物件のチェック（2026-09-26）。page.tsx が import する pickup-aix-handoff に判定の部品を持ち込まないよう、並びの隣に置く ──
/** AIX に渡せる候補の行（未確認・外す候補でない・72時間切れでない） */
export type AixPickRow = { id: number; rank: number; recommended: number; score: number | null; status: string; verdict: string | null; expired?: boolean; reason_codes?: string[] | null;
  /** 2026-09-28 資料の現況の申込の状況（審査中・商談中）。詳細 API が pdf_text から読んだ値。無ければ terms.evidence.moveIn から読む */
  deal_status?: string | null; terms?: { evidence?: { moveIn?: string | null } | null } | null };
const aixCandidate = (r: AixPickRow) => r.status === "pending" && r.verdict !== "drop" && !r.expired;

/**
 * 2026-09-28 竹内「審査中と出ているのは物件ピックアップのチェックのところに入れない」（9/27「商談中は審査中と同じ」）:
 *   資料の現況が審査中・商談中の部屋か（資料の文字のまま・listing-deal-status）。既定のチェック・質の高い10件・10件に絞る時に使う
 */
export function dealStatusOf(r: Pick<AixPickRow, "deal_status" | "terms">): "審査中" | "商談中" | null {
  if (r.deal_status === "審査中" || r.deal_status === "商談中") return r.deal_status;
  return listingDealStatus({ evidenceMoveIn: r.terms?.evidence?.moveIn ?? null });
}

/**
 * 2026-09-29 反証: 手でチェックした審査中・商談中の部屋を AIX に渡す前に確かめる文（無ければ null＝確かめない）。
 *   確かめる所は AIX に渡すボタン（sendViaAix・👑 の1件送りも）。画像の保存では聞かない
 */
export function dealConfirmMessage(rows: ReadonlyArray<Pick<AixPickRow, "deal_status" | "terms"> & { property_name?: string | null; room_no?: string | null }>): string | null {
  const deal = rows.map((r) => ({ r, st: dealStatusOf(r) })).filter((x) => x.st);
  if (deal.length === 0) return null;
  const names = deal.map(({ r, st }) => `${r.property_name ?? ""}${r.room_no ? ` ${r.room_no}` : ""}：${st}`).join("、");
  return `資料の現況が審査中・商談中の物件が${deal.length}件入っています（${names}）。このまま AIX に渡しますか？`;
}

/**
 * 点の高い順（画面の並び sortForReview と同じ・👑 を先頭）に max 件まで選ぶ。
 * 2026-09-26 竹内のスクショ「AIX物件ピックアップ（20件）」: リアプロの一括が 2件ずつ7回に分かれて届いた回（20件・外す候補 0）で、
 *   既定のチェックが「未確認で外す候補以外 全部」＝20件になり、押すと「10件までにしてください」で止まっていた。
 */
export function pickTopForAix<T extends AixPickRow>(items: ReadonlyArray<T>, bestId?: number | null, max = PICKUP_AIX_MAX): number[] {
  // 2026-09-28 手でチェックした審査中・商談中の部屋は、絞る時に一番後ろ（先に外れる）
  const cand = items.filter(aixCandidate);
  const open = cand.filter((r) => !dealStatusOf(r)), deal = cand.filter((r) => dealStatusOf(r));
  return [...sortForReview(open, bestId ?? null), ...sortForReview(deal, bestId ?? null)].slice(0, max).map((r) => r.id);
}

/**
 * 2026-09-27 竹内「物件ピックアップの場合、質の高い10件のボタン、3件ではない10件で行う」
 *   ＋「質の高い物件は NG 条件の物件が入ってたら10件にならなくても入れない」「お客さんからの NG 条件がある物件は選択されないようにする」:
 *   「✨ 質の高い10件を選ぶ」ボタンが選ぶ物件（純関数）。
 *   - 候補: 未送信（送信済み・見送りは選ばない）・保存期間の切れていない物・判定が通す（か判定なし）で、判定の札に NG が1つも無い物
 *     （NG の見分けは property-brain.ngHitCodes＝今の判定の外す候補・保留の理由・書いた条件の ×・必須の ×。新しい語の一覧は作らない）
 *   - 並び: 画面と同じ1本の並び（合計＝判定の点＋画像の加点 → …・sortForReview）・👑 が候補なら先頭
 *   - max 件（AIX 物件ピックアップの上限 PICKUP_AIX_MAX＝10）まで。足りなくても NG の物件で埋めない
 *   返す物: 選んだ id・NG で除いた件数（未送信の物だけ数える）
 */
/*
 * 2026-09-28 竹内:
 *   ①「審査中と出ているのは物件ピックアップのチェックのところに入れない」→ 資料の現況が審査中・商談中の部屋は選ばない（dealExcluded に数える・NG が先）
 *   ②「新規のお客さんの物件ピックアップの際…AD1 の物件は入れない。AD1.5 以上で、更に AD2 以上が優先。AD2 以上で8件ない場合が AD1 も」
 *     → opts.firstProposal（まだ物件を1件もお送りしていないお客様の回）の時だけ、点の並びの後に AD の段で選ぶ（pickup-ad-priority.selectByAdPriority）。
 *       adExcluded＝点の順だけなら入っていたのに AD の段で外れた数。お送りした後の回（新着）は今まで通り点の順
 */
export type QualityPick = { ids: number[]; ngExcluded: number; dealExcluded: number; adExcluded: number; firstProposal: boolean };
export function pickQualityTop<T extends AixPickRow>(items: ReadonlyArray<T>, bestId?: number | null, max = PICKUP_AIX_MAX, opts: { firstProposal?: boolean } = {}): QualityPick {
  const base = items.filter((r) => r.status === "pending" && !r.expired);
  const isNg = (r: T) => r.verdict === "drop" || r.verdict === "hold" || ngHitCodes(r.reason_codes).length > 0;
  const notNg = base.filter((r) => !isNg(r));
  const ok = notNg.filter((r) => !dealStatusOf(r));
  const sorted = sortForReview(ok, bestId ?? null);
  const firstProposal = !!opts.firstProposal;
  if (!firstProposal) return { ids: sorted.slice(0, max).map((r) => r.id), ngExcluded: base.length - notNg.length, dealExcluded: notNg.length - ok.length, adExcluded: 0, firstProposal };
  const sel = selectByAdPriority(sorted, max);
  return { ids: sel.picked.map((r) => r.id), ngExcluded: base.length - notNg.length, dealExcluded: notNg.length - ok.length, adExcluded: sel.adSkipped.length, firstProposal };
}

/** ボタンの文字（「✨ 質の高い10件を選ぶ」・10件に足りない時は「✨ 質の高い9件を選ぶ」） */
export function qualityPickLabel(n: number): string {
  return `✨ 質の高い${n}件を選ぶ`;
}

/** 選んだ後の知らせ（「✨ 質の高い9件を選びました（NG 条件・保留の物件は選びません・3件）」） */
export function qualityPickMessage(picked: number, ngExcluded: number, max = PICKUP_AIX_MAX, extra: { dealExcluded?: number; adExcluded?: number } = {}): string {
  const ng = ngExcluded > 0 ? `NG 条件・保留の物件は選びません・${ngExcluded}件` : "";
  // 2026-09-28 審査中・商談中／新規のお客様の AD の段
  const deal = (extra.dealExcluded ?? 0) > 0 ? `審査中・商談中は選びません・${extra.dealExcluded}件` : "";
  const ad = (extra.adExcluded ?? 0) > 0 ? `新規のお客様は AD の高い物件を優先・AD1 など${extra.adExcluded}件を外しました` : "";
  const why = [ng, deal, ad].filter(Boolean).join("・");
  const short = picked < max ? `${max}件に足りません` : "";
  const tail = [short, why].filter(Boolean).join("・");
  return picked === 0
    ? `選べる物件がありません${why ? `（${why}）` : ""}`
    : `✨ 質の高い${picked}件を選びました${tail ? `（${tail}）` : ""}`;
}

/**
 * 詳細を開いた時の既定のチェック: まとめの回ごとに、点の高い順に PICKUP_AIX_MAX 件まで（それより下はチェックを外しておく）。
 * 2026-09-27 竹内「お客さんからの NG 条件がある物件は選択されないようにする」: 既定のチェックも「✨ 質の高い10件」と同じ（pickQualityTop・NG／保留は付けない）
 */
/**
 * 2026-09-28 opts.firstProposalSentAt: お客様へ一番最初に物件をお送りした時刻（null＝まだ・undefined＝分からない）。
 *   回（created_at）がそれより前なら「新規のお客様の回」＝AD の段で選ぶ（pickup-ad-priority.isFirstProposalRound）
 */
export function defaultAixChecks<T extends AixPickRow>(rounds: ReadonlyArray<{ items: ReadonlyArray<T>; created_at?: string | null }>, bestId?: number | null, max = PICKUP_AIX_MAX, opts: { firstProposalSentAt?: string | null } = {}): Record<number, boolean> {
  const out: Record<number, boolean> = {};
  for (const r of rounds) {
    const firstProposal = isFirstProposalRound(r.created_at, opts.firstProposalSentAt);
    const top = new Set(pickQualityTop(r.items, r.items.some((x) => x.id === bestId) ? bestId : null, max, { firstProposal }).ids);
    for (const it of r.items) out[it.id] = top.has(it.id);
  }
  return out;
}

/** 画面に出す短い言い方（REASON_JA より短く。無ければ REASON_JA） */
const CHIP_JA: Record<string, string> = {
  ALREADY_SENT: "送付済みの建物",
  RENT_OVER_130: "家賃が上限の3割超",
  RENT_OVER_110: "家賃が上限の1割超",
  RENT_SLIGHTLY_OVER: "家賃が上限を少し超過",
  RENT_ABOVE_USUAL: "いつもの家賃帯より高め",
  INITIAL_COST_NOT_ZERO: "敷金か礼金あり",
  INITIAL_COST_OVER_LIMIT: "敷礼が初期費用の上限超",
  FLOOR_PLAN_MISMATCH: "間取りが希望と違う",
  WALK_OVER: "徒歩が希望の1.5倍超",
  WALK_SLIGHTLY_OVER: "徒歩が希望を少し超過",
  BUILDING_AGE_OVER: "築年が希望超過",
  BUILDING_AGE_SLIGHTLY_OVER: "築年が希望を少し超過",
  PROFIT_NEGATIVE: "割引が AD より大きい",
  PET_NG: "ペット不可",
  ZERO_ZERO_MATCH: "敷礼0（希望に一致）",
  AD_COVERS_DISCOUNT: "AD で割引をまかなえる",
  // 2026-09-25 資料の表の募集の条件
  MOVE_IN_OK: "入居時期に間に合う",
  MOVE_IN_LATE: "入居が希望より遅い",
  MOVE_IN_UNKNOWN: "入居時期は要確認",
  CONTRACT_FIXED: "定期借家",
  FREE_RENT_MATCH: "フリーレント（希望に一致）",
  // 2026-09-25 家賃下限・間取りの「も可」・広さ・エリア・通勤
  RENT_BELOW_MIN: "家賃が下限よりかなり安い",
  // 2026-09-29 家賃の位置（property-brain RENT_BAND_RULE）
  RENT_UNDER_MIN: "家賃が下限未満",
  RENT_NEAR_MIN: "家賃が下限を少し下回る",
  RENT_BAND_UPPER: "家賃は上限寄り（相場に見合う）",
  RENT_BAND_MID: "家賃は上限の85〜90%",
  RENT_BAND_LOWER: "家賃は上限の80〜85%",
  RENT_BAND_LOW: "家賃が上限の8割未満（安すぎ）",
  RENT_TARGET_NEAR: "家賃が目安の額に近い",
  RENT_TARGET_MID: "家賃が目安の額から少し離れる",
  RENT_TARGET_FAR: "家賃が目安の額から離れる",
  FLOOR_PLAN_ALT_MATCH: "間取り「も可」の型",
  SQM_UNDER: "広さが希望の9割未満",
  SQM_UNKNOWN: "広さは要確認",
  // 2026-09-27 洋室の帖数（room-jo.ts）
  ROOM_JO_OK: "洋室の帖数が希望以上",
  ROOM_JO_NG: "洋室が希望の帖数より狭い",
  ROOM_JO_SOFT_NG: "洋室が希望の帖数（目安）より狭い",
  ROOM_JO_IMG_NG: "図の読みでは洋室が狭い（要確認）",
  ROOM_JO_UNKNOWN: "洋室の帖数は要確認",
  AREA_STATION_MATCH: "希望の駅",
  AREA_WARD_MATCH: "希望の区・市",
  AREA_LINE_MATCH: "希望の路線",
  AREA_NEAR: "希望エリアの近く（2km内）",
  AREA_CLOSE: "希望エリアに近い",
  AREA_FAR: "希望エリアから離れている",
  AREA_EXCLUDED: "希望外のエリア",
  AREA_UNKNOWN: "場所は要確認",
  COMMUTE_OK: "通勤が希望の時間内",
  COMMUTE_OVER: "通勤が希望の時間超",
  COMMUTE_UNKNOWN: "通勤は要確認",
  // 2026-09-25 竹内「広げて検索した場合も希望の方が少し高く・隣の駅だからって大幅に低くしない。家賃とかでもそう」:
  //   拡張の広げて検索の幅の内側（希望どおりより少しだけ低い加点）
  AREA_STATION_WIDE: "広げた検索の駅（希望の駅の隣）",
  AREA_STATION_2STOPS: "希望の駅から2駅",
  AREA_WARD_WIDE: "広げた検索の区（難波の3区）",
  RENT_WIDE: "広げた家賃の幅（上限＋5千/1万円）",
  FLOOR_PLAN_WIDE: "広げた間取り（LDK→DK）",
  BUILDING_AGE_WIDE: "広げた築年の幅（＋5年）",
  SQM_WIDE: "広げた広さの幅（−5㎡）",
  // 2026-09-25 監査（任務A・B）
  ALREADY_SENT_OTHER_ROOM: "同じ建物の別の部屋を送付済み",
  ALREADY_SENT_SAME_ROOM: "この部屋は送付済み（送り直し？）",
  FLOOR_PLAN_SAME_CLASS: "同じ広さの級（2DK↔1LDK）",
  FLOOR_PLAN_LARGER: "希望より広い間取り",
  AD_NONE: "AD なし",
  // 2026-09-25 案B（書いた条件だけ重く・全部合う・AD 1ヶ月未満）
  ZERO_ZERO_INFERRED: "敷礼0（送った物件から推した）",
  AGE_W5: "築5年以内（築浅の希望）", AGE_W10: "築10年以内（築浅の希望）", AGE_W15: "築15年以内（築浅の希望）", AGE_W_OLD: "築15年超（築浅の希望）",
  AGE_COL_W5: "築5年以内（希望の中でも新しい）", AGE_COL_W10: "築10年以内（希望の中でも新しい）", AGE_N5: "築5年以内", AGE_N10: "築10年以内",
  WALK_NEAR_W5: "徒歩5分以内（駅近の希望）", WALK_NEAR_W7: "徒歩7分以内（駅近の希望）", WALK_NEAR_N: "徒歩5分以内",
  WALK_TEXT_OK: "駅近の希望内", WALK_TEXT_OVER: "駅近の希望を超える", WALK_TEXT_FAR: "駅近の希望を大きく超える",
  RENT_CHEAP_W80: "家賃が上限の8割以下（安くしたい）", RENT_CHEAP_W90: "家賃が上限の9割以下（安くしたい）", RENT_CHEAP_W95: "家賃が上限の95%以下（安くしたい）",
  AD_UNDER_1M: "AD 1ヶ月未満",
  FIT_ALL: "書いた条件に全部合う", FIT_ALL_HALF: "書いた条件（2つ）に全部合う", FIT_ONE_MISS: "書いた条件の1つだけ外れ", FIT_ONE_MISS_HALF: "書いた条件（2つ）の1つだけ外れ",
};

/** 読めなかった材料（点が動かない理由）。コード → 札の言葉 */
const MISSING_JA: Record<string, string> = {
  RENT_UNKNOWN: "家賃", INITIAL_COST_UNKNOWN: "敷礼", AD_UNKNOWN: "AD", RENT_MAX_UNRELIABLE: "家賃上限",
};

export type ReasonChip = {
  code: string;
  label: string;
  /** 足し引きした点（0 は材料なし・知らせだけ） */
  points: number;
  /** drop＝外す理由・minus＝減点・plus＝加点・info＝知らせ（点なし） */
  tone: "drop" | "minus" | "plus" | "info";
};

export type ReasonView = {
  /** 外す・減点の理由（先に見せる）。外す理由（drop）が先頭 */
  minus: ReasonChip[];
  /** 加点 */
  plus: ReasonChip[];
  /** 読めなかった材料（「材料なし: 家賃・敷礼・AD」） */
  missing: string[];
  /** reason_codes に無い一文（同じ建物の省略 等）。reasons_ja のうちコードから作っていない物 */
  notes: string[];
  /** 50 ＋ 合計（上限前）。reason_codes が無い古い行は null */
  rawTotal: number | null;
};

/** 外す（drop）にするコード（judgeProperty の "drop" と同じ） */
const DROP_CODES = new Set(["ALREADY_SENT", "RENT_OVER_130", "ROOM_JO_NG"]);

/**
 * 1件の理由の見え方。reason_codes（判定のコード）から点の内訳を作る。
 * reason_codes が無い古い行は reasons_ja をそのまま知らせ（info）として返す。
 */
export function buildReasonView(row: { reason_codes?: string[] | null; reasons_ja?: string[] | null }): ReasonView {
  const codes = row.reason_codes ?? null;
  const ja = row.reasons_ja ?? [];
  const view: ReasonView = { minus: [], plus: [], missing: [], notes: [], rawTotal: null };
  if (!codes || codes.length === 0) {
    view.notes = ja.slice();
    return view;
  }
  const fromCodes = new Set<string>();
  let total = BASE_SCORE;
  for (const code of codes) {
    const p = reasonPoints(code);
    total += p;
    const label = CHIP_JA[code] ?? reasonJa(code);
    fromCodes.add(reasonJa(code));
    if (MISSING_JA[code]) { view.missing.push(MISSING_JA[code]); continue; }
    if (p < 0) view.minus.push({ code, label, points: p, tone: DROP_CODES.has(code) ? "drop" : "minus" });
    else if (p > 0) view.plus.push({ code, label, points: p, tone: "plus" });
    else view.minus.push({ code, label, points: 0, tone: "info" });
  }
  // 外す理由 → 減点の大きい順 → 知らせ
  const w = (c: ReasonChip) => (c.tone === "drop" ? 0 : c.tone === "minus" ? 1 : 2);
  view.minus.sort((a, z) => (w(a) - w(z)) || (a.points - z.points));
  view.plus.sort((a, z) => z.points - a.points);
  view.notes = ja.filter((s) => !fromCodes.has(s));
  view.rawTotal = total;
  return view;
}

/** 点の内訳の1行（「基準50 −30 送付済みの建物 ＋15 間取り一致 ＝ 35」）。コードが無ければ空 */
export function formatScoreBreakdown(v: ReasonView, score: number | null): string {
  if (v.rawTotal == null) return "";
  const parts = [...v.minus.filter((c) => c.points !== 0), ...v.plus].map((c) => `${c.points > 0 ? "＋" : "−"}${Math.abs(c.points)} ${c.label}`);
  const clamp = score != null && score !== v.rawTotal ? `（上限・下限で ${score}）` : "";
  return `基準${BASE_SCORE}${parts.length ? " " + parts.join(" ") : ""} ＝ ${v.rawTotal}${clamp}`;
}
