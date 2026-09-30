// app/lib/ad-under1-policy.ts（純関数・画面・サーバー・監査で共用。import は無し＝property-brain からも使える）
// AD（広告料）1ヶ月未満の物件の扱いを決める1か所の表。
//
// 2026-09-30 竹内「AD1未満の物件は基本的に送らない。家賃10万で AD0.5 等 売上5万以上ある場合で、他に物件ない場合や
//   お客さんにしばらく新着物件送れていない人などは送っても良い。しかし 1K の AD1未満はきほんおくらない」
//   → AD が1ヶ月未満の物件は、次の3つを全部満たす時だけ「送ってよい側」（"fallback"）。それ以外は「送らない側」（"never"）:
//       ① 売上（家賃 × AD の月数。AD が円で読めている時はその円）が 5万円以上
//       ② 間取りが 1K（1R・ワンルームも同じ扱い）でない
//       ③ 他に送れる物件が無い、または、そのお客様にしばらく新着物件を送れていない（③は選ぶ側の決まり＝pickup-review-order.pickQualityTop）
//   スタッフが手で選んで送るのは止めない（AIX に渡す前に確かめる＝pickup-review-order.adUnder1ConfirmMessage）。
//
// 迷った時の向き（誤って外さない）:
//   ・売上が読めない（家賃も円も無い）・間取りが読めない物は "never" にしない（"fallback"＝保留のまま）。"never" は確かな時だけ
//   ・AD が読めない（AD_UNKNOWN）・アズ・スタットの 200% みなしは対象外（"na"）
//   ・AD なし（資料に「広告費 なし」＝0）は売上 0 なので "never"（札は今まで通り AD_NONE）

/** 売上（円）の線。これ未満は送らない側 */
export const AD_UNDER1_MIN_SALES_YEN = 50_000;

/**
 * 「しばらく新着を送れていない」の日数の線（お客様へ届けた最後のご提案の送付から）。
 * 2026-09-30 自動検索の「止まっている」（送付が ACTIVE_DAYS=7 日以内なら動いている＝8日以上ないと止まっている・auto-search-plan）と同じ線。
 *   実データ（scripts/audit-ad-under1.ts の C・D の節）: 回が届いた時点の最後の送付からの日数は 〜1日 11・1〜3日 18・3〜5日 8・5〜7日 12・7〜10日 16・10〜14日 17・14日以上 24・一度も無し 18（124回）。
 *   線を 3日〜14日で動かしても穴埋めが入る回は 4〜2回（穴埋め候補のある回 8回のうち）＝日数はほとんど効かない → 別の「止まっている」の物差しを作らず自動検索と揃える
 */
export const AD_UNDER1_STALE_DAYS = 8;

export type AdUnder1Policy = "never" | "fallback" | "na";

export type AdUnder1Input = {
  adMonths?: number | null;
  /** 表に円で書いてある AD（無ければ null） */
  adYen?: number | null;
  rentYen?: number | null;
  floorPlan?: string | null;
};

export type AdUnder1Result = {
  policy: AdUnder1Policy;
  /** AD の月数（円だけの時は家賃で直した物）。読めなければ null */
  months: number | null;
  /** 売上（円）。読めなければ null */
  salesYen: number | null;
  oneRoom: boolean;
  /** 画面・監査に出す一言（na は空） */
  why: string;
};

/** 1K・1R・ワンルーム（1SK も 1K 扱い＝normalizeFloorPlanToken と同じ）。読めない間取りは false */
export function isOneRoomPlan(floorPlan: string | null | undefined): boolean {
  const t = String(floorPlan ?? "").normalize("NFKC").toUpperCase().replace(/\s+/g, "");
  if (!t) return false;
  if (/ワンルーム|1ルーム/.test(t)) return true;
  return /^1(?:SK|K|R)$/.test(t);
}

/** AD の月数（月数があればそれ・無ければ 円÷家賃）。読めなければ null */
export function adMonthsOf(i: AdUnder1Input): number | null {
  if (i.adMonths != null) return i.adMonths;
  if (i.adYen != null && i.rentYen) return i.adYen / i.rentYen;
  return null;
}

/** 売上（円）。円があればそれ・無ければ 家賃 × 月数（管理費は含めない＝property-brain.computeAdYen と同じ）。読めなければ null */
export function adSalesYen(i: AdUnder1Input): number | null {
  if (i.adYen != null) return i.adYen;
  if (i.adMonths != null && i.rentYen != null) return Math.round(i.adMonths * i.rentYen);
  return null;
}

/**
 * AD 1ヶ月未満の扱い。
 *   "na"       … AD が1ヶ月以上／読めない（対象外）
 *   "never"    … 送らない側（1K・1R、または売上が 5万円未満と分かっている）
 *   "fallback" … 売上 5万円以上（か売上が読めない）で 1K でない＝他に送れる物件が無い時・しばらく送れていない時だけ
 * 0.01 の余裕は judgeProperty の段（AD 250%→2.5 の丸め・円÷家賃の端数）と同じ
 */
export function adUnder1Policy(i: AdUnder1Input): AdUnder1Result {
  const months = adMonthsOf(i);
  const salesYen = adSalesYen(i);
  const oneRoom = isOneRoomPlan(i.floorPlan);
  const res = (policy: AdUnder1Policy, why: string): AdUnder1Result => ({ policy, months, salesYen, oneRoom, why });
  if (months == null || months + 0.01 >= 1) return res("na", "");
  if (oneRoom) return res("never", `1K の AD1未満（売上${salesYen != null ? yenText(salesYen) : "不明"}）`);
  if (salesYen != null && salesYen < AD_UNDER1_MIN_SALES_YEN) return res("never", `売上${yenText(salesYen)}（5万円未満）`);
  return res("fallback", salesYen != null ? `売上${yenText(salesYen)}（5万円以上）` : "売上は読めない（家賃・AD の円が無い）");
}

function yenText(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000) / 10}万円` : `${n}円`;
}

// ── 判定の札 ────────────────────────────────────────────────────────────────
/** 送らない側（外す候補＝DROP_REASON_CODES）。点は AD_UNDER_1M と同じ −30 */
export const AD_UNDER1_NEVER_CODE = "AD_UNDER_1M_NEVER";
/** 他に無い時・しばらく送れていない時だけ（保留＝HOLD_REASON_CODES）。点は AD_UNDER_1M と同じ −30 */
export const AD_UNDER1_FALLBACK_CODE = "AD_UNDER_1M_FALLBACK";
/** 2026-09-30 より前の行の札（1K・売上の区別なし・保留）。保存済みの行を付け直さない間は残る */
export const AD_UNDER1_LEGACY_CODE = "AD_UNDER_1M";

/** 政策 → 判定の札（na は null） */
export function adUnder1CodeFor(p: AdUnder1Policy): string | null {
  return p === "never" ? AD_UNDER1_NEVER_CODE : p === "fallback" ? AD_UNDER1_FALLBACK_CODE : null;
}

/** AD 1ヶ月未満・AD なしの札か（旧の AD_UNDER_1M・新しい 2つ・AD_NONE。_HELD は付かない札だが付いても同じに見る） */
export function isAdUnder1Code(code: string): boolean {
  return /^(?:AD_UNDER_1M(?:_NEVER|_FALLBACK)?|AD_NONE)(?:_HELD)?$/.test(String(code ?? ""));
}

/**
 * 札の並びから、その行の AD 1ヶ月未満の扱いを読む（画面・選び方はこれだけを見る）:
 *   "never"（AD_UNDER_1M_NEVER・AD_NONE）／"fallback"（AD_UNDER_1M_FALLBACK）／"legacy"（旧の AD_UNDER_1M＝どちらか分からない・送らない側のまま）／null（AD1未満でない）
 */
export function adUnder1KindOfCodes(codes: ReadonlyArray<string> | null | undefined): "never" | "fallback" | "legacy" | null {
  const set = new Set((codes ?? []).map((c) => String(c).replace(/_HELD$/, "")));
  if (set.has(AD_UNDER1_NEVER_CODE) || set.has("AD_NONE")) return "never";
  if (set.has(AD_UNDER1_FALLBACK_CODE)) return "fallback";
  if (set.has(AD_UNDER1_LEGACY_CODE)) return "legacy";
  return null;
}

// ── しばらく送れていないか ──────────────────────────────────────────────────
/**
 * そのお客様に「しばらく新着を送れていない」か。lastSentAt＝お客様へ届けた最後のご提案の送付（isProposalSend を通した物）。
 *   null（一度も送っていない）・undefined（分からない）・日時が読めない → false（＝「他に無い時だけ」に倒す）
 *   一度も送っていない新規のお客様は「送れていない」ではなく、選び方は新規の決まり（pickup-ad-priority）と「他に無い時」で見る
 */
export function isStaleForAdUnder1(roundCreatedAt: string | null | undefined, lastSentAt: string | null | undefined, staleDays: number = AD_UNDER1_STALE_DAYS): boolean {
  if (!lastSentAt) return false;
  const last = Date.parse(lastSentAt);
  const at = Date.parse(String(roundCreatedAt ?? ""));
  const base = Number.isFinite(at) ? at : Date.now();
  if (!Number.isFinite(last)) return false;
  return base - last >= staleDays * 86_400_000;
}
