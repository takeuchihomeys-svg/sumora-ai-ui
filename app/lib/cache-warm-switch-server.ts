// app/lib/cache-warm-switch-server.ts
// お客様ごと・1日ごとの温めのスイッチ（cache-warm-switch.ts）の DB 側。ブレイン（brain-core）と温めの cron（brain-sweep）が同じ関数を呼ぶ。
//
// 2026-10-02 竹内「…今日の1日に○通以上やり取りしているお客さんはキャッシュ効かせた方が…切り替わるスイッチが必要、そこも判断するようにブレインが。
//   そして切り替えて、1日でおわらせて、次の日もまた振り出しに戻す形」
//   ・loadCacheWarmDecision: 今日（JST）のやり取りの通数とお客様の最後の通を数えて decideCacheWarm を呼ぶ（ブレインの呼び出しごと・温めの cron ごと）
//   ・saveConvWarmPrefix: mode=on で ON の時だけ、本物が送った前置き（model・thinking・system・会話専用ブロック）をそのまま llm_warm_prefixes に残す
//     （hash='convwarm:<会話id>'。温めは同じバイト列を送る＝1文字もずれない。keep-warm の候補からは外す）
//   ・tryConvWarms: mode=on の時だけ温める（ブレインの温めと同じ窓 50〜58 分・冷えていたら退く）。shadow は「温めるはずだった会話」を数えて残すだけ
//   止める: BRAIN_CACHE_WARM=off。既定は shadow（判断と前置きの指紋を brain_decision_logs.digest.cw に残すだけ・費用0）
import { supabase } from "./supabase";
import { jstDayStartMs } from "./jst-date";
import { decideBrainWarm } from "./brain-warm";
import { sumoraLlmMarks } from "./llm-usage-recorder";
import {
  decideCacheWarm, cacheWarmMode, cacheWarmParams, convWarmHash, CONV_WARM_HASH_PREFIX,
  type CacheWarmDecision,
} from "./cache-warm-switch";

/** 今日のやり取りの通数とお客様の最後の通 → スイッチ。数えられなければ OFF（unknown_count） */
export async function loadCacheWarmDecision(conversationId: string, nowMs: number = Date.now()): Promise<CacheWarmDecision> {
  const dayStartIso = new Date(jstDayStartMs(nowMs)).toISOString();
  const [cnt, lastCust] = await Promise.all([
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId).gte("created_at", dayStartIso),
    supabase.from("messages").select("created_at").eq("conversation_id", conversationId).eq("sender", "customer")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const p = cacheWarmParams();
  const lastMs = lastCust.data?.created_at ? Date.parse(lastCust.data.created_at as string) : NaN;
  return decideCacheWarm({
    nowMs,
    exchangesToday: cnt.error ? null : (cnt.count ?? 0),
    lastCustomerMsgMs: Number.isFinite(lastMs) ? lastMs : null,
    minExchangesToday: p.minExchangesToday, quietMinutes: p.quietMinutes,
  });
}

export type ConvWarmPrefix = {
  model: string;
  thinking: { type: "disabled" };
  system: Array<{ type: "text"; text: string; cache_control?: unknown }>;
  /** 会話専用ブロック（本物の user content[0] と同じ物・cache_control 1h 付き） */
  convBlock: { type: "text"; text: string; cache_control?: unknown };
};

/** mode=on で ON の時だけ呼ぶ。本物が送ったバイト列をそのまま残す（fire-and-forget・失敗は warn だけ） */
export async function saveConvWarmPrefix(conversationId: string, p: ConvWarmPrefix): Promise<void> {
  const nowIso = new Date().toISOString();
  const hash = convWarmHash(conversationId);
  const chars = p.system.reduce((n, b) => n + b.text.length, 0) + p.convBlock.text.length;
  const { data: row } = await supabase.from("llm_warm_prefixes").select("use_count, last_used_at").eq("hash", hash).maybeSingle();
  // 日が変わったら温めの回数も 0 から（振り出しに戻す・decideBrainWarm の1日の上限に warm_count を使う）
  const newDay = !row?.last_used_at || Date.parse(row.last_used_at as string) < jstDayStartMs(Date.now());
  const { error } = row
    ? await supabase.from("llm_warm_prefixes").update({
        model: p.model, system_blocks: { thinking: p.thinking, system: p.system }, human_blocks: [p.convBlock], chars,
        last_used_at: nowIso, use_count: (row.use_count ?? 0) + 1, retired_at: null,
        ...(newDay ? { warm_count: 0, last_warmed_at: null } : {}),
      }).eq("hash", hash)
    : await supabase.from("llm_warm_prefixes").insert({
        hash, model: p.model, system_blocks: { thinking: p.thinking, system: p.system }, human_blocks: [p.convBlock], chars,
        use_count: 1, first_used_at: nowIso, last_used_at: nowIso, sys0_hash: "brain-conv",
      });
  if (error) console.warn(JSON.stringify({ tag: "conv-warm:save-failed", conversationId, error: error.message }));
}

export type ConvWarmResult = { conversationId: string; warmed: boolean; reason: string; gapMinutes?: number | null; cache_read?: number; cache_write?: number };

type Row = { hash: string; model: string; system_blocks: { thinking?: unknown; system?: unknown[] } | null; human_blocks: unknown[] | null; last_used_at: string | null; last_warmed_at: string | null; warm_count: number | null; retired_at: string | null };

/**
 * 温め1回（残した行をそのまま送る・max_tokens 1・user は [会話専用ブロック, "."]）。
 * 本物（brainRequestBase＋messages[0].content=[会話専用ブロック, 毎回の材料]）と同じ model・thinking・system・会話専用ブロック。
 * 名札 brain-conv-warm は claude-model-map の CACHE_GROUPS でブレインの組＝本物と同じモデルに写る。会話 ID はテストの歯止め（YUMA 以外を断る）のため付ける
 */
export async function sendConvWarm(r: Pick<Row, "model" | "system_blocks" | "human_blocks">, conversationId: string): Promise<{ read: number; write: number }> {
  const system = (r.system_blocks?.system ?? []) as unknown[];
  const conv = (r.human_blocks ?? [])[0];
  if (!system.length || !conv) throw new Error("bad_row");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json", "x-api-key": (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, ""), "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31", ...sumoraLlmMarks("brain-conv-warm", conversationId) },
    body: JSON.stringify({ model: r.model, max_tokens: 1, thinking: r.system_blocks?.thinking ?? { type: "disabled" }, system, messages: [{ role: "user", content: [conv, { type: "text", text: "." }] }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const u = ((await res.json()) as { usage?: Record<string, number> }).usage ?? {};
  return { read: Number(u.cache_read_input_tokens) || 0, write: Number(u.cache_creation_input_tokens) || 0 };
}

/** 温めの cron（brain-sweep の対象0件の分岐）から呼ぶ。shadow は数えるだけ・on は ON の会話だけ温める */
export async function tryConvWarms(nowMs: number = Date.now()): Promise<{ mode: string; on: number; results: ConvWarmResult[] }> {
  const mode = cacheWarmMode();
  if (mode === "off") return { mode, on: 0, results: [] };
  const dayStartIso = new Date(jstDayStartMs(nowMs)).toISOString();
  if (mode === "shadow") {
    // 影: 今日ブレインが ON と判断した会話を数えるだけ（温めない・費用0）
    const { data } = await supabase.from("brain_decision_logs").select("conversation_id").gte("created_at", dayStartIso).eq("digest->cw->>on", "true").limit(500);
    const ids = [...new Set(((data ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))];
    let on = 0;
    for (const id of ids.slice(0, 30)) if ((await loadCacheWarmDecision(id, nowMs)).on) on++;
    return { mode, on, results: [] };
  }
  const { data, error } = await supabase.from("llm_warm_prefixes")
    .select("hash, model, system_blocks, human_blocks, last_used_at, last_warmed_at, warm_count, retired_at")
    .like("hash", `${CONV_WARM_HASH_PREFIX}%`).gte("last_used_at", dayStartIso).order("last_used_at", { ascending: false }).limit(20);
  if (error) return { mode, on: 0, results: [{ conversationId: "*", warmed: false, reason: "read_failed:" + error.message }] };
  const results: ConvWarmResult[] = [];
  let on = 0;
  for (const r of (data ?? []) as Row[]) {
    const conversationId = r.hash.slice(CONV_WARM_HASH_PREFIX.length);
    const sw = await loadCacheWarmDecision(conversationId, nowMs);
    if (!sw.on) { results.push({ conversationId, warmed: false, reason: "switch_off:" + sw.reason }); continue; }
    on++;
    const ms = (s: string | null) => (s ? Date.parse(s) : null);
    // 窓はブレインの温めと同じ関数（50〜58分・1日20回・冷えたら retire）。最後の本物＝saveConvWarmPrefix の last_used_at
    const d = decideBrainWarm({ nowMs, lastRealCallMs: ms(r.last_used_at), lastWarmedMs: ms(r.last_warmed_at), retiredMs: ms(r.retired_at), warmedTodayCount: r.warm_count ?? 0, enabled: true, altRouted: false, maxPerDay: 12 });
    if (!d.warm) { results.push({ conversationId, warmed: false, reason: d.reason, gapMinutes: d.gapMinutes }); continue; }
    if (!(r.system_blocks?.system ?? []).length || !(r.human_blocks ?? [])[0]) { results.push({ conversationId, warmed: false, reason: "bad_row" }); continue; }
    // claim 先行（同じ5分に2本走っても1回だけ）
    let q = supabase.from("llm_warm_prefixes").update({ last_warmed_at: new Date(nowMs).toISOString(), warm_count: (r.warm_count ?? 0) + 1 }).eq("hash", r.hash);
    q = r.last_warmed_at ? q.eq("last_warmed_at", r.last_warmed_at) : q.is("last_warmed_at", null);
    const { data: claimed } = await q.select("hash");
    if (!Array.isArray(claimed) || claimed.length === 0) { results.push({ conversationId, warmed: false, reason: "claim_failed" }); continue; }
    try {
      const { read, write } = await sendConvWarm(r, conversationId);
      // 会話専用ブロックまで当たっていない（書いた）＝冷えていた・中身が変わった → 6h 退く（次の本物が書く）
      if (write > 0) await supabase.from("llm_warm_prefixes").update({ retired_at: new Date().toISOString() }).eq("hash", r.hash);
      results.push({ conversationId, warmed: true, reason: write > 0 ? "cold" : "hit", gapMinutes: d.gapMinutes, cache_read: read, cache_write: write });
    } catch (e) {
      await supabase.from("llm_warm_prefixes").update({ last_warmed_at: r.last_warmed_at, warm_count: r.warm_count ?? 0 }).eq("hash", r.hash);
      results.push({ conversationId, warmed: false, reason: "send_failed:" + (e instanceof Error ? e.message : String(e)).slice(0, 120) });
    }
  }
  return { mode, on, results };
}
