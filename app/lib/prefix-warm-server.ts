// app/lib/prefix-warm-server.ts
// Claude の固定の前置き（最終チェック4段・お客様の要約・次の一手）を営業時間だけ温める — DB を読む側（brain-sweep の対象0件の分岐から呼ぶ）
//
// 2026-09-29 竹内「クロードの部分、キャッシュを営業時間中温める」。型はブレインの温め（brain-sweep.tryBrainWarm）と同じ:
//   ①前置きは本物と同じ関数（final-check.buildFinalCheckWarmBodies／customer-summary-prompt／suggest-next-action-prompt）で作る
//   ②「最後の本物」は llm_usage_logs を action＋sys_key_full 一致で読む（created_at − duration_ms＝リクエスト開始時刻）
//   ③claim 先行（llm_warm_prefixes・hash='warm:<名札>:<鍵>'）・送信に失敗したら claim を戻す
//   ④usage を hit / dynamic_rewrite / cold / no_cache に分け、cold・no_cache は 6h retire（書き込みは次の本物に払わせる）
//   ⑤env で絞らない（キャッシュは Anthropic アカウント×内容の鍵。local の温めも本番の蓄えを温める）
//   止める: PREFIX_WARM=off。時間帯: PREFIX_WARM_HOURS_JST（既定 "9-22"）。1対象 1日20回まで
import { supabase } from "./supabase";
import { getCachedPromptRules } from "./prompt-cache";
import { loadCustomerSummaryPrefixInputs } from "./customer-summary-prompt-server";
import { loadSuggestNextActionPrefixInputs } from "./suggest-next-action-prompt-server";
import {
  buildPrefixWarmTargets, decidePrefixWarm, classifyPrefixWarmUsage, prefixWarmHash, PREFIX_WARM_DEFAULTS,
  type PrefixWarmInputs, type PrefixWarmTarget, type PrefixWarmUsageKind,
} from "./prefix-warm";
import { isOffSwitch } from "./brain-night-defer";
import { willRouteAlt } from "./llm-alt-provider";
import { isWarmHourJst, parseHoursJst } from "./reply-warm-prefix";
import { jstDayStartMs } from "./jst-date";
import { sumoraLlmMarks } from "./llm-usage-recorder";

export type PrefixWarmResult = {
  name: string;
  warmed: boolean;
  reason: string;
  key?: string;
  gapMinutes?: number | null;
  kind?: PrefixWarmUsageKind;
  cache_read?: number;
  cache_write_1h?: number;
  cache_write_5m?: number;
  request_id?: string | null;
};

/** 本物の経路と同じ材料を読む。dbRules は generate-reply の大多数の状態（applying・phone_call 以外）と同じ文字列になる条件で取る */
export async function loadPrefixWarmInputs(): Promise<PrefixWarmInputs> {
  const [dbRules, finalCheckRules, summary, nextAction] = await Promise.all([
    // 2026-09-29 実測: conversation_state 条件付きの generate_reply ルールは applying 1件・phone_call 2件だけ。他の状態は全部同じ文字列＝
    //   最終チェックの前置きは（applying を除き）1種類。ここは代表として proposing を渡す（{} だと condition_key 未指定の warn が毎回出る）
    getCachedPromptRules("generate_reply", { conversation_state: "proposing", is_first_reply: "false" }),
    getCachedPromptRules("final_check", {}, false),
    loadCustomerSummaryPrefixInputs(),
    loadSuggestNextActionPrefixInputs(),
  ]);
  return { finalCheck: { dbRules, finalCheckRules }, summary, nextAction };
}

export type PrefixWarmUsage = { cache_read: number; cache_write_1h: number; cache_write_5m: number; input_uncached: number; request_id: string | null };

/** 温め1回を送る（raw fetch・印は x-sumora-llm-action=<名札>。出口 llm-usage-recorder が記録し Anthropic には送らない）。失敗は投げる */
export async function sendPrefixWarm(t: PrefixWarmTarget, timeoutMs = 30_000): Promise<PrefixWarmUsage> {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31", ...sumoraLlmMarks(t.name) },
    body: JSON.stringify(t.body),
  });
  if (!res.ok) throw new Error(`prefix-warm ${t.name} HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
  const data = await res.json() as { usage?: Record<string, unknown> };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const u = data.usage ?? {};
  const cc = (u.cache_creation ?? {}) as Record<string, unknown>;
  const cache_write_5m = n(cc.ephemeral_5m_input_tokens);
  const cache_write_1h = n(cc.ephemeral_1h_input_tokens) || (cache_write_5m ? 0 : n(u.cache_creation_input_tokens));
  return { cache_read: n(u.cache_read_input_tokens), cache_write_1h, cache_write_5m, input_uncached: n(u.input_tokens), request_id: res.headers.get("request-id") };
}

const ms = (iso: unknown): number | null => { const t = typeof iso === "string" ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

async function warmOne(t: PrefixWarmTarget, nowMs: number, hoursJst: string): Promise<PrefixWarmResult> {
  const altRouted = willRouteAlt(t.realActions[0] ?? null);
  const hash = prefixWarmHash(t);
  const dayStartIso = new Date(jstDayStartMs(nowMs)).toISOString();
  const [lastReal, warmedToday, claimRow] = await Promise.all([
    supabase.from("llm_usage_logs").select("created_at, duration_ms").in("action", t.realActions).lt("status", 400).eq("sys_key_full", t.key)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("llm_usage_logs").select("*", { count: "exact", head: true }).eq("action", t.name).gte("created_at", dayStartIso),
    supabase.from("llm_warm_prefixes").select("last_warmed_at, retired_at, warm_count").eq("hash", hash).maybeSingle(),
  ]);
  if (lastReal.error) console.warn(`[prefix-warm] ${t.name} llm_usage_logs read failed:`, lastReal.error.message);
  if (claimRow.error) console.warn(`[prefix-warm] ${t.name} llm_warm_prefixes read failed:`, claimRow.error.message);
  const row = (claimRow.data ?? null) as { last_warmed_at: string | null; retired_at: string | null; warm_count: number | null } | null;
  const lastRealInsertedMs = ms(lastReal.data?.created_at);
  const lastRealDurationMs = Math.max(0, Number(lastReal.data?.duration_ms) || 0);
  const decision = decidePrefixWarm({
    nowMs,
    lastRealCallMs: lastRealInsertedMs === null ? null : lastRealInsertedMs - lastRealDurationMs,
    lastWarmedMs: ms(row?.last_warmed_at),
    retiredMs: ms(row?.retired_at),
    warmedTodayCount: warmedToday.count ?? 0,
    hoursJst, enabled: true, altRouted, maxPerDay: PREFIX_WARM_DEFAULTS.maxPerDay,
  });
  if (!decision.warm) return { name: t.name, warmed: false, reason: decision.reason, key: t.key, gapMinutes: decision.gapMinutes };

  // claim 先行（brain-warm と同じ形）
  const nowIso = new Date(nowMs).toISOString();
  if (!row) {
    const { error: insErr } = await supabase.from("llm_warm_prefixes").insert({
      hash, model: t.model, system_blocks: [], human_blocks: [], chars: t.chars, use_count: 0, sys0_hash: t.name,
      first_used_at: nowIso, last_used_at: nowIso, last_warmed_at: nowIso, warm_count: 1,
    });
    if (insErr) return { name: t.name, warmed: false, reason: "claim_failed", key: t.key, gapMinutes: decision.gapMinutes };
  } else {
    let q = supabase.from("llm_warm_prefixes").update({ last_warmed_at: nowIso, warm_count: (row.warm_count ?? 0) + 1 }).eq("hash", hash);
    q = row.last_warmed_at ? q.eq("last_warmed_at", row.last_warmed_at) : q.is("last_warmed_at", null);
    const { data: claimed, error: upErr } = await q.select("hash");
    if (upErr || !Array.isArray(claimed) || claimed.length === 0) return { name: t.name, warmed: false, reason: "claim_failed", key: t.key, gapMinutes: decision.gapMinutes };
  }

  let u: PrefixWarmUsage;
  try {
    u = await sendPrefixWarm(t);
  } catch (e) {
    // 送信失敗で claim を残すと 50 分 too_soon → その間に本物の TTL が切れる。claim を戻す（brain-warm の反証と同じ）
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    const { error: undoErr } = row
      ? await supabase.from("llm_warm_prefixes").update({ last_warmed_at: row.last_warmed_at, warm_count: row.warm_count ?? 0 }).eq("hash", hash).eq("last_warmed_at", nowIso)
      : await supabase.from("llm_warm_prefixes").delete().eq("hash", hash).eq("last_warmed_at", nowIso);
    console.warn(JSON.stringify({ tag: "prefix-warm:send-failed", name: t.name, key: t.key, gapMinutes: decision.gapMinutes, error: msg, claimUndone: !undoErr }));
    return { name: t.name, warmed: false, reason: "send_failed:" + msg, key: t.key, gapMinutes: decision.gapMinutes };
  }
  const kind = classifyPrefixWarmUsage(u, t.staticHitMinRead);
  const line = { tag: "prefix-warm:done", name: t.name, key: t.key, kind, cache_read: u.cache_read, cache_write_1h: u.cache_write_1h, cache_write_5m: u.cache_write_5m, request_id: u.request_id, gapMinutes: decision.gapMinutes };
  if (kind === "hit") {
    console.log(JSON.stringify(line));
  } else if (kind === "dynamic_rewrite") {
    // 先頭は当たり・後ろのブロック（会社ルール／改善ルール／フロー運用ガイド）だけ書いた＝DB 更新の前払い。ただし同じ鍵で2回続くのは鍵の揺れ → retire
    const prev = await supabase.from("llm_usage_logs").select("cache_read, cache_write_1h, cache_write_5m").eq("action", t.name).eq("sys_key_full", t.key)
      .lt("status", 400).lt("created_at", nowIso).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const prevKind = prev.data ? classifyPrefixWarmUsage({ cache_read: Number(prev.data.cache_read) || 0, cache_write_1h: Number(prev.data.cache_write_1h) || 0, cache_write_5m: Number(prev.data.cache_write_5m) || 0 }, t.staticHitMinRead) : null;
    if (prevKind === "dynamic_rewrite") {
      console.warn(JSON.stringify({ ...line, tag: "prefix-warm:dynamic-rewrite-repeat", note: "同じ鍵で2回続けて後ろのブロックを書いた＝鍵の揺れか cache の消失 → 6h retire" }));
      await supabase.from("llm_warm_prefixes").update({ retired_at: new Date().toISOString() }).eq("hash", hash);
    } else {
      console.log(JSON.stringify({ ...line, note: "後ろのブロックが変わった＝次の本物が払う分の前払い" }));
    }
  } else {
    console.warn(JSON.stringify({ ...line, tag: kind === "cold" ? "prefix-warm:cold" : "prefix-warm:no-cache", note: kind === "cold" ? "時間切れ・デプロイ・鍵ずれのどれか → 6h retire" : "cache_control が効いていない（最低長未満か鍵の付け方）→ 6h retire" }));
    await supabase.from("llm_warm_prefixes").update({ retired_at: new Date().toISOString() }).eq("hash", hash);
  }
  return { name: t.name, warmed: true, reason: "warm", key: t.key, gapMinutes: decision.gapMinutes, kind, cache_read: u.cache_read, cache_write_1h: u.cache_write_1h, cache_write_5m: u.cache_write_5m, request_id: u.request_id };
}

/** 呼び出し側（brain-sweep）が catch する。disabled／時間帯外は DB を読まずに即 return */
export async function tryPrefixWarms(nowMs: number): Promise<PrefixWarmResult[]> {
  const enabled = !isOffSwitch(process.env.PREFIX_WARM);
  const hoursJst = process.env.PREFIX_WARM_HOURS_JST || PREFIX_WARM_DEFAULTS.hoursJst;
  if (!enabled) return [{ name: "*", warmed: false, reason: "disabled" }];
  if (!isWarmHourJst(nowMs, hoursJst)) {
    const h = parseHoursJst(hoursJst);
    return [{ name: "*", warmed: false, reason: `outside_hours_jst(${h.start}-${h.end})` }];
  }
  const targets = buildPrefixWarmTargets(await loadPrefixWarmInputs());
  const settled = await Promise.allSettled(targets.map((t) => warmOne(t, nowMs, hoursJst)));
  return settled.map((r, i) => r.status === "fulfilled"
    ? r.value
    : { name: targets[i].name, warmed: false, reason: "error:" + (r.reason instanceof Error ? r.reason.message : String(r.reason)).slice(0, 200), key: targets[i].key });
}

/** cron_run_logs に残す短い形・console に出す価値の無い理由 */
export const PREFIX_WARM_QUIET_REASONS = new Set(["too_soon", "disabled", "no_prior_call"]);
export function compactPrefixWarmResults(rs: PrefixWarmResult[]): Array<{ name: string; reason: string; kind?: PrefixWarmUsageKind; gapMinutes?: number | null }> {
  return rs.map((r) => ({ name: r.name, reason: r.reason, ...(r.kind ? { kind: r.kind } : {}), ...(r.gapMinutes !== undefined ? { gapMinutes: r.gapMinutes } : {}) }));
}
