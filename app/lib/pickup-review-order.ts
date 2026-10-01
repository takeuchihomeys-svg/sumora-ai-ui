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
// 2026-09-30 竹内「AD1未満の物件は基本的に送らない…他に物件ない場合や、しばらく新着物件送れていない人は送っても良い」（純関数）
import { adUnder1KindOfCodes, isStaleForAdUnder1, AD_UNDER1_FALLBACK_CODE } from "./ad-under1-policy";
import { PICKUP_AIX_MAX } from "./pickup-aix-handoff";
import { compareOverall } from "./pickup-best";
// 2026-09-28 竹内「審査中と出ているのは物件ピックアップのチェックのところに入れない」「新規のお客さんは AD1 を入れない・AD2 以上を優先」（純関数）
import { listingDealStatus } from "./listing-deal-status";
import { selectByAdPriority, isFirstProposalRound } from "./pickup-ad-priority";
// 2026-09-30 v2.5.42 竹内「一度送った物件はお客さんごとに再度送らないようにする」: 拡張の sent-skip と同じ完全一致（建物名＋号室）
import { buildSentRoomIndex, pickSentRooms } from "./sent-room-match";
import { isCustomerRow } from "./sent-delivery";

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
  /** 2026-09-30 v2.5.42 送付済みの部屋の照合（建物名＋号室の完全一致） */
  property_name?: string | null; room_no?: string | null; room_text?: string | null;
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
  // 2026-09-30 審査中・商談中は確認でなく送れない（underReviewBlockMessage が先に止める）。ここに来る行は無い（null）＝呼び出しの形だけ残す
  const deal = rows.map((r) => ({ r, st: dealStatusOf(r) })).filter((x) => x.st && x.st !== "審査中" && x.st !== "商談中");
  if (deal.length === 0) return null;
  const names = deal.map(({ r, st }) => `${r.property_name ?? ""}${r.room_no ? ` ${r.room_no}` : ""}：${st}`).join("、");
  return `資料の現況が商談中の物件が${deal.length}件入っています（${names}）。このまま AIX に渡しますか？`;
}

/**
 * 2026-09-30 竹内「審査中の物件送らない。確認する」（YUMA のテストで FEEL UMEDA 202＝資料の現況「審査中」をオススメとして送った）:
 *   手でチェックした審査中の部屋は AIX に渡さない（確認の「OK」で送れる形をやめた）。止める文を返す（無ければ null）。
 *   9/28 の「手で選んだ時は確認つきで渡せる」は、審査中については上書き（商談中は今まで通り dealConfirmMessage の確認）。
 *   サーバー側の2枚目の壁は /api/aix/action（pickup_ids の行の資料を pickupDealStatus で読む）
 */
export function underReviewBlockMessage(rows: ReadonlyArray<Pick<AixPickRow, "deal_status" | "terms"> & { property_name?: string | null; room_no?: string | null }>): string | null {
  // 同日 竹内「1から4全てその提案通り」: 商談中も審査中と同じく送れない（9/27「商談中は審査中と同じ」）
  const hit = rows.map((r) => ({ r, st: dealStatusOf(r) })).filter((x) => x.st === "審査中" || x.st === "商談中");
  if (hit.length === 0) return null;
  const names = hit.slice(0, 5).map(({ r, st }) => `${r.property_name ?? ""}${r.room_no ? ` ${r.room_no}` : ""}：${st}`).join("、");
  return `資料の現況が審査中・商談中の物件は送れません（${names}${hit.length > 5 ? " ほか" : ""}）。チェックを外してから送ってください`;
}

/**
 * 2026-09-30 竹内「AD1未満の物件は基本的に送らない」: 手で選んだ AD1ヶ月未満の物件を AIX に渡す前に確かめる文（無ければ null＝確かめない）。
 *   審査中・商談中の確認（dealConfirmMessage）と同じ形。スタッフが意図して送るのは止めない（「OK」で送れる）＝止めるのは既定の選び方だけ。
 *   "never"（1K・売上5万円未満・AD なし）と "fallback"（売上5万円以上）で言い方を分ける。旧の札（AD_UNDER_1M）も AD1未満として出す
 */
export function adUnder1ConfirmMessage(rows: ReadonlyArray<{ reason_codes?: ReadonlyArray<string> | null; property_name?: string | null; room_no?: string | null }>): string | null {
  const hit = rows.map((r) => ({ r, k: adUnder1KindOfCodes(r.reason_codes) })).filter((x) => x.k);
  if (hit.length === 0) return null;
  const word = (k: "never" | "fallback" | "legacy" | null) => (k === "fallback" ? "AD1未満（売上5万円以上）" : k === "never" ? "AD1未満（1K か売上5万円未満）" : "AD1未満");
  const names = hit.slice(0, 5).map(({ r, k }) => `${r.property_name ?? ""}${r.room_no ? ` ${r.room_no}` : ""}：${word(k)}`).join("、");
  return `AD が1ヶ月未満の物件が${hit.length}件入っています（${names}${hit.length > 5 ? " ほか" : ""}）。AD1未満は基本的に送らない決まりです。このまま AIX に渡しますか？`;
}

/**
 * 点の高い順（画面の並び sortForReview と同じ・👑 を先頭）に max 件まで選ぶ。
 * 2026-09-26 竹内のスクショ「AIX物件ピックアップ（20件）」: リアプロの一括が 2件ずつ7回に分かれて届いた回（20件・外す候補 0）で、
 *   既定のチェックが「未確認で外す候補以外 全部」＝20件になり、押すと「10件までにしてください」で止まっていた。
 */
export function pickTopForAix<T extends AixPickRow>(items: ReadonlyArray<T>, bestId?: number | null, max = PICKUP_AIX_MAX): number[] {
  // 2026-09-28 手でチェックした審査中・商談中の部屋は、絞る時に一番後ろ（先に外れる）
  const cand = items.filter(aixCandidate);
  // 2026-09-30 AD1ヶ月未満の物件も手で選んだ時は残すが、絞る時は審査中・商談中の前・ほかの後ろ（先に外れる）
  const low = cand.filter((r) => !dealStatusOf(r) && adUnder1KindOfCodes(r.reason_codes) != null);
  const open = cand.filter((r) => !dealStatusOf(r) && adUnder1KindOfCodes(r.reason_codes) == null), deal = cand.filter((r) => dealStatusOf(r));
  return [...sortForReview(open, bestId ?? null), ...sortForReview(low, bestId ?? null), ...sortForReview(deal, bestId ?? null)].slice(0, max).map((r) => r.id);
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
/** 送った記録（詳細 API の sent_history の1行・pickup-sent-badge と同じ出所） */
export type SentHistLite = { property_name: string | null; room_no: string | null; delivery?: string | null; source?: string | null; channel?: string | null; sent_at?: string | null };

/**
 * 2026-09-30 v2.5.42 竹内「画面監視して、一度送った物件はお客さんごとに再度送らないようにする形で」:
 *   そのお客様に**届けた**（★物件出し★への共有は除く）部屋と、建物名＋号室が完全に同じ行（拡張 sent-skip.js と同じ線・sent-room-match）。
 *   同じ建物の別の部屋・号室の読めない行は入れない（迷ったら外さない）。status=sent の行（この売上サポから送った印）は元から別扱い
 */
export function sentBeforeIds<T extends Pick<AixPickRow, "id" | "status" | "property_name" | "room_no" | "room_text">>(items: ReadonlyArray<T>, history: ReadonlyArray<SentHistLite> | null | undefined): Set<number> {
  const rows = (history ?? []).filter((h) => h && isCustomerRow({ delivery: h.delivery ?? null, source: h.source ?? null } as never));
  if (!rows.length) return new Set();
  const idx = buildSentRoomIndex(rows);
  return new Set(pickSentRooms(items.filter((it) => it.status !== "sent"), idx).map((it) => it.id));
}

/**
 * 手で選んだ行に送付済みの部屋（完全一致）か送信済みの印の行があれば、AIX に渡す前に確かめる文（無ければ null）。
 *   スタッフが意図して送り直す時は「OK」で送れる（止めるのは既定の選び方だけ）
 */
export function sentConfirmMessage<T extends Pick<AixPickRow, "id" | "status" | "property_name" | "room_no" | "room_text">>(rows: ReadonlyArray<T>, history: ReadonlyArray<SentHistLite> | null | undefined): string | null {
  const before = sentBeforeIds(rows, history);
  const hit = rows.filter((r) => before.has(r.id) || r.status === "sent");
  if (!hit.length) return null;
  const names = hit.slice(0, 5).map((r) => `${r.property_name ?? ""}${(r.room_no ?? r.room_text) ? ` ${r.room_no ?? r.room_text}` : ""}`).join("、");
  return `このお客様に送付済みの部屋が${hit.length}件入っています（${names}${hit.length > 5 ? " ほか" : ""}）。もう一度送りますか？`;
}

/**
 * 2026-09-30 竹内「AD1未満の物件は基本的に送らない。売上5万以上ある場合で、他に物件ない場合や、お客さんにしばらく新着物件送れていない人などは送っても良い。
 *   しかし 1K の AD1未満はきほんおくらない」:
 *   ・AD1未満のうち "never"（AD_UNDER_1M_NEVER＝1K か売上5万円未満・AD_NONE）と旧の AD_UNDER_1M は既定の候補に入れない（外す候補・保留のまま）
 *   ・"fallback"（AD_UNDER_1M_FALLBACK＝売上5万円以上で 1K でない）は、他の条件に外れが無く（AD の低さだけが保留の理由）、
 *     ①ほかに選べる物件が1件も無い時 ②そのお客様にしばらく新着を送れていない時（opts.staleSinceLastSend）だけ、通常の候補の後ろに足す
 *   ・「AD の低さだけが保留の理由」= 他の保留・外す候補・NG の札が無く、AD の −30 が無ければ通す線（40点）を超える点
 */
const FALLBACK_AD_PENALTY = Math.abs(reasonPoints(AD_UNDER1_FALLBACK_CODE));
export function isAdUnder1FallbackRow(r: { verdict?: string | null; score?: number | null; reason_codes?: ReadonlyArray<string> | null }): boolean {
  if (adUnder1KindOfCodes(r.reason_codes) !== "fallback") return false;
  if (r.verdict === "drop" || ngHitCodes(r.reason_codes).length > 0) return false;
  return r.score != null && r.score + FALLBACK_AD_PENALTY >= 40;
}

export type QualityPick = { ids: number[]; ngExcluded: number; dealExcluded: number; adExcluded: number; firstProposal: boolean; sentExcluded?: number;
  /** AD1未満で選ばなかった件数（never・旧の札・穴埋めに入らなかった fallback） */
  adUnder1Excluded?: number;
  /** AD1未満（売上5万円以上）を穴埋めで入れた件数と理由（no_other＝ほかに選べる物件が無い・stale＝しばらく送れていない） */
  adUnder1Filled?: number; adUnder1FillWhy?: "no_other" | "stale" | null };
export function pickQualityTop<T extends AixPickRow>(items: ReadonlyArray<T>, bestId?: number | null, max = PICKUP_AIX_MAX, opts: { firstProposal?: boolean; sentBefore?: ReadonlySet<number> | null; staleSinceLastSend?: boolean } = {}): QualityPick {
  // 2026-09-30 v2.5.42 送付済みの部屋（別の回で届けた同じ部屋）は既定の候補に入れない
  const sentSet = opts.sentBefore ?? null;
  const all = items.filter((r) => r.status === "pending" && !r.expired);
  const base = sentSet && sentSet.size ? all.filter((r) => !sentSet.has(r.id)) : all;
  const sentExcluded = all.length - base.length;
  const isNg = (r: T) => r.verdict === "drop" || r.verdict === "hold" || ngHitCodes(r.reason_codes).length > 0;
  const notNg = base.filter((r) => !isNg(r));
  const ok = notNg.filter((r) => !dealStatusOf(r));
  const sorted = sortForReview(ok, bestId ?? null);
  const firstProposal = !!opts.firstProposal;
  let ids: number[]; let adExcluded = 0;
  if (!firstProposal) ids = sorted.slice(0, max).map((r) => r.id);
  else { const sel = selectByAdPriority(sorted, max); ids = sel.picked.map((r) => r.id); adExcluded = sel.adSkipped.length; }
  // AD1未満（売上5万円以上）の穴埋め: ほかに1件も選べない時か、しばらく送れていない時だけ・通常の候補の後ろ（点の順）
  const lowAll = base.filter((r) => adUnder1KindOfCodes(r.reason_codes) != null && isNg(r));
  const pool = sortForReview(lowAll.filter((r) => isAdUnder1FallbackRow(r) && !dealStatusOf(r)), bestId ?? null);
  const fillWhy: "no_other" | "stale" | null = pool.length === 0 || ids.length >= max ? null : ids.length === 0 ? "no_other" : opts.staleSinceLastSend ? "stale" : null;
  const filled = fillWhy ? pool.slice(0, max - ids.length) : [];
  if (filled.length) ids = [...ids, ...filled.map((r) => r.id)];
  // 数え方: AD の低さだけで外れた行（AD1未満の札があり、ほかの NG が無い）は adUnder1Excluded に分け、NG・保留の件数（ngExcluded）に混ぜない
  const adOnly = lowAll.filter((r) => ngHitCodes(r.reason_codes).length === 0);
  const ngExcluded = (base.length - notNg.length) - adOnly.length;
  return { ids, ngExcluded, dealExcluded: notNg.length - ok.length, adExcluded, firstProposal, sentExcluded,
    adUnder1Excluded: adOnly.length - filled.length, adUnder1Filled: filled.length, adUnder1FillWhy: filled.length ? fillWhy : null };
}

/** ボタンの文字（「✨ 質の高い10件を選ぶ」・10件に足りない時は「✨ 質の高い9件を選ぶ」） */
export function qualityPickLabel(n: number): string {
  return `✨ 質の高い${n}件を選ぶ`;
}

/** 選んだ後の知らせ（「✨ 質の高い9件を選びました（NG 条件・保留の物件は選びません・3件）」） */
export function qualityPickMessage(picked: number, ngExcluded: number, max = PICKUP_AIX_MAX, extra: { dealExcluded?: number; adExcluded?: number; sentExcluded?: number;
  adUnder1Excluded?: number; adUnder1Filled?: number; adUnder1FillWhy?: "no_other" | "stale" | null } = {}): string {
  const ng = ngExcluded > 0 ? `NG 条件・保留の物件は選びません・${ngExcluded}件` : "";
  // 2026-09-28 審査中・商談中／新規のお客様の AD の段
  const deal = (extra.dealExcluded ?? 0) > 0 ? `審査中・商談中は選びません・${extra.dealExcluded}件` : "";
  const ad = (extra.adExcluded ?? 0) > 0 ? `新規のお客様は AD の高い物件を優先・AD1 など${extra.adExcluded}件を外しました` : "";
  const sent = (extra.sentExcluded ?? 0) > 0 ? `送付済みの部屋は選びません・${extra.sentExcluded}件` : "";
  // 2026-09-30 AD1ヶ月未満: 外した件数／売上5万円以上の物件を穴埋めで入れた理由（ほかに選べる物件が無い・しばらく新着を送れていない）
  const low = (extra.adUnder1Excluded ?? 0) > 0 ? `AD1ヶ月未満は選びません・${extra.adUnder1Excluded}件` : "";
  const fill = (extra.adUnder1Filled ?? 0) > 0
    ? `AD1ヶ月未満（売上5万円以上）を${extra.adUnder1Filled}件入れました＝${extra.adUnder1FillWhy === "stale" ? "しばらく新着を送れていないため" : "ほかに選べる物件が無いため"}`
    : "";
  const why = [ng, deal, ad, sent, low, fill].filter(Boolean).join("・");
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
export function defaultAixChecks<T extends AixPickRow>(rounds: ReadonlyArray<{ items: ReadonlyArray<T>; created_at?: string | null }>, bestId?: number | null, max = PICKUP_AIX_MAX, opts: { firstProposalSentAt?: string | null; sentHistory?: ReadonlyArray<SentHistLite> | null;
  /** 2026-09-30 お客様へ届けた最後のご提案の送付（null＝一度も無い・undefined＝分からない）。AD1未満（売上5万円以上）の穴埋めの「しばらく送れていない」に使う */
  lastProposalSentAt?: string | null } = {}): Record<number, boolean> {
  const out: Record<number, boolean> = {};
  for (const r of rounds) {
    const firstProposal = isFirstProposalRound(r.created_at, opts.firstProposalSentAt);
    const sentBefore = opts.sentHistory ? sentBeforeIds(r.items, opts.sentHistory) : null;
    const staleSinceLastSend = isStaleForAdUnder1(r.created_at, opts.lastProposalSentAt);
    const top = new Set(pickQualityTop(r.items, r.items.some((x) => x.id === bestId) ? bestId : null, max, { firstProposal, sentBefore, staleSinceLastSend }).ids);
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
  INITIAL_COST_NOT_ZERO_SOFT: "敷金か礼金あり（できれば安く・見積書で割引）",
  INITIAL_COST_OVER_LIMIT: "敷礼が初期費用の上限超",
  FLOOR_PLAN_MISMATCH: "間取りが希望と違う",
  FLOOR_PLAN_TOO_SMALL: "間取りが希望より小さい",
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
  AD_UNDER_1M_NEVER: "AD 1ヶ月未満（1K か売上5万円未満・送らない）",
  AD_UNDER_1M_FALLBACK: "AD 1ヶ月未満（売上5万円以上・他に無い時だけ）",
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
