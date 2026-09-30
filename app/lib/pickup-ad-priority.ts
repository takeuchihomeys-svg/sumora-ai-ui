// app/lib/pickup-ad-priority.ts（純関数・画面とサーバーと監査で共用。サーバーの部品は import しない）
// ピックアップの「選び方」の決まり（点の並びとは別の段）: ①資料の現況が審査中・商談中の部屋は選ばない ②新規のお客様は AD の高い物件を優先する。
//
// 2026-09-28 竹内（未桜さんの売上サポのスクショ・ファステート難波SOUTHベック 306＝資料の現況の欄に赤い判子「商談中」・#787 pass 162点・既定でチェックが付いていた）:
//   「審査中と出ているのは物件ピックアップのチェックのところに入れない」（9/27 に「商談中は審査中と同じ」と決めている）
//   → 既定のチェック・「✨ 質の高い10件」・10件に絞る時の並びから外す（手で1件ずつチェックするのは可・AIX に渡す前に確かめる）。
//     現況は資料の文字（listing-deal-status.ts）で読む。保存の 1,219行で terms.evidence.moveIn と pdf_text の読みは 154行すべて一致（9/29）。
//     判子が画像だけで文字の無い資料（pdf_has_text=false かつ evidence なし）は 15行あり、今は読めない（画像の読み取りは足していない＝未決）
//
// 2026-09-28 竹内「新規のお客さんの物件ピックアップの際、他にオススメできる条件の物件が10件ある場合、AD1 の物件は入れない。
//   AD1.5 以上で、更に AD2 以上が優先。AD2 以上で8件ない場合が AD1 もピックアップに入れていく。これはスコアリングの基準とは別に、
//   AD が低いのを入れるとその物件で決まると利益が低いため入れない形。物件探していて条件がないお客さん等に対しての新着物件の場合等なら必要となる」
//   決まり（竹内さんの文のまま読んだ形・selectByAdPriority）:
//     - 対象は「新規のお客様」＝まだ物件を1件も直接お送りしていないお客様の回（isFirstProposalRound）。
//       お送りした後の回（新着便・条件に合う物件が少ないお客様の新着）は対象外＝今まで通り点の順
//     - 候補（通す・NG なし・審査中/商談中でない）を AD の段に分け、AD2 以上 → AD1.5 → AD1 の順に10件まで埋める
//     - AD1（と AD 不明）を足すのは「AD2 以上が8件に満たない」時だけ（AD2_ENOUGH）。AD2 以上が8件以上なら、10件に足りなくても AD1 では埋めない
//     - 段の中は点の並び（合計＝判定の点＋画像の加点・sortForReview）のまま。段は点とは別に決める（点の重みは変えない）
//     - アズ・スタットの AD 200% みなし（AD_ASSUMED_AGENT＋AD_HIGH）は AD2 として扱う
//     - AD 1ヶ月未満・AD なしは既に「保留」（HOLD）で候補に入らない
//   解釈が割れる所（竹内さんに確認中）: AD 不明（資料に AD が読めない）を AD1 と同じ段にした／👑（点の1位）も AD の段で外れうる

/** AD の段。ad2＝2ヶ月（200%）以上・ad15＝1.5ヶ月以上2ヶ月未満・ad1＝1ヶ月以上1.5ヶ月未満・low＝1ヶ月未満/なし・unknown＝読めない */
export type PickupAdTier = "ad2" | "ad15" | "ad1" | "low" | "unknown";

/** 新規のお客様で「AD2 以上がこの件数あれば AD1 は足さない」（竹内「AD2以上で8件ない場合が AD1 もピックアップに入れていく」） */
export const AD2_ENOUGH = 8;

/**
 * 判定の札（reason_codes）から AD の段を決める。札は judgeProperty が AD の月数（円は家賃で月数に直した物）から付ける:
 *   AD_1M＝1〜2ヶ月・AD_1_5M＝1.5〜2ヶ月（AD_1M と一緒に付く）・AD_HIGH＝2ヶ月以上・AD_2_5M/AD_VERY_HIGH＝2.5/3ヶ月以上。
 *   保留・外す候補の行は同じ札に _HELD が付く（点は0・段は同じ）
 */
export function pickupAdTier(codes: ReadonlyArray<string> | null | undefined): PickupAdTier {
  const set = new Set((codes ?? []).map((c) => String(c).replace(/_HELD$/, "")));
  if (set.has("AD_HIGH") || set.has("AD_2_5M") || set.has("AD_VERY_HIGH") || set.has("AD_ASSUMED_AGENT")) return "ad2";
  if (set.has("AD_1_5M")) return "ad15";
  if (set.has("AD_1M")) return "ad1";
  if (set.has("AD_UNDER_1M") || set.has("AD_UNDER_1M_NEVER") || set.has("AD_UNDER_1M_FALLBACK") || set.has("AD_NONE")) return "low";
  return "unknown";
}

/** 画面・知らせに出す短い名前 */
export const AD_TIER_JA: Record<PickupAdTier, string> = { ad2: "AD2以上", ad15: "AD1.5", ad1: "AD1", low: "AD1未満", unknown: "AD不明" };

export type AdPriorityResult<T> = {
  /** 選んだ行（元の並び＝点の並びのまま） */
  picked: T[];
  /** 点の順だけなら max 件に入っていたのに、AD の段で外れた行（AD1・AD 不明） */
  adSkipped: T[];
  /** AD1 を足してよかったか（AD2 以上が AD2_ENOUGH 件に満たない） */
  lowAllowed: boolean;
  /** 候補の段ごとの数 */
  tiers: Record<PickupAdTier, number>;
};

/**
 * 新規のお客様の選び方。sorted は既に点の並び（sortForReview）の候補（通す・NG なし・審査中/商談中でない・未送信）。
 * AD2 以上 → AD1.5 → （AD2 以上が enough 件に満たない時だけ）AD1・AD 不明 の順に max 件まで。返す picked は元の並びのまま
 */
export function selectByAdPriority<T extends { reason_codes?: ReadonlyArray<string> | null }>(
  sorted: ReadonlyArray<T>, max: number, enough: number = AD2_ENOUGH,
): AdPriorityResult<T> {
  const tiers: Record<PickupAdTier, number> = { ad2: 0, ad15: 0, ad1: 0, low: 0, unknown: 0 };
  const tierOf = new Map<T, PickupAdTier>();
  for (const r of sorted) { const t = pickupAdTier(r.reason_codes); tierOf.set(r, t); tiers[t]++; }
  const lowAllowed = tiers.ad2 < enough;
  const order: PickupAdTier[][] = [["ad2"], ["ad15"], ...(lowAllowed ? [["ad1", "unknown", "low"] as PickupAdTier[]] : [])];
  const chosen = new Set<T>();
  for (const group of order) {
    for (const r of sorted) {
      if (chosen.size >= max) break;
      if (group.includes(tierOf.get(r)!)) chosen.add(r);
    }
  }
  const picked = sorted.filter((r) => chosen.has(r));
  const adSkipped = sorted.slice(0, max).filter((r) => !chosen.has(r));
  return { picked, adSkipped, lowAllowed, tiers };
}

// ── 新規のお客様か（まだ物件を直接お送りしていない回か）──────────────────────────────
/** sent_properties の1行（channel・delivery・source・sent_at） */
export type SentLite = { sent_at: string | null; channel?: string | null; delivery?: string | null; source?: string | null };

/**
 * お客様へ物件を「ご提案として」お送りした行か。
 *   - グループ共有だけ（delivery=shared・旧の line_group）は数えない（お客様に届いていない）
 *   - 物件確認（check）・見積書（estimate）はお客様が持ってきた物件への返事なので数えない
 *   - channel の無い古い行（source=vision＝スタッフが送った物件画像を読んだ行・8月以降 1,613行）は数える
 */
export function isProposalSend(s: SentLite): boolean {
  const shared = s.delivery === "shared" || (s.delivery == null && s.source === "line_group");
  if (shared) return false;
  if (s.channel === "check" || s.channel === "estimate") return false;
  if (s.source === "aix:property_check_result" || s.source === "aix:estimate_sheet") return false;
  return true;
}

/** 一番最初にお客様へ物件をご提案した時刻（無ければ null＝まだ1件も送っていない） */
export function firstProposalSentAt(sends: ReadonlyArray<SentLite>): string | null {
  let best: number | null = null;
  let bestIso: string | null = null;
  for (const s of sends) {
    if (!s.sent_at || !isProposalSend(s)) continue;
    const ms = Date.parse(s.sent_at);
    if (!Number.isFinite(ms)) continue;
    if (best == null || ms < best) { best = ms; bestIso = s.sent_at; }
  }
  return bestIso;
}

/**
 * お客様へ届けた一番最近のご提案の送付の時刻（無ければ null＝一度も無い）。
 * 2026-09-30 竹内「お客さんにしばらく新着物件送れていない人」（AD1未満の穴埋めの条件・ad-under1-policy.isStaleForAdUnder1）。
 *   グループ共有（shared）・物件確認・見積書は数えない（isProposalSend）。last_property_sent_at は自動検索で書き換わるので使わない
 */
export function lastProposalSentAt(sends: ReadonlyArray<SentLite>): string | null {
  let best: number | null = null;
  let bestIso: string | null = null;
  for (const s of sends) {
    if (!s.sent_at || !isProposalSend(s)) continue;
    const ms = Date.parse(s.sent_at);
    if (!Number.isFinite(ms)) continue;
    if (best == null || ms > best) { best = ms; bestIso = s.sent_at; }
  }
  return bestIso;
}

/**
 * その回が「新規のお客様のピックアップ」か: 回が届いた時点で、まだ物件を1件もお送りしていない。
 *   firstSentAt が undefined（分からない・古い画面）の時は対象外（今まで通り）にする
 */
export function isFirstProposalRound(roundCreatedAt: string | null | undefined, firstSentAt: string | null | undefined): boolean {
  if (firstSentAt === undefined) return false;
  if (firstSentAt === null) return true;
  const r = Date.parse(String(roundCreatedAt ?? ""));
  const f = Date.parse(firstSentAt);
  if (!Number.isFinite(r) || !Number.isFinite(f)) return false;
  return r < f;
}
