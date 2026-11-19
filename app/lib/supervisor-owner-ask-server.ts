// app/lib/supervisor-owner-ask-server.ts — 統括Pro の迷い（推奨つき）を質問の台帳 owner_questions に入れる／未回答を読む
//
// 2026-11-19 竹内さん「迷ったら俺に推奨で確認とるかたちで」。表は既存（owner_questions）。新しい列・表は足さない
// （source_kind='supervisor_pro'・dedupe_key='sup-pro:<scope>:<trigger-種>:<JST日付>' で区別する）。
// 答えは scripts/owner-questions.ts --answer <id> "<答え>" → 設計知見（P1・札 竹内さんの決定）になり、次の Pro の kb_hits に戻る。
import type { SupabaseClient } from "@supabase/supabase-js";
import { ledgerDedupeKey, ledgerOpenPrefix, jstDayOf, type OwnerAsk } from "./supervisor-owner-ask";

export const SUPERVISOR_ASK_TOPIC = "統括の判断";
export const SUPERVISOR_ASK_SOURCE = "supervisor_pro";

export type SaveAskResult = {
  saved: Array<{ ask: OwnerAsk; id: string | null; how: "inserted" | "dry" }>;
  skipped: Array<{ ask: OwnerAsk; id: string | null; why: "same_day" | "open_exists" }>;
  errors: string[];
};

/** 優先度（小さいほど先）: 費用・DB・本番は 1、それ以外は 2 */
function priorityOf(a: OwnerAsk): number {
  return a.trigger === "cost" || a.trigger === "db_change" || a.trigger === "deploy" ? 1 : 2;
}

export async function saveOwnerAsks(
  sb: SupabaseClient,
  scope: string,
  asks: ReadonlyArray<OwnerAsk>,
  opts: { now?: number; dry?: boolean } = {},
): Promise<SaveAskResult> {
  const out: SaveAskResult = { saved: [], skipped: [], errors: [] };
  const day = jstDayOf(opts.now ?? Date.now());
  for (const a of asks) {
    try {
      const key = ledgerDedupeKey(scope, a, day);
      const same = await sb.from("owner_questions").select("id").eq("dedupe_key", key).limit(1);
      if (same.error) { out.errors.push(`${a.trigger}: ${same.error.message.slice(0, 80)}`); continue; }
      if (same.data && same.data.length) { out.skipped.push({ ask: a, id: String(same.data[0].id), why: "same_day" }); continue; }
      // 同じ scope・同じ trigger で未回答がある間は、新しい日でも足さない（聞きすぎない）
      const open = await sb.from("owner_questions").select("id").eq("status", "open").like("dedupe_key", `${ledgerOpenPrefix(scope, a.trigger)}%`).limit(1);
      if (open.error) { out.errors.push(`${a.trigger}: ${open.error.message.slice(0, 80)}`); continue; }
      if (open.data && open.data.length) { out.skipped.push({ ask: a, id: String(open.data[0].id), why: "open_exists" }); continue; }
      if (opts.dry) { out.saved.push({ ask: a, id: null, how: "dry" }); continue; }
      const ins = await sb.from("owner_questions").insert({
        kind: "question",
        topic: SUPERVISOR_ASK_TOPIC,
        question: a.question,
        options: a.options,
        recommended: a.recommended,
        why: a.why,
        source_kind: SUPERVISOR_ASK_SOURCE,
        source_ref: `scope=${scope} trigger=${a.trigger} src=${a.source}`,
        status: "open",
        priority: priorityOf(a),
        dedupe_key: key,
      }).select("id").single();
      if (ins.error) { out.errors.push(`${a.trigger}: ${ins.error.message.slice(0, 80)}`); continue; }
      out.saved.push({ ask: a, id: String((ins.data as { id: string }).id), how: "inserted" });
    } catch (e) {
      out.errors.push(`${a.trigger}: ${String((e as Error)?.message || e).slice(0, 80)}`);
    }
  }
  return out;
}

/** 統括が出して未回答の問い（Pro に「もう聞いた」と渡し、同じ事を聞き直さない） */
export async function fetchOpenSupervisorAsks(sb: SupabaseClient, limit = 8): Promise<Array<{ id: string; question: string; recommended: string | null; created_at: string }>> {
  try {
    const r = await sb.from("owner_questions").select("id,question,recommended,created_at").eq("status", "open").eq("source_kind", SUPERVISOR_ASK_SOURCE).order("created_at", { ascending: false }).limit(limit);
    if (r.error || !r.data) return [];
    return r.data as Array<{ id: string; question: string; recommended: string | null; created_at: string }>;
  } catch {
    return [];
  }
}
