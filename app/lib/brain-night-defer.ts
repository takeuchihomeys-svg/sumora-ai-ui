// app/lib/brain-night-defer.ts
// 22:00〜9:00（JST）に届いたお客様のメッセージは分析しない（ブレインも下書きも）で、9:00 から順に分析する — その判定だけを置く純関数
//
// 2026-09-24 竹内「22時〜9時のお客さんは分析せずに9時から分析するように仕組化したら他での浪費も防げるのでは？
//   たとえば深夜にお客さんから1通くるだけでも0.5ドル必要となる部分。時間は日本時間に設定する」
//   実測（scripts/peek-night-messages.ts・10夜）: 夜のお客様起点の Claude ≈$3.8/夜、うち冷えたキャッシュの書き直し ≈$1.5/夜。
//   夜に1通だけ来るとブレインの全書き直し（39k×$6≈$0.23）＋返信生成の全書き直し（≈115k≈$0.7）で約 $1 かかるのが「0.5ドル」の正体。
//
// 設計（設計知見「入口は1つの関数」「『落とす』機能は失敗時 fail-open」）:
//   - 見送るのは**お客様起点の自動分析**だけ（line-webhook / generate-draft-bg-async / cron / brain-sweep / 画面の自動起動）。
//     スタッフの明示操作（再生成ボタン・宣言送信）は夜でも動く（費用は人の操作回数で有界）。
//   - origin 未指定は「走らせる」（名札を付け忘れた経路がスタッフの操作でも止まらないように安全側へ倒す）。
//   - 既存の parseHoursJst（reply-warm-prefix.ts）は end > start しか受けず "22-9" を黙って 7-24 に落とす（テストで固定された挙動）。
//     そのまま使うと「7〜24時が夜」と逆に動くので、跨ぎ対応の parser をここに置く（JST の時の計算は jstParts をそのまま使う）。
//   - 依存は ./jst-date だけ（supabase を読み込まない＝テストが env 無しで走る）。
import { jstParts, jstDayStartMs } from "./jst-date";

/** 環境変数の形（process.env がそのまま渡せる。テストは素の object で渡す） */
export type EnvLike = Record<string, string | undefined>;

/** 夜の時間帯（JST）。"22-9" ＝ 22:00〜翌 8:59 */
export const BRAIN_NIGHT_DEFAULT_HOURS = "22-9";

export type HourRangeJst = { start: number; end: number; /** start > end（日付を跨ぐ） */ wraps: boolean };

export const BRAIN_NIGHT_FALLBACK: HourRangeJst = { start: 22, end: 9, wraps: true };

/**
 * "22-9" / "9-22" / "0-6" / "22-24" → HourRangeJst。形は parseHoursJst と同じ正規表現。
 * 0<=start<=23・0<=end<=24・start!==end。壊れた値・範囲外・start==end は fallback
 */
export function parseHourRangeJst(spec: string | null | undefined, fallback: HourRangeJst): HourRangeJst {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec ?? "");
  if (!m) return fallback;
  const start = Number(m[1]), end = Number(m[2]);
  if (!(start >= 0 && start <= 23 && end >= 0 && end <= 24 && start !== end)) return fallback;
  return { start, end, wraps: start > end };
}

/** JST の時が範囲内か。wraps ? (h>=start || h<end) : (h>=start && h<end) */
export function inHourRangeJst(nowMs: number, r: HourRangeJst): boolean {
  const h = jstParts(nowMs).hour;
  return r.wraps ? h >= r.start || h < r.end : h >= r.start && h < r.end;
}

/**
 * 次の end 時（既定 9:00 JST）の UTC ms。base = JST 当日 0:00 + end 時、base <= now なら翌日
 * （跨ぎ・非跨ぎ・月末・年末を同じ式で扱う。昼に呼ぶと翌日の end 時になる）
 */
export function nightDeferUntilMs(nowMs: number, r: HourRangeJst): number {
  const base = jstDayStartMs(nowMs) + r.end * 3_600_000;
  return base <= nowMs ? base + 86_400_000 : base;
}

/** ブレインを起動した理由。自動（お客様起点・画面の自動起動・cron・sweep）と手動（スタッフのボタン・送信）を分ける */
export type BrainOrigin = "customer_message" | "image_read" | "ui" | "cron" | "sweep" | "staff";

/** 夜に見送る起点（staff だけが夜も動く） */
export const NIGHT_DEFER_ORIGINS: ReadonlySet<BrainOrigin> = new Set<BrainOrigin>(["customer_message", "image_read", "ui", "cron", "sweep"]);

/** 環境変数の「止める」の読み方を1か所に（"off" の一語だけで止める。true/1/on/空/未設定は全部オン） */
export function isOffSwitch(v: string | null | undefined): boolean {
  return (v ?? "").trim().toLowerCase() === "off";
}

export function isNightDeferEnabled(env: EnvLike = process.env): boolean {
  return !isOffSwitch(env.BRAIN_NIGHT_DEFER);
}

export function nightRangeFromEnv(env: EnvLike = process.env): HourRangeJst {
  return parseHourRangeJst(env.BRAIN_NIGHT_HOURS_JST, BRAIN_NIGHT_FALLBACK);
}

export type NightDeferInput = { nowMs: number; origin: BrainOrigin | undefined; enabled: boolean; range: HourRangeJst };
export type NightDeferDecision = { defer: boolean; until: number | null; reason: string };

/**
 * 判定順（fail-open）:
 *   enabled=false → disabled ／ origin が staff（または NIGHT_DEFER_ORIGINS に無い）→ origin:staff ／ origin 未指定 → origin:unknown（走らせる）
 *   ／ 夜でない → day ／ 夜 → defer:true・until＝次の end 時
 */
export function decideNightDefer(i: NightDeferInput): NightDeferDecision {
  if (!i.enabled) return { defer: false, until: null, reason: "disabled" };
  if (i.origin === undefined) return { defer: false, until: null, reason: "origin:unknown" };
  if (!NIGHT_DEFER_ORIGINS.has(i.origin)) return { defer: false, until: null, reason: "origin:staff" };
  if (!inHourRangeJst(i.nowMs, i.range)) return { defer: false, until: null, reason: "day" };
  return { defer: true, until: nightDeferUntilMs(i.nowMs, i.range), reason: `night(${i.range.start}-${i.range.end})` };
}

/** 入口で呼ぶ形（env と今の時刻を読んで decideNightDefer に渡すだけ。時刻の比較を入口ごとにコピペしない） */
export function decideNightDeferNow(origin: BrainOrigin | undefined, nowMs: number = Date.now(), env: EnvLike = process.env): NightDeferDecision {
  return decideNightDefer({ nowMs, origin, enabled: isNightDeferEnabled(env), range: nightRangeFromEnv(env) });
}
