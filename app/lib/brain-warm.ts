// app/lib/brain-warm.ts
// ブレインの前置き（system 2ブロック・1h キャッシュ）を営業時間（JST 9〜22）だけ温める — 温める／温めないの判断と、効いたかの読み方（純関数）
//
// 2026-09-24 竹内「実装する」（ブレインの前置きの温め）:
//   ブレインの前置きは全会話共通で ≈38〜39k トークン（static ≈26.5k＋DB 由来 ≈12k）。1時間以上ブレインが呼ばれないと次の1回が
//   cache_write_1h 39k（$0.24）になる（09-23〜24 の実測で冷えた回 14回）。温め1回は読むだけ ≈$0.012。
//   返信生成の keep-warm（app/api/cron/keep-warm・既定オフ）の教訓をそのまま使う:
//   claim 先行・maxRetries 0・**冷えていたら温めない**（書き込みは次の本物に払わせる）・時間帯・1日の上限・効果は llm_usage_logs で1週間以上見る。
//   温める対象は system 2ブロック全体の1つだけ（26〜27k の「変種」は別の前置きではなく system[1] だけ書き直した回。別の温めを作ると鍵が2つになり費用だけ増える）。
//   本物と温めの system が1文字も違わない事は brain-core.buildBrainSystemBlocks（同じ関数）で保証する。ここは判断だけ。
//   依存は ./reply-warm-prefix の isWarmHourJst / parseHoursJst だけ（新しい JST 計算を作らない・supabase を読み込まない）。
import { isWarmHourJst, parseHoursJst } from "./reply-warm-prefix";

export const BRAIN_WARM_DEFAULTS = {
  /** 営業時間（JST）。parseHoursJst / isWarmHourJst をそのまま使う（start<end のみ・壊れた値は既存 fallback 7-24） */
  hoursJst: "9-22",
  /** 最後のブレイン呼び出し／温めからこれ以上空いたら温める */
  minGapMinutes: 50,
  /** これを超えたら「冷えている」＝温めない（1h TTL。sweep は5分毎なので 50〜58 の窓に必ず1スロット入る。59 にしない＝cron の遅れ＋送信時間で 60 を跨ぐと $0.24 の書き込み） */
  maxGapMinutes: 58,
  /** 1日の上限（9〜22時で最大 13h×1.3 ≈ 17。暴走の型の上限） */
  maxPerDay: 20,
  /** 温めが丸ごと冷えていた後、本物の呼び出しが来るまで温めない時間 */
  coldRetireHours: 6,
} as const;

export type BrainWarmInput = {
  nowMs: number;
  /** llm_usage_logs（action in brain_fresh/brain_full/brain_fresh_claude・status<400・sys_key_full 一致）の最新 created_at */
  lastRealCallMs: number | null;
  /** llm_warm_prefixes（hash='brain:'+sys_key_full）.last_warmed_at */
  lastWarmedMs: number | null;
  /** 同 .retired_at */
  retiredMs: number | null;
  /** llm_usage_logs action='brain-warm'・created_at >= JST 当日 0:00 の件数 */
  warmedTodayCount: number;
  hoursJst?: string;
  minGapMinutes?: number;
  maxGapMinutes?: number;
  maxPerDay?: number;
  coldRetireHours?: number;
  /** BRAIN_WARM !== "off" */
  enabled: boolean;
  /** willRouteAlt("brain_fresh") が true（毎回の分析が DeepSeek に回っている時は Claude 側を温めない） */
  altRouted: boolean;
};

export type BrainWarmDecision = { warm: boolean; reason: string; gapMinutes: number | null };

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/**
 * 判定順: disabled → alt_routed → outside_hours_jst(9-22) → day_cap → no_prior_call（本物の呼び出しの記録が無い＝温めない。最初の本物に書かせる）
 *   → retired（retired_at から coldRetireHours 以内で、その後に本物が来ていない）→ too_soon(<50) → cold_skip(>58) → warm
 * 「最後のタッチ」は GREATEST(lastRealCallMs, lastWarmedMs)（温めで延びた TTL も守る）
 */
export function decideBrainWarm(i: BrainWarmInput): BrainWarmDecision {
  const o = {
    ...BRAIN_WARM_DEFAULTS,
    ...stripUndefined({ hoursJst: i.hoursJst, minGapMinutes: i.minGapMinutes, maxGapMinutes: i.maxGapMinutes, maxPerDay: i.maxPerDay, coldRetireHours: i.coldRetireHours }),
  };
  if (!i.enabled) return { warm: false, reason: "disabled", gapMinutes: null };
  if (i.altRouted) return { warm: false, reason: "alt_routed", gapMinutes: null };
  if (!isWarmHourJst(i.nowMs, o.hoursJst)) {
    const h = parseHoursJst(o.hoursJst);
    return { warm: false, reason: `outside_hours_jst(${h.start}-${h.end})`, gapMinutes: null };
  }
  if (i.warmedTodayCount >= o.maxPerDay) return { warm: false, reason: "day_cap", gapMinutes: null };
  const touches = [i.lastRealCallMs, i.lastWarmedMs].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (touches.length === 0) return { warm: false, reason: "no_prior_call", gapMinutes: null };
  const lastTouch = Math.max(...touches);
  const gapMinutes = Math.round(((i.nowMs - lastTouch) / 60_000) * 10) / 10;
  if (i.retiredMs != null && Number.isFinite(i.retiredMs)) {
    const withinRetire = i.nowMs - i.retiredMs < o.coldRetireHours * 3_600_000;
    const realAfterRetire = i.lastRealCallMs != null && i.lastRealCallMs > i.retiredMs;
    if (withinRetire && !realAfterRetire) return { warm: false, reason: "retired", gapMinutes };
  }
  if (gapMinutes < o.minGapMinutes) return { warm: false, reason: "too_soon", gapMinutes };
  if (gapMinutes > o.maxGapMinutes) return { warm: false, reason: "cold_skip", gapMinutes };
  return { warm: true, reason: "warm", gapMinutes };
}

/**
 * 温めの usage から「効いたか」を読む（cache_write>0 の理由分け）。閾値は system[1] ≈12k・全体 ≈39k の実測から:
 *   hit            … cache_write_1h 0・cache_read >0（狙い通り: read≈38〜39k）
 *   dynamic_rewrite … cache_write_1h >0・cache_read >= 20,000（static は当たり・DB 由来ブロックだけ書いた＝DB 更新の前払い・損ではない）
 *   cold           … cache_read 0（または 20k 未満）で cache_write_1h >0（時間切れ or デプロイ or 鍵ずれ → retire）
 *   no_cache       … 両方 0（キャッシュ指定が効いていない＝鍵の付け方が壊れている。warn）
 */
export type BrainWarmUsageKind = "hit" | "dynamic_rewrite" | "cold" | "no_cache";
export const BRAIN_WARM_STATIC_HIT_MIN_READ = 20_000;

export function classifyBrainWarmUsage(u: { cache_read: number; cache_write_1h: number }): BrainWarmUsageKind {
  const read = Number(u.cache_read) || 0;
  const write = Number(u.cache_write_1h) || 0;
  if (write === 0 && read > 0) return "hit";
  if (write > 0 && read >= BRAIN_WARM_STATIC_HIT_MIN_READ) return "dynamic_rewrite";
  if (write > 0) return "cold";
  return "no_cache";
}
