// app/lib/takeuchi-anatomy-server.ts — 竹内さんの文の解剖を作る（サーバー専用・夜の cron・サーバーの鍵）
//
// 2026-11-03 作業員6。①まだ選んでいなければ、takeuchi_compose_examples から場面×趣旨で偏りなく約200通に anatomy_pick を立てる
//   ②anatomy が空の選んだ通を1回 limit 通（既定 50）だけ DeepSeek で下読みする（名札 reply_anatomy）。
//   渡すのは表に伏せて置いた body と customer_gist だけ（お客様の生の発言は送らない・出口の alt-pii-gate も通る）。
//   名札 reply_anatomy が DeepSeek に回る設定（LLM_ALT_ACTIONS か LLM_ALT_ROUTES）でなければ動かない（Claude で200通を読まない）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sumoraLlmMarks } from "./llm-usage-recorder";
import { readAltConfig, shouldRouteAlt } from "./llm-alt-provider";
import { pickBalanced, ANATOMY_SYSTEM, anatomyPrompt, parseAnatomy, anatomyConflicts } from "./takeuchi-anatomy";

export const ANATOMY_ACTION = "reply_anatomy";
function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function runTakeuchiAnatomy(opts: { dry?: boolean; limit?: number; total?: number; budgetMs?: number } = {}): Promise<{ ok: boolean; error?: string; picked?: number; read?: number; parsed?: number; conflicts?: number; remaining?: number; dry?: boolean }> {
  const sb = serviceClient();
  if (!sb) return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い" };
  if (!shouldRouteAlt(readAltConfig(), ANATOMY_ACTION)) return { ok: false, error: `名札 ${ANATOMY_ACTION} が DeepSeek に回る設定に無い（LLM_ALT_ACTIONS に足す）` };
  const t0 = Date.now();
  try {
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
    const { data: todo, error } = await sb.from("takeuchi_compose_examples").select("message_id, scene, body, customer_gist")
      .eq("anatomy_pick", true).is("anatomy", null).order("sent_at", { ascending: false }).limit(Math.min(opts.limit ?? 50, 100));
    if (error) throw new Error(error.message);
    const list = (todo ?? []) as Array<{ message_id: string; scene: string; body: string; customer_gist: string | null }>;
    let read = 0, parsed = 0, conflicts = 0;
    const key = process.env.ANTHROPIC_API_KEY ?? "";
    if (!opts.dry && key) {
      for (const r of list) {
        if (Date.now() - t0 > (opts.budgetMs ?? 200_000)) break;
        read++;
        try {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST", signal: AbortSignal.timeout(30_000),
            headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...sumoraLlmMarks(ANATOMY_ACTION) },
            body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 500, system: ANATOMY_SYSTEM, messages: [{ role: "user", content: anatomyPrompt({ maskedCustomer: r.customer_gist, maskedBody: r.body, scene: r.scene }) }] }),
          });
          if (!res.ok) continue;
          const d = await res.json() as { content?: Array<{ type: string; text?: string }>; model?: string };
          const a = parseAnatomy(d.content?.find((b) => b.type === "text")?.text ?? "");
          if (!a) continue;
          parsed++;
          const cf = anatomyConflicts(a, r.body);
          if (cf.length) conflicts++;
          const up = await sb.from("takeuchi_compose_examples").update({ anatomy: a, anatomy_model: `${ANATOMY_ACTION}:${d.model ?? "alt"}`, anatomy_at: new Date().toISOString(), anatomy_conflicts: cf }).eq("message_id", r.message_id);
          if (up.error) throw new Error(up.error.message);
        } catch (e) { console.warn(JSON.stringify({ tag: "anatomy:failed", error: e instanceof Error ? e.message : String(e) })); }
      }
    }
    return { ok: true, picked, read, parsed, conflicts, remaining: Math.max(0, list.length - read), dry: !!opts.dry };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
