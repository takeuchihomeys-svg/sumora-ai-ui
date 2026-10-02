// app/lib/cache-warm-switch.ts
// ブレインの「この会話専用の前置き」を温めるかどうかのスイッチ（お客様ごと・1日ごと）— 純関数・DB なし・単体テストあり
//
// 2026-10-02 竹内「ブレインでキャッシュ効く部分をもっと効かせていく。切り替えるようにしたら良い。1日に何度も連絡きたらキャッシュあたためて
//   効かせれるように。…今日の1日に○通以上やり取りしているお客さんはキャッシュ効かせた方が質も節約も両方できるので、切り替わるスイッチが必要、
//   そこも判断するようにブレインが。そして切り替えて、1日でおわらせて、次の日もまた振り出しに戻す形。アツければあたためる。かなりアツいお客さん」
//
// 決まり（1つの関数 decideCacheWarm が決める。ブレインの呼び出し・温めの cron・監査が同じ関数を使う）:
//   ・OFF が既定。今日（JST の日）のやり取り（お客様＋スタッフの通）が N 通に達したら ON
//   ・ON の間だけ、その会話の前置き（system 2ブロック＋会話専用ブロック）を 1h で持ち、温めの cron が 50〜58 分の窓で読み直す
//   ・営業時間（JST 9〜22・夜間見送り brain-night-defer と同じ時間帯）だけ。夜は OFF
//   ・お客様の最後の通から QUIET 分を過ぎたら OFF（静かになったら止める）
//   ・日が変わると今日のやり取りは 0 から数え直す＝全員 OFF に戻る（振り出しに戻す）
//
// N と QUIET の根拠（本番 9.1日・2026-09-23〜10-02・llm_usage_logs×messages・YUMA を除く・scripts/audit-cache-warm-switch.ts）:
//   1日のやり取りの数で切った時の会話×日: 1-2通 93／3-5 61／6-9 42／10-14 24／15-19 14／20+ 18。
//   同じ会話の brain_fresh の間隔は 1日7通以上の帯で p50 9分（5分未満 41・5〜60分 52・1時間超 14）＝1h なら大半がつながる帯。
//   ON にした時の損得は「会話専用ブロックが次の本物まで変わらない確率 q」で決まる:
//     q=0.43（今の実測・0.5〜5分の組で当たり 63%・間に戦略／全体分析／セーブデータが走ると 0/33）→ どの N でも損（N=10 で −$0.03〜−0.06/日）
//     q=0.9・ブロック 8k → N=10 で +$0.11/日（ON 5.4人/日・温め 4回/日）＝一番得。N=15 +$0.06・N=20 +$0.04
//   → N=10（10通以上＝上位 22% の会話×日）・QUIET=120分（60〜240分で差は小さい・120分で 1日7通以上の帯の間隔の 9割を覆う）。
//   q が足りない間は影（shadow）で判断と前置きの指紋だけを残し、温めも TTL も変えない（BRAIN_CACHE_WARM=on の時だけ効く）。

import { jstParts, jstDayStartMs, jstYmd } from "./jst-date";

export type CacheWarmMode = "off" | "shadow" | "on";

export const CACHE_WARM_DEFAULTS = {
  /** 今日のやり取り（お客様＋スタッフ）がこの数以上で ON */
  minExchangesToday: 10,
  /** お客様の最後の通からこれ以上空いたら OFF（分） */
  quietMinutes: 120,
  /** 営業時間（JST・start<=h<end） */
  hoursJst: { start: 9, end: 22 },
} as const;

/** 環境変数 BRAIN_CACHE_WARM（既定 shadow）。on 以外の値は影か止める */
export function cacheWarmMode(env: Record<string, string | undefined> = process.env): CacheWarmMode {
  const v = (env.BRAIN_CACHE_WARM ?? "").trim().toLowerCase();
  if (v === "on") return "on";
  if (v === "off") return "off";
  return "shadow";
}

/** 環境変数で N・QUIET を上書き（壊れた値は既定） */
export function cacheWarmParams(env: Record<string, string | undefined> = process.env): { minExchangesToday: number; quietMinutes: number } {
  const num = (s: string | undefined, d: number) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
  return {
    minExchangesToday: num(env.BRAIN_CACHE_WARM_MIN_EXCHANGES, CACHE_WARM_DEFAULTS.minExchangesToday),
    quietMinutes: num(env.BRAIN_CACHE_WARM_QUIET_MIN, CACHE_WARM_DEFAULTS.quietMinutes),
  };
}

export type CacheWarmInput = {
  nowMs: number;
  /** 今日（JST）のやり取りの通数（お客様＋スタッフ）。数えられなかった時は null＝OFF */
  exchangesToday: number | null;
  /** お客様の最後の通の時刻（無ければ null） */
  lastCustomerMsgMs: number | null;
  minExchangesToday?: number;
  quietMinutes?: number;
};

export type CacheWarmDecision = {
  on: boolean;
  reason: "on" | "night" | "below_threshold" | "quiet" | "no_customer_msg_today" | "unknown_count";
  /** JST の日（'YYYY-MM-DD'）。日が変わると別の判断＝振り出しに戻る */
  day: string;
  exchangesToday: number | null;
  threshold: number;
  /** お客様の最後の通からの分（無ければ null） */
  quietFor: number | null;
  /** 影の記録だけ（2026-10-02 竹内「記録だけとる」）: 閾値 N=3/6/10 それぞれなら ON だったか。挙動には使わない */
  byN?: Record<number, boolean>;
};

/** 影で並べて記録する閾値（監査 audit-cache-warm-switch で N ごとに比べる） */
export const CACHE_WARM_SHADOW_NS = [3, 6, 10] as const;

/** スイッチの判断（1つの関数・1つの値）。ブレインの呼び出しと温めの cron の両方がこれを呼ぶ */
export function decideCacheWarm(i: CacheWarmInput): CacheWarmDecision {
  const d = decideCacheWarmAt(i);
  const byN: Record<number, boolean> = {};
  for (const n of CACHE_WARM_SHADOW_NS) byN[n] = decideCacheWarmAt({ ...i, minExchangesToday: n }).on;
  return { ...d, byN };
}

function decideCacheWarmAt(i: CacheWarmInput): CacheWarmDecision {
  const threshold = i.minExchangesToday ?? CACHE_WARM_DEFAULTS.minExchangesToday;
  const quietMax = i.quietMinutes ?? CACHE_WARM_DEFAULTS.quietMinutes;
  const day = jstYmd(i.nowMs);
  const quietFor = i.lastCustomerMsgMs != null && Number.isFinite(i.lastCustomerMsgMs) ? Math.round((i.nowMs - i.lastCustomerMsgMs) / 60_000) : null;
  const base = { day, exchangesToday: i.exchangesToday, threshold, quietFor };
  const h = jstParts(i.nowMs).hour;
  if (h < CACHE_WARM_DEFAULTS.hoursJst.start || h >= CACHE_WARM_DEFAULTS.hoursJst.end) return { on: false, reason: "night", ...base };
  if (i.exchangesToday == null || !Number.isFinite(i.exchangesToday)) return { on: false, reason: "unknown_count", ...base };
  if (i.exchangesToday < threshold) return { on: false, reason: "below_threshold", ...base };
  // 今日のお客様の通が無い（スタッフだけで N 通）＝熱いお客様ではない
  if (i.lastCustomerMsgMs == null || i.lastCustomerMsgMs < jstDayStartMs(i.nowMs)) return { on: false, reason: "no_customer_msg_today", ...base };
  if (quietFor != null && quietFor > quietMax) return { on: false, reason: "quiet", ...base };
  return { on: true, reason: "on", ...base };
}

/** brain_decision_logs.digest に残す短い形（cw）。h は会話専用ブロックの指紋（同じ指紋が続く率＝q を監査で測る） */
export function compactCacheWarm(d: CacheWarmDecision, mode: CacheWarmMode, prefixHash: string | null): { on: boolean; r: string; n: number | null; th: number; m: CacheWarmMode; h: string | null; bn?: string } {
  // bn: 影の N ごとの ON（例 "3:1,6:1,10:0"）。記録だけ
  const bn = d.byN ? CACHE_WARM_SHADOW_NS.map((n) => `${n}:${d.byN?.[n] ? 1 : 0}`).join(",") : undefined;
  return { on: d.on, r: d.reason, n: d.exchangesToday, th: d.threshold, m: mode, h: prefixHash, ...(bn ? { bn } : {}) };
}

/** 会話専用ブロックの cache_control。ON かつ mode=on の時だけ 1h、それ以外は今まで通り 5分（文面は1文字も変えない） */
export function convBlockCacheControl(d: CacheWarmDecision | null | undefined, mode: CacheWarmMode): { type: "ephemeral"; ttl?: "1h" } {
  return d?.on && mode === "on" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/** 温めの保存行の hash（llm_warm_prefixes）。keep-warm の候補クエリは 'warm:%' と同じく除外する */
export const CONV_WARM_HASH_PREFIX = "convwarm:";
export const convWarmHash = (conversationId: string) => `${CONV_WARM_HASH_PREFIX}${conversationId}`;

/**
 * 損得の見積もり（監査・報告用）。1会話×日あたり。単価は Sonnet 5/5.5（入力 $2・5分書き $2.5・1h書き $4・読み $0.2 / 1M）。
 *   calls: その日の本物の回数・q: 次の本物まで会話専用ブロックが変わらない確率・P: 会話専用ブロック・S: 共有の前置き（温めも読む）・warms: 温めの回数
 *   今（5分・温め無し）: 5分以内の組だけ当たる（p5 = 5分以内の組の割合）
 *   ON（1h＋温め）: 1時間以内の組（p60）と温めでつないだ組が当たる
 */
export function estimateHotDayNetUsd(i: { calls: number; q: number; P: number; S: number; p5: number; p60: number; warms: number }): number {
  const PR = { w5: 2.5, w1h: 4, read: 0.2 };
  const pairs = Math.max(0, i.calls - 1);
  const now = (i.P * PR.w5 + pairs * (i.p5 * (i.q * i.P * PR.read + (1 - i.q) * i.P * PR.w5) + (1 - i.p5) * i.P * PR.w5)) / 1e6;
  const on = (i.P * PR.w1h + pairs * (i.p60 * (i.q * i.P * PR.read + (1 - i.q) * i.P * PR.w1h) + (1 - i.p60) * i.P * PR.w1h) + i.warms * (i.S + i.P) * PR.read) / 1e6;
  return now - on;
}

export type ConvBlock = { type: "text"; text: string; cache_control: { type: "ephemeral"; ttl?: "1h" } };
/**
 * 会話専用ブロックの組み立て（2026-10-02 キャッシュ①・竹内「4はオススメでする」）。
 *   今回の発言の層: A（変わりにくい物＝顧客プロファイル＋会話ストーリー）→ B（戦略 JSON＋セーブデータ＋出力の指定）の2ブロック・どちらも印あり。
 *     A は温めのスイッチの印（warmCc＝既定5分・ON かつ mode=on で 1h）、B は 5分（1h の後に 5分＝TTL の並びの決まりどおり）。
 *     A が空の時は B だけで、B が温めのスイッチの印（旧の1ブロックと同じ扱い）。空のブロックは API エラーになるので出さない。
 *   全体分析の層: 今まで通り1ブロック（1h・今は空＝省略）。
 *   印は system の2つと合わせて最大4つ（API の上限）。
 */
export function buildConvBlocks(p: { isFreshLayer: boolean; a: string; b: string; combined: string; warmCc: { type: "ephemeral"; ttl?: "1h" } }): ConvBlock[] {
  if (!p.isFreshLayer) return p.combined.trim() ? [{ type: "text", text: p.combined, cache_control: { type: "ephemeral", ttl: "1h" } }] : [];
  const out: ConvBlock[] = [];
  const hasA = !!p.a.trim();
  if (hasA) out.push({ type: "text", text: p.a, cache_control: p.warmCc });
  if (p.b.trim()) out.push({ type: "text", text: p.b, cache_control: hasA ? { type: "ephemeral" } : p.warmCc });
  return out;
}
