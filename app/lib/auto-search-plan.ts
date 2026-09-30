// app/lib/auto-search-plan.ts（純関数・DB も fetch も無し）
// 自動便（午前 10:15〜11:15・午後 16:15〜17:15）で「誰を・どの並びで・どこまで読むか」をお客様の状態で決める。
//
// 2026-09-30 竹内さんの決定（設計 wf_7b9c28ba の未決への答え・memory project_search_cadence_plan）:
//   - 新規 = 物件ピックアップをまだお客様に送っていない人（pickup-ad-priority の isProposalSend と同じ定義・登録日数で切らない）。
//     リアプロは朝も夕も AD 順・更新日 14日・止める線なし。ピンポイント → 足りなければ拡張の今の「広げて」（chain・kind new・しきい値10）
//   - 送った後 = 朝も夕も更新順・前回の検索以降だけ（stop_at_last:true）。週1回の AD 順は無し
//   - 条件を言い直した直後 = 次の便の1回だけ新規と同じ（AD 順・止める線なし）
//   - 要対応（status=hot）の人は止まっていても毎日（今まで通り）。要対応から外れて止まっている人
//     （実際の送付もお客様の発言も8日以上ない）だけ週2回（曜日はお客様ごとにばらす）
//   - 状態の判定は実際にお客様へ届けた送付とお客様の発言で。last_property_sent_at は使わない
//     （merge-pdfs が自動検索の回でも今の時刻に書くので「最近送った人」を自分で作り直していた＝9/30 の監査で60人中40人が4日以上前の送付）
//   - ITANDI は元から更新日順・並び替え無し（sort は拡張がリアプロだけに使う）
//
// 表（PLAN_TABLE）はここ1か所。拡張は payload.plan_by_customer[id] に従うだけ（戻すのはサーバーの環境変数だけで済む）:
//   AUTO_SEARCH_PLAN=legacy … 今までの選び方（auto-search-schedule.selectAutoSearchTargets・午前 AD 順・広げて）に戻す
//   AUTO_SEARCH_STOP_AT_LAST=off … plan の stop_at_last を全員 false に

import { seededRandom, jstDaysSince, MAX_TARGETS_PER_RUN, type AutoSearchMode } from "./auto-search-schedule";

export type AutoSearchState = "new" | "cond_changed" | "active" | "dormant_hot" | "dormant" | "off";

/** 状態の判定の材料（auto-search-plan-server が DB から読む） */
export type AutoSearchStateInput = {
  id: string;
  status?: string | null;
  created_at?: string | null;
  /** 検索の条件（エリア）があるか。無い人は拡張が空振りするので off */
  has_condition: boolean;
  /** お客様へ最初にご提案として届けた時刻（isProposalSend）。null＝まだ1件も／undefined＝読めない */
  first_proposal_at: string | null | undefined;
  /** お客様へ最後にご提案として届けた時刻（isProposalSend） */
  last_proposal_at: string | null;
  /** お客様の最後の発言（messages.sender=customer） */
  last_customer_msg_at: string | null;
  /** 条件の最後の変更（property_condition_history） */
  last_condition_change_at: string | null;
  /** サイトごとの前回の検索（search_audits の最後に終わった回・realpro／itandi） */
  last_search_by_site?: Record<string, string> | null;
};

/** 物件検索の対象にしない状態（申込以降・終了・保留）。auto-search-schedule の EXCLUDED_STATUS と同じ */
export const EXCLUDED_STATUS = new Set(["applying", "closed_won", "closed_lost", "closed", "cancelled", "pending"]);
/** 動いている＝実際の送付かお客様の発言がこの日数以内（JST の日付で数える）。8日以上ないと止まっている */
export const ACTIVE_DAYS = 7;
/** 条件を言い直した直後とみなす長さ（これより前の変更は、次の便で検索が記録されていなくても言い直しとしない） */
export const COND_CHANGED_DAYS = 7;
/** 何も動きが無いまま（送付・発言・条件の変更・登録）この日数を過ぎたら自動便に入れない（設計の既定・ブレインに聞く形は未実装） */
export const OFF_AFTER_DAYS = 30;
/** 週2回の人の回数 */
export const DORMANT_TIMES_PER_WEEK = 2;
/** 新規・条件の言い直しの更新日（竹内「新規の検索の更新日は14日」） */
export const NEW_UPDATE_DAYS = 14;
/** 1回のページの上限（auto-search-schedule.SEARCH_MAX_PAGES と同じ・拡張 DEFAULT_MAX_PAGES） */
export const PLAN_MAX_PAGES = 5;

const DAY_MS = 86_400_000;
const ms = (s: string | null | undefined) => { const v = Date.parse(String(s ?? "")); return Number.isFinite(v) ? v : NaN; };
const latest = (...xs: Array<string | null | undefined>) => {
  let best: string | null = null;
  for (const x of xs) if (x && Number.isFinite(ms(x)) && (!best || ms(x) > ms(best))) best = x;
  return best;
};

export type StateResult = { state: AutoSearchState; reason: string };

/**
 * お客様の状態（上から順に当てる・決定論）:
 *   off          … 申込以降・終了・保留／条件（エリア）なし／送付の記録が読めない／何も動きが無いまま OFF_AFTER_DAYS 日
 *   new          … まだ1件もご提案を届けていない（登録日数で切らない）
 *   cond_changed … 届けた後で、条件の変更（COND_CHANGED_DAYS 日以内）が前回の検索（サイトの古い方）より後・前回の検索が無い
 *   active       … 実際の送付かお客様の発言が ACTIVE_DAYS 日以内
 *   dormant_hot  … 止まっているが要対応（status=hot）
 *   dormant      … 止まっている（送付も発言も8日以上ない）
 */
export function classifyAutoSearchState(i: AutoSearchStateInput, nowMs: number): StateResult {
  if (EXCLUDED_STATUS.has(String(i.status ?? ""))) return { state: "off", reason: `対象外の状態（${i.status}）` };
  if (!i.has_condition) return { state: "off", reason: "検索の条件（エリア）なし" };
  if (i.first_proposal_at === undefined) return { state: "off", reason: "送付の記録が読めない" };
  const lastActivity = latest(i.last_proposal_at, i.last_customer_msg_at, i.last_condition_change_at, i.created_at);
  const idle = jstDaysSince(lastActivity, nowMs);
  if (idle == null || idle > OFF_AFTER_DAYS) return { state: "off", reason: idle == null ? "動きの日時が読めない" : `${idle}日動きなし（${OFF_AFTER_DAYS}日を超えた）` };
  if (i.first_proposal_at === null) return { state: "new", reason: "まだご提案を届けていない（新規）" };
  const change = ms(i.last_condition_change_at);
  if (Number.isFinite(change) && nowMs - change <= COND_CHANGED_DAYS * DAY_MS) {
    const sites = Object.values(i.last_search_by_site ?? {}).map(ms).filter(Number.isFinite);
    // 前回の検索（サイトの古い方）より後に条件が変わった＝まだ今の条件で見ていないサイトがある
    const oldest = sites.length ? Math.min(...sites) : NaN;
    if (!Number.isFinite(oldest) || change >= oldest) return { state: "cond_changed", reason: "条件を言い直した後、まだ検索していない" };
  }
  const sendDays = jstDaysSince(i.last_proposal_at, nowMs);
  const msgDays = jstDaysSince(i.last_customer_msg_at, nowMs);
  const recent = [sendDays, msgDays].filter((d): d is number => d != null);
  const minDays = recent.length ? Math.min(...recent) : null;
  if (minDays != null && minDays <= ACTIVE_DAYS) return { state: "active", reason: `送付 ${sendDays ?? "-"}日前・発言 ${msgDays ?? "-"}日前` };
  if (String(i.status ?? "") === "hot") return { state: "dormant_hot", reason: `止まっているが要対応（送付 ${sendDays ?? "-"}日前・発言 ${msgDays ?? "-"}日前）` };
  return { state: "dormant", reason: `送付 ${sendDays ?? "-"}日前・発言 ${msgDays ?? "-"}日前（8日以上なし）` };
}

export type AutoSearchPlan = {
  state: AutoSearchState;
  /** リアプロの並び（ad＝AD 高い順・updated＝更新順＝既定）。ITANDI は並び替え無し */
  sort: "ad" | "updated";
  /** いつもピンポイント（足りなければ新規だけ chain が広げて） */
  is_wide: false;
  /**
   * 更新日の元の値（search-update-days.planUpdateDays の baseDays）。前回の検索から空いた時間を覆う所まで広げてから拡張に渡す。
   *   null＝指定なし
   */
  days: number | null;
  /** 更新順の一覧で「前回の検索より古い行」で止める（2.5.43 update-order-stop・update_days_plan.last_by_site） */
  stop_at_last: boolean;
  max_pages: number;
  reason: string;
};

type Row = { sort: "ad" | "updated"; days: "new" | "since_last"; stop_at_last: boolean; runs: "both" | "am_twice_week"; note: string };
/** 状態ごとの回し方（1か所）。off はどの便にも入れない */
export const PLAN_TABLE: Record<Exclude<AutoSearchState, "off">, Row> = {
  new:          { sort: "ad",      days: "new",        stop_at_last: false, runs: "both",          note: "新規: AD 順・更新日14日・止める線なし" },
  cond_changed: { sort: "ad",      days: "new",        stop_at_last: false, runs: "both",          note: "条件の言い直しの直後の1回: 新規と同じ（AD 順・止める線なし）" },
  active:       { sort: "updated", days: "since_last", stop_at_last: true,  runs: "both",          note: "送った後: 更新順・前回の検索以降だけ" },
  dormant_hot:  { sort: "updated", days: "since_last", stop_at_last: true,  runs: "both",          note: "要対応で止まっている: 毎日・更新順・前回の検索以降だけ" },
  dormant:      { sort: "updated", days: "since_last", stop_at_last: true,  runs: "am_twice_week", note: "止まっている: 週2回（午前）・更新順・前回の検索以降だけ" },
};

/** 状態の優先（小さいほど先・上限40で切る）: ③言い直し → ①新規 → 要対応 → ②動いている → ④止まっている */
export function priorityOfState(state: AutoSearchState, status?: string | null): number {
  if (state === "cond_changed") return 0;
  if (state === "new") return 1;
  if (String(status ?? "") === "hot") return 2; // active の hot・dormant_hot
  if (state === "active") return 3;
  if (state === "dormant") return 4;
  return 9;
}

/** JST の曜日（0=日） */
function jstWeekday(jstDate: string): number {
  return new Date(`${jstDate}T12:00:00+09:00`).getUTCDay();
}
/** その週の月曜（JST の日付）＝週の種 */
function weekKey(jstDate: string): string {
  const d = Date.parse(`${jstDate}T12:00:00+09:00`);
  const wd = (jstWeekday(jstDate) + 6) % 7; // 月=0
  return new Date(d - wd * DAY_MS + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 止まっている人の週2回の曜日（0=日〜6=土）。週（月曜の日付）＋お客様の種で決める＝毎週・人ごとに変わる。
 * 2つの曜日は2〜4日離す（続けて2日にしない）
 */
export function dormantWeekdays(jstDate: string, customerId: string): number[] {
  const rnd = seededRandom(`auto-plan|dormant|${weekKey(jstDate)}|${customerId}`);
  const a = Math.floor(rnd() * 7);
  const b = (a + 2 + Math.floor(rnd() * 3)) % 7;
  return [a, b].sort((x, y) => x - y);
}

/**
 * その便の計画。この便で検索しない時は null。
 * ctx.lastSearchAt … そのお客様の前回の検索（サイトの古い方）。前回の検索が無い「前回以降」の人は、
 *   最後にご提案を届けた日から rp-update-days と同じ線（1/3/7/14・無ければ14）で読む（漏れない側）
 */
export function planFor(
  state: AutoSearchState, mode: AutoSearchMode, jstDate: string, customerId: string,
  ctx: { lastSearchAt?: string | null; lastProposalAt?: string | null; nowMs?: number; stopAtLast?: boolean } = {},
): AutoSearchPlan | null {
  if (state === "off") return null;
  const row = PLAN_TABLE[state];
  if (row.runs === "am_twice_week") {
    if (mode !== "am") return null;
    if (!dormantWeekdays(jstDate, customerId).includes(jstWeekday(jstDate))) return null;
  }
  let days: number | null;
  if (row.days === "new") days = NEW_UPDATE_DAYS;
  else if (ctx.lastSearchAt && Number.isFinite(ms(ctx.lastSearchAt))) days = 1; // 前回の検索からの空きは planUpdateDays が覆う
  else {
    const d = jstDaysSince(ctx.lastProposalAt ?? null, ctx.nowMs ?? Date.now());
    days = d == null ? NEW_UPDATE_DAYS : d <= 1 ? 1 : d <= 3 ? 3 : d <= 7 ? 7 : 14;
  }
  const stop = row.stop_at_last && ctx.stopAtLast !== false;
  return { state, sort: row.sort, is_wide: false, days, stop_at_last: stop, max_pages: PLAN_MAX_PAGES, reason: row.note + (row.stop_at_last && !stop ? "（止める線は切ってある）" : "") };
}

/** 環境変数（サーバーだけが読む。拡張は payload に従うだけ） */
export function planEnv(env: Record<string, string | undefined> = process.env): { legacy: boolean; stopAtLast: boolean } {
  return { legacy: env.AUTO_SEARCH_PLAN === "legacy", stopAtLast: env.AUTO_SEARCH_STOP_AT_LAST !== "off" };
}

export type PlannedTarget = { id: string; state: AutoSearchState; stateReason: string; priority: number; plan: AutoSearchPlan };

/**
 * 今日のこの便の対象（状態 → 計画 → 優先の順 → 上限）。off・この便で回さない人は外す（skipped に理由）
 */
export function selectPlannedTargets(
  inputs: ReadonlyArray<AutoSearchStateInput>, mode: AutoSearchMode, jstDate: string, nowMs: number,
  opts: { limit?: number; stopAtLast?: boolean } = {},
): { targets: PlannedTarget[]; byState: Record<AutoSearchState, number>; notThisRun: Array<{ id: string; state: AutoSearchState; why: string }>; overLimit: PlannedTarget[] } {
  const byState: Record<AutoSearchState, number> = { new: 0, cond_changed: 0, active: 0, dormant_hot: 0, dormant: 0, off: 0 };
  const picked: PlannedTarget[] = [];
  const notThisRun: Array<{ id: string; state: AutoSearchState; why: string }> = [];
  for (const i of inputs) {
    if (!i?.id) continue;
    const { state, reason } = classifyAutoSearchState(i, nowMs);
    byState[state]++;
    if (state === "off") continue;
    const sites = Object.values(i.last_search_by_site ?? {}).filter((x) => Number.isFinite(ms(x)));
    const lastSearchAt = sites.length ? sites.reduce((a, b) => (ms(a) < ms(b) ? a : b)) : null;
    const plan = planFor(state, mode, jstDate, String(i.id), { lastSearchAt, lastProposalAt: i.last_proposal_at, nowMs, stopAtLast: opts.stopAtLast });
    if (!plan) { notThisRun.push({ id: String(i.id), state, why: state === "dormant" ? "週2回の日でない（止まっている）" : "この便では回さない" }); continue; }
    picked.push({ id: String(i.id), state, stateReason: reason, priority: priorityOfState(state, i.status), plan });
  }
  // 同じ優先の中は前回の検索が古い順（窓が空きを覆うので枠から落ちても遅れるだけ）→ id
  const lastOf = new Map(inputs.map((i) => {
    const v = Object.values(i.last_search_by_site ?? {}).map(ms).filter(Number.isFinite);
    return [String(i.id), v.length ? Math.min(...v) : -Infinity] as const;
  }));
  picked.sort((a, b) => a.priority - b.priority || (lastOf.get(a.id)! - lastOf.get(b.id)!) || a.id.localeCompare(b.id));
  const limit = Math.max(0, opts.limit ?? MAX_TARGETS_PER_RUN);
  return { targets: picked.slice(0, limit), byState, notThisRun, overLimit: picked.slice(limit) };
}

/** payload.plan_by_customer の1人分（拡張が読む形） */
export type PlanPayloadEntry = { state: AutoSearchState; sort: "ad" | "updated"; is_wide: false; days: number | null; stop_at_last: boolean; max_pages: number; reason: string };

/** payload.plan_by_customer（お客様 id → 計画）。days は更新日の計画（planUpdateDays）で広げた後の値を渡す */
export function planByCustomerPayload(entries: ReadonlyArray<{ id: string; plan: AutoSearchPlan; days?: number | null }>): Record<string, PlanPayloadEntry> {
  const out: Record<string, PlanPayloadEntry> = {};
  for (const e of entries) {
    out[String(e.id)] = {
      state: e.plan.state, sort: e.plan.sort, is_wide: false,
      days: e.days === undefined ? e.plan.days : e.days,
      stop_at_last: e.plan.stop_at_last, max_pages: e.plan.max_pages, reason: e.plan.reason,
    };
  }
  return out;
}

/** payload からそのお客様の計画を読む（無ければ undefined＝今までの形） */
export function planOfPayload(payload: unknown, customerId: string | null | undefined): PlanPayloadEntry | undefined {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>).plan_by_customer : null;
  if (!p || typeof p !== "object" || customerId == null) return undefined;
  const e = (p as Record<string, unknown>)[String(customerId)];
  return e && typeof e === "object" ? (e as PlanPayloadEntry) : undefined;
}

/** 状態の日本語（dry_run・報告） */
export const STATE_JA: Record<AutoSearchState, string> = {
  new: "①新規", cond_changed: "③条件の言い直し", active: "②送った後・動いている", dormant_hot: "要対応で止まっている", dormant: "④止まっている", off: "対象外",
};
