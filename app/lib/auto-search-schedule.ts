// app/lib/auto-search-schedule.ts
// 毎日の自動物件検索（AIXモードの PC が実行する）の「誰を・どの条件で」を決める純関数。DB 依存なし。
//
// 2026-09-19 竹内:
//   「拡張ツールAIXモードにしている場合、毎日11:00になったら3日以内物件確認している人や
//     新規のお客さんの物件検索自動ですることできるか（AD高い順）。
//     ルールは昨日のお客さんなら更新日昨日で3日前物件出しした人なら3日内等本来の通り。
//     そして17:00に今日出た新規物件をおくる為本日の更新日付で検索したの送る形出来るか
//     （最新物件・この場合AD順ではなくて更新順とする・そして項目は１ページだけで
//       本来のように３ページ迄いかなくて大丈夫）
//     こうしたら最新でオススメ出来る物件出た際に見落とさなくて良いから」
//
// 【既にあった物（作る前に探した）】
//   ・automation_commands（積む → AIXモードの PC が /api/automation/pending?aix=1 で claim → 検索して送信）
//   ・更新日の計算（拡張 popup.js の calcUpdateDays: 1日以内→"1" / 3日以内→"3" / 7日以内→"7" / それ以上→"14"）
//   足したのは「時刻で積む」「誰を選ぶ」「17時用の条件（当日・更新順・1ページ）」だけ。
//
// 【更新日が「本来の通り」になる理由】
//   前回送った日からの日数で更新日を絞る＝**前回送ってから新しく出たお部屋だけ**が出る。
//   昨日送った人 → 1日以内、3日前に送った人 → 3日以内。竹内さんの言う「本来の通り」はこの計算そのもの。

/** 物件顧客のうち、この判断に使う列だけ */
export type AutoSearchCustomer = {
  id: string;
  status?: string | null;
  last_property_sent_at?: string | null;
  /**
   * 物件を「確認した」日時（拡張・顧客画面の確認ボタン → 一覧の「確:」バッジ）。
   * 2026-09-19 竹内「物件出ししたお客さんっていうのは送信じゃなくて確認したお客さんも含む」
   */
  property_viewed_at?: string | null;
  /** 物件顧客として登録された日時（「新規のお客さん」の判定に使う） */
  created_at?: string | null;
};

export type AutoSearchMode = "am" | "pm";

/** 対象に選んだ1人（rpUpdateDays は検索フォームの「更新日」に入れる値。null は絞らない） */
export type AutoSearchTarget = {
  id: string;
  /** なぜ選ばれたか（ログ・報告用） */
  reason: "recent_sent" | "new_customer";
  rpUpdateDays: number | null;
};

/** 物件検索の対象にしない状態（申込以降・終了） */
const EXCLUDED_STATUS = new Set(["applying", "closed_won", "closed_lost", "closed", "cancelled", "pending"]);
/** 「直近に物件出しした人」の範囲（竹内さんの「3日以内物件確認している人」） */
export const RECENT_SENT_DAYS = 3;
/**
 * 「新規のお客さん」＝登録からこの日数以内で、まだ一度も物件を出していない人。
 *
 * 2026-09-19 竹内「**新規のお客さんで送っていない人も3日以内で**」← 直近3日にそろえる（初版は14日だった）。
 * 実データ: まだ出していない人は109人いるが **1か月より前の登録が98人**（古い放置客）。
 * 3日で切ると 5人前後で、直近3日に物件出しした人と同じ「今動いている人」だけが残る。
 */
export const NEW_CUSTOMER_DAYS = 3;
/** 1回に積む上限（多すぎると 11:00〜17:00 の間に終わらない）。優先順位の高い順に切る */
export const MAX_TARGETS_PER_RUN = 40;
const DAY_MS = 86_400_000;

/** JST の日付（YYYY-MM-DD）に揃える */
function jstDateStr(ms: number): string {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 前回の物件出しから何日経ったか（JST の日付で数える）。読めなければ null。
 * 「3日前に送った」は時刻ではなく**日付**で数える（9/16 10:00 → 9/19 11:00 は3日。
 *  時刻の差（3日1時間）で数えると1時間の違いで外れてしまう）。
 */
export function jstDaysSince(lastSentAt: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!lastSentAt) return null;
  const t = Date.parse(lastSentAt);
  if (!Number.isFinite(t)) return null;
  const sentMidnight = Date.parse(`${jstDateStr(t)}T00:00:00+09:00`);
  const nowMidnight = Date.parse(`${jstDateStr(nowMs)}T00:00:00+09:00`);
  return Math.round((nowMidnight - sentMidnight) / DAY_MS);
}

/**
 * 「最後に物件を出した日」＝ 送信（last_property_sent_at）と確認（property_viewed_at）の**新しい方**。
 * 2026-09-19 竹内「物件出ししたお客さんっていうのは送信じゃなくて確認したお客さんも含む」。
 * 一覧の「送:」「確:」の2つのバッジがそれぞれこの2列（拡張 popup.js）。
 */
export function lastPropertyTouchAt(c: Pick<AutoSearchCustomer, "last_property_sent_at" | "property_viewed_at">): string | null {
  const sent = c.last_property_sent_at ? Date.parse(c.last_property_sent_at) : NaN;
  const viewed = c.property_viewed_at ? Date.parse(c.property_viewed_at) : NaN;
  const okSent = Number.isFinite(sent);
  const okViewed = Number.isFinite(viewed);
  if (!okSent && !okViewed) return null;
  if (okSent && okViewed) return sent >= viewed ? c.last_property_sent_at! : c.property_viewed_at!;
  return okSent ? c.last_property_sent_at! : c.property_viewed_at!;
}

/**
 * 前回の物件出しから何日経ったかで「更新日」を決める。
 * 拡張 popup.js の calcUpdateDays と**同じ線**（1 / 3 / 7 / 14・初回は絞らない）。
 * ここを直したら向こうも直す（四者同名）。
 * ※ 渡すのは lastPropertyTouchAt（送信と確認の新しい方）＝「前回そのお客様に物件を出してから」の新着だけが出る。
 */
export function rpUpdateDaysFor(lastSentAt: string | null | undefined, nowMs: number = Date.now()): number | null {
  const daysSince = jstDaysSince(lastSentAt, nowMs);
  if (daysSince === null) return null; // 初めての物件出し・読めない値 → 絞り込まない
  if (daysSince <= 1) return 1;
  if (daysSince <= 3) return 3;
  if (daysSince <= 7) return 7;
  return 14;
}

/** 優先順位（小さいほど先）。hot は返事が来ている人なので最優先 */
function priorityOf(c: AutoSearchCustomer, reason: AutoSearchTarget["reason"]): number {
  if (c.status === "hot") return 0;
  if (reason === "recent_sent") return 1;
  if (c.status === "new_inquiry") return 2;
  return 3; // まだ一度も送っていない property_search
}

/**
 * 自動検索の対象を選ぶ。
 *   ① 直近3日に物件を送った人（＝やりとりが動いている人。前回以降の新着だけを出す）
 *   ② まだ一度も送っていない人（新規のお客さん）
 * 申込以降・終了・保留の人は選ばない。多い時は優先順位の高い順に MAX_TARGETS_PER_RUN 件まで。
 */
export function selectAutoSearchTargets(
  customers: readonly AutoSearchCustomer[],
  opts: { nowMs?: number; limit?: number } = {},
): AutoSearchTarget[] {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? MAX_TARGETS_PER_RUN;
  const picked: Array<AutoSearchTarget & { priority: number }> = [];
  for (const c of customers) {
    if (!c?.id) continue;
    if (EXCLUDED_STATUS.has(String(c.status ?? ""))) continue;
    // 「3日以内に物件を出した」は送信と確認の新しい方で、JST の日付で数える
    //   （rpUpdateDaysFor と同じ数え方＝出る更新日と必ず揃う）
    const touchedAt = lastPropertyTouchAt(c);
    const daysSince = jstDaysSince(touchedAt, nowMs);
    const isRecent = daysSince !== null && daysSince <= RECENT_SENT_DAYS;
    // まだ一度も出していない人は「最近登録された人」だけ（古い放置客を毎日回さない）。
    // 登録日が無いデータは新規とみなさない（fail-closed）
    const sinceCreated = jstDaysSince(c.created_at, nowMs);
    const isNew = daysSince === null && sinceCreated !== null && sinceCreated <= NEW_CUSTOMER_DAYS;
    if (!isRecent && !isNew) continue;
    const reason: AutoSearchTarget["reason"] = isRecent ? "recent_sent" : "new_customer";
    picked.push({
      id: String(c.id),
      reason,
      rpUpdateDays: rpUpdateDaysFor(touchedAt, nowMs),
      priority: priorityOf(c, reason),
    });
  }
  picked.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return picked.slice(0, Math.max(0, limit)).map(({ id, reason, rpUpdateDays }) => ({ id, reason, rpUpdateDays }));
}

/**
 * 17時の「最新物件」便の条件（竹内さんの指定そのまま）
 * 2026-09-19 竹内「AD順じゃなくて、指定しなければ更新順になるから17時の時だけ並び替え順をAD順にしなければ大丈夫」
 *   → リアプロの**既定が更新順**。拡張は sort="updated" の時だけ並び替えを**既定へ戻す**（前の検索の値が残る画面のため）。
 * 2026-09-19 竹内「17:00の検索はピンポイント検索で一括で行うようにする」→ is_wide=false・1コマンドにまとめる
 */
export const PM_LATEST = {
  /** 本日の更新日付＝更新日「1日以内」で絞る */
  rpUpdateDays: 1,
  /** 並び替えを既定（＝更新順）に戻す */
  sort: "updated" as const,
  /** 1ページだけ（3ページまで行かない） */
  maxPages: 1,
  /** ピンポイント検索（条件を広げない） */
  isWide: false,
};

/**
 * 11時の便（AD 高い順・ページは今まで通り）。sort="ad" は拡張では**何もしない**印＝今の並びのまま。
 * 2026-09-19 竹内「拡張ツールのAIXの11:00の検索は広げて検索」→ is_wide=true
 *   （広げて検索のルール: 家賃 +5,000〜10,000円／隣の駅・同じ区／広さ −5〜10㎡。dept_search_tool.md）
 */
export const AM_DAILY = {
  sort: "ad" as const,
  maxPages: 3,
  isWide: true,
};

export type AutoSearchPayload = {
  source: "auto_schedule";
  mode: AutoSearchMode;
  /** 11時＝広げて検索（true）／17時＝ピンポイント（false）。2026-09-19 竹内 */
  is_wide: boolean;
  /** 検索フォームの「更新日」。null は絞らない（初回の人） */
  rp_update_days: number | null;
  /** 並び順（拡張が対応していれば反映・未対応なら今の並びのまま警告ログ） */
  sort: "ad" | "updated";
  /** 巡回するページ数の上限 */
  max_pages: number;
  /** 何時の便か（JST・ログと重複防止のキー） */
  jst_date: string;
};

/**
 * 積むコマンドの payload を作る。
 *
 * 11時は**人ごとに更新日が変わる**（前回出した日から計算）ので、顧客1人につき1コマンド。広げて検索。
 * 17時は**全員が同じ条件**（本日の更新日付・更新順・1ページ・ピンポイント）なので、
 *   1コマンドに全員を入れて拡張の一括検索でまとめて回す（竹内「ピンポイント検索で一括で行う」）。
 *   target は 17時では更新日の計算に使わない（全員 1日以内）。
 */
export function buildAutoSearchPayload(
  mode: AutoSearchMode,
  target: AutoSearchTarget | null,
  nowMs: number = Date.now(),
): AutoSearchPayload {
  const pm = mode === "pm";
  return {
    source: "auto_schedule",
    mode,
    is_wide: pm ? PM_LATEST.isWide : AM_DAILY.isWide,
    rp_update_days: pm ? PM_LATEST.rpUpdateDays : (target?.rpUpdateDays ?? null),
    sort: pm ? PM_LATEST.sort : AM_DAILY.sort,
    max_pages: pm ? PM_LATEST.maxPages : AM_DAILY.maxPages,
    jst_date: jstDateStr(nowMs),
  };
}

/** 17時は1コマンドにまとめる（全員同じ条件）／11時は1人1コマンド（更新日が人ごとに違う） */
export function isBatchedRun(mode: AutoSearchMode): boolean {
  return mode === "pm";
}
