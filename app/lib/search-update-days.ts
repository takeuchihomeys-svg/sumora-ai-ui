// app/lib/search-update-days.ts（純関数・DB も fetch も無し・画面からも使える）
// 更新日（リアプロの「N日以内」・ITANDI の「募集条件更新 N日以内」）を「前回の検索から空いた日数」で覆えているかを決める・確かめる。
//
// 2026-09-29 竹内「更新日もちゃんと確認する。更新日を生かすことによって最新の物件の検索や新規物件のもれがないようにするのが目的」
//
// 【今までの決まり】rp-update-days.ts: 手で決めた値 → 無ければ「前回そのお客様に物件を出した日（送った日と確認した日の新しい方）」から 1/3/7/14。
//   午後の便は全員 1（本日の更新日付）。
// 【穴】物件を出した日と「前回そのサイトで最後まで検索した日」は別。例: 前回の検索が 9/26 で、9/27 の便が失敗・見送り、
//   9/28 の午後の便が 1日以内 → 9/27 に更新された物件はどの回も見ていない（新着の漏れ）。
// 【足した決まり】前回の検索（そのお客様×サイトの最後に終わった回＝search_audits の finished・失敗なし）から空いた時間を覆う日数まで
//   **広げる**（狭めない＝今までの決まりより狭くはならない）。選べる値はリアプロの 1/3/7/14（ITANDI も同じ値を 0〜9 の欄に入れ、14 は「なし」）。
//   14 でも覆えない（15日以上空いた）時は「指定なし」（大きい側・漏れない）。
//   前回の検索が分からない（ブレインの点検の記録が無い）時は今までの決まりのまま。
//
// 日数は**時間で**数える（リアプロの「1日以内」を「今から24時間」と読む＝狭い側の読み方）:
//   前日 10:00 に検索 → 今日 17:00（31時間）は 1日以内では前日 10:00〜17:00 が抜ける → 3日以内。
//   サイトの「N日以内」が暦の日で数える作りなら広すぎるだけ（漏れない側）。実物で確かめたら線を変える（UPDATE_DAYS_GRACE_HOURS）。

/** リアプロの更新日の選択肢（拡張の select・rp-update-days の RP_UPDATE_DAYS_CHOICES と同じ） */
export const UPDATE_DAYS_CHOICES = [1, 3, 7, 14] as const;
/** ITANDI の欄の上限（なし/0〜9）。これを超える日数は「なし」で検索する（itandi-update-days.js） */
export const ITANDI_MAX_DAYS = 9;
/** 時間の端数の余裕（検索の開始のばらつき・時計のずれ）。24時間＋これ以内なら 1日で覆えるとみなす */
export const UPDATE_DAYS_GRACE_HOURS = 0.5;

const HOUR_MS = 3_600_000;

/** 前回の検索からの時間（時間）。読めなければ null */
export function hoursSince(lastIso: string | null | undefined, nowMs: number): number | null {
  if (!lastIso) return null;
  const t = Date.parse(lastIso);
  if (!Number.isFinite(t) || t > nowMs + 60_000) return null;
  return Math.max(0, (nowMs - t) / HOUR_MS);
}

/** 空いた時間を覆うのに要る日数（1以上・切り上げ）。読めなければ null */
export function neededDays(gapHours: number | null): number | null {
  if (gapHours == null || !Number.isFinite(gapHours)) return null;
  return Math.max(1, Math.ceil(Math.max(0, gapHours - UPDATE_DAYS_GRACE_HOURS) / 24));
}

/** 要る日数を覆う選択肢（1/3/7/14）。14 で足りない時は null＝指定なし（大きい側） */
export function coverChoice(need: number | null): number | null {
  if (need == null) return null;
  for (const c of UPDATE_DAYS_CHOICES) if (c >= need) return c;
  return null;
}

/** 広い方（null＝指定なし＝一番広い） */
export function widerDays(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return Math.max(a, b);
}

/** その日数で空いた時間を覆えているか（null＝指定なし＝覆える） */
export function coversGap(days: number | null, gapHours: number | null): boolean {
  if (days == null) return true;
  const need = neededDays(gapHours);
  if (need == null) return true;
  return days >= need;
}

export type UpdateDaysPlan = {
  /** 使う更新日（null＝指定なし） */
  days: number | null;
  /** 今までの決まりの値（rp-update-days・午後の便の 1 等） */
  base_days: number | null;
  /** 前回の検索（最後に終わった回）の時刻（リアプロと ITANDI の古い方）。無ければ null */
  last_search_at: string | null;
  /** 空いた時間（時間・小数1桁） */
  gap_hours: number | null;
  /** 空いた時間を覆うのに要る日数 */
  need_days: number | null;
  /** 今までの決まりより広げたか */
  widened: boolean;
  /** 短い理由（ログ・点検・見張りの材料） */
  reason: string;
};

/**
 * 更新日を決める。今までの決まり（base）を、前回の検索から空いた時間を覆う所まで広げる（狭めない）。
 * lastSearchAt は「そのお客様の、これから検索するサイトの中で一番古い最後の回」（どのサイトも覆う＝1つの値で両方に使う）。
 * どのサイトにも記録が無い時は base のまま。
 */
export function planUpdateDays(i: { baseDays: number | null; lastSearchAt: string | null; nowMs: number }): UpdateDaysPlan {
  const gap = hoursSince(i.lastSearchAt, i.nowMs);
  const need = neededDays(gap);
  const base = i.baseDays == null ? null : Number(i.baseDays) || null;
  if (need == null) {
    return { days: base, base_days: base, last_search_at: null, gap_hours: null, need_days: null, widened: false, reason: "前回の検索の記録なし（今までの決まり）" };
  }
  const cover = coverChoice(need);
  const days = widerDays(base, cover);
  const widened = days !== base && (base != null) && (days == null || days > base);
  const g = Math.round(gap! * 10) / 10;
  const reason = widened
    ? `前回の検索から${fmtGap(g)}空いた → ${base}日以内では覆えないので${days == null ? "指定なし" : `${days}日以内`}に広げた`
    : `前回の検索から${fmtGap(g)}（${base == null ? "指定なし" : `${base}日以内`}で覆える）`;
  return { days, base_days: base, last_search_at: i.lastSearchAt, gap_hours: g, need_days: need, widened, reason };
}

export function fmtGap(hours: number | null): string {
  if (hours == null) return "?";
  if (hours < 48) return `${Math.round(hours)}時間`;
  return `${Math.round((hours / 24) * 10) / 10}日`;
}

/** お客様ごとの計画（payload.update_days_plan の形）。拡張は by_customer[id].days を更新日に使う */
export type UpdateDaysPlanPayload = { v: 1; by_customer: Record<string, { days: number | null; base_days: number | null; gap_hours: number | null; last_search_at: string | null; widened: boolean }> };

export function planPayload(entries: ReadonlyArray<{ id: string; plan: UpdateDaysPlan }>): UpdateDaysPlanPayload {
  const by: UpdateDaysPlanPayload["by_customer"] = {};
  for (const e of entries) by[String(e.id)] = { days: e.plan.days, base_days: e.plan.base_days, gap_hours: e.plan.gap_hours, last_search_at: e.plan.last_search_at, widened: e.plan.widened };
  return { v: 1, by_customer: by };
}

/** payload の計画からそのお客様の分を読む（無ければ undefined＝今まで通り） */
export function planFor(payload: unknown, customerId: string | null | undefined): UpdateDaysPlanPayload["by_customer"][string] | undefined {
  const p = (payload && typeof payload === "object" ? (payload as Record<string, unknown>).update_days_plan : null) as UpdateDaysPlanPayload | null;
  if (!p || typeof p !== "object" || !p.by_customer || customerId == null) return undefined;
  const e = p.by_customer[String(customerId)];
  return e && typeof e === "object" ? e : undefined;
}

// ─── 一覧の更新日（C2）・ページの打ち切り（C3） ─────────────────────────────

/**
 * リアプロの一覧の行の先頭のセル（見出し「部屋名更新日」）: 「309 4日前 閲覧済」「0405 4時間前」「1001 30分前」→ 経過の日数（小数）。
 * 読めなければ null。拡張（snapshot-core readDom・bulk-dl）も同じ形で読む（四者同名: chrome-extension/snapshot-core.js ageDaysOfCell）。
 */
export function ageDaysOfCell(cell: string | null | undefined): number | null {
  const s = String(cell ?? "").normalize("NFKC");
  const m = s.match(/(\d{1,4})\s*(分|時間|日|週間|ヶ月|か月|カ月)前/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const d = unit === "分" ? n / 1440 : unit === "時間" ? n / 24 : unit === "日" ? n : unit === "週間" ? n * 7 : n * 30;
  return Number.isFinite(d) ? d : null;
}

export type UpdateAges = { n: number; max_days: number | null; over?: number | null; sample?: number[] | null };

/**
 * 一覧の行の更新日の経過が、指定の日数の中に収まっているか。
 * 「N日前」は切り捨ての表示（1日と23時間でも「1日前」）なので、N日以内の検索で N日前 までは中。N+1日前 からが外（＝絞りが効いていない）。
 * 外が 2件以上かつ 20% 以上の時だけ言う（1件の境目の揺れで誤警報を出さない）
 */
export function agesOutside(days: number | null, ages: UpdateAges | null | undefined): { outside: number; total: number; bad: boolean } | null {
  if (days == null || !ages || !(ages.n > 0)) return null;
  const sample = Array.isArray(ages.sample) ? ages.sample.filter((x) => typeof x === "number" && Number.isFinite(x)) : [];
  let outside = typeof ages.over === "number" ? ages.over : null;
  // over が無い時は見本（最大150）で数える＝割合も見本の数で割る
  const total = outside != null ? ages.n : sample.length;
  if (outside == null) outside = sample.filter((x) => Math.floor(x) > days).length;
  if (!(total > 0)) return null;
  return { outside, total, bad: outside >= 2 && outside / Math.max(1, total) >= 0.2 };
}
