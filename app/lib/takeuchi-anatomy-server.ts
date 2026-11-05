// app/lib/takeuchi-anatomy-server.ts — 竹内さんの文の解剖を作る（サーバー専用・夜の cron・サーバーの鍵）
//
// 2026-11-03 作業員6。①まだ選んでいなければ、takeuchi_compose_examples から場面×趣旨で偏りなく約200通に anatomy_pick を立てる
//   ②anatomy が空の選んだ通を1回 limit 通（既定 50）だけ DeepSeek で下読みする（名札 reply_anatomy）。
//   渡すのは表に伏せて置いた body と customer_gist だけ（お客様の生の発言は送らない・出口の alt-pii-gate も通る）。
//   名札 reply_anatomy が DeepSeek に回る設定（LLM_ALT_ACTIONS か LLM_ALT_ROUTES）でなければ動かない（Claude で200通を読まない）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sumoraLlmMarks } from "./llm-usage-recorder";
import { readAltConfig, shouldRouteAlt } from "./llm-alt-provider";
import { pickBalanced, ANATOMY_SYSTEM, ANATOMY_SYSTEM_FOCUS, anatomyFocusOn, anatomyPrompt, parseAnatomy, anatomyConflicts } from "./takeuchi-anatomy";
import { COMPOSE_PURPOSES, purposeOfText, type ComposePurpose } from "./compose-blueprint";

/** 重点を読ませる間に広げる通数（新しい順・竹内さんの番 約1,000番・統括役了承 11/05） */
const FOCUS_WIDEN_TOTAL = 1000;

export const ANATOMY_ACTION = "reply_anatomy";
/** 重点の夜の枠（vercel.json の ?window=focus）の期限と費用の上限（11/05 統括役了承・3重の止め方の①③） */
export const ANATOMY_FOCUS_WINDOW_UNTIL = Date.parse("2026-11-09T09:00:00+09:00");
export const ANATOMY_FOCUS_COST_CAP_USD = 1;
const ANATOMY_FOCUS_COST_SINCE = "2026-11-05T00:00:00+09:00";
/** 1通の費用の高めの見込み（今朝の DeepSeek 28回 $0.0077 ≒ $0.0003/回の倍）。読んでいる間の上限の見張りに使う */
const ANATOMY_EST_USD_PER_CALL = 0.0006;
/** 11/05 JST 0時からの reply_anatomy の費用の合計（llm_usage_logs・1000行ずつ） */
export async function anatomySpentUsd(sb: SupabaseClient): Promise<number> {
  const { altUsageUsd } = await import("./llm-price");
  let usd = 0;
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("llm_usage_logs").select("created_at, model, input_uncached, cache_read, output_tokens").eq("action", ANATOMY_ACTION).gte("created_at", ANATOMY_FOCUS_COST_SINCE).order("created_at", { ascending: true }).range(i, i + 999);
    if (error) throw new Error(`llm_usage_logs: ${error.message}`);
    const rows = (data ?? []) as Array<Parameters<typeof altUsageUsd>[0]>;
    for (const r of rows) usd += altUsageUsd(r);
    if (rows.length < 1000) break;
  }
  return usd;
}
function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function runTakeuchiAnatomy(opts: { dry?: boolean; limit?: number; total?: number; budgetMs?: number; costCapUsd?: number } = {}): Promise<{ ok: boolean; error?: string; picked?: number; read?: number; parsed?: number; conflicts?: number; remaining?: number; dry?: boolean; spentUsd?: number; skipped?: string }> {
  const sb = serviceClient();
  if (!sb) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" };
  if (!shouldRouteAlt(readAltConfig(), ANATOMY_ACTION)) return { ok: false, error: `名札 ${ANATOMY_ACTION} が DeepSeek に回る設定に無い（LLM_ALT_ACTIONS に足す）` };
  const t0 = Date.now();
  try {
    // ③ 費用の門（夜の枠の時だけ）: 11/05 からの合計が上限以上なら読まずに戻る。読んでいる間も見込みで上限に届いたら止める
    let spentUsd: number | undefined;
    if (opts.costCapUsd != null) {
      spentUsd = await anatomySpentUsd(sb);
      if (spentUsd >= opts.costCapUsd) return { ok: true, skipped: `費用の上限（11/05 から $${spentUsd.toFixed(3)} ≥ $${opts.costCapUsd}）`, spentUsd, read: 0 };
    }
    let picked = 0;
    const { count } = await sb.from("takeuchi_compose_examples").select("message_id", { count: "exact", head: true }).eq("anatomy_pick", true);
    if (!count) {
      const { data } = await sb.from("takeuchi_compose_examples").select("message_id, scene, purpose, sent_at").order("sent_at", { ascending: false }).limit(3000);
      const pick = pickBalanced((data ?? []) as Array<{ message_id: string; scene: string; purpose: string; sent_at: string }>, opts.total ?? 200);
      picked = pick.length;
      if (!opts.dry && pick.length) {
        for (let i = 0; i < pick.length; i += 100) {
          const r = await sb.from("takeuchi_compose_examples").update({ anatomy_pick: true }).in("message_id", pick.slice(i, i + 100).map((p) => p.message_id));
          if (r.error) throw new Error(r.error.message);
        }
      }
    }
    // 2026-11-05 作業員5（KB P0 575a7cd5・統括役了承）: TAKEUCHI_ANATOMY_FOCUS=on の間は、重点（focus）と背景（background）も読ませ、
    //   anatomy が無い行と focus が無い行を新しい順に約1,000通まで読む（1回 300通まで・5本ずつ並べる）。off は今まで通り（選んだ約200通・1本ずつ）
    const focusMode = anatomyFocusOn();
    const cap = focusMode ? 300 : 100;
    let q = sb.from("takeuchi_compose_examples").select("message_id, scene, body, customer_gist");
    if (focusMode) {
      const { data: edge } = await sb.from("takeuchi_compose_examples").select("sent_at").order("sent_at", { ascending: false }).range(FOCUS_WIDEN_TOTAL - 1, FOCUS_WIDEN_TOTAL - 1);
      const cutoff = ((edge ?? []) as Array<{ sent_at: string }>)[0]?.sent_at ?? null;
      q = q.or("anatomy.is.null,anatomy->>focus.is.null").or("anatomy_model.is.null,anatomy_model.not.like.*parse_failed*");
      if (cutoff) q = q.gte("sent_at", cutoff);
    } else q = q.eq("anatomy_pick", true).is("anatomy", null);
    const { data: todo, error } = await q.order("sent_at", { ascending: false }).limit(Math.min(opts.limit ?? 50, cap));
    if (error) throw new Error(error.message);
    const list = (todo ?? []) as Array<{ message_id: string; scene: string; body: string; customer_gist: string | null }>;
    // その番の時点の状況の文 v2（conductor_turn_vectors・あれば）。重点の「前の約束を果たしたか」を読むのに要る
    const sitOf = new Map<string, string>();
    if (focusMode && list.length) {
      for (let i = 0; i < list.length; i += 100) {
        const { data: sv } = await sb.from("conductor_turn_vectors").select("source_key, situation_v2").in("source_key", list.slice(i, i + 100).map((r) => `msg:${r.message_id}`)).not("situation_v2", "is", null);
        for (const x of (sv ?? []) as Array<{ source_key: string; situation_v2: string }>) sitOf.set(x.source_key.slice(4), x.situation_v2);
      }
    }
    let read = 0, parsed = 0, conflicts = 0;
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    const readOne = async (r: (typeof list)[number]) => {
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", signal: AbortSignal.timeout(30_000),
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...sumoraLlmMarks(ANATOMY_ACTION) },
          body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: focusMode ? 650 : 500, system: focusMode ? ANATOMY_SYSTEM_FOCUS : ANATOMY_SYSTEM, messages: [{ role: "user", content: anatomyPrompt({ maskedCustomer: r.customer_gist, maskedBody: r.body, scene: r.scene, situation: sitOf.get(r.message_id) ?? null }) }] }),
        });
        if (!res.ok) return;
        const d = await res.json() as { content?: Array<{ type: string; text?: string }>; model?: string };
        const rawText = d.content?.find((b) => b.type === "text")?.text ?? "";
        // 2026-11-06 弱い所 347: 重点を読ませる回は、purpose が一覧の外でも捨てずに本文の決まった札の趣旨にする（元の値は purpose_raw）
        const fb = focusMode ? purposeOfText(r.body).purpose : null;
        const a = parseAnatomy(rawText, focusMode ? { fallbackPurpose: (COMPOSE_PURPOSES as readonly string[]).includes(String(fb)) ? (fb as ComposePurpose) : "inform" } : {});
        if (!a) {
          // それでも読めない（JSON の崩れ）時は、伏せた答えの頭を残し、次の夜に読み直さない印を付ける（anatomy は触らない）
          if (focusMode) {
            const { maskPII } = await import("./pii-mask");
            await sb.from("takeuchi_compose_examples").update({ anatomy_model: `${ANATOMY_ACTION}:parse_failed`, anatomy_at: new Date().toISOString(), anatomy_conflicts: [`parse_failed:${maskPII(rawText).replace(/\s+/g, " ").slice(0, 300)}`] }).eq("message_id", r.message_id);
          }
          return;
        }
        parsed++;
        const cf = anatomyConflicts(a, r.body);
        if (cf.length) conflicts++;
        const up = await sb.from("takeuchi_compose_examples").update({ anatomy: a, anatomy_model: `${ANATOMY_ACTION}:${d.model ?? "alt"}`, anatomy_at: new Date().toISOString(), anatomy_conflicts: cf }).eq("message_id", r.message_id);
        if (up.error) throw new Error(up.error.message);
      } catch (e) { console.warn(JSON.stringify({ tag: "anatomy:failed", error: e instanceof Error ? e.message : String(e) })); }
    };
    if (!opts.dry && key) {
      const par = focusMode ? 5 : 1;
      for (let i = 0; i < list.length; i += par) {
        if (Date.now() - t0 > (opts.budgetMs ?? 200_000)) break;
        if (opts.costCapUsd != null && (spentUsd ?? 0) + (read + par) * ANATOMY_EST_USD_PER_CALL >= opts.costCapUsd) break;
        const batch = list.slice(i, i + par);
        read += batch.length;
        await Promise.all(batch.map(readOne));
      }
    }
    return { ok: true, picked, read, parsed, conflicts, remaining: Math.max(0, list.length - read), dry: !!opts.dry, ...(spentUsd != null ? { spentUsd } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
